#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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
  read = readFile,
  rpc,
  rpcFactory = createRpcClient,
  runCommand = run,
  safeConfig,
  sentinelBytes,
  sentinelPath,
}) {
  await rpc("saveConfig", [{
    ...initialConfig,
    profile: {
      ...(initialConfig.profile ?? {}),
      profiles: [...(initialConfig.profile?.profiles ?? []), dangerousProfile],
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
  assert.deepEqual(persistedProfile, dangerousProfile, "dangerous Codex profile did not persist across restart");
  assert.deepEqual(await read(sentinelPath), sentinelBytes, "management restart/getConfig mutated Codex sentinel");

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
  assertIsolatedEnvironment(root, env, homedir());

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
    assert.notEqual(gatewayPort, 3456);

    const sentinelPath = join(env.HOME, ".codex", "config.toml");
    const sentinelBytes = Buffer.from("CCR_CONTRACT_SENTINEL = \"must-remain-byte-exact\"\n");
    await mkdir(dirname(sentinelPath), { recursive: true });
    await writeFile(sentinelPath, sentinelBytes, { mode: 0o600 });

    const management = run(ccr, ["start", "--no-gateway"], env);
    assert.equal(management.status, 0, `CCR management start failed: ${management.stderr}`);
    let rpc = await createRpcClient(env);
    const initialConfig = await rpc("getConfig");
    assert.deepEqual(await readFile(sentinelPath), sentinelBytes, "management start/getConfig mutated Codex sentinel");
    const dangerousProfile = {
      agent: "codex",
      configFile: sentinelPath,
      enabled: true,
      id: "airkit-contract-dangerous-codex",
      name: "AirKit isolated dangerous Codex contract probe",
      scope: "global",
    };
    const configured = {
      ...initialConfig,
      HOST: "127.0.0.1",
      PORT: gatewayPort,
      routerEndpoint: `http://127.0.0.1:${gatewayPort}`,
      gateway: { ...initialConfig.gateway, host: "127.0.0.1", port: gatewayPort },
    };
    ({ rpc } = await verifyDangerousCodexPersistence({
      ccr,
      dangerousProfile,
      env,
      initialConfig,
      rpc,
      safeConfig: configured,
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
    assert.equal(launched.child?.status, 0, "installed named CCR profile must launch fake claude successfully");

    const liveConfig = await rpc("getConfig");
    const endpoint = installedRuntime.resolveCcrGatewayEndpoint(liveConfig);
    assert.equal(Number(endpoint.port), gatewayPort);
    const health = await fetch(new URL("/health", endpoint), { signal: AbortSignal.timeout(5_000) });
    assert.equal(health.ok, true, `configured gateway health failed: HTTP ${health.status}`);

    const payload = JSON.parse(await readFile(env.FAKE_CLAUDE_RESULT_FILE, "utf8"));
    assert.equal(payload.content?.[0]?.text, "FAKE_PROVIDER_OK");
    assert.equal(payload.ambientSentinel, undefined, "ambient controller env leaked into the CCR/Claude child");
    assert.ok(resolve(payload.fixtureSettingsPath).startsWith(`${resolve(root)}/`));
    const providerRequest = JSON.parse(await readFile(fakeProvider.requestFile, "utf8"));
    assert.equal(providerRequest.url, "/v1/chat/completions");
    assert.equal(providerRequest.body.model, "fake-model");

    const managedProfile = liveConfig.profile.profiles.find((profile) => profile.id === managedProfileId);
    assert.ok(managedProfile);
    assert.ok(resolve(managedProfile.settingsFile).startsWith(`${resolve(root)}/`));
    assert.ok(resolve(managedProfile.env.CLAUDE_STATUSLINE_CACHE_DIR).startsWith(`${resolve(root)}/`));
    assert.equal(JSON.stringify(managedProfile).includes(homedir()), false);

    process.stdout.write(`${JSON.stringify({
      ccrVersion: ccrPackage.version,
      fakeProviderResponse: payload.content[0].text,
      gateway: endpoint.origin,
      idempotentManagedSaves: managedSaves,
      namedProfile: managedProfileId,
      realHomeAccessDenied: true,
      realHomeReferenced: false,
      sqliteFiles: sqliteAfterInit.length,
    }, null, 2)}\n`);
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
    await rm(root, { force: true, recursive: true });
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
      launch: { binary: "claude", args: [], defaultMode: "auto", modes: { auto: {} } },
      ccr: {
        LOG: false,
        Providers: [{
          name: "fake",
          type: "openai_chat_completions",
          api_base_url: `http://127.0.0.1:${providerPort}/v1/chat/completions`,
          api_key: "$FAKE_PROVIDER_API_KEY",
          models: ["fake-model"],
        }],
        Router: { default: "fake,fake-model", background: "fake,fake-model" },
      },
    }],
  };
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
    await writeFile(process.env.FAKE_PROVIDER_REQUEST_FILE, JSON.stringify({
      method: request.method,
      url: request.url,
      body,
    }));
    if (body.model !== "fake-model") {
      response.writeHead(422, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "unexpected fixture model" } }));
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      id: "fixture-response",
      object: "chat.completion",
      created: 0,
      model: "fake-model",
      choices: [{ index: 0, message: { role: "assistant", content: "FAKE_PROVIDER_OK" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }));
  });
});
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
import { execFileSync } from "node:child_process";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
const baseUrl = process.env.ANTHROPIC_BASE_URL;
const model = process.env.ANTHROPIC_MODEL;
if (!baseUrl || !model) throw new Error("named CCR profile did not supply gateway URL and model");
if (!(await fetch(process.env.FAKE_PROVIDER_PROBE_URL, { signal: AbortSignal.timeout(5_000) })).ok) {
  throw new Error("fake provider is not reachable from fake Claude");
}
const settingsFiles = await findSettingsFiles(dirname(process.env.HOME));
let helperSettings;
for (const path of settingsFiles) {
  const settings = JSON.parse(await readFile(path, "utf8"));
  if (Object.hasOwn(settings, "model")) throw new Error(\`managed settings must not persist a Claude model default: \${path}\`);
  if (settings.apiKeyHelper) helperSettings = { path, settings };
}
if (!helperSettings) throw new Error("CCR did not create an isolated apiKeyHelper setting");
const helperKey = helperSettings.settings.apiKeyHelper
  ? execFileSync("/bin/sh", ["-c", helperSettings.settings.apiKeyHelper], { encoding: "utf8", env: process.env }).trim()
  : "";
const response = await fetch(new URL("/v1/messages", baseUrl), {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-api-key": process.env.ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_AUTH_TOKEN ?? helperKey,
  },
  body: JSON.stringify({ max_tokens: 16, messages: [{ role: "user", content: "fixture" }], model }),
  signal: AbortSignal.timeout(10_000),
});
const payload = await response.json();
if (!response.ok) throw new Error(JSON.stringify(payload));
await writeFile(process.env.FAKE_CLAUDE_RESULT_FILE, JSON.stringify({
  ...payload,
  ambientSentinel: process.env.AIRKIT_E2E_AMBIENT_SENTINEL,
  fixtureSettingsPath: helperSettings.path,
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
