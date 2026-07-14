import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import { test } from "node:test";
import { createCoreClient } from "../src/compat/gateway.mjs";

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
