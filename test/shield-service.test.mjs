import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
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
  resolveShieldRoot,
  startShieldService,
  stopShieldService,
  uninstallShieldService,
  transitionShieldPolicy,
} from "../src/shield/service.mjs";
import { invalidateShieldPolicyBinding, shieldPaths, writeShieldConfig, writeShieldIdentity, writeShieldPolicyState } from "../src/shield/paths.mjs";
import { startShieldProxy } from "../src/shield/proxy.mjs";
import { readShieldIdentity } from "../src/shield/paths.mjs";
import { readShieldOperationalStatus } from "../src/shield/operational-status.mjs";
import { installShieldPolicyProvision } from "../src/shield/policy-bundle.mjs";
import { CCSHIELD_CAPABILITY, CCSHIELD_CONTROL_CAPABILITY, ccshieldService, startCcshieldFixture } from "./fixtures/ccshield-daemon.mjs";

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

  assert.equal(plan.label, "com.airkit.shield.subscription");
  assert.deepEqual(calls, []);
  assert.match(plan.plistXml, /com\.airkit\.shield/);
  assert.deepEqual(plan.plist.ProgramArguments, [options.nodePath, options.daemonPath, "--config", options.paths.configPath]);
  assert.deepEqual(Object.keys(plan.plist.EnvironmentVariables), []);
  assert.equal(plan.plist.ProcessType, "Standard");
  assert.match(plan.plistXml, /<key>ProcessType<\/key>\s*<string>Standard<\/string>/);
});

test("shield privacy provision is preview-first and keeps asset references out of CLI output", async () => {
  const output = capture();
  const calls = [];
  const code = await runShieldCli(["privacy", "provision", "--bundle", "/private/privacy.json", "--gitleaks", "/private/gitleaks", "--gitleaks-rules", "/private/rules.toml"], {
    stdout: output.stdout,
    shield: {
      async privacyProvision(request) { calls.push(request); return { state: "preview", write: request.write }; },
    },
  });
  assert.equal(code, 0);
  assert.deepEqual(calls, [{ bundlePath: "/private/privacy.json", gitleaksPath: "/private/gitleaks", gitleaksRulesPath: "/private/rules.toml", lane: "subscription", write: false }]);
  await assert.rejects(
    runShieldCli(["privacy", "provision", "--bundle", "/private/privacy.json", "--gitleaks", "/private/gitleaks"], { stdout: capture().stdout, shield: {} }),
    /usage: shield privacy provision/i,
  );
  assert.match(output.value(), /privacy/);
  assert.doesNotMatch(output.value(), /private/);
});

test("clean-lane privacy preview accepts its explicit policy bundle without persisted policy state", async () => {
  const calls = [];
  await runShieldCli([
    "privacy", "provision", "--lane", "managed",
    "--policy-bundle", "/private/policy.json",
    "--bundle", "/private/privacy.json", "--gitleaks", "/private/gitleaks", "--gitleaks-rules", "/private/rules.toml",
  ], {
    stdout: capture().stdout,
    shield: { async privacyProvision(request) { calls.push(request); return { state: "preview" }; } },
  });
  assert.deepEqual(calls, [{
    lane: "managed", write: false, policyBundlePath: "/private/policy.json",
    bundlePath: "/private/privacy.json", gitleaksPath: "/private/gitleaks", gitleaksRulesPath: "/private/rules.toml",
  }]);
});

test("shield policy install is preview-first and hides source paths", async () => {
  const output = capture();
  const calls = [];
  const code = await runShieldCli(["policy", "install", "--bundle", "/private/policy.bundle", "--public-key", "/private/policy.pub"], {
    stdout: output.stdout,
    shield: { async policyInstall(request) { calls.push(request); return { state: "preview", version: "2026.09.02.9" }; } },
  });
  assert.equal(code, 0);
  assert.deepEqual(calls, [{ bundlePath: "/private/policy.bundle", publicKeyPath: "/private/policy.pub", lane: "subscription", write: false }]);
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

test("shield start tolerates a service install already bootstrapped but still requires a live kickstart", async () => {
  const homeDir = await mkdtemp(join(tmpdir(), "airkit-shield-restart-"));
  const { options, paths } = fixture(homeDir);
  try {
    await installShieldService({ ...options, write: true, runLaunchctl: async () => ({ ok: true }) });
    const alreadyLoaded = { ok: false, status: 5, stdout: "", stderr: "Bootstrap failed: 5: Input/output error\n" };
    const calls = [];
    await startShieldService({
      ...options,
      runLaunchctl: async (args) => { calls.push(args[0]); return args[0] === "bootstrap" ? alreadyLoaded : { ok: true }; },
    });
    assert.deepEqual(calls, ["bootstrap", "kickstart"]);
    await assert.rejects(
      startShieldService({ ...options, runLaunchctl: async () => alreadyLoaded }),
      /launchctl kickstart failed/i,
    );
    assert.ok(paths.launchAgentPath);
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
  assert.equal(calls.length, 0);
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

test("readiness keeps subscription fixed and rejects persisted managed targets", async () => {
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
      lane: "managed",
      io: shieldStateIo(paths, {
        identity: { ...baseIdentity, lane: "managed", targetClass: "managed" },
        config: { capability, targetOrigin: "http://127.0.0.1:3456", lane: "managed", generation },
      }),
    }),
    /managed configuration must not persist/,
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
    config: { capability, lane: "managed", generation },
  });

  await assert.rejects(
    ensureShieldReady({ lane: "managed", paths, io, inspectService: async () => ({ loaded: true, active: true, pid: 41 }), isProcessAlive: async () => true, probeShield: async () => true }),
    /PID mismatch/i,
  );
  await assert.rejects(
    ensureShieldReady({ lane: "managed", paths, io, inspectService: async () => ({ loaded: true, active: true, pid: 42 }), isProcessAlive: async () => true, probeShield: async () => false }),
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
    lane: "subscription",
    targetClass: "subscription",
    policyVersion: policyState.version,
    detectorVersions: policyState.detectorVersions,
    paths,
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

test("offline policy transition durably records its replacement before returning", async () => {
  const { paths } = fixture();
  const recorded = [];
  const installed = { version: "2026.09.03.1", detectorVersions: policyState.detectorVersions };
  const result = await transitionShieldPolicy({
    paths,
    io: { readFile: async () => { throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); } },
    installPolicy: async () => installed,
    inspectService: async () => ({ active: false }),
    isProcessAlive: async () => { throw new Error("offline transition must not probe a process"); },
    probeShield: async () => { throw new Error("offline transition must not probe a proxy"); },
    startService: async () => { throw new Error("offline transition must not start the daemon"); },
    ensureReady: async () => { throw new Error("offline transition must not bind a daemon"); },
    recordShieldPolicyTransition: async (event) => { recorded.push(event); return { durable: "ack" }; },
  });
  assert.equal(result, installed);
  assert.deepEqual(recorded, [{
    requestId: recorded[0].requestId,
    lane: "subscription", destinationClass: "subscription", bundleVersion: "2026.09.03.1",
    detectorVersions: policyState.detectorVersions, action: "transition", reasonCodes: ["policy_replaced"],
    transformCount: 0, override: false, elapsedMs: 0,
  }]);
  assert.match(recorded[0].requestId, /^policy-[0-9a-f]{32}$/);
});

test("offline policy transition fails closed when the durable recorder rejects", async () => {
  const { paths } = fixture();
  await assert.rejects(transitionShieldPolicy({
    paths,
    io: { readFile: async () => { throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); } },
    installPolicy: async () => ({ version: "2026.09.03.1", detectorVersions: policyState.detectorVersions }),
    inspectService: async () => ({ active: false }),
    recordShieldPolicyTransition: async () => { throw new Error("audit spool is unavailable"); },
  }), /audit spool is unavailable/);
});

test("policy install --write reaches the durable recorder on an inactive lane", async () => {
  const home = await mkdtemp(join(tmpdir(), "airkit-shield-offline-policy-"));
  const recorded = [];
  try {
    const code = await runShieldCli(["policy", "install", "--bundle", "/tmp/p", "--public-key", "/tmp/k", "--write"], {
      env: { HOME: home },
      stdout: capture().stdout,
      runLaunchctl: async () => ({ ok: false, stdout: "", stderr: "could not find service" }),
      installShieldPolicyProvision: async () => ({ version: "2026.09.03.1", detectorVersions: policyState.detectorVersions }),
      createDecisionRecorder: async () => ({
        recordShieldPolicyTransition: async (event) => { recorded.push(event); return { durable: "ack" }; },
      }),
    });
    assert.equal(code, 1);
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0].action, "transition");
    assert.equal(recorded[0].lane, "subscription");
    assert.equal(recorded[0].destinationClass, "subscription");
    assert.deepEqual(recorded[0].reasonCodes, ["policy_replaced"]);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("policy install --write refuses to replace policy without a durable recorder", async () => {
  const home = await mkdtemp(join(tmpdir(), "airkit-shield-offline-policy-norecorder-"));
  let installs = 0;
  try {
    await assert.rejects(runShieldCli(["policy", "install", "--bundle", "/tmp/p", "--public-key", "/tmp/k", "--write"], {
      env: { HOME: home },
      stdout: capture().stdout,
      runLaunchctl: async () => ({ ok: false, stdout: "", stderr: "could not find service" }),
      installShieldPolicyProvision: async ({ write }) => { if (write) installs += 1; return { version: "v", detectorVersions: {} }; },
      createDecisionRecorder: async () => ({}),
    }), /audit recorder is unavailable/);
    assert.equal(installs, 0);
  } finally { await rm(home, { recursive: true, force: true }); }
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
  assert.equal(calls.length, 0);
});

test("shield stop only unloads its own job and preserves shield state", async () => {
  const { paths } = fixture();
  const calls = [];
  const result = await stopShieldService({ paths, runLaunchctl: async (args) => { calls.push(args); return { ok: true }; } });
  assert.equal(result.stopped, true);
  assert.deepEqual(calls, [["bootout", paths.launchdTarget]]);
});

test("shield uninstall previews, then removes only its own LaunchAgent and keeps lane state", async () => {
  const { paths } = fixture();
  const plist = renderedPlist(paths.serviceLabel);
  const calls = [];
  const unlinked = [];
  const io = {
    async lstat(path) { assert.equal(path, paths.launchAgentPath); return { isFile: () => true, uid: 501 }; },
    async readFile() { return plist; },
    async unlink(path) { unlinked.push(path); },
  };
  const runLaunchctl = async (args) => { calls.push(args); return { ok: true }; };
  const preview = await uninstallShieldService({ paths, io, runLaunchctl, uid: 501 });
  assert.deepEqual({ installed: preview.installed, removed: preview.removed }, { installed: true, removed: false });
  assert.deepEqual(preview.operations.map((entry) => entry.op), ["bootout", "unlink"]);
  assert.deepEqual([calls, unlinked], [[], []]);
  const result = await uninstallShieldService({ paths, io, runLaunchctl, uid: 501, write: true });
  assert.equal(result.removed, true);
  assert.deepEqual(calls, [["bootout", paths.launchdTarget]]);
  assert.deepEqual(unlinked, [paths.launchAgentPath]);
});

test("shield uninstall is a no-op when absent and refuses plists it does not own", async () => {
  const { paths } = fixture();
  const calls = [];
  const runLaunchctl = async (args) => { calls.push(args); return { ok: true }; };
  const unlink = async () => { throw new Error("must not unlink"); };
  const missing = { async lstat() { throw Object.assign(new Error("missing"), { code: "ENOENT" }); }, unlink };
  assert.equal((await uninstallShieldService({ paths, runLaunchctl, uid: 501, io: missing })).installed, false);
  assert.deepEqual(calls, [], "preview never unloads");
  const absent = await uninstallShieldService({ paths, runLaunchctl, write: true, uid: 501, io: missing });
  assert.deepEqual({ installed: absent.installed, removed: absent.removed }, { installed: false, removed: false });
  assert.deepEqual(calls.splice(0), [["bootout", paths.launchdTarget]], "a hand-deleted plist can leave its job loaded");
  const owned = { async lstat() { return { isFile: () => true, uid: 501 }; }, async readFile() { return renderedPlist(paths.serviceLabel); }, unlink };
  await assert.rejects(uninstallShieldService({ paths, runLaunchctl, write: true, uid: 502, io: owned }), /is not this user's gui\/502/);
  await assert.rejects(uninstallShieldService({ paths, write: true, uid: 501, io: owned,
    runLaunchctl: async () => ({ ok: false, stderr: "Boot-out failed: 1: Operation not permitted" }) }), /launchctl bootout failed: Boot-out failed: 1: Operation not permitted/,
    "an untolerated bootout failure keeps the plist so a rerun can finish");
  for (const [stat, plist, pattern] of [
    [{ isFile: () => false, uid: 501 }, renderedPlist(paths.serviceLabel), /not a regular file/],
    [{ isFile: () => true, uid: 0 }, renderedPlist(paths.serviceLabel), /not a regular file owned by this user/],
    [{ isFile: () => true, uid: 501 }, renderedPlist("com.example.other"), /does not belong/],
    [{ isFile: () => true, uid: 501 }, "not a plist", /does not belong/],
  ]) {
    await assert.rejects(uninstallShieldService({ paths, runLaunchctl, write: true, uid: 501,
      io: { async lstat() { return stat; }, async readFile() { return plist; }, unlink } }), pattern);
  }
  assert.deepEqual(calls, []);
});

function renderedPlist(label) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0">\n<dict>\n  <key>Label</key>\n  <string>${label}</string>\n</dict>\n</plist>\n`;
}

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
      CLAUDE_AGENT_API_BASE_URL: "https://stale-provider.invalid",
      ANTHROPIC_CUSTOM_HEADERS: "x-tenant: fixture\nX-AirKit-Shield: stale-capability\nx-airkit-shield-launch: ffffffffffffffffffffffffffffffff",
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
  assert.equal(calls[0].options.env.CLAUDE_AGENT_API_BASE_URL, "http://127.0.0.1:8811");
  assert.match(
    calls[0].options.env.ANTHROPIC_CUSTOM_HEADERS,
    new RegExp(`^x-tenant: fixture\\nx-airkit-shield: ${capability}\\nx-airkit-shield-launch: [0-9a-f]{32}$`),
  );
  assert.equal(calls[0].options.env.ANTHROPIC_CUSTOM_HEADERS.includes("f".repeat(32)), false);
  assert.equal(calls[0].options.env.AIRKIT_SHIELD_CAPABILITY, undefined);
  assert.equal(calls[0].options.env.CLAUDE_CODE_OAUTH_TOKEN, "subscription-oauth-sentinel");
  assert.equal(calls[0].args.includes(capability), false);
  assert.equal(calls[0].options.stdio, "inherit");
});

test("Shield child refuses Claude settings that redirect around its transport", async () => {
  let spawned = false;
  await assert.rejects(
    launchShieldChild({
      command: "/usr/bin/env",
      args: ["--settings", '{"env":{"CLAUDE_AGENT_API_BASE_URL":"http://127.0.0.1:4599"}}'],
      ready: { origin: "http://127.0.0.1:8811", capability, lane: "subscription", targetClass: "subscription" },
      spawnChild() { spawned = true; },
    }),
    /Shield launch settings cannot override.*CLAUDE_AGENT_API_BASE_URL/i,
  );
  assert.equal(spawned, false);
});

test("Shield child refuses persisted Claude settings that redirect around its transport", async () => {
  const home = await mkdtemp(join(tmpdir(), "airkit-shield-persisted-settings-"));
  let spawned = false;
  try {
    await mkdir(join(home, ".claude"), { recursive: true });
    await writeFile(join(home, ".claude", "settings.json"), JSON.stringify({
      env: { CLAUDE_AGENT_API_BASE_URL: "http://127.0.0.1:4599" },
    }));
    await assert.rejects(
      launchShieldChild({
        command: "/usr/bin/env",
        args: ["true"],
        env: { HOME: home, CLAUDE_CONFIG_DIR: join(home, ".claude") },
        ready: { origin: "http://127.0.0.1:8811", capability, lane: "subscription", targetClass: "subscription" },
        spawnChild() { spawned = true; },
      }),
      /Shield launch settings cannot override.*CLAUDE_AGENT_API_BASE_URL/i,
    );
    assert.equal(spawned, false);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
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
    /usage: shield launch --lane subscription\|managed .*-- command/i,
  );
});

test("managed shield CLI launch fails closed without an AirKit destination lease", async () => {
  await assert.rejects(
    runShieldCli(["launch", "--lane", "managed", "--", "echo", "unsafe"], { shield: { async launch() { throw new Error("managed Shield launch requires AirKit lease lifecycle"); } } }),
    /requires AirKit lease lifecycle/i,
  );
});

test("subscription shield CLI accepts only an explicit loopback dynamic target", async () => {
  const calls = [];
  await runShieldCli(["launch", "--lane", "subscription", "--target", "http://127.0.0.1:8804", "--", "echo", "ok"], {
    stdout: capture().stdout,
    shield: { async launch(options) { calls.push(options); return { state: "healthy", exitCode: 0 }; } },
  });
  assert.equal(calls[0].targetOrigin, "http://127.0.0.1:8804");
  for (const target of ["https://127.0.0.1:8804", "http://localhost:8804", "http://127.0.0.1", "http://example.com:80"]) {
    await assert.rejects(runShieldCli(["launch", "--lane", "subscription", "--target", target, "--", "echo", "no"], { shield: {} }), /usage: shield launch/i);
  }
});

test("subscription --pxpipe launch points Shield at a pxpipe hop and closes it with the lease", async () => {
  const events = [];
  await runShieldCli(["launch", "--lane", "subscription", "--pxpipe", "--", "echo", "ok"], {
    stdout: capture().stdout,
    ensureShieldReady: async () => ({ origin: "http://127.0.0.1:8811", capability: "a".repeat(32), lane: "subscription", targetClass: "subscription" }),
    startPxpipeHop: async ({ upstream }) => {
      events.push(`hop:${upstream}`);
      return { origin: "http://127.0.0.1:8805", async close() { events.push("hop-close"); } };
    },
    createShieldDestinationLease: async ({ ready, targetOrigin }) => { events.push(`create:${targetOrigin}`); return ready; },
    renewShieldDestinationLease: async () => true,
    revokeShieldDestinationLease: async () => events.push("revoke"),
    shieldLeaseSetInterval: () => ({ unref() {} }),
    shieldLeaseClearInterval: () => {},
    launchShieldChild: async () => { events.push("child-exit"); return { code: 0 }; },
  });
  assert.deepEqual(events, ["hop:https://api.anthropic.com", "create:http://127.0.0.1:8805", "child-exit", "revoke", "hop-close"]);
});

async function launchWithGlobalSettings({ lane = "subscription", command = "claude", args = ["-p", "hi"], settings, env = { HOME: "/airkit-test-home" } }) {
  const launched = [];
  const reads = [];
  const stderr = capture();
  await runShieldCli(["launch", "--lane", lane, "--", command, ...args], {
    env,
    stdout: capture().stdout,
    stderr: stderr.stdout,
    readGlobalSettings: async (path) => { reads.push(path); return JSON.stringify(settings); },
    ensureShieldReady: async () => ({ origin: "http://127.0.0.1:8811", capability: "a".repeat(32), lane, targetClass: lane }),
    revokeShieldDestinationLease: async () => {},
    launchShieldChild: async (options) => { launched.push(options); return { code: 0 }; },
  });
  return { args: launched[0].args, reads, warning: stderr.value() };
}

test("subscription launch overrides a CCR route id saved as the shared default /model", async () => {
  const result = await launchWithGlobalSettings({ settings: { model: "anthropic/claude-ccr-h6169726b" } });
  assert.deepEqual(result.args, ["--model", "default", "-p", "hi"]);
  assert.deepEqual(result.reads, ["/airkit-test-home/.claude/settings.json"]);
  assert.match(result.warning, /\/airkit-test-home\/\.claude\/settings\.json sets "model": "anthropic\/claude-ccr-h6169726b"/);
  assert.match(result.warning, /remove the "model" key/);
});

test("subscription launch leaves real models, explicit --model and non-Claude commands alone", async () => {
  const real = await launchWithGlobalSettings({ settings: { model: "opus[1m]" } });
  assert.deepEqual(real.args, ["-p", "hi"]);
  assert.equal(real.warning, "");

  const explicit = await launchWithGlobalSettings({ args: ["--model", "sonnet"], settings: { model: "claude-airkit-mode[1m]" } });
  assert.deepEqual(explicit.args, ["--model", "sonnet"]);
  assert.deepEqual(explicit.reads, []);

  const other = await launchWithGlobalSettings({ command: "echo", args: ["ok"], settings: { model: "claude-airkit-mode[1m]" } });
  assert.deepEqual(other.args, ["ok"]);
  assert.deepEqual(other.reads, []);
});

test("shield doctor warns when the shared Claude settings pin a CCR-only model", async () => {
  const output = capture();
  await runShieldCli(["doctor", "--lane", "subscription"], {
    env: { HOME: "/airkit-test-home" },
    stdout: output.stdout,
    readGlobalSettings: async () => JSON.stringify({ model: "anthropic/claude-ccr-h6169726b" }),
    shieldStatus: async () => ({ state: "healthy", service: { active: true }, identity: { present: true } }),
    readShieldOperationalStatus: async () => ({ state: "protected", lanes: [{ lane: "subscription", state: "protected" }] }),
    readAuditHealth: async () => "healthy",
  });
  assert.match(output.value(), /globalModel\.warning: \/airkit-test-home\/\.claude\/settings\.json sets "model": "anthropic\/claude-ccr-h6169726b"/);
  assert.match(output.value(), /any launch without --model would request it/);
});

test("--pxpipe is subscription-only and excludes --target", async () => {
  await assert.rejects(runShieldCli(["launch", "--lane", "managed", "--pxpipe", "--", "echo", "no"], { shield: {} }), /lease lifecycle/);
  await assert.rejects(runShieldCli(["launch", "--lane", "subscription", "--pxpipe", "--target", "http://127.0.0.1:8804", "--", "echo", "no"], { shield: {} }), /not both/);
});

test("subscription --pxpipe closes the hop when the lease cannot be created", async () => {
  let closed = false;
  await assert.rejects(runShieldCli(["launch", "--lane", "subscription", "--pxpipe", "--", "echo", "no"], {
    stdout: capture().stdout,
    ensureShieldReady: async () => ({ origin: "http://127.0.0.1:8811", capability: "a".repeat(32), lane: "subscription", targetClass: "subscription" }),
    startPxpipeHop: async () => ({ origin: "http://127.0.0.1:8805", async close() { closed = true; } }),
    createShieldDestinationLease: async () => { throw new Error("lease refused"); },
  }), /lease refused/);
  assert.equal(closed, true);
});

test("subscription target launch renews its lease until its foreground child exits", async () => {
  const intervals = [];
  const cleared = [];
  const events = [];
  await runShieldCli(["launch", "--lane", "subscription", "--target", "http://127.0.0.1:8804", "--", "echo", "ok"], {
    stdout: capture().stdout,
    ensureShieldReady: async () => ({ origin: "http://127.0.0.1:8811", capability: "a".repeat(32), lane: "subscription", targetClass: "subscription" }),
    createShieldDestinationLease: async ({ ready, targetOrigin }) => {
      events.push(`create:${targetOrigin}`);
      return { ...ready, capability: "b".repeat(32) };
    },
    renewShieldDestinationLease: async ({ ready, targetOrigin }) => {
      events.push(`renew:${ready.capability}:${targetOrigin}`);
      return true;
    },
    revokeShieldDestinationLease: async ({ ready }) => events.push(`revoke:${ready.capability}`),
    shieldLeaseSetInterval: (callback, delay) => {
      assert.equal(delay, 15_000);
      const timer = { unref() {} };
      intervals.push({ callback, timer });
      return timer;
    },
    shieldLeaseClearInterval: (timer) => cleared.push(timer),
    launchShieldChild: async () => {
      assert.equal(intervals.length, 1);
      await intervals[0].callback();
      events.push("child-exit");
      return { code: 0 };
    },
  });
  assert.deepEqual(events, [
    "create:http://127.0.0.1:8804",
    `renew:${"b".repeat(32)}:http://127.0.0.1:8804`,
    "child-exit",
    `revoke:${"b".repeat(32)}`,
  ]);
  assert.deepEqual(cleared, [intervals[0].timer]);
});

test("subscription target launch retains its lease while a matching background host remains", async () => {
  const intervals = [];
  const checks = [];
  const cleared = [];
  const events = [];
  let active = true;
  await runShieldCli(["launch", "--lane", "subscription", "--target", "http://127.0.0.1:8804", "--", "echo", "ok"], {
    stdout: capture().stdout,
    ensureShieldReady: async () => ({ origin: "http://127.0.0.1:8811", capability: "a".repeat(32), lane: "subscription", targetClass: "subscription" }),
    createShieldDestinationLease: async ({ ready }) => ({ ...ready, capability: "b".repeat(32) }),
    renewShieldDestinationLease: async () => events.push("renew"),
    revokeShieldDestinationLease: async () => events.push("revoke"),
    shieldLeaseSetInterval: (callback) => {
      const timer = { unref() {} };
      intervals.push({ callback, timer });
      return timer;
    },
    shieldLeaseClearInterval: (timer) => cleared.push(timer),
    backgroundHostDetector: async (origin) => {
      assert.equal(origin, "http://127.0.0.1:8811");
      return active;
    },
    backgroundMiddlewareGraceMs: 1_000,
    backgroundSetTimeout: (callback) => {
      checks.push(callback);
      return { unref() {} };
    },
    launchShieldChild: async () => ({ code: 0 }),
  });
  assert.equal(intervals.length, 1);
  assert.equal(checks.length, 1);
  assert.deepEqual(events, []);
  await intervals[0].callback();
  assert.deepEqual(events, ["renew"]);
  active = false;
  await checks[0]();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["renew", "revoke"]);
  assert.deepEqual(cleared, [intervals[0].timer]);
});

test("sequential interactive Shield children unregister each approval channel before the next launch", async () => {
  const ready = { origin: "http://127.0.0.1:8811", capability: "c".repeat(32), lane: "subscription", targetClass: "subscription" };
  const events = [];
  const channels = [
    { socketPath: "/tmp/approval-one.sock", capability: "a".repeat(32), async close() { events.push("close:one"); } },
    { socketPath: "/tmp/approval-two.sock", capability: "b".repeat(32), async close() { events.push("close:two"); } },
  ];
  for (const channel of channels) {
    await launchShieldChild({
      command: "echo",
      ready,
      createApprovalChannel: async () => channel,
      registerApprovalChannel: async ({ channel: registered }) => events.push(`register:${registered.socketPath}`),
      unregisterApprovalChannel: async () => events.push("unregister"),
      spawnChild: () => {
        const child = new EventEmitter();
        queueMicrotask(() => child.emit("close", 0, null));
        return child;
      },
    });
  }
  assert.deepEqual(events, [
    "register:/tmp/approval-one.sock", "unregister", "close:one",
    "register:/tmp/approval-two.sock", "unregister", "close:two",
  ]);
});

test("each Shield launch registers, routes, and unregisters its own fresh launch id", async () => {
  const ready = { origin: "http://127.0.0.1:8811", capability: "c".repeat(32), lane: "subscription", targetClass: "subscription" };
  const launches = [];
  for (let index = 0; index < 2; index += 1) {
    const seen = {};
    await launchShieldChild({
      command: "echo",
      ready,
      env: { PATH: "/usr/bin" },
      createApprovalChannel: async () => ({ socketPath: `/tmp/approval-${index}.sock`, capability: "a".repeat(32), async close() {} }),
      registerApprovalChannel: async ({ launchId }) => { seen.registered = launchId; },
      unregisterApprovalChannel: async ({ launchId }) => { seen.unregistered = launchId; },
      spawnChild: (_command, _args, options) => {
        seen.header = /^x-airkit-shield-launch: (.*)$/m.exec(options.env.ANTHROPIC_CUSTOM_HEADERS)?.[1];
        const child = new EventEmitter();
        queueMicrotask(() => child.emit("close", 0, null));
        return child;
      },
    });
    launches.push(seen);
  }
  for (const seen of launches) {
    assert.match(seen.registered, /^[0-9a-f]{32}$/);
    assert.equal(seen.unregistered, seen.registered);
    assert.equal(seen.header, seen.registered);
  }
  assert.notEqual(launches[0].registered, launches[1].registered);
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
  assert.deepEqual(calls, [{ write: true, lane: "subscription" }]);
});

test("shield install requires an explicit valid lane and passes it to provisioning", async () => {
  const calls = [];
  await runShieldCli(["install", "--lane", "managed", "--write"], {
    stdout: capture().stdout,
    shield: { async install(options) { calls.push(options); return { state: "degraded", write: true, lane: options.lane }; } },
  });
  assert.deepEqual(calls, [{ write: true, lane: "managed" }]);
  await assert.rejects(runShieldCli(["install", "--lane", "unknown"], { shield: {} }), /usage: shield install/i);
});

test("shield lifecycle commands pass the selected lane without sharing subscription state", async () => {
  const calls = [];
  await runShieldCli(["status", "--lane", "managed"], { stdout: capture().stdout, shield: { async status(options) { calls.push(options); return { state: "stopped" }; } } });
  assert.deepEqual(calls, [{ lane: "managed" }]);
  await assert.rejects(runShieldCli(["doctor", "--lane", "invalid"], { shield: {} }), /usage: shield doctor/i);
});

test("managed install parses through the CLI and binds same-lane verified provisions", async () => {
  const home = await mkdtemp(join(tmpdir(), "airkit-shield-cli-"));
  const calls = [];
  try {
    await runShieldCli(["install", "--lane", "managed"], {
      env: { HOME: home }, stdout: capture().stdout,
      readShieldAssetsProvision: async ({ paths }) => { calls.push(["assets", paths.lane]); return { gitleaks: { path: "/opt/gitleaks", sha256: "a".repeat(64), rules: { path: "/opt/gitleaks-rules.toml", sha256: "b".repeat(64), version: "rules-bbbbbbbbbbbb" } } }; },
      readShieldPolicyProvision: async ({ paths }) => { calls.push(["policy", paths.lane]); return { bundle: {}, publicKey: "key" }; },
      loadShieldPolicy: async () => ({ version: "policy-1" }),
      installShieldService: async ({ paths, config, write }) => {
        calls.push(["install", paths.lane, config.gitleaks.executable, write]);
        assert.deepEqual(config.gitleaks.ruleBundle, {
          path: "/opt/gitleaks-rules.toml",
          sha256: "b".repeat(64),
          version: "rules-bbbbbbbbbbbb",
          commandProfile: {
            versionArgs: ["version"],
            scanArgs: ["stdin", "--config", "{rules}", "--report-format", "json", "--report-path", "-", "--redact"],
          },
        });
        return { label: paths.serviceLabel };
      },
    });
    assert.deepEqual(calls, [["assets", "managed"], ["policy", "managed"], ["install", "managed", "/opt/gitleaks", false]]);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("managed policy privacy and install CLI sequence stays in one lane", async () => {
  const home = await mkdtemp(join(tmpdir(), "airkit-shield-cli-sequence-"));
  const calls = [];
  const dependencies = {
    env: { HOME: home }, stdout: capture().stdout,
    installShieldPolicyProvision: async ({ paths, write }) => { calls.push(["policy", paths.lane, write]); return { version: "p", detectorVersions: {} }; },
    provisionShieldAssets: async ({ paths, write }) => { calls.push(["privacy", paths.lane, write]); return {}; },
    readShieldAssetsProvision: async () => ({ gitleaks: { path: "/opt/gitleaks", sha256: "a".repeat(64), rules: { path: "/opt/gitleaks-rules.toml", sha256: "b".repeat(64), version: "rules-bbbbbbbbbbbb" } } }),
    readShieldPolicyProvision: async () => ({ bundle: {}, publicKey: "key" }), loadShieldPolicy: async () => ({}),
    installShieldService: async ({ paths }) => { calls.push(["install", paths.lane]); return { label: paths.serviceLabel }; },
  };
  try {
    await runShieldCli(["policy", "install", "--bundle", "/tmp/p", "--public-key", "/tmp/k", "--lane", "managed"], dependencies);
    await runShieldCli(["privacy", "provision", "--bundle", "/tmp/privacy", "--gitleaks", "/tmp/g", "--gitleaks-rules", "/tmp/rules.toml", "--lane", "managed"], dependencies);
    await runShieldCli(["install", "--lane", "managed"], dependencies);
    assert.deepEqual(calls, [["policy", "managed", undefined], ["privacy", "managed", false], ["install", "managed"]]);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("managed status and doctor CLI commands preserve their lane", async () => {
  const calls = [];
  const shield = {
    async status(options) { calls.push(["status", options.lane]); return { state: "stopped" }; },
    async doctor(options) { calls.push(["doctor", options.lane]); return { state: "stopped" }; },
  };
  await runShieldCli(["status", "--lane", "managed"], { shield, stdout: capture().stdout });
  await runShieldCli(["doctor", "--lane", "managed"], { shield, stdout: capture().stdout });
  assert.deepEqual(calls, [["status", "managed"], ["doctor", "managed"]]);
});

test("shield doctor degrades a live service when its operational lane is unavailable", async () => {
  const output = capture();
  const code = await runShieldCli(["doctor", "--lane", "subscription"], {
    stdout: output.stdout,
    shieldStatus: async () => ({ state: "healthy", service: { active: true }, identity: { present: true } }),
    readShieldOperationalStatus: async () => ({ state: "unavailable", lanes: [{ lane: "subscription", state: "unavailable" }] }),
    readAuditHealth: async () => "unavailable",
  });
  assert.equal(code, 1);
  assert.match(output.value(), /state: degraded/);
  assert.match(output.value(), /operational\.lanes\.0\.lane: subscription/);
  assert.match(output.value(), /operational\.lanes\.0\.state: unavailable/);
  assert.doesNotMatch(output.value(), /\[object Object\]/);
});

test("shield doctor reports the probed audit health instead of a fixed unavailable", async () => {
  for (const audit of ["healthy", "unavailable"]) {
    const seen = [];
    const output = capture();
    await runShieldCli(["doctor", "--lane", "subscription"], {
      stdout: output.stdout,
      shieldStatus: async () => ({ state: "healthy", service: { active: true }, identity: { present: true } }),
      readShieldOperationalStatus: async (options) => {
        seen.push(options.audit);
        return { state: "protected", lanes: [{ lane: "subscription", state: "protected", audit: options.audit }] };
      },
      readAuditHealth: async () => audit,
    });
    assert.deepEqual(seen, [audit]);
    assert.match(output.value(), new RegExp(`operational\\.lanes\\.0\\.audit: ${audit}`));
  }
});

test("audit health collapses every non-healthy or failing status to unavailable", async () => {
  const { readAuditHealth } = await import("../src/audit/cli.mjs");
  const status = (value) => ({ audit: { status: async () => { if (value instanceof Error) throw value; return { state: value }; } } });
  assert.equal(await readAuditHealth(status("healthy")), "healthy");
  for (const value of ["degraded", "blocked", "stopped", undefined, new Error("socket gone")]) {
    assert.equal(await readAuditHealth(status(value)), "unavailable");
  }
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

test("airkit shield install preview fails closed when lane assets are absent", async () => {
  const { paths, options } = fixture();
  const output = capture();
  const calls = [];
  const io = new Proxy({}, { get: () => async (...args) => calls.push(args) });
  await assert.rejects(runCli(["shield", "install"], {
    stdout: output.stdout,
    paths,
    nodePath: options.nodePath,
    daemonPath: options.daemonPath,
    io,
    runLaunchctl: async (args) => calls.push(args),
    catalogPath: "/does/not/exist.json",
  }), /shield asset provision|isSymbolicLink/i);
  assert.equal(calls.length, 1);
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

// ccshield listens on 127.0.0.1:<random> and publishes it as identity.origin;
// it never creates shield.sock, so discovery must not depend on one.
async function ccshieldHome(identity) {
  const home = await mkdtemp(join(tmpdir(), "airkit-ccshield-"));
  const root = join(home, ".local", "share", "ccshield", "subscription");
  await mkdir(root, { recursive: true, mode: 0o700 });
  if (identity) await writeFile(join(root, "identity.json"), JSON.stringify(identity), { mode: 0o600 });
  return { home, root, env: { HOME: home, AIRKIT_GUI_UID: "501" } };
}

const ccshieldIdentity = {
  origin: "http://127.0.0.1:53817",
  capability: "d".repeat(32),
  version: 1,
  pid: 4242,
  lane: "subscription",
  generation: "ccshield-generation-1",
  targetClass: "subscription",
  policyVersion: "airkit-subscription-opf-2026.09.30-secret-redact",
  detectorVersions: { gitleaks: "8.30.1", privacy: "opf-1-client-exempt" },
  media: { documents: "blocked", images: "unscanned" },
};

test("discovery picks a live ccshield by identity origin without any shield.sock", async () => {
  const { home, root, env } = await ccshieldHome(ccshieldIdentity);
  try {
    const probes = [];
    const resolved = await resolveShieldRoot({
      lane: "subscription",
      env,
      inspectService: ccshieldService(4242),
      isProcessAlive: async (pid) => pid === 4242,
      probeShield: async (origin, cap) => { probes.push([origin, cap]); return true; },
    });
    await assert.rejects(stat(join(root, "shield.sock")), { code: "ENOENT" });
    assert.equal(resolved.implementation, "ccshield");
    assert.equal(resolved.rootDir, root);
    assert.deepEqual(resolved.skipped, []);
    assert.deepEqual(probes, [["http://127.0.0.1:53817", "d".repeat(32)]]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("discovery falls back to the AirKit root when ccshield does not answer its origin", async () => {
  const { home, env } = await ccshieldHome(ccshieldIdentity);
  try {
    const resolved = await resolveShieldRoot({ lane: "subscription", env, inspectService: ccshieldService(4242), isProcessAlive: async () => true, probeShield: async () => false });
    assert.equal(resolved.implementation, "airkit");
    assert.equal(resolved.rootDir, join(home, ".local", "state", "airkit-shield", "subscription"));
    assert.equal(resolved.skipped[0].reason, "listener at the identity origin did not answer the readiness probe");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("discovery falls back when the ccshield pid is dead or identity is absent", async () => {
  const dead = await ccshieldHome(ccshieldIdentity);
  const empty = await ccshieldHome(null);
  try {
    const probeShield = async () => { throw new Error("must not probe"); };
    const stale = await resolveShieldRoot({ lane: "subscription", env: dead.env, inspectService: ccshieldService(4242), isProcessAlive: async () => false, probeShield });
    assert.equal(stale.implementation, "airkit");
    assert.match(stale.skipped[0].reason, /pid 4242 is not running/);
    const absent = await resolveShieldRoot({ lane: "subscription", env: empty.env, isProcessAlive: async () => true, probeShield });
    assert.equal(absent.implementation, "airkit");
    assert.equal(absent.skipped[0].reason, "identity.json is absent");
  } finally {
    await rm(dead.home, { recursive: true, force: true });
    await rm(empty.home, { recursive: true, force: true });
  }
});

const notRunning = async () => ({ ok: true, stdout: "state = not running\n" });
const running = async () => ({ ok: true, stdout: `state = running\npid = ${process.pid}\n` });
const quietDoctor = { readAuditHealth: async () => "healthy", readShieldOperationalStatus: async () => ({ lanes: [] }) };

test("an invalid or lane-mismatched ccshield identity falls back to the legacy root with its reason", async () => {
  const mismatched = await startCcshieldFixture({ identity: { lane: "managed", targetClass: "managed" } });
  const nonLoopback = await startCcshieldFixture({ identity: { origin: "http://10.0.0.1:8811" } });
  try {
    const lane = await resolveShieldRoot({ lane: "subscription", env: mismatched.env });
    assert.equal(lane.implementation, "airkit");
    assert.equal(lane.rootDir, mismatched.legacyRoot);
    assert.deepEqual(lane.skipped.map(({ implementation, rootDir, reason }) => ({ implementation, rootDir, reason })), [
      { implementation: "ccshield", rootDir: mismatched.root, reason: "identity lane is managed, not subscription" },
    ]);
    const schema = await resolveShieldRoot({ lane: "subscription", env: nonLoopback.env });
    assert.equal(schema.implementation, "airkit");
    assert.match(schema.skipped[0].reason, /^identity is not valid v1: shield identity origin must be a loopback HTTP endpoint/);
    assert.deepEqual(nonLoopback.requests, [], "an invalid identity is never probed");
  } finally {
    await mismatched.close();
    await nonLoopback.close();
  }
});

test("shield status and doctor name the legacy root and why ccshield was skipped", async () => {
  const fixture = await startCcshieldFixture({ identity: { lane: "managed", targetClass: "managed" } });
  try {
    for (const command of ["status", "doctor"]) {
      const output = capture();
      await runShieldCli([command, "--lane", "subscription"], { stdout: output.stdout, env: fixture.env, runLaunchctl: notRunning, ...quietDoctor });
      const text = output.value();
      assert.match(text, /^root\.implementation: airkit$/m, command);
      assert.ok(text.includes(`root.rootDir: ${fixture.legacyRoot}\n`), command);
      assert.match(text, /^root\.skipped\.0\.implementation: ccshield$/m, command);
      assert.match(text, /^root\.skipped\.0\.reason: identity lane is managed, not subscription$/m, command);
      assert.match(text, /^state: stopped$/m, command);
    }
  } finally {
    await fixture.close();
  }
});

test("shield status and doctor name a live ccshield root without leaking its origin", async () => {
  const fixture = await startCcshieldFixture();
  try {
    for (const command of ["status", "doctor"]) {
      const output = capture();
      await runShieldCli([command, "--lane", "subscription"], { stdout: output.stdout, env: fixture.env, runLaunchctl: running, ...quietDoctor });
      const text = output.value();
      assert.match(text, /^root\.implementation: ccshield$/m, command);
      assert.ok(text.includes(`root.rootDir: ${fixture.root}\n`), command);
      assert.doesNotMatch(text, /root\.skipped\./, command);
      assert.equal(text.includes("127.0.0.1"), false, command);
      assert.equal(text.includes(CCSHIELD_CAPABILITY), false, command);
    }
    const output = capture();
    await runShieldCli(["status", "--lane", "subscription"], { stdout: output.stdout, env: fixture.env, runLaunchctl: running });
    assert.match(output.value(), /^state: healthy$/m);
  } finally {
    await fixture.close();
  }
});

test("with neither ccshield nor legacy Shield alive, readiness and launch fail closed as before", async () => {
  const silent = await startCcshieldFixture({ listen: false });
  const dead = await startCcshieldFixture({ identity: { pid: 2 ** 22 + 7 } });
  try {
    for (const fixture of [silent, dead]) {
      await assert.rejects(
        ensureShieldReady({ lane: "subscription", env: fixture.env, inspectService: async () => { throw new Error("must not inspect"); } }),
        /^Error: shield identity is stale; start the shield service and try again$/,
      );
      let launched = false;
      await assert.rejects(
        runShieldCli(["launch", "--lane", "subscription", "--target", "http://127.0.0.1:8804", "--", "echo", "no"], {
          stdout: capture().stdout,
          env: fixture.env,
          launchShieldChild: async () => { launched = true; return { code: 0 }; },
        }),
        /shield identity is stale/,
      );
      assert.equal(launched, false);
      assert.deepEqual(fixture.requests.filter(({ path }) => path !== "/_airkit/shield/ready"), []);
    }
  } finally {
    await silent.close();
    await dead.close();
  }
});

test("a launch on a chosen ccshield leases through its origin and reads its config", async () => {
  const fixture = await startCcshieldFixture();
  const launched = [];
  try {
    const code = await runShieldCli(["launch", "--lane", "subscription", "--target", "http://127.0.0.1:8804", "--", "echo", "ok"], {
      stdout: capture().stdout,
      env: fixture.env,
      inspectService: async () => ({ loaded: true, active: true, pid: process.pid }),
      shieldLeaseSetInterval: () => ({ unref() {} }),
      shieldLeaseClearInterval: () => {},
      backgroundHostDetector: async () => false,
      launchShieldChild: async ({ ready }) => { launched.push(ready); return { code: 0 }; },
    });
    assert.equal(code, 0);
    assert.equal(launched.length, 1);
    assert.equal(launched[0].origin, fixture.origin);
    assert.equal(launched[0].paths.implementation, "ccshield");
    assert.equal(launched[0].paths.rootDir, fixture.root);
    const leases = fixture.requests.filter(({ path }) => path === "/_airkit/shield/destination-lease");
    assert.deepEqual(leases.map(({ method, control }) => [method, control]), [
      ["POST", CCSHIELD_CONTROL_CAPABILITY],
      ["DELETE", CCSHIELD_CONTROL_CAPABILITY],
    ]);
    assert.equal(leases[0].body.targetOrigin, "http://127.0.0.1:8804");
    assert.equal(leases[1].body.capability, leases[0].body.capability);
  } finally {
    await fixture.close();
  }
});

test("approval channel registration goes to the chosen ccshield origin", async () => {
  const fixture = await startCcshieldFixture();
  try {
    const ready = await ensureShieldReady({ lane: "subscription", env: fixture.env, inspectService: async () => ({ loaded: true, active: true, pid: process.pid }) });
    assert.equal(ready.paths.rootDir, fixture.root);
    const result = await launchShieldChild({
      command: "echo",
      args: ["ok"],
      ready,
      env: { HOME: fixture.home },
      approvalBroker: {},
      createApprovalChannel: async () => ({ socketPath: "/tmp/airkit-ccshield-approval.sock", capability: "f".repeat(32), async close() {} }),
      spawnChild: () => {
        const child = new EventEmitter();
        setImmediate(() => child.emit("close", 0, null));
        return child;
      },
    });
    assert.equal(result.code, 0);
    const approvals = fixture.requests.filter(({ path }) => path === "/_airkit/shield/approval-channel");
    assert.deepEqual(approvals.map(({ method, control }) => [method, control]), [
      ["POST", CCSHIELD_CONTROL_CAPABILITY],
      ["DELETE", CCSHIELD_CONTROL_CAPABILITY],
    ]);
    assert.equal(approvals[0].body.socketPath, "/tmp/airkit-ccshield-approval.sock");
    assert.equal(approvals[1].body.launchId, approvals[0].body.launchId);
  } finally {
    await fixture.close();
  }
});

test("shield policy status reads the policy of the chosen ccshield root", async () => {
  const fixture = await startCcshieldFixture();
  try {
    const output = capture();
    const code = await runShieldCli(["policy", "status", "--lane", "subscription"], { stdout: output.stdout, env: fixture.env, runLaunchctl: running });
    assert.equal(code, 0);
    assert.match(output.value(), /^version: airkit-subscription-opf-2026\.09\.30-secret-redact$/m);
    assert.match(output.value(), /^detectorVersions\.gitleaks: 8\.30\.1$/m);
    assert.match(output.value(), /^root\.implementation: ccshield$/m);
  } finally {
    await fixture.close();
  }
});

test("a stale ccshield pid with a foreign listener on its port never receives the capability", async () => {
  // pid 1 is alive (EPERM) but is not ccshield; the fixture listener stands in for whatever now owns the port.
  const fixture = await startCcshieldFixture({ identity: { pid: 1 } });
  try {
    const unloaded = await resolveShieldRoot({ lane: "subscription", env: fixture.env, inspectService: ccshieldService(null, "managed") });
    assert.equal(unloaded.implementation, "airkit");
    assert.equal(unloaded.skipped[0].reason, "service com.ccshield.subscription is not actively running");
    const otherPid = await resolveShieldRoot({ lane: "subscription", env: fixture.env, inspectService: ccshieldService(process.pid) });
    assert.equal(otherPid.implementation, "airkit");
    assert.equal(otherPid.skipped[0].reason, "service com.ccshield.subscription pid does not match identity pid 1");
    for (const argv of [["status"], ["doctor"], ["policy", "status"]]) {
      await runShieldCli([...argv, "--lane", "subscription"], { stdout: capture().stdout, env: fixture.env, runLaunchctl: running, readAuditHealth: async () => "healthy" });
    }
    await assert.rejects(ensureShieldReady({ lane: "subscription", env: fixture.env, inspectService: ccshieldService(process.pid) }), /shield identity is stale/);
    assert.deepEqual(fixture.requests, []);
  } finally {
    await fixture.close();
  }
});

test("ccshield identity and config files must be private regular files of this user", async () => {
  const cases = [
    ["identity.json", 0o644, "identity.json must be private"],
    ["config.json", 0o640, "config.json must be private"],
  ];
  for (const [file, mode, reason] of cases) {
    const fixture = await startCcshieldFixture();
    try {
      await chmod(join(fixture.root, file), mode);
      const resolved = await resolveShieldRoot({ lane: "subscription", env: fixture.env, inspectService: fixture.inspectService });
      assert.equal(resolved.implementation, "airkit", file);
      assert.equal(resolved.skipped[0].reason, reason);
      assert.deepEqual(fixture.requests, [], file);
    } finally {
      await fixture.close();
    }
  }
  const linked = await startCcshieldFixture();
  try {
    const real = join(linked.home, "identity-elsewhere.json");
    await rename(join(linked.root, "identity.json"), real);
    await symlink(real, join(linked.root, "identity.json"));
    const resolved = await resolveShieldRoot({ lane: "subscription", env: linked.env, inspectService: linked.inspectService });
    assert.equal(resolved.skipped[0].reason, "identity.json must not be a symlink");
    assert.deepEqual(linked.requests, []);
  } finally {
    await linked.close();
  }
});

test("the legacy root still reads a group-readable identity as before", async () => {
  const fixture = await startCcshieldFixture({ listen: false });
  try {
    const paths = shieldPaths({ env: fixture.env, lane: "subscription" });
    await mkdir(paths.rootDir, { recursive: true, mode: 0o700 });
    await writeFile(paths.identityPath, JSON.stringify(fixture.identity), { mode: 0o644 });
    await chmod(paths.identityPath, 0o644);
    const identity = await readShieldIdentity({ paths });
    assert.equal(identity.pid, process.pid);
  } finally {
    await fixture.close();
  }
});

test("with both ccshield and the legacy Shield alive, ccshield wins and the legacy one is never contacted", async () => {
  const fixture = await startCcshieldFixture();
  const legacy = await startCcshieldFixture();
  try {
    await mkdir(fixture.legacyRoot, { recursive: true, mode: 0o700 });
    await writeFile(join(fixture.legacyRoot, "identity.json"), JSON.stringify(legacy.identity), { mode: 0o600 });
    const bothAlive = async ({ paths }) => ({ loaded: true, active: true, pid: process.pid, label: paths.serviceLabel });
    const ready = await ensureShieldReady({ lane: "subscription", env: fixture.env, inspectService: bothAlive });
    assert.equal(ready.origin, fixture.origin);
    assert.equal(ready.paths.implementation, "ccshield");
    assert.deepEqual(legacy.requests, []);
  } finally {
    await fixture.close();
    await legacy.close();
  }
});

test("a ccshield that answers discovery but fails a deep check blocks the launch without falling back", async () => {
  const mutations = [
    ["config.json", (value) => ({ ...value, generation: "ccshield-generation-2" }), /^shield configuration generation mismatch; restart the shield service \(ccshield at .+ is the chosen Shield; AirKit does not fall back to the legacy Shield\)$/],
    ["policy-state.json", (value) => ({ ...value, version: "airkit-subscription-opf-2026.10.01" }), /^shield policy version mismatch; restart the shield service \(ccshield at .+ is the chosen Shield; AirKit does not fall back to the legacy Shield\)$/],
  ];
  for (const [file, mutate, message] of mutations) {
    const fixture = await startCcshieldFixture();
    const legacy = await startCcshieldFixture();
    try {
      const path = join(fixture.root, file);
      await writeFile(path, JSON.stringify(mutate(JSON.parse(await readFile(path, "utf8")))), { mode: 0o600 });
      await mkdir(fixture.legacyRoot, { recursive: true, mode: 0o700 });
      await writeFile(join(fixture.legacyRoot, "identity.json"), JSON.stringify(legacy.identity), { mode: 0o600 });
      const bothAlive = async ({ paths }) => ({ loaded: true, active: true, pid: process.pid, label: paths.serviceLabel });
      await assert.rejects(ensureShieldReady({ lane: "subscription", env: fixture.env, inspectService: bothAlive }), (error) => message.test(error.message));
      let launched = false;
      await assert.rejects(runShieldCli(["launch", "--lane", "subscription", "--", "echo", "no"], {
        stdout: capture().stdout,
        env: fixture.env,
        inspectService: bothAlive,
        launchShieldChild: async () => { launched = true; return { code: 0 }; },
      }), (error) => message.test(error.message));
      assert.equal(launched, false, file);
      assert.deepEqual(legacy.requests, [], file);
      assert.deepEqual(fixture.requests.filter(({ path: requestPath }) => requestPath !== "/_airkit/shield/ready"), [], file);
    } finally {
      await fixture.close();
      await legacy.close();
    }
  }
});

test("operational status and shield doctor name the ccshield root without its origin or capabilities", async () => {
  const fixture = await startCcshieldFixture();
  try {
    const operational = await readShieldOperationalStatus({ env: fixture.env, audit: "healthy", inspectService: fixture.inspectService });
    const subscription = operational.lanes.find(({ lane }) => lane === "subscription");
    assert.equal(subscription.implementation, "ccshield");
    assert.equal(subscription.root_dir, fixture.root);
    const serialized = JSON.stringify(operational);
    for (const secret of [fixture.origin, "127.0.0.1", CCSHIELD_CAPABILITY, CCSHIELD_CONTROL_CAPABILITY]) {
      assert.equal(serialized.includes(secret), false, secret);
    }
    const output = capture();
    await runShieldCli(["doctor", "--lane", "subscription"], { stdout: output.stdout, env: fixture.env, runLaunchctl: running, readAuditHealth: async () => "healthy" });
    const text = output.value();
    assert.ok(text.includes(`root_dir: ${fixture.root}\n`), text);
    for (const secret of [fixture.origin, "127.0.0.1", CCSHIELD_CAPABILITY, CCSHIELD_CONTROL_CAPABILITY]) {
      assert.equal(text.includes(secret), false, secret);
    }
  } finally {
    await fixture.close();
  }
});

test("shield policy install refuses while ccshield serves the lane", async () => {
  const fixture = await startCcshieldFixture();
  try {
    const output = capture();
    const code = await runShieldCli(["policy", "install", "--bundle", "/tmp/policy-bundle", "--public-key", "/tmp/policy-public.pem", "--write"], {
      stdout: output.stdout,
      env: fixture.env,
      runLaunchctl: running,
      installShieldPolicyProvision: async () => { throw new Error("must not install into the legacy root"); },
    });
    assert.equal(code, 3);
    assert.match(output.value(), /^state: blocked$/m);
    assert.match(output.value(), /^refused: ccshield serves the subscription lane; install its policy with ccshield's own tooling\. This command installs into the legacy AirKit Shield only\.$/m);
    assert.match(output.value(), /^root\.implementation: ccshield$/m);
    await assert.rejects(stat(fixture.legacyRoot), { code: "ENOENT" });
  } finally {
    await fixture.close();
  }
});

test("legacy service commands say they manage the legacy AirKit Shield only", async () => {
  const fixture = await startCcshieldFixture();
  try {
    const output = capture();
    await runShieldCli(["uninstall", "--lane", "subscription"], { stdout: output.stdout, env: fixture.env, runLaunchctl: notRunning });
    assert.match(output.value(), /^manages: legacy AirKit Shield only$/m);
    const help = capture();
    await runShieldCli(["help"], { stdout: help.stdout });
    assert.match(help.value(), /legacy AirKit Shield only/);
  } finally {
    await fixture.close();
  }
});
