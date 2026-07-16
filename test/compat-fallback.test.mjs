import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import { test } from "node:test";

import { createFallbackRouter } from "../src/compat/fallback.mjs";
import { createCoreClient, handleCompatibilityMessage } from "../src/compat/gateway.mjs";
import { inspectPendingServerHistory } from "../src/compat/server-history.mjs";

const VALID_CONFIG = {
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

test("routes typed Advisor and Code Execution requests by changing only the model", async () => {
  for (const type of ["advisor_20260301", "code_execution_20260120"]) {
    const calls = [];
    const response = { marker: type };
    const route = createFallbackRouter({
      config: VALID_CONFIG,
      async coreClient(request) {
        calls.push(request);
        return response;
      },
    });
    const body = {
      model: "example/main-model",
      max_tokens: 2048,
      metadata: { request: "opaque" },
      messages: [{ role: "user", content: "run" }],
      tools: [{ type, name: "server_tool", unknown_option: { enabled: true } }],
    };
    const before = structuredClone(body);

    const result = await route({
      body,
      headers: { "anthropic-beta": "code-execution-2025-08-25" },
    });

    assert.equal(result, response);
    assert.deepEqual(body, before);
    assert.deepEqual(calls[0].body, {
      ...before,
      model: "anthropic-messages/claude-sonnet",
    });
    assert.equal(calls[0].body.tools, body.tools);
    assert.equal(calls[0].body.messages, body.messages);
    assert.equal(calls[0].headers["anthropic-beta"], "code-execution-2025-08-25");
  }
});

test("returns Web citations, encrypted Advisor content, and unknown blocks unchanged", async () => {
  const response = {
    id: "msg_fallback",
    type: "message",
    stop_reason: "pause_turn",
    content: [
      {
        type: "web_search_tool_result",
        tool_use_id: "srvtoolu_search",
        content: [{
          type: "web_search_result",
          url: "https://example.com/source",
          title: "Source",
          encrypted_content: "opaque-search-content",
        }],
      },
      {
        type: "web_fetch_tool_result",
        tool_use_id: "srvtoolu_fetch",
        content: { type: "web_fetch_result", citations: [{ cited_text: "Exact evidence" }] },
      },
      {
        type: "advisor_tool_result",
        tool_use_id: "srvtoolu_advisor",
        content: { type: "advisor_redacted_result", encrypted_content: "opaque-advisor-content" },
      },
      { type: "future_server_result", opaque: { preserved: true } },
    ],
  };
  const route = createFallbackRouter({ config: VALID_CONFIG, coreClient: async () => response });

  const result = await route({
    body: {
      model: "example/main-model",
      messages: [{ role: "user", content: "research" }],
      tools: [{ type: "web_search_20260318", name: "web_search" }],
    },
  });

  assert.equal(result, response);
  assert.equal(result.content[0].content[0].encrypted_content, "opaque-search-content");
  assert.equal(result.content[1].content.citations[0].cited_text, "Exact evidence");
  assert.equal(result.content[2].content.encrypted_content, "opaque-advisor-content");
  assert.deepEqual(result.content[3], { type: "future_server_result", opaque: { preserved: true } });
});

test("preserves MCP servers and container while forwarding only allowed headers", async () => {
  const calls = [];
  const route = createFallbackRouter({
    config: VALID_CONFIG,
    async coreClient(request) {
      calls.push(request);
      return new Response("provider failure", { status: 503 });
    },
  });
  const body = {
    model: "example/main-model",
    container: { id: "ctr_1" },
    mcp_servers: [{
      type: "url",
      name: "example-server",
      url: "https://mcp.example.invalid",
      authorization_token: "opaque-bearer-value",
    }],
    messages: [{ role: "user", content: "use connector" }],
    tools: [{ type: "mcp_toolset", mcp_server_name: "example-server" }],
  };

  const result = await route({
    body,
    headers: {
      authorization: "Bearer client-secret",
      "anthropic-beta": "mcp-client-2025-04-04",
      "anthropic-version": "2023-06-01",
      "x-request-id": "request-1",
      "x-unsafe-private-header": "do-not-forward",
    },
  });

  assert.equal(result.status, 503);
  assert.equal(calls[0].body.container, body.container);
  assert.equal(calls[0].body.mcp_servers, body.mcp_servers);
  assert.equal(calls[0].body.mcp_servers[0].authorization_token, "opaque-bearer-value");
  assert.deepEqual(calls[0].headers, {
    "anthropic-beta": "mcp-client-2025-04-04",
    "anthropic-version": "2023-06-01",
    "x-request-id": "request-1",
  });
});

test("pairs pending calls by id and preserves mixed client continuation", () => {
  const state = inspectPendingServerHistory({
    messages: [
      {
        role: "assistant",
        content: [
          { type: "server_tool_use", id: "srvtoolu_1", name: "code_execution", input: {} },
          { type: "tool_use", id: "toolu_1", name: "get_input", input: {} },
        ],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "ready" }],
      },
    ],
  });

  assert.deepEqual(state.pendingServerCallIds, ["srvtoolu_1"]);
  assert.deepEqual(state.pendingClientCallIds, []);
  assert.deepEqual(state.serverResultIds, []);
  assert.deepEqual(state.clientResultIds, ["toolu_1"]);
  assert.deepEqual([...state.families], ["codeExecution"]);
  assert.equal(state.continuation, "mixed-client-results");
});

test("counts paired continuation turns after resetting unrelated completed history", () => {
  const state = inspectPendingServerHistory({
    container: { id: "ctr_2" },
    messages: [
      {
        role: "assistant",
        content: [
          { type: "server_tool_use", id: "srvtoolu_old", name: "code_execution", input: {} },
          {
            type: "code_execution_tool_result",
            tool_use_id: "srvtoolu_old",
            content: { type: "code_execution_result", stdout: "old" },
          },
        ],
      },
      { role: "user", content: "start a separate logical turn" },
      {
        role: "assistant",
        content: [
          { type: "server_tool_use", id: "srvtoolu_current", name: "code_execution", input: {} },
          {
            type: "code_execution_tool_result",
            tool_use_id: "srvtoolu_current",
            content: { type: "code_execution_result", stdout: "current" },
          },
        ],
      },
    ],
  });

  assert.deepEqual(state.serverCallIds, ["srvtoolu_old", "srvtoolu_current"]);
  assert.deepEqual(state.serverResultIds, ["srvtoolu_old", "srvtoolu_current"]);
  assert.deepEqual(state.pendingServerCallIds, []);
  assert.deepEqual([...state.families], ["codeExecution"]);
  assert.equal(state.containerId, "ctr_2");
  assert.equal(state.continuation, "server-continuation");
  assert.equal(state.continuationTurns, 1);
});

test("fails closed on unknown future history result blocks", () => {
  const state = inspectPendingServerHistory({
    messages: [{
      role: "user",
      content: [{
        type: "future_server_result",
        tool_use_id: "srvtoolu_future",
        opaque: { preserved: true },
      }],
    }],
  });

  assert.deepEqual(state.serverResultIds, ["srvtoolu_future"]);
  assert.equal(state.continuation, "unsupported");
  assert.equal(state.requiresFallback, true);
});

test("scopes the continuation cap to the current pending logical lifecycle", async () => {
  let calls = 0;
  const route = createFallbackRouter({
    config: {
      ...VALID_CONFIG,
      fallback: { ...VALID_CONFIG.fallback, maxContinuationTurns: 2 },
    },
    async coreClient() {
      calls += 1;
      return {};
    },
  });
  const completedHistory = ["old-one", "old-two"].flatMap((suffix) => [
    {
      role: "assistant",
      content: [{ type: "server_tool_use", id: `srvtoolu_${suffix}`, name: "advisor", input: {} }],
    },
    {
      role: "user",
      content: [{
        type: "advisor_tool_result",
        tool_use_id: `srvtoolu_${suffix}`,
        content: { type: "advisor_redacted_result", encrypted_content: `opaque-${suffix}` },
      }],
    },
  ]);

  const activeMessages = [
    ...completedHistory,
    { role: "user", content: "start a separate request" },
    {
      role: "assistant",
      content: [{ type: "server_tool_use", id: "srvtoolu_active", name: "advisor", input: {} }],
    },
  ];
  const active = inspectPendingServerHistory({ messages: activeMessages });

  assert.equal(active.continuationTurns, 1);
  await route({ body: { model: "example/main-model", messages: activeMessages } });
  assert.equal(calls, 1);

  const cappedMessages = [
    { role: "user", content: "start one logical request" },
    {
      role: "assistant",
      content: [{ type: "server_tool_use", id: "srvtoolu_first", name: "advisor", input: {} }],
    },
    {
      role: "user",
      content: [{
        type: "advisor_tool_result",
        tool_use_id: "srvtoolu_first",
        content: { type: "advisor_redacted_result", encrypted_content: "opaque-first" },
      }],
    },
    {
      role: "assistant",
      content: [{ type: "server_tool_use", id: "srvtoolu_second", name: "advisor", input: {} }],
    },
  ];
  const capped = inspectPendingServerHistory({ messages: cappedMessages });
  assert.equal(capped.continuationTurns, 2);

  await assert.rejects(
    route({ body: { model: "example/main-model", messages: cappedMessages } }),
    (error) => {
      assert.equal(error.code, "compatibility_continuation_limit");
      assert.match(error.message, /continuation limit/i);
      assert.doesNotMatch(error.message, /opaque-/);
      return true;
    },
  );
  assert.equal(calls, 1);
});

test("rejects paired pause-turn continuation loops at the configured cap", async () => {
  let calls = 0;
  const route = createFallbackRouter({
    config: {
      ...VALID_CONFIG,
      fallback: { ...VALID_CONFIG.fallback, maxContinuationTurns: 2 },
    },
    async coreClient() {
      calls += 1;
      return {};
    },
  });
  const messages = [
    { role: "user", content: "run one logical code execution" },
    ...["first", "second"].map((suffix) => ({
      role: "assistant",
      content: [
        {
          type: "server_tool_use",
          id: `srvtoolu_${suffix}`,
          name: "code_execution",
          input: { code: suffix },
        },
        {
          type: "code_execution_tool_result",
          tool_use_id: `srvtoolu_${suffix}`,
          content: { type: "code_execution_result", stdout: suffix },
        },
      ],
    })),
  ];
  const body = {
    model: "example/main-model",
    container: { id: "ctr_pause_loop" },
    messages,
  };
  const state = inspectPendingServerHistory(body);

  assert.deepEqual(state.pendingServerCallIds, []);
  assert.equal(state.continuationTurns, 2);
  await assert.rejects(route({ body }), { code: "compatibility_continuation_limit" });
  assert.equal(calls, 0);
});

test("propagates abort and timeout without rewriting provider errors", async () => {
  let calls = 0;
  const timeout = new DOMException("provider timed out", "TimeoutError");
  const route = createFallbackRouter({
    config: VALID_CONFIG,
    async coreClient({ signal }) {
      calls += 1;
      assert.equal(signal?.aborted, false);
      throw timeout;
    },
  });
  const body = { model: "example/main-model", messages: [] };
  const aborted = new AbortController();
  aborted.abort();

  await assert.rejects(route({ body, signal: aborted.signal }), { name: "AbortError" });
  assert.equal(calls, 0);
  await assert.rejects(route({ body, signal: new AbortController().signal }), (error) => error === timeout);
  assert.equal(calls, 1);
});

test("gateway sends typed server tools through whole-request fallback unchanged", async () => {
  const calls = [];
  const response = {
    id: "msg_gateway_fallback",
    type: "message",
    role: "assistant",
    model: "anthropic/claude-sonnet",
    content: [{ type: "future_result", opaque: true }],
    stop_reason: "pause_turn",
    usage: { input_tokens: 3, output_tokens: 1 },
  };
  const body = {
    model: "example/main-model",
    max_tokens: 512,
    messages: [{ role: "user", content: "run code" }],
    tools: [{ type: "code_execution_20260521", name: "code_execution" }],
  };
  const coreClient = {
    async requestMessage(requestBody, headers, signal) {
      calls.push({ body: requestBody, headers, signal });
      return response;
    },
  };

  const result = await handleCompatibilityMessage({
    body,
    config: VALID_CONFIG,
    coreClient,
    headers: { "anthropic-beta": "code-execution-2025-08-25" },
  });

  assert.equal(result, response);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.model, "anthropic-messages/claude-sonnet");
  assert.equal(calls[0].body.messages, body.messages);
  assert.equal(calls[0].body.tools, body.tools);
});

test("real core fallback preserves stream true, SSE bytes, and backpressure", async (t) => {
  let seenBody;
  let releaseSecondChunk;
  const secondChunkGate = new Promise((resolve) => {
    releaseSecondChunk = resolve;
  });
  const firstChunk = Buffer.from("event: message_start\ndata: {\"type\":\"message_start\"}\n\n");
  const secondChunk = Buffer.from("event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n");
  const fixture = await createFallbackCoreFixture(t, async ({ body, response }) => {
    seenBody = body;
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "x-request-id": "fallback-stream",
    });
    response.write(firstChunk);
    await secondChunkGate;
    response.end(secondChunk);
  });
  const downstream = createFallbackResponse({ backpressure: true });
  let settled = false;
  const pending = handleCompatibilityMessage({
    body: fallbackBody({ stream: true }),
    config: VALID_CONFIG,
    coreClient: createCoreClient(fixture.options),
    headers: { "anthropic-version": "2023-06-01" },
    response: downstream,
  }).finally(() => {
    settled = true;
  });

  const firstEvent = await Promise.race([
    downstream.firstWrite.then(() => "write"),
    new Promise((resolve) => setTimeout(() => resolve("timed-out"), 200)),
  ]);
  if (firstEvent !== "write") {
    releaseSecondChunk();
    downstream.releaseDrain();
    await pending.catch(() => {});
  }
  assert.equal(firstEvent, "write");
  assert.equal(seenBody.stream, true);
  assert.equal(seenBody.model, "anthropic/claude-sonnet");
  assert.equal(downstream.statusCode, 200);
  assert.equal(downstream.headers["content-type"], "text/event-stream");
  assert.equal(downstream.headers["x-request-id"], "fallback-stream");
  assert.deepEqual(downstream.body, firstChunk);
  assert.equal(settled, false);

  releaseSecondChunk();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  downstream.releaseDrain();
  await pending;
  assert.deepEqual(downstream.body, Buffer.concat([firstChunk, secondChunk]));
});

test("real core fallback preserves non-2xx status, headers, and body", async (t) => {
  let seenBody;
  const errorBody = Buffer.from(JSON.stringify({
    type: "error",
    error: { type: "rate_limit_error", message: "try later" },
  }));
  const fixture = await createFallbackCoreFixture(t, async ({ body, response }) => {
    seenBody = body;
    response.writeHead(429, {
      "content-type": "application/json",
      "retry-after": "3",
      "x-request-id": "fallback-rate-limit",
    });
    response.end(errorBody);
  });
  const downstream = createFallbackResponse();

  await handleCompatibilityMessage({
    body: fallbackBody({ stream: true }),
    config: VALID_CONFIG,
    coreClient: createCoreClient(fixture.options),
    response: downstream,
  });

  assert.equal(seenBody.stream, true);
  assert.equal(downstream.statusCode, 429);
  assert.equal(downstream.headers["content-type"], "application/json");
  assert.equal(downstream.headers["retry-after"], "3");
  assert.equal(downstream.headers["x-request-id"], "fallback-rate-limit");
  assert.deepEqual(downstream.body, errorBody);
});

test("real core fallback cancels upstream when the downstream closes", async (t) => {
  let upstreamClosed;
  const upstreamClose = new Promise((resolve) => {
    upstreamClosed = resolve;
  });
  const fixture = await createFallbackCoreFixture(t, async ({ response }) => {
    const timeout = setTimeout(() => response.end(), 200);
    response.once("close", () => {
      clearTimeout(timeout);
      upstreamClosed();
    });
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write("event: message_start\ndata: {}\n\n");
  });
  const downstream = createFallbackResponse();
  const pending = handleCompatibilityMessage({
    body: fallbackBody({ stream: true }),
    config: VALID_CONFIG,
    coreClient: createCoreClient(fixture.options),
    response: downstream,
  });

  const firstEvent = await Promise.race([
    downstream.firstWrite.then(() => "write"),
    pending.then(() => "settled", () => "settled"),
  ]);
  assert.equal(firstEvent, "write");
  downstream.emit("close");
  await assert.rejects(pending, { code: "ERR_STREAM_PREMATURE_CLOSE" });
  await upstreamClose;
});

function fallbackBody(overrides = {}) {
  return {
    model: "example/main-model",
    max_tokens: 512,
    messages: [{ role: "user", content: "run code" }],
    tools: [{ type: "code_execution_20260521", name: "code_execution" }],
    ...overrides,
  };
}

async function createFallbackCoreFixture(t, handler) {
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    await handler({
      body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
      request,
      response,
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return {
    options: {
      config: {
        gateway: {
          coreHost: "127.0.0.1",
          corePort: server.address().port,
          generatedConfigFile: "/fixture/generated.json",
        },
      },
      readFile: () => JSON.stringify({
        auth: { staticApiKeys: { keys: ["generated-core-token"] } },
      }),
    },
  };
}

function createFallbackResponse({ backpressure = false } = {}) {
  const chunks = [];
  let notifyFirstWrite;
  const firstWrite = new Promise((resolve) => {
    notifyFirstWrite = resolve;
  });
  const response = Object.assign(new EventEmitter(), {
    firstWrite,
    headers: {},
    statusCode: 200,
    writeHead(statusCode, headers) {
      this.statusCode = statusCode;
      this.headers = Object.fromEntries(
        Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]),
      );
    },
    write(chunk) {
      chunks.push(Buffer.from(chunk));
      notifyFirstWrite();
      return !backpressure;
    },
    end(chunk) {
      if (chunk !== undefined) chunks.push(Buffer.from(chunk));
      this.emit("finish");
    },
    releaseDrain() {
      backpressure = false;
      this.emit("drain");
    },
  });
  Object.defineProperty(response, "body", { get: () => Buffer.concat(chunks) });
  return response;
}
