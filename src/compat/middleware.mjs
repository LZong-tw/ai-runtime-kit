import { timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";

import { createGatewayClient } from "./gateway.mjs";
import { createGptActivitySseTransform } from "./activity.mjs";
import {
  createMcpHandler,
  createMessagesHandler,
} from "./plugin.mjs";
import {
  AIRKIT_MODE_HEADER,
  VERIFIED_NATIVE_COMPATIBILITY,
  resolveCompatibilityPolicies,
  validateCompatibilityConfig,
} from "./config.mjs";

const JSON_ERROR = Buffer.from(JSON.stringify({
  error: { message: "Compatibility middleware forwarding failed", type: "api_error" },
}));

export async function startCompatibilityMiddleware({
  compatibility,
  gatewayOrigin,
  gatewayToken,
  clientToken = gatewayToken,
  mode,
  port = 0,
}) {
  validateCompatibilityConfig(compatibility);
  if (typeof clientToken !== "string" || clientToken.length === 0) {
    throw new Error("compatibility client authentication is missing or invalid");
  }
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error("compatibility middleware port must be an integer from 0 through 65535");
  }
  if (mode !== undefined && (typeof mode !== "string" || mode.trim() === "")) {
    throw new Error("compatibility middleware mode must be a non-empty string when provided");
  }
  const coreClient = createGatewayClient({
    origin: gatewayOrigin,
    token: gatewayToken,
    responseTransformFactory: createGptActivitySseTransform,
  });
  const { policies } = resolveCompatibilityPolicies(
    compatibility,
    VERIFIED_NATIVE_COMPATIBILITY,
  );
  const messages = createMessagesHandler({
    config: compatibility,
    coreClient,
    policies,
  });
  const mcp = createMcpHandler({ config: compatibility, coreClient });
  const server = createServer((request, response) => {
    void handleRequest({
      coreClient,
      gatewayToken: clientToken,
      mcp,
      messages,
      mode,
      request,
      response,
    });
  });

  await listenLoopback(server, port);
  const address = server.address();
  if (address === null || typeof address === "string") {
    await closeServer(server);
    throw new Error("Compatibility middleware did not expose a loopback address");
  }
  return {
    close: () => closeServer(server),
    origin: `http://127.0.0.1:${address.port}`,
  };
}

async function handleRequest({ coreClient, gatewayToken, mcp, messages, mode, request, response }) {
  if (!isAuthorized(request.headers, gatewayToken)) {
    request.resume();
    response.writeHead(401, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: "Invalid API key", type: "authentication_error" } }));
    return;
  }

  const target = requestTarget(request.url);
  if (target === null) {
    request.resume();
    response.writeHead(400, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: "Invalid request path", type: "invalid_request_error" } }));
    return;
  }
  const path = new URL(target, "http://airkit.local").pathname;
  if (mode !== undefined && request.headers[AIRKIT_MODE_HEADER] === undefined) {
    // External clients do not know AirKit's private mode header. Stamp it only
    // for the compatibility handlers; the gateway's safe-header allowlist
    // keeps this internal routing label out of the upstream request.
    request.headers = { ...request.headers, [AIRKIT_MODE_HEADER]: mode };
  }
  try {
    if (request.method === "POST" && path === "/v1/messages") {
      await messages(request, response, { readBody });
      return;
    }
    if (request.method === "POST" && path === "/airkit/compatibility/mcp") {
      await mcp(request, response, { readBody });
      return;
    }
    await coreClient.forward({
      body: request.method === "GET" || request.method === "HEAD" ? undefined : request,
      headers: request.headers,
      method: request.method,
      path: target,
      response,
      signal: requestLifecycleSignal(request, response),
    });
  } catch (error) {
    containFailure(response, error);
  }
}

function isAuthorized(headers, expectedToken) {
  const apiKeyMatches = tokenMatches(headers?.["x-api-key"], expectedToken);
  const bearerMatches = tokenMatches(bearerToken(headers?.authorization), expectedToken);
  return apiKeyMatches || bearerMatches;
}

function bearerToken(value) {
  if (typeof value !== "string") return "";
  const match = value.match(/^Bearer\s+(.+)$/i);
  return match?.[1] ?? "";
}

function tokenMatches(value, expectedToken) {
  const received = typeof value === "string" ? Buffer.from(value) : Buffer.alloc(0);
  const expected = Buffer.from(expectedToken);
  return received.byteLength === expected.byteLength && timingSafeEqual(received, expected);
}

function requestTarget(url) {
  // A leading `//` is a scheme-relative URL when resolved with `new URL()`.
  // Backslashes are normalized to slashes by `new URL()` too. Reject both so
  // the generated gateway key can only ever reach the configured CCR origin.
  if (
    typeof url !== "string" ||
    !url.startsWith("/") ||
    url.startsWith("//") ||
    url.includes("\\")
  ) return null;
  return url;
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
  return controller.signal;
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function containFailure(response, error) {
  if (response.destroyed === true) return;
  if (response.headersSent !== true) {
    response.writeHead(502, { "content-type": "application/json", "content-length": String(JSON_ERROR.byteLength) });
    response.end(JSON_ERROR);
    return;
  }
  response.destroy(error instanceof Error ? error : new Error(String(error)));
}

function listenLoopback(server, port = 0) {
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
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
