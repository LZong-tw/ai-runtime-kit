import assert from "node:assert/strict";
import test from "node:test";

import { createAuditUiAdapter } from "../src/audit/ui-contract.mjs";

test("CCR UI query projection is metadata-only and excludes sensitive fields", async () => {
  const adapter = createAuditUiAdapter({
    async query() {
      return {
        state: "healthy",
        rows: [{
          client: "claude-sub",
          completeness: "metadata_only",
          event_count: 2,
          apiKey: "secret-api-key",
          payload: "private prompt",
          authorization: "Bearer secret-token",
          socketPath: "/Users/private/.local/state/auditd.sock",
        }],
      };
    },
    async status() {
      return { state: "healthy" };
    },
  });

  const result = await adapter.query("clients");
  assert.equal(result.state, "healthy");
  assert.equal(result.metadata_only, true);
  assert.equal(result.payload_included, false);
  assert.deepEqual(result.rows, [{ client: "claude-sub", completeness: "metadata_only", event_count: 2 }]);
  assert.doesNotMatch(JSON.stringify(result), /secret|private|authorization|socketPath/i);
});

test("CCR UI query contract preserves empty healthy results", async () => {
  const adapter = createAuditUiAdapter({
    async query() { return { state: "healthy", rows: [] }; },
    async status() { return { state: "healthy", database: { present: true, ok: true } }; },
  });

  const result = await adapter.query("requests");
  assert.deepEqual(result.rows, []);
  assert.equal(result.empty, true);
  assert.equal(result.state, "healthy");
  assert.equal(result.gap, undefined);
});

test("CCR UI query and status contract exposes safe degraded state", async () => {
  const adapter = createAuditUiAdapter({
    async query() { throw new Error("failed at /Users/private/audit.sqlite token=secret-token"); },
    async status() {
      return {
        state: "degraded",
        database: { present: true, ok: false, path: "/Users/private/audit.sqlite", masterKeyHex: "secret" },
        service: { installed: true, loaded: false, stale: true, plistPath: "/Users/private/service.plist" },
        keychain: { present: false, secret: "secret" },
      };
    },
  });

  const query = await adapter.query("requests");
  assert.equal(query.state, "degraded");
  assert.deepEqual(query.rows, []);
  assert.deepEqual(query.gap, { code: "audit_query_unavailable" });
  assert.doesNotMatch(JSON.stringify(query), /secret|private|audit\.sqlite/i);

  const status = await adapter.status();
  assert.equal(status.state, "degraded");
  assert.deepEqual(status.database, { present: true, ok: false });
  assert.deepEqual(status.service, { installed: true, loaded: false, stale: true });
  assert.deepEqual(status.keychain, { present: false });
  assert.doesNotMatch(JSON.stringify(status), /secret|private|plistPath|masterKey/i);
});

test("CCR UI contract rejects unknown or oversized queries without invoking store", async () => {
  let calls = 0;
  const adapter = createAuditUiAdapter({
    async query() { calls += 1; return { state: "healthy", rows: [] }; },
    async status() { return { state: "healthy" }; },
  });

  const unknown = await adapter.query("raw-sql");
  const oversized = await adapter.query("request", ["x".repeat(257)]);
  assert.equal(unknown.error.code, "unknown_query");
  assert.equal(oversized.error.code, "invalid_query_arguments");
  assert.equal(calls, 0);
});
