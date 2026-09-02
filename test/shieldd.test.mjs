import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";

import { startShieldDaemon } from "../src/shieldd.mjs";

const config = {
  capability: "c".repeat(32),
  targetOrigin: "https://api.anthropic.com",
  lane: "subscription",
  generation: "generation-1",
  targetClass: "subscription",
  launcherContext: {
    repository: { remoteHash: "a".repeat(64), trustClass: "internal" },
    pathClasses: ["source"],
    destinationClass: "subscription",
    interactive: false,
  },
  gitleaks: { executable: "/opt/airkit/gitleaks", sha256: "b".repeat(64), ruleBundle: { path: "/opt/airkit/rules.toml", sha256: "c".repeat(64), version: "rules-1", commandProfile: { versionArgs: ["version"], scanArgs: ["stdin", "--config", "{rules}", "--report-format", "json", "--report-path", "-", "--redact"] } } },
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
    createScanner: async (options) => {
      calls.push(["scanner", options]);
      return { version: "8.24.0", scan: async () => ({ findings: [] }) };
    },
    writePolicyState: async (options) => calls.push(["state", options]),
    startProxy: async (options) => {
      calls.push(["proxy", options]);
      return { origin: "http://127.0.0.1:8811", close: async () => calls.push(["close"]) };
    },
    writeIdentity: async (options) => calls.push(["identity", options]),
  });

  assert.equal(daemon.policy, policy);
  assert.deepEqual(await calls.find(([name]) => name === "proxy")[1].decide({ body: Buffer.alloc(0) }), {
    action: "block",
    reasonCodes: ["fixture"],
    approvalEligible: false,
    redactions: [],
    lane: "subscription",
    destinationClass: "subscription",
    bundleVersion: "2026.09.02.2",
    detectorVersions: { gitleaks: "8.24.0" },
  });
  assert.deepEqual(calls.map(([name]) => name), ["bundle", "policy", "scanner", "state", "proxy", "identity"]);
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
      createScanner: async () => ({ version: "8.24.0", scan: async () => ({ findings: [] }) }),
      writePolicyState: async () => {},
      startProxy: async () => ({ origin: "http://127.0.0.1:8811", close: async () => calls.push("close") }),
      writeIdentity: async () => { throw new Error("identity write failed"); },
    }),
    /identity write failed/,
  );
  assert.deepEqual(calls, ["close"]);
});

test("daemon normalizes conflicting launcher destination class before policy evaluation", async () => {
  const policyInputs = [];
  const proxyDecisions = [];
  await startShieldDaemon({
    config: {
      ...config,
      launcherContext: { ...config.launcherContext, destinationClass: "managed" },
    },
    paths,
    readPolicyBundle: async () => ({ bundle: {}, publicKey: "pinned-ed25519-public-key" }),
    loadPolicy: async () => ({
      ...policy,
      async evaluate(input) {
        policyInputs.push(input);
        return { action: "require_approval", reasonCodes: ["internal_repository_code"], approvalEligible: true, redactions: [] };
      },
    }),
    createScanner: async () => ({ version: "8.24.0", scan: async () => ({ findings: [] }) }),
    writePolicyState: async () => {},
    startProxy: async ({ decide }) => {
      proxyDecisions.push(await decide({ body: Buffer.alloc(0) }));
      return { origin: "http://127.0.0.1:8811", close: async () => {} };
    },
    writeIdentity: async () => {},
  });

  assert.equal(policyInputs[0].destinationClass, "subscription");
  assert.equal(proxyDecisions[0].destinationClass, "subscription");
});

test("daemon rejects a target class that conflicts with its lane before policy activation", async () => {
  let loaded = false;
  await assert.rejects(
    startShieldDaemon({
      config: { ...config, targetClass: "managed" },
      paths,
      readPolicyBundle: async () => ({ bundle: {}, publicKey: "pinned-ed25519-public-key" }),
      loadPolicy: async () => { loaded = true; return policy; },
    }),
    /targetClass must match/i,
  );
  assert.equal(loaded, false);
});

test("proxy requests reach Gitleaks, category-only classification, and policy evaluation", async (t) => {
  const upstream = createServer(async (request, response) => {
    request.resume();
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"ok":true}');
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  t.after(() => new Promise((resolve) => upstream.close(resolve)));
  const address = upstream.address();
  const scannerCalls = [];
  const policyInputs = [];
  const daemon = await startShieldDaemon({
    config: { ...config, targetOrigin: `http://127.0.0.1:${address.port}` },
    paths,
    readPolicyBundle: async () => ({ bundle: {}, publicKey: "pinned-ed25519-public-key" }),
    createScanner: async () => ({
      version: "8.24.0",
      async scan(body) {
        scannerCalls.push(Buffer.from(body).toString("utf8"));
        return { findings: [{ category: "private-key", count: 1 }] };
      },
    }),
    loadPolicy: async () => ({
      ...policy,
      async evaluate(input) {
        policyInputs.push(input);
        return { action: "block", reasonCodes: ["confirmed-secret"], approvalEligible: false, redactions: [] };
      },
    }),
    writePolicyState: async () => {},
    writeIdentity: async () => {},
  });
  t.after(() => daemon.shield.close());

  const response = await fetch(`${daemon.shield.origin}/v1/messages`, {
    method: "POST",
    headers: { "x-airkit-shield": config.capability },
    body: '{"content":"fixture-private-key"}',
  });

  assert.equal(response.status, 503);
  assert.deepEqual(scannerCalls, ['{"content":"fixture-private-key"}']);
  assert.deepEqual(policyInputs, [{
    lane: "subscription",
    destinationClass: "subscription",
    interactive: false,
    repositoryClass: "internal",
    pathClasses: ["source"],
    secretFindings: [{ category: "private-key", count: 1 }],
    piiFindings: [],
  }]);
  assert.doesNotMatch(JSON.stringify(policyInputs), /fixture-private-key|aaaa/);
});

test("missing launcher context reaches policy facts but fails closed without durable audit", async (t) => {
  const upstream = createServer((request, response) => {
    request.resume();
    response.end('{"ok":true}');
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  t.after(() => new Promise((resolve) => upstream.close(resolve)));
  const address = upstream.address();
  const policyInputs = [];
  const { launcherContext: _launcherContext, ...configWithoutContext } = config;
  const daemon = await startShieldDaemon({
    config: { ...configWithoutContext, targetOrigin: `http://127.0.0.1:${address.port}` },
    paths,
    readPolicyBundle: async () => ({ bundle: {}, publicKey: "pinned-ed25519-public-key" }),
    createScanner: async () => ({ version: "8.24.0", scan: async () => ({ findings: [] }) }),
    loadPolicy: async () => ({
      ...policy,
      async evaluate(input) {
        policyInputs.push(input);
        return { action: "allow", reasonCodes: [], approvalEligible: false, redactions: [] };
      },
    }),
    writePolicyState: async () => {},
    writeIdentity: async () => {},
  });
  t.after(() => daemon.shield.close());

  const response = await fetch(`${daemon.shield.origin}/v1/messages`, {
    method: "POST",
    headers: { "x-airkit-shield": config.capability },
    body: '{"content":"ordinary"}',
  });

  assert.equal(response.status, 503);
  assert.deepEqual(policyInputs, [{
    lane: "subscription",
    destinationClass: "subscription",
    interactive: false,
    repositoryClass: "unknown",
    pathClasses: ["unknown"],
    secretFindings: [],
    piiFindings: [],
  }]);
});
