#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { repairCcrCodexProfiles } from "../src/codex-takeover-guard.mjs";
import { assertNoManagedApiKeyHelperOverride } from "../src/airkit.mjs";

export { assertNoManagedApiKeyHelperOverride as assertNoApiKeyHelperOverride };

export async function awaitNativeRequestLog({
  expected = {},
  marker,
  pollIntervalMs = 100,
  rpc,
  timeoutMs = 5_000,
}) {
  assert.equal(typeof marker, "string", "native request-log marker must be a string");
  assert.ok(marker.length > 0, "native request-log marker must not be empty");
  assert.equal(typeof rpc, "function", "native request-log RPC client is required");

  const deadline = Date.now() + timeoutMs;
  let lastItems = [];
  do {
    const page = await rpc("getRequestLogs", [{ page: 1, pageSize: 100, query: marker }]);
    const items = Array.isArray(page?.items) ? page.items : [];
    if (items.length === 1) {
      assertNativeRequestLog(items[0], expected);
      return items[0];
    }
    lastItems = items;
    if (Date.now() >= deadline) break;
    await wait(pollIntervalMs);
  } while (true);

  assert.fail(
    `expected exactly one native request log for ${marker}; received ${lastItems.length}: `
    + JSON.stringify(lastItems.map(({ client, model, provider, requestBody, statusCode }) => ({
      client,
      model,
      provider,
      requestBody: requestBody?.text?.slice(0, 200),
      statusCode,
    }))),
  );
}

function assertNativeRequestLog(row, expected) {
  for (const [field, value] of Object.entries(expected)) {
    const actual = row[field];
    if (typeof value === "function") {
      value(actual, row);
    } else {
      assert.deepEqual(actual, value, `native request log field ${field} did not match`);
    }
  }
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

const ISOLATED_PATH_VARIABLES = [
  "HOME",
  "XDG_CONFIG_HOME",
  "CLAUDE_CONFIG_DIR",
  "CCR_INTERNAL_HOME_DIR",
  "CCR_INTERNAL_APP_DATA_DIR",
  "CCR_INTERNAL_USER_DATA_DIR",
  "AIRKIT_CONFIG_DIR",
];

export function createIsolatedEnvironment(root, baseEnv = process.env) {
  const isolatedRoot = resolve(root);
  const home = resolve(isolatedRoot, "home");
  return {
    ...baseEnv,
    HOME: home,
    XDG_CONFIG_HOME: resolve(isolatedRoot, "xdg-config"),
    CLAUDE_CONFIG_DIR: resolve(isolatedRoot, "claude"),
    CCR_INTERNAL_HOME_DIR: home,
    CCR_INTERNAL_APP_DATA_DIR: resolve(isolatedRoot, "app-data"),
    CCR_INTERNAL_USER_DATA_DIR: resolve(isolatedRoot, "user-data"),
    AIRKIT_CONFIG_DIR: resolve(isolatedRoot, "airkit-config"),
  };
}

export function configureIsolatedGateway(config, { corePort, gatewayPort }) {
  return {
    ...config,
    HOST: "127.0.0.1",
    PORT: gatewayPort,
    routerEndpoint: `http://127.0.0.1:${gatewayPort}`,
    gateway: {
      ...config.gateway,
      host: "127.0.0.1",
      port: gatewayPort,
      coreHost: "127.0.0.1",
      corePort,
    },
  };
}

export async function finalizeIsolatedRoot(root, failed, options = {}) {
  if (failed) {
    const report = options.report ?? ((message) => process.stderr.write(message));
    report(`Isolated E2E artifacts retained at ${root}\n`);
    return;
  }
  const remove = options.remove ?? rm;
  await remove(root, { force: true, recursive: true });
}

export function assertIsolatedEnvironment(root, env, realHome) {
  const isolatedRoot = `${resolve(root)}/`;
  const resolvedRealHome = realHome ? `${resolve(realHome)}/` : null;
  for (const name of ISOLATED_PATH_VARIABLES) {
    const value = `${resolve(env[name] ?? "")}/`;
    if (!value.startsWith(isolatedRoot)) {
      throw new Error(`${name} escapes the isolated CCR root`);
    }
    if (resolvedRealHome && value.startsWith(resolvedRealHome)) {
      throw new Error(`${name} points into the real home directory`);
    }
  }
}

export function isSupportedCcrVersion(version) {
  const match = String(version ?? "").match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match) return false;
  const [major, minor, patch] = match.slice(1).map(Number);
  return major === 3 && (minor > 0 || patch >= 4);
}

export async function verifyDangerousCodexPersistence({
  ccr,
  dangerousProfile,
  env,
  initialConfig,
  postProbeConfig,
  read = readFile,
  rpc,
  rpcFactory = createRpcClient,
  runCommand = run,
  sentinelBytes,
  sentinelPath,
}) {
  const profiles = initialConfig.profile?.profiles ?? [];
  const profileIndex = profiles.findIndex((profile) => profile.id === dangerousProfile.id);
  assert.notEqual(profileIndex, -1, "dangerous Codex probe must replace an existing profile");
  await rpc("saveConfig", [{
    ...initialConfig,
    profile: {
      ...(initialConfig.profile ?? {}),
      profiles: profiles.map((profile, index) => index === profileIndex
        ? { ...profile, ...dangerousProfile }
        : profile),
    },
  }, { applyProfile: false }]);
  assert.deepEqual(await read(sentinelPath), sentinelBytes, "applyProfile:false mutated Codex sentinel");

  const stopped = runCommand(ccr, ["stop"], env);
  assert.equal(stopped.status, 0, `CCR management stop failed: ${stopped.stderr}`);
  assert.deepEqual(await read(sentinelPath), sentinelBytes, "management stop mutated Codex sentinel");
  const restarted = runCommand(ccr, ["start", "--no-gateway"], env);
  assert.equal(restarted.status, 0, `CCR management restart failed: ${restarted.stderr}`);
  const freshRpc = await rpcFactory(env);
  const persistedConfig = await freshRpc("getConfig");
  const persistedProfile = persistedConfig.profile?.profiles?.find((profile) => profile.id === dangerousProfile.id);
  assert.ok(persistedProfile, "dangerous Codex profile did not persist across restart");
  assert.equal(persistedProfile.agent, "codex");
  assert.equal(persistedProfile.enabled, true, "dangerous Codex profile was disabled across restart");
  assert.equal(persistedProfile.scope, "global");
  assert.equal(persistedProfile.configFile, dangerousProfile.configFile);
  assert.deepEqual(await read(sentinelPath), sentinelBytes, "management restart/getConfig mutated Codex sentinel");

  const safeConfig = repairCcrCodexProfiles(postProbeConfig);
  await freshRpc("saveConfig", [safeConfig, { applyProfile: false }]);
  assert.deepEqual(await read(sentinelPath), sentinelBytes, "safe applyProfile:false save mutated Codex sentinel");
  return { persistedConfig, rpc: freshRpc };
}

async function main() {
  const childNonce = process.argv[2] === "--sandbox-child" ? process.argv[3] : null;
  if (!childNonce || childNonce !== process.env.AIRKIT_E2E_SANDBOX_NONCE) {
    runSandboxController();
    return;
  }
  const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const root = await mkdtemp(join(tmpdir(), "airkit-ccr3-e2e-"));
  const runtimeRoot = join(root, "runtime");
  const inherited = Object.fromEntries(
    ["PATH", "TMPDIR", "LANG", "LC_ALL", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY"]
      .filter((name) => process.env[name])
      .map((name) => [name, process.env[name]]),
  );
  const env = createIsolatedEnvironment(root, inherited);
  env.NPM_CONFIG_CACHE = join(root, "npm-cache");
  env.NPM_CONFIG_USERCONFIG = join(root, "npmrc");
  env.FAKE_PROVIDER_API_KEY = "fixture-key";
  env.FAKE_NATIVE_LOG_PREFIX = `airkit-e2e-native-${randomUUID()}`;
  assertIsolatedEnvironment(root, env, homedir());

  let failed = false;
  let fakeProvider;
  try {
    await Promise.all(ISOLATED_PATH_VARIABLES.map((name) => mkdir(env[name], { recursive: true })));
    const sqliteBefore = await findFiles(root, (path) => path.endsWith(".sqlite"));
    assert.deepEqual(sqliteBefore, [], "isolated root must start without CCR SQLite state");

    const packed = run("npm", ["pack", repositoryRoot, "--pack-destination", root], env, 120_000);
    assert.equal(packed.status, 0, `AirKit package build failed: ${packed.stderr}`);
    const packageArchive = join(root, packed.stdout.trim().split("\n").at(-1));
    const requestedCcrVersion = process.env.AIRKIT_CCR_E2E_VERSION ?? "3.0.4";
    assert.equal(isSupportedCcrVersion(requestedCcrVersion), true, "requested CCR verifier version is outside >=3.0.4 <4");
    const install = run("npm", [
      "install",
      "--prefix",
      runtimeRoot,
      "--no-package-lock",
      "--no-audit",
      "--no-fund",
      `@musistudio/claude-code-router@${requestedCcrVersion}`,
      packageArchive,
    ], env, 120_000);
    assert.equal(install.status, 0, `isolated npm install failed: ${install.stderr}`);

    const ccr = join(runtimeRoot, "node_modules", ".bin", "ccr");
    const fakeBin = join(root, "fake-bin");
    await installFakeClaude(fakeBin);
    env.FAKE_CLAUDE_RESULT_FILE = join(root, "fake-claude-result.json");
    env.AIRKIT_E2E_EXPECTED_CLAUDE_HOME = env.CLAUDE_CONFIG_DIR;
    env.PATH = `${fakeBin}:${dirname(ccr)}:${env.PATH ?? ""}`;
    const ccrPackage = JSON.parse(await readFile(
      join(runtimeRoot, "node_modules", "@musistudio", "claude-code-router", "package.json"),
      "utf8",
    ));
    assert.equal(
      isSupportedCcrVersion(ccrPackage.version),
      true,
      `CCR ${ccrPackage.version} does not satisfy >=3.0.4 <4`,
    );

    const providerPort = await reservePort();
    fakeProvider = await startFakeProvider(fakeBin, providerPort, join(root, "fake-provider-request.json"), env);
    env.FAKE_PROVIDER_PROBE_URL = `http://127.0.0.1:${providerPort}/health`;
    const gatewayPort = await reservePort();
    let corePort = await reservePort();
    while (corePort === gatewayPort || corePort === 3457) corePort = await reservePort();
    assert.notEqual(gatewayPort, 3456);
    assert.notEqual(corePort, 3457);

    const sentinelPath = join(env.HOME, ".codex", "config.toml");
    const sentinelBytes = Buffer.from("CCR_CONTRACT_SENTINEL = \"must-remain-byte-exact\"\n");
    await mkdir(dirname(sentinelPath), { recursive: true });
    await writeFile(sentinelPath, sentinelBytes, { mode: 0o600 });

    const management = run(ccr, ["start", "--no-gateway"], env);
    assert.equal(management.status, 0, `CCR management start failed: ${management.stderr}`);
    let rpc = await createRpcClient(env);
    const initialConfig = await rpc("getConfig");
    assert.deepEqual(await readFile(sentinelPath), sentinelBytes, "management start/getConfig mutated Codex sentinel");
    const existingCodexProfile = initialConfig.profile?.profiles?.find((profile) => profile.agent === "codex" && profile.enabled)
      ?? initialConfig.profile?.profiles?.find((profile) => profile.agent === "codex");
    assert.ok(existingCodexProfile, "CCR must provide a Codex profile for the persisted takeover probe");
    const dangerousProfile = {
      ...existingCodexProfile,
      codexHome: "",
      configFile: sentinelPath,
      enabled: true,
      scope: "global",
    };
    const configured = configureIsolatedGateway(initialConfig, { corePort, gatewayPort });
    ({ rpc } = await verifyDangerousCodexPersistence({
      ccr,
      dangerousProfile,
      env,
      initialConfig,
      postProbeConfig: configured,
      rpc,
      sentinelBytes,
      sentinelPath,
    }));

    const sqliteAfterInit = await findFiles(root, (path) => path.endsWith(".sqlite"));
    assert.ok(sqliteAfterInit.length > 0, "CCR must initialize SQLite inside the isolated root");

    const installedRuntime = await import(pathToFileURL(
      join(runtimeRoot, "node_modules", "@lzong", "ai-runtime-kit", "src", "airkit.mjs"),
    ));
    const catalog = fakeCatalog(providerPort);
    let managedSaves = 0;
    const savedConfigs = [];
    const trackedFetch = async (input, init) => {
      if (typeof init?.body === "string") {
        const request = JSON.parse(init.body);
        if (request.method === "saveConfig") {
          managedSaves += 1;
          savedConfigs.push(request.args[0]);
        }
      }
      return fetch(input, init);
    };
    const prepareOptions = {
      commandExists: async (command) => ["ccr", "claude"].includes(command),
      configDir: env.AIRKIT_CONFIG_DIR,
      env,
      fetch: trackedFetch,
      launch: false,
      mode: "auto",
      runtimeVersions: { claudeCode: "2.1.208", claudeCodeRouter: ccrPackage.version, node: process.versions.node },
    };
    await installedRuntime.prepareLaunch(catalog, "ccr3-e2e", prepareOptions);
    assert.equal(managedSaves, 1, "first prepare must persist the AirKit-managed config once");
    const firstManagedConfig = await rpc("getConfig");
    await installedRuntime.prepareLaunch(catalog, "ccr3-e2e", prepareOptions);
    assert.equal(
      managedSaves,
      1,
      `second prepare must be idempotent; changed paths: ${differencePaths(firstManagedConfig, savedConfigs[1]).join(", ")}`,
    );
    assert.deepEqual(await rpc("getConfig"), firstManagedConfig);

    const managedProfileId = "airkit-ccr3-e2e-auto";
    const launched = await installedRuntime.prepareLaunch(catalog, "ccr3-e2e", {
      ...prepareOptions,
      launch: true,
    });
    assert.ok(launched.child, "installed named CCR profile must spawn fake claude");
    assert.equal(await waitForExit(launched.child, 10_000), true, "installed fake claude did not exit");
    assert.equal(
      launched.child.exitCode ?? launched.child.status,
      0,
      "installed named CCR profile must launch fake claude successfully",
    );

    const liveConfig = await rpc("getConfig");
    assert.equal(
      liveConfig.plugins?.some((plugin) => plugin.id === "airkit-compatibility"),
      false,
      "adapter-managed CCR config must not register the legacy public compatibility route",
    );
    assert.equal(liveConfig.observability?.requestLogs, true, "adapter-managed CCR must record native request logs");
    const endpoint = installedRuntime.resolveCcrGatewayEndpoint(liveConfig);
    assert.equal(Number(endpoint.port), gatewayPort);
    const health = await fetch(new URL("/health", endpoint), { signal: AbortSignal.timeout(5_000) });
    assert.equal(health.ok, true, `configured gateway health failed: HTTP ${health.status}`);
    const managedProfile = liveConfig.profile.profiles.find((profile) => profile.id === managedProfileId);
    assert.ok(managedProfile);
    const payload = JSON.parse(await readFile(env.FAKE_CLAUDE_RESULT_FILE, "utf8"));
    assert.notEqual(payload.gatewayBaseUrl, endpoint.origin, "compatibility launch must use the loopback adapter");
    assert.equal(
      payload.claudeConfigDir,
      env.CLAUDE_CONFIG_DIR,
      "the launched child must keep the Claude home it inherited",
    );
    // Resolve the key the way the launcher does, through the profile's
    // generated helper, rather than through a settings file the child no
    // longer reads.
    const gatewayKeyResult = run(launched.launch.gatewayTokenCommand, [], env);
    assert.equal(gatewayKeyResult.status, 0, "isolated CCR gateway key helper failed");
    const gatewayApiKey = gatewayKeyResult.stdout.trim();
    assert.ok(gatewayApiKey.length > 0, "isolated CCR gateway key helper returned an empty key");
    const nativeRequestLogs = await runAdapterRequestLogScenarios({
      expectedClient: "Profile: AirKit ccr3-e2e auto",
      expectedModel: "fake-model",
      expectedProvider: "airkit-provider-ccr3-e2e-fake-openai",
      markers: {
        abort: `${env.FAKE_NATIVE_LOG_PREFIX}-abort`,
        json: `${env.FAKE_NATIVE_LOG_PREFIX}-json`,
        sse: `${env.FAKE_NATIVE_LOG_PREFIX}-sse`,
      },
      rpc,
    });
    const fallbackFamilies = ["webSearch", "webFetch", "codeExecution", "mcpConnector"];
    const providerRequests = JSON.parse(await readFile(fakeProvider.requestFile, "utf8"));
    const installedCompatRoot = join(runtimeRoot, "node_modules", "@lzong", "ai-runtime-kit", "src", "compat");
    const [{ inspectPendingServerHistory }, { resolveCompatibilityPolicies }] = await Promise.all([
      import(pathToFileURL(join(installedCompatRoot, "server-history.mjs"))),
      import(pathToFileURL(join(installedCompatRoot, "config.mjs"))),
    ]);
    const fallbackEvidence = summarizeFallbackEvidence(providerRequests, { inspectPendingServerHistory });
    assertFallbackProviderRequests(providerRequests, `http://127.0.0.1:${providerPort}`, fallbackFamilies);
    assert.deepEqual(fallbackEvidence.map(({ family }) => family), fallbackFamilies);
    assert.equal(
      JSON.stringify(providerRequests).includes(gatewayApiKey),
      false,
      "generated outer gateway key reached provider",
    );
    assert.equal(JSON.stringify(providerRequests).includes("ccr-local"), false, "outer gateway key reached provider");
    const compatibilityPolicies = resolveCompatibilityPolicies(fakeCompatibilityConfig("mcp"), {}).policies;
    assert.equal(Object.keys(compatibilityPolicies).length, 6);

    assert.equal(payload.content?.[0]?.text, "FAKE_PROVIDER_OK");
    assert.equal(payload.compatibilityMcp?.serverInfo?.name, "airkit-compatibility");
    assert.equal(payload.compatibilityMcp?.protocolVersion, "2025-03-26");
    assert.equal(payload.ambientSentinel, undefined, "ambient controller env leaked into the CCR/Claude child");
    const providerRequest = providerRequests.find(({ body }) => body.model === "fake-model");
    assert.ok(providerRequest, "fake OpenAI provider did not receive the ordinary launch request");
    assert.equal(providerRequest.url, "/v1/chat/completions");
    assert.equal(providerRequest.body.model, "fake-model");
    assert.ok(providerRequests
      .filter(({ body }) => body.metadata?.user_id?.startsWith("airkit-e2e-"))
      .every(({ url }) => url === "/v1/messages"), "fallback requests must use Anthropic Messages");

    assert.ok(resolve(managedProfile.settingsFile).startsWith(`${resolve(root)}/`));
    assert.ok(resolve(managedProfile.env.CLAUDE_STATUSLINE_CACHE_DIR).startsWith(`${resolve(root)}/`));
    assert.equal(JSON.stringify(managedProfile).includes(homedir()), false);

    process.stdout.write(`${JSON.stringify({
      ccrVersion: ccrPackage.version,
      compatibilityPolicies,
      fakeProviderResponse: payload.content[0].text,
      gateway: endpoint.origin,
      idempotentManagedSaves: managedSaves,
      fallbackEvidence,
      compatibilityMcp: payload.compatibilityMcp.serverInfo.name,
      namedProfile: managedProfileId,
      nativeRequestLogs,
      realHomeAccessDenied: true,
      realHomeReferenced: false,
      sqliteFiles: sqliteAfterInit.length,
    }, null, 2)}\n`);
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    const ccr = join(runtimeRoot, "node_modules", ".bin", "ccr");
    run(ccr, ["stop"], env, 30_000, true);
    await new Promise((done) => setTimeout(done, 500));
    if (fakeProvider) {
      fakeProvider.child.kill("SIGTERM");
      if (!(await waitForExit(fakeProvider.child, 2_000))) {
        fakeProvider.child.kill("SIGKILL");
        await waitForExit(fakeProvider.child, 2_000);
      }
    }
    await finalizeIsolatedRoot(root, failed);
  }
}

function runSandboxController() {
  if (process.platform !== "darwin") {
    throw new Error("CCR E2E real-home access enforcement currently requires macOS sandbox-exec");
  }
  const scriptPath = fileURLToPath(import.meta.url);
  const repositoryRoot = resolve(dirname(scriptPath), "..");
  const realHome = resolve(homedir());
  const nodeRoot = resolve(process.execPath, "..", "..");
  const nonce = randomUUID();
  const metadataPaths = [...new Set([
    ...ancestorPaths(repositoryRoot, realHome),
    ...ancestorPaths(nodeRoot, realHome),
  ])];
  const profile = [
    "(version 1)",
    "(allow default)",
    `(deny file-read* file-write* (subpath ${sandboxLiteral(realHome)}))`,
    ...metadataPaths.map((path) => `(allow file-read-metadata (literal ${sandboxLiteral(path)}))`),
    `(allow file-read* (subpath ${sandboxLiteral(repositoryRoot)}))`,
    `(allow file-read* (subpath ${sandboxLiteral(nodeRoot)}))`,
  ].join(" ");
  const result = spawnSync("/usr/bin/sandbox-exec", [
    "-p",
    profile,
    process.execPath,
    scriptPath,
    "--sandbox-child",
    nonce,
  ], {
    env: {
      ...process.env,
      AIRKIT_E2E_AMBIENT_SENTINEL: "must-not-reach-child",
      AIRKIT_E2E_SANDBOX_NONCE: nonce,
    },
    stdio: "inherit",
    timeout: 180_000,
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}

function ancestorPaths(path, stop) {
  const paths = [];
  for (
    let current = dirname(path);
    current === stop || current.startsWith(`${stop}/`);
    current = dirname(current)
  ) {
    paths.push(current);
    if (current === stop) break;
  }
  return paths;
}

function sandboxLiteral(value) {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

async function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return Promise.race([
    new Promise((done) => child.once("exit", () => done(true))),
    new Promise((done) => setTimeout(() => done(false), timeoutMs)),
  ]);
}

function fakeCatalog(providerPort) {
  return {
    schema: 1,
    profiles: [{
      name: "ccr3-e2e",
      visibility: "public",
      summary: "Isolated CCR 3 verification fixture.",
      // claudeModel is a bare Claude id on purpose: the fake claude sends it as
      // body.model, so the run proves the compat plugin's bare-model rewrite
      // end to end (provider must receive the routed provider-local model).
      launch: { binary: "claude", args: [], claudeModel: "claude-sonnet-5", defaultMode: "auto", modes: { auto: {} } },
      ccr: {
        APIKEY: "ccr-local",
        LOG: false,
        plugins: [{
          id: "airkit-compatibility",
          module: "@lzong/ai-runtime-kit/compatibility-plugin",
          config: fakeCompatibilityConfig("mcp"),
        }],
        Providers: [{
          name: "fake-openai",
          type: "openai_chat_completions",
          api_base_url: `http://127.0.0.1:${providerPort}/v1/chat/completions`,
          api_key: "$FAKE_PROVIDER_API_KEY",
          models: ["fake-model"],
        }, {
          name: "fake-anthropic",
          type: "anthropic_messages",
          api_base_url: `http://127.0.0.1:${providerPort}/v1/messages`,
          api_key: "$FAKE_PROVIDER_API_KEY",
          models: ["claude-sonnet"],
        }],
        Router: { default: "fake-openai,fake-model", background: "fake-openai,fake-model" },
      },
    }],
  };
}

function fakeCompatibilityConfig(webSearchMode = "native-first") {
  return {
    fallback: {
      provider: "fake-anthropic",
      model: "claude-sonnet",
      maxContinuationTurns: 8,
    },
    advisor: { mode: "anthropic-fallback" },
    codeExecution: { mode: "anthropic-fallback" },
    mcpConnector: { mode: "anthropic-fallback" },
    toolSearch: { mode: "bridge" },
    webFetch: { mode: "native-first" },
    webSearch: { mode: webSearchMode },
  };
}

export async function runFallbackGatewayScenarios({
  apiKey,
  fetchImpl = fetch,
  gatewayOrigin,
  loopbackOrigin,
}) {
  const fallbackFamilies = ["advisor", "webSearch", "webFetch", "codeExecution", "mcpConnector"];
  const scenarios = {
    advisor: {
      tools: [{
        type: "advisor_20260301",
        name: "advisor",
        model: "claude-sonnet",
        max_uses: 3,
      }],
    },
    webSearch: { tools: [{ type: "web_search_20260318" }] },
    webFetch: {
      messages: [{ role: "user", content: `Fetch ${loopbackOrigin}/webFetch-fixture only.` }],
      tools: [{ type: "web_fetch_20260209" }],
    },
    codeExecution: {
      container: { id: "container_fixture" },
      messages: [{
        role: "assistant",
        content: [
          { type: "server_tool_use", id: "srvtoolu_code", name: "code_execution", input: {} },
          {
            type: "code_execution_tool_result",
            tool_use_id: "srvtoolu_code",
            content: { type: "code_execution_result", stdout: "fixture" },
          },
        ],
      }],
      tools: [{ type: "code_execution_20260120" }],
    },
    mcpConnector: {
      container: { id: "container_mcp_fixture" },
      mcp_servers: [{ type: "url", url: `${loopbackOrigin}/mcp-fixture` }],
      tools: [{ type: "mcp_toolset" }],
    },
  };
  for (const family of fallbackFamilies) {
    const body = {
      metadata: { user_id: `airkit-e2e-${family}`, contract_marker: "preserve-me" },
      model: "fake-model",
      max_tokens: 32,
      messages: [{ role: "user", content: "fixture" }],
      ...scenarios[family],
    };
    const response = await fetchImpl(new URL("/v1/messages", gatewayOrigin), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "x-request-id": `fixture-${family}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    const payload = await response.json();
    const errorMessage = String(payload?.error?.message ?? "").slice(0, 200);
    assert.equal(
      response.ok,
      true,
      `${family} gateway fallback failed: HTTP ${response.status}${errorMessage ? ` (${errorMessage})` : ""}`,
    );
    assert.equal(payload.type, "message", `${family} gateway fallback returned a non-message`);
    if (family === "advisor") {
      assert.deepEqual(payload.content.map(({ type }) => type), ["server_tool_use", "advisor_tool_result"]);
      assert.deepEqual(payload.content[1].content, {
        type: "advisor_redacted_result",
        encrypted_content: "fixture",
      });
    }
    if (family === "codeExecution") {
      assert.deepEqual(payload.content.map(({ type }) => type), ["server_tool_use", "code_execution_tool_result"]);
    }
  }
  return fallbackFamilies;
}

export async function runAdapterRequestLogScenarios({
  expectedClient,
  expectedModel,
  expectedProvider,
  markers,
  rpc,
}) {
  const expected = {
    client: expectedClient,
    durationMs: (durationMs) => assert.ok(Number.isFinite(durationMs) && durationMs >= 0,
      "native request log must retain a non-negative duration"),
    model: expectedModel,
    provider: expectedProvider,
  };
  const jsonLog = await awaitNativeRequestLog({
    expected: { ...expected, isStream: false, statusCode: 200 },
    marker: markers.json,
    rpc,
  });

  const sseLog = await awaitNativeRequestLog({
    expected: { ...expected, isStream: true, statusCode: 200 },
    marker: markers.sse,
    rpc,
  });

  const abortLog = await awaitNativeRequestLog({
    expected: { ...expected, isStream: false, statusCode: 499 },
    marker: markers.abort,
    rpc,
  });

  return Object.fromEntries(Object.entries({ abort: abortLog, json: jsonLog, sse: sseLog }).map(([scenario, row]) => [
    scenario,
    {
      client: row.client,
      durationMs: row.durationMs,
      isStream: row.isStream,
      model: row.model,
      provider: row.provider,
      statusCode: row.statusCode,
    },
  ]));
}

export function assertFallbackProviderRequests(
  records,
  loopbackOrigin,
  expectedFamilies = ["advisor", "webSearch", "webFetch", "codeExecution", "mcpConnector"],
) {
  const byFamily = new Map(records.flatMap((record) => {
    const userId = record.body?.metadata?.user_id;
    return typeof userId === "string" && userId.startsWith("airkit-e2e-")
      ? [[userId.slice("airkit-e2e-".length), record]]
      : [];
  }));
  assert.equal(byFamily.size, expectedFamilies.length);
  assert.deepEqual([...byFamily.keys()].sort(), [...expectedFamilies].sort());
  for (const [family, record] of byFamily) {
    assert.equal(record.url, "/v1/messages", `${family} used the wrong provider protocol`);
    assert.equal(record.body.metadata.contract_marker, "preserve-me");
    assert.equal(record.headers["anthropic-version"], "2023-06-01");
  }
  if (byFamily.has("advisor")) {
    assert.deepEqual(byFamily.get("advisor").body.tools, [{
      type: "advisor_20260301",
      name: "advisor",
      model: "claude-sonnet",
      max_uses: 3,
    }]);
  }
  assert.deepEqual(byFamily.get("webSearch").body.tools, [{ type: "web_search_20260318" }]);
  assert.deepEqual(byFamily.get("webFetch").body.tools, [{ type: "web_fetch_20260209" }]);
  assert.match(byFamily.get("webFetch").body.messages[0].content, new RegExp(`${loopbackOrigin}/webFetch-fixture`));
  assert.deepEqual(byFamily.get("codeExecution").body.container, { id: "container_fixture" });
  assert.deepEqual(byFamily.get("codeExecution").body.tools, [{ type: "code_execution_20260120" }]);
  assert.equal(byFamily.get("codeExecution").body.messages[0].content[0].type, "server_tool_use");
  assert.equal(byFamily.get("codeExecution").body.messages[0].content[1].type, "code_execution_tool_result");
  assert.deepEqual(byFamily.get("mcpConnector").body.mcp_servers, [{
    type: "url",
    url: `${loopbackOrigin}/mcp-fixture`,
  }]);
  assert.deepEqual(byFamily.get("mcpConnector").body.tools, [{ type: "mcp_toolset" }]);
}

export function summarizeFallbackEvidence(records, { inspectPendingServerHistory }) {
  const evidence = records.flatMap(({ body, headers }) => {
    const userId = body?.metadata?.user_id;
    if (typeof userId !== "string" || !userId.startsWith("airkit-e2e-")) return [];
    const history = inspectPendingServerHistory(body);
    return [{
      bodyHash: createHash("sha256").update(JSON.stringify(body)).digest("hex"),
      container: history.containerId,
      continuationCount: history.continuationTurns,
      fallbackModel: body.model,
      redactedHeaders: redactProviderHeaders(headers),
      family: userId.slice("airkit-e2e-".length),
    }];
  });
  assert.ok(evidence.every(({ bodyHash }) => /^[a-f0-9]{64}$/.test(bodyHash)));
  assert.ok(evidence.every(({ fallbackModel }) => fallbackModel === "claude-sonnet"));
  assert.equal(evidence.find(({ family }) => family === "codeExecution").continuationCount, 1);
  assert.equal(evidence.find(({ family }) => family === "codeExecution").container, "container_fixture");
  return evidence;
}

function redactProviderHeaders(headers = {}) {
  const selected = ["anthropic-version", "x-api-key", "x-request-id"];
  return Object.fromEntries(selected.flatMap((name) => {
    if (!Object.hasOwn(headers, name)) return [];
    return [[name, name === "x-api-key" ? "[redacted]" : "[present]"]];
  }));
}

async function startFakeProvider(binDir, port, requestFile, env) {
  const path = join(binDir, "fake-provider.mjs");
  await writeFile(path, `import { createServer } from "node:http";
import { writeFile } from "node:fs/promises";
const server = createServer((request, response) => {
  if (request.method === "GET" && request.url === "/health") {
    response.writeHead(200).end("ok");
    return;
  }
  if (request.method !== "POST") {
    response.writeHead(404).end();
    return;
  }
  const chunks = [];
  request.on("data", (chunk) => chunks.push(chunk));
  request.on("end", async () => {
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    records.push({
      method: request.method,
      url: request.url,
      headers: request.headers,
      body,
    });
    await writeFile(process.env.FAKE_PROVIDER_REQUEST_FILE, JSON.stringify(records));
    const credentialValid = request.url === "/v1/chat/completions"
      ? request.headers.authorization === "Bearer fixture-key"
      : request.headers["x-api-key"] === "fixture-key";
    if (!credentialValid) {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "invalid fixture credential" } }));
      return;
    }
    if (!["fake-model", "claude-sonnet"].includes(body.model)) {
      response.writeHead(422, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "unexpected fixture model" } }));
      return;
    }
    const marker = body.messages?.flatMap((message) => typeof message.content === "string" ? [message.content] : []).join(" ") ?? "";
    if (marker.endsWith("-abort")) {
      setTimeout(() => {
        if (!response.destroyed) response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ type: "message" }));
      }, 1_000);
      return;
    }
    if (body.stream === true) {
      const messageStart = JSON.stringify({
        type: "message_start",
        message: {
          id: "fixture-stream",
          type: "message",
          role: "assistant",
          model: body.model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 0 },
        },
      });
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end([
        "event: message_start",
        "data: " + messageStart,
        "",
        "event: message_stop",
        "data: " + JSON.stringify({ type: "message_stop" }),
        "",
      ].join("\\n"));
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    const family = body.metadata?.user_id?.slice("airkit-e2e-".length);
    const serverContent = family === "advisor" ? [
      { type: "server_tool_use", id: "srvtoolu_advisor_response", name: "advisor", input: {} },
      { type: "advisor_tool_result", tool_use_id: "srvtoolu_advisor_response", content: { type: "advisor_redacted_result", encrypted_content: "fixture" } },
    ] : family === "codeExecution" ? [
      { type: "server_tool_use", id: "srvtoolu_code_response", name: "code_execution", input: {} },
      { type: "code_execution_tool_result", tool_use_id: "srvtoolu_code_response", content: { type: "code_execution_result", stdout: "fixture-response" } },
    ] : [{ type: "text", text: "FAKE_PROVIDER_OK" }];
    response.end(JSON.stringify(request.url === "/v1/chat/completions" ? {
      id: "fixture-openai-response",
      object: "chat.completion",
      created: 1,
      model: body.model,
      choices: [{ index: 0, message: { role: "assistant", content: "FAKE_PROVIDER_OK" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    } : {
      id: "fixture-anthropic-response",
      type: "message",
      role: "assistant",
      model: body.model,
      content: serverContent,
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    }));
  });
});
const records = [];
await writeFile(process.env.FAKE_PROVIDER_REQUEST_FILE, "[]");
server.listen(Number(process.env.FAKE_PROVIDER_PORT), "127.0.0.1");
process.on("SIGTERM", () => server.close(() => process.exit(0)));
`);
  const child = spawn(process.execPath, [path], {
    env: { ...env, FAKE_PROVIDER_PORT: String(port), FAKE_PROVIDER_REQUEST_FILE: requestFile },
    stdio: "ignore",
  });
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return { child, requestFile };
    } catch {
      // The child may still be binding its socket.
    }
    await new Promise((done) => setTimeout(done, 100));
  }
  child.kill("SIGTERM");
  throw new Error("fake provider did not become healthy");
}

async function installFakeClaude(binDir) {
  await mkdir(binDir, { recursive: true });
  const path = join(binDir, "claude");
  await writeFile(path, `#!/usr/bin/env node
import { readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
const assertNoManagedApiKeyHelperOverride = (${assertNoManagedApiKeyHelperOverride.toString()});
assertNoManagedApiKeyHelperOverride(process.argv.slice(2));
const mcpConfigIndex = process.argv.indexOf("--mcp-config");
if (mcpConfigIndex === -1) throw new Error("compatibility MCP config was not supplied");
if (process.argv.includes("--strict-mcp-config")) throw new Error("compatibility MCP must remain additive");
const mcpConfig = JSON.parse(process.argv[mcpConfigIndex + 1]);
const compatibilityMcp = mcpConfig.mcpServers?.["airkit-compatibility"];
if (compatibilityMcp?.url !== "\${AIRKIT_COMPATIBILITY_MCP_URL}") {
  throw new Error("compatibility MCP URL must remain an environment placeholder");
}
if (compatibilityMcp?.headers?.["x-api-key"] !== "\${AIRKIT_COMPATIBILITY_MCP_TOKEN}") {
  throw new Error("compatibility MCP token must remain an environment placeholder");
}
const baseUrl = process.env.ANTHROPIC_BASE_URL;
const gatewayToken = process.env.ANTHROPIC_AUTH_TOKEN;
if (!baseUrl || !gatewayToken) throw new Error("direct launch did not supply the gateway URL and key");
// The launch model arrives as an argument, not an environment default: a
// stale ANTHROPIC_MODEL would outrank it silently.
const modelIndex = process.argv.indexOf("--model");
const model = modelIndex === -1 ? null : process.argv[modelIndex + 1];
if (!model) throw new Error("direct launch did not supply --model");
for (const name of ["ANTHROPIC_MODEL", "ANTHROPIC_SMALL_FAST_MODEL", "ANTHROPIC_API_KEY"]) {
  if (process.env[name]) throw new Error(\`direct launch must clear \${name}\`);
}
if (process.env.ANTHROPIC_CUSTOM_HEADERS !== "x-airkit-mode: auto") {
  throw new Error("direct launch must label its routing mode");
}
// The whole point of the direct launch: Claude keeps the home it inherited.
if (process.env.CLAUDE_CONFIG_DIR !== process.env.AIRKIT_E2E_EXPECTED_CLAUDE_HOME) {
  throw new Error(\`direct launch redirected CLAUDE_CONFIG_DIR to \${process.env.CLAUDE_CONFIG_DIR}\`);
}
if (!(await fetch(process.env.FAKE_PROVIDER_PROBE_URL, { signal: AbortSignal.timeout(5_000) })).ok) {
  throw new Error("fake provider is not reachable from fake Claude");
}
for (const path of await findSettingsFiles(dirname(process.env.HOME))) {
  const settings = JSON.parse(await readFile(path, "utf8"));
  if (Object.hasOwn(settings, "model")) throw new Error(\`managed settings must not persist a Claude model default: \${path}\`);
}
const response = await fetch(new URL("/v1/messages", baseUrl), {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-api-key": gatewayToken,
  },
  body: JSON.stringify({ max_tokens: 16, messages: [{ role: "user", content: "fixture" }], model }),
  signal: AbortSignal.timeout(10_000),
});
const payload = await response.json();
if (!response.ok) throw new Error(JSON.stringify(payload));
const nativePrefix = process.env.FAKE_NATIVE_LOG_PREFIX;
if (!nativePrefix) throw new Error("native request-log marker prefix was not supplied");
const nativeMarkers = {
  abort: nativePrefix + "-abort",
  json: nativePrefix + "-json",
  sse: nativePrefix + "-sse",
};
const adapterRequest = (marker, options = {}) => fetch(new URL("/v1/messages", baseUrl), {
  ...options,
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-api-key": gatewayToken,
    ...(options.headers ?? {}),
  },
  body: JSON.stringify({
    max_tokens: 16,
    messages: [{ role: "user", content: marker }],
    model,
    ...(options.body ?? {}),
  }),
});
const nativeJsonResponse = await adapterRequest(nativeMarkers.json, { signal: AbortSignal.timeout(10_000) });
if (!nativeJsonResponse.ok || (await nativeJsonResponse.json()).type !== "message") {
  throw new Error("adapter JSON fixture request failed");
}
const nativeSseResponse = await adapterRequest(nativeMarkers.sse, {
  body: { stream: true },
  headers: { accept: "text/event-stream" },
  signal: AbortSignal.timeout(10_000),
});
if (!nativeSseResponse.ok || !(nativeSseResponse.headers.get("content-type") ?? "").includes("text/event-stream")) {
  throw new Error("adapter SSE fixture request failed");
}
if (!/event: message_start/.test(await nativeSseResponse.text())) {
  throw new Error("adapter SSE fixture response was not preserved");
}
const abortController = new AbortController();
const nativeAbort = adapterRequest(nativeMarkers.abort, { signal: abortController.signal });
await new Promise((resolve) => setTimeout(resolve, 100));
abortController.abort();
try {
  await nativeAbort;
  throw new Error("adapter abort fixture request unexpectedly completed");
} catch (error) {
  if (error?.name !== "AbortError") throw error;
}
const fallbackFamilies = ["webSearch", "webFetch", "codeExecution", "mcpConnector"];
const providerOrigin = new URL(process.env.FAKE_PROVIDER_PROBE_URL).origin;
const fallbackScenarios = {
  webSearch: { tools: [{ type: "web_search_20260318" }] },
  webFetch: {
    messages: [{ role: "user", content: "Fetch " + providerOrigin + "/webFetch-fixture only." }],
    tools: [{ type: "web_fetch_20260209" }],
  },
  codeExecution: {
    container: { id: "container_fixture" },
    messages: [{
      role: "assistant",
      content: [
        { type: "server_tool_use", id: "srvtoolu_code", name: "code_execution", input: {} },
        {
          type: "code_execution_tool_result",
          tool_use_id: "srvtoolu_code",
          content: { type: "code_execution_result", stdout: "fixture" },
        },
      ],
    }],
    tools: [{ type: "code_execution_20260120" }],
  },
  mcpConnector: {
    container: { id: "container_mcp_fixture" },
    mcp_servers: [{ type: "url", url: providerOrigin + "/mcp-fixture" }],
    tools: [{ type: "mcp_toolset" }],
  },
};
for (const family of fallbackFamilies) {
  const fallbackResponse = await fetch(new URL("/v1/messages", baseUrl), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": gatewayToken,
      "anthropic-version": "2023-06-01",
      "x-request-id": "fixture-" + family,
    },
    body: JSON.stringify({
      metadata: { user_id: "airkit-e2e-" + family, contract_marker: "preserve-me" },
      model: "fake-model",
      max_tokens: 32,
      messages: [{ role: "user", content: "fixture" }],
      ...fallbackScenarios[family],
    }),
    signal: AbortSignal.timeout(10_000),
  });
  const fallbackPayload = await fallbackResponse.json();
  if (!fallbackResponse.ok || fallbackPayload.type !== "message") {
    throw new Error("adapter fallback fixture failed for " + family);
  }
  if (family === "codeExecution") {
    const types = fallbackPayload.content.map(({ type }) => type);
    if (JSON.stringify(types) !== JSON.stringify(["server_tool_use", "code_execution_tool_result"])) {
      throw new Error("adapter code-execution fallback fixture returned the wrong content");
    }
  }
}
const mcpResponse = await fetch(process.env.AIRKIT_COMPATIBILITY_MCP_URL, {
  method: "POST",
  headers: {
    "x-api-key": process.env.AIRKIT_COMPATIBILITY_MCP_TOKEN,
    "content-type": "application/json",
  },
  body: JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "airkit-e2e", version: "1" },
    },
  }),
  signal: AbortSignal.timeout(10_000),
});
const mcpPayload = await mcpResponse.json();
if (!mcpResponse.ok || mcpPayload.error) throw new Error(JSON.stringify(mcpPayload));
await writeFile(process.env.FAKE_CLAUDE_RESULT_FILE, JSON.stringify({
  ...payload,
  ambientSentinel: process.env.AIRKIT_E2E_AMBIENT_SENTINEL,
  claudeConfigDir: process.env.CLAUDE_CONFIG_DIR,
  compatibilityMcp: mcpPayload.result,
  gatewayBaseUrl: baseUrl,
  launchModel: model,
  nativeMarkers,
}));

async function findSettingsFiles(root) {
  const matches = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && entry.name === "settings.json") matches.push(path);
    }
  }
  await visit(root);
  return matches;
}
`);
  await chmod(path, 0o755);
}

async function reservePort() {
  const server = createServer();
  await new Promise((done, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", done);
  });
  const { port } = server.address();
  await new Promise((done) => server.close(done));
  return port;
}

async function createRpcClient(env) {
  const service = JSON.parse(await readFile(join(env.CCR_INTERNAL_HOME_DIR, ".claude-code-router", "service.json"), "utf8"));
  const serviceUrl = new URL(service.url);
  const token = serviceUrl.searchParams.get("ccr_web_token");
  assert.ok(token, "isolated CCR service must provide a management token");
  return async (method, args = []) => {
    const response = await fetch(new URL("/api/ccr/rpc", serviceUrl.origin), {
      method: "POST",
      headers: { "content-type": "application/json", origin: serviceUrl.origin, "x-ccr-web-auth": token },
      body: JSON.stringify({ method, args }),
      signal: AbortSignal.timeout(5_000),
    });
    const payload = await response.json();
    if (!response.ok || payload.error) {
      throw new Error(`CCR RPC ${method} failed: ${payload.error?.message ?? `HTTP ${response.status}`}`);
    }
    return payload.value;
  };
}

async function findFiles(root, predicate) {
  const matches = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (predicate(path)) matches.push(path);
    }
  }
  await visit(root);
  return matches;
}

function run(command, args, env, timeout = 30_000, allowMissing = false) {
  const result = spawnSync(command, args, { encoding: "utf8", env, timeout });
  if (result.error && !allowMissing) throw result.error;
  return result;
}

function differencePaths(left, right, prefix = "$") {
  if (Object.is(left, right)) return [];
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return [prefix];
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  return [...keys].flatMap((key) => differencePaths(left[key], right[key], `${prefix}.${key}`));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.stack ?? error}\n`);
    process.exitCode = 1;
  });
}
