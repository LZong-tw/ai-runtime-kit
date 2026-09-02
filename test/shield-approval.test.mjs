import assert from "node:assert/strict";
import { test } from "node:test";

import { createApprovalBroker } from "../src/shield/approval.mjs";

const scope = Object.freeze({
  requestId: "request-1",
  digest: "a".repeat(64),
  bundleVersion: "2026.09.02",
  destinationClass: "subscription",
  reasonCodes: ["internal_repository_code"],
});

test("an interactive broker grants exactly one matching request without printing its digest", async () => {
  const output = [];
  const broker = createApprovalBroker({
    tty: { interactive: true, write: (value) => output.push(value), prompt: async () => "y" },
    clock: fixedClock(),
  });

  const grant = await broker.request(scope);
  assert.ok(grant);
  assert.equal(grant.consumed, false);
  assert.equal(broker.consume(grant, scope), true);
  assert.equal(grant.consumed, true);
  assert.equal(broker.consume(grant, scope), false, "a grant cannot be replayed");
  assert.equal(broker.consume(grant, { ...scope, digest: "b".repeat(64) }), false, "a grant is digest-scoped");
  assert.doesNotMatch(output.join(""), /aaaaaaaa|request-1/);
  assert.match(output.join(""), /internal_repository_code/);
  assert.match(output.join(""), /subscription/);
});

test("headless, rejected, timed-out, and aborted approvals do not create grants", async () => {
  const headless = createApprovalBroker({ tty: null, clock: fixedClock() });
  assert.equal(await headless.request(scope), null);

  const rejected = createApprovalBroker({
    tty: { interactive: true, write() {}, prompt: async () => "n" },
    clock: fixedClock(),
  });
  assert.equal(await rejected.request(scope), null);

  const timeoutClock = fixedClock();
  const timedOut = createApprovalBroker({
    tty: { interactive: true, write() {}, prompt: async () => new Promise(() => {}) },
    clock: timeoutClock,
    timeoutMs: 10,
  });
  const expired = timedOut.request(scope);
  timeoutClock.fire();
  assert.equal(await expired, null);

  const controller = new AbortController();
  const aborted = createApprovalBroker({
    tty: { interactive: true, write() {}, prompt: async () => new Promise(() => {}) },
    clock: fixedClock(),
  });
  const pending = aborted.request({ ...scope, signal: controller.signal });
  controller.abort();
  assert.equal(await pending, null);
});

test("expired grants cannot be consumed", async () => {
  const clock = fixedClock();
  const broker = createApprovalBroker({
    tty: { interactive: true, write() {}, prompt: async () => true },
    clock,
    ttlMs: 10,
  });
  const grant = await broker.request(scope);
  clock.advance(11);
  assert.equal(broker.consume(grant, scope), false);
  assert.equal(grant.consumed, false);
});

function fixedClock() {
  let now = 1_000;
  let timer = null;
  return {
    now: () => now,
    setTimeout(callback) { timer = callback; return 1; },
    clearTimeout() { timer = null; },
    fire() { timer?.(); },
    advance(milliseconds) { now += milliseconds; },
  };
}
