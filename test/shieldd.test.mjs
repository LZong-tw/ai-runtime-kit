import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { EventEmitter, once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import test from "node:test";

import { createDefaultDecisionRecorder, startShieldDaemon } from "../src/shieldd.mjs";
import { canonicalJson } from "../src/shield/policy-bundle.mjs";
import { createPrivacyFilter } from "../src/shield/privacy.mjs";
import { startShieldProxy } from "../src/shield/proxy.mjs";

const config = {
  capability: "c".repeat(32),
  controlCapability: "d".repeat(32),
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

const compiledPolicyWasm = await readFile(new URL("./fixtures/shield-policy.wasm", import.meta.url));
const compiledPolicyKeyPair = generateKeyPairSync("ed25519");

const policy = {
  version: "2026.09.02.2",
  detectorVersions: { gitleaks: "8.24.0", privacy: "privacy-1" },
  async evaluate() {
    return { action: "block", reasonCodes: ["fixture"], approvalEligible: false, redactions: [] };
  },
};

test("daemon activates validated policy before proxy readiness and publishes its identity binding", async () => {
  const calls = [];
  const daemon = await startDaemon({
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
    detectorVersions: { gitleaks: "8.24.0", privacy: "privacy-1" },
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
    startDaemon({
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

test("daemon requires a durable audit recorder before it publishes an identity", async () => {
  const calls = [];
  await assert.rejects(
    startDaemon({
      config,
      paths,
      readPolicyBundle: async () => ({ bundle: {}, publicKey: "pinned-ed25519-public-key" }),
      loadPolicy: async () => policy,
      createScanner: async () => ({ version: "8.24.0", scan: async () => ({ findings: [] }) }),
      createDecisionRecorder: async () => { throw new Error("audit not durable"); },
      startProxy: async () => { calls.push("proxy"); return { origin: "http://127.0.0.1:8811", close: async () => {} }; },
      writePolicyState: async () => calls.push("state"),
      writeIdentity: async () => calls.push("identity"),
    }),
    /audit not durable/,
  );
  assert.deepEqual(calls, []);
});

test("daemon passes its durable decision recorder to the protected proxy", async () => {
  const recorder = { recordShieldDecision: async () => ({ durable: "ack" }) };
  let proxyOptions = null;
  await startDaemon({
    config,
    paths,
    readPolicyBundle: async () => ({ bundle: {}, publicKey: "pinned-ed25519-public-key" }),
    loadPolicy: async () => policy,
    createScanner: async () => ({ version: "8.24.0", scan: async () => ({ findings: [] }) }),
    createDecisionRecorder: async () => recorder,
    writePolicyState: async () => {},
    startProxy: async (options) => { proxyOptions = options; return { origin: "http://127.0.0.1:8811", close: async () => {} }; },
    writeIdentity: async () => {},
  });
  assert.equal(proxyOptions.recordShieldDecision, recorder.recordShieldDecision);
});

test("default daemon recorder requires an audit capability, key, and spare encrypted spool", async () => {
  const recorder = await createDefaultDecisionRecorder({
    env: { AIRKIT_AUDIT_CAPABILITY_FILE: "/private/audit-capability", AIRKIT_AUDIT_SOCKET_PATH: "/private/audit.sock" },
    auditPaths: { rootDir: "/private/audit", spoolDir: "/private/audit/spool", socketPath: "/private/audit.sock" },
    readCapability: async () => "a".repeat(32),
    masterKeyProvider: { get: async () => Buffer.alloc(32, 7) },
    createClient: (options) => ({ async send() { return { status: "committed", event_id: "ignored" }; }, options }),
    createSpool: () => ({ async stats() { return { atCapacity: false }; }, async enqueue() { throw new Error("not reached"); } }),
  });
  assert.equal(typeof recorder.recordShieldDecision, "function");
  await assert.rejects(
    createDefaultDecisionRecorder({
      env: { AIRKIT_AUDIT_CAPABILITY_FILE: "/private/audit-capability" },
      auditPaths: { rootDir: "/private/audit", spoolDir: "/private/audit/spool", socketPath: "/private/audit.sock" },
      readCapability: async () => "a".repeat(32),
      masterKeyProvider: { get: async () => Buffer.alloc(32, 7) },
      createSpool: () => ({ async stats() { return { atCapacity: true }; } }),
    }),
    /spool is at capacity/i,
  );
});

test("daemon normalizes conflicting launcher destination class before policy evaluation", async () => {
  const policyInputs = [];
  const proxyDecisions = [];
  await startDaemon({
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
    startDaemon({
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
  const daemon = await startDaemon({
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

  assert.equal(response.status, 403);
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

test("a dynamic launch lease carries bounded classifier facts into the daemon policy without raw workspace data", async (t) => {
  const workspace = "/private/workspaces/restricted-production-app";
  const upstream = createServer((request, response) => {
    request.resume();
    response.end("must not forward");
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  t.after(() => new Promise((resolve) => upstream.close(resolve)));
  const address = upstream.address();
  const policyInputs = [];
  const managedConfig = { ...config, lane: "managed", targetClass: "managed" };
  delete managedConfig.targetOrigin;
  const daemon = await startDaemon({
    config: managedConfig,
    paths,
    readPolicyBundle: async () => ({ bundle: {}, publicKey: "pinned-ed25519-public-key" }),
    createScanner: async () => ({ version: "8.24.0", scan: async () => ({ findings: [] }) }),
    loadPolicy: async () => ({
      ...policy,
      async evaluate(input) {
        policyInputs.push(input);
        return { action: input.repositoryClass === "restricted" ? "block" : "allow", reasonCodes: ["workspace_policy"], approvalEligible: false, redactions: [] };
      },
    }),
    writePolicyState: async () => {},
    writeIdentity: async () => {},
  });
  t.after(() => daemon.shield.close());
  const context = {
    repository: { remoteHash: createHash("sha256").update(workspace).digest("hex"), trustClass: "restricted" },
    pathClasses: ["production_config"],
    destinationClass: "managed",
    interactive: true,
  };
  const lease = "e".repeat(32);
  const registered = await fetch(`${daemon.shield.origin}/_airkit/shield/destination-lease`, {
    method: "POST",
    headers: { "x-airkit-shield-control": managedConfig.controlCapability, "content-type": "application/json" },
    body: JSON.stringify({ capability: lease, targetOrigin: `http://127.0.0.1:${address.port}`, expiresAt: Date.now() + 30_000, launcherContext: context }),
  });
  assert.equal(registered.status, 204);
  const response = await fetch(`${daemon.shield.origin}/v1/messages`, {
    method: "POST", headers: { "x-airkit-shield": lease }, body: '{"content":"ordinary"}',
  });
  assert.equal(response.status, 403);
  assert.deepEqual(policyInputs, [{
    lane: "managed", destinationClass: "managed", interactive: true, repositoryClass: "restricted",
    pathClasses: ["production_config"], secretFindings: [], piiFindings: [],
  }]);
  assert.doesNotMatch(JSON.stringify({ config: managedConfig, policyInputs }), /restricted-production-app|\/private\/workspaces/);
});

test("missing launcher context reaches policy facts and forwards only after durable audit", async (t) => {
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
  const daemon = await startDaemon({
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

  assert.equal(response.status, 200);
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

test("daemon composes provisioned Privacy findings and sends only a valid policy redaction to the proxy", async () => {
  const policyInputs = [];
  const decisions = [];
  await startDaemon({
    config,
    paths,
    readPolicyBundle: async () => ({ bundle: {}, publicKey: "pinned-ed25519-public-key" }),
    readAssetsProvision: async () => assetsProvision(),
    createPrivacy: async () => ({
      version: "privacy-1",
      async scan() {
        return { status: "ok", findings: [{ label: "email", count: 1 }], redactions: [{ label: "email", count: 1, spans: [{ start: 12, end: 47 }] }], redactedBody: Buffer.from('{"content":"[EMAIL]"}') };
      },
      close() {},
    }),
    createScanner: async () => ({ version: "8.24.0", scan: async () => ({ findings: [] }) }),
    loadPolicy: async () => ({
      version: "2026.09.02.4",
      detectorVersions: { gitleaks: "8.24.0", privacy: "privacy-1" },
      async evaluate(input) {
        policyInputs.push(input);
        return { action: "redact", reasonCodes: ["pii_email_redacted"], approvalEligible: false, redactions: [] };
      },
    }),
    writePolicyState: async () => {},
    startProxy: async ({ decide }) => {
      decisions.push(await decide({ body: Buffer.from('{"content":"privacy-raw-sentinel-must-not-escape"}') }));
      return { origin: "http://127.0.0.1:8811", close: async () => {} };
    },
    writeIdentity: async () => {},
  });

  assert.deepEqual(policyInputs[0].piiFindings, [{ category: "email", count: 1 }]);
  assert.equal(decisions[0].action, "redact");
  assert.deepEqual(decisions[0].redactedBody, Buffer.from('{"content":"[EMAIL]"}'));
  assert.doesNotMatch(JSON.stringify(decisions[0]), /privacy-raw/);
});

test("daemon uses the signed OPA policy to redact a non-email Privacy finding before upstream forwarding", async (t) => {
  let upstreamBody = null;
  const upstream = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      upstreamBody = Buffer.concat(chunks).toString("utf8");
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"ok":true}');
    });
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  t.after(() => new Promise((resolve) => upstream.close(resolve)));
  const address = upstream.address();
  const original = '{"content":"555-0100"}';
  let evaluatedDecision = null;
  const daemon = await startDaemon({
    config: { ...config, targetOrigin: `http://127.0.0.1:${address.port}` },
    paths,
    readPolicyBundle: async () => signedCompiledPolicyBundle(),
    readAssetsProvision: async () => assetsProvision(),
    createPrivacy: async () => ({
      version: "privacy-1",
      async scan() {
        return {
          status: "ok",
          findings: [{ label: "phone", count: 1 }],
          redactions: [{ label: "phone", count: 1, spans: [{ start: 12, end: 20 }] }],
          redactedBody: Buffer.from('{"content":"[PHONE]"}'),
        };
      },
      close() {},
    }),
    createScanner: async () => ({ version: "8.24.0", scan: async () => ({ findings: [] }) }),
    writePolicyState: async () => {},
    writeIdentity: async () => {},
    startProxy: async (options) => startShieldProxy({
      ...options,
      recordShieldDecision: async () => {},
      decide: async (request) => {
        evaluatedDecision = await options.decide(request);
        return evaluatedDecision;
      },
    }),
  });
  t.after(() => daemon.shield.close());

  const response = await fetch(`${daemon.shield.origin}/v1/messages`, {
    method: "POST",
    headers: { "x-airkit-shield": config.capability },
    body: original,
  });

  assert.equal(evaluatedDecision?.action, "redact");
  assert.equal(response.status, 200);
  assert.equal(upstreamBody, '{"content":"[PHONE]"}');
  assert.notEqual(upstreamBody, original);
});

test("daemon blocks every privacy worker failure before a real upstream fetch", async (t) => {
  const failures = [
    { name: "unknown", handle(message, reply) { if (message.type === "health") reply(privacyHealth(message)); else reply({ type: "scan", id: message.id, status: "unknown" }); } },
    { name: "timeout", handle(message, reply) { if (message.type === "health") reply(privacyHealth(message)); } },
    { name: "malformed", handle(message, reply, worker) { if (message.type === "health") reply(privacyHealth(message)); else worker.stdout.emit("data", "not-json\n"); } },
    { name: "exit", handle(message, reply, worker) { if (message.type === "health") reply(privacyHealth(message)); else worker.emit("exit", 1); } },
    { name: "oversized", handle(message, reply, worker) { if (message.type === "health") reply(privacyHealth(message)); else worker.stdout.emit("data", "x".repeat(1_048_577)); } },
  ];
  for (const failure of failures) {
    let upstreamCalls = 0;
    const upstream = createServer((request, response) => { upstreamCalls += 1; request.resume(); response.end("wrong"); });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    t.after(() => new Promise((resolve) => upstream.close(resolve)));
    const address = upstream.address();
    const daemon = await startDaemon({
      config: { ...config, targetOrigin: `http://127.0.0.1:${address.port}` },
      paths,
      readPolicyBundle: async () => ({ bundle: {}, publicKey: "pinned-ed25519-public-key" }),
      readAssetsProvision: async () => assetsProvision(),
      createPrivacy: async ({ provision }) => createPrivacyFilter({
        provision,
        spawnWorker: () => fakePrivacyWorker(failure.handle),
        validateWorker: async () => {},
        timeoutMs: 50,
      }),
      createScanner: async () => ({ version: "8.24.0", scan: async () => ({ findings: [] }) }),
      loadPolicy: async () => ({ version: "2026.09.02.4", detectorVersions: { gitleaks: "8.24.0", privacy: "privacy-1" }, async evaluate() { return { action: "allow", reasonCodes: [], redactions: [] }; } }),
      writePolicyState: async () => {},
      startProxy: async (options) => startShieldProxy({ ...options, recordShieldDecision: async () => {} }),
      writeIdentity: async () => {},
    });
    const response = await fetch(`${daemon.shield.origin}/v1/messages`, { method: "POST", headers: { "x-airkit-shield": config.capability }, body: '{"content":"privacy-raw-sentinel-must-not-escape"}' });
    assert.equal(response.status, 503, failure.name);
    assert.equal(upstreamCalls, 0, failure.name);
    await daemon.shield.close();
    await new Promise((resolve) => upstream.close(resolve));
  }
});

function assetsProvision() {
  return {
    version: 1,
    bundle: { version: "policy-1", sha256: "a".repeat(64), path: "/opt/airkit/policy.json" },
    gitleaks: { sha256: "b".repeat(64), path: "/opt/airkit/gitleaks" },
    privacy: { version: "privacy-1", sha256: "c".repeat(64), path: "/opt/airkit/privacy.json", worker: { command: "/opt/airkit/privacy-worker", args: ["--stdio"], sha256: "d".repeat(64) } },
  };
}

function privacyHealth(message) {
  return { type: "health", id: message.id, protocol: "airkit-privacy-ndjson-v1", version: "privacy-1" };
}

function fakePrivacyWorker(handle) {
  const worker = new EventEmitter();
  worker.stdout = new EventEmitter();
  worker.stderr = new EventEmitter();
  worker.stdin = {
    write(chunk) {
      const message = JSON.parse(String(chunk).trim());
      handle(message, (reply) => worker.stdout.emit("data", `${JSON.stringify(reply)}\n`), worker);
      return true;
    },
    end() {},
  };
  worker.kill = () => worker.emit("exit", 0);
  return worker;
}

function signedCompiledPolicyBundle() {
  const manifest = {
    formatVersion: 1,
    version: "2026.09.02.5",
    opaAbi: "1",
    opaWasmSdkVersion: "1.8.0",
    wasmSha256: createHash("sha256").update(compiledPolicyWasm).digest("hex"),
    detectorVersions: { gitleaks: "8.24.0", privacy: "privacy-1" },
    selfTest: {
      input: {
        lane: "subscription",
        destinationClass: "subscription",
        interactive: false,
        repositoryClass: "public",
        pathClasses: ["source"],
        secretFindings: [],
        piiFindings: [],
      },
      expected: { action: "allow", reasonCodes: [], approvalEligible: false, redactions: [] },
    },
  };
  return {
    bundle: {
      manifest,
      wasm: compiledPolicyWasm,
      signature: sign(null, Buffer.from(canonicalJson(manifest)), compiledPolicyKeyPair.privateKey).toString("base64"),
    },
    publicKey: compiledPolicyKeyPair.publicKey,
  };
}

function startDaemon(options) {
  return startShieldDaemon({
    readAssetsProvision: async () => assetsProvision(),
    createPrivacy: async () => ({ version: "privacy-1", async scan() { return { status: "ok", findings: [], redactions: [] }; }, close() {} }),
    createDecisionRecorder: async () => ({ recordShieldDecision: async () => ({ durable: "ack" }) }),
    ...options,
  });
}
