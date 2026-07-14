import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import { test } from "node:test";
import {
  createCoreClient,
  handleCompatibilityMessage,
  writeAnthropicMessage,
} from "../src/compat/gateway.mjs";

const CORE_TOKEN = "generated-core-token";
const RAW_RESPONSE_BODY = Buffer.from([0, 1, 2, 255, 10]);

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

test("advisor bridge consults the configured Anthropic model and resumes the executor", async () => {
  const fixture = createBridgeFixture([
    message({
      id: "msg_executor_1",
      content: [
        { type: "text", text: "I will consult the advisor." },
        { type: "tool_use", id: "toolu_advisor", name: "airkit_advisor", input: {} },
      ],
      usage: { input_tokens: 10, output_tokens: 4 },
    }),
    message({
      id: "msg_advisor",
      model: "anthropic/claude-opus-4-8",
      content: [{ type: "text", text: "Inspect the failure boundary first." }],
      usage: { input_tokens: 100, output_tokens: 20 },
    }),
    message({
      id: "msg_executor_2",
      content: [{ type: "text", text: "The boundary is now clear." }],
      usage: { input_tokens: 12, output_tokens: 6 },
    }),
  ]);

  const result = await handleCompatibilityMessage(fixture.input);

  assert.deepEqual(result.content.map((block) => block.type), [
    "text",
    "server_tool_use",
    "advisor_tool_result",
    "text",
  ]);
  assert.equal(fixture.calls[0].body.model, "executor-model");
  assert.deepEqual(fixture.calls[0].body.tools.map((tool) => tool.name), [
    "ordinary_tool",
    "airkit_advisor",
    "airkit_tool_search",
  ]);
  assert.equal(fixture.calls[1].body.model, "anthropic/claude-opus-4-8");
  assert.equal(fixture.calls[1].body.tools, undefined);
  assert.match(fixture.calls[1].body.messages[0].content, /<transcript>/);
  assert.match(fixture.calls[1].body.messages[0].content, /Please investigate/);
  assert.equal(fixture.calls[2].body.model, "executor-model");
  assert.equal(fixture.calls[2].body.messages.at(-1).role, "user");
  assert.match(fixture.calls[2].body.messages.at(-1).content[0].content, /failure boundary/);
  assert.equal(result.id, "msg_executor_2");
  assert.equal(result.model, "executor-model");
  assert.deepEqual(result.usage, {
    input_tokens: 22,
    output_tokens: 10,
    iterations: {
      advisor: [{ input_tokens: 100, output_tokens: 20 }],
      executor: [
        { input_tokens: 10, output_tokens: 4 },
        { input_tokens: 12, output_tokens: 6 },
      ],
    },
  });
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

test("prior native result blocks become bounded history and reactivate referenced tools", async () => {
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
              id: "srvtoolu_prior_advisor",
              name: "advisor",
              input: {},
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "advisor_tool_result",
              tool_use_id: "srvtoolu_prior_advisor",
              content: {
                type: "advisor_result",
                text: "Use the prior evidence.",
                stop_reason: "end_turn",
              },
            },
          ],
        },
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
  assert.doesNotMatch(normalizedHistory, /advisor_tool_result|tool_search_tool_result/);
  assert.match(normalizedHistory, /Use the prior evidence/);
  assert.match(normalizedHistory, /search_files/);
});

test("mixed compatibility and normal client tool calls return the client call without executing it", async () => {
  const fixture = createBridgeFixture([
    message({
      content: [
        { type: "text", text: "Before advisor." },
        { type: "tool_use", id: "toolu_advisor", name: "airkit_advisor", input: {} },
        { type: "text", text: "After advisor." },
        { type: "tool_use", id: "toolu_client", name: "ordinary_tool", input: { value: 1 } },
      ],
      stop_reason: "tool_use",
    }),
    message({
      model: "anthropic/claude-opus-4-8",
      content: [{ type: "text", text: "Use the ordinary tool next." }],
    }),
  ]);

  const result = await handleCompatibilityMessage(fixture.input);

  assert.equal(fixture.calls.length, 2);
  assert.deepEqual(result.content.map((block) => block.type), [
    "text",
    "server_tool_use",
    "advisor_tool_result",
    "text",
    "tool_use",
  ]);
  assert.equal(result.content.at(-1).name, "ordinary_tool");
});

test("advisor max_uses returns a canonical error without another advisor call", async () => {
  const fixture = createBridgeFixture([
    message({
      content: [{ type: "tool_use", id: "toolu_advisor_1", name: "airkit_advisor", input: {} }],
    }),
    message({
      model: "anthropic/claude-opus-4-8",
      content: [{ type: "text", text: "One consultation only." }],
    }),
    message({
      content: [{ type: "tool_use", id: "toolu_advisor_2", name: "airkit_advisor", input: {} }],
    }),
    message({ content: [{ type: "text", text: "Continuing without another consultation." }] }),
  ], { advisorMaxUses: 1 });

  const result = await handleCompatibilityMessage(fixture.input);

  assert.equal(fixture.calls.filter((call) => call.body.model.includes("opus")).length, 1);
  assert.equal(result.content[3].type, "advisor_tool_result");
  assert.equal(result.content[3].content.error_code, "max_uses_exceeded");
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

test("unsupported native history falls back for only this request with a visible warning", async () => {
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
  assert.equal(fixture.calls[0].body.model, "anthropic/claude-opus-4-8");
  assert.equal(fixture.calls[0].body.tools.some((tool) => tool.type?.startsWith("advisor_")), false);
  assert.equal(fixture.calls[0].body.tools.some((tool) => tool.defer_loading === true), false);
  assert.equal(fixture.calls[0].body.tools.some((tool) => tool.name === "get_weather"), true);
  assert.match(JSON.stringify(fixture.calls[0].body.messages), /srvtoolu_web_search/);
  assert.equal(result.content[0].type, "text");
  assert.match(result.content[0].text, /compatibility fallback/i);
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
    /fallbackModel must be an Anthropic-family model/,
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
  assert.equal(fixture.calls.at(-1).body.model, "anthropic/claude-opus-4-8");
  assert.match(result.content[0].text, /compatibility fallback/i);
  assert.equal(result.usage.iterations.executor.length, 9);
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

function createBridgeFixture(script, options = {}) {
  const calls = [];
  const queue = [...script];
  const advisorMaxUses = options.advisorMaxUses ?? 2;
  const body = {
    model: "executor-model",
    max_tokens: 2048,
    messages: [{ role: "user", content: "Please investigate the current failure." }],
    tools: [
      {
        type: "advisor_20260301",
        name: "advisor",
        max_uses: advisorMaxUses,
        max_tokens: 512,
      },
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
        advisor: {
          mode: "bridge",
          model: "anthropic/claude-opus-4-8",
          fallbackModel: options.fallbackModel ?? "anthropic/claude-opus-4-8",
        },
        toolSearch: { mode: "bridge" },
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
