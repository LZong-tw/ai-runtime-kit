import { test } from "node:test";
import assert from "node:assert/strict";

import { resolveShieldLauncher, shieldLauncherDescriptors } from "../src/shield/launchers.mjs";
import { createDecisionCache } from "../src/shield/decision-cache.mjs";

test("every declared AirKit and Headroom launcher has an explicit Shield disposition", () => {
  const cases = [
    ["airclaude", "managed", "managed", ["airclaude", "shield", "managed"]],
    ["cclaude-work", "managed", "managed", ["cclaude-*", "airclaude", "shield", "managed"]],
    ["hr-airclaude", "managed", "managed", ["headroom", "airclaude", "shield", "managed"]],
    ["hr-claude-web", "managed", "managed", ["headroom", "web", "shield", "managed"]],
  ];

  for (const [launcher, lane, destinationClass, hopChain] of cases) {
    assert.deepEqual(
      resolveShieldLauncher({ launcher, mode: "auto", headroom: launcher.startsWith("hr-"), providerOverride: lane }),
      { coverage: "protected", clientLane: lane, destinationClass, hopChain },
      launcher,
    );
  }
});

test("declared direct client bypasses are visible and undeclared helpers fail closed", () => {
  assert.deepEqual(
    resolveShieldLauncher({ launcher: "claude", mode: "auto" }),
    { coverage: "bypass", bypassReason: "direct_client" },
  );
  assert.deepEqual(
    resolveShieldLauncher({ launcher: "hr-claude-sub", mode: "auto", headroom: true }),
    { coverage: "bypass", bypassReason: "zsh_direct_subscription" },
  );
  assert.throws(
    () => resolveShieldLauncher({ launcher: "hr-unknown", mode: "auto" }),
    /undeclared Shield launcher/i,
  );
});

test("launcher descriptor inventory exposes protected hops and zsh bypasses distinctly", () => {
  const descriptors = shieldLauncherDescriptors();
  assert.deepEqual(descriptors.find((entry) => entry.launcher === "hr-claude-sub"), {
    coverage: "bypass", launcher: "hr-claude-sub", bypassReason: "zsh_direct_subscription",
  });
  assert.deepEqual(descriptors.find((entry) => entry.launcher === "hr-claude-web"), {
    coverage: "protected", launcher: "hr-claude-web", lanes: ["managed"], hopChain: ["headroom", "web", "shield", "managed"],
  });
});

test("decision cache reuses only exact terminal retry metadata and invalidates transitions", async () => {
  let now = 1_000;
  const cache = createDecisionCache({ clock: () => now, ttlMs: 100, maxEntries: 2 });
  const first = {
    body: Buffer.from('{"safe":"redacted"}'),
    action: "redact",
    detectorVersions: { Gitleaks: "1", Privacy: "1" },
    destinationClass: "managed",
    lane: "managed",
    policyVersion: "policy-1",
    requestDigest: "a".repeat(64),
    reasonCodes: ["pii_redacted"], transformCount: 1,
  };
  cache.set(first);
  const hit = cache.get(first);
  assert.equal(hit.action, "redact");
  assert.deepEqual(hit.body, Buffer.from('{"safe":"redacted"}'));
  assert.notEqual(hit.body, first.body);
  assert.equal(cache.get({ ...first, requestDigest: "b".repeat(64) }), null);
  assert.equal(cache.get({ ...first, policyVersion: "policy-2" }), null);
  assert.equal(cache.get({ ...first, lane: "subscription", destinationClass: "subscription" }), null);

  cache.invalidateTransition({ policyVersion: "policy-2", detectorVersions: { Gitleaks: "2", Privacy: "1" } });
  assert.equal(cache.get(first), null);
  cache.set({ ...first, policyVersion: "policy-2", detectorVersions: { Gitleaks: "2", Privacy: "1" } });
  now += 101;
  assert.equal(cache.get({ ...first, policyVersion: "policy-2", detectorVersions: { Gitleaks: "2", Privacy: "1" } }), null);
});

test("decision cache coalesces concurrent exact computations without retaining request input", async () => {
  const cache = createDecisionCache();
  const key = {
    detectorVersions: { Gitleaks: "1", Privacy: "1" }, destinationClass: "managed", lane: "managed", policyVersion: "policy-1", requestDigest: "c".repeat(64),
  };
  let calls = 0;
  const compute = async () => {
    calls += 1;
    return { ...key, action: "allow", body: Buffer.alloc(0), reasonCodes: ["policy_allow"], transformCount: 0 };
  };
  const [left, right] = await Promise.all([cache.getOrCompute(key, compute), cache.getOrCompute(key, compute)]);
  assert.equal(calls, 1);
  assert.equal(left.action, "allow");
  assert.equal(right.action, "allow");
  assert.equal(JSON.stringify(cache.inspect()).includes("requestDigest"), false);
});

test("decision cache rejects a computed decision whose identity differs from the pending retry", async () => {
  const cache = createDecisionCache();
  const key = {
    detectorVersions: { Gitleaks: "1", Privacy: "1" }, destinationClass: "managed", lane: "managed", policyVersion: "policy-1", requestDigest: "d".repeat(64),
  };
  await assert.rejects(
    cache.getOrCompute(key, async () => ({ ...key, requestDigest: "e".repeat(64), action: "allow", body: Buffer.alloc(0), reasonCodes: ["policy_allow"], transformCount: 0 })),
    /identity mismatch/i,
  );
  assert.equal(cache.get(key), null);
});
