import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
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
  try {
    await plugin.setup({
      pluginConfig: {
        auditRootDir: root,
        auditQuerySocketPath: join(root, "auditd-query.sock"),
      },
      registerApp(app) { apps.push(app); },
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
    assert.doesNotMatch(pageResponse.body(), /api[_-]?key|authorization|bearer|secret|\/Users\//i);
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
