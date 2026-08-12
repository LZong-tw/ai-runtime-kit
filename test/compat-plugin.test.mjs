import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import { test } from "node:test";
import {
  createCoreClient,
  handleCompatibilityMessage,
  writeAnthropicMessage,
} from "../src/compat/gateway.mjs";
import {
  resolveCompatibilityPolicies,
  VERIFIED_NATIVE_COMPATIBILITY,
} from "../src/compat/config.mjs";
import plugin, {
  createMcpHandler,
  createMessagesHandler,
} from "../src/compat/plugin.mjs";
import { classifyCacheCohort, describeStablePrefix } from "../src/compat/prefix-observability.mjs";

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

test("raw passthrough retries an explicit 401 fallback once with only its model changed", async () => {
  const seenBodies = [];
  const client = createCoreClient({
    config: {
      gateway: {
        coreHost: "127.0.0.1",
        corePort: 43991,
        generatedConfigFile: "/fixture/generated.json",
      },
    },
    async fetchImpl(_endpoint, options) {
      seenBodies.push(Buffer.from(options.body));
      return seenBodies.length === 1
        ? new Response("web route rejected", { status: 401 })
        : new Response("oneportal response", { status: 200 });
    },
    readFile: () => generatedConfig(CORE_TOKEN),
  });
  const primary = Buffer.from(JSON.stringify({
    model: "web-litellm/gpt-5.6-terra",
    messages: [{ role: "user", content: "same request" }],
  }));
  const fallback = Buffer.from(JSON.stringify({
    model: "oneportal/gpt-5.6-terra",
    messages: [{ role: "user", content: "same request" }],
  }));
  const response = createRecordingResponse();

  await client.forwardRaw({
    body: primary,
    fallback: { body: fallback, statuses: [401] },
    headers: {},
    response,
  });

  assert.deepEqual(seenBodies, [primary, fallback]);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, Buffer.from("oneportal response"));
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

test("Advisor bridge uses the configured Anthropic model and resumes the executor", async () => {
  const fixture = createBridgeFixture([
    message({
      content: [
        { type: "text", text: "I will consult the advisor." },
        { type: "tool_use", id: "toolu_advisor", name: "airkit_advisor", input: {} },
      ],
    }),
    message({
      model: "anthropic-messages/claude-sonnet",
      content: [{ type: "text", text: "Inspect the failure boundary first." }],
    }),
    message({ content: [{ type: "text", text: "The boundary is now clear." }] }),
  ], {
    body: {
      tools: [{
        type: "advisor_20260301",
        name: "advisor",
        model: "claude-opus-5",
        max_uses: 2,
      }],
    },
    advisorMode: "bridge",
  });

  const result = await handleCompatibilityMessage(fixture.input);

  assert.deepEqual(result.content.map((block) => block.type), [
    "text",
    "server_tool_use",
    "advisor_tool_result",
    "text",
  ]);
  assert.equal(fixture.calls[0].body.tools.some((tool) => tool.type?.startsWith("advisor_")), false);
  assert.equal(fixture.calls[0].body.tools.some((tool) => tool.name === "airkit_advisor"), true);
  assert.equal(fixture.calls[1].body.model, "anthropic-messages/claude-sonnet");
  assert.equal(fixture.calls[1].body.tools, undefined);
  assert.match(fixture.calls[1].body.messages[0].content, /<transcript>/);
  assert.equal(fixture.calls[2].body.model, "executor-model");
  assert.match(fixture.calls[2].body.messages.at(-1).content[0].content, /failure boundary/);
  assert.match(result.content[2].content.text, /failure boundary/);
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
      model: "anthropic/claude-opus-5",
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
        model: "anthropic/claude-opus-5",
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
      model: "anthropic/claude-opus-5",
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

test("gateway aggregates DeepSeek cache hit and miss counters across executor iterations", async () => {
  const fixture = createBridgeFixture([
    message({
      content: [{
        type: "tool_use",
        id: "toolu_search",
        name: "airkit_tool_search",
        input: { query: "weather" },
      }],
      usage: {
        input_tokens: 10,
        output_tokens: 2,
        prompt_cache_hit_tokens: 50,
        prompt_cache_miss_tokens: 10,
      },
    }),
    message({
      content: [{ type: "text", text: "Usage is complete." }],
      usage: {
        input_tokens: 12,
        output_tokens: 3,
        prompt_cache_hit_tokens: 70,
        prompt_cache_miss_tokens: 30,
      },
    }),
  ]);

  const result = await handleCompatibilityMessage(fixture.input);

  assert.equal(result.usage.prompt_cache_hit_tokens, 120);
  assert.equal(result.usage.prompt_cache_miss_tokens, 40);
  assert.deepEqual(result.usage.iterations.executor.map((usage) => ({
    prompt_cache_hit_tokens: usage.prompt_cache_hit_tokens,
    prompt_cache_miss_tokens: usage.prompt_cache_miss_tokens,
  })), [
    { prompt_cache_hit_tokens: 50, prompt_cache_miss_tokens: 10 },
    { prompt_cache_hit_tokens: 70, prompt_cache_miss_tokens: 30 },
  ]);
});

test("zero core usage gets a bounded estimate for Claude Code context tracking", async () => {
  const fixture = createBridgeFixture([
    message({
      content: [{ type: "text", text: "A short answer." }],
      usage: { input_tokens: 0, output_tokens: 0 },
    }),
  ]);

  const result = await handleCompatibilityMessage(fixture.input);

  assert.ok(result.usage.input_tokens > 0);
  assert.ok(result.usage.output_tokens > 0);
  assert.equal(result.usage.cache_read_input_tokens, undefined);
  assert.equal(result.usage.cache_creation_input_tokens, undefined);
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

test("Anthropic responses do not expose executor iteration telemetry to Claude Code", async () => {
  const outbound = message({
    usage: {
      input_tokens: 12,
      output_tokens: 3,
      iterations: {
        executor: [{ input_tokens: 7, output_tokens: 1 }],
      },
    },
  });
  const jsonResponse = createMessageResponse();
  const streamResponse = createMessageResponse();

  await writeAnthropicMessage(jsonResponse, outbound, false);
  await writeAnthropicMessage(streamResponse, outbound, true);

  assert.equal(JSON.parse(jsonResponse.body).usage.iterations, undefined);
  const frames = parseSse(streamResponse.body);
  assert.equal(frames[0].data.message.usage.iterations, undefined);
  assert.equal(
    frames.find((frame) => frame.event === "message_delta").data.usage.iterations,
    undefined,
  );
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

test("compatibility plugin validates its configuration without registering public CCR routes", async () => {
  const routes = [];

  await plugin.setup({
    config: structuredClone(PLUGIN_RUNTIME_CONFIG),
    coreClient: {},
    pluginConfig: structuredClone(COMPLETE_PLUGIN_CONFIG),
    registerGatewayRoute(route) {
      routes.push(route);
    },
  });

  assert.deepEqual(routes, []);
  const handlers = await createPluginHandlers({
    coreClient: createPluginCoreClient(),
    pluginConfig: structuredClone(COMPLETE_PLUGIN_CONFIG),
  });
  assert.equal(typeof handlers.messages.handler, "function");
  assert.equal(typeof handlers.mcp.handler, "function");
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

test("compatibility plugin rejects removed Advisor model configuration before registering routes", async () => {
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
    /advisor\.model.*removed/,
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

// The whole point of the strip is where it happens: a server-tool definition
// diverts the request on presence alone, so removing advisor after that
// decision would be too late. These two assert the decision itself flips.
test("advisor stripping does not write diagnostics into the interactive terminal", async () => {
  const fixture = await createPluginFixture({
    coreClient: createPluginCoreClient({
      async forwardRaw(input) {
        input.response.end();
      },
    }),
  });
  const body = Buffer.from(JSON.stringify({
    model: "claude-sonnet-5",
    messages: [{ role: "user", content: "hi" }],
    tools: [{ name: "Bash" }, { type: "advisor_20260301" }],
  }), "utf8");
  const captured = [];
  const originalWrite = process.stderr.write;
  process.stderr.write = (chunk) => {
    captured.push(String(chunk));
    return true;
  };

  try {
    await fixture.messages.handler(
      createPluginRequest(body),
      createRecordingResponse(),
      fixture.helpers,
    );
  } finally {
    process.stderr.write = originalWrite;
  }

  assert.equal(captured.some((line) => line.startsWith("[airkit-advisor-stripped]")), false);
});

test("an advisor definition is stripped before the compatibility decision", async () => {
  const forwarded = [];
  const fixture = await createPluginFixture({
    coreClient: createPluginCoreClient({
      async forwardRaw(input) {
        forwarded.push(JSON.parse(input.body.toString("utf8")));
        input.response.end();
      },
    }),
  });
  const body = Buffer.from(JSON.stringify({
    model: "claude-sonnet-5",
    messages: [{ role: "user", content: "hi" }],
    tools: [{ name: "Bash" }, { type: "advisor_20260301" }],
  }), "utf8");

  await fixture.messages.handler(
    createPluginRequest(body),
    createRecordingResponse(),
    fixture.helpers,
  );

  assert.equal(forwarded.length, 1, "the request must stay on the raw passthrough");
  assert.deepEqual(forwarded[0].tools, [{ name: "Bash" }]);
});

test("advisor bridge keeps the definition and returns a canonical result", async () => {
  const calls = [];
  const queue = [
    message({ content: [{ type: "tool_use", id: "toolu_advisor", name: "airkit_advisor", input: {} }] }),
    message({
      model: "anthropic-messages/claude-sonnet",
      content: [{ type: "text", text: "Review complete." }],
    }),
    message({ content: [{ type: "text", text: "Proceed with the verified fix." }] }),
  ];
  const fixture = await createPluginFixture({
    pluginConfig: {
      advisor: { mode: "bridge" },
    },
    coreClient: {
      async requestMessage(body, headers) {
        calls.push({ body: structuredClone(body), headers: structuredClone(headers ?? {}) });
        return structuredClone(queue.shift());
      },
    },
  });
  const body = Buffer.from(JSON.stringify({
    model: "claude-sonnet-5",
    max_tokens: 512,
    messages: [{ role: "user", content: "hi" }],
    tools: [{ type: "advisor_20260301", name: "advisor", max_uses: 1 }],
  }), "utf8");
  const response = createRecordingResponse();

  await fixture.messages.handler(createPluginRequest(body), response, fixture.helpers);

  const result = JSON.parse(response.body.toString("utf8"));
  assert.equal(response.statusCode, 200);
  assert.deepEqual(result.content.map((block) => block.type), [
    "server_tool_use",
    "advisor_tool_result",
    "text",
  ]);
  assert.equal(calls[0].body.tools.some((tool) => tool.type === "advisor_20260301"), false);
  const advisorTool = calls[0].body.tools.find((tool) => tool.name === "airkit_advisor");
  assert.ok(advisorTool);
  assert.match(advisorTool.description, /independent second opinion/i);
  assert.match(advisorTool.description, /找 Advisor/);
  assert.match(advisorTool.description, /advisor_tool_result/);
  assert.equal(calls[1].body.tools, undefined);
  assert.equal(result.content[1].content.text, "Review complete.");
});

test("advisor.unsupported passthrough leaves the definition in place and diverts", async () => {
  const forwarded = [];
  const fixture = await createPluginFixture({
    pluginConfig: { advisor: { mode: "anthropic-fallback", unsupported: "passthrough" } },
    coreClient: createPluginCoreClient({
      async forwardRaw(input) {
        forwarded.push(JSON.parse(input.body.toString("utf8")));
        input.response.end();
      },
    }),
  });
  const body = Buffer.from(JSON.stringify({
    model: "claude-sonnet-5",
    messages: [{ role: "user", content: "hi" }],
    tools: [{ name: "Bash" }, { type: "advisor_20260301" }],
  }), "utf8");

  await fixture.messages.handler(
    createPluginRequest(body),
    createRecordingResponse(),
    fixture.helpers,
  );

  assert.equal(forwarded.length, 0, "the advisor definition must still divert the request");
});

test("unused native-first server-tool definitions keep a DeepSeek request on its executor route", async () => {
  const executorCalls = [];
  const fallbackCalls = [];
  const fixture = await createPluginFixture({
    coreClient: {
      async requestMessage(body) {
        executorCalls.push(structuredClone(body));
        return message({ content: [{ type: "text", text: "executor response" }] });
      },
      async requestFallback(body) {
        fallbackCalls.push(structuredClone(body));
        throw new Error("unused native-first definition must not trigger fallback");
      },
    },
  });
  const body = {
    model: "oneportal/deepseek-v4-flash",
    max_tokens: 512,
    system: "Stable prefix — keep this whitespace and Unicode unchanged.\n  ",
    messages: [{ role: "user", content: [{ type: "text", text: "answer without searching" }] }],
    tools: [
      {
        name: "ordered_first",
        description: "Must remain before the native server tool.",
        input_schema: { type: "object", properties: { value: { type: "string" } } },
      },
      { type: "web_search_20260318", name: "web_search" },
    ],
  };
  const response = createRecordingResponse();

  await fixture.messages.handler(
    createPluginRequest(Buffer.from(JSON.stringify(body))),
    response,
    fixture.helpers,
  );

  assert.equal(fallbackCalls.length, 0);
  assert.equal(executorCalls.length, 1);
  assert.equal(executorCalls[0].model, body.model);
  assert.equal(
    JSON.stringify({ system: executorCalls[0].system, messages: executorCalls[0].messages, tools: executorCalls[0].tools }),
    JSON.stringify({ system: body.system, messages: body.messages, tools: body.tools }),
    "DeepSeek stable prompt prefix fields must remain byte-identical on the executor route",
  );
  assert.equal(JSON.parse(response.body).content[0].text, "executor response");
});

test("unused native-first server-tool definitions keep a GPT request on its executor route", async () => {
  const executorCalls = [];
  const fallbackCalls = [];
  const fixture = await createPluginFixture({
    coreClient: {
      async requestMessage(body) {
        executorCalls.push(structuredClone(body));
        return message({ content: [{ type: "text", text: "executor response" }] });
      },
      async requestFallback(body) {
        fallbackCalls.push(structuredClone(body));
        throw new Error("unused native-first definition must not trigger fallback");
      },
    },
  });
  const body = {
    model: "oneportal/gpt-5.6-luna",
    max_tokens: 512,
    system: "Stable GPT prefix — keep this ordering unchanged.\n  ",
    messages: [{ role: "user", content: [{ type: "text", text: "answer without searching" }] }],
    tools: [{ type: "web_search_20260318", name: "web_search" }],
  };
  const response = createRecordingResponse();

  await fixture.messages.handler(
    createPluginRequest(Buffer.from(JSON.stringify(body))),
    response,
    fixture.helpers,
  );

  assert.equal(fallbackCalls.length, 0);
  assert.equal(executorCalls.length, 1);
  assert.equal(executorCalls[0].model, body.model);
  assert.equal(
    JSON.stringify({ system: executorCalls[0].system, messages: executorCalls[0].messages, tools: executorCalls[0].tools }),
    JSON.stringify({ system: body.system, messages: body.messages, tools: body.tools }),
    "GPT stable prompt prefix fields must remain byte-identical on the executor route",
  );
  assert.equal(JSON.parse(response.body).content[0].text, "executor response");
});

test("unused native-first server-tool definitions still fallback for non-cache-sensitive routes", async () => {
  const executorCalls = [];
  const fallbackCalls = [];
  const fixture = await createPluginFixture({
    coreClient: {
      async requestMessage(body) {
        executorCalls.push(structuredClone(body));
        return message({ content: [{ type: "text", text: "unexpected executor response" }] });
      },
      async requestFallback(body) {
        fallbackCalls.push(structuredClone(body));
        return message({ content: [{ type: "text", text: "fallback response" }] });
      },
    },
  });
  const body = {
    model: "oneportal/kimi-k2.6",
    max_tokens: 512,
    messages: [{ role: "user", content: "answer without searching" }],
    tools: [{ type: "web_search_20260318", name: "web_search" }],
  };
  const response = createRecordingResponse();

  await fixture.messages.handler(
    createPluginRequest(Buffer.from(JSON.stringify(body))),
    response,
    fixture.helpers,
  );

  assert.equal(fallbackCalls.length, 1);
  assert.equal(executorCalls.length, 0);
});

test("cache-sensitive routes still fallback for unverified native-first server tools", async () => {
  const executorCalls = [];
  const fallbackCalls = [];
  const fixture = await createPluginFixture({
    coreClient: {
      async requestMessage(body) {
        executorCalls.push(structuredClone(body));
        return message({ content: [{ type: "text", text: "unexpected executor response" }] });
      },
      async requestFallback(body) {
        fallbackCalls.push(structuredClone(body));
        return message({ content: [{ type: "text", text: "fallback response" }] });
      },
    },
  });
  const response = createRecordingResponse();

  await fixture.messages.handler(
    createPluginRequest(Buffer.from(JSON.stringify({
      model: "oneportal/gpt-5.6-luna",
      max_tokens: 512,
      messages: [{ role: "user", content: "answer without fetching" }],
      tools: [{ type: "web_fetch_20260318", name: "web_fetch" }],
    }))),
    response,
    fixture.helpers,
  );

  assert.equal(fallbackCalls.length, 1);
  assert.equal(executorCalls.length, 0);
});

test("ordinary DeepSeek Messages requests remove unsupported Claude effort before forwarding", async () => {
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
    messages: [{ role: "user", content: "hi" }],
  }]);
});

test("ordinary GPT Messages requests reserve output space beyond short reasoning budgets", async () => {
  const calls = [];
  const fixture = await createPluginFixture({
    coreClient: createPluginCoreClient({
      async forwardRaw(input) {
        calls.push(JSON.parse(input.body.toString("utf8")));
      },
    }),
  });
  const body = {
    model: "oneportal/gpt-5.6-terra",
    max_tokens: 64,
    messages: [{ role: "user", content: "Summarize the restored session." }],
  };

  await fixture.messages.handler(
    createPluginRequest(Buffer.from(JSON.stringify(body))),
    createRecordingResponse(),
    fixture.helpers,
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].max_tokens, 1024);
});

test("oversized GPT-family tool catalogs use the local ToolSearch bridge within the upstream limit", async () => {
  const calls = [];
  const replies = [
    message({
      content: [{
        type: "tool_use",
        id: "toolu_search",
        name: "airkit_tool_search",
        input: { query: "Client" },
      }],
      stop_reason: "tool_use",
    }),
    message({ content: [{ type: "text", text: "ok" }] }),
  ];
  const fixture = await createPluginFixture({
    pluginConfig: {
      toolSearch: {
        mode: "bridge",
        maxToolsByModel: { "gpt-*": 128 },
      },
    },
    coreClient: createPluginCoreClient({
      async requestMessage(body) {
        calls.push(structuredClone(body));
        return replies.shift();
      },
    }),
  });
  const body = {
    model: "oneportal/gpt-5.4",
    max_tokens: 8,
    messages: [{ role: "user", content: "hi" }],
    tools: Array.from({ length: 171 }, (_, index) => ({
      name: `client_tool_${index}`,
      description: `Client tool ${index}`,
      input_schema: { type: "object", properties: {} },
    })),
  };

  await fixture.messages.handler(
    createPluginRequest(Buffer.from(JSON.stringify(body))),
    createRecordingResponse(),
    fixture.helpers,
  );

  assert.equal(calls.length, 2);
  assert.ok(calls[0].tools.length <= 128);
  assert.ok(calls[1].tools.length <= 128);
  assert.ok(calls[0].tools.some(({ name }) => name === "airkit_tool_search"));
  assert.equal(calls[0].tools.filter(({ name }) => name.startsWith("client_tool_")).length, 122);
  assert.equal(calls[1].tools.filter(({ name }) => name.startsWith("client_tool_")).length, 127);
});

test("oversized GPT catalogs keep Claude Code WebFetch on the bounded client-tool executor", async () => {
  const calls = [];
  const fixture = await createPluginFixture({
    pluginConfig: {
      toolSearch: {
        mode: "bridge",
        maxToolsByModel: { "gpt-5.6-terra": 128 },
      },
    },
    coreClient: createPluginCoreClient({
      async requestMessage(body) {
        calls.push(structuredClone(body));
        return message({ content: [{ type: "text", text: "ok" }] });
      },
      async requestFallback() {
        throw new Error("client-side WebFetch must not divert an ordinary GPT turn");
      },
    }),
  });
  const response = createRecordingResponse();
  const body = {
    model: "oneportal/gpt-5.6-terra",
    max_tokens: 512,
    messages: [{ role: "user", content: "Fetch the page." }],
    tools: [
      { name: "WebFetch", input_schema: { type: "object" } },
      ...Array.from({ length: 170 }, (_, index) => ({
        name: `client_tool_${index}`,
        description: `Client tool ${index}`,
        input_schema: { type: "object", properties: {} },
      })),
    ],
  };

  await fixture.messages.handler(
    createPluginRequest(Buffer.from(JSON.stringify(body))),
    response,
    fixture.helpers,
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].model, body.model);
  assert.ok(calls[0].tools.length <= 128);
  assert.ok(calls[0].tools.some(({ name }) => name === "WebFetch"));
  assert.ok(calls[0].tools.some(({ name }) => name === "airkit_tool_search"));
  assert.equal(response.statusCode, 200);
});

test("unverified native-first WebFetch definition does not divert an ordinary turn", async () => {
  const calls = [];
  const fixture = await createPluginFixture({
    coreClient: createPluginCoreClient({
      async forwardRaw(input) {
        calls.push(input);
        input.response.writeHead(202, { "content-type": "application/json" });
        input.response.end(Buffer.from("{}"));
      },
      async requestFallback() {
        throw new Error("a client-side WebFetch definition alone must not fallback");
      },
    }),
  });
  const response = createRecordingResponse();
  const body = {
    model: "oneportal/deepseek-v4-flash",
    max_tokens: 512,
    messages: [{ role: "user", content: "Inspect the repository." }],
    tools: [{ name: "WebFetch", input_schema: { type: "object" } }],
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

test("fallback rejections respect routeLog and do not duplicate terminal API errors", async () => {
  const captured = [];
  const originalWrite = process.stderr.write;
  process.stderr.write = (chunk) => {
    captured.push(String(chunk));
    return true;
  };
  try {
    const fixture = await createPluginFixture({
      pluginConfig: { webFetch: { mode: "anthropic-fallback" } },
      coreClient: createPluginCoreClient({
        async requestFallback() {
          return new Response(JSON.stringify({ error: { message: "rate limited" } }), {
            status: 429,
            headers: { "content-type": "application/json" },
          });
        },
      }),
    });
    const response = createRecordingResponse();
    await fixture.messages.handler(
      createPluginRequest(Buffer.from(JSON.stringify({
        model: "executor-model",
        max_tokens: 8,
        messages: [{ role: "user", content: "fetch" }],
        tools: [{ name: "WebFetch", input_schema: { type: "object" } }],
      }))),
      response,
      fixture.helpers,
    );
    assert.equal(response.statusCode, 429);
    assert.equal(captured.some((line) => line.startsWith("[airkit-fallback]")), false);
  } finally {
    process.stderr.write = originalWrite;
  }
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

test("Web LiteLLM strips its unsupported WebSearch definition while verified providers stay native", async () => {
  const rawCalls = [];
  const fixture = await createPluginFixture({
    pluginConfig: {
      webSearch: {
        mode: "native-first",
        clientToolExclusions: ["web-litellm-anthropic"],
      },
    },
    coreClient: createPluginCoreClient({
      async forwardRaw(input) {
        rawCalls.push(input);
        input.response.writeHead(202, { "content-type": "application/json" });
        input.response.end(Buffer.from("{}"));
      },
    }),
  });
  const tools = [{ name: "WebSearch", input_schema: { type: "object" } }];
  const invoke = async (model) => fixture.messages.handler(
    createPluginRequest(Buffer.from(JSON.stringify({ model, messages: [], tools }))),
    createRecordingResponse(),
    fixture.helpers,
  );

  await invoke("web-litellm-anthropic/claude-opus-5");
  await invoke("oneportal-anthropic/claude-sonnet-5");

  assert.equal(rawCalls.length, 2);
  assert.deepEqual(JSON.parse(rawCalls[0].body).tools, []);
  assert.deepEqual(JSON.parse(rawCalls[1].body).tools, tools);
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
  const coreCalls = [];
  let readCount = 0;
  const helpers = {
    async readBody(request) {
      readCount += 1;
      return request.body;
    },
  };
  const coreClient = options.coreClient ?? createPluginCoreClient({
      async requestMessage(body, headers) {
        coreCalls.push({ body: structuredClone(body), headers: structuredClone(headers ?? {}) });
        return webSearchMessage();
      },
  });
  const handlers = await createPluginHandlers({
    coreClient,
    pluginConfig: {
      ...structuredClone(COMPLETE_PLUGIN_CONFIG),
      ...options.pluginConfig,
    },
  });
  const { mcp } = handlers;
  return {
    coreCalls,
    helpers,
    messages: handlers.messages,
    mcp,
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

async function createPluginHandlers({
  config = structuredClone(PLUGIN_RUNTIME_CONFIG),
  coreClient,
  pluginConfig,
}) {
  await plugin.setup({ config, coreClient, pluginConfig });
  const { policies } = resolveCompatibilityPolicies(
    pluginConfig,
    VERIFIED_NATIVE_COMPATIBILITY,
  );
  return {
    mcp: { handler: createMcpHandler({ config: pluginConfig, coreClient }) },
    messages: {
      handler: createMessagesHandler({
        config: pluginConfig,
        coreClient,
        policies,
      }),
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

function createPluginRequest(body, { headers, signal } = {}) {
  return Object.assign(new EventEmitter(), {
    body,
    headers: {
      "content-type": "application/json",
      "x-request-id": "fixture-request",
      ...headers,
    },
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
        advisor: { mode: options.advisorMode ?? "anthropic-fallback" },
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
    headersSent: false,
    statusCode: 200,
    writableEnded: false,
    writableFinished: false,
    writeHead(statusCode, headers) {
      this.statusCode = statusCode;
      this.headersSent = true;
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
      this.writableEnded = true;
      if (endEvent !== null) {
        if (endEvent === "finish") this.writableFinished = true;
        this.emit(endEvent);
      }
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
  const pluginConfig = {
    ...structuredClone(COMPLETE_PLUGIN_CONFIG),
    routes: {
      default: "demo-provider/steady-coder",
      background: "demo-provider/cheap-coder",
    },
  };
  const handlers = await createPluginHandlers({
    coreClient: {
      async forwardRaw({ body }) {
        forwarded.push(Buffer.from(body));
      },
    },
    pluginConfig,
  });
  const handler = handlers.messages.handler;
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
    const handlers = await createPluginHandlers({
      coreClient: { async forwardRaw() {} },
      pluginConfig,
    });
    return handlers.messages.handler;
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
    JSON.stringify({ model: "claude-sonnet-5", max_tokens: 8, messages: [] }),
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
  assert.equal(entry.inModel, "claude-sonnet-5");
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

test("stable prefix observation changes only when the prefix changes", () => {
  const base = {
    model: "oneportal/deepseek-v4-flash",
    system: [{ type: "text", text: "stable system" }],
    tools: [{ name: "Bash", input_schema: { type: "object" } }],
    messages: [
      { role: "user", content: "earlier request" },
      { role: "assistant", content: "earlier answer" },
      { role: "user", content: "tail A" },
    ],
  };
  const samePrefix = describeStablePrefix({ ...base, messages: [...base.messages.slice(0, -1), { role: "user", content: "tail B" }] });
  const changedSystem = describeStablePrefix({ ...base, system: [{ type: "text", text: "changed system" }] });
  const changedHistory = describeStablePrefix({ ...base, messages: [{ role: "user", content: "changed history" }, ...base.messages.slice(1)] });

  assert.equal(samePrefix.stablePrefixHash, describeStablePrefix(base).stablePrefixHash);
  assert.notEqual(changedSystem.stablePrefixHash, describeStablePrefix(base).stablePrefixHash);
  assert.notEqual(changedHistory.stablePrefixHash, describeStablePrefix(base).stablePrefixHash);
  assert.match(samePrefix.stablePrefixHash, /^[0-9a-f]{64}$/);
  assert.equal(samePrefix.candidate, true);
});

test("cache cohort classifies every model from request shape and provider counters", () => {
  const coldStart = describeStablePrefix({
    model: "oneportal/Kimi-K3",
    messages: [{ role: "user", content: "first request" }],
  });
  const reusablePrefix = describeStablePrefix({
    model: "oneportal/deepseek-v4-flash",
    messages: [
      { role: "user", content: "history" },
      { role: "user", content: "tail" },
    ],
  });

  assert.deepEqual(classifyCacheCohort(coldStart, null), {
    state: "cold_start",
    stablePrefixMessages: 0,
  });
  assert.deepEqual(classifyCacheCohort(reusablePrefix, {
    prompt_cache_hit_tokens: 80,
    prompt_cache_miss_tokens: 20,
  }), {
    state: "reusable_prefix_hit",
    stablePrefixMessages: 1,
  });
  assert.deepEqual(classifyCacheCohort(reusablePrefix, {
    prompt_cache_hit_tokens: 0,
    prompt_cache_miss_tokens: 100,
  }), {
    state: "reusable_prefix_miss",
    stablePrefixMessages: 1,
  });
  assert.deepEqual(classifyCacheCohort(reusablePrefix, null), {
    state: "usage_unavailable",
    stablePrefixMessages: 1,
  });
});

test("stable prefix metadata never changes the forwarded request body", async () => {
  const forwarded = [];
  const handler = await createPluginHandlers({
    coreClient: { async forwardRaw({ body }) { forwarded.push(Buffer.from(body)); } },
    pluginConfig: {
      ...structuredClone(COMPLETE_PLUGIN_CONFIG),
      routeLog: true,
      routes: { default: "oneportal/deepseek-v4-flash" },
    },
  });
  const body = {
    model: "oneportal/deepseek-v4-flash",
    system: [{ type: "text", text: "stable system" }],
    tools: [{ name: "Bash", input_schema: { type: "object" } }],
    messages: [
      { role: "user", content: "history" },
      { role: "user", content: "tail" },
    ],
  };
  const raw = Buffer.from(JSON.stringify(body));
  const logs = await captureAirkitLogs(() => handler.messages.handler(
    createPluginRequest(raw, { headers: { "x-request-id": "stable-prefix-body" } }),
    {},
    { readBody: async () => raw },
  ));
  assert.deepEqual(forwarded, [raw]);
  assert.match(logs.routes[0].stablePrefix.stablePrefixHash, /^[0-9a-f]{64}$/);
  assert.equal(logs.requests[0].stablePrefix.stablePrefixMessages, 1);
});

test("raw Web GPT requests carry their explicit OnePortal 401 fallback", async () => {
  let forwarded;
  const handler = await createPluginHandlers({
    coreClient: {
      async forwardRaw(request) {
        forwarded = request;
      },
    },
    pluginConfig: {
      ...structuredClone(COMPLETE_PLUGIN_CONFIG),
      transportFallbacks: [{
        from: { provider: "web-litellm", model: "gpt-5.6-terra" },
        to: { provider: "oneportal", model: "gpt-5.6-terra" },
        statuses: [401],
      }],
    },
  });
  const raw = Buffer.from(JSON.stringify({
    model: "web-litellm/gpt-5.6-terra",
    messages: [{ role: "user", content: "keep the Web route when healthy" }],
  }));

  await handler.messages.handler(
    createPluginRequest(raw),
    createRecordingResponse(),
    { readBody: async () => raw },
  );

  assert.deepEqual(forwarded.body, raw);
  assert.deepEqual(JSON.parse(forwarded.fallback.body.toString()), {
    model: "oneportal/gpt-5.6-terra",
    messages: [{ role: "user", content: "keep the Web route when healthy" }],
  });
  assert.deepEqual(forwarded.fallback.statuses, [401]);
});

test("request lifecycle telemetry records a successful raw response with its actual status", async () => {
  const fixture = await createPluginFixture({
    pluginConfig: {
      routeLog: true,
      routes: { default: "oneportal/GLM-5.2" },
    },
    coreClient: createPluginCoreClient({
      async forwardRaw({ response }) {
        response.writeHead(202, { "content-type": "application/json" });
        response.end("accepted");
      },
    }),
  });
  const response = createRecordingResponse();
  const body = Buffer.from(JSON.stringify({
    model: "claude-sonnet-5",
    messages: [{ role: "user", content: "body-secret-value" }],
  }));
  const logs = await captureAirkitLogs(() => fixture.messages.handler(
    createPluginRequest(body, {
      headers: {
        authorization: "Bearer auth-secret-value",
        "x-request-id": "request-observe-202",
      },
    }),
    response,
    fixture.helpers,
  ));

  assert.equal(logs.routes.length, 1);
  assert.equal(logs.requests.length, 1, "exactly one terminal record is emitted");
  assert.equal(logs.routes[0].requestId, "request-observe-202");
  assert.deepEqual(withoutTiming(logs.requests[0]), {
    requestId: "request-observe-202",
    path: "passthrough",
    mode: null,
    inModel: "claude-sonnet-5",
    outModel: "oneportal/GLM-5.2",
    provider: "oneportal",
    stream: false,
    status: 202,
    outcome: "completed",
    cacheCohort: { state: "cold_start", stablePrefixMessages: 0 },
  });
  assertTerminalTiming(logs.requests[0]);
  assert.doesNotMatch(logs.raw, /auth-secret-value|body-secret-value/);
});

test("request lifecycle telemetry records compatibility JSON and SSE completion", async () => {
  const fixture = await createPluginFixture({
    pluginConfig: { routeLog: true },
    coreClient: createPluginCoreClient({
      async requestMessage() {
        return message({ content: [{ type: "text", text: "ok" }] });
      },
    }),
  });
  const requests = [false, true].map((stream) => ({
    body: Buffer.from(JSON.stringify({
      ...compatibilityRequestBody(stream),
      model: "oneportal/executor-model",
    })),
    response: createRecordingResponse(),
    stream,
  }));
  const logs = await captureAirkitLogs(async () => {
    for (const request of requests) {
      await fixture.messages.handler(
        createPluginRequest(request.body, {
          headers: { "x-request-id": `request-compat-${request.stream ? "sse" : "json"}` },
        }),
        request.response,
        fixture.helpers,
      );
    }
  });

  assert.equal(logs.routes.length, 2);
  assert.equal(logs.requests.length, 2, "one terminal record per compatibility request");
  assert.deepEqual(logs.requests.map((entry) => withoutTiming(entry)), [
    {
      requestId: "request-compat-json",
      path: "compat",
      mode: null,
      inModel: "oneportal/executor-model",
      outModel: "oneportal/executor-model",
      provider: "oneportal",
      stream: false,
      status: 200,
      outcome: "completed",
      cacheCohort: { state: "cold_start", stablePrefixMessages: 0 },
    },
    {
      requestId: "request-compat-sse",
      path: "compat",
      mode: null,
      inModel: "oneportal/executor-model",
      outModel: "oneportal/executor-model",
      provider: "oneportal",
      stream: true,
      status: 200,
      outcome: "completed",
      cacheCohort: { state: "cold_start", stablePrefixMessages: 0 },
    },
  ]);
  logs.requests.forEach(assertTerminalTiming);
  assert.equal(requests[0].response.headers["content-type"], "application/json");
  assert.equal(requests[1].response.headers["content-type"], "text/event-stream");
});

test("request lifecycle telemetry records DeepSeek prompt cache counters", async () => {
  const fixture = await createPluginFixture({
    pluginConfig: { routeLog: true },
    coreClient: createPluginCoreClient({
      async requestMessage() {
        return message({
          content: [{ type: "text", text: "cached response" }],
          usage: {
            input_tokens: 120,
            output_tokens: 5,
            prompt_cache_hit_tokens: 80,
            prompt_cache_miss_tokens: 40,
          },
        });
      },
    }),
  });
  const response = createRecordingResponse();
  const logs = await captureAirkitLogs(() => fixture.messages.handler(
    createPluginRequest(Buffer.from(JSON.stringify({
      model: "oneportal/deepseek-v4-flash",
      messages: [{ role: "user", content: "reuse the stable prefix" }],
      tools: [{ type: "web_search_20260318", name: "web_search" }],
    })), { headers: { "x-request-id": "deepseek-cache-log" } }),
    response,
    fixture.helpers,
  ));

  assert.deepEqual(logs.requests[0].promptCache, {
    prompt_cache_hit_tokens: 80,
    prompt_cache_miss_tokens: 40,
    cache_read_input_tokens: 80,
    cache_creation_input_tokens: null,
    cache_miss_input_tokens: 40,
    hit_rate: 80 / 120,
  });
});

test("request lifecycle telemetry records GPT nested cache counters", async () => {
  const fixture = await createPluginFixture({
    pluginConfig: { routeLog: true },
    coreClient: createPluginCoreClient({
      async requestMessage() {
        return message({
          content: [{ type: "text", text: "cached GPT response" }],
          usage: {
            prompt_tokens: 200,
            prompt_tokens_details: { cached_tokens: 150 },
            completion_tokens: 7,
          },
        });
      },
    }),
  });
  const logs = await captureAirkitLogs(() => fixture.messages.handler(
    createPluginRequest(Buffer.from(JSON.stringify({
      model: "oneportal/gpt-5.6-sol",
      messages: [{ role: "user", content: "reuse the stable prefix" }],
      tools: [{ type: "web_search_20260318", name: "web_search" }],
    })), { headers: { "x-request-id": "gpt-cache-log" } }),
    createRecordingResponse(),
    fixture.helpers,
  ));

  assert.deepEqual(logs.requests[0].promptCache, {
    prompt_cache_hit_tokens: 150,
    prompt_cache_miss_tokens: 50,
    cache_read_input_tokens: 150,
    cache_creation_input_tokens: null,
    cache_miss_input_tokens: 50,
    hit_rate: 150 / 200,
  });
});

test("request lifecycle telemetry treats GPT Anthropic-shaped input as total prompt tokens", async () => {
  const fixture = await createPluginFixture({
    pluginConfig: { routeLog: true },
    coreClient: createPluginCoreClient({
      async requestMessage() {
        return message({
          content: [{ type: "text", text: "cached GPT response" }],
          model: "oneportal/gpt-5.6-sol",
          usage: {
            input_tokens: 25_102,
            cache_read_input_tokens: 19_712,
            output_tokens: 196,
          },
        });
      },
    }),
  });
  const logs = await captureAirkitLogs(() => fixture.messages.handler(
    createPluginRequest(Buffer.from(JSON.stringify({
      model: "oneportal/gpt-5.6-sol",
      messages: [{ role: "user", content: "reuse the stable prefix" }],
      tools: [{ type: "web_search_20260318", name: "web_search" }],
    })), { headers: { "x-request-id": "gpt-anthropic-shaped-cache-log" } }),
    createRecordingResponse(),
    fixture.helpers,
  ));

  assert.equal(logs.requests[0].promptCache.prompt_cache_miss_tokens, 5_390);
  assert.equal(logs.requests[0].promptCache.hit_rate, 19_712 / 25_102);
});

test("raw request telemetry records gateway cache counters without changing bytes", async () => {
  const raw = Buffer.from(JSON.stringify({
    model: "oneportal/deepseek-v4-flash",
    messages: [
      { role: "user", content: "history" },
      { role: "user", content: "tail" },
    ],
  }));
  const fixture = await createPluginFixture({
    pluginConfig: { routeLog: true },
    coreClient: createPluginCoreClient({
      async forwardRaw({ body, response, onResponse }) {
        assert.deepEqual(body, raw);
        onResponse?.({
          headers: new Headers({
            "x-gateway-billing-cache-read-tokens": "150",
            "x-gateway-billing-cache-write-tokens": "0",
            "x-gateway-billing-input-tokens": "200",
          }),
        });
        response.writeHead(200, { "content-type": "application/json" });
        response.end("{}");
      },
    }),
  });
  const logs = await captureAirkitLogs(() => fixture.messages.handler(
    createPluginRequest(raw, { headers: { "x-request-id": "raw-cache-log" } }),
    createRecordingResponse(),
    fixture.helpers,
  ));

  assert.deepEqual(logs.requests[0].promptCache, {
    prompt_cache_hit_tokens: 150,
    prompt_cache_miss_tokens: 50,
    cache_read_input_tokens: 150,
    cache_creation_input_tokens: 0,
    cache_miss_input_tokens: 50,
    hit_rate: 150 / 200,
    source: "gateway-response-header",
  });
  assert.deepEqual(logs.requests[0].cacheCohort, {
    state: "reusable_prefix_hit",
    stablePrefixMessages: 1,
  });
});

test("request lifecycle telemetry waits for SSE response finish before emitting completion", async () => {
  const fixture = await createPluginFixture({
    pluginConfig: { routeLog: true },
    coreClient: createPluginCoreClient({
      async requestMessage() {
        return message({ content: [{ type: "text", text: "streamed" }] });
      },
    }),
  });
  const response = createRecordingResponse({ endEvent: null });
  const body = Buffer.from(JSON.stringify({
    ...compatibilityRequestBody(true),
    model: "oneportal/executor-model",
  }));
  let handlerSettled = false;

  const logs = await captureAirkitLogs(async (snapshot) => {
    const pending = fixture.messages.handler(
      createPluginRequest(body, {
        headers: { "x-request-id": "request-deferred-sse-finish" },
      }),
      response,
      fixture.helpers,
    ).finally(() => {
      handlerSettled = true;
    });
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(response.ended, true, "the SSE writer has called end");
    assert.equal(handlerSettled, false, "the route handler still awaits response finish");
    assert.equal(snapshot().requests.length, 0, "completion is not logged before finish");

    response.emit("finish");
    await pending;
  });

  assert.equal(logs.requests.length, 1);
  assert.equal(logs.requests[0].status, 200);
  assert.equal(logs.requests[0].outcome, "completed");
});

test("request lifecycle telemetry preserves a raw upstream 429 as a completed response", async () => {
  const fixture = await createPluginFixture({
    pluginConfig: { routeLog: true },
    coreClient: createPluginCoreClient({
      async forwardRaw({ response }) {
        response.writeHead(429, { "content-type": "application/json" });
        response.end('{"error":"rate_limited"}');
      },
    }),
  });
  const response = createRecordingResponse();
  const logs = await captureAirkitLogs(() => fixture.messages.handler(
    createPluginRequest(Buffer.from(JSON.stringify({ model: "oneportal/model", messages: [] })), {
      headers: { "x-request-id": "request-rate-limited" },
    }),
    response,
    fixture.helpers,
  ));

  assert.equal(response.statusCode, 429);
  assert.equal(logs.requests.length, 1);
  assert.equal(logs.requests[0].status, 429);
  assert.equal(logs.requests[0].outcome, "completed");
});

test("request lifecycle telemetry records synchronous forwarding failures without secrets", async () => {
  const fixture = await createPluginFixture({
    pluginConfig: { routeLog: true },
    coreClient: createPluginCoreClient({
      forwardRaw() {
        throw new Error("upstream-error-secret");
      },
    }),
  });
  const response = createRecordingResponse();
  const unsafeRequestId = "private credential value";
  const logs = await captureAirkitLogs(() => fixture.messages.handler(
    createPluginRequest(Buffer.from(JSON.stringify({ model: "oneportal/model", messages: [] })), {
      headers: {
        authorization: "Bearer forwarding-auth-secret",
        "x-request-id": unsafeRequestId,
      },
    }),
    response,
    fixture.helpers,
  ));

  assert.equal(response.statusCode, 502);
  assert.equal(logs.routes.length, 1);
  assert.equal(logs.requests.length, 1);
  assert.equal(logs.requests[0].requestId, logs.routes[0].requestId);
  assert.notEqual(logs.requests[0].requestId, unsafeRequestId);
  assert.match(logs.requests[0].requestId, /^[A-Za-z0-9._:-]+$/);
  assert.equal(logs.requests[0].status, 502);
  assert.equal(logs.requests[0].outcome, "forwarding_failed");
  assert.doesNotMatch(logs.raw, /upstream-error-secret|forwarding-auth-secret|private credential/);
});

test("request lifecycle telemetry records an aborted client once with no response status", async () => {
  let releaseForward;
  const forwardGate = new Promise((resolve) => {
    releaseForward = resolve;
  });
  const fixture = await createPluginFixture({
    pluginConfig: { routeLog: true },
    coreClient: createPluginCoreClient({
      async forwardRaw({ signal }) {
        await forwardGate;
        assert.equal(signal.aborted, true);
      },
    }),
  });
  const response = createRecordingResponse();
  const logsPromise = captureAirkitLogs(async () => {
    const pending = fixture.messages.handler(
      createPluginRequest(Buffer.from(JSON.stringify({ model: "oneportal/model", messages: [] })), {
        headers: { "x-request-id": "request-client-abort" },
      }),
      response,
      fixture.helpers,
    );
    await new Promise((resolve) => setImmediate(resolve));
    response.emit("close");
    releaseForward();
    await pending;
  });
  const logs = await logsPromise;

  assert.equal(logs.requests.length, 1, "close and handler settlement share one terminal record");
  assert.equal(logs.requests[0].status, null);
  assert.equal(logs.requests[0].outcome, "client_aborted");
});

test("request lifecycle telemetry retains a committed status when the client aborts", async () => {
  let releaseForward;
  const forwardGate = new Promise((resolve) => {
    releaseForward = resolve;
  });
  const fixture = await createPluginFixture({
    pluginConfig: { routeLog: true },
    coreClient: createPluginCoreClient({
      async forwardRaw({ response, signal }) {
        response.writeHead(206, { "content-type": "application/json" });
        await forwardGate;
        assert.equal(signal.aborted, true);
      },
    }),
  });
  const response = createRecordingResponse({ endEvent: null });
  const logs = await captureAirkitLogs(async () => {
    const pending = fixture.messages.handler(
      createPluginRequest(Buffer.from(JSON.stringify({ model: "oneportal/model", messages: [] })), {
        headers: { "x-request-id": "request-committed-abort" },
      }),
      response,
      fixture.helpers,
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(response.headersSent, true);
    response.emit("close");
    releaseForward();
    await pending;
  });

  assert.equal(logs.requests.length, 1);
  assert.equal(logs.requests[0].status, 206);
  assert.equal(logs.requests[0].outcome, "client_aborted");
});

test("request lifecycle telemetry distinguishes a destroyed response from forwarding failure", async () => {
  let destroyedWith;
  const fixture = await createPluginFixture({
    pluginConfig: { routeLog: true },
    coreClient: createPluginCoreClient({
      async forwardRaw({ response }) {
        response.statusCode = 207;
        response.headersSent = true;
        throw new Error("destroyed-response-secret");
      },
    }),
  });
  const response = Object.assign(createRecordingResponse(), {
    destroy(error) {
      destroyedWith = error;
    },
  });
  const logs = await captureAirkitLogs(() => fixture.messages.handler(
    createPluginRequest(Buffer.from(JSON.stringify({ model: "oneportal/model", messages: [] })), {
      headers: { "x-request-id": "request-response-destroyed" },
    }),
    response,
    fixture.helpers,
  ));

  assert.match(destroyedWith.message, /destroyed-response-secret/);
  assert.equal(logs.requests.length, 1);
  assert.equal(logs.requests[0].status, 207);
  assert.equal(logs.requests[0].outcome, "response_destroyed");
  assert.doesNotMatch(logs.raw, /destroyed-response-secret/);
});

async function captureAirkitLogs(run) {
  const chunks = [];
  const original = process.stderr.write;
  process.stderr.write = (chunk) => {
    chunks.push(String(chunk));
    return true;
  };
  try {
    await run(() => parseCapturedAirkitLogs(chunks));
  } finally {
    process.stderr.write = original;
  }
  return parseCapturedAirkitLogs(chunks);
}

function parseCapturedAirkitLogs(chunks) {
  const raw = chunks.join("");
  const parse = (prefix) => chunks
    .filter((line) => line.startsWith(prefix))
    .map((line) => JSON.parse(line.slice(prefix.length)));
  return {
    raw,
    requests: parse("[airkit-request] "),
    routes: parse("[airkit-route] "),
  };
}

function withoutTiming(entry) {
  const { at, durationMs, ...stable } = entry;
  return stable;
}

function assertTerminalTiming(entry) {
  assert.equal(Number.isNaN(Date.parse(entry.at)), false);
  assert.equal(typeof entry.durationMs, "number");
  assert.equal(Number.isFinite(entry.durationMs), true);
  assert.ok(entry.durationMs >= 0);
}

test("the caller's mode label selects its route table for main and background traffic", async () => {
  const forwarded = [];
  const pluginConfig = {
    ...structuredClone(COMPLETE_PLUGIN_CONFIG),
    routeLog: true,
    routes: { default: "demo-provider/steady-coder", background: "demo-provider/cheap-coder" },
    modeRoutes: {
      glm: { default: "demo-provider/glm-coder", background: "demo-provider/glm-mini" },
    },
  };
  const handlers = await createPluginHandlers({
    coreClient: {
      async forwardRaw({ body }) {
        forwarded.push(Buffer.from(body));
      },
    },
    pluginConfig,
  });
  const handler = handlers.messages.handler;
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
  assert.equal(await invoke("claude-sonnet-5", labelled), "demo-provider/glm-coder");
  assert.equal(await invoke("claude-haiku-4-5-20251001", labelled), "demo-provider/glm-mini");
  assert.equal(
    await invoke("claude-sonnet-5", { "x-airkit-mode": "unconfigured" }),
    "demo-provider/steady-coder",
    "an unknown mode still routes through the flat table",
  );
  assert.equal(await invoke("claude-sonnet-5", {}), "demo-provider/steady-coder");

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

test("mode effort applies to the Sonnet lane while explicit effort wins", async () => {
  const forwarded = [];
  const handlers = await createPluginHandlers({
    coreClient: {
      async forwardRaw({ body }) {
        forwarded.push(JSON.parse(body.toString("utf8")));
      },
    },
    pluginConfig: {
      ...structuredClone(COMPLETE_PLUGIN_CONFIG),
      launchModel: "claude-airkit-mode",
      routes: { default: "demo-provider/default", sonnet: "oneportal/gpt-5.6-luna" },
      modeRoutes: {
        glm: { default: "oneportal/GLM-5.2", sonnet: "oneportal/gpt-5.6-luna" },
      },
      modeEffort: { glm: "xhigh" },
    },
  });
  const handler = handlers.messages.handler;
  const invoke = async (body) => {
    await handler(
      createPluginRequest(Buffer.from(JSON.stringify(body)), { headers: { "x-airkit-mode": "glm" } }),
      createRecordingResponse(),
      { readBody: async (request) => request.body },
    );
    return forwarded.at(-1);
  };

  assert.deepEqual(
    await invoke({ model: "claude-sonnet-5", messages: [] }),
    { model: "oneportal/gpt-5.6-luna", reasoning_effort: "xhigh", messages: [] },
  );
  assert.deepEqual(
    await invoke({ model: "claude-sonnet-5", output_config: { effort: "max" }, messages: [] }),
    { model: "oneportal/gpt-5.6-luna", reasoning_effort: "max", messages: [] },
  );
  assert.deepEqual(
    await invoke({ model: "claude-airkit-mode", messages: [] }),
    { model: "oneportal/GLM-5.2", messages: [] },
    "the mode default is lane-specific and does not alter the default route",
  );
});

test("the launcher's own model id routes separately from an in-session Sonnet pick", async () => {
  const forwarded = [];
  const pluginConfig = {
    ...structuredClone(COMPLETE_PLUGIN_CONFIG),
    launchModel: "claude-airkit-mode",
    routes: {
      default: "demo-provider/steady-coder",
      background: "demo-provider/cheap-coder",
      sonnet: "demo-provider/real-sonnet",
    },
    modeRoutes: {
      glm: {
        default: "demo-provider/glm-coder",
        background: "demo-provider/glm-mini",
        sonnet: "demo-provider/real-sonnet",
      },
    },
  };
  const handlers = await createPluginHandlers({
    coreClient: {
      async forwardRaw({ body }) {
        forwarded.push(Buffer.from(body));
      },
    },
    pluginConfig,
  });
  const handler = handlers.messages.handler;
  const invoke = async (model, headers) => {
    const raw = Buffer.from(JSON.stringify({ model, max_tokens: 8, messages: [] }), "utf8");
    await handler({ headers, method: "POST", signal: undefined }, {}, { readBody: async () => raw });
    return JSON.parse(forwarded.at(-1).toString()).model;
  };

  const glm = { "x-airkit-mode": "glm" };
  assert.equal(await invoke("claude-airkit-mode", glm), "demo-provider/glm-coder");
  assert.equal(await invoke("claude-sonnet-5", glm), "demo-provider/real-sonnet");
  assert.equal(await invoke("claude-haiku-4-5-20251001", glm), "demo-provider/glm-mini");
  assert.equal(await invoke("claude-airkit-mode", {}), "demo-provider/steady-coder");
  assert.equal(await invoke("claude-sonnet-5", {}), "demo-provider/real-sonnet");
});

test("bare Claude routing without routes config forwards byte-identical bytes", async () => {
  const forwarded = [];
  const handlers = await createPluginHandlers({
    coreClient: {
      async forwardRaw({ body }) {
        forwarded.push(Buffer.from(body));
      },
    },
    pluginConfig: structuredClone(COMPLETE_PLUGIN_CONFIG),
  });
  const handler = handlers.messages.handler;
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
