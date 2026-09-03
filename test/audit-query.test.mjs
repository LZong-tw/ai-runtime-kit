import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import {
  createAuditQueryClient,
  createAuditQueryServer,
  authenticateAuditQueryRequest,
  queryAuditStore,
} from "../src/audit/query.mjs";
import { createAuditDaemon } from "../src/audit/daemon.mjs";

const CAPABILITY = "query-capability-v1";

async function withSocket(run) {
  const root = await mkdtemp("/tmp/airkit-audit-query-");
  const socketPath = join(root, "auditd-query.sock");
  try {
    await run({ root, socketPath });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

test("query bridge serves only bounded allowlisted metadata operations", async () => {
  await withSocket(async ({ root, socketPath }) => {
    const calls = [];
    const server = createAuditQueryServer({
      socketPath,
      capability: CAPABILITY,
      query: (request) => {
        calls.push(request);
        return queryAuditStore({
          query(sql, params) {
            return [{ sql, params, client: "airclaude", completeness: "metadata_only" }];
          },
        }, request.operation, request.params, { limit: request.limit });
      },
    });
    await server.start();
    try {
      assert.equal((await stat(socketPath)).mode & 0o777, 0o600);
      const client = createAuditQueryClient({ socketPath, capability: CAPABILITY, timeoutMs: 200 });
      const result = await client.query("clients", { limit: 10 });
      assert.equal(result.status, "ok");
      assert.equal(result.rows[0].client, "airclaude");
      assert.equal(calls[0].operation, "clients");
      assert.equal(calls[0].limit, 10);
      assert.equal((await stat(root)).mode & 0o777, 0o700);
    } finally {
      await server.stop();
    }
  });
});

test("query bridge rejects bad capability and arbitrary SQL without invoking the handler", async () => {
  await withSocket(async ({ socketPath }) => {
    let calls = 0;
    const server = createAuditQueryServer({
      socketPath,
      capability: CAPABILITY,
      query: async () => {
        calls += 1;
        return [];
      },
    });
    await server.start();
    try {
      const badClient = createAuditQueryClient({ socketPath, capability: "wrong-capability", timeoutMs: 200 });
      await assert.rejects(badClient.query("clients"), /authorization|closed|socket/i);
      const client = createAuditQueryClient({ socketPath, capability: CAPABILITY, timeoutMs: 200 });
      assert.throws(() => client.query("SELECT 1"), /allowed|operation/i);
      assert.equal(calls, 0);
    } finally {
      await server.stop();
    }
  });
});

test("query store uses static SQL and caps every bridge result", () => {
  const calls = [];
  const store = { query(sql, params) { calls.push({ sql, params }); return []; } };
  queryAuditStore(store, "request", { id: "request-1" }, { limit: 7 });
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /^SELECT request_id/);
  assert.equal(calls[0].params.at(-1), 7);
  assert.equal(calls[0].sql.includes("payload_json"), false);
  assert.throws(() => queryAuditStore(store, "DROP TABLE requests"), /allowed|unknown/i);
});

test("Shield detail query binds exactly one opaque request ID and its limit", () => {
  const calls = [];
  const store = { query(sql, params) { calls.push({ sql, params }); return []; } };
  queryAuditStore(store, "shield_decision", { id: "shield-request-1" }, { limit: 7 });
  assert.match(calls[0].sql, /FROM shield_decisions WHERE logical_request_id = \?/);
  assert.deepEqual(calls[0].params, ["shield-request-1", 7]);
  for (const rawId of ["raw prompt secret", "https://private.invalid/request", "Bearer grant-token"]) {
    assert.throws(() => queryAuditStore(store, "shield_decision", { id: rawId }), /shield.*opaque|shield.*identifier/i);
    assert.throws(() => authenticateAuditQueryRequest({
      version: 1, request_id: "request-1", operation: "shield_decision", params: { id: rawId },
    }, CAPABILITY), /shield.*identifier/i);
  }
});

test("audit daemon owns the query socket and reports its lifecycle", async () => {
  await withSocket(async ({ root, socketPath }) => {
    const ingestSocketPath = join(root, "auditd.sock");
    const store = {
      query() { return [{ client: "daemon" }]; },
      async ingestEvent() { return { status: "committed" }; },
      close() {},
    };
    const daemon = createAuditDaemon({
      paths: { rootDir: root, socketPath: ingestSocketPath, querySocketPath: socketPath },
      capability: CAPABILITY,
      keyProvider: { async getMasterKey() { return Buffer.alloc(32, 7); } },
      storeFactory: () => store,
      stderr: { write() {} },
    });
    await daemon.start();
    try {
      assert.equal(daemon.status().queryListening, true);
      const result = await createAuditQueryClient({ socketPath, capability: CAPABILITY }).query("clients");
      assert.equal(result.rows[0].client, "daemon");
    } finally {
      await daemon.stop();
    }
    await assert.rejects(stat(socketPath), /ENOENT/);
  });
});
