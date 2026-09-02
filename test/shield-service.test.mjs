import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
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
  startShieldService,
  stopShieldService,
} from "../src/shield/service.mjs";
import { shieldPaths, writeShieldIdentity } from "../src/shield/paths.mjs";

const capability = "c".repeat(32);
const generation = "generation-1";

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

test("shield install writes a private plist only with --write semantics", async () => {
  const homeDir = await mkdtemp(join(tmpdir(), "airkit-shield-service-"));
  const { options, paths } = fixture(homeDir);
  const calls = [];
  try {
    await installShieldService({ ...options, write: true, runLaunchctl: async (args) => { calls.push(args); return { ok: true }; } });
    assert.equal((await stat(paths.launchAgentPath)).mode & 0o777, 0o600);
    assert.match(await readFile(paths.launchAgentPath, "utf8"), /<string>--config<\/string>/);
    assert.deepEqual(calls, [
      ["bootstrap", paths.launchdDomain, paths.launchAgentPath],
      ["kickstart", "-k", paths.launchdTarget],
    ]);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("stale identity blocks shield launch", async () => {
  const homeDir = await mkdtemp(join(tmpdir(), "airkit-shield-ready-"));
  const { paths } = fixture(homeDir);
  try {
    await writeShieldIdentity({
      paths,
      identity: { origin: "http://127.0.0.1:8811", capability, version: 1, pid: 42, lane: "subscription", generation, targetClass: "subscription" },
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
  assert.deepEqual(ready, { origin: identity.origin, capability, targetClass: "subscription" });
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

test("AirKit keeps capability out of its argv while the trusted child inherits it and owns its output", async () => {
  const calls = [];
  const child = new EventEmitter();
  const outcome = launchShieldChild({
    command: "/usr/bin/env",
    args: ["true"],
    ready: { origin: "http://127.0.0.1:8811", capability, lane: "subscription", targetClass: "subscription" },
    env: { PATH: "/usr/bin" },
    spawnChild(command, args, options) {
      calls.push({ command, args, options });
      queueMicrotask(() => child.emit("close", 0, null));
      return child;
    },
  });
  assert.deepEqual(await outcome, { code: 0, signal: null });
  assert.deepEqual(calls[0].args, ["true"]);
  assert.equal(calls[0].options.env.AIRKIT_SHIELD_ORIGIN, "http://127.0.0.1:8811");
  assert.equal(calls[0].options.env.AIRKIT_SHIELD_CAPABILITY, capability);
  assert.equal(calls[0].args.includes(capability), false);
  assert.equal(calls[0].options.stdio, "inherit");
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

function shieldStateIo(paths, { identity, config }) {
  return {
    async readFile(path) {
      if (path === paths.identityPath) return `${JSON.stringify(identity)}\n`;
      if (path === paths.configPath) return `${JSON.stringify(config)}\n`;
      throw new Error(`unexpected fixture path: ${path}`);
    },
  };
}
