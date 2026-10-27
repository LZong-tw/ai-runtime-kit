import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import plugin from "../src/audit/ccr-plugin.mjs";

function responseRecorder() {
  const chunks = [];
  return {
    statusCode: null,
    headers: null,
    writeHead(statusCode, headers) {
      this.statusCode = statusCode;
      this.headers = headers;
    },
    end(body = "") {
      chunks.push(Buffer.from(body));
    },
    body() { return Buffer.concat(chunks).toString("utf8"); },
  };
}

test("CCR audit wrapper registers a browser backend and one-time bootstrap app", async () => {
  const root = await mkdtemp("/tmp/airkit-ccr-plugin-");
  const apps = [];
  const backends = [];
  const operations = [];
  try {
    await writeFile(join(root, "capability"), "c".repeat(32), { mode: 0o600 });
    await plugin.setup({
      pluginConfig: {
        auditRootDir: root,
        auditQuerySocketPath: join(root, "auditd-query.sock"),
      },
      registerApp(app) { apps.push(app); },
      createAuditQueryClient() {
        return {
          async query(operation) {
            operations.push(operation);
            return { rows: operation === "requests" ? [{ logical_request_id: "request-1", raw_prompt: "must-not-render" }] : [] };
          },
        };
      },
      async registerHttpBackend(backend) {
        backends.push(backend);
        return { host: backend.host, port: 4567, url: "http://127.0.0.1:4567" };
      },
    });

    assert.equal(apps.length, 1);
    assert.equal(apps[0].id, "airkit-audit");
    assert.match(apps[0].url, /^http:\/\/127\.0\.0\.1:4567\/\?bootstrap=/);
    const bootstrapPath = join(root, "ccr-ui-bootstrap-url");
    assert.equal(await readFile(bootstrapPath, "utf8"), `${apps[0].url}\n`);
    assert.equal((await stat(bootstrapPath)).mode & 0o777, 0o600);
    assert.equal(backends.length, 1);
    assert.equal(backends[0].id, "airkit-audit-ui");
    assert.equal(backends[0].host, "127.0.0.1");
    assert.equal(backends[0].port, 0);
    assert.equal(typeof backends[0].handler, "function");

    const bootstrap = new URL(apps[0].url).searchParams.get("bootstrap");
    assert.ok(bootstrap);
    const pageResponse = responseRecorder();
    await backends[0].handler(
      { method: "GET", url: `/?bootstrap=${encodeURIComponent(bootstrap)}`, headers: { host: "127.0.0.1:4567" } },
      pageResponse,
    );
    assert.equal(pageResponse.statusCode, 200);
    assert.match(pageResponse.headers["set-cookie"], /HttpOnly/i);
    assert.match(pageResponse.body(), /metadata-only local audit view/i);
    assert.match(pageResponse.body(), /requests/);
    assert.doesNotMatch(pageResponse.body(), /shield/i);
    assert.doesNotMatch(pageResponse.body(), /api[_-]?key|authorization|bearer|secret|\/Users\//i);
    const sessionCookie = pageResponse.headers["set-cookie"].split(";", 1)[0];
    const requestsQuery = responseRecorder();
    await backends[0].handler(
      { method: "GET", url: "/api/query?name=requests", headers: { cookie: sessionCookie } },
      requestsQuery,
    );
    assert.equal(requestsQuery.statusCode, 200);
    assert.deepEqual(operations, ["requests"]);
    assert.doesNotMatch(requestsQuery.body(), /must-not-render/);
    const retiredQuery = responseRecorder();
    await backends[0].handler(
      { method: "GET", url: "/api/query?name=shield_decisions", headers: { cookie: sessionCookie } },
      retiredQuery,
    );
    assert.equal(retiredQuery.statusCode, 200);
    assert.match(retiredQuery.body(), /unknown_query/);
    assert.deepEqual(operations, ["requests"]);
    await assert.rejects(readFile(bootstrapPath, "utf8"), { code: "ENOENT" });

    const replayResponse = responseRecorder();
    await backends[0].handler(
      { method: "GET", url: `/?bootstrap=${encodeURIComponent(bootstrap)}`, headers: { host: "127.0.0.1:4567" } },
      replayResponse,
    );
    assert.equal(replayResponse.statusCode, 410);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CCR audit control reissues one-time URLs only for its private token", async () => {
  const root = await mkdtemp("/tmp/airkit-ccr-control-");
  let app;
  let backend;
  try {
    await plugin.setup({
      pluginConfig: { auditRootDir: root },
      registerApp(value) { app = value; },
      async registerHttpBackend(value) {
        backend = value;
        return { url: "http://127.0.0.1:4567" };
      },
    });

    const controlPath = join(root, "ccr-ui-control.json");
    const control = JSON.parse(await readFile(controlPath, "utf8"));
    assert.equal((await stat(controlPath)).mode & 0o777, 0o600);
    assert.equal(control.origin, "http://127.0.0.1:4567");
    assert.match(control.token, /^[A-Za-z0-9_-]{32}$/);

    const unauthorized = responseRecorder();
    await backend.handler({ method: "POST", url: "/internal/bootstrap", headers: {} }, unauthorized);
    assert.equal(unauthorized.statusCode, 403);
    assert.equal(unauthorized.body().includes(control.token), false);

    const first = responseRecorder();
    await backend.handler({ method: "POST", url: "/internal/bootstrap", headers: { "x-airkit-audit-control": control.token } }, first);
    assert.equal(first.statusCode, 200);
    const firstUrl = JSON.parse(first.body()).url;
    assert.match(firstUrl, /^http:\/\/127\.0\.0\.1:4567\/\?bootstrap=/);

    const second = responseRecorder();
    await backend.handler({ method: "POST", url: "/internal/bootstrap", headers: { "x-airkit-audit-control": control.token } }, second);
    assert.equal(second.statusCode, 200);
    const secondUrl = JSON.parse(second.body()).url;
    assert.notEqual(secondUrl, firstUrl);
    assert.notEqual(secondUrl, app.url);

    const expired = responseRecorder();
    await backend.handler({ method: "GET", url: new URL(firstUrl).pathname + new URL(firstUrl).search, headers: {} }, expired);
    assert.equal(expired.statusCode, 410);

    const fresh = responseRecorder();
    await backend.handler({ method: "GET", url: new URL(secondUrl).pathname + new URL(secondUrl).search, headers: {} }, fresh);
    assert.equal(fresh.statusCode, 200);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CCR plugin stop removes its unpublished browser entry and control token", async () => {
  const root = await mkdtemp("/tmp/airkit-ccr-stop-");
  try {
    await plugin.setup({
      pluginConfig: { auditRootDir: root },
      registerApp() {},
      async registerHttpBackend() { return { url: "http://127.0.0.1:4567" }; },
    });
    await plugin.stop();
    await assert.rejects(readFile(join(root, "ccr-ui-bootstrap-url"), "utf8"), { code: "ENOENT" });
    await assert.rejects(readFile(join(root, "ccr-ui-control.json"), "utf8"), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
