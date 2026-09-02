import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

const PROTOCOL = "airkit-privacy-ndjson-v1";
const MAX_BODY_BYTES = 1_048_576;
const MAX_FRAME_BYTES = 1_048_576;
const DEFAULT_TIMEOUT_MS = 2_000;
const KNOWN_LABELS = new Set(["address", "credit-card", "email", "ip-address", "person", "phone", "ssn", "token"]);

export async function createPrivacyFilter({ provision, spawnWorker = defaultSpawnWorker, validateWorker = validatePrivacyWorkerAsset, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const privacy = assertPrivacyProvision(provision);
  if (typeof spawnWorker !== "function") throw new TypeError("shield privacy worker launcher is required");
  if (typeof validateWorker !== "function") throw new TypeError("shield privacy worker validator is required");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) throw new TypeError("shield privacy worker timeout is invalid");

  try { await validateWorker(privacy.worker); } catch { throw new Error("shield privacy worker unavailable"); }

  let worker;
  try {
    worker = spawnWorker({ command: privacy.worker.command, args: privacy.worker.args, shell: false, stdio: ["pipe", "pipe", "pipe"] });
  } catch {
    throw new Error("shield privacy worker unavailable");
  }
  if (!worker?.stdin || !worker?.stdout || typeof worker.stdin.write !== "function" || typeof worker.stdout.on !== "function") {
    throw new Error("shield privacy worker unavailable");
  }

  const pending = new Map();
  let remainder = Buffer.alloc(0);
  let stderrBytes = 0;
  let closed = false;
  const failAll = () => {
    for (const entry of pending.values()) entry.resolve(null);
    pending.clear();
  };
  const close = () => {
    if (closed) return;
    closed = true;
    failAll();
    try { worker.kill?.(); } catch {}
  };
  const failWorker = () => { close(); };
  worker.once?.("error", failWorker);
  worker.once?.("exit", failWorker);
  worker.stdout.on("data", (chunk) => {
    if (closed) return;
    const incomingBytes = Buffer.isBuffer(chunk) || chunk instanceof Uint8Array ? chunk.byteLength : Buffer.byteLength(chunk);
    if (incomingBytes > MAX_FRAME_BYTES || remainder.byteLength > MAX_FRAME_BYTES - incomingBytes) { failWorker(); return; }
    const next = Buffer.concat([remainder, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
    const lines = next.toString("utf8").split("\n");
    remainder = Buffer.from(lines.pop() ?? "");
    if (remainder.byteLength > MAX_FRAME_BYTES) { failWorker(); return; }
    for (const line of lines) {
      if (Buffer.byteLength(line) > MAX_FRAME_BYTES) { failWorker(); return; }
      consumeReply(line, pending);
    }
  });
  worker.stderr?.on?.("data", (chunk) => {
    stderrBytes += Buffer.byteLength(chunk);
    if (stderrBytes > MAX_FRAME_BYTES) failWorker();
  });

  const request = async (message) => {
    if (closed) return null;
    const id = randomUUID();
    const payload = JSON.stringify({ ...message, id, protocol: PROTOCOL });
    if (Buffer.byteLength(payload) > MAX_FRAME_BYTES) return null;
    return await new Promise((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        resolve(null);
      }, timeoutMs);
      pending.set(id, { expectedType: message.type, resolve: (reply) => { clearTimeout(timer); resolve(reply); } });
      try { worker.stdin.write(`${payload}\n`); } catch { pending.delete(id); clearTimeout(timer); resolve(null); }
    });
  };

  const health = await request({ type: "health" });
  if (!validHealth(health, privacy.version)) {
    close();
    throw new Error("shield privacy worker unavailable");
  }
  return Object.freeze({
    version: privacy.version,
    async scan(body) {
      if (closed || !validBody(body)) return unavailable();
      const reply = await request({ type: "scan", body: Buffer.from(body).toString("base64") });
      return normalizeScanReply(reply);
    },
    close,
  });
}

export async function runPrivacyWorkerSelfTest(provision, { spawnWorker = defaultSpawnWorker, validateWorker = validatePrivacyWorkerAsset, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const filter = await createPrivacyFilter({ provision, spawnWorker, validateWorker, timeoutMs });
  try {
    const original = Buffer.from('{"content":"AIRKIT_PRIVACY_PROTOCOL_PROBE_EMAIL"}');
    const result = await filter.scan(original);
    if (!isVerifiedRedaction({ original, result }) || !result.findings.some((finding) => finding.label === "email") || result.redactedBody.includes("AIRKIT_PRIVACY_PROTOCOL_PROBE_EMAIL")) {
      throw new Error("shield privacy worker self-test failed");
    }
    return Object.freeze({ version: filter.version });
  } catch {
    throw new Error("shield privacy worker self-test failed");
  } finally {
    filter.close();
  }
}

function consumeReply(line, pending) {
  let reply;
  try { reply = JSON.parse(line); } catch { failPending(pending); return; }
  if (!isPlainObject(reply) || typeof reply.id !== "string" || typeof reply.type !== "string") { failPending(pending); return; }
  const entry = pending.get(reply.id);
  if (!entry || entry.expectedType !== reply.type) { failPending(pending); return; }
  pending.delete(reply.id);
  entry.resolve(reply);
}

function failPending(pending) {
  for (const entry of pending.values()) entry.resolve(null);
  pending.clear();
}

function validHealth(reply, version) {
  return isPlainObject(reply) && reply.type === "health" && reply.protocol === PROTOCOL && reply.version === version;
}

function normalizeScanReply(reply) {
  if (!isPlainObject(reply) || reply.type !== "scan" || typeof reply.status !== "string") return unavailable();
  if (reply.status === "unknown") return Object.freeze({ status: "unknown", findings: Object.freeze([]) });
  if (reply.status !== "ok" || !Array.isArray(reply.findings) || reply.findings.length > 128) return unavailable();
  const findings = [];
  for (const finding of reply.findings) {
    if (!isPlainObject(finding) || !KNOWN_LABELS.has(finding.label) || !Number.isInteger(finding.count) || finding.count < 1 || finding.count > 1024) {
      return Object.freeze({ status: "unknown", findings: Object.freeze([]) });
    }
    findings.push(Object.freeze({ label: finding.label, count: finding.count }));
  }
  const result = { status: "ok", findings: Object.freeze(findings) };
  if (reply.redactions !== undefined) {
    const redactions = normalizeRedactions(reply.redactions);
    if (redactions === null) return unavailable();
    result.redactions = redactions;
  }
  if (reply.redactedBody !== undefined) {
    const redactedBody = decodeRedactedBody(reply.redactedBody);
    if (redactedBody === null) return unavailable();
    result.redactedBody = redactedBody;
  }
  return Object.freeze(result);
}

function normalizeRedactions(value) {
  if (!Array.isArray(value) || value.length > 128) return null;
  const result = [];
  for (const entry of value) {
    if (!isPlainObject(entry) || !KNOWN_LABELS.has(entry.label) || !Number.isInteger(entry.count) || entry.count < 1 || entry.count > 1024) return null;
    const spans = entry.spans === undefined ? undefined : normalizeSpans(entry.spans, entry.count);
    if (spans === null) return null;
    result.push(Object.freeze({ label: entry.label, count: entry.count, ...(spans === undefined ? {} : { spans }) }));
  }
  return Object.freeze(result);
}

function normalizeSpans(value, count) {
  if (!Array.isArray(value) || value.length !== count) return null;
  const spans = [];
  for (const span of value) {
    if (!isPlainObject(span) || !Number.isInteger(span.start) || !Number.isInteger(span.end) || span.start < 0 || span.end <= span.start || span.end > MAX_BODY_BYTES) return null;
    spans.push(Object.freeze({ start: span.start, end: span.end }));
  }
  return Object.freeze(spans);
}

export function isVerifiedRedaction({ original, result } = {}) {
  if (!validBody(original) || result?.status !== "ok" || !Buffer.isBuffer(result.redactedBody) || result.redactedBody.equals(Buffer.from(original))) return false;
  if (!Array.isArray(result.findings) || !Array.isArray(result.redactions)) return false;
  const counts = new Map();
  for (const redaction of result.redactions) {
    if (!Array.isArray(redaction.spans) || redaction.spans.length !== redaction.count) return false;
    for (const span of redaction.spans) {
      if (!Number.isInteger(span.start) || !Number.isInteger(span.end) || span.start < 0 || span.end <= span.start || span.end > original.byteLength) return false;
      const originalValue = Buffer.from(original).subarray(span.start, span.end);
      if (result.redactedBody.includes(originalValue)) return false;
    }
    counts.set(redaction.label, (counts.get(redaction.label) ?? 0) + redaction.count);
  }
  return result.findings.every((finding) => counts.get(finding.label) >= finding.count);
}

function decodeRedactedBody(value) {
  if (typeof value !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return null;
  const body = Buffer.from(value, "base64");
  if (body.byteLength === 0 || body.byteLength > MAX_BODY_BYTES) return null;
  try { JSON.parse(body.toString("utf8")); } catch { return null; }
  return Buffer.from(body);
}

function assertPrivacyProvision(provision) {
  const privacy = provision?.privacy;
  if (!isPlainObject(privacy) || !safeIdentifier(privacy.version) || !isPlainObject(privacy.worker)
    || !isAbsoluteCanonical(privacy.worker.command) || !Array.isArray(privacy.worker.args)
    || !privacy.worker.args.every((argument) => typeof argument === "string" && argument.length > 0 && argument.length <= 256)
    || !/^[a-f0-9]{64}$/.test(privacy.worker.sha256 ?? "")) {
    throw new TypeError("shield privacy provision is invalid");
  }
  return Object.freeze({ version: privacy.version, worker: Object.freeze({ command: privacy.worker.command, args: Object.freeze([...privacy.worker.args]), sha256: privacy.worker.sha256 }) });
}

export async function validatePrivacyWorkerAsset(worker, { io = { lstat, readFile, realpath } } = {}) {
  if (!isPlainObject(worker) || !isAbsolute(worker.command) || resolve(worker.command) !== worker.command || !/^[a-f0-9]{64}$/.test(worker.sha256 ?? "")) {
    throw new Error("shield privacy worker provision is invalid");
  }
  let entry;
  let canonicalPath;
  let bytes;
  try { [entry, canonicalPath, bytes] = await Promise.all([io.lstat(worker.command), io.realpath(worker.command), io.readFile(worker.command)]); }
  catch { throw new Error("shield privacy worker validation failed"); }
  if (canonicalPath !== worker.command || entry.isSymbolicLink?.() || !entry.isFile?.() || (entry.mode & 0o022) !== 0 || (entry.mode & 0o100) === 0
    || (typeof process.getuid === "function" && entry.uid !== process.getuid())
    || createHash("sha256").update(bytes).digest("hex") !== worker.sha256) {
    throw new Error("shield privacy worker validation failed");
  }
  return Object.freeze({ command: worker.command, sha256: worker.sha256 });
}

function validBody(body) { return (Buffer.isBuffer(body) || body instanceof Uint8Array) && body.byteLength <= MAX_BODY_BYTES; }
function unavailable() { return Object.freeze({ status: "unavailable", findings: Object.freeze([]) }); }
function safeIdentifier(value) { return typeof value === "string" && /^[A-Za-z0-9._-]{1,128}$/.test(value); }
function isAbsoluteCanonical(value) { return typeof value === "string" && value.startsWith("/") && !value.includes("//") && !value.includes("/../") && !value.endsWith("/.."); }
function isPlainObject(value) { return value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype; }
function defaultSpawnWorker({ command, args, shell, stdio }) { return spawn(command, args, { shell, stdio }); }
