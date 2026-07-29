import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import { test } from "node:test";
import {
  createCoreClient,
  handleCompatibilityMessage,
  writeAnthropicMessage,
} from "../src/compat/gateway.mjs";
import plugin from "../src/compat/plugin.mjs";

const CORE_TOKEN = "generated-core-token";
const RAW_RESPONSE_BODY = Buffer.from([0, 1, 2, 255, 10]);
const COMPLETE_PLUGIN_CONFIG = {
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
const PLUGIN_RUNTIME_CONFIG = {
  Providers: [{
    name: "anthropic-messages",
    type: "anthropic_messages",
    models: ["claude-sonnet"],
  }],
};

test("core client uses generated x-ccr-core-auth without forwarding client secrets", async (t) => {
  const fixture = await createCoreFixture(t, { tokenEntry: { key: CORE_TOKEN } });
  const client = createCoreClient(fixture.options);
  const result = await client.requestMessage(
    { model: "claude-sonnet", messages: [] },
    {
      accept: "application/json",
      authorization: "Bearer outer-secret",
      baggage: "trace=value",
      connection: "upgrade",
      cookie: "session=outer-secret",
      "anthropic-beta": "tool-search-tool-2025-11-19",
      "anthropic-version": "2023-06-01",
      b3: "0123456789abcdef0123456789abcdef-0123456789abcdef-1",
      traceparent: "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01",
      "user-agent": "fixture-agent",
      "x-api-key": "outer-key",
      "x-ccr-core-auth": "attacker-token",
      "x-ccr-extra": "attacker-value",
      "x-datadog-api-key": "trace-secret",
      "x-b3-api-key": "b3-secret",
      "x-b3-flags": "1",
      "x-b3-parentspanid": "0123456789abcdef",
      "x-b3-sampled": "1",
      "x-b3-spanid": "fedcba9876543210",
      "x-b3-traceid": "0123456789abcdef0123456789abcdef",
      "x-request-id": "request-123",
    },
  );

  assert.equal(result.type, "message");
  assert.equal(fixture.seen.headers["x-ccr-core-auth"], fixture.coreToken);
  assert.equal(fixture.seen.headers.authorization, undefined);
  assert.equal(fixture.seen.headers["x-api-key"], undefined);
  assert.equal(fixture.seen.headers.cookie, undefined);
  assert.notEqual(fixture.seen.headers.connection, "upgrade");
  assert.equal(fixture.seen.headers["x-ccr-extra"], undefined);
  assert.equal(fixture.seen.headers["x-datadog-api-key"], undefined);
  assert.equal(fixture.seen.headers["x-b3-api-key"], undefined);
  assert.equal(
    fixture.seen.headers.b3,
    "0123456789abcdef0123456789abcdef-0123456789abcdef-1",
  );
  assert.equal(fixture.seen.headers["x-b3-flags"], "1");
  assert.equal(fixture.seen.headers["x-b3-parentspanid"], "0123456789abcdef");
  assert.equal(fixture.seen.headers["x-b3-sampled"], "1");
  assert.equal(fixture.seen.headers["x-b3-spanid"], "fedcba9876543210");
  assert.equal(
    fixture.seen.headers["x-b3-traceid"],
    "0123456789abcdef0123456789abcdef",
  );
  assert.equal(
    fixture.seen.headers["anthropic-beta"],
    "tool-search-tool-2025-11-19",
  );
  assert.equal(fixture.seen.headers["anthropic-version"], "2023-06-01");
  assert.equal(fixture.seen.headers["x-request-id"], "request-123");
  assert.equal(fixture.seen.headers.baggage, "trace=value");
  assert.equal(JSON.parse(fixture.seen.body).stream, false);
});

test("raw passthrough preserves ordinary request and response bytes", async (t) => {
  const fixture = await createCoreFixture(t);
  const client = createCoreClient(fixture.options);
  const requestBody = Buffer.from('{"model":"executor","messages":[]}');
  const response = createRecordingResponse();

  await client.forwardRaw({ body: requestBody, headers: {}, method: "POST", response });

  assert.deepEqual(fixture.seen.body, requestBody);
  assert.deepEqual(response.body, fixture.rawResponseBody);
  assert.equal(response.statusCode, 202);
  assert.equal(response.headers["content-type"], "application/octet-stream");
});

test("raw passthrough streams before upstream completion and waits for downstream drain", async () => {
  const firstChunk = Buffer.from("first-");
  const secondChunk = Buffer.from("second");
  let releaseSecondChunk;
  let upstreamCompleted = false;
  const secondChunkGate = new Promise((resolve) => {
    releaseSecondChunk = resolve;
  });
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(firstChunk);
      void secondChunkGate.then(() => {
        controller.enqueue(secondChunk);
        controller.close();
        upstreamCompleted = true;
      });
    },
  });
  const client = createCoreClient({
    config: {
      gateway: {
        coreHost: "127.0.0.1",
        corePort: 43991,
        generatedConfigFile: "/fixture/generated.json",
      },
    },
    fetchImpl: async () => new Response(body, { status: 200 }),
    readFile: () => generatedConfig(CORE_TOKEN),
  });
  const response = createRecordingResponse({ backpressure: true });
  let settled = false;
  const pending = client
    .forwardRaw({ body: Buffer.from("request"), headers: {}, response })
    .finally(() => {
      settled = true;
    });

  const firstEvent = await Promise.race([
    response.firstWrite.then(() => "write"),
    new Promise((resolve) => setImmediate(() => resolve("turn-ended"))),
  ]);
  if (firstEvent !== "write") {
    releaseSecondChunk();
    response.releaseDrain();
    await pending;
  }
  assert.equal(firstEvent, "write");
  assert.equal(upstreamCompleted, false);
  assert.deepEqual(response.body, firstChunk);

  releaseSecondChunk();
  await secondChunkGate;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(upstreamCompleted, true);
  assert.equal(settled, false);
  assert.deepEqual(response.body, firstChunk);

  response.releaseDrain();
  await pending;
  assert.deepEqual(response.body, Buffer.concat([firstChunk, secondChunk]));
  assert.equal(response.ended, true);
});

test("raw passthrough safely ends a response with no upstream body", async () => {
  const client = createCoreClient({
    config: {
      gateway: {
        coreHost: "127.0.0.1",
        corePort: 43991,
        generatedConfigFile: "/fixture/generated.json",
      },
    },
    fetchImpl: async () => ({ body: null, headers: new Headers(), status: 204 }),
    readFile: () => generatedConfig(CORE_TOKEN),
  });
  const response = createRecordingResponse();

  await client.forwardRaw({ body: Buffer.from("request"), headers: {}, response });

  assert.equal(response.statusCode, 204);
  assert.equal(response.ended, true);
  assert.deepEqual(response.body, Buffer.alloc(0));
});

test("raw passthrough cancels upstream when downstream closes under backpressure", async () => {
  let cancelled = false;
  const upstream = new ReadableStream({
    start(controller) {
      controller.enqueue(Buffer.from("first"));
    },
    cancel() {
      cancelled = true;
    },
  });
  const client = createCoreClient({
    config: {
      gateway: {
        coreHost: "127.0.0.1",
        corePort: 43991,
        generatedConfigFile: "/fixture/generated.json",
      },
    },
    fetchImpl: async () => new Response(upstream, { status: 200 }),
    readFile: () => generatedConfig(CORE_TOKEN),
  });
  const response = createRecordingResponse({ backpressure: true });
  const pending = client.forwardRaw({ body: Buffer.from("request"), headers: {}, response });

  await response.firstWrite;
  response.emit("close");
  const outcome = await observePromptSettlement(pending, response);

  assert.equal(outcome.status, "rejected");
  assert.match(outcome.error.message, /CCR passthrough downstream closed/);
  assert.equal(cancelled, true);
});

test("raw passthrough sanitizes downstream errors and cancels upstream", async () => {
  let cancelled = false;
  const upstream = new ReadableStream({
    start(controller) {
      controller.enqueue(Buffer.from("first"));
    },
    cancel() {
      cancelled = true;
    },
  });
  const client = createCoreClient({
    config: {
      gateway: {
        coreHost: "127.0.0.1",
        corePort: 43991,
        generatedConfigFile: "/fixture/generated.json",
      },
    },
    fetchImpl: async () => new Response(upstream, { status: 200 }),
    readFile: () => generatedConfig(CORE_TOKEN),
  });
  const response = createRecordingResponse({ backpressure: true });
  const pending = client.forwardRaw({ body: Buffer.from("request"), headers: {}, response });

  await response.firstWrite;
  response.emit("error", new Error("downstream-secret"));
  const outcome = await observePromptSettlement(pending, response);

  assert.equal(outcome.status, "rejected");
  assert.match(outcome.error.message, /CCR passthrough downstream failed/);
  assert.doesNotMatch(outcome.error.message, /downstream-secret/);
  assert.equal(cancelled, true);
});

test("raw passthrough rejects when downstream closes before finish", async () => {
  const client = createCoreClient({
    config: {
      gateway: {
        coreHost: "127.0.0.1",
        corePort: 43991,
        generatedConfigFile: "/fixture/generated.json",
      },
    },
    fetchImpl: async () => ({ body: null, headers: new Headers(), status: 204 }),
    readFile: () => generatedConfig(CORE_TOKEN),
  });
  const response = createRecordingResponse({ endEvent: "close" });
  const pending = client.forwardRaw({ body: Buffer.from("request"), headers: {}, response });

  const outcome = await observePromptSettlement(pending, response);

  assert.equal(outcome.status, "rejected");
  assert.match(outcome.error.message, /CCR passthrough downstream closed/);
});

test("raw passthrough cancels upstream when aborted under backpressure", async () => {
  let cancelled = false;
  const upstream = new ReadableStream({
    start(controller) {
      controller.enqueue(Buffer.from("first"));
    },
    cancel() {
      cancelled = true;
    },
  });
  const client = createCoreClient({
    config: {
      gateway: {
        coreHost: "127.0.0.1",
        corePort: 43991,
        generatedConfigFile: "/fixture/generated.json",
      },
    },
    fetchImpl: async () => new Response(upstream, { status: 200 }),
    readFile: () => generatedConfig(CORE_TOKEN),
  });
  const response = createRecordingResponse({ backpressure: true });
  const controller = new AbortController();
  const pending = client.forwardRaw({
    body: Buffer.from("request"),
    headers: {},
    response,
    signal: controller.signal,
  });

  await response.firstWrite;
  controller.abort();
  const outcome = await observePromptSettlement(pending, response);

  assert.equal(outcome.status, "rejected");
  assert.equal(outcome.error.name, "AbortError");
  assert.equal(cancelled, true);
});

test("core client converts wildcard core hosts to connectable loopback hosts", async (t) => {
  const fixture = await createCoreFixture(t, { coreHost: "0.0.0.0" });
  const client = createCoreClient(fixture.options);

  await client.requestMessage({ model: "claude-sonnet", messages: [] });

  assert.equal(fixture.seen.host, `127.0.0.1:${fixture.port}`);

  let endpoint;
  const ipv6Client = createCoreClient({
    config: {
      gateway: {
        coreHost: "::",
        corePort: 43992,
        generatedConfigFile: "/fixture/generated.json",
      },
    },
    fetchImpl: async (url) => {
      endpoint = String(url);
      return new Response('{"type":"message"}', {
        headers: { "content-type": "application/json" },
      });
    },
    readFile: () => generatedConfig(CORE_TOKEN),
  });
  await ipv6Client.requestMessage({ model: "claude-sonnet", messages: [] });
  assert.equal(endpoint, "http://[::1]:43992/v1/messages");
});

test("core client rejects malformed or missing generated authentication without leaking contents", async () => {
  const gateway = {
    coreHost: "127.0.0.1",
    corePort: 43991,
    generatedConfigFile: "/fixture/generated.json",
  };
  const cases = [
    () => '{"private":"must-not-leak"',
    () => JSON.stringify({ auth: { staticApiKeys: { keys: [] } }, private: "must-not-leak" }),
    () => {
      throw Object.assign(new Error("ENOENT must-not-leak"), { code: "ENOENT" });
    },
  ];

  for (const readFile of cases) {
    const client = createCoreClient({
      config: { gateway },
      fetchImpl: async () => assert.fail("fetch must not run without generated authentication"),
      readFile,
    });
    await assert.rejects(
      client.requestMessage({ model: "claude-sonnet", messages: [] }),
      (error) => {
        assert.match(error.message, /generated CCR core authentication/i);
        assert.doesNotMatch(error.message, /must-not-leak|ENOENT/);
        return true;
      },
    );
  }
});

test("core client returns upstream non-2xx JSON unchanged", async (t) => {
  const fixture = await createCoreFixture(t);
  const client = createCoreClient(fixture.options);

  const result = await client.requestMessage({ model: "rate-limited", messages: [] });

  assert.deepEqual(result, {
    type: "error",
    error: { type: "rate_limit_error", message: "try later" },
  });
});

test("raw passthrough propagates abort signals to the core request", async (t) => {
  const fixture = await createCoreFixture(t);
  const client = createCoreClient(fixture.options);
  const controller = new AbortController();
  const response = createRecordingResponse();
  const pending = client.forwardRaw({
    body: Buffer.from('{"model":"wait-for-abort","messages":[]}'),
    headers: {},
    response,
    signal: controller.signal,
  });

  await fixture.requestStarted;
  controller.abort();

  await assert.rejects(pending, (error) => error.name === "AbortError");
  assert.equal(response.body.length, 0);
});

test("ToolSearch bridge keeps deferred tools out until a local match", async () => {
  const fixture = createBridgeFixture([
    message({
      content: [
        {
          type: "tool_use",
          id: "toolu_search",
          name: "airkit_tool_search",
          input: { query: "weather" },
        },
      ],
    }),
    message({
      content: [{ type: "tool_use", id: "toolu_weather", name: "get_weather", input: {} }],
      stop_reason: "tool_use",
    }),
  ]);

  const result = await handleCompatibilityMessage(fixture.input);

  assert.equal(fixture.calls[0].body.tools.some((tool) => tool.name === "get_weather"), false);
  assert.equal(fixture.calls[1].body.tools.some((tool) => tool.name === "get_weather"), true);
  assert.equal(fixture.calls[1].body.tools.some((tool) => tool.name === "search_files"), false);
  assert.deepEqual(result.content.map((block) => block.type), [
    "server_tool_use",
    "tool_search_tool_result",
    "tool_use",
  ]);
  assert.deepEqual(result.content[1].content.tool_references, [
    { type: "tool_reference", tool_name: "get_weather" },
  ]);
});

test("prior ToolSearch result blocks become bounded history and reactivate referenced tools", async () => {
  const fixture = createBridgeFixture([
    message({ content: [{ type: "text", text: "History understood." }] }),
  ], {
    body: {
      messages: [
        { role: "user", content: "Earlier question" },
        {
          role: "assistant",
          content: [
            {
              type: "server_tool_use",
              id: "srvtoolu_prior_search",
              name: "tool_search_tool_regex",
              input: { query: "files" },
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_search_tool_result",
              tool_use_id: "srvtoolu_prior_search",
              content: {
                type: "tool_search_tool_search_result",
                tool_references: [{ type: "tool_reference", tool_name: "search_files" }],
              },
            },
          ],
        },
      ],
    },
  });

  await handleCompatibilityMessage(fixture.input);

  assert.equal(fixture.calls[0].body.tools.some((tool) => tool.name === "search_files"), true);
  const normalizedHistory = JSON.stringify(fixture.calls[0].body.messages);
  assert.doesNotMatch(normalizedHistory, /tool_search_tool_result/);
  assert.match(normalizedHistory, /search_files/);
});

test("invalid ToolSearch input returns a bounded typed result and resumes", async () => {
  const fixture = createBridgeFixture([
    message({
      content: [
        {
          type: "tool_use",
          id: "toolu_bad_search",
          name: "airkit_tool_search",
          input: { query: "[" },
        },
      ],
    }),
    message({ content: [{ type: "text", text: "Search input was rejected safely." }] }),
  ]);

  const result = await handleCompatibilityMessage(fixture.input);

  assert.equal(result.content[1].content.error_code, "invalid_tool_input");
  assert.match(result.content[1].content.error_message, /invalid ToolSearch regex/);
  assert.ok(result.content[1].content.error_message.length <= 256);
});

test("unsupported native history falls back without rewriting request or response", async () => {
  const fixture = createBridgeFixture([
    message({
      id: "msg_fallback",
      model: "anthropic/claude-opus-4-8",
      content: [{ type: "text", text: "Fallback response." }],
    }),
  ], {
    body: {
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "server_tool_use",
              id: "srvtoolu_web_search",
              name: "web_search",
              input: { query: "public protocol" },
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "advisor_tool_result",
              tool_use_id: "srvtoolu_missing",
              content: { type: "advisor_result", text: "orphan" },
            },
          ],
        },
      ],
    },
  });

  const result = await handleCompatibilityMessage(fixture.input);

  assert.equal(fixture.calls.length, 1);
  assert.equal(fixture.calls[0].body.model, "anthropic-messages/claude-sonnet");
  assert.deepEqual(fixture.calls[0].body.tools, fixture.input.body.tools);
  assert.deepEqual(fixture.calls[0].body.messages, fixture.input.body.messages);
  assert.match(JSON.stringify(fixture.calls[0].body.messages), /srvtoolu_web_search/);
  assert.deepEqual(result.content, [{ type: "text", text: "Fallback response." }]);
});

test("cross-kind native result IDs fall back without rewriting mismatched history", async () => {
  for (const [serverName, result] of [
    [
      "advisor",
      {
        type: "tool_search_tool_result",
        tool_use_id: "srvtoolu_mismatch",
        content: {
          type: "tool_search_tool_search_result",
          tool_references: [{ type: "tool_reference", tool_name: "get_weather" }],
        },
      },
    ],
    [
      "tool_search_tool_regex",
      {
        type: "advisor_tool_result",
        tool_use_id: "srvtoolu_mismatch",
        content: { type: "advisor_result", text: "wrong kind" },
      },
    ],
  ]) {
    const fixture = createBridgeFixture([
      message({
        model: "anthropic/claude-opus-4-8",
        content: [{ type: "text", text: "Isolated fallback." }],
      }),
    ], {
      body: {
        messages: [
          { role: "user", content: "Original request" },
          {
            role: "assistant",
            content: [
              {
                type: "server_tool_use",
                id: "srvtoolu_mismatch",
                name: serverName,
                input: {},
              },
            ],
          },
          { role: "user", content: [result] },
        ],
      },
    });

    await handleCompatibilityMessage(fixture.input);

    assert.equal(fixture.calls.length, 1);
    assert.equal(fixture.calls[0].body.model, "anthropic-messages/claude-sonnet");
    assert.deepEqual(fixture.calls[0].body.messages, fixture.input.body.messages);
    assert.match(JSON.stringify(fixture.calls[0].body.messages), /get_weather|wrong kind/);
  }
});

test("fallback rejects a configured non-Anthropic model before calling core", async () => {
  const fixture = createBridgeFixture([], {
    body: {
      messages: [
        {
          role: "user",
          content: [
            {
              type: "advisor_tool_result",
              tool_use_id: "srvtoolu_missing",
              content: { type: "advisor_result", text: "orphan" },
            },
          ],
        },
      ],
    },
    fallbackModel: "openai/gpt-5.4",
  });

  await assert.rejects(
    handleCompatibilityMessage(fixture.input),
    /fallback\.model must be an Anthropic-family model/,
  );
  assert.equal(fixture.calls.length, 0);
});

test("executor loop cap falls back after eight iterations", async () => {
  const repeatedSearches = Array.from({ length: 8 }, (_, index) =>
    message({
      id: `msg_loop_${index}`,
      content: [
        {
          type: "tool_use",
          id: `toolu_loop_${index}`,
          name: "airkit_tool_search",
          input: { query: "no_match" },
        },
      ],
    }),
  );
  const fixture = createBridgeFixture([
    ...repeatedSearches,
    message({
      id: "msg_loop_fallback",
      model: "anthropic/claude-opus-4-8",
      content: [{ type: "text", text: "Loop fallback response." }],
    }),
  ]);

  const result = await handleCompatibilityMessage(fixture.input);

  assert.equal(fixture.calls.filter((call) => call.body.model === "executor-model").length, 8);
  assert.equal(fixture.calls.at(-1).body.model, "anthropic-messages/claude-sonnet");
  assert.deepEqual(result.content, [{ type: "text", text: "Loop fallback response." }]);
  assert.equal(result.usage.iterations, undefined);
});

test("bridge errors are bounded and never expose provider payloads", async () => {
  const fixture = createBridgeFixture([]);
  fixture.input.coreClient.requestMessage = async () => {
    throw new Error("credential=secret provider-payload /private/runtime/path");
  };

  await assert.rejects(handleCompatibilityMessage(fixture.input), (error) => {
    assert.match(error.message, /CCR executor request failed/);
    assert.ok(error.message.length <= 256);
    assert.doesNotMatch(error.message, /secret|provider-payload|private\/runtime/);
    return true;
  });
});

test("invalid nonnumeric usage counters are removed from totals and iteration details", async () => {
  const fixture = createBridgeFixture([
    message({
      content: [{ type: "text", text: "Usage sanitized." }],
      usage: {
        input_tokens: 7,
        output_tokens: 2,
        cache_read_input_tokens: "provider-secret",
        server_tool_use: { web_search_requests: "nested-secret" },
        service_tier: "standard",
      },
    }),
  ]);

  const result = await handleCompatibilityMessage(fixture.input);

  assert.equal(result.usage.input_tokens, 7);
  assert.equal(result.usage.output_tokens, 2);
  assert.equal(result.usage.cache_read_input_tokens, undefined);
  assert.equal(result.usage.service_tier, "standard");
  assert.equal(result.usage.iterations.executor[0].cache_read_input_tokens, undefined);
  assert.equal(result.usage.server_tool_use?.web_search_requests, undefined);
  assert.equal(
    result.usage.iterations.executor[0].server_tool_use?.web_search_requests,
    undefined,
  );
  assert.doesNotMatch(JSON.stringify(result.usage), /provider-secret|nested-secret/);
});

test("Anthropic JSON and SSE writers preserve canonical result ordering", async () => {
  const outbound = message({
    id: "msg_serialized",
    content: [
      { type: "text", text: "Before" },
      {
        type: "server_tool_use",
        id: "srvtoolu_advisor_serialized",
        name: "advisor",
        input: {},
      },
      {
        type: "advisor_tool_result",
        tool_use_id: "srvtoolu_advisor_serialized",
        content: { type: "advisor_result", text: "Advice" },
      },
      {
        type: "server_tool_use",
        id: "srvtoolu_search_serialized",
        name: "tool_search_tool_regex",
        input: { query: "weather" },
      },
      {
        type: "tool_search_tool_result",
        tool_use_id: "srvtoolu_search_serialized",
        content: {
          type: "tool_search_tool_search_result",
          tool_references: [{ type: "tool_reference", tool_name: "get_weather" }],
        },
      },
      { type: "tool_use", id: "toolu_client", name: "get_weather", input: {} },
    ],
    stop_reason: "tool_use",
    usage: { input_tokens: 5, output_tokens: 7 },
  });
  const jsonResponse = createMessageResponse();
  const streamResponse = createMessageResponse();

  await writeAnthropicMessage(jsonResponse, outbound, false);
  await writeAnthropicMessage(streamResponse, outbound, true);

  assert.equal(jsonResponse.headers["content-type"], "application/json");
  assert.deepEqual(JSON.parse(jsonResponse.body), outbound);
  assert.equal(streamResponse.headers["content-type"], "text/event-stream");
  const frames = parseSse(streamResponse.body);
  assert.equal(frames[0].event, "message_start");
  assert.equal(frames.at(-1).event, "message_stop");
  const starts = frames.filter((frame) => frame.event === "content_block_start");
  assert.deepEqual(starts.map((frame) => frame.data.content_block.type), outbound.content.map((b) => b.type));
  for (const resultType of ["advisor_tool_result", "tool_search_tool_result"]) {
    const resultStart = frames.findIndex(
      (frame) =>
        frame.event === "content_block_start" && frame.data.content_block.type === resultType,
    );
    const matchingUseStop = frames.findLastIndex(
      (frame, index) => frame.event === "content_block_stop" && index < resultStart,
    );
    assert.ok(matchingUseStop >= 0 && matchingUseStop < resultStart);
    assert.deepEqual(
      frames[resultStart].data.content_block,
      outbound.content.find((block) => block.type === resultType),
    );
  }
  assert.equal(frames.some((frame) => frame.event === "message_delta"), true);
});

test("Anthropic SSE serializes thinking, redaction, citations, and unknown complete blocks", async () => {
  const citation = {
    type: "char_location",
    cited_text: "Protocol excerpt",
    document_index: 0,
    document_title: "Protocol",
    start_char_index: 0,
    end_char_index: 16,
  };
  const outbound = message({
    content: [
      { type: "thinking", thinking: "Reason carefully.", signature: "signed-thinking" },
      { type: "redacted_thinking", data: "opaque-redacted-thinking" },
      { type: "text", text: "Cited answer.", citations: [citation] },
      { type: "custom_complete_block", payload: { public: true } },
    ],
  });
  const jsonResponse = createMessageResponse();
  const streamResponse = createMessageResponse();

  writeAnthropicMessage(jsonResponse, outbound, false);
  writeAnthropicMessage(streamResponse, outbound, true);

  assert.deepEqual(JSON.parse(jsonResponse.body), outbound);
  const frames = parseSse(streamResponse.body);
  const starts = frames.filter((frame) => frame.event === "content_block_start");
  assert.deepEqual(starts[0].data.content_block, {
    type: "thinking",
    thinking: "",
    signature: "",
  });
  assert.deepEqual(starts[1].data.content_block, outbound.content[1]);
  assert.deepEqual(starts[2].data.content_block, { type: "text", text: "", citations: [] });
  assert.deepEqual(starts[3].data.content_block, outbound.content[3]);
  const deltas = frames
    .filter((frame) => frame.event === "content_block_delta")
    .map((frame) => frame.data.delta);
  assert.deepEqual(deltas, [
    { type: "thinking_delta", thinking: "Reason carefully." },
    { type: "signature_delta", signature: "signed-thinking" },
    { type: "text_delta", text: "Cited answer." },
    { type: "citations_delta", citation },
  ]);
});

test("compatibility plugin registers stable authenticated POST routes", async () => {
  const routes = [];

  await plugin.setup({
    config: structuredClone(PLUGIN_RUNTIME_CONFIG),
    coreClient: {},
    pluginConfig: structuredClone(COMPLETE_PLUGIN_CONFIG),
    registerGatewayRoute(route) {
      routes.push(route);
    },
  });

  assert.deepEqual(
    routes.map(({ auth, id, method, path }) => ({ auth, id, method, path })),
    [
      {
        auth: "gateway",
        id: "airkit-compatibility-messages",
        method: "POST",
        path: "/v1/messages",
      },
      {
        auth: "gateway",
        id: "airkit-compatibility-mcp",
        method: "POST",
        path: "/airkit/compatibility/mcp",
      },
    ],
  );
});

test("compatibility plugin fails closed on an invalid fallback provider binding", async () => {
  for (const Providers of [
    [],
    [{ name: "anthropic-messages", type: "openai_chat_completions", models: ["claude-sonnet"] }],
    [{ name: "anthropic-messages", type: "anthropic_messages", models: ["claude-opus"] }],
  ]) {
    const routes = [];
    await assert.rejects(
      plugin.setup({
        config: { Providers },
        coreClient: createPluginCoreClient(),
        pluginConfig: structuredClone(COMPLETE_PLUGIN_CONFIG),
        registerGatewayRoute(route) {
          routes.push(route);
        },
      }),
      /fallback provider|fallback model/,
    );
    assert.deepEqual(routes, []);
  }
});

test("compatibility plugin rejects removed Advisor bridge configuration before registering routes", async () => {
  const routes = [];

  await assert.rejects(
    plugin.setup({
      config: {},
      coreClient: createPluginCoreClient(),
      pluginConfig: {
        ...structuredClone(COMPLETE_PLUGIN_CONFIG),
        advisor: { mode: "bridge", model: "other/executor", fallbackModel: "claude-opus" },
      },
      registerGatewayRoute(route) {
        routes.push(route);
      },
    }),
    /advisor\.mode "bridge" was removed/,
  );
  assert.deepEqual(routes, []);
});

test("ordinary Messages requests preserve raw bytes and abort propagation", async () => {
  const calls = [];
  const fixture = await createPluginFixture({
    coreClient: createPluginCoreClient({
      async forwardRaw(input) {
        calls.push(input);
        input.response.writeHead(202, { "content-type": "application/octet-stream" });
        input.response.end(Buffer.from("raw-response"));
      },
    }),
  });
  const body = Buffer.from([0, 255, 123, 125, 10]);
  const upstream = new AbortController();
  const request = createPluginRequest(body, { signal: upstream.signal });
  const response = createRecordingResponse();

  await fixture.messages.handler(request, response, fixture.helpers);

  assert.equal(fixture.readCount, 1);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].body, body);
  assert.equal(calls[0].headers, request.headers);
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].response, response);
  // The handler derives a lifecycle signal (CCR passes no request.signal on
  // real requests); an upstream abort must still propagate through it.
  assert.equal(calls[0].signal.aborted, false);
  upstream.abort();
  assert.equal(calls[0].signal.aborted, true);
  assert.deepEqual(response.body, Buffer.from("raw-response"));
});

test("ordinary Messages requests translate Claude effort before OpenAI-compatible forwarding", async () => {
  const calls = [];
  const fixture = await createPluginFixture({
    coreClient: createPluginCoreClient({
      async forwardRaw(input) {
        calls.push(JSON.parse(input.body.toString("utf8")));
      },
    }),
  });
  const body = {
    model: "oneportal/deepseek-v4-flash",
    max_tokens: 8,
    output_config: { effort: "low" },
    messages: [{ role: "user", content: "hi" }],
  };

  await fixture.messages.handler(
    createPluginRequest(Buffer.from(JSON.stringify(body))),
    createRecordingResponse(),
    fixture.helpers,
  );

  assert.deepEqual(calls, [{
    model: "oneportal/deepseek-v4-flash",
    max_tokens: 8,
    reasoning_effort: "high",
    messages: [{ role: "user", content: "hi" }],
  }]);
});

test("Claude Code WebFetch client requests fail closed to the Anthropic route", async () => {
  const calls = [];
  const fixture = await createPluginFixture({
    coreClient: createPluginCoreClient({
      async requestFallback(body) {
        calls.push(structuredClone(body));
        return new Response(JSON.stringify({ type: "message", content: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    }),
  });
  const response = createRecordingResponse();
  const body = {
    model: "executor-model",
    max_tokens: 512,
    messages: [{ role: "user", content: "Fetch the page." }],
    tools: [{ name: "WebFetch", input_schema: { type: "object" } }],
  };

  await fixture.messages.handler(
    createPluginRequest(Buffer.from(JSON.stringify(body))),
    response,
    fixture.helpers,
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].model, "anthropic-messages/claude-sonnet");
  assert.deepEqual(calls[0].tools, body.tools);
  assert.equal(response.statusCode, 200);
});

test("Claude Code WebSearch stays native when native-first is verified", async () => {
  const calls = [];
  const fixture = await createPluginFixture({
    coreClient: createPluginCoreClient({
      async forwardRaw(input) {
        calls.push(input);
        input.response.writeHead(202, { "content-type": "application/json" });
        input.response.end(Buffer.from("{}"));
      },
    }),
  });
  const response = createRecordingResponse();
  const body = {
    model: "executor-model",
    messages: [{ role: "user", content: "Search." }],
    tools: [{ name: "WebSearch", input_schema: { type: "object" } }],
  };

  await fixture.messages.handler(
    createPluginRequest(Buffer.from(JSON.stringify(body))),
    response,
    fixture.helpers,
  );

  assert.equal(calls.length, 1);
  assert.deepEqual(JSON.parse(calls[0].body), body);
  assert.equal(response.statusCode, 202);
});

test("explicit WebSearch fallback overrides the verified native route", async () => {
  const calls = [];
  const fixture = await createPluginFixture({
    pluginConfig: { webSearch: { mode: "anthropic-fallback" } },
    coreClient: createPluginCoreClient({
      async requestFallback(body) {
        calls.push(structuredClone(body));
        return new Response(JSON.stringify({ type: "message", content: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    }),
  });
  const response = createRecordingResponse();
  const body = {
    model: "executor-model",
    messages: [{ role: "user", content: "Search." }],
    tools: [{ name: "WebSearch", input_schema: { type: "object" } }],
  };

  await fixture.messages.handler(
    createPluginRequest(Buffer.from(JSON.stringify(body))),
    response,
    fixture.helpers,
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].model, "anthropic-messages/claude-sonnet");
  assert.deepEqual(calls[0].tools, body.tools);
});

test("compatibility Messages requests bridge JSON and preserve the stream flag", async () => {
  const calls = [];
  const fixture = await createPluginFixture({
    coreClient: createPluginCoreClient({
      async requestMessage(body) {
        calls.push(structuredClone(body));
        return calls.length === 1
          ? message({
              content: [{
                type: "tool_use",
                id: "toolu_search",
                name: "airkit_tool_search",
                input: { query: "weather" },
              }],
              stop_reason: "tool_use",
            })
          : message({ content: [{ type: "text", text: "Sunny." }] });
      },
    }),
  });
  const jsonResponse = createMessageResponse();
  const streamResponse = createMessageResponse();

  await fixture.messages.handler(
    createPluginRequest(Buffer.from(JSON.stringify(compatibilityRequestBody(false)))),
    jsonResponse,
    fixture.helpers,
  );
  calls.length = 0;
  await fixture.messages.handler(
    createPluginRequest(Buffer.from(JSON.stringify(compatibilityRequestBody(true)))),
    streamResponse,
    fixture.helpers,
  );

  assert.equal(jsonResponse.headers["content-type"], "application/json");
  assert.deepEqual(
    JSON.parse(jsonResponse.body).content.map((block) => block.type),
    ["server_tool_use", "tool_search_tool_result", "text"],
  );
  assert.equal(streamResponse.headers["content-type"], "text/event-stream");
  assert.equal(parseSse(streamResponse.body).at(-1).event, "message_stop");
});

test("compatibility plugin streams typed server-tool fallback through the real response path", async () => {
  const calls = [];
  const upstreamAbort = new AbortController();
  const signal = upstreamAbort.signal;
  const fixture = await createPluginFixture({
    coreClient: createPluginCoreClient({
      async requestFallback(body, headers, receivedSignal) {
        calls.push({ body: structuredClone(body), headers, signal: receivedSignal });
        return new Response("event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n", {
          status: 200,
          headers: {
            "content-type": "text/event-stream",
            "x-request-id": "typed-fallback",
          },
        });
      },
    }),
  });
  const response = createRecordingResponse();
  const body = {
    model: "executor-model",
    max_tokens: 512,
    messages: [{ role: "user", content: "run code" }],
    stream: true,
    tools: [{ type: "code_execution_20260521", name: "code_execution" }],
  };

  await fixture.messages.handler(
    createPluginRequest(Buffer.from(JSON.stringify(body)), { signal }),
    response,
    fixture.helpers,
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.model, "anthropic-messages/claude-sonnet");
  assert.equal(calls[0].body.stream, true);
  assert.deepEqual(calls[0].body.tools, body.tools);
  assert.equal(calls[0].signal.aborted, false);
  upstreamAbort.abort();
  assert.equal(calls[0].signal.aborted, true, "upstream abort propagates via lifecycle signal");
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["content-type"], "text/event-stream");
  assert.equal(response.headers["x-request-id"], "typed-fallback");
  assert.equal(response.body.toString("utf8"), "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n");
});

test("compatibility plugin routes pending server history without a repeated tool definition", async () => {
  const calls = [];
  const fixture = await createPluginFixture({
    coreClient: createPluginCoreClient({
      async requestFallback(body) {
        calls.push(structuredClone(body));
        return new Response(JSON.stringify({ type: "error", error: { type: "overloaded_error" } }), {
          status: 529,
          headers: { "content-type": "application/json", "retry-after": "2" },
        });
      },
    }),
  });
  const response = createRecordingResponse();
  const body = {
    model: "executor-model",
    max_tokens: 512,
    messages: [{
      role: "assistant",
      content: [{ type: "server_tool_use", id: "srvtoolu_pending", name: "advisor", input: {} }],
    }],
    stream: false,
  };

  await fixture.messages.handler(
    createPluginRequest(Buffer.from(JSON.stringify(body))),
    response,
    fixture.helpers,
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].model, "anthropic-messages/claude-sonnet");
  assert.deepEqual(calls[0].messages, body.messages);
  assert.equal(response.statusCode, 529);
  assert.equal(response.headers["retry-after"], "2");
  assert.deepEqual(JSON.parse(response.body), {
    type: "error",
    error: { type: "overloaded_error" },
  });
});

test("MCP initialize, initialized notification, and tools/list are stateless", async () => {
  const fixture = await createPluginFixture();
  const initialized = await fixture.callMcp("initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "fixture", version: "1" },
  });
  const notification = await fixture.callMcp("notifications/initialized", undefined, {
    notification: true,
  });
  const tools = await fixture.callMcp("tools/list", {});

  assert.equal(initialized.statusCode, 200);
  assert.equal(initialized.json.result.protocolVersion, "2025-03-26");
  assert.deepEqual(initialized.json.result.capabilities, { tools: {} });
  assert.equal(notification.statusCode, 202);
  assert.equal(notification.body.length, 0);
  assert.deepEqual(tools.json.result.tools, [
    {
      name: "web_search",
      description: "Search the current web through the configured Anthropic WebSearch model.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
          allowed_domains: { type: "array", items: { type: "string" } },
          blocked_domains: { type: "array", items: { type: "string" } },
        },
        required: ["query"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true },
    },
  ]);
});

test("MCP web_search forces the configured model, server tool, and domain filter", async () => {
  const calls = [];
  const fixture = await createPluginFixture({
    coreClient: createPluginCoreClient({
      async requestMessage(body) {
        calls.push(structuredClone(body));
        return webSearchMessage();
      },
    }),
  });

  const response = await fixture.callMcp("tools/call", {
    name: "web_search",
    arguments: {
      query: "current protocol release",
      allowed_domains: ["Example.COM"],
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].model, "anthropic-messages/claude-sonnet");
  assert.equal(calls[0].stream, false);
  assert.deepEqual(calls[0].messages, [
    { role: "user", content: "current protocol release" },
  ]);
  assert.deepEqual(calls[0].tools, [
    {
      type: "web_search_20250305",
      name: "web_search",
      max_uses: 5,
      allowed_domains: ["example.com"],
    },
  ]);
  assert.deepEqual(calls[0].tool_choice, { type: "tool", name: "web_search" });
  assert.deepEqual(response.json.result.structuredContent.results, [
    { title: "Protocol release", url: "https://example.com/release", pageAge: "today" },
  ]);
  assert.equal(response.json.result.structuredContent.summary, "Current release summary.");
});

test("MCP rejects invalid search input without calling the provider", async () => {
  const fixture = await createPluginFixture();
  const invalidArguments = [
    { query: "   " },
    { query: "x".repeat(1001) },
    { query: "release", allowed_domains: "example.com" },
    { query: "release", allowed_domains: ["https://example.com/path"] },
    {
      query: "release",
      allowed_domains: ["example.com"],
      blocked_domains: ["blocked.example"],
    },
  ];

  for (const argumentsValue of invalidArguments) {
    const response = await fixture.callMcp("tools/call", {
      name: "web_search",
      arguments: argumentsValue,
    });
    assert.equal(response.json.result.isError, true);
    assert.deepEqual(response.json.result.content, [
      { type: "text", text: "Invalid web search request." },
    ]);
  }
  assert.equal(fixture.coreCalls.length, 0);
});

test("MCP returns bounded JSON-RPC errors for malformed requests and unknown operations", async () => {
  const fixture = await createPluginFixture();
  const malformedJson = await fixture.callRawMcp(Buffer.from('{"jsonrpc":'));
  const invalidRequest = await fixture.callRawMcp(
    Buffer.from(JSON.stringify({ jsonrpc: "1.0", id: 91, method: "tools/list" })),
  );
  const unknownMethod = await fixture.callMcp("resources/list", {});
  const unknownTool = await fixture.callMcp("tools/call", {
    name: "private_tool_name",
    arguments: {},
  });

  assert.deepEqual(malformedJson.json, {
    jsonrpc: "2.0",
    id: null,
    error: { code: -32700, message: "Parse error" },
  });
  assert.deepEqual(invalidRequest.json, {
    jsonrpc: "2.0",
    id: null,
    error: { code: -32600, message: "Invalid Request" },
  });
  assert.deepEqual(unknownMethod.json.error, { code: -32601, message: "Method not found" });
  assert.deepEqual(unknownTool.json.error, { code: -32602, message: "Unknown tool" });
  assert.doesNotMatch(JSON.stringify(unknownTool.json), /private_tool_name/);
});

test("MCP converts canonical WebSearch error blocks to a fixed tool error", async () => {
  const fixture = await createPluginFixture({
    coreClient: createPluginCoreClient({
      async requestMessage() {
        return webSearchMessage({
          content: [{
            type: "web_search_tool_result",
            tool_use_id: "srvtoolu_web",
            content: {
              type: "web_search_tool_result_error",
              error_code: "too_many_requests",
              provider_message: "account-secret",
            },
          }],
        });
      },
    }),
  });

  const response = await fixture.callMcp("tools/call", {
    name: "web_search",
    arguments: { query: "release" },
  });

  assert.deepEqual(response.json.result, {
    content: [{ type: "text", text: "Web search is unavailable." }],
    isError: true,
  });
  assert.doesNotMatch(JSON.stringify(response.json), /account-secret|too_many_requests/);
});

test("MCP bounds public output and hides provider failures", async () => {
  const success = await createPluginFixture({
    coreClient: createPluginCoreClient({
      async requestMessage() {
        return webSearchMessage({
          content: [
            {
              type: "web_search_tool_result",
              tool_use_id: "srvtoolu_web",
              provider_payload: "provider-secret",
              content: [
                {
                  type: "web_search_result",
                  title: "T".repeat(700),
                  url: "https://example.com/release",
                  encrypted_content: "opaque-secret",
                },
                { type: "web_search_result", title: "Unsafe", url: "file:///private/result" },
                {
                  type: "web_search_result",
                  title: "Credential URL",
                  url: "https://username:password@example.com/private",
                },
              ],
            },
            { type: "text", text: "S".repeat(5000) },
          ],
        });
      },
    }),
  });
  const sanitized = await success.callMcp("tools/call", {
    name: "web_search",
    arguments: { query: "release" },
  });
  const serialized = JSON.stringify(sanitized.json);

  assert.equal(sanitized.json.result.structuredContent.results.length, 1);
  assert.equal(sanitized.json.result.structuredContent.results[0].title.length, 512);
  assert.equal(sanitized.json.result.structuredContent.summary.length, 4096);
  assert.doesNotMatch(serialized, /provider-secret|opaque-secret|file:\/\/|username|password/);

  const failure = await createPluginFixture({
    coreClient: createPluginCoreClient({
      async requestMessage() {
        throw new Error("credential in /private/provider.json");
      },
    }),
  });
  const failed = await failure.callMcp("tools/call", {
    name: "web_search",
    arguments: { query: "release" },
  });
  assert.deepEqual(failed.json.result, {
    content: [{ type: "text", text: "Web search is unavailable." }],
    isError: true,
  });
  assert.doesNotMatch(JSON.stringify(failed.json), /credential|private|provider\.json/i);
});

async function createPluginFixture(options = {}) {
  const routes = [];
  const coreCalls = [];
  let readCount = 0;
  const helpers = {
    async readBody(request) {
      readCount += 1;
      return request.body;
    },
  };
  await plugin.setup({
    config: structuredClone(PLUGIN_RUNTIME_CONFIG),
    coreClient: options.coreClient ?? createPluginCoreClient({
      async requestMessage(body, headers) {
        coreCalls.push({ body: structuredClone(body), headers: structuredClone(headers ?? {}) });
        return webSearchMessage();
      },
    }),
    pluginConfig: {
      ...structuredClone(COMPLETE_PLUGIN_CONFIG),
      ...options.pluginConfig,
    },
    registerGatewayRoute(route) {
      routes.push(route);
    },
  });
  const mcp = routes.find((route) => route.path === "/airkit/compatibility/mcp");
  return {
    coreCalls,
    helpers,
    messages: routes.find((route) => route.path === "/v1/messages"),
    mcp,
    routes,
    get readCount() {
      return readCount;
    },
    async callMcp(method, params, { notification = false } = {}) {
      return this.callRawMcp(Buffer.from(JSON.stringify({
        jsonrpc: "2.0",
        ...(notification ? {} : { id: 17 }),
        method,
        ...(params === undefined ? {} : { params }),
      })));
    },
    async callRawMcp(body) {
      const response = createRecordingResponse();
      await mcp.handler(createPluginRequest(body), response, helpers);
      return {
        body: response.body,
        json: response.body.length === 0 ? undefined : JSON.parse(response.body.toString("utf8")),
        statusCode: response.statusCode,
      };
    },
  };
}

function createPluginCoreClient(overrides = {}) {
  return {
    async forwardRaw() {
      throw new Error("unexpected raw passthrough");
    },
    async requestMessage() {
      throw new Error("unexpected core request");
    },
    async requestFallback() {
      throw new Error("unexpected fallback request");
    },
    ...overrides,
  };
}

function createPluginRequest(body, { signal } = {}) {
  return Object.assign(new EventEmitter(), {
    body,
    headers: { "content-type": "application/json", "x-request-id": "fixture-request" },
    method: "POST",
    signal,
  });
}

function compatibilityRequestBody(stream) {
  return {
    model: "executor-model",
    max_tokens: 512,
    messages: [{ role: "user", content: "Search tools." }],
    stream,
    tools: [
      { type: "tool_search_tool_regex_20251119", name: "tool_search_tool_regex" },
      {
        name: "get_weather",
        description: "Get weather",
        defer_loading: true,
        input_schema: { type: "object", properties: {} },
      },
    ],
  };
}

function webSearchMessage(overrides = {}) {
  return message({
    content: [
      {
        type: "server_tool_use",
        id: "srvtoolu_web",
        name: "web_search",
        input: { query: "current protocol release" },
      },
      {
        type: "web_search_tool_result",
        tool_use_id: "srvtoolu_web",
        content: [{
          type: "web_search_result",
          title: "Protocol release",
          url: "https://example.com/release",
          page_age: "today",
          encrypted_content: "opaque-provider-value",
        }],
      },
      { type: "text", text: "Current release summary." },
    ],
    ...overrides,
  });
}

function createBridgeFixture(script, options = {}) {
  const calls = [];
  const queue = [...script];
  const body = {
    model: "executor-model",
    max_tokens: 2048,
    messages: [{ role: "user", content: "Please investigate the current failure." }],
    tools: [
      {
        type: "tool_search_tool_regex_20251119",
        name: "tool_search_tool_regex",
      },
      {
        name: "get_weather",
        description: "Get current weather",
        defer_loading: true,
        input_schema: { type: "object", properties: {} },
      },
      {
        name: "search_files",
        description: "Search files",
        defer_loading: true,
        input_schema: { type: "object", properties: {} },
      },
      {
        name: "ordinary_tool",
        description: "An ordinary client tool",
        input_schema: { type: "object", properties: {} },
      },
    ],
    ...options.body,
  };
  const coreClient = {
    async requestMessage(requestBody, headers) {
      calls.push({ body: structuredClone(requestBody), headers: structuredClone(headers ?? {}) });
      assert.ok(queue.length > 0, "scripted core received an unexpected request");
      return structuredClone(queue.shift());
    },
  };
  return {
    calls,
    input: {
      body,
      headers: { "anthropic-beta": "tool-search-tool-2025-11-19" },
      config: {
        fallback: {
          provider: "anthropic-messages",
          model: options.fallbackModel ?? "claude-sonnet",
          maxContinuationTurns: 8,
        },
        toolSearch: { mode: "bridge" },
        webSearch: { mode: "native-first" },
        webFetch: { mode: "native-first" },
        codeExecution: { mode: "anthropic-fallback" },
        advisor: { mode: "anthropic-fallback" },
        mcpConnector: { mode: "anthropic-fallback" },
      },
      coreClient,
      createId: (() => {
        let next = 0;
        return (prefix) => `${prefix}_${++next}`;
      })(),
    },
  };
}

function message(overrides = {}) {
  return {
    id: "msg_fixture",
    type: "message",
    role: "assistant",
    model: "executor-model",
    content: [],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 },
    ...overrides,
  };
}

function createMessageResponse() {
  const chunks = [];
  return {
    headers: {},
    statusCode: 200,
    writeHead(statusCode, headers) {
      this.statusCode = statusCode;
      this.headers = Object.fromEntries(
        Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]),
      );
    },
    write(chunk) {
      chunks.push(String(chunk));
      return true;
    },
    end(chunk) {
      if (chunk !== undefined) chunks.push(String(chunk));
    },
    get body() {
      return chunks.join("");
    },
  };
}

function parseSse(body) {
  return body
    .trim()
    .split("\n\n")
    .map((frame) => {
      const lines = frame.split("\n");
      return {
        event: lines.find((line) => line.startsWith("event: ")).slice(7),
        data: JSON.parse(lines.find((line) => line.startsWith("data: ")).slice(6)),
      };
    });
}

async function createCoreFixture(t, { coreHost = "127.0.0.1", tokenEntry = CORE_TOKEN } = {}) {
  let notifyRequestStarted;
  const requestStarted = new Promise((resolve) => {
    notifyRequestStarted = resolve;
  });
  const seen = {};
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    seen.body = Buffer.concat(chunks);
    seen.headers = request.headers;
    seen.host = request.headers.host;
    notifyRequestStarted();

    const body = JSON.parse(seen.body.toString("utf8"));
    if (body.model === "wait-for-abort") return;
    if (body.model === "executor") {
      response.writeHead(202, { "content-type": "application/octet-stream" });
      response.end(RAW_RESPONSE_BODY);
      return;
    }
    if (body.model === "rate-limited") {
      response.writeHead(429, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          type: "error",
          error: { type: "rate_limit_error", message: "try later" },
        }),
      );
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ type: "message", content: [] }));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();

  return {
    coreToken: CORE_TOKEN,
    options: {
      config: {
        gateway: {
          coreHost,
          corePort: port,
          generatedConfigFile: "/fixture/generated.json",
        },
      },
      readFile: () => generatedConfig(tokenEntry),
    },
    port,
    rawResponseBody: RAW_RESPONSE_BODY,
    requestStarted,
    seen,
  };
}

function generatedConfig(tokenEntry) {
  return JSON.stringify({ auth: { staticApiKeys: { keys: [tokenEntry] } } });
}

function createRecordingResponse({ backpressure = false, endEvent = "finish" } = {}) {
  const chunks = [];
  let notifyFirstWrite;
  const firstWrite = new Promise((resolve) => {
    notifyFirstWrite = resolve;
  });
  const response = Object.assign(new EventEmitter(), {
    ended: false,
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
      this.ended = true;
      this.emit(endEvent);
    },
    releaseDrain() {
      backpressure = false;
      this.emit("drain");
    },
  });
  Object.defineProperty(response, "body", {
    get: () => Buffer.concat(chunks),
  });
  return response;
}

async function observePromptSettlement(pending, response) {
  const observed = pending.then(
    (value) => ({ status: "resolved", value }),
    (error) => ({ error, status: "rejected" }),
  );
  const outcome = await Promise.race([
    observed,
    new Promise((resolve) => setImmediate(() => resolve({ status: "pending" }))),
  ]);
  if (outcome.status === "pending") {
    response.emit("error", new Error("test cleanup"));
    await observed;
  }
  return outcome;
}

test("known bare Claude families are routed before raw passthrough; unknown and qualified models pass byte-identical", async () => {
  const forwarded = [];
  const routes = [];
  await plugin.setup({
    config: structuredClone(PLUGIN_RUNTIME_CONFIG),
    coreClient: {
      async forwardRaw({ body }) {
        forwarded.push(Buffer.from(body));
      },
    },
    pluginConfig: {
      ...structuredClone(COMPLETE_PLUGIN_CONFIG),
      routes: {
        default: "demo-provider/steady-coder",
        background: "demo-provider/cheap-coder",
      },
    },
    registerGatewayRoute(route) {
      routes.push(route);
    },
  });
  const handler = routes.find(({ id }) => id === "airkit-compatibility-messages").handler;
  const invoke = async (body) => {
    const raw = Buffer.from(JSON.stringify(body), "utf8");
    await handler(
      { headers: {}, method: "POST", signal: undefined },
      {},
      { readBody: async () => raw },
    );
    return { raw, sent: forwarded.at(-1) };
  };

  const background = await invoke({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 8,
    messages: [{ role: "user", content: "hi" }],
  });
  assert.equal(JSON.parse(background.sent.toString()).model, "demo-provider/cheap-coder");

  const unknown = await invoke({
    model: "claude-fable-5",
    max_tokens: 8,
    messages: [{ role: "user", content: "hi" }],
  });
  assert.deepEqual(unknown.sent, unknown.raw, "unknown Claude family stays byte-identical");

  const qualified = await invoke({
    model: "other-provider/claude-sonnet",
    max_tokens: 8,
    messages: [{ role: "user", content: "hi" }],
  });
  assert.deepEqual(qualified.sent, qualified.raw, "qualified selector stays byte-identical");

  const unrelated = await invoke({
    model: "deepseek-v4-flash",
    max_tokens: 8,
    messages: [{ role: "user", content: "hi" }],
  });
  assert.deepEqual(unrelated.sent, unrelated.raw, "non-Claude model stays byte-identical");
});

test("routeLog emits one redacted decision line per request and stays silent when off", async () => {
  const setupHandler = async (pluginConfig) => {
    const routes = [];
    await plugin.setup({
      config: structuredClone(PLUGIN_RUNTIME_CONFIG),
      coreClient: { async forwardRaw() {} },
      pluginConfig,
      registerGatewayRoute(route) {
        routes.push(route);
      },
    });
    return routes.find(({ id }) => id === "airkit-compatibility-messages").handler;
  };
  const captureStderr = async (run) => {
    const lines = [];
    const original = process.stderr.write;
    process.stderr.write = (chunk) => {
      lines.push(String(chunk));
      return true;
    };
    try {
      await run();
    } finally {
      process.stderr.write = original;
    }
    return lines.filter((line) => line.startsWith("[airkit-route] "));
  };
  const request = {
    headers: { authorization: "Bearer gateway-secret-token" },
    method: "POST",
    signal: undefined,
  };
  const raw = Buffer.from(
    JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 8, messages: [] }),
    "utf8",
  );

  const onHandler = await setupHandler({
    ...structuredClone(COMPLETE_PLUGIN_CONFIG),
    routeLog: true,
    routes: { default: "demo-provider/steady-coder" },
  });
  const logged = await captureStderr(() =>
    onHandler(request, {}, { readBody: async () => raw }));
  assert.equal(logged.length, 1);
  const entry = JSON.parse(logged[0].slice("[airkit-route] ".length));
  assert.equal(entry.inModel, "claude-sonnet-4-6");
  assert.equal(entry.outModel, "demo-provider/steady-coder");
  assert.equal(entry.rewritten, true);
  assert.equal(entry.path, "passthrough");
  assert.match(entry.authId, /^[0-9a-f]{8}$/);
  assert.ok(!logged[0].includes("gateway-secret-token"), "raw credential never appears");

  const offHandler = await setupHandler({
    ...structuredClone(COMPLETE_PLUGIN_CONFIG),
    routes: { default: "demo-provider/steady-coder" },
  });
  const silent = await captureStderr(() =>
    offHandler(request, {}, { readBody: async () => raw }));
  assert.equal(silent.length, 0, "no decision lines when routeLog is absent");
});

test("the caller's mode label selects its route table for main and background traffic", async () => {
  const forwarded = [];
  const routes = [];
  await plugin.setup({
    config: structuredClone(PLUGIN_RUNTIME_CONFIG),
    coreClient: {
      async forwardRaw({ body }) {
        forwarded.push(Buffer.from(body));
      },
    },
    pluginConfig: {
      ...structuredClone(COMPLETE_PLUGIN_CONFIG),
      routeLog: true,
      routes: { default: "demo-provider/steady-coder", background: "demo-provider/cheap-coder" },
      modeRoutes: {
        glm: { default: "demo-provider/glm-coder", background: "demo-provider/glm-mini" },
      },
    },
    registerGatewayRoute(route) {
      routes.push(route);
    },
  });
  const handler = routes.find(({ id }) => id === "airkit-compatibility-messages").handler;
  const lines = [];
  const invoke = async (model, headers) => {
    const raw = Buffer.from(JSON.stringify({ model, max_tokens: 8, messages: [] }), "utf8");
    const original = process.stderr.write;
    process.stderr.write = (chunk) => {
      lines.push(String(chunk));
      return true;
    };
    try {
      await handler({ headers, method: "POST", signal: undefined }, {}, { readBody: async () => raw });
    } finally {
      process.stderr.write = original;
    }
    return JSON.parse(forwarded.at(-1).toString()).model;
  };

  const labelled = { "x-airkit-mode": "glm" };
  assert.equal(await invoke("claude-sonnet-4-6", labelled), "demo-provider/glm-coder");
  assert.equal(await invoke("claude-haiku-4-5-20251001", labelled), "demo-provider/glm-mini");
  assert.equal(
    await invoke("claude-sonnet-4-6", { "x-airkit-mode": "unconfigured" }),
    "demo-provider/steady-coder",
    "an unknown mode still routes through the flat table",
  );
  assert.equal(await invoke("claude-sonnet-4-6", {}), "demo-provider/steady-coder");

  const decisions = lines
    .filter((line) => line.startsWith("[airkit-route] "))
    .map((line) => JSON.parse(line.slice("[airkit-route] ".length)));
  assert.deepEqual(decisions.map((entry) => entry.mode), ["glm", "glm", "unconfigured", null]);
  assert.deepEqual(
    decisions.map((entry) => entry.outModel),
    [
      "demo-provider/glm-coder",
      "demo-provider/glm-mini",
      "demo-provider/steady-coder",
      "demo-provider/steady-coder",
    ],
  );
});

test("bare Claude routing without routes config forwards byte-identical bytes", async () => {
  const forwarded = [];
  const routes = [];
  await plugin.setup({
    config: structuredClone(PLUGIN_RUNTIME_CONFIG),
    coreClient: {
      async forwardRaw({ body }) {
        forwarded.push(Buffer.from(body));
      },
    },
    pluginConfig: structuredClone(COMPLETE_PLUGIN_CONFIG),
    registerGatewayRoute(route) {
      routes.push(route);
    },
  });
  const handler = routes.find(({ id }) => id === "airkit-compatibility-messages").handler;
  const raw = Buffer.from(
    JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 8, messages: [] }),
    "utf8",
  );
  await handler({ headers: {}, method: "POST", signal: undefined }, {}, { readBody: async () => raw });
  assert.deepEqual(forwarded.at(-1), raw);
});

test("handler contains forwarding failures instead of rejecting into the daemon", async () => {
  const fixture = await createPluginFixture({
    coreClient: createPluginCoreClient({
      async forwardRaw() {
        throw new Error("core connection lost");
      },
    }),
  });
  const response = createRecordingResponse();

  await fixture.messages.handler(
    createPluginRequest(Buffer.from(JSON.stringify({ model: "x", messages: [] }))),
    response,
    fixture.helpers,
  );

  assert.equal(response.statusCode, 502);
  assert.match(response.body.toString(), /compatibility forwarding failed/);
});

test("handler destroys the response when failure happens after headers were sent", async () => {
  let destroyedWith;
  const fixture = await createPluginFixture({
    coreClient: createPluginCoreClient({
      async forwardRaw({ response }) {
        response.headersSent = true;
        throw new Error("downstream vanished mid-stream");
      },
    }),
  });
  const response = Object.assign(createRecordingResponse(), {
    destroy(error) {
      destroyedWith = error;
    },
  });

  await fixture.messages.handler(
    createPluginRequest(Buffer.from(JSON.stringify({ model: "x", messages: [] }))),
    response,
    fixture.helpers,
  );

  assert.match(destroyedWith.message, /downstream vanished/);
});

test("client disconnect aborts the lifecycle signal handed to the core", async () => {
  let receivedSignal;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const fixture = await createPluginFixture({
    coreClient: createPluginCoreClient({
      async forwardRaw({ signal }) {
        receivedSignal = signal;
        await gate;
      },
    }),
  });
  const response = createRecordingResponse();

  const pending = fixture.messages.handler(
    createPluginRequest(Buffer.from(JSON.stringify({ model: "x", messages: [] }))),
    response,
    fixture.helpers,
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(receivedSignal.aborted, false);
  response.emit("close");
  assert.equal(receivedSignal.aborted, true, "response close aborts the core request");
  release();
  await pending;
});
