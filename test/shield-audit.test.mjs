import assert from "node:assert/strict";
import { test } from "node:test";

import { buildShieldDecisionEvent, createShieldDecisionRecorder } from "../src/shield/audit.mjs";

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
  assert.equal(event.event_kind, "collector_lifecycle");
  assert.deepEqual(event.payload, { shield_decision: decision });
  for (const forbidden of ["body", "path", "url", "headers", "digest", "span", "prompt", "grant"]) {
    assert.throws(() => buildShieldDecisionEvent({ ...decision, [forbidden]: "sentinel-secret" }), /shield decision/i);
  }
  assert.doesNotMatch(JSON.stringify(event), /sentinel-secret/);
});

test("durable recorder resolves only after audit daemon ACK", async () => {
  const sent = [];
  const recorder = createShieldDecisionRecorder({
    client: { send: async (event) => { sent.push(event); return { status: "committed" }; } },
    now: () => new Date("2026-09-02T00:00:00.000Z"),
  });
  const result = await recorder.recordShieldDecision(decision);
  assert.equal(result.durable, "ack");
  assert.equal(sent.length, 1);
});

test("audit transport failure and full spool fail closed", async () => {
  const unavailable = createShieldDecisionRecorder({
    client: { send: async () => { throw new Error("raw-secret must not escape"); } },
  });
  await assert.rejects(unavailable.recordShieldDecision(decision), /shield audit is unavailable/);

  let enqueued = false;
  const full = createShieldDecisionRecorder({
    client: { send: async () => { throw new Error("audit daemon unavailable"); } },
    spool: {
      stats: async () => ({ atCapacity: true }),
      enqueue: async () => { enqueued = true; },
    },
  });
  await assert.rejects(full.recordShieldDecision(decision), /shield audit is unavailable/);
  assert.equal(enqueued, false);
});

test("encrypted spool capacity is a durable fallback after a daemon failure", async () => {
  const enqueued = [];
  const recorder = createShieldDecisionRecorder({
    client: { send: async () => { throw new Error("audit daemon unavailable"); } },
    spool: {
      stats: async () => ({ atCapacity: false }),
      enqueue: async (event) => { enqueued.push(event); return { event: { event_id: event.event_id } }; },
    },
  });
  const result = await recorder.recordShieldDecision(decision);
  assert.equal(result.durable, "spool");
  assert.equal(enqueued.length, 1);
});
