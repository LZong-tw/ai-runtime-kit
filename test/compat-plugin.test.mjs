import assert from "node:assert/strict";
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
      traceparent: "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01",
      "user-agent": "fixture-agent",
      "x-api-key": "outer-key",
      "x-ccr-core-auth": "attacker-token",
      "x-ccr-extra": "attacker-value",
      "x-datadog-api-key": "trace-secret",
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

function createRecordingResponse() {
  const chunks = [];
  return {
    body: Buffer.alloc(0),
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
    },
    end(chunk) {
      if (chunk !== undefined) chunks.push(Buffer.from(chunk));
      this.body = Buffer.concat(chunks);
    },
  };
}
