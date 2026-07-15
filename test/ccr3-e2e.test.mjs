import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import * as airkitRuntime from "../src/airkit.mjs";

const verifierPath = resolve(import.meta.dirname, "..", "scripts", "verify-ccr3-e2e.mjs");
const verifierSource = readFileSync(verifierPath, "utf8");
const verifier = await import(verifierPath);

test("repository includes the isolated CCR 3 end-to-end verifier", () => {
  assert.equal(existsSync(verifierPath), true);
  const packageJson = JSON.parse(readFileSync(resolve(import.meta.dirname, "..", "package.json"), "utf8"));
  assert.equal(packageJson.scripts["verify:ccr3:e2e"], "node scripts/verify-ccr3-e2e.mjs");
  assert.match(verifierSource, /sandbox-exec/);
  assert.match(verifierSource, /AIRKIT_E2E_AMBIENT_SENTINEL/);
  assert.match(verifierSource, /AIRKIT_E2E_SANDBOX_NONCE/);
  assert.doesNotMatch(verifierSource, /AIRKIT_E2E_CONTROLLER_GUARD/);
});

test("runtime has no persisted Claude session model repair layer", () => {
  const runtime = readFileSync(resolve(import.meta.dirname, "..", "src", "airkit.mjs"), "utf8");
  assert.doesNotMatch(runtime, /repairClaudeRestoreSessions|claudeRestoreProjectsDir|listClaudeSessionFiles/);
  assert.doesNotMatch(verifierSource, /repairRestore\s*:\s*false/);
});

test("CCR 3 verifier exposes isolated path and gateway endpoint helpers", () => {
  assert.equal(typeof verifier.createIsolatedEnvironment, "function");
  assert.equal(typeof verifier.assertIsolatedEnvironment, "function");
  assert.equal(typeof airkitRuntime.ensureCcr3Gateway, "function");
  assert.equal(typeof airkitRuntime.resolveCcrGatewayEndpoint, "function");
});

test("isolated CCR environment keeps every writable state path below one root", () => {
  const root = "/tmp/airkit-ccr3-contract";
  const env = verifier.createIsolatedEnvironment(root, { PATH: "/usr/bin" });

  assert.equal(env.PATH, "/usr/bin");
  for (const name of [
    "HOME",
    "XDG_CONFIG_HOME",
    "CLAUDE_CONFIG_DIR",
    "CCR_INTERNAL_HOME_DIR",
    "CCR_INTERNAL_APP_DATA_DIR",
    "CCR_INTERNAL_USER_DATA_DIR",
    "AIRKIT_CONFIG_DIR",
  ]) {
    assert.match(env[name], /^\/tmp\/airkit-ccr3-contract\//);
  }
});

test("failed isolated CCR verification retains its root for diagnosis", async () => {
  const removed = [];
  const reports = [];

  await verifier.finalizeIsolatedRoot("/tmp/airkit-failed", true, {
    remove: async (...args) => removed.push(args),
    report: (message) => reports.push(message),
  });

  assert.deepEqual(removed, []);
  assert.deepEqual(reports, ["Isolated E2E artifacts retained at /tmp/airkit-failed\n"]);
});

test("successful isolated CCR verification removes its root", async () => {
  const removed = [];

  await verifier.finalizeIsolatedRoot("/tmp/airkit-passed", false, {
    remove: async (...args) => removed.push(args),
  });

  assert.deepEqual(removed, [["/tmp/airkit-passed", { force: true, recursive: true }]]);
});

test("isolated CCR gateway uses dedicated external and core loopback ports", () => {
  const configured = verifier.configureIsolatedGateway({
    HOST: "0.0.0.0",
    PORT: 3456,
    gateway: { host: "0.0.0.0", port: 3456, coreHost: "127.0.0.1", corePort: 3457 },
  }, { corePort: 43990, gatewayPort: 43989 });

  assert.equal(configured.HOST, "127.0.0.1");
  assert.equal(configured.PORT, 43989);
  assert.equal(configured.routerEndpoint, "http://127.0.0.1:43989");
  assert.deepEqual(configured.gateway, {
    host: "127.0.0.1",
    port: 43989,
    coreHost: "127.0.0.1",
    corePort: 43990,
  });
});

test("gateway endpoint follows the configured non-default CCR gateway address", () => {
  const endpoint = airkitRuntime.resolveCcrGatewayEndpoint({
    HOST: "127.0.0.1",
    PORT: 3456,
    gateway: { host: "127.0.0.2", port: 43991 },
  });

  assert.equal(endpoint.origin, "http://127.0.0.2:43991");
});

test("gateway endpoint converts wildcard bind hosts to connectable loopback hosts", () => {
  assert.equal(airkitRuntime.resolveCcrGatewayEndpoint({ gateway: { host: "0.0.0.0", port: 43991 } }).origin, "http://127.0.0.1:43991");
  assert.equal(airkitRuntime.resolveCcrGatewayEndpoint({ gateway: { host: "::", port: 43992 } }).origin, "http://[::1]:43992");
});

test("production gateway readiness uses bounded health requests and starts the configured endpoint", async () => {
  const events = [];
  const endpoint = await airkitRuntime.ensureCcr3Gateway({
    fetchImpl: async (url, options) => {
      events.push({ signal: options.signal, url: String(url) });
      return { ok: events.length > 1 };
    },
    getConfig: async () => ({ gateway: { host: "0.0.0.0", port: 43993 } }),
    healthTimeoutMs: 25,
    pollAttempts: 2,
    pollIntervalMs: 0,
    startGateway: async () => events.push({ started: true }),
  });

  assert.equal(endpoint, "http://127.0.0.1:43993");
  assert.equal(events[0].url, "http://127.0.0.1:43993/health");
  assert.ok(events[0].signal instanceof AbortSignal);
  assert.deepEqual(events[1], { started: true });
});

test("CCR management RPC requests carry a bounded timeout signal", async () => {
  const root = await mkdtemp("/tmp/airkit-ccr-rpc-");
  const stateDir = resolve(root, ".claude-code-router");
  await mkdir(stateDir, { recursive: true });
  await writeFile(
    resolve(stateDir, "service.json"),
    JSON.stringify({ url: "http://127.0.0.1:43210/?ccr_web_token=fixture" }),
  );
  const requests = [];

  try {
    const client = airkitRuntime.createCcr3Client({
      env: { CCR_INTERNAL_HOME_DIR: root },
      rpcTimeoutMs: 25,
      fetch: async (_url, options) => {
        requests.push(options);
        return { ok: true, json: async () => ({ value: { Providers: [] } }) };
      },
    });
    await client.getConfig();
    assert.equal(requests.length, 1);
    assert.ok(requests[0].signal instanceof AbortSignal);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
