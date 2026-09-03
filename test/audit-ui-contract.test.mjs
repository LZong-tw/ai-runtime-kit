import assert from "node:assert/strict";
import test from "node:test";

import { createAuditEvent, validateAuditEvent } from "../src/audit/event.mjs";
import { AUDIT_MIGRATIONS } from "../src/audit/migrations.mjs";
import { queryAuditStore } from "../src/audit/query.mjs";
import { createAuditUiAdapter, projectShieldStatus } from "../src/audit/ui-contract.mjs";

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

test("Shield audit accepts only metadata and exposes a static metadata-only query", async () => {
  const shieldMigration = AUDIT_MIGRATIONS.find((migration) => migration.id === "004_shield_metadata_audit");
  const decisionSourceMigration = AUDIT_MIGRATIONS.find((migration) => migration.id === "005_shield_decision_source");
  assert.ok(shieldMigration);
  assert.ok(decisionSourceMigration);
  assert.match(shieldMigration.statements.join("\n"), /CREATE TABLE IF NOT EXISTS shield_decisions/);
  assert.match(decisionSourceMigration.statements.join("\n"), /decision_source/);

  const event = createAuditEvent({
    source: "airkit-shield",
    source_version: "1",
    logical_request_id: "request-1",
    session_id: "session-1",
    client: "airkit-shield",
    event_kind: "shield_decision",
    payload: {
      lane: "subscription",
      destination_class: "subscription",
      policy_version: "policy-1",
      gitleaks_version: "8.24.3",
      privacy_version: "privacy-1",
      action: "block",
      reasons: ["confirmed_secret"],
      transform_count: 0,
      override: false,
      elapsed_ms: 12,
    },
  });
  assert.equal(validateAuditEvent(event).payload.action, "block");
  assert.throws(() => validateAuditEvent({
    ...event,
    payload: { ...event.payload, body: "shield-raw-sentinel", url: "https://secret.invalid", headers: { authorization: "Bearer secret" } },
  }), /shield metadata/i);

  const calls = [];
  queryAuditStore({
    query(sql, params) {
      calls.push({ sql, params });
      return [{
        logical_request_id: "request-1",
        session_id: "session-1",
        lane: "subscription",
        destination_class: "subscription",
        policy_version: "policy-1",
        gitleaks_version: "8.24.3",
        privacy_version: "privacy-1",
        action: "block",
        reasons: "confirmed_secret",
        transform_count: 0,
        decision_source: "cache_hit",
        override: 0,
        elapsed_ms: 12,
        payload_json: "shield-raw-sentinel",
      }];
    },
  }, "shield_decisions");
  assert.match(calls[0].sql, /FROM shield_decisions/);
  assert.doesNotMatch(calls[0].sql, /payload_json|reveal|body|url|header/i);
});

test("Shield correlation identifiers are bounded opaque values, never raw evidence", () => {
  const fields = {
    source: "airkit-shield",
    source_version: "1",
    logical_request_id: "shield-request-1",
    session_id: "shield-session-1",
    client: "airkit-shield",
    event_kind: "shield_decision",
    payload: {
      lane: "subscription", destination_class: "subscription", policy_version: "policy-1",
      gitleaks_version: "8.24.3", privacy_version: "privacy-1", action: "block",
      reasons: ["confirmed_secret"], transform_count: 0, override: false, elapsed_ms: 1,
    },
  };
  for (const [logical_request_id, session_id] of [
    ["raw prompt with secret", "shield-session-1"],
    ["https://private.invalid/request", "shield-session-1"],
    ["shield-request-1", "/Users/private/repo"],
    ["shield-request-1", "Bearer grant-token"],
    ["x".repeat(129), "shield-session-1"],
  ]) {
    assert.throws(() => validateAuditEvent(createAuditEvent({ ...fields, logical_request_id, session_id })), /shield.*(identifier|metadata)|logical_request/i);
  }
});

test("Shield UI status projects real per-lane health and declared coverage without route metadata", () => {
  const projection = projectShieldStatus({
    state: "protected",
    lanes: [
      {
        lane: "subscription",
        state: "protected",
        service: "healthy",
        policy: "healthy",
        privacy: "healthy",
        audit: "healthy",
        policy_version: "policy-1",
        gitleaks_version: "8.24.3",
        privacy_version: "privacy-1",
        origin: "http://127.0.0.1:8811",
        capability: "must-not-render",
      },
      {
        lane: "managed",
        state: "unavailable",
        service: "stopped",
        policy: "missing",
        privacy: "missing",
        audit: "unavailable",
      },
    ],
    declared_coverage: [
      { launcher: "airclaude", lanes: ["managed"], hop_chain: ["airclaude", "shield", "managed"] },
    ],
    declared_bypasses: [
      { launcher: "claude", reason: "direct_client" },
    ],
    coverage: 4,
    bypass: false,
    raw_prompt: "shield-raw-sentinel",
  });
  assert.deepEqual(projection, {
    state: "protected",
    lanes: [
      {
        lane: "subscription",
        state: "protected",
        service: "healthy",
        policy: "healthy",
        privacy: "healthy",
        audit: "healthy",
        policy_version: "policy-1",
        gitleaks_version: "8.24.3",
        privacy_version: "privacy-1",
      },
      {
        lane: "managed",
        state: "unavailable",
        service: "stopped",
        policy: "missing",
        privacy: "missing",
        audit: "unavailable",
      },
    ],
    declared_coverage: [
      { launcher: "airclaude", lanes: ["managed"], hop_chain: ["airclaude", "shield", "managed"] },
    ],
    declared_bypasses: [
      { launcher: "claude", reason: "direct_client" },
    ],
  });
  assert.doesNotMatch(JSON.stringify(projection), /8811|capability|sentinel/i);
});

test("Shield UI and status projections preserve accounting-neutral protection state", async () => {
  const adapter = createAuditUiAdapter({
    async query() {
      return {
        state: "healthy",
        rows: [{
          logical_request_id: "request-1",
          session_id: "session-1",
          lane: "subscription",
          destination_class: "subscription",
          policy_version: "policy-1",
          gitleaks_version: "8.24.3",
          privacy_version: "privacy-1",
          action: "block",
          reasons: "confirmed_secret",
          transform_count: 0,
          decision_source: "cache_hit",
          override: false,
          elapsed_ms: 12,
          content: "shield-raw-sentinel",
          cache_read_tokens: 999,
          derived_total_cost: 123,
        }],
      };
    },
    async status() { return { state: "healthy" }; },
  });
  const result = await adapter.query("shield_decisions");
  assert.deepEqual(result.rows, [{
    logical_request_id: "request-1",
    session_id: "session-1",
    lane: "subscription",
    destination_class: "subscription",
    policy_version: "policy-1",
    gitleaks_version: "8.24.3",
    privacy_version: "privacy-1",
    action: "block",
    reasons: "confirmed_secret",
    transform_count: 0,
    decision_source: "cache_hit",
    override: false,
    elapsed_ms: 12,
  }]);
  assert.doesNotMatch(JSON.stringify(result), /sentinel|cache_read|total_cost/i);

  assert.deepEqual(projectShieldStatus({ state: "protected", raw_prompt: "shield-raw-sentinel" }), { state: "protected" });
});

test("Shield UI rejects non-opaque detail identifiers before it invokes the query bridge", async () => {
  let calls = 0;
  const adapter = createAuditUiAdapter({
    async query() { calls += 1; return { state: "healthy", rows: [] }; },
    async status() { return { state: "healthy" }; },
  });
  for (const rawId of ["raw prompt secret", "https://private.invalid/request", "Bearer grant-token"]) {
    const result = await adapter.query("shield_decision", [rawId]);
    assert.equal(result.error.code, "invalid_query_arguments");
  }
  assert.equal(calls, 0);
});
