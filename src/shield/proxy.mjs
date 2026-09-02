import { timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";

const INSPECTION_MAX_BYTES = 1_048_576;
const INTERNAL_HEADERS = new Set([
  "connection",
  "content-length",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "forwarded",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-original-url",
  "x-airkit-shield",
]);

export async function startShieldProxy({ capability, targetOrigin, decide, onDecision = async () => {}, port = 0 } = {}) {
  assertCapability(capability);
  const target = assertFixedTarget(targetOrigin);
  if (typeof decide !== "function") throw new TypeError("shield proxy decision function is required");
  if (typeof onDecision !== "function") throw new TypeError("shield proxy decision observer must be a function");
  assertPort(port);

  const server = createServer((request, response) => {
    void handleShieldRequest({ request, response, capability, target, decide, onDecision });
  });
  await listenLoopback(server, port);
  const address = server.address();
  if (address === null || typeof address === "string" || address.address !== "127.0.0.1") {
    await closeServer(server);
    throw new Error("shield proxy did not expose a loopback listener");
  }
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => closeServer(server),
  };
}

async function handleShieldRequest({ request, response, capability, target, decide, onDecision }) {
  const startedAt = Date.now();
  if (!capabilityMatches(request.headers["x-airkit-shield"], capability)) {
    request.resume();
    await finish(response, onDecision, startedAt, { action: "unauthorized", reason: "invalid_capability", bytes: 0, status: 401, code: "shield_unauthorized" });
    return;
  }

  const path = safeMessagesPath(request.url);
  if (path === null) {
    request.resume();
    await finish(response, onDecision, startedAt, { action: "blocked", reason: "invalid_path", bytes: 0, status: 403, code: "shield_blocked" });
    return;
  }

  const lifecycle = requestLifecycleSignal(request, response);
  if (lifecycle.signal.aborted) return;
  let inspection;
  try {
    inspection = await readInspection(request);
  } catch {
    await finish(response, onDecision, startedAt, { action: "unavailable", reason: "request_failed", bytes: 0, status: 503, code: "shield_unavailable" });
    return;
  }
  if (inspection.tooLarge) {
    await finish(response, onDecision, startedAt, { action: "blocked", reason: "inspection_too_large", bytes: inspection.bytes, status: 403, code: "shield_blocked" });
    return;
  }

  if (lifecycle.signal.aborted) return;
  let decision;
  try {
    decision = await decide({
      method: request.method ?? "GET",
      path,
      bytes: inspection.bytes,
      body: inspection.body,
      signal: lifecycle.signal,
    });
  } catch {
    await finish(response, onDecision, startedAt, { action: "unavailable", reason: "decision_failed", bytes: inspection.bytes, status: 503, code: "shield_unavailable" });
    return;
  }
  if (decision?.action !== "allow") {
    await finish(response, onDecision, startedAt, { action: "blocked", reason: "denied", bytes: inspection.bytes, status: 403, code: "shield_blocked" });
    return;
  }
  if (lifecycle.signal.aborted) return;

  try {
    const upstream = await fetch(new URL(path, target), {
      method: request.method,
      headers: forwardHeaders(request.headers),
      body: request.method === "GET" || request.method === "HEAD" ? undefined : inspection.body,
      redirect: "manual",
      signal: lifecycle.signal,
    });
    if (upstream.status >= 300 && upstream.status < 400) {
      await discardResponse(upstream);
      await finish(response, onDecision, startedAt, { action: "unavailable", reason: "upstream_redirect", bytes: inspection.bytes, status: 503, code: "shield_unavailable" });
      return;
    }
    writeUpstreamHeaders(response, upstream);
    await streamResponse(upstream, response, lifecycle.signal);
    await emitDecision(onDecision, decisionEvent("allow", "allowed", inspection.bytes, startedAt));
  } catch {
    if (!response.headersSent) {
      await finish(response, onDecision, startedAt, { action: "unavailable", reason: "upstream_failed", bytes: inspection.bytes, status: 503, code: "shield_unavailable" });
    } else if (!response.destroyed) {
      response.destroy();
    }
  }
}

async function discardResponse(upstream) {
  try { await upstream.body?.cancel(); } catch {}
}

function assertCapability(capability) {
  if (typeof capability !== "string" || capability.length < 32) throw new Error("shield proxy capability is missing or invalid");
}

function assertFixedTarget(targetOrigin) {
  let target;
  try { target = new URL(targetOrigin); } catch { target = null; }
  if (
    target === null ||
    (target.protocol !== "http:" && target.protocol !== "https:") ||
    target.username !== "" ||
    target.password !== "" ||
    target.pathname !== "/" ||
    target.search !== "" ||
    target.hash !== ""
  ) throw new Error("shield proxy target origin is invalid");
  return target;
}

function assertPort(port) {
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error("shield proxy port must be an integer from 0 through 65535");
}

function capabilityMatches(value, expected) {
  const received = typeof value === "string" ? Buffer.from(value) : Buffer.alloc(0);
  const target = Buffer.from(expected);
  return received.byteLength === target.byteLength && timingSafeEqual(received, target);
}

function safeMessagesPath(value) {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return null;
  let target;
  try { target = new URL(value, "http://shield.local"); } catch { return null; }
  return target.pathname === "/v1/messages" ? `${target.pathname}${target.search}` : null;
}

async function readInspection(request) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > INSPECTION_MAX_BYTES) {
      request.resume();
      return { body: null, bytes, tooLarge: true };
    }
    chunks.push(buffer);
  }
  return { body: Buffer.concat(chunks), bytes, tooLarge: false };
}

function forwardHeaders(headers) {
  const forwarded = new Headers();
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (INTERNAL_HEADERS.has(name.toLowerCase()) || value === undefined) continue;
    forwarded.set(name, Array.isArray(value) ? value.join(", ") : value);
  }
  return forwarded;
}

function writeUpstreamHeaders(response, upstream) {
  const headers = {};
  for (const [name, value] of upstream.headers) {
    const normalized = name.toLowerCase();
    if (normalized !== "content-encoding" && normalized !== "content-length" && !INTERNAL_HEADERS.has(normalized)) headers[name] = value;
  }
  response.writeHead(upstream.status, headers);
}

async function streamResponse(upstream, response, signal) {
  if (upstream.body === null) {
    response.end();
    return;
  }
  for await (const chunk of upstream.body) {
    if (!response.write(chunk)) await waitForDrain(response, signal);
  }
  response.end();
}

function requestLifecycleSignal(request, response) {
  const controller = new AbortController();
  const abort = () => {
    if (!controller.signal.aborted) controller.abort();
  };
  request.once("aborted", abort);
  request.once("error", abort);
  response.once("close", () => {
    if (response.writableFinished !== true) abort();
  });
  if (request.aborted === true || request.destroyed === true || response.destroyed === true) abort();
  return controller;
}

function waitForDrain(response, signal) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      response.off("drain", onDrain);
      response.off("close", onClose);
      response.off("error", onError);
      signal?.removeEventListener("abort", onAbort);
    };
    const onDrain = () => { cleanup(); resolve(); };
    const onClose = () => { cleanup(); reject(new Error("shield downstream closed")); };
    const onError = () => { cleanup(); reject(new Error("shield downstream failed")); };
    const onAbort = () => { cleanup(); reject(signal.reason ?? new Error("shield downstream aborted")); };
    response.once("drain", onDrain);
    response.once("close", onClose);
    response.once("error", onError);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    else if (response.destroyed) onClose();
  });
}

async function finish(response, onDecision, startedAt, { action, reason, bytes, status, code }) {
  await emitDecision(onDecision, decisionEvent(action, reason, bytes, startedAt));
  if (!response.headersSent) {
    const body = Buffer.from(JSON.stringify({ error: { code } }));
    response.writeHead(status, { "content-type": "application/json", "content-length": String(body.byteLength) });
    response.end(body);
  }
}

function decisionEvent(action, reason, bytes, startedAt) {
  return { action, reason, bytes, elapsedMs: Math.max(0, Date.now() - startedAt) };
}

async function emitDecision(onDecision, event) {
  try { await onDecision(event); } catch {}
}

function listenLoopback(server, port) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, "127.0.0.1");
  });
}

function closeServer(server) {
  return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}
