import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { once } from "node:events";
import { test } from "node:test";

import { startCompatibilityMiddleware } from "../src/compat/middleware.mjs";

const GATEWAY_TOKEN = "adapter-gateway-token";
const COMPATIBILITY = {
  fallback: {
    provider: "anthropic-messages",
    model: "claude-sonnet",
    maxContinuationTurns: 8,
  },
  toolSearch: { mode: "bridge" },
  webSearch: { mode: "native-first" },
  webFetch: { mode: "native-first" },
  codeExecution: { mode: "anthropic-fallback" },
  advisor: { mode: "anthropic-fallback" },
  mcpConnector: { mode: "anthropic-fallback" },
};

test("middleware authenticates callers and forwards ordinary Messages requests through the public gateway", async (t) => {
  const upstream = await startFixture(t, async (request, response) => {
    const body = await readBody(request);
    assert.equal(request.url, "/v1/messages");
    assert.equal(request.headers["x-api-key"], GATEWAY_TOKEN);
    assert.equal(request.headers.authorization, undefined);
    assert.equal(request.headers.cookie, undefined);
    assert.equal(request.headers["x-ccr-core-auth"], undefined);
    assert.deepEqual(JSON.parse(body), { model: "claude-sonnet", messages: [] });
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"type":"message","content":[]}');
  });
  const adapter = await startAdapter(t, upstream.origin);

  const denied = await fetch(`${adapter.origin}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: '{"model":"claude-sonnet","messages":[]}',
  });
  assert.equal(denied.status, 401);

  const result = await fetch(`${adapter.origin}/v1/messages`, {
    method: "POST",
    headers: {
      authorization: "Bearer caller-secret",
      cookie: "caller-cookie",
      "content-type": "application/json",
      "x-api-key": GATEWAY_TOKEN,
      "x-ccr-core-auth": "attacker-secret",
    },
    body: '{"model":"claude-sonnet","messages":[]}',
  });

  assert.equal(result.status, 200);
  assert.equal(await result.text(), '{"type":"message","content":[]}');
});

test("middleware preserves upstream SSE bytes and 429 responses", async (t) => {
  const sse = Buffer.from("event: message_start\\ndata: {\\\"type\\\":\\\"message_start\\\"}\\n\\nevent: message_stop\\ndata: {\\\"type\\\":\\\"message_stop\\\"}\\n\\n");
  let requestCount = 0;
  const upstream = await startFixture(t, async (_request, response) => {
    requestCount += 1;
    if (requestCount === 1) {
      response.writeHead(200, { "content-type": "text/event-stream", "x-upstream": "sse" });
      response.write(sse.subarray(0, 17));
      response.end(sse.subarray(17));
      return;
    }
    response.writeHead(429, { "content-type": "application/json", "retry-after": "7" });
    response.end('{"error":{"type":"rate_limit_error"}}');
  });
  const adapter = await startAdapter(t, upstream.origin);

  const streamed = await adapterFetch(adapter.origin, "/v1/messages", {
    model: "claude-sonnet", messages: [], stream: true,
  });
  assert.equal(streamed.status, 200);
  assert.equal(streamed.headers.get("x-upstream"), "sse");
  assert.deepEqual(Buffer.from(await streamed.arrayBuffer()), sse);

  const throttled = await adapterFetch(adapter.origin, "/v1/messages", {
    model: "claude-sonnet", messages: [],
  });
  assert.equal(throttled.status, 429);
  assert.equal(throttled.headers.get("retry-after"), "7");
  assert.equal(await throttled.text(), '{"error":{"type":"rate_limit_error"}}');
});

test("middleware proxies non-compatibility gateway paths with the generated gateway token", async (t) => {
  const upstream = await startFixture(t, async (request, response) => {
    assert.equal(request.url, "/v1/models?limit=3");
    assert.equal(request.headers["x-api-key"], GATEWAY_TOKEN);
    assert.equal(request.headers.authorization, undefined);
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"data":[{"id":"claude-sonnet"}]}');
  });
  const adapter = await startAdapter(t, upstream.origin);

  const result = await fetch(`${adapter.origin}/v1/models?limit=3`, {
    headers: { authorization: "Bearer caller-secret", "x-api-key": GATEWAY_TOKEN },
  });

  assert.equal(result.status, 200);
  assert.deepEqual(await result.json(), { data: [{ id: "claude-sonnet" }] });
});

test("middleware rejects scheme-relative targets before the gateway key can leave the configured origin", async (t) => {
  let forwarded = false;
  const upstream = await startFixture(t, async (_request, response) => {
    forwarded = true;
    response.writeHead(200).end();
  });
  const adapter = await startAdapter(t, upstream.origin);
  const target = new URL(adapter.origin);

  const status = await new Promise((resolve, reject) => {
    const request = httpRequest({
      host: target.hostname,
      port: target.port,
      path: "//attacker.example/v1/models",
      headers: { "x-api-key": GATEWAY_TOKEN },
    }, (response) => {
      response.resume();
      response.once("end", () => resolve(response.statusCode));
    });
    request.once("error", reject);
    request.end();
  });

  assert.equal(status, 400);
  assert.equal(forwarded, false);
});

test("middleware rejects backslash targets before the gateway key can leave the configured origin", async (t) => {
  let forwarded = false;
  const upstream = await startFixture(t, async (_request, response) => {
    forwarded = true;
    response.writeHead(200).end();
  });
  const adapter = await startAdapter(t, upstream.origin);
  const target = new URL(adapter.origin);

  const status = await new Promise((resolve, reject) => {
    const request = httpRequest({
      host: target.hostname,
      port: target.port,
      path: "/\\attacker.example/v1/models",
      headers: { "x-api-key": GATEWAY_TOKEN },
    }, (response) => {
      response.resume();
      response.once("end", () => resolve(response.statusCode));
    });
    request.once("error", reject);
    request.end();
  });

  assert.equal(status, 400);
  assert.equal(forwarded, false);
});

test("middleware aborts the public-gateway request when the caller disconnects", async (t) => {
  let notifyStarted;
  let notifyAborted;
  const started = new Promise((resolve) => { notifyStarted = resolve; });
  const aborted = new Promise((resolve) => { notifyAborted = resolve; });
  const upstream = await startFixture(t, async (request) => {
    request.once("aborted", notifyAborted);
    notifyStarted();
    await new Promise(() => {});
  });
  const adapter = await startAdapter(t, upstream.origin);
  const controller = new AbortController();
  const pending = adapterFetch(adapter.origin, "/v1/messages", {
    model: "claude-sonnet", messages: [], stream: true,
  }, controller.signal);

  await started;
  controller.abort();
  await assert.rejects(pending, (error) => error.name === "AbortError");
  await Promise.race([
    aborted,
    new Promise((_, reject) => setTimeout(() => reject(new Error("upstream was not aborted")), 1_000)),
  ]);
});

test("middleware aborts a compatibility MCP WebSearch request when the caller disconnects", async (t) => {
  let notifyStarted;
  let notifyUpstreamClosed;
  let upstreamResponse;
  const started = new Promise((resolve) => { notifyStarted = resolve; });
  const upstreamClosed = new Promise((resolve) => { notifyUpstreamClosed = resolve; });
  const upstream = await startFixture(t, async (request, response) => {
    await readBody(request);
    upstreamResponse = response;
    response.once("close", notifyUpstreamClosed);
    notifyStarted();
    await once(response, "close");
  });
  const adapter = await startAdapter(t, upstream.origin);
  const target = new URL(adapter.origin);
  const requestBody = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "web_search", arguments: { query: "abort MCP request" } },
  });
  const client = httpRequest({
    host: target.hostname,
    method: "POST",
    port: target.port,
    path: "/airkit/compatibility/mcp",
    headers: {
      "content-length": String(Buffer.byteLength(requestBody)),
      "content-type": "application/json",
      "x-api-key": GATEWAY_TOKEN,
    },
  });
  const clientClosed = new Promise((resolve) => client.once("close", resolve));
  client.once("error", () => {});
  client.end(requestBody);

  await started;
  client.destroy();
  await clientClosed;
  await awaitWithin(upstreamClosed, "MCP upstream was not aborted", () => upstreamResponse?.destroy());
});

test("middleware serves compatibility MCP WebSearch through the public gateway", async (t) => {
  const upstream = await startFixture(t, async (request, response) => {
    const body = JSON.parse(await readBody(request));
    assert.equal(request.url, "/v1/messages");
    assert.equal(request.headers["x-api-key"], GATEWAY_TOKEN);
    assert.equal(body.model, "anthropic-messages/claude-sonnet");
    assert.equal(body.tools[0].type, "web_search_20250305");
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      type: "message",
      content: [
        { type: "text", text: "A result" },
        {
          type: "web_search_tool_result",
          content: [{ type: "web_search_result", title: "Example", url: "https://example.com" }],
        },
      ],
    }));
  });
  const adapter = await startAdapter(t, upstream.origin);

  const result = await adapterFetch(adapter.origin, "/airkit/compatibility/mcp", {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "web_search", arguments: { query: "adapter test" } },
  });

  assert.equal(result.status, 200);
  assert.deepEqual(await result.json(), {
    jsonrpc: "2.0",
    id: 1,
    result: {
      content: [{ type: "text", text: "A result" }],
      structuredContent: {
        results: [{ title: "Example", url: "https://example.com/" }],
        summary: "A result",
      },
    },
  });
});

async function startAdapter(t, gatewayOrigin) {
  const adapter = await startCompatibilityMiddleware({
    compatibility: COMPATIBILITY,
    gatewayOrigin,
    gatewayToken: GATEWAY_TOKEN,
  });
  t.after(() => adapter.close());
  return adapter;
}

async function startFixture(t, handler) {
  const server = createServer((request, response) => {
    void handler(request, response).catch((error) => response.destroy(error));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  return { origin: `http://127.0.0.1:${address.port}` };
}

function adapterFetch(origin, path, body, signal) {
  return fetch(`${origin}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": GATEWAY_TOKEN },
    body: JSON.stringify(body),
    signal,
  });
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function awaitWithin(promise, message, onTimeout) {
  let timeout;
  try {
    await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeout = setTimeout(() => {
          onTimeout();
          reject(new Error(message));
        }, 1_000);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}
