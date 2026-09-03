import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runCli } from "../src/airkit.mjs";
import { runShieldCli } from "../src/shield/cli.mjs";
import {
  ensureShieldReady,
  inspectShieldService,
  installShieldService,
  launchShieldChild,
  planShieldService,
  readShieldConfig,
  startShieldService,
  stopShieldService,
  transitionShieldPolicy,
} from "../src/shield/service.mjs";
import { invalidateShieldPolicyBinding, shieldPaths, writeShieldConfig, writeShieldIdentity, writeShieldPolicyState } from "../src/shield/paths.mjs";
import { startShieldProxy } from "../src/shield/proxy.mjs";
import { installShieldPolicyProvision } from "../src/shield/policy-bundle.mjs";

const capability = "c".repeat(32);
const generation = "generation-1";
const policyState = { version: "2026.09.02.1", detectorVersions: { gitleaks: "8.24.0", privacy: "privacy-1" } };

function fixture(homeDir = "/tmp/airkit-shield-service-home") {
  const paths = shieldPaths({ homeDir, uid: 501 });
  return {
    paths,
    options: {
      paths,
      nodePath: "/opt/node/bin/node",
      daemonPath: "/opt/airkit/src/shieldd.mjs",
    },
  };
}

function capture() {
  let value = "";
  return { stdout: { write(chunk) { value += String(chunk); } }, value: () => value };
}

test("shield install previews without launchctl mutation", async () => {
  const { options } = fixture();
  const calls = [];
  const io = new Proxy({}, { get: () => async (...args) => calls.push(args) });
  const plan = await installShieldService({ ...options, io, runLaunchctl: async (args) => calls.push(args) });

  assert.equal(plan.label, "com.airkit.shield");
  assert.deepEqual(calls, []);
  assert.match(plan.plistXml, /com\.airkit\.shield/);
  assert.deepEqual(plan.plist.ProgramArguments, [options.nodePath, options.daemonPath, "--config", options.paths.configPath]);
  assert.deepEqual(Object.keys(plan.plist.EnvironmentVariables), []);
});

test("shield privacy provision is preview-first and keeps asset references out of CLI output", async () => {
  const output = capture();
  const calls = [];
  const code = await runShieldCli(["privacy", "provision", "--bundle", "/private/privacy.json", "--gitleaks", "/private/gitleaks"], {
    stdout: output.stdout,
    shield: {
      async privacyProvision(request) { calls.push(request); return { state: "preview", write: request.write }; },
    },
  });
  assert.equal(code, 0);
  assert.deepEqual(calls, [{ bundlePath: "/private/privacy.json", gitleaksPath: "/private/gitleaks", write: false }]);
  assert.match(output.value(), /privacy/);
  assert.doesNotMatch(output.value(), /private/);
});

test("shield policy install is preview-first and hides source paths", async () => {
  const output = capture();
  const calls = [];
  const code = await runShieldCli(["policy", "install", "--bundle", "/private/policy.bundle", "--public-key", "/private/policy.pub"], {
    stdout: output.stdout,
    shield: { async policyInstall(request) { calls.push(request); return { state: "preview", version: "2026.09.02.9" }; } },
  });
  assert.equal(code, 0);
  assert.deepEqual(calls, [{ bundlePath: "/private/policy.bundle", publicKeyPath: "/private/policy.pub", write: false }]);
  assert.match(output.value(), /2026\.09\.02\.9/);
  assert.doesNotMatch(output.value(), /private/);
});

test("shield policy status renders only active metadata", async () => {
  const output = capture();
  const code = await runShieldCli(["policy", "status"], {
    stdout: output.stdout,
    shield: { async policyStatus() { return { state: "healthy", version: "2026.09.02.9", detectorVersions: { gitleaks: "8.24.0", privacy: "privacy-1" } }; } },
  });
  assert.equal(code, 0);
  assert.match(output.value(), /2026\.09\.02\.9/);
  assert.doesNotMatch(output.value(), /private|path|origin|capability/i);
});

test("shield install writes a private plist only with --write semantics", async () => {
  const homeDir = await mkdtemp(join(tmpdir(), "airkit-shield-service-"));
  const { options, paths } = fixture(homeDir);
  const calls = [];
  try {
    await installShieldService({ ...options, write: true, runLaunchctl: async (args) => { calls.push(args); return { ok: true }; } });
    assert.equal((await stat(paths.launchAgentPath)).mode & 0o777, 0o600);
    assert.equal(await stat(paths.configPath).then(() => true, () => false), true);
    assert.equal((await stat(paths.configPath)).mode & 0o777, 0o600);
    const config = JSON.parse(await readFile(paths.configPath, "utf8"));
    assert.deepEqual(config, {
      capability: config.capability,
      controlCapability: config.controlCapability,
      targetOrigin: "https://api.anthropic.com",
      lane: "subscription",
      generation: config.generation,
      targetClass: "subscription",
    });
    assert.deepEqual(await readShieldConfig({ paths }), config);
    assert.match(await readFile(paths.launchAgentPath, "utf8"), /<string>--config<\/string>/);
    assert.deepEqual(calls, [
      ["bootstrap", paths.launchdDomain, paths.launchAgentPath],
      ["kickstart", "-k", paths.launchdTarget],
    ]);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("shield start refuses an uninstalled service without provisioning state", async () => {
  const { options } = fixture();
  const calls = [];
  const missing = Object.assign(new Error("missing"), { code: "ENOENT" });
  await assert.rejects(
    startShieldService({
      ...options,
      io: {
        async readFile() { throw missing; },
        async mkdir(...args) { calls.push(["mkdir", ...args]); },
        async writeFile(...args) { calls.push(["writeFile", ...args]); },
        async chmod(...args) { calls.push(["chmod", ...args]); },
        async rename(...args) { calls.push(["rename", ...args]); },
      },
      runLaunchctl: async (args) => { calls.push(["launchctl", ...args]); return { ok: true }; },
    }),
    /shield install --write/i,
  );
  assert.deepEqual(calls, []);
});

test("stale identity blocks shield launch", async () => {
  const homeDir = await mkdtemp(join(tmpdir(), "airkit-shield-ready-"));
  const { paths } = fixture(homeDir);
  try {
    await writeShieldIdentity({
      paths,
      identity: { origin: "http://127.0.0.1:8811", capability, version: 1, pid: 42, lane: "subscription", generation, targetClass: "subscription", policyVersion: policyState.version, detectorVersions: policyState.detectorVersions },
    });
    await assert.rejects(
      ensureShieldReady({ lane: "subscription", paths, isProcessAlive: async () => false }),
      /shield identity is stale/i,
    );
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("launchd inspection reports only a running service PID as active", async () => {
  const { paths } = fixture();
  const service = await inspectShieldService({
    paths,
    io: { async readFile() { return "plist"; } },
    runLaunchctl: async () => ({ ok: true, stdout: "state = running\npid = 4242\n" }),
  });

  assert.equal(service.loaded, true);
  assert.equal(service.active, true);
  assert.equal(service.pid, 4242);
});

test("lane and configuration generation mismatches reject readiness before probing", async () => {
  const { paths } = fixture();
  const probes = [];
  const identity = {
    origin: "http://127.0.0.1:8811",
    capability,
    version: 1,
    pid: 42,
    lane: "subscription",
    generation,
    targetClass: "subscription",
    policyVersion: policyState.version,
    detectorVersions: policyState.detectorVersions,
  };
  const io = shieldStateIo(paths, {
    identity,
    config: { capability, targetOrigin: "https://api.anthropic.com", lane: "subscription", generation },
  });
  const options = {
    paths,
    io,
    inspectService: async () => ({ loaded: true, active: true, pid: 42 }),
    isProcessAlive: async () => true,
    probeShield: async (...args) => probes.push(args),
  };

  await assert.rejects(ensureShieldReady({ ...options, lane: "managed" }), /lane mismatch/i);
  await assert.rejects(
    ensureShieldReady({ ...options, lane: "subscription", io: shieldStateIo(paths, { identity: { ...identity, generation: "old-generation" }, config: { capability, targetOrigin: "https://api.anthropic.com", lane: "subscription", generation } }) }),
    /generation mismatch/i,
  );
  assert.deepEqual(probes, []);
});

test("readiness binds subscription and managed lanes to the expected target origin", async () => {
  const { paths } = fixture();
  const probes = [];
  const baseIdentity = {
    origin: "http://127.0.0.1:8811",
    capability,
    version: 1,
    pid: 42,
    generation,
    policyVersion: policyState.version,
    detectorVersions: policyState.detectorVersions,
  };
  const readyOptions = {
    paths,
    inspectService: async () => ({ loaded: true, active: true, pid: 42 }),
    isProcessAlive: async () => true,
    probeShield: async (...args) => probes.push(args),
  };

  await assert.rejects(
    ensureShieldReady({
      ...readyOptions,
      lane: "subscription",
      io: shieldStateIo(paths, {
        identity: { ...baseIdentity, lane: "subscription", targetClass: "subscription" },
        config: { capability, targetOrigin: "https://managed.example", lane: "subscription", generation },
      }),
    }),
    /shield target origin mismatch/,
  );
  await assert.rejects(
    ensureShieldReady({
      ...readyOptions,
      expectedTargetOrigin: "http://127.0.0.1:4599/",
      lane: "managed",
      io: shieldStateIo(paths, {
        identity: { ...baseIdentity, lane: "managed", targetClass: "managed" },
        config: { capability, targetOrigin: "http://127.0.0.1:3456", lane: "managed", generation },
      }),
    }),
    /shield target origin mismatch/,
  );
  assert.deepEqual(probes, []);
});

test("launchd PID mismatch and failed authenticated listener probe reject readiness", async () => {
  const { paths } = fixture();
  const identity = {
    origin: "http://127.0.0.1:8811",
    capability,
    version: 1,
    pid: 42,
    lane: "managed",
    generation,
    targetClass: "managed",
    policyVersion: policyState.version,
    detectorVersions: policyState.detectorVersions,
  };
  const io = shieldStateIo(paths, {
    identity,
    config: { capability, targetOrigin: "https://managed.example", lane: "managed", generation },
  });

  await assert.rejects(
    ensureShieldReady({ lane: "managed", paths, io, inspectService: async () => ({ loaded: true, active: true, pid: 41 }), isProcessAlive: async () => true, probeShield: async () => true }),
    /PID mismatch/i,
  );
  await assert.rejects(
    ensureShieldReady({ expectedTargetOrigin: "https://managed.example", lane: "managed", paths, io, inspectService: async () => ({ loaded: true, active: true, pid: 42 }), isProcessAlive: async () => true, probeShield: async () => false }),
    /listener.*readiness/i,
  );
});

test("readiness returns only after the active identity answers the capability probe", async () => {
  const { paths } = fixture();
  const identity = {
    origin: "http://127.0.0.1:8811",
    capability,
    version: 1,
    pid: 42,
    lane: "subscription",
    generation,
    targetClass: "subscription",
    policyVersion: policyState.version,
    detectorVersions: policyState.detectorVersions,
  };
  const probes = [];
  const ready = await ensureShieldReady({
    lane: "subscription",
    paths,
    io: shieldStateIo(paths, {
      identity,
      config: { capability, targetOrigin: "https://api.anthropic.com", lane: "subscription", generation },
    }),
    inspectService: async () => ({ loaded: true, active: true, pid: 42 }),
    isProcessAlive: async () => true,
    probeShield: async (origin, receivedCapability) => {
      probes.push({ origin, capability: receivedCapability });
      return true;
    },
  });

  assert.deepEqual(probes, [{ origin: identity.origin, capability }]);
  assert.deepEqual(ready, {
    origin: identity.origin,
    capability,
    targetClass: "subscription",
    policyVersion: policyState.version,
    detectorVersions: policyState.detectorVersions,
  });
});

test("readiness rejects a daemon identity bound to a stale policy transition before probing", async () => {
  const { paths } = fixture();
  const identity = {
    origin: "http://127.0.0.1:8811",
    capability,
    version: 1,
    pid: 42,
    lane: "subscription",
    generation,
    targetClass: "subscription",
    policyVersion: "2026.09.01.1",
    detectorVersions: policyState.detectorVersions,
  };
  let probes = 0;
  await assert.rejects(
    ensureShieldReady({
      lane: "subscription",
      paths,
      io: shieldStateIo(paths, { identity, config: { capability, targetOrigin: "https://api.anthropic.com", lane: "subscription", generation } }),
      inspectService: async () => ({ loaded: true, active: true, pid: 42 }),
      isProcessAlive: async () => true,
      probeShield: async () => { probes += 1; return true; },
    }),
    /policy version mismatch/i,
  );
  assert.equal(probes, 0);
});

test("policy install quiesces a live old daemon binding until a fresh policy identity is published", async (t) => {
  const homeDir = await mkdtemp(join(tmpdir(), "airkit-shield-policy-transition-"));
  t.after(() => rm(homeDir, { recursive: true, force: true }));
  const paths = shieldPaths({ homeDir, uid: process.getuid?.() ?? 501 });
  const oldIdentity = {
    origin: "http://127.0.0.1:8811", capability, version: 1, pid: 42,
    lane: "subscription", generation, targetClass: "subscription",
    policyVersion: "2026.09.01.1", detectorVersions: policyState.detectorVersions,
  };
  const newState = { version: "2026.09.02.2", detectorVersions: policyState.detectorVersions };
  await writeShieldConfig({ paths, config: { capability, controlCapability: "d".repeat(32), targetOrigin: "https://api.anthropic.com", lane: "subscription", generation } });
  await writeShieldIdentity({ paths, identity: oldIdentity });
  await writeShieldPolicyState({ paths, state: { version: oldIdentity.policyVersion, detectorVersions: oldIdentity.detectorVersions } });
  const sourceDir = join(homeDir, "policy-source");
  await mkdir(sourceDir, { mode: 0o700 });
  const bundlePath = join(sourceDir, "policy.json");
  const publicKeyPath = join(sourceDir, "policy.pub");
  await writeFile(bundlePath, JSON.stringify({ manifest: {}, signature: "aGVsbG8=", wasm: "d2FzbQ==" }), { mode: 0o600 });
  await writeFile(publicKeyPath, "fixture-public-key", { mode: 0o600 });
  await chmod(bundlePath, 0o600);
  await chmod(publicKeyPath, 0o600);

  await installShieldPolicyProvision({ bundlePath, publicKeyPath, write: true, paths, loadPolicy: async () => newState });

  let probes = 0;
  await assert.rejects(
    ensureShieldReady({
      lane: "subscription", paths,
      inspectService: async () => ({ loaded: true, active: true, pid: 42 }),
      isProcessAlive: async () => true,
      probeShield: async () => { probes += 1; return true; },
    }),
    /identity is stale/i,
  );
  assert.equal(probes, 0, "the old live daemon cannot authorize another managed launch");

  await writeShieldPolicyState({ paths, state: newState });
  await writeShieldIdentity({ paths, identity: { ...oldIdentity, policyVersion: newState.version } });
  const ready = await ensureShieldReady({
    lane: "subscription", paths,
    inspectService: async () => ({ loaded: true, active: true, pid: 42 }),
    isProcessAlive: async () => true,
    probeShield: async () => true,
  });
  assert.equal(ready.policyVersion, newState.version);
});

test("policy lifecycle transaction stops a live proxy before activating and binding a replacement", async (t) => {
  const homeDir = await mkdtemp(join(tmpdir(), "airkit-shield-policy-proxy-transition-"));
  t.after(() => rm(homeDir, { recursive: true, force: true }));
  const paths = shieldPaths({ homeDir, uid: process.getuid?.() ?? 501 });
  const controlCapability = "d".repeat(32);
  const oldPolicy = { version: "policy-old", detectorVersions: policyState.detectorVersions };
  const newPolicy = { version: "policy-new", detectorVersions: policyState.detectorVersions };
  let upstreamCalls = 0;
  const upstream = await startServer(async (_request, response) => { upstreamCalls += 1; response.end("ok"); });
  t.after(() => upstream.close());
  let oldProxy = await startShieldProxy({ capability, controlCapability, targetOrigin: upstream.origin, decide: async () => ({ action: "allow", reasonCodes: ["allow"], lane: "subscription", destinationClass: "subscription", bundleVersion: oldPolicy.version, detectorVersions: oldPolicy.detectorVersions }), recordShieldDecision: async () => {} });
  const oldIdentity = { origin: oldProxy.origin, capability, version: 1, pid: 777, lane: "subscription", generation, targetClass: "subscription", policyVersion: oldPolicy.version, detectorVersions: oldPolicy.detectorVersions };
  await writeShieldConfig({ paths, config: { capability, controlCapability, targetOrigin: "https://api.anthropic.com", lane: "subscription", generation } });
  await writeShieldIdentity({ paths, identity: oldIdentity });
  await writeShieldPolicyState({ paths, state: oldPolicy });
  assert.equal((await fetch(`${oldProxy.origin}/v1/messages`, { method: "POST", headers: { "x-airkit-shield": capability }, body: "{}" })).status, 200);
  let activePid = 777;
  let replacement = null;
  const transitions = [];
  const probe = async (origin, receivedCapability) => {
    try { return (await fetch(`${origin}/_airkit/shield/ready`, { headers: { "x-airkit-shield": receivedCapability } })).status === 204; } catch { return false; }
  };
  await transitionShieldPolicy({
    paths,
    installPolicy: async () => { await invalidateShieldPolicyBinding({ paths }); return newPolicy; },
    inspectService: async () => ({ loaded: true, active: activePid > 0, pid: activePid || null }),
    isProcessAlive: async (pid) => pid === activePid,
    probeShield: probe,
    stopService: async () => { await oldProxy.close(); activePid = 0; assert.equal(await probe(oldIdentity.origin, capability), false); },
    startService: async () => {
      replacement = await startShieldProxy({ capability, controlCapability, targetOrigin: upstream.origin, decide: async () => ({ action: "allow", reasonCodes: ["allow"], lane: "subscription", destinationClass: "subscription", bundleVersion: newPolicy.version, detectorVersions: newPolicy.detectorVersions }), recordShieldDecision: async () => {} });
      activePid = 778;
      await writeShieldPolicyState({ paths, state: newPolicy });
      await writeShieldIdentity({ paths, identity: { ...oldIdentity, origin: replacement.origin, pid: activePid, policyVersion: newPolicy.version } });
    },
    recordShieldPolicyTransition: async (transition) => { transitions.push(transition); return { durable: "ack" }; },
  });
  t.after(() => replacement?.close());
  assert.equal(upstreamCalls, 1, "the old proxy forwarded only before the transaction");
  assert.equal((await fetch(`${replacement.origin}/v1/messages`, { method: "POST", headers: { "x-airkit-shield": capability }, body: "{}" })).status, 200);
  assert.equal(upstreamCalls, 2);
  assert.equal(transitions.length, 1);
  assert.equal(transitions[0].action, "transition");
  assert.equal(transitions[0].bundleVersion, newPolicy.version);
});

test("policy lifecycle transaction rejects a launchd respawn before installing", async () => {
  const { paths } = fixture();
  const identity = { origin: "http://127.0.0.1:8811", capability, version: 1, pid: 42, lane: "subscription", generation, targetClass: "subscription", policyVersion: policyState.version, detectorVersions: policyState.detectorVersions };
  let inspections = 0;
  let installs = 0;
  await assert.rejects(transitionShieldPolicy({
    paths,
    io: shieldStateIo(paths, { identity, config: { capability, targetOrigin: "https://api.anthropic.com", lane: "subscription", generation } }),
    inspectService: async () => ++inspections === 1 ? { loaded: true, active: true, pid: 42 } : { loaded: true, active: true, pid: 43 },
    stopService: async () => {}, isProcessAlive: async () => false, probeShield: async () => false,
    installPolicy: async () => { installs += 1; return policyState; },
  }), /could not stop/i);
  assert.equal(installs, 0);
});

test("policy lifecycle transaction rejects an inactive service with a live old identity before install", async () => {
  const { paths } = fixture();
  const identity = { origin: "http://127.0.0.1:8811", capability, version: 1, pid: 42, lane: "subscription", generation, targetClass: "subscription", policyVersion: policyState.version, detectorVersions: policyState.detectorVersions };
  let installs = 0;
  await assert.rejects(transitionShieldPolicy({
    paths,
    io: shieldStateIo(paths, { identity, config: { capability, targetOrigin: "https://api.anthropic.com", lane: "subscription", generation } }),
    inspectService: async () => ({ loaded: true, active: false, pid: null }),
    isProcessAlive: async () => true, probeShield: async () => true,
    installPolicy: async () => { installs += 1; return policyState; },
  }), /live stale daemon/i);
  assert.equal(installs, 0);
});

test("policy lifecycle transaction rejects an inactive service when a dead PID still leaves its old proxy reachable", async () => {
  const { paths } = fixture();
  const identity = { origin: "http://127.0.0.1:8811", capability, version: 1, pid: 42, lane: "subscription", generation, targetClass: "subscription", policyVersion: policyState.version, detectorVersions: policyState.detectorVersions };
  let installs = 0;
  await assert.rejects(transitionShieldPolicy({
    paths,
    io: shieldStateIo(paths, { identity, config: { capability, targetOrigin: "https://api.anthropic.com", lane: "subscription", generation } }),
    inspectService: async () => ({ loaded: true, active: false, pid: null }),
    isProcessAlive: async () => false, probeShield: async () => true,
    installPolicy: async () => { installs += 1; return policyState; },
  }), /proxy remains reachable/i);
  assert.equal(installs, 0);
});

test("readiness rejects an incomplete detector binding before probing", async () => {
  const { paths } = fixture();
  const identity = {
    origin: "http://127.0.0.1:8811", capability, version: 1, pid: 42,
    lane: "subscription", generation, targetClass: "subscription",
    policyVersion: policyState.version, detectorVersions: { gitleaks: "8.24.0" },
  };
  let probes = 0;
  await assert.rejects(
    ensureShieldReady({
      lane: "subscription", paths,
      io: shieldStateIo(paths, { identity, config: { capability, targetOrigin: "https://api.anthropic.com", lane: "subscription", generation }, state: { version: policyState.version, detectorVersions: { gitleaks: "8.24.0" } } }),
      inspectService: async () => ({ loaded: true, active: true, pid: 42 }),
      isProcessAlive: async () => true,
      probeShield: async () => { probes += 1; return true; },
    }),
    /detector.*privacy/i,
  );
  assert.equal(probes, 0);
});

test("start refuses launchd plist path drift before mutating the job", async () => {
  const { options } = fixture();
  const calls = [];
  await assert.rejects(
    startShieldService({
      ...options,
      io: { async readFile() { return "different plist"; } },
      runLaunchctl: async (args) => calls.push(args),
    }),
    /shield launch plist path drift/i,
  );
  assert.deepEqual(calls, []);
});

test("shield stop only unloads its own job and preserves shield state", async () => {
  const { paths } = fixture();
  const calls = [];
  const result = await stopShieldService({ paths, runLaunchctl: async (args) => { calls.push(args); return { ok: true }; } });
  assert.equal(result.stopped, true);
  assert.deepEqual(calls, [["bootout", paths.launchdTarget]]);
});

test("AirKit keeps capability out of argv and injects Claude's Shield transport environment", async () => {
  const calls = [];
  const child = new EventEmitter();
  const outcome = launchShieldChild({
    command: "/usr/bin/env",
    args: ["true"],
    ready: { origin: "http://127.0.0.1:8811", capability, lane: "subscription", targetClass: "subscription" },
    env: {
      ANTHROPIC_API_BASE_URL: "https://stale-provider.invalid",
      ANTHROPIC_BASE_URL: "https://stale-provider.invalid",
      ANTHROPIC_CUSTOM_HEADERS: "x-tenant: fixture\nX-AirKit-Shield: stale-capability",
      CLAUDE_CODE_OAUTH_TOKEN: "subscription-oauth-sentinel",
      PATH: "/usr/bin",
    },
    spawnChild(command, args, options) {
      calls.push({ command, args, options });
      queueMicrotask(() => child.emit("close", 0, null));
      return child;
    },
  });
  assert.deepEqual(await outcome, { code: 0, signal: null });
  assert.deepEqual(calls[0].args, ["true"]);
  assert.equal(calls[0].options.env.ANTHROPIC_API_BASE_URL, "http://127.0.0.1:8811");
  assert.equal(calls[0].options.env.ANTHROPIC_BASE_URL, "http://127.0.0.1:8811");
  assert.equal(
    calls[0].options.env.ANTHROPIC_CUSTOM_HEADERS,
    `x-tenant: fixture\nx-airkit-shield: ${capability}`,
  );
  assert.equal(calls[0].options.env.AIRKIT_SHIELD_CAPABILITY, undefined);
  assert.equal(calls[0].options.env.CLAUDE_CODE_OAUTH_TOKEN, "subscription-oauth-sentinel");
  assert.equal(calls[0].args.includes(capability), false);
  assert.equal(calls[0].options.stdio, "inherit");
});

test("Shield launch rejects a capability that cannot be represented as one custom header", async () => {
  let spawnCalls = 0;

  await assert.rejects(
    launchShieldChild({
      command: "/usr/bin/env",
      args: ["true"],
      ready: {
        origin: "http://127.0.0.1:8811",
        capability: `${capability}\nx-escape: injected`,
        lane: "subscription",
        targetClass: "subscription",
      },
      spawnChild() {
        spawnCalls += 1;
        const child = new EventEmitter();
        queueMicrotask(() => child.emit("close", 0, null));
        return child;
      },
    }),
    /shield capability cannot be represented as an HTTP header/,
  );
  assert.equal(spawnCalls, 0);
});

test("Shield child environment fails closed without a durable decision recorder", async () => {
  let upstreamCalls = 0;
  const upstream = createServer((request, response) => {
    upstreamCalls += 1;
    request.resume();
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"ok":true}');
  });
  upstream.listen(0, "127.0.0.1");
  await new Promise((resolvePromise, reject) => {
    upstream.once("listening", resolvePromise);
    upstream.once("error", reject);
  });
  const upstreamAddress = upstream.address();
  const shield = await startShieldProxy({
    capability,
    controlCapability: "d".repeat(32),
    targetOrigin: `http://127.0.0.1:${upstreamAddress.port}`,
    decide: async () => ({ action: "allow" }),
  });
  const calls = [];
  const child = new EventEmitter();

  try {
    const outcome = launchShieldChild({
      command: "/usr/bin/env",
      args: ["true"],
      ready: { origin: shield.origin, capability, lane: "subscription", targetClass: "subscription" },
      env: {},
      spawnChild(command, args, options) {
        calls.push({ command, args, options });
        queueMicrotask(() => child.emit("close", 0, null));
        return child;
      },
    });
    assert.deepEqual(await outcome, { code: 0, signal: null });
    const childEnv = calls[0].options.env;
    const headers = Object.fromEntries(childEnv.ANTHROPIC_CUSTOM_HEADERS.split("\n").map((line) => {
      const separator = line.indexOf(":");
      return [line.slice(0, separator), line.slice(separator + 1).trim()];
    }));
    const response = await fetch(`${childEnv.ANTHROPIC_BASE_URL}/v1/messages`, {
      body: "{}",
      headers,
      method: "POST",
    });

    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: { code: "shield_unavailable" } });
    assert.equal(upstreamCalls, 0);
  } finally {
    await shield.close();
    await new Promise((resolvePromise) => upstream.close(resolvePromise));
  }
});

test("shield status never displays capability or target metadata", async () => {
  const output = capture();
  const code = await runShieldCli(["status"], {
    stdout: output.stdout,
    shield: {
      async status() {
        return {
          state: "healthy",
          identity: { present: true, origin: "http://127.0.0.1:8811", capability, targetClass: "loopback" },
          service: { installed: true, loaded: true },
        };
      },
    },
  });
  assert.equal(code, 0);
  assert.match(output.value(), /state: healthy/);
  assert.equal(output.value().includes(capability), false);
  assert.equal(output.value().includes("127.0.0.1"), false);
  assert.equal(output.value().includes("loopback"), false);
});

test("shield launch CLI requires a lane and command boundary", async () => {
  await assert.rejects(
    runShieldCli(["launch", "--lane", "subscription", "echo", "unsafe"], { shield: {} }),
    /usage: shield launch --lane subscription\|managed -- command/i,
  );
});

test("shield install applies lifecycle only with --write", async () => {
  const calls = [];
  const output = capture();
  const code = await runShieldCli(["install", "--write"], {
    stdout: output.stdout,
    shield: {
      async install(options) {
        calls.push(options);
        return { state: "degraded", write: options.write };
      },
    },
  });
  assert.equal(code, 1);
  assert.deepEqual(calls, [{ write: true }]);
});

test("airkit routes shield commands before catalog loading", async () => {
  const output = capture();
  const code = await runCli(["shield", "status"], {
    stdout: output.stdout,
    shield: {
      async status() {
        return { state: "healthy", service: { installed: true, loaded: true } };
      },
    },
    catalogPath: "/does/not/exist.json",
  });
  assert.equal(code, 0);
  assert.match(output.value(), /state: healthy/);
});

test("airkit shield install preview exits zero, names the service, and performs no mutation", async () => {
  const { paths, options } = fixture();
  const output = capture();
  const calls = [];
  const io = new Proxy({}, { get: () => async (...args) => calls.push(args) });
  const code = await runCli(["shield", "install"], {
    stdout: output.stdout,
    paths,
    nodePath: options.nodePath,
    daemonPath: options.daemonPath,
    io,
    runLaunchctl: async (args) => calls.push(args),
    catalogPath: "/does/not/exist.json",
  });

  assert.equal(code, 0);
  assert.match(output.value(), /com\.airkit\.shield/);
  assert.deepEqual(calls, []);
});

function shieldStateIo(paths, { identity, config, state = policyState }) {
  const storedConfig = { ...config, controlCapability: config.controlCapability ?? "d".repeat(32) };
  return {
    async lstat(path) {
      if (path === paths.policyStatePath) {
        return {
          uid: process.getuid?.(),
          mode: 0o600,
          isFile: () => true,
          isSymbolicLink: () => false,
        };
      }
      throw new Error(`unexpected fixture stat path: ${path}`);
    },
    async readFile(path) {
      if (path === paths.identityPath) return `${JSON.stringify(identity)}\n`;
      if (path === paths.configPath) return `${JSON.stringify(storedConfig)}\n`;
      if (path === paths.policyStatePath) return `${JSON.stringify(state)}\n`;
      throw new Error(`unexpected fixture path: ${path}`);
    },
  };
}

async function startServer(handler) {
  const server = createServer((request, response) => void handler(request, response));
  server.listen(0, "127.0.0.1");
  await new Promise((resolvePromise, reject) => { server.once("listening", resolvePromise); server.once("error", reject); });
  const address = server.address();
  return { origin: `http://127.0.0.1:${address.port}`, close: () => new Promise((resolvePromise) => server.close(resolvePromise)) };
}
