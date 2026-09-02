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
  installShieldService,
  launchShieldChild,
  planShieldService,
  startShieldService,
  stopShieldService,
} from "../src/shield/service.mjs";
import { shieldPaths, writeShieldIdentity } from "../src/shield/paths.mjs";

const capability = "c".repeat(32);

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
      identity: { origin: "http://127.0.0.1:8811", capability, version: 1, pid: 42, targetClass: "loopback" },
    });
    await assert.rejects(
      ensureShieldReady({ lane: "subscription", paths, isProcessAlive: async () => false }),
      /shield identity is stale/i,
    );
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
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

test("shield launch passes identity only through the child environment", async () => {
  const calls = [];
  const child = new EventEmitter();
  const outcome = launchShieldChild({
    command: "/usr/bin/env",
    args: ["true"],
    ready: { origin: "http://127.0.0.1:8811", capability, targetClass: "loopback" },
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
