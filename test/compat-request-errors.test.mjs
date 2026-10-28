import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { createCoreClient, createGatewayClient } from "../src/compat/gateway.mjs";
import { startCompatibilityMiddleware } from "../src/compat/middleware.mjs";
import { openRequestErrorStore, serializeError } from "../src/compat/request-errors.mjs";
import {
  COMPLETE_PLUGIN_CONFIG, createCoreFixture, createPluginCoreClient, createPluginFixture,
  createPluginRequest, createRecordingResponse,
} from "./helpers/compat-fixtures.mjs";
import { compatLog, formatCompatLine } from "../src/compat/diagnostics.mjs";

const DAY = 86_400_000;
const ordinaryBody = { model: "executor", messages: [] };
const compatBody = {
  model: "executor-model", messages: [{ role: "user", content: "Find tools" }],
  tools: [
    { type: "tool_search_tool_regex_20251119", name: "tool_search_tool_regex" },
    { name: "weather", defer_loading: true, input_schema: { type: "object", properties: {} } },
  ],
};

function tempDir(t) {
  // Keep all test filesystem changes inside the checkout, not the real home.
  const dir = mkdtempSync(join(process.cwd(), ".compat-errors-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function database(t, options = {}) {
  const dir = tempDir(t);
  const path = join(dir, "state", "requests.sqlite");
  const store = openRequestErrorStore({ path, ...options });
  const db = new DatabaseSync(path, { readOnly: true });
  t.after(() => { db.close(); store.close(); });
  return {
    dir, path, store, db,
    rows: () => db.prepare("SELECT * FROM compat_requests ORDER BY at, request_id").all(),
  };
}

async function invoke({ store, coreClient, body = ordinaryBody, headers = {}, pluginConfig }) {
  const fixture = await createPluginFixture({ coreClient, requestStore: store, pluginConfig });
  const request = createPluginRequest(Buffer.from(JSON.stringify(body)), { headers });
  const response = createRecordingResponse();
  await fixture.messages.handler(request, response, fixture.helpers);
  return response;
}

function assertTimings(row) {
  for (const key of ["received_to_upstream_ms", "upstream_first_byte_ms", "total_ms", "transform_ms"]) {
    assert.ok(Number.isFinite(row[key]) && row[key] >= 0, `${key}: ${row[key]}`);
  }
  assert.ok(row.upstream_first_byte_ms <= row.total_ms);
  assert.ok(row.transform_ms <= row.received_to_upstream_ms);
}

test("forwardRaw failure preserves real error/cause and returns a correlated public request ID", async (t) => {
  const { store, rows } = database(t);
  const cause = Object.assign(new Error("ECONNRESET"), { code: "ECONNRESET" });
  const response = await invoke({
    store,
    headers: { "x-request-id": "unsafe request id" },
    coreClient: createPluginCoreClient({
      async forwardRaw() { throw new Error("core connection lost", { cause }); },
    }),
  });
  assert.equal(response.statusCode, 502);
  const error = JSON.parse(response.body).error;
  assert.equal(error.message, "compatibility forwarding failed");
  assert.equal(error.type, "api_error");
  assert.match(error.request_id, /^[a-f0-9-]{36}$/);
  assert.equal(error.request_id, response.headers["x-airkit-request-id"]);
  const [row] = rows();
  assert.equal(rows().length, 1);
  assert.equal(row.request_id, error.request_id);
  assert.equal(row.kind, "error");
  assert.equal(row.client_status, 502);
  const evidence = JSON.parse(row.error_json);
  assert.equal(evidence.message, "core connection lost");
  assert.deepEqual(evidence.causes, [{ name: "Error", message: "ECONNRESET", code: "ECONNRESET" }]);
  assert.ok(Number.isFinite(row.total_ms));
});

for (const clientType of ["core", "gateway"]) {
  test(`${clientType} compat 400 stores bounded body evidence, strips auth headers, and redacts body credential values`, async (t) => {
    const { store, rows } = database(t);
    const fetchImpl = async () => new Response(
      'upstream rejected: Bearer secrettoken123 and sk-abcdefghijk123',
      { status: 400, headers: { authorization: "private-response-token", "x-request-id": "upstream-400" } },
    );
    const core = await createCoreFixture(t);
    const coreClient = clientType === "core"
      ? createCoreClient({ ...core.options, fetchImpl })
      : createGatewayClient({ origin: `http://127.0.0.1:${core.port}`, token: "fixture-key", fetchImpl });
    const response = await invoke({ store, coreClient, body: compatBody });
    assert.equal(response.statusCode, 400);
    assert.equal(response.headers["x-request-id"], "upstream-400");
    const publicError = JSON.parse(response.body).error;
    assert.equal(publicError.message, "Upstream provider rejected the request");
    assert.equal(publicError.request_id, response.headers["x-airkit-request-id"]);
    const [row] = rows();
    assert.equal(row.kind, "error");
    assert.equal(row.upstream_status, 400);
    const evidence = JSON.parse(row.error_json);
    assert.equal(evidence.status, 400);
    assert.equal(evidence.upstreamBody, "[redacted]");
    assert.ok(evidence.causes.some((cause) => cause.message === "CCR upstream rejected the Messages request"));
    assert.equal(evidence.headers.authorization, undefined);
    assert.equal(evidence.headers["x-request-id"], "upstream-400");
    assert.doesNotMatch(row.error_json, /secrettoken123|sk-abcdefghijk123|private-response-token/);
    assertTimings(row);
  });
}

test("clean upstream error text survives serialization through requestCoreMessage", async (t) => {
  const { store, rows } = database(t);
  const core = await createCoreFixture(t);
  const coreClient = createCoreClient({
    ...core.options,
    fetchImpl: async () => new Response('{"error":{"message":"model not available"}}', { status: 400 }),
  });
  await invoke({ store, coreClient, body: compatBody });
  assert.equal(JSON.parse(rows()[0].error_json).upstreamBody, '{"error":{"message":"model not available"}}');
});

test("error bodies over 64 KiB are UTF-8 safely truncated, including client-captured bodies", async (t) => {
  const body = "x" + "😀".repeat(20_000);
  const serialized = serializeError(new Error("large response"), { upstreamBody: body });
  assert.equal(serialized.upstreamBodyTruncated, true);
  assert.ok(Buffer.byteLength(serialized.upstreamBody) <= 65_536);
  assert.ok(body.startsWith(serialized.upstreamBody));
  assert.doesNotMatch(serialized.upstreamBody, /\ufffd/);
  const { store, rows } = database(t);
  const core = await createCoreFixture(t);
  await invoke({
    store, body: compatBody,
    coreClient: createCoreClient({ ...core.options, fetchImpl: async () => new Response(body, { status: 400 }) }),
  });
  const evidence = JSON.parse(rows()[0].error_json);
  assert.equal(evidence.upstreamBodyTruncated, true);
  assert.ok(Buffer.byteLength(evidence.upstreamBody) <= 65_536);
  assert.ok(body.startsWith(evidence.upstreamBody));
});

test("successful passthrough records finite per-request timings and preserves bytes", async (t) => {
  const { store, rows } = database(t);
  const core = await createCoreFixture(t);
  const response = await invoke({ store, coreClient: createCoreClient(core.options) });
  assert.equal(response.statusCode, 202);
  assert.deepEqual(response.body, core.rawResponseBody);
  const [row] = rows();
  assert.equal(row.kind, "success");
  assert.match(row.request_id, /^[a-f0-9-]{36}$/);
  assert.equal(response.headers["x-airkit-request-id"], row.request_id);
  assert.equal(row.upstream_status, 202);
  assert.equal(row.in_model, "executor");
  assert.equal(row.out_model, "executor");
  assert.equal(row.path, "passthrough");
  assert.equal(row.error_json, null);
  assertTimings(row);
});

test("compat first-byte timing is captured before the response body is parsed", async (t) => {
  const { store, rows } = database(t);
  const core = await createCoreFixture(t);
  const response = await invoke({
    store, body: compatBody,
    coreClient: createCoreClient({
      ...core.options,
      fetchImpl: async () => ({
        status: 200, headers: new Headers(),
        async json() {
          await new Promise((resolve) => setTimeout(resolve, 25));
          return { type: "message", content: [], usage: {} };
        },
      }),
    }),
  });
  assert.equal(response.statusCode, 200);
  const [row] = rows();
  assertTimings(row);
  assert.ok(row.total_ms - row.upstream_first_byte_ms >= 20);
});

test("fallback rejection stores body/families and terminal timings without changing client bytes", async (t) => {
  const { store, rows } = database(t);
  const original = Buffer.from(' {"type":"error","error":{"message":"tool unavailable"}}\n');
  const logs = [];
  t.mock.method(compatLog, "write", (tag, record) => { logs.push(formatCompatLine(tag, record)); });
  const response = await invoke({
    store,
    body: { ...ordinaryBody, tools: [{ type: "code_execution_20260521", name: "code_execution" }] },
    pluginConfig: { routeLog: true },
    coreClient: createPluginCoreClient({
      async requestFallback() {
        return new Response(original, { status: 403, headers: { "content-type": "application/json", "x-api-key": "private" } });
      },
    }),
  });
  assert.equal(response.statusCode, 403);
  assert.deepEqual(response.body, original);
  assert.equal(rows().length, 1);
  const [row] = rows();
  assert.equal(row.kind, "fallback_error");
  assert.equal(row.upstream_status, 403);
  assert.equal(row.client_status, 403);
  assert.equal(row.out_model, "anthropic-messages/claude-sonnet");
  const evidence = JSON.parse(row.error_json);
  assert.equal(evidence.status, 403);
  assert.equal(evidence.upstreamBody, original.toString());
  assert.deepEqual(evidence.families, ["codeExecution"]);
  assert.equal(evidence.headers["x-api-key"], undefined);
  assertTimings(row);
  const log = JSON.parse(logs.find((line) => line.startsWith("[airkit-fallback] ")).slice("[airkit-fallback] ".length));
  assert.equal(log.requestId, row.request_id);
});

test("large fallback rejection is relayed in full while only a bounded prefix is persisted", async (t) => {
  const { store, rows } = database(t);
  const original = Buffer.from("😀".repeat(20_000));
  const response = await invoke({
    store,
    body: { ...ordinaryBody, tools: [{ type: "code_execution_20260521", name: "code_execution" }] },
    coreClient: createPluginCoreClient({ async requestFallback() { return new Response(original, { status: 400 }); } }),
  });
  assert.deepEqual(response.body, original);
  const [row] = rows();
  assert.equal(row.kind, "fallback_error");
  const evidence = JSON.parse(row.error_json);
  assert.equal(evidence.upstreamBodyTruncated, true);
  assert.ok(Buffer.byteLength(evidence.upstreamBody) <= 65_536);
  assert.ok(original.toString().startsWith(evidence.upstreamBody));
});

test("empty fallback rejections also retain upstream status and evidence", async (t) => {
  const { store, rows } = database(t);
  const response = await invoke({
    store,
    body: { ...ordinaryBody, tools: [{ type: "code_execution_20260521", name: "code_execution" }] },
    coreClient: createPluginCoreClient({ async requestFallback() { return new Response(null, { status: 403 }); } }),
  });
  assert.equal(response.statusCode, 403);
  assert.equal(response.body.length, 0);
  const [row] = rows();
  assert.equal(row.kind, "fallback_error");
  assert.equal(JSON.parse(row.error_json).upstreamBody, "");
  assertTimings(row);
});

test("raw upstream rejection preserves bytes and the authoritative AirKit request ID", async (t) => {
  const { store, rows } = database(t);
  const core = await createCoreFixture(t);
  const original = "raw upstream error text";
  const response = await invoke({
    store,
    coreClient: createCoreClient({
      ...core.options,
      fetchImpl: async () => new Response(original, { status: 400, headers: { "x-airkit-request-id": "not-our-id" } }),
    }),
  });
  assert.equal(response.body.toString(), original);
  const [row] = rows();
  assert.equal(response.headers["x-airkit-request-id"], row.request_id);
  assert.equal(row.kind, "error");
  assert.equal(JSON.parse(row.error_json).upstreamBody, original);
  assertTimings(row);
});

test("prune retains errors for 30 days and successes for 7 days, including pruning at open", (t) => {
  const now = 2_000_000_000_000;
  const { store, rows, path } = database(t, { now: () => now });
  for (const [id, kind, age] of [
    ["old-error", "error", 31], ["old-fallback", "fallback_error", 31], ["old-success", "success", 8],
    ["recent-error", "error", 29], ["recent-fallback", "fallback_error", 29], ["recent-success", "success", 6],
  ]) store.record({ request_id: id, kind, at: now - age * DAY });
  assert.equal(rows().length, 6);
  store.close();
  const reopened = openRequestErrorStore({ path, now: () => now });
  t.after(() => reopened.close());
  assert.deepEqual(rows().map((row) => row.request_id).sort(), ["recent-error", "recent-fallback", "recent-success"]);
  reopened.prune();
  assert.equal(rows().length, 3);
});

test("record triggers pruning at most hourly", (t) => {
  let now = 2_000_000_000_000;
  const { store, rows } = database(t, { now: () => now });
  store.record({ request_id: "expired", kind: "error", at: now - 31 * DAY });
  now += 60 * 60 * 1000 - 1;
  store.record({ request_id: "before-hour", kind: "success" });
  assert.equal(rows().length, 2);
  now += 1;
  store.record({ request_id: "at-hour", kind: "success" });
  assert.deepEqual(rows().map((row) => row.request_id), ["before-hour", "at-hour"]);
});

test("file-as-directory open failure and throwing injected stores do not break requests", async (t) => {
  const dir = tempDir(t);
  const file = join(dir, "not-a-directory");
  writeFileSync(file, "blocker");
  const failedStore = openRequestErrorStore({ path: join(file, "requests.sqlite") });
  for (const store of [failedStore, { record() { throw new Error("disk failed"); } }]) {
    const response = await invoke({
      store, coreClient: createPluginCoreClient({ async forwardRaw() { throw new Error("core connection lost"); } }),
    });
    assert.equal(response.statusCode, 502);
    assert.equal(JSON.parse(response.body).error.message, "compatibility forwarding failed");
    assert.ok(response.headers["x-airkit-request-id"]);
  }
  const core = await createCoreFixture(t);
  const success = await invoke({ store: failedStore, coreClient: createCoreClient(core.options) });
  assert.equal(success.statusCode, 202);
  assert.deepEqual(success.body, core.rawResponseBody);
  assert.doesNotThrow(() => { failedStore.record({}); failedStore.prune(); failedStore.close(); });
});

test("default store path follows XDG/HOME and files are private; closed methods never throw", (t) => {
  const dir = tempDir(t);
  for (const env of [{ XDG_STATE_HOME: join(dir, "xdg") }, { HOME: join(dir, "home") }]) {
    const root = env.XDG_STATE_HOME ?? join(env.HOME, ".local", "state");
    const store = openRequestErrorStore({ env });
    const path = join(root, "airkit", "compat-requests.sqlite");
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(statSync(join(root, "airkit")).mode & 0o777, 0o700);
    store.close();
    assert.doesNotThrow(() => { store.record({}); store.prune(); store.close(); });
  }
});

test("serialization removes sensitive record and Headers keys and caps cause depth", () => {
  let error = new Error("root");
  for (let i = 0; i < 8; i += 1) error = new Error(`cause-${i}`, { cause: error });
  for (const headers of [
    { Authorization: "hidden", "Proxy-Authorization": "hidden", Cookie: "hidden", "Set-Cookie": "hidden", "X-Api-Key": "hidden", "X-Ccr-Core-Auth": "hidden", "x-visible": "kept" },
    new Headers({ authorization: "hidden", cookie: "hidden", "set-cookie": "hidden", "x-api-key": "hidden", "x-ccr-core-auth": "hidden", "proxy-authorization": "hidden", "x-visible": "kept" }),
  ]) {
    error.headers = headers;
    const evidence = serializeError(error);
    assert.deepEqual(evidence.headers, { "x-visible": "kept" });
    assert.equal(evidence.causes.length, 5);
  }
  for (const body of ["Bearer secrettoken123", "sk-abcdefghijk123"]) {
    assert.equal(serializeError(error, { upstreamBody: body }).upstreamBody, "[redacted]");
  }
});

test("MCP contained failure returns request ID and stores original error", async (t) => {
  const { store, rows } = database(t);
  const fixture = await createPluginFixture({ requestStore: store });
  const response = createRecordingResponse();
  await fixture.mcp.handler(createPluginRequest(Buffer.alloc(0)), response, {
    async readBody() { throw new Error("MCP body read failed"); },
  });
  assert.equal(response.statusCode, 502);
  assert.equal(JSON.parse(response.body).error.request_id, response.headers["x-airkit-request-id"]);
  assert.equal(rows()[0].kind, "error");
  assert.equal(JSON.parse(rows()[0].error_json).message, "MCP body read failed");
});

test("middleware accepts an injected store and returns the request ID without touching HOME", async (t) => {
  const { store, rows } = database(t);
  const core = await createCoreFixture(t);
  const middleware = await startCompatibilityMiddleware({
    compatibility: COMPLETE_PLUGIN_CONFIG, requestStore: store,
    gatewayOrigin: `http://127.0.0.1:${core.port}`, gatewayToken: "fixture-key",
  });
  t.after(() => middleware.close());
  const response = await fetch(`${middleware.origin}/v1/messages`, {
    method: "POST", headers: { "x-api-key": "fixture-key", "content-type": "application/json", "x-request-id": "middleware-request" },
    body: JSON.stringify({ model: "claude-sonnet", messages: [] }),
  });
  const airkitRequestId = response.headers.get("x-airkit-request-id");
  assert.match(airkitRequestId, /^[a-f0-9-]{36}$/);
  assert.deepEqual(await response.json(), { type: "message", content: [] });
  assert.equal(rows()[0].request_id, airkitRequestId);
});

test("a reused client x-request-id never merges two requests into one stored row", async (t) => {
  const { store, rows } = database(t);
  const headers = { "x-request-id": "client-reused-id" };
  const failed = await invoke({
    store, headers,
    coreClient: createPluginCoreClient({ async forwardRaw() { throw new Error("first attempt lost"); } }),
  });
  const succeeded = await invoke({
    store, headers,
    coreClient: createPluginCoreClient({
      async forwardRaw({ response, onResponse }) {
        onResponse?.({ headers: new Headers(), status: 200, error: null });
        response.writeHead(200, { "content-type": "application/json" });
        response.end("{}");
      },
    }),
  });
  const ids = [failed, succeeded].map((response) => response.headers["x-airkit-request-id"]);
  assert.notEqual(ids[0], ids[1]);
  assert.equal(rows().length, 2);
  const errorRow = rows().find((row) => row.request_id === ids[0]);
  assert.equal(errorRow.kind, "error");
  assert.equal(JSON.parse(errorRow.error_json).message, "first attempt lost");
  assert.equal(rows().find((row) => row.request_id === ids[1]).kind, "success");
});
