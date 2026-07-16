import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import * as airkitRuntime from "../src/airkit.mjs";
import { inspectPendingServerHistory } from "../src/compat/server-history.mjs";

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

test("isolated CCR verifier loads the compatibility plugin and probes its MCP route", () => {
  assert.match(verifierSource, /id: "airkit-compatibility"/);
  assert.match(verifierSource, /AIRKIT_COMPATIBILITY_MCP_URL/);
  assert.match(verifierSource, /AIRKIT_COMPATIBILITY_MCP_TOKEN/);
  assert.match(verifierSource, /method: "initialize"/);
  assert.match(verifierSource, /payload\.compatibilityMcp\?\.serverInfo\?\.name/);
  assert.match(verifierSource, /payload\.content\?\.\[0\]\?\.text, "FAKE_PROVIDER_OK"/);
});

test("isolated CCR verifier executes and validates every fallback family", async () => {
  assert.match(verifierSource, /name: "fake-openai"[\s\S]*type: "openai_chat_completions"/);
  assert.match(verifierSource, /name: "fake-anthropic"[\s\S]*type: "anthropic_messages"/);
  assert.match(verifierSource, /provider: "fake-anthropic"/);
  assert.match(verifierSource, /fallback requests must use Anthropic Messages/);
  const gatewayRequests = [];
  const families = await verifier.runFallbackGatewayScenarios({
    apiKey: "outer-fixture",
    gatewayOrigin: "http://127.0.0.1:43123",
    loopbackOrigin: "http://127.0.0.1:43124",
    async fetchImpl(input, init) {
      gatewayRequests.push({
        body: JSON.parse(init.body),
        headers: Object.fromEntries(new Headers(init.headers)),
        url: String(input),
      });
      const family = gatewayRequests.at(-1).body.metadata.user_id.slice("airkit-e2e-".length);
      const content = family === "advisor"
        ? [{ type: "server_tool_use" }, {
            type: "advisor_tool_result",
            content: { type: "advisor_redacted_result", encrypted_content: "fixture" },
          }]
        : family === "codeExecution"
          ? [{ type: "server_tool_use" }, { type: "code_execution_tool_result" }]
          : [];
      return Response.json({ type: "message", content, stop_reason: "end_turn" });
    },
  });

  assert.deepEqual(families, ["advisor", "webSearch", "webFetch", "codeExecution", "mcpConnector"]);
  assert.equal(gatewayRequests.length, 5);
  assert.ok(gatewayRequests.every(({ url }) => url === "http://127.0.0.1:43123/v1/messages"));
  assert.match(JSON.stringify(gatewayRequests[2].body), /http:\/\/127\.0\.0\.1:43124\/webFetch-fixture/);

  const providerRecords = gatewayRequests.map((request, index) => ({
    body: { ...request.body, model: "claude-sonnet" },
    headers: {
      "anthropic-version": "2023-06-01",
      "x-api-key": "provider-fixture-secret",
      "x-request-id": `provider-${families[index]}`,
    },
  }));
  const evidence = verifier.summarizeFallbackEvidence(providerRecords, { inspectPendingServerHistory });
  assert.deepEqual(evidence.map(({ family }) => family), families);
  assert.ok(evidence.every(({ fallbackModel }) => fallbackModel === "claude-sonnet"));
  assert.ok(evidence.every(({ bodyHash }) => /^[a-f0-9]{64}$/.test(bodyHash)));
  assert.equal(evidence.find(({ family }) => family === "codeExecution").continuationCount, 1);
  assert.equal(evidence.find(({ family }) => family === "codeExecution").container, "container_fixture");
  assert.deepEqual(evidence[0].redactedHeaders, {
    "anthropic-version": "[present]",
    "x-api-key": "[redacted]",
    "x-request-id": "[present]",
  });
  assert.doesNotMatch(JSON.stringify(evidence), /provider-fixture-secret|outer-fixture/);
  const providerBodies = gatewayRequests.map((request, index) => ({
    ...request,
    body: { ...request.body, model: "claude-sonnet" },
    headers: { ...request.headers, "x-request-id": `fixture-${families[index]}` },
    url: "/v1/messages",
  }));
  assert.doesNotThrow(() =>
    verifier.assertFallbackProviderRequests(providerBodies, "http://127.0.0.1:43124"));
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

test("fake Claude enforces launch-time apiKeyHelper precedence", () => {
  assert.throws(
    () => verifier.assertNoApiKeyHelperOverride(["--settings", "{\"apiKeyHelper\":\"\"}"]),
    /must not override CCR managed apiKeyHelper/,
  );
  assert.doesNotThrow(() => verifier.assertNoApiKeyHelperOverride(["--permission-mode", "auto"]));
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
  let started = false;
  const endpoint = await airkitRuntime.ensureCcr3Gateway({
    fetchImpl: async (url, options) => {
      events.push({ signal: options.signal, url: String(url) });
      return { ok: started, json: async () => ({ status: "ok" }) };
    },
    getConfig: async () => ({
      gateway: { host: "0.0.0.0", port: 43993, coreHost: "127.0.0.1", corePort: 43994 },
    }),
    healthTimeoutMs: 25,
    pollAttempts: 2,
    pollIntervalMs: 0,
    startGateway: async () => {
      started = true;
      events.push({ started: true });
    },
  });

  assert.equal(endpoint, "http://127.0.0.1:43993");
  assert.equal(events[0].url, "http://127.0.0.1:43993/health");
  assert.ok(events[0].signal instanceof AbortSignal);
  assert.deepEqual(events[1], { started: true });
  assert.equal(events[2].url, "http://127.0.0.1:43993/health");
  assert.equal(events[3].url, "http://127.0.0.1:43994/health");
  assert.ok(events[2].signal instanceof AbortSignal);
  assert.ok(events[3].signal instanceof AbortSignal);
});

test("production gateway readiness waits for the CCR core after the outer health endpoint is ready", async () => {
  const events = [];
  let coreChecks = 0;
  const endpoint = await airkitRuntime.ensureCcr3Gateway({
    fetchImpl: async (url) => {
      const value = String(url);
      events.push(value);
      if (value === "http://127.0.0.1:43995/health") {
        coreChecks += 1;
        return { ok: coreChecks > 1, json: async () => ({ status: "ok" }) };
      }
      return { ok: true };
    },
    getConfig: async () => ({
      gateway: { host: "127.0.0.1", port: 43994, coreHost: "127.0.0.1", corePort: 43995 },
    }),
    pollAttempts: 2,
    pollIntervalMs: 0,
    startGateway: async () => events.push("started"),
  });

  assert.equal(endpoint, "http://127.0.0.1:43994");
  assert.deepEqual(events, [
    "http://127.0.0.1:43994/health",
    "http://127.0.0.1:43995/health",
    "started",
    "http://127.0.0.1:43994/health",
    "http://127.0.0.1:43995/health",
  ]);
});

test("production gateway readiness requires the CCR core health status to be ok", async () => {
  let coreChecks = 0;
  const endpoint = await airkitRuntime.ensureCcr3Gateway({
    fetchImpl: async (url) => {
      if (String(url) === "http://127.0.0.1:43997/health") {
        coreChecks += 1;
        return { ok: true, json: async () => ({ status: coreChecks > 1 ? "ok" : "starting" }) };
      }
      return { ok: true };
    },
    getConfig: async () => ({
      gateway: { host: "127.0.0.1", port: 43996, coreHost: "127.0.0.1", corePort: 43997 },
    }),
    pollAttempts: 2,
    pollIntervalMs: 0,
    startGateway: async () => {},
  });

  assert.equal(endpoint, "http://127.0.0.1:43996");
  assert.equal(coreChecks, 2);
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
