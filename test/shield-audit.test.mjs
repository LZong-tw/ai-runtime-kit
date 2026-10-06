import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { buildShieldDecisionEvent, buildShieldPolicyTransitionEvent, createShieldDecisionRecorder } from "../src/shield/audit.mjs";
import { decryptAuditValue } from "../src/audit/crypto.mjs";
import { createEncryptedSpool } from "../src/audit/spool.mjs";
import { DatabaseSync } from "node:sqlite";
import { queryAuditStore } from "../src/audit/query.mjs";
import { openAuditStore } from "../src/audit/store.mjs";

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
    decision_source: "evaluated",
    override: false,
    elapsed_ms: 4,
  });
  for (const forbidden of ["body", "path", "url", "headers", "digest", "span", "prompt", "grant", "cacheKey"]) {
    assert.throws(() => buildShieldDecisionEvent({ ...decision, [forbidden]: "sentinel-secret" }), /shield decision/i);
  }
  assert.doesNotMatch(JSON.stringify(event), /sentinel-secret/);
});

const MEDIA = Object.freeze({
  imageVersion: "image-0123456789ab",
  imageCount: 2,
  imageTransformCount: 1,
  documentCount: 0,
  mediaOutcome: "scanned",
});

test("shield decisions carry media counters only when the decision sets them", () => {
  const plain = buildShieldDecisionEvent(decision);
  for (const column of ["image_version", "image_count", "image_transform_count", "document_count", "media_outcome"]) {
    assert.equal(Object.hasOwn(plain.payload, column), false, column);
  }

  const media = buildShieldDecisionEvent({ ...decision, action: "redact", transformCount: 3, ...MEDIA });
  assert.deepEqual({
    image_version: media.payload.image_version,
    image_count: media.payload.image_count,
    image_transform_count: media.payload.image_transform_count,
    document_count: media.payload.document_count,
    media_outcome: media.payload.media_outcome,
  }, { image_version: "image-0123456789ab", image_count: 2, image_transform_count: 1, document_count: 0, media_outcome: "scanned" });

  const blocked = buildShieldDecisionEvent({ ...decision, action: "block", reasonCodes: ["media_document_blocked"], documentCount: 1, mediaOutcome: "blocked_document" });
  assert.deepEqual([blocked.payload.document_count, blocked.payload.media_outcome, Object.hasOwn(blocked.payload, "image_count")], [1, "blocked_document", false]);
});

test("shield media values are refused before they reach the audit transport", () => {
  for (const bad of [
    { imageVersion: "https://images.example/a.png" },
    { imageVersion: "file_abc" },
    { imageCount: -1 },
    { documentCount: 1.5 },
    { mediaOutcome: "allowed" },
    { mediaOutcome: null },
    { mediaOutcome: "blocked_secret" },
    { imageTransformCount: 1 },
    { image_count: 1 },
    { ocrText: "hunter2" },
  ]) {
    assert.throws(() => buildShieldDecisionEvent({ ...decision, ...bad }), /shield (decision|metadata)/i, JSON.stringify(bad));
  }
  assert.throws(
    () => buildShieldPolicyTransitionEvent({ ...decision, action: "transition", reasonCodes: ["policy_replaced"], mediaOutcome: "none" }),
    /shield decision/i,
  );
});

test("shield media counters round-trip through the audit store and decision queries", async () => {
  const root = await mkdtemp(join(tmpdir(), "airkit-shield-media-"));
  const store = openAuditStore({
    databasePath: join(root, "audit.sqlite"),
    backupDir: join(root, "backups"),
    Database: DatabaseSync,
    now: () => new Date("2026-10-06T00:00:00.000Z"),
  });
  try {
    const at = (iso) => ({ now: () => new Date(iso) });
    await store.ingestEvent(buildShieldDecisionEvent({ ...decision, requestId: "media-1", action: "redact", transformCount: 3, ...MEDIA }, at("2026-10-06T00:00:01.000Z")));
    await store.ingestEvent(buildShieldDecisionEvent({ ...decision, requestId: "plain-1" }, at("2026-10-06T00:00:02.000Z")));
    await store.ingestEvent(buildShieldPolicyTransitionEvent({ ...decision, requestId: "transition-1", action: "transition", reasonCodes: ["policy_replaced"] }));

    const project = (row) => [row.logical_request_id, row.image_version, row.image_count, row.image_transform_count, row.document_count, row.media_outcome];
    assert.deepEqual(queryAuditStore(store, "shield_decisions").map(project), [
      ["media-1", "image-0123456789ab", 2, 1, 0, "scanned"],
      ["plain-1", null, null, null, null, null],
    ]);
    assert.deepEqual(queryAuditStore(store, "shield_decision", { id: "media-1" }).map(project), [["media-1", "image-0123456789ab", 2, 1, 0, "scanned"]]);
    const [transition] = queryAuditStore(store, "shield_policy_transitions");
    assert.equal(Object.hasOwn(transition, "media_outcome"), false);
  } finally {
    store.close();
    await rm(root, { force: true, recursive: true });
  }
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

test("shield audit admits only declared cache provenance", () => {
  const coalesced = buildShieldDecisionEvent({ ...decision, decisionSource: "coalesced" });
  assert.equal(coalesced.payload.decision_source, "coalesced");
  assert.throws(() => buildShieldDecisionEvent({ ...decision, decisionSource: "request_digest" }), /shield decision/i);
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

test("durable recorder persists policy transition events through the same encrypted channel", async () => {
  const sent = [];
  const recorder = createShieldDecisionRecorder({
    masterKey: MASTER_KEY,
    client: { send: async (envelope) => { sent.push(envelope); return { status: "committed" }; } },
  });
  await recorder.recordShieldPolicyTransition({ ...decision, action: "transition", reasonCodes: ["policy_replaced"] });
  const plaintext = decryptAuditValue({
    masterKey: MASTER_KEY,
    purpose: "request-evidence/v1",
    identity: sent[0].event_id,
    encrypted: sent[0].encrypted,
  });
  assert.equal(JSON.parse(plaintext.toString("utf8")).event_kind, "shield_policy_transition");
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
