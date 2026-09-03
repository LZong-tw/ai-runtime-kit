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
            return { rows: operation === "shield_decisions" ? [{ logical_request_id: "shield-request-1", raw_prompt: "must-not-render" }] : [] };
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
    assert.match(pageResponse.body(), /shield_decisions/);
    assert.match(pageResponse.body(), /shield_policy_transitions/);
    assert.doesNotMatch(pageResponse.body(), /api[_-]?key|authorization|bearer|secret|\/Users\//i);
    const sessionCookie = pageResponse.headers["set-cookie"].split(";", 1)[0];
    const shieldQuery = responseRecorder();
    await backends[0].handler(
      { method: "GET", url: "/api/query?name=shield_decisions", headers: { cookie: sessionCookie } },
      shieldQuery,
    );
    assert.equal(shieldQuery.statusCode, 200);
    assert.deepEqual(operations, ["shield_decisions"]);
    assert.doesNotMatch(shieldQuery.body(), /must-not-render/);
    const rawDetail = responseRecorder();
    await backends[0].handler(
      { method: "GET", url: "/api/query?name=shield_decision&id=https%3A%2F%2Fprivate.invalid%2Frequest", headers: { cookie: sessionCookie } },
      rawDetail,
    );
    assert.equal(rawDetail.statusCode, 200);
    assert.match(rawDetail.body(), /invalid_query_arguments/);
    assert.deepEqual(operations, ["shield_decisions"]);
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
