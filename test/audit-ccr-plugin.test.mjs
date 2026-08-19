import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
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

test("CCR audit wrapper registers a gateway-authenticated app and metadata routes", async () => {
  const root = await mkdtemp("/tmp/airkit-ccr-plugin-");
  const apps = [];
  const routes = [];
  try {
    await plugin.setup({
      pluginConfig: {
        auditRootDir: root,
        auditQuerySocketPath: join(root, "auditd-query.sock"),
      },
      registerApp(app) { apps.push(app); },
      registerGatewayRoute(route) { routes.push(route); },
    });

    assert.equal(apps.length, 1);
    assert.equal(apps[0].id, "airkit-audit-ui");
    assert.equal(apps[0].url, "/plugins/airkit-audit");
    assert.equal(routes.length, 3);
    assert.deepEqual(routes.map((route) => route.auth), ["gateway", "gateway", "gateway"]);
    assert.deepEqual(routes.map((route) => route.methods ?? [route.method]), [
      ["GET"], ["GET"], ["GET"],
    ]);

    const pageResponse = responseRecorder();
    await routes[0].handler({}, pageResponse);
    assert.equal(pageResponse.statusCode, 200);
    assert.match(pageResponse.body(), /metadata-only local audit view/i);
    assert.doesNotMatch(pageResponse.body(), /api[_-]?key|authorization|bearer|secret|\/Users\//i);

    const statusResponse = responseRecorder();
    await routes[1].handler({}, statusResponse, {
      sendJson(response, status, body) {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(body));
      },
    });
    assert.equal(statusResponse.statusCode, 200);
    assert.equal(JSON.parse(statusResponse.body()).state, "degraded");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
