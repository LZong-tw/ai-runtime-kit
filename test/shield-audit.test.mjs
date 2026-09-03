import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { buildShieldDecisionEvent, buildShieldPolicyTransitionEvent, createShieldDecisionRecorder } from "../src/shield/audit.mjs";
import { decryptAuditValue } from "../src/audit/crypto.mjs";
import { createEncryptedSpool } from "../src/audit/spool.mjs";

const MASTER_KEY = Buffer.alloc(32, 9);

const decision = Object.freeze({
  requestId: "request-1",
  lane: "subscription",
  destinationClass: "subscription",
  bundleVersion: "2026.09.02",
  detectorVersions: { gitleaks: "8.24.3" },
  action: "allow",
  reasonCodes: ["policy_allow"],
  transformCount: 0,
  override: false,
  elapsedMs: 4,
});

test("shield decision builder admits only metadata allowlist", () => {
  const event = buildShieldDecisionEvent(decision, { now: () => new Date("2026-09-02T00:00:00.000Z") });
  assert.equal(event.event_kind, "shield_decision");
  assert.deepEqual(event.payload, {
    lane: "subscription",
    destination_class: "subscription",
    policy_version: "2026.09.02",
    gitleaks_version: "8.24.3",
    privacy_version: "unknown",
    action: "allow",
    reasons: ["policy_allow"],
    transform_count: 0,
    override: false,
    elapsed_ms: 4,
  });
  for (const forbidden of ["body", "path", "url", "headers", "digest", "span", "prompt", "grant"]) {
    assert.throws(() => buildShieldDecisionEvent({ ...decision, [forbidden]: "sentinel-secret" }), /shield decision/i);
  }
  assert.doesNotMatch(JSON.stringify(event), /sentinel-secret/);
});

test("shield policy transitions use the same metadata-only event contract", () => {
  const event = buildShieldPolicyTransitionEvent({
    ...decision,
    action: "transition",
    reasonCodes: ["policy_replaced"],
  });
  assert.equal(event.event_kind, "shield_policy_transition");
  assert.equal(event.payload.action, "transition");
  assert.equal(event.payload.reasons[0], "policy_replaced");
  assert.doesNotMatch(JSON.stringify(event), /capability|body|secret/i);
});

test("durable recorder sends an encrypted transport envelope and waits for audit daemon ACK", async () => {
  const sent = [];
  const recorder = createShieldDecisionRecorder({
    masterKey: MASTER_KEY,
    client: { send: async (envelope) => { sent.push(envelope); return { status: "committed" }; } },
    now: () => new Date("2026-09-02T00:00:00.000Z"),
  });
  const result = await recorder.recordShieldDecision(decision);
  assert.equal(result.durable, "ack");
  assert.equal(sent.length, 1);
  assert.deepEqual(Object.keys(sent[0]).sort(), ["encrypted", "event_id"]);
  assert.equal(sent[0].event_id.length > 0, true);
  assert.doesNotMatch(JSON.stringify(sent[0]), /request-1|policy_allow/);
  const plaintext = decryptAuditValue({
    masterKey: MASTER_KEY,
    purpose: "request-evidence/v1",
    identity: sent[0].event_id,
    encrypted: sent[0].encrypted,
  });
  assert.deepEqual(JSON.parse(plaintext.toString("utf8")).payload, buildShieldDecisionEvent(decision, { now: () => new Date("2026-09-02T00:00:00.000Z") }).payload);
});

test("audit transport failure and full spool fail closed", async () => {
  const unavailable = createShieldDecisionRecorder({
    masterKey: MASTER_KEY,
    client: { send: async () => { throw new Error("raw-secret must not escape"); } },
  });
  await assert.rejects(unavailable.recordShieldDecision(decision), /shield audit is unavailable/);

  let enqueued = false;
  const full = createShieldDecisionRecorder({
    masterKey: MASTER_KEY,
    client: { send: async () => { throw new Error("audit daemon unavailable"); } },
    spool: {
      stats: async () => ({ atCapacity: true }),
      enqueue: async () => { enqueued = true; },
    },
  });
  await assert.rejects(full.recordShieldDecision(decision), /shield audit is unavailable/);
  assert.equal(enqueued, false);
});

test("encrypted spool capacity is a durable fallback after a daemon failure", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "airkit-shield-audit-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const spool = createEncryptedSpool({
    paths: { rootDir: root, spoolDir: join(root, "spool") },
    masterKey: MASTER_KEY,
  });
  const recorder = createShieldDecisionRecorder({
    masterKey: MASTER_KEY,
    client: { send: async () => { throw new Error("audit daemon unavailable"); } },
    spool,
  });
  const result = await recorder.recordShieldDecision(decision);
  assert.equal(result.durable, "spool");
  const entries = await spool.entries();
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0].event.payload, buildShieldDecisionEvent(decision).payload);
  const records = await Promise.all((await readdir(join(root, "spool"))).map((name) => readFile(join(root, "spool", name), "utf8")));
  assert.doesNotMatch(records.join(""), /request-1|policy_allow/);
});
