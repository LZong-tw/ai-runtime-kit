import assert from "node:assert/strict";
import test from "node:test";

import { startShieldDaemon } from "../src/shieldd.mjs";

const config = {
  capability: "c".repeat(32),
  targetOrigin: "https://api.anthropic.com",
  lane: "subscription",
  generation: "generation-1",
  targetClass: "subscription",
};

const paths = {
  configPath: "/private/config.json",
  policyBundlePath: "/private/policy.bundle.json",
  policyPublicKeyPath: "/private/policy-public.pem",
};

const policy = {
  version: "2026.09.02.2",
  detectorVersions: { gitleaks: "8.24.0" },
  async evaluate() {
    return { action: "block", reasonCodes: ["fixture"], approvalEligible: false, redactions: [] };
  },
};

test("daemon activates validated policy before proxy readiness and publishes its identity binding", async () => {
  const calls = [];
  const daemon = await startShieldDaemon({
    config,
    paths,
    pid: 4242,
    readPolicyBundle: async ({ receivedPaths }) => {
      calls.push(["bundle", receivedPaths]);
      return { bundle: { fixture: true }, publicKey: "pinned-ed25519-public-key" };
    },
    loadPolicy: async (options) => {
      calls.push(["policy", options]);
      return policy;
    },
    writePolicyState: async (options) => calls.push(["state", options]),
    startProxy: async (options) => {
      calls.push(["proxy", options]);
      return { origin: "http://127.0.0.1:8811", close: async () => calls.push(["close"]) };
    },
    writeIdentity: async (options) => calls.push(["identity", options]),
  });

  assert.equal(daemon.policy, policy);
  assert.deepEqual(await calls.find(([name]) => name === "proxy")[1].decide({}), {
    action: "block",
    reasonCodes: ["fixture"],
    approvalEligible: false,
    redactions: [],
  });
  assert.deepEqual(calls.map(([name]) => name), ["bundle", "policy", "state", "proxy", "identity"]);
  assert.deepEqual(calls.at(-1)[1].identity, {
    origin: "http://127.0.0.1:8811",
    capability: config.capability,
    version: 1,
    pid: 4242,
    lane: "subscription",
    generation: "generation-1",
    targetClass: "subscription",
    policyVersion: policy.version,
    detectorVersions: policy.detectorVersions,
  });
});

test("daemon closes the proxy when publishing the bound identity fails", async () => {
  const calls = [];
  await assert.rejects(
    startShieldDaemon({
      config,
      paths,
      readPolicyBundle: async () => ({ bundle: {}, publicKey: "pinned-ed25519-public-key" }),
      loadPolicy: async () => policy,
      writePolicyState: async () => {},
      startProxy: async () => ({ origin: "http://127.0.0.1:8811", close: async () => calls.push("close") }),
      writeIdentity: async () => { throw new Error("identity write failed"); },
    }),
    /identity write failed/,
  );
  assert.deepEqual(calls, ["close"]);
});
