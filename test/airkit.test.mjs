import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import * as airkitRuntime from "../src/airkit.mjs";
import * as ccrVerifier from "../scripts/verify-ccr3-e2e.mjs";
import {
  buildHeartbeatResponse,
  parseTaskCapsule,
  processContextHook,
} from "../src/context-heartbeat.mjs";

import {
  buildLaunchPlan,
  buildShellSnippet,
  doctorProfile,
  exportOssRelease,
  installProfile,
  loadCatalog,
  prepareLaunch,
  runAirclaudeCli,
  runCli,
  updateProfile,
} from "../src/airkit.mjs";

const profile = "openai-compatible-example";

test("runtime requirements hard-cut to Node 22, Claude Code 2.1.208, and CCR 3.0.4", async () => {
  const packageJson = JSON.parse(
    await readFile(resolve(import.meta.dirname, "..", "package.json"), "utf8"),
  );

  assert.equal(packageJson.engines.node, ">=22");
  assert.deepEqual(airkitRuntime.RUNTIME_REQUIREMENTS, {
    claudeCode: ">=2.1.208",
    claudeCodeRouter: ">=3.0.4 <4",
    node: ">=22",
  });
});

test("catalog rejects invalid proactive compaction policy", async () => {
  const root = await mkdtemp(join(tmpdir(), "airkit-invalid-context-policy-"));
  const catalog = launchCatalog();
  const cases = [
    [{ autoCompactWindow: 99999 }, /autoCompactWindow must be an integer from 100000 to 1000000/],
    [{ autoCompactWindow: 300000.5 }, /autoCompactWindow must be an integer from 100000 to 1000000/],
    [{ autoCompactPercentage: 0 }, /autoCompactPercentage must be "default" or an integer from 1 to 100/],
    [{ autoCompactPercentage: "40" }, /autoCompactPercentage must be "default" or an integer from 1 to 100/],
    [{ extra: true }, /launch\.context contains unsupported field: extra/],
  ];

  try {
    for (const [index, [context, expected]] of cases.entries()) {
      catalog.profiles[0].launch.context = context;
      const catalogPath = join(root, `${index}.json`);
      await writeFile(catalogPath, `${JSON.stringify(catalog)}\n`);
      await assert.rejects(loadCatalog(catalogPath), expected);
    }
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("isolated verifier restarts management-only before trusting persisted dangerous Codex state", async () => {
  assert.equal(ccrVerifier.isSupportedCcrVersion("3.0.4"), true);
  assert.equal(ccrVerifier.isSupportedCcrVersion("3.9.99"), true);
  assert.equal(ccrVerifier.isSupportedCcrVersion("3.0.3"), false);
  assert.equal(ccrVerifier.isSupportedCcrVersion("4.0.0"), false);
  const sentinel = Buffer.from("sentinel");
  const existingCodexProfile = {
    agent: "codex",
    configFile: "/isolated/original/.codex/config.toml",
    enabled: true,
    id: "default-codex",
    scope: "global",
  };
  const dangerousProfile = {
    ...existingCodexProfile,
    configFile: "/isolated/.codex/config.toml",
    scope: "global",
  };
  const postProbeConfig = {
    HOST: "127.0.0.1",
    profile: {
      profiles: [
        existingCodexProfile,
        { agent: "claude-code", enabled: true, id: "default-claude", scope: "global" },
      ],
    },
  };
  const expectedSafeConfig = {
    ...postProbeConfig,
    profile: {
      profiles: [
        { ...existingCodexProfile, scope: "ccr", showAllSessions: true },
        postProbeConfig.profile.profiles[1],
      ],
    },
  };
  const events = [];
  let persisted = { profile: { profiles: [existingCodexProfile] } };
  const makeRpc = (generation) => async (method, args = []) => {
    events.push(`${generation}:${method}`);
    if (method === "saveConfig") persisted = structuredClone(args[0]);
    return structuredClone(persisted);
  };
  const initialRpc = makeRpc("initial");
  const restartedRpc = makeRpc("fresh");

  const result = await ccrVerifier.verifyDangerousCodexPersistence({
    ccr: "ccr",
    dangerousProfile,
    env: {},
    initialConfig: persisted,
    read: async () => Buffer.from(sentinel),
    rpc: initialRpc,
    rpcFactory: async () => {
      events.push("fresh-client");
      return restartedRpc;
    },
    runCommand: (_command, args) => {
      events.push(`run:${args.join(" ")}`);
      return { status: 0, stderr: "" };
    },
    postProbeConfig,
    sentinelBytes: sentinel,
    sentinelPath: "/isolated/.codex/config.toml",
  });

  assert.deepEqual(events, [
    "initial:saveConfig",
    "run:stop",
    "run:start --no-gateway",
    "fresh-client",
    "fresh:getConfig",
    "fresh:saveConfig",
  ]);
  assert.equal(result.rpc, restartedRpc);
  assert.deepEqual(persisted, expectedSafeConfig);

  const source = await readFile(resolve(import.meta.dirname, "..", "scripts", "verify-ccr3-e2e.mjs"), "utf8");
  const lifecycle = [
    "await rpc(\"saveConfig\"",
    "runCommand(ccr, [\"stop\"]",
    "runCommand(ccr, [\"start\", \"--no-gateway\"]",
    "await rpcFactory(env)",
    "await freshRpc(\"getConfig\")",
    "await freshRpc(\"saveConfig\"",
  ].map((step) => source.indexOf(step));
  assert.equal(lifecycle.every((position) => position >= 0), true);
  assert.deepEqual([...lifecycle].sort((left, right) => left - right), lifecycle);
});

test("OSS package allowlist excludes tests and migration artifacts", async () => {
  const expectedFiles = [
    "CLAUDE.md",
    "README.md",
    "docs/install.md",
    "docs/profile-schema.md",
    "docs/runtime-lessons.md",
    "profiles",
    "scripts/capture-claude-tool-contract.mjs",
    "scripts/verify-ccr3-e2e.mjs",
    "src",
  ];
  const packageJson = JSON.parse(
    await readFile(resolve(import.meta.dirname, "..", "package.json"), "utf8"),
  );
  const outDir = await mkdtemp(join(tmpdir(), "airkit-export-"));

  try {
    await exportOssRelease({ outDir });
    const exportedPackage = JSON.parse(await readFile(join(outDir, "package.json"), "utf8"));

    assert.deepEqual(packageJson.files, expectedFiles);
    assert.deepEqual(exportedPackage.files, expectedFiles);
    for (const document of ["README.md", "CLAUDE.md"]) {
      assert.equal(
        await readFile(join(outDir, document), "utf8"),
        await readFile(resolve(import.meta.dirname, "..", document), "utf8"),
      );
    }
    const compatibilityDocuments = [
      "README.md",
      "CLAUDE.md",
      "docs/install.md",
      "docs/superpowers/specs/2026-07-14-claude-gateway-compatibility.md",
    ];
    const compatibilityTable = [
      "| Family | Profile mode | Effective behavior |",
      "| --- | --- | --- |",
      "| WebSearch (`webSearch`) | `native-first` | Native. The complete call/result wire cycle was verified with real Claude Code 2.1.211. |",
      "| WebFetch (`webFetch`) | `native-first` | Anthropic fallback for now. Claude exposes the native client tool, but the zero-public-network loopback execution is blocked by Claude's domain-safety check, so AirKit does not claim the native cycle is verified. |",
      "| Code Execution (`codeExecution`) | `anthropic-fallback` | The complete request uses the configured Anthropic route so container and continuation state stay intact. |",
      "| Advisor (`advisor`) | `anthropic-fallback` | The complete request uses the configured Anthropic route; the removed approximation bridge is not used. |",
      "| ToolSearch (`toolSearch`) | `bridge` | Safe bounded regex/BM25 requests use the local bridge. Unsafe, oversized, unsupported, or unknown requests fall back as a complete request. |",
      "| MCP Connector (`mcpConnector`) | `anthropic-fallback` | Typed server-side connector requests use the configured Anthropic route; client-side MCP remains native. |",
    ].join("\n");
    for (const document of compatibilityDocuments) {
      const text = await readFile(resolve(import.meta.dirname, "..", document), "utf8");
      assert.equal(
        text.includes(compatibilityTable),
        true,
        `${document} must contain the shared six-family compatibility table`,
      );
      for (const shellBlock of text.matchAll(/```bash\n([\s\S]*?)```/g)) {
        assert.doesNotMatch(
          shellBlock[1],
          /--profile <profile>/,
          `${document} shell commands must use the copyable PROFILE variable`,
        );
      }
      assert.match(text, /PROFILE=your-profile/);
      assert.match(text, /--profile "\$PROFILE"/);
      assert.doesNotMatch(text, /"advisor"\s*:\s*\{[^}]*"mode"\s*:\s*"bridge"/s);
      assert.doesNotMatch(text, /"advisor"\s*:\s*\{[^}]*"(?:model|fallbackModel)"\s*:/s);
      assert.doesNotMatch(text, /"webSearch"\s*:\s*\{[^}]*"mode"\s*:\s*"mcp"/s);
      assert.doesNotMatch(
        text,
        /Advisor, ToolSearch, and WebSearch are all compatibility capabilities/,
      );
    }
    const authorityDocuments = [
      "docs/profile-schema.md",
      "docs/superpowers/specs/2026-07-15-complete-server-tool-compatibility-design.md",
    ];
    for (const document of authorityDocuments) {
      const text = await readFile(resolve(import.meta.dirname, "..", document), "utf8");
      assert.match(
        text,
        /WebSearch[\s\S]{0,120}native[\s\S]{0,120}verified/i,
        `${document} must identify WebSearch native execution as verified`,
      );
      assert.match(
        text,
        /WebFetch[\s\S]{0,180}Anthropic fallback[\s\S]{0,180}native execution[\s\S]{0,80}not\s+verified/i,
        `${document} must resolve WebFetch to Anthropic fallback without claiming native execution`,
      );
    }
    const authoritativeExamples = [
      ...authorityDocuments,
      "docs/superpowers/plans/2026-07-15-complete-server-tool-compatibility.md",
    ];
    for (const document of authoritativeExamples) {
      const text = await readFile(resolve(import.meta.dirname, "..", document), "utf8");
      assert.doesNotMatch(
        text,
        /\bmodel["']?\s*:\s*["']anthropic\/claude-[^"']+["']/i,
        `${document} must not present a slash-bearing model as a proven CCR route`,
      );
    }
    const implementationPlan = await readFile(
      resolve(
        import.meta.dirname,
        "..",
        "docs/superpowers/plans/2026-07-15-complete-server-tool-compatibility.md",
      ),
      "utf8",
    );
    assert.match(implementationPlan, /private-runtime-overlay/);
    assert.match(implementationPlan, /--profile private-profile/);
    assert.doesNotMatch(implementationPlan, /"visibility"\s*:\s*"internal"/i);
    assert.equal(
      await readFile(join(outDir, "scripts", "verify-ccr3-e2e.mjs"), "utf8"),
      await readFile(resolve(import.meta.dirname, "..", "scripts", "verify-ccr3-e2e.mjs"), "utf8"),
    );
    assert.equal(
      await readFile(join(outDir, "src", "codex-takeover-guard.mjs"), "utf8"),
      await readFile(resolve(import.meta.dirname, "..", "src", "codex-takeover-guard.mjs"), "utf8"),
    );
    for (const module of [
      "config.mjs",
      "fallback.mjs",
      "gateway.mjs",
      "plugin.mjs",
      "protocol.mjs",
      "server-history.mjs",
      "server-tools.mjs",
      "tool-search.mjs",
    ]) {
      assert.equal(
        await readFile(join(outDir, "src", "compat", module), "utf8"),
        await readFile(resolve(import.meta.dirname, "..", "src", "compat", module), "utf8"),
      );
    }
    assert.ok(await import(join(outDir, "src", "airkit.mjs")));
  } finally {
    await rm(outDir, { force: true, recursive: true });
  }
});

test("CCR 3 merge creates CCR-only mode profiles and preserves unrelated configuration", () => {
  const current = {
    Providers: [{ id: "provider-unrelated", name: "unrelated", models: ["keep-me"] }],
    Router: {
      builtInRules: { "claude-code": { enabled: true }, codex: { enabled: true } },
      fallback: { mode: "off", models: [], retryCount: 1 },
      rules: [{ id: "unrelated-rule", name: "Keep me", enabled: true, target: "unrelated/keep-me" }],
    },
    profile: {
      enabled: true,
      profiles: [
        {
          agent: "claude-code",
          enabled: true,
          id: "unrelated-profile",
          model: "unrelated/keep-me",
          name: "Unrelated",
          scope: "ccr",
          surface: "cli",
        },
      ],
    },
  };

  const merged = airkitRuntime.buildCcr3ManagedConfig(
    launchCatalog(),
    "launch-example",
    current,
    {
      apiKeys: { demo: "resolved-at-runtime" },
      configDir: "/tmp/airkit-config",
      env: { HOME: "/tmp/airkit-isolated-home" },
    },
  );

  assert.equal(merged.config.Providers[0].name, "unrelated");
  const managedProvider = merged.config.Providers.find(
    (provider) => provider.id === "airkit-provider-launch-example-demo",
  );
  assert.equal(managedProvider.name, managedProvider.id);
  assert.equal(managedProvider.api_key, "resolved-at-runtime");
  assert.deepEqual(
    merged.config.profile.profiles
      .filter((candidate) => candidate.id.startsWith("airkit-launch-example-"))
      .map(({ id, model, scope, surface }) => ({ id, model, scope, surface })),
    [
      {
        id: "airkit-launch-example-auto",
        model: "airkit-provider-launch-example-demo/steady-coder",
        scope: "ccr",
        surface: "cli",
      },
      {
        id: "airkit-launch-example-fast",
        model: "airkit-provider-launch-example-demo/cheap-coder",
        scope: "ccr",
        surface: "cli",
      },
      {
        id: "airkit-launch-example-pro",
        model: "airkit-provider-launch-example-demo/strong-coder",
        scope: "ccr",
        surface: "cli",
      },
    ],
  );
  for (const managedProfile of merged.config.profile.profiles.filter((candidate) =>
    candidate.id.startsWith("airkit-launch-example-"))) {
    assert.match(managedProfile.settingsFile, /^\/tmp\/airkit-config\/ccr-profiles\//);
    assert.notEqual(managedProfile.settingsFile, "~/.claude/settings.json");
    assert.match(managedProfile.env.CLAUDE_STATUSLINE_CACHE_DIR, /^\/tmp\/airkit-isolated-home\//);
  }
  assert.ok(merged.config.profile.profiles.some((candidate) => candidate.id === "unrelated-profile"));
  assert.ok(merged.config.Router.rules.some((rule) => rule.id === "unrelated-rule"));
});

test("CCR 3 managed providers can route upstream through a per-launch proxy", () => {
  const merged = airkitRuntime.buildCcr3ManagedConfig(
    compatibilityCatalog(),
    "launch-example",
    {},
    {
      apiKeys: { demo: "resolved-at-runtime" },
      env: { AIRCLAUDE_PROVIDER_BASE_URL: "http://127.0.0.1:8804/v1/chat/completions" },
    },
  );

  assert.equal(
    merged.config.Providers[0].api_base_url,
    "http://127.0.0.1:8804/v1/chat/completions",
  );
  assert.equal(
    merged.config.Providers[1].api_base_url,
    "https://example.invalid/v1/messages",
  );
});

test("CCR compatibility requires a managed Anthropic Messages provider and local model", () => {
  const cases = [
    ["missing provider", (catalog) => {
      catalog.profiles[0].ccr.plugins[0].config.fallback.provider = "missing";
    }, /references unmanaged provider: missing/],
    ["wrong provider type", (catalog) => {
      catalog.profiles[0].ccr.Providers[1].type = "openai_chat_completions";
    }, /must use anthropic_messages/],
    ["missing provider model", (catalog) => {
      catalog.profiles[0].ccr.Providers[1].models = ["claude-opus"];
    }, /model is missing from provider anthropic-messages: claude-sonnet/],
  ];

  for (const [name, mutate, expected] of cases) {
    const catalog = compatibilityCatalog();
    mutate(catalog);
    assert.throws(
      () => airkitRuntime.buildCcr3ManagedConfig(catalog, "launch-example"),
      expected,
      name,
    );
  }
});

test("CCR compatibility opt-in resolves the installed plugin and preserves unrelated plugins", () => {
  const catalog = compatibilityCatalog();
  const unrelated = { id: "user-plugin", module: "/user/plugin.mjs", config: { keep: true } };
  const merged = airkitRuntime.buildCcr3ManagedConfig(catalog, "launch-example", {
    Providers: [],
    plugins: [unrelated],
    profile: { profiles: [] },
  }, { configDir: "/tmp/airkit-compatibility" });

  assert.deepEqual(merged.config.plugins[0], unrelated);
  assert.equal(merged.config.plugins[1].id, "airkit-compatibility");
  assert.equal(merged.config.plugins[1].enabled, true);
  assert.equal(merged.config.plugins[1].module, resolve(import.meta.dirname, "..", "src", "compat", "plugin.mjs"));
  assert.equal(
    merged.config.plugins[1].config.fallback.provider,
    "airkit-provider-launch-example-anthropic-messages",
  );
  assert.ok(merged.config.Providers.some((provider) =>
    provider.id === "airkit-provider-launch-example-anthropic-messages" &&
    provider.type === "anthropic_messages" &&
    provider.models.includes("claude-sonnet")));
  assert.doesNotMatch(merged.config.plugins[1].module, /airkit-compatibility\/plugins/);

  const repeated = airkitRuntime.buildCcr3ManagedConfig(
    catalog,
    "launch-example",
    merged.config,
    { configDir: "/tmp/airkit-compatibility" },
  );
  assert.deepEqual(repeated.config, merged.config);
});

test("CCR compatibility rejects removed Advisor bridge before CCR RPC or credentials", async () => {
  const catalog = compatibilityCatalog();
  catalog.profiles[0].ccr.plugins[0].config.advisor = {
    fallbackModel: "anthropic/claude-opus",
    mode: "bridge",
    model: "anthropic/claude-opus",
  };
  catalog.profiles[0].shell = { ccrTokenOpRef: "op://Test/API/token" };
  let ccrClientCreations = 0;
  let credentialCalls = 0;

  await assert.rejects(
    () => prepareLaunch(catalog, "launch-example", {
      configDir: "/tmp/airkit-compatibility",
      createCcrClient: () => {
        ccrClientCreations += 1;
        return {};
      },
      runCommand: async () => {
        credentialCalls += 1;
        return { ok: true, status: 0, stdout: "unused" };
      },
    }),
    /advisor\.mode.*removed/i,
  );
  assert.equal(ccrClientCreations, 0);
  assert.equal(credentialCalls, 0);
});

test("CCR 3 merge rejects the removed CCR 2 transformer contract", () => {
  const catalog = launchCatalog();
  catalog.profiles[0].ccr.transformers = [{ path: "/tmp/legacy.cjs" }];
  catalog.profiles[0].ccr.Providers[0].transformer = { use: ["legacy"] };

  assert.throws(
    () => airkitRuntime.buildCcr3ManagedConfig(catalog, "launch-example", {}),
    /legacy CCR transformers are unsupported by CCR 3/,
  );
});

test("CCR 3 profiles require an explicit launch contract", () => {
  const catalog = launchCatalog();
  delete catalog.profiles[0].launch;

  assert.throws(
    () => airkitRuntime.buildCcr3ManagedConfig(catalog, "launch-example", {}),
    /must define launch or a shell wrapper for CCR 3/,
  );
});

test("CCR 3 launch rejects args that clear the managed apiKeyHelper", () => {
  const catalog = launchCatalog();
  catalog.profiles[0].launch.args.unshift("--settings", "{\"apiKeyHelper\":\"\"}");

  assert.throws(
    () => buildLaunchPlan(catalog, "launch-example", { mode: "auto" }),
    /must not override CCR managed apiKeyHelper/,
  );
});

test("CCR 3 launch inherits only the user's statusLine into the isolated Claude profile", async () => {
  const home = await mkdtemp(join(tmpdir(), "airkit-statusline-home-"));
  const configDir = await mkdtemp(join(tmpdir(), "airkit-statusline-config-"));
  const calls = [];
  await mkdir(join(home, ".claude"), { recursive: true });
  await writeFile(join(home, ".claude", "settings.json"), JSON.stringify({
    model: "must-not-leak",
    permissions: { ask: ["Bash(glab api:*)"] },
    statusLine: { type: "command", command: "/tmp/statusline.sh" },
  }));

  try {
    await prepareLaunch(launchCatalog(), "launch-example", {
      ccrClient: {
        ensureGateway: async () => {},
        getConfig: async () => ({ Providers: [], Router: {}, profile: { profiles: [] } }),
        getVersion: async () => "3.0.4",
        saveConfig: async () => {},
      },
      commandExists: async () => true,
      configDir,
      env: { DEMO_API_KEY: "runtime-secret", HOME: home },
      inspectCodexTakeoverFiles: async () => ({ inspection: { hazards: [] } }),
      runtimeVersions: passingRuntimeVersions(),
      spawnCommand: (_command, args) => {
        calls.push(args);
        return { status: 0 };
      },
    });

    const settingsIndex = calls[0].indexOf("--settings");
    assert.notEqual(settingsIndex, -1);
    assert.deepEqual(JSON.parse(calls[0][settingsIndex + 1]), {
      statusLine: { type: "command", command: "/tmp/statusline.sh" },
    });
  } finally {
    await rm(home, { force: true, recursive: true });
    await rm(configDir, { force: true, recursive: true });
  }
});

test("legacy transformer rejection happens before launch writes or CCR RPC", async () => {
  const catalog = launchCatalog();
  const configDir = await mkdtemp(join(tmpdir(), "airkit-legacy-transformer-"));
  const calls = [];
  catalog.profiles[0].ccr.transformers = [{ path: "/tmp/legacy.cjs" }];
  try {
    await assert.rejects(
      () => prepareLaunch(catalog, "launch-example", {
        ccrClient: {
          getConfig: async () => calls.push("getConfig"),
          getVersion: async () => calls.push("getVersion"),
          saveConfig: async () => calls.push("saveConfig"),
        },
        configDir,
        launch: false,
        runtimeVersions: passingRuntimeVersions(),
      }),
      /legacy CCR transformers are unsupported by CCR 3/,
    );
    assert.deepEqual(calls, []);
    await assert.rejects(readFile(join(configDir, "ccr", "launch-example.json")), { code: "ENOENT" });
  } finally {
    await rm(configDir, { force: true, recursive: true });
  }
});

test("CCR 3 merge refuses to replace an unowned provider with the same name", () => {
  assert.throws(
    () => airkitRuntime.buildCcr3ManagedConfig(
      launchCatalog(),
      "launch-example",
      { Providers: [{ id: "user-provider", name: "demo", models: ["keep-me"] }] },
      { apiKeys: { demo: "runtime-secret" } },
    ),
    /unowned CCR provider name collision: demo/,
  );
});

test("CCR 3 merge adopts a matching provider imported from CCR 2", () => {
  const catalog = launchCatalog();
  const [expected] = airkitRuntime.buildCcrConfig(catalog, "launch-example").Providers;
  const merged = airkitRuntime.buildCcr3ManagedConfig(
    catalog,
    "launch-example",
    {
      Providers: [{
        ...expected,
        api_key: "legacy-secret",
        id: "provider-demo-imported",
        transformer: { use: ["legacy"] },
      }],
    },
    { apiKeys: { demo: "runtime-secret" } },
  );
  const provider = merged.config.Providers.find(
    (candidate) => candidate.id === "airkit-provider-launch-example-demo",
  );

  assert.equal(provider.id, "airkit-provider-launch-example-demo");
  assert.equal(provider.name, provider.id);
  assert.equal(provider.api_key, "runtime-secret");
  assert.equal(provider.transformer, undefined);
});

test("CCR 3 merge rejects near-match providers instead of adopting them", () => {
  const catalog = launchCatalog();
  const [expected] = airkitRuntime.buildCcrConfig(catalog, "launch-example").Providers;
  const nearMatches = [
    { ...expected, id: "user-provider" },
    { ...expected, api_base_url: "https://other.example.test/v1", id: "provider-demo-imported" },
    { ...expected, id: "provider-demo-imported", models: [...expected.models, "unexpected-model"] },
  ];

  for (const provider of nearMatches) {
    assert.throws(
      () => airkitRuntime.buildCcr3ManagedConfig(
        catalog,
        "launch-example",
        { Providers: [provider] },
        { apiKeys: { demo: "runtime-secret" } },
      ),
      /unowned CCR provider name collision: demo/,
    );
  }
});

test("CCR 3 launch path uses the managed profile and never invokes CCR 2 commands", async () => {
  const configDir = await mkdtemp(join(tmpdir(), "airkit-ccr3-launch-"));
  const calls = [];
  const ccrClient = {
    getConfig: async () => ({
      Providers: [],
      Router: {
        builtInRules: { "claude-code": { enabled: true }, codex: { enabled: true } },
        fallback: { mode: "off", models: [], retryCount: 1 },
        rules: [],
      },
      profile: { enabled: true, profiles: [] },
    }),
    getVersion: async () => "3.0.4",
    saveConfig: async (config) => calls.push({ command: "saveConfig", config }),
  };

  try {
    const result = await prepareLaunch(launchCatalog(), "launch-example", {
      ccrClient,
      commandExists: async (command) => ["ccr", "claude"].includes(command),
      configDir,
      env: { DEMO_API_KEY: "runtime-secret", HOME: configDir },
      launch: false,
      liveCcrConfig: join(configDir, "live", "config.json"),
      mode: "pro",
      runCommand: async (command, args) => {
        calls.push({ command, args });
        return {
          ok: true,
          status: 0,
          stdout: args[0] === "activate" ? 'export ANTHROPIC_BASE_URL="http://127.0.0.1:3456"\n' : "",
        };
      },
      runtimeVersions: { claudeCode: "2.1.208", claudeCodeRouter: "3.0.4", node: "24.11.1" },
    });

    assert.equal(result.launch.command, "ccr");
    assert.deepEqual(result.launch.args.slice(0, 3), ["airkit-launch-example-pro", "cli", "--"]);
    assert.ok(calls.some((call) => call.command === "saveConfig"));
    assert.ok(!calls.some((call) => ["restart", "activate"].includes(call.args?.[0])));
  } finally {
    await rm(configDir, { force: true, recursive: true });
  }
});

test("runtime check reports installed versions against the hard-cut requirements", async () => {
  const output = [];
  const exitCode = await runCli(["runtime", "check"], {
    runtimeVersions: { claudeCode: "2.1.208", claudeCodeRouter: "3.0.4", node: "24.11.1" },
    stdout: { write: (chunk) => output.push(chunk) },
  });

  assert.equal(exitCode, 0);
  assert.match(output.join(""), /Node\.js\s+24\.11\.1\s+required >=22\s+ok/);
  assert.match(output.join(""), /Claude Code\s+2\.1\.208\s+required >=2\.1\.208\s+ok/);
  assert.match(output.join(""), /Claude Code Router\s+3\.0\.4\s+required >=3\.0\.4 <4\s+ok/);
});

test("runtime update previews explicit installs without changing global packages", async () => {
  const calls = [];
  const output = [];
  const exitCode = await runCli(["runtime", "update"], {
    runCommand: async (command, args) => {
      calls.push({ command, args });
      return { ok: true, status: 0, stdout: "" };
    },
    stdout: { write: (chunk) => output.push(chunk) },
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(calls, []);
  assert.match(output.join(""), /Preview only/);
  assert.match(output.join(""), /@anthropic-ai\/claude-code@2\.1\.208/);
  assert.match(output.join(""), /@musistudio\/claude-code-router@3\.0\.4/);
  assert.match(output.join(""), /npm install --global/);
  assert.match(output.join(""), /\.claude-code-router/);
  assert.match(output.join(""), /Re-run with --write/);
});

test("runtime update --write requires the isolated CCR 3 profile probe", async () => {
  const root = await mkdtemp(join(tmpdir(), "airkit-runtime-update-"));
  const calls = [];
  try {
    const exitCode = await runCli(["runtime", "update", "--write"], {
      backupDir: join(root, "backup"),
      env: { HOME: join(root, "real-home") },
      runCommand: async (command, args) => {
        calls.push({ command, args });
        return { ok: true, status: 0, stdout: "" };
      },
      runtimeProbe: async () => {
        calls.push({ command: "runtimeProbe", args: [] });
        return { profileResolved: true, version: "3.0.4" };
      },
      runtimeVersions: passingRuntimeVersions(),
      stdout: { write: () => {} },
    });

    assert.equal(exitCode, 0);
    assert.deepEqual(calls[0], {
      command: "npm",
      args: [
        "install",
        "--global",
        "@anthropic-ai/claude-code@2.1.208",
        "@musistudio/claude-code-router@3.0.4",
      ],
    });
    assert.deepEqual(calls[1], { command: "runtimeProbe", args: [] });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("airclaude launch injects reusable runtime lessons", async () => {
  const catalog = await loadCatalog();
  const plan = buildLaunchPlan(catalog, profile, { configDir: "/tmp/airkit-test" });
  const prompt = appendSystemPromptText(plan.launch.args);

  assert.match(prompt, /durable lessons/i);
  assert.match(prompt, /Symptom\/Cause\/Rule\/Action\/Verify/);
  assert.match(prompt, /Do not record secrets/);
  assert.match(prompt, /Athena/);
  assert.match(prompt, /database, catalog, region, workgroup, or result output location/);
  assert.match(prompt, /get-query-execution/);
  assert.match(prompt, /StateChangeReason/);
  assert.match(prompt, /shell wrapper/);
  assert.match(prompt, /command -v/);
  assert.match(prompt, /AirClaude active routing/);
  assert.match(prompt, /mode: auto/);
  assert.match(prompt, /default: openai-compatible,steady-coder \(model steady-coder\)/);
  assert.match(prompt, /background: openai-compatible,fast-coder \(model fast-coder\)/);
  assert.doesNotMatch(prompt, /- think:|- longContext:|- webSearch:/);
  assert.match(prompt, /Claude launch\/display model is compatibility metadata only/);
});

test("generated shell wrappers delegate to the managed CCR 3 launch path", async () => {
  const catalog = await loadCatalog();
  const snippet = buildShellSnippet(catalog, profile, { configDir: "/tmp/airkit-test" });

  assert.match(snippet, /airclaude-example\(\)/);
  assert.match(snippet, /command airclaude --profile 'openai-compatible-example' --/);
  assert.match(snippet, /local -x CCR_PROFILE=/);
  assert.doesNotMatch(snippet, /\n  export CCR_PROFILE=/);
  assert.doesNotMatch(snippet, /\n  cclaude /);
});

test("shell wrapper args can use config dir templates", async () => {
  const configDir = await mkdtemp(join(tmpdir(), "airkit-oss-wrapper-args-"));
  const catalog = {
    schema: 1,
    profiles: [
      {
        name: "wrapper-args",
        visibility: "public",
        summary: "Profile with wrapper args.",
        shell: {
          wrappers: [
            {
              name: "claude-wrapper",
              command: "claude",
              args: ["--strict-mcp-config", "--mcp-config", "{{configDir}}/claude/empty-mcp.json"],
            },
          ],
        },
      },
    ],
  };

  try {
    const snippet = buildShellSnippet(catalog, "wrapper-args", { configDir });

    assert.match(
      snippet,
      new RegExp(`claude '--strict-mcp-config' '--mcp-config' '${escapeRegExp(configDir)}/claude/empty-mcp\\.json'`),
    );
    assert.match(snippet, /--append-system-prompt/);
    assert.match(snippet, /AirKit reusable runtime lessons/);
  } finally {
    await rm(configDir, { force: true, recursive: true });
  }
});

test("updateProfile dry run renders previews and does not mutate stale installed files", async () => {
  const catalog = await loadCatalog();
  const configDir = await mkdtemp(join(tmpdir(), "airkit-oss-update-"));
  const previewDir = await mkdtemp(join(tmpdir(), "airkit-oss-preview-"));

  try {
    const staleCcr = "{ \"stale\": true }\n";
    const staleShell = "# stale shell\n";
    await mkdir(join(configDir, "ccr"), { recursive: true });
    await mkdir(join(configDir, "shell"), { recursive: true });
    await writeFile(join(configDir, "ccr", `${profile}.json`), staleCcr);
    await writeFile(join(configDir, "shell", `${profile}.zsh`), staleShell);

    const result = await updateProfile(catalog, profile, { configDir, previewDir, write: false });

    assert.equal(result.write, false);
    assert.equal(result.files.ccrConfig.status, "stale");
    assert.equal(result.files.shellSnippet.status, "stale");
    assert.match(await readFile(result.files.ccrConfig.preview, "utf8"), /steady-coder/);
    assert.match(await readFile(result.files.shellSnippet.preview, "utf8"), /airclaude-example/);
    assert.equal(await readFile(result.files.ccrConfig.target, "utf8"), staleCcr);
    assert.equal(await readFile(result.files.shellSnippet.target, "utf8"), staleShell);
  } finally {
    await rm(previewDir, { force: true, recursive: true });
    await rm(configDir, { force: true, recursive: true });
  }
});

test("doctorProfile reports rendered file drift and runtime availability", async () => {
  const catalog = await loadCatalog();
  const configDir = await mkdtemp(join(tmpdir(), "airkit-oss-doctor-"));

  try {
    await installProfile(catalog, profile, { configDir, write: true });
    await writeFile(join(configDir, "ccr", `${profile}.json`), "{ \"stale\": true }\n");

    const result = await doctorProfile(catalog, profile, {
      commandExists: async (command) => command !== "ccr",
      configDir,
      sourceShellSnippet: async () => ({ ok: true }),
    });

    assert.equal(result.ok, false);
    assert.equal(result.files.ccrConfig.ok, false);
    assert.equal(result.files.shellSnippet.ok, true);
    assert.equal(result.runtime.ccr.ok, false);
    assert.equal(result.runtime.context.contextWindow.source, "unavailable");
    assert.equal(result.runtime.context.usage.cacheDetails, "unavailable");
    assert.match(result.failures.join("\n"), /stale CCR config/);
    assert.match(result.failures.join("\n"), /missing command: ccr/);
  } finally {
    await rm(configDir, { force: true, recursive: true });
  }
});

test("native-first compatibility renders no duplicate MCP and reports six policies", async () => {
  const catalog = compatibilityCatalog();
  const configDir = await mkdtemp(join(tmpdir(), "airkit-compatibility-doctor-"));

  try {
    const plan = buildLaunchPlan(catalog, "launch-example", { configDir });
    assert.equal(plan.compatibilityMcp, undefined);
    assert.deepEqual(plan.compatibility.policies, {
      webSearch: "native",
      webFetch: "anthropic-fallback",
      codeExecution: "anthropic-fallback",
      advisor: "anthropic-fallback",
      toolSearch: "bridge",
      mcpConnector: "anthropic-fallback",
    });
    await installProfile(catalog, "launch-example", { configDir, write: true });
    const result = await doctorProfile(catalog, "launch-example", {
      commandExists: async () => true,
      configDir,
      sourceShellSnippet: async () => ({ ok: true }),
    });

    assert.deepEqual(result.runtime.compatibility.capabilities, {
      advisor: "anthropic-fallback",
      codeExecution: "anthropic-fallback",
      mcpConnector: "anthropic-fallback",
      toolSearch: "bridged",
      webFetch: "anthropic-fallback",
      webSearch: "native",
    });
    assert.equal(result.runtime.compatibility.ok, true);
    assert.deepEqual(result.runtime.context.contextWindow, {
      tokens: 256_000,
      source: "catalog:modelCatalog",
      metadataOnly: true,
    });
    assert.equal(result.runtime.context.usage.cacheDetails, "unavailable");
  } finally {
    await rm(configDir, { force: true, recursive: true });
  }
});

test("doctor command exits zero when rendered files match", async () => {
  const catalog = await loadCatalog();
  const fakeBin = await mkdtemp(join(tmpdir(), "airkit-oss-bin-"));
  const configDir = await mkdtemp(join(tmpdir(), "airkit-oss-cli-doctor-"));

  try {
    const fakeCcr = join(fakeBin, "ccr");
    await writeFile(fakeCcr, "#!/bin/sh\nexit 0\n");
    await chmod(fakeCcr, 0o755);
    await installProfile(catalog, profile, { configDir, write: true });

    const result = runAirkitWithEnv(
      { PATH: `${fakeBin}:${process.env.PATH ?? ""}` },
      "doctor",
      "--profile",
      profile,
      "--config-dir",
      configDir,
    );

    assert.equal(result.status, 0);
    assert.match(result.stdout, /ok CCR config/);
    assert.match(result.stdout, /ok shell snippet/);
    assert.match(result.stdout, /ok CCR availability/);
    assert.match(result.stdout, /ok shell source/);
    assert.match(result.stdout, /info context window: unavailable/);
    assert.match(result.stdout, /info completion usage: unavailable; cache details unavailable/);
    assert.equal(result.stderr, "");
  } finally {
    await rm(fakeBin, { force: true, recursive: true });
    await rm(configDir, { force: true, recursive: true });
  }
});

test("runCli can render a caller-provided catalog", async () => {
  const catalogPath = resolve(import.meta.dirname, "..", "profiles", "catalog.json");
  const output = [];

  const exitCode = await runCli(["list"], {
    catalogPath,
    stdout: { write: (chunk) => output.push(chunk) },
  });

  assert.equal(exitCode, 0);
  assert.match(output.join(""), /openai-compatible-example/);
});

test("runCli prints help without loading the catalog", async () => {
  for (const arg of ["-h", "--help"]) {
    const output = [];
    const exitCode = await runCli([arg], {
      catalogPath: "/does/not/exist/catalog.json",
      stdout: { write: (chunk) => output.push(chunk) },
    });

    assert.equal(exitCode, 0);
    const help = output.join("");
    assert.match(help, /Usage: airkit/);
    assert.match(help, /airclaude \[mode\]/);
    assert.doesNotMatch(help, /airclaude \[auto\|pro\]/);
    assert.match(help, /init --profile/);
  }
});

test("buildLaunchPlan applies pro mode CCR routing overlay without mutating the catalog", async () => {
  const catalog = launchCatalog();
  const configDir = await mkdtemp(join(tmpdir(), "airkit-launch-plan-"));

  try {
    const plan = buildLaunchPlan(catalog, "launch-example", { configDir, mode: "pro" });

    assert.equal(plan.mode, "pro");
    assert.equal(plan.ccrConfig.Router.default, "demo,strong-coder");
    assert.equal(plan.ccrConfig.Router.think, undefined);
    assert.equal(plan.ccrConfig.Router.background, "demo,cheap-coder");
    assert.equal(catalog.profiles[0].ccr.Router.default, "demo,steady-coder");
    assert.equal(plan.launch.command, "ccr");
    assert.deepEqual(plan.launch.args.slice(0, 4), [
      "airkit-launch-example-pro",
      "cli",
      "--",
      "--append-system-prompt",
    ]);
    assert.match(
      plan.launch.args[4],
      /AirClaude mode pro routes default to strong-coder while Claude launch uses claude-sonnet-4-6\./,
    );
    assert.match(plan.launch.args[4], /AirKit reusable runtime lessons/);
    assert.match(plan.launch.args[4], /AirClaude active routing/);
    assert.match(plan.launch.args[4], /mode: pro/);
    assert.match(plan.launch.args[4], /default: demo,strong-coder \(model strong-coder\)/);
    assert.match(plan.launch.args[4], /background: demo,cheap-coder \(model cheap-coder\)/);
    assert.doesNotMatch(plan.launch.args[4], /- think:|- longContext:|- webSearch:/);
    assert.match(plan.launch.args[4], /Do not infer the active provider route from Claude Code's displayed model name/);
    assert.match(plan.launch.args[4], /\[AIRKIT_TASK_CAPSULE\]/);
    for (const field of [
      "objective",
      "constraints",
      "decisions",
      "changed_files",
      "verification",
      "repository_state",
      "next_action",
    ]) {
      assert.match(plan.launch.args[4], new RegExp(`${field}:`));
    }
    assert.match(plan.launch.args[4], /Never include credentials or provider-private payloads in the capsule/);
    assert.equal(plan.launch.env.AIRCLAUDE_PROFILE, "launch-example");
    assert.equal(plan.launch.env.AIRCLAUDE_MODE, "pro");
    assert.equal(plan.launch.env.AIRCLAUDE_ROUTE_DEFAULT, "demo,strong-coder");
    assert.equal(plan.launch.env.AIRCLAUDE_ROUTE_DEFAULT_MODEL, "strong-coder");
    assert.equal(plan.launch.env.AIRCLAUDE_ROUTE_THINK, undefined);
    assert.equal(plan.launch.env.AIRCLAUDE_ROUTE_LONG_CONTEXT_MODEL, undefined);
    assert.equal(plan.launch.env.AIRCLAUDE_STATUSLINE_LABEL, "airclaude pro strong-coder");
    assert.equal(plan.launch.env.AIRCLAUDE_STATUSLINE_INPUT_PRICE_PER_MILLION, "2");
    assert.equal(plan.launch.env.AIRCLAUDE_RESTORE_MODEL, undefined);
    assert.match(plan.launch.env.CLAUDE_STATUSLINE_CACHE_DIR, /\/\.claude\/cache\/airclaude\/launch-example\/pro$/);
    assert.deepEqual(plan.launch.userArgs, []);
  } finally {
    await rm(configDir, { force: true, recursive: true });
  }
});

test("airclaude launch quiets the Powerlevel10k instant prompt in its command subshells", async () => {
  const catalog = launchCatalog();
  const configDir = await mkdtemp(join(tmpdir(), "airkit-launch-p10k-"));

  try {
    const plan = buildLaunchPlan(catalog, "launch-example", { configDir });
    // P10k's instant-prompt eval leaks git/dir prompt segments into Claude Code's non-interactive
    // command shells, spamming "(eval): command not found: git/head/awk/...". Disabling instant
    // prompt for the launched process silences it without touching the user's P10k/.zshrc setup.
    assert.equal(plan.launch.env.POWERLEVEL9K_INSTANT_PROMPT, "off");
  } finally {
    await rm(configDir, { force: true, recursive: true });
  }
});

test("airclaude launch scopes proactive compaction policy to the managed child", async () => {
  const catalog = launchCatalog();
  const configDir = await mkdtemp(join(tmpdir(), "airkit-launch-compaction-"));
  catalog.profiles[0].launch.context = {
    autoCompactWindow: 300000,
    autoCompactPercentage: "default",
  };
  catalog.profiles[0].launch.env = {
    CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "99",
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: "1",
  };

  try {
    const env = {
      CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "40",
      HOME: configDir,
    };
    const plan = buildLaunchPlan(catalog, "launch-example", { configDir, env });
    const managed = airkitRuntime.buildCcr3ManagedConfig(catalog, "launch-example", {}, { configDir, env });
    const managedProfile = managed.config.profile.profiles.find(
      (candidate) => candidate.id === "airkit-launch-example-auto",
    );

    assert.equal(plan.launch.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, "300000");
    assert.equal(plan.launch.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE, "");
    assert.equal(managedProfile.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, "300000");
    assert.equal(managedProfile.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE, "");
    assert.equal(env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE, "40");
  } finally {
    await rm(configDir, { force: true, recursive: true });
  }
});

test("AirClaude heartbeat is child-only, bounded, factual, and excludes hook/provider payloads", () => {
  const hookInput = {
    cwd: "/private/workspace",
    hook_event_name: "UserPromptSubmit",
    permission_mode: "auto",
    prompt: "private user prompt that must never be repeated",
    session_id: "private-session-id",
    transcript_path: "/private/transcript.jsonl",
  };
  const env = {
    AIRCLAUDE_MODE: "auto",
    AIRCLAUDE_PROFILE: "example-profile",
    AIRCLAUDE_ROUTE_BACKGROUND: "private-provider,fast-model",
    AIRCLAUDE_ROUTE_BACKGROUND_MODEL: "fast-model",
    AIRCLAUDE_ROUTE_DEFAULT: "private-provider,strong-model",
    AIRCLAUDE_ROUTE_DEFAULT_MODEL: "strong-model",
    AIRKIT_COMPATIBILITY_MCP_TOKEN: "private-token",
  };

  const response = buildHeartbeatResponse(hookInput, env);
  const context = response.hookSpecificOutput.additionalContext;

  assert.equal(response.hookSpecificOutput.hookEventName, "UserPromptSubmit");
  assert.ok(context.length <= 512);
  assert.match(context, /AirClaude session context is active/);
  assert.match(context, /routing mode is auto/);
  assert.match(context, /default model is strong-model/);
  assert.match(context, /background model is fast-model/);
  assert.match(context, /Durable task state consists of/);
  assert.doesNotMatch(JSON.stringify(response), /private user prompt|private-session-id|private\/transcript|private-provider|private-token/);
  assert.equal(buildHeartbeatResponse(hookInput, {}), null);
  assert.equal(buildHeartbeatResponse({ ...hookInput, hook_event_name: "SessionStart" }, env), null);
});

test("AirClaude renders an additive session plugin for the heartbeat", async () => {
  const catalog = launchCatalog();
  const configDir = await mkdtemp(join(tmpdir(), "airkit-heartbeat-plugin-"));

  try {
    const plan = buildLaunchPlan(catalog, "launch-example", {
      configDir,
      userArgs: ["--resume", "session-id"],
    });
    const pluginIndex = plan.launch.args.indexOf("--plugin-dir");
    assert.notEqual(pluginIndex, -1);
    assert.equal(plan.launch.args[pluginIndex + 1], join(configDir, "plugins", "airkit-context"));
    assert.deepEqual(plan.launch.userArgs, ["--resume", "session-id"]);

    const managed = plan.files.managedFiles;
    const manifest = managed.find((file) => file.path.endsWith("/.claude-plugin/plugin.json"));
    const hooks = managed.find((file) => file.path.endsWith("/hooks/hooks.json"));
    const script = managed.find((file) => file.path.endsWith("/scripts/user-prompt-submit.mjs"));
    assert.ok(manifest);
    assert.ok(hooks);
    assert.ok(script);
    await installProfile(catalog, "launch-example", { configDir, force: true, write: true });
    assert.deepEqual(Object.keys(JSON.parse(await readFile(hooks.path, "utf8")).hooks).sort(), [
      "PostCompact",
      "SessionStart",
      "UserPromptSubmit",
    ]);
    const hookInput = JSON.stringify({
      hook_event_name: "UserPromptSubmit",
      prompt: "ordinary prompt",
      session_id: "session-id",
    });
    const active = spawnSync(process.execPath, [script.path], {
      encoding: "utf8",
      env: {
        ...process.env,
        AIRCLAUDE_MODE: "auto",
        AIRCLAUDE_PROFILE: "launch-example",
        AIRCLAUDE_ROUTE_BACKGROUND_MODEL: "cheap-coder",
        AIRCLAUDE_ROUTE_DEFAULT_MODEL: "balanced-coder",
      },
      input: hookInput,
    });
    assert.equal(active.status, 0);
    assert.deepEqual(JSON.parse(active.stdout).hookSpecificOutput.hookEventName, "UserPromptSubmit");
    assert.equal(active.stderr, "");

    const inactive = spawnSync(process.execPath, [script.path], {
      encoding: "utf8",
      env: { ...process.env, AIRCLAUDE_PROFILE: "" },
      input: hookInput,
    });
    assert.equal(inactive.status, 0);
    assert.equal(inactive.stdout, "");
    assert.equal(inactive.stderr, "");

    const lifecycleEnv = {
      ...process.env,
      AIRCLAUDE_MODE: "auto",
      AIRCLAUDE_PROFILE: "launch-example",
      AIRCLAUDE_ROUTE_BACKGROUND_MODEL: "cheap-coder",
      AIRCLAUDE_ROUTE_DEFAULT_MODEL: "balanced-coder",
      CLAUDE_PLUGIN_DATA: join(configDir, "plugin-data"),
    };
    const compact = spawnSync(process.execPath, [script.path], {
      encoding: "utf8",
      env: lifecycleEnv,
      input: JSON.stringify({
        compact_summary: `[AIRKIT_TASK_CAPSULE]\nobjective: Resume the isolated task\nconstraints: Keep settings unchanged\ndecisions: Persist only bounded fields\nchanged_files: src/context-heartbeat.mjs\nverification: Manual compact simulated\nrepository_state: isolated fixture\nnext_action: Resume the session\n[/AIRKIT_TASK_CAPSULE]`,
        cwd: "/workspace/isolated",
        hook_event_name: "PostCompact",
        trigger: "manual",
      }),
    });
    assert.equal(compact.status, 0);
    assert.equal(compact.stdout, "");

    const resumed = spawnSync(process.execPath, [script.path], {
      encoding: "utf8",
      env: lifecycleEnv,
      input: JSON.stringify({
        cwd: "/workspace/isolated",
        hook_event_name: "SessionStart",
        source: "resume",
      }),
    });
    assert.equal(resumed.status, 0);
    assert.match(JSON.parse(resumed.stdout).hookSpecificOutput.additionalContext, /Objective: Resume the isolated task/);
    assert.equal(resumed.stderr, "");
  } finally {
    await rm(configDir, { force: true, recursive: true });
  }
});

test("task capsule requires every durable field, stays bounded, and redacts credential-shaped values", () => {
  const capsule = parseTaskCapsule(`
[AIRKIT_TASK_CAPSULE]
objective: Finish context lifecycle restoration
constraints: Do not change global settings; token=private-token-value; ANTHROPIC_AUTH_TOKEN=opaquecredentialvalue; AWS_SECRET_ACCESS_KEY=opaqueawssecret; endpoint=https://private.example/v1
decisions: Store state in plugin data
changed_files: src/context-heartbeat.mjs, test/airkit.test.mjs
verification: Focused tests pass
repository_state: branch codex/context-retention-phase3, clean before edits
next_action: Run the complete suite
[/AIRKIT_TASK_CAPSULE]
`);

  assert.deepEqual(Object.keys(capsule), [
    "objective",
    "constraints",
    "decisions",
    "changed_files",
    "verification",
    "repository_state",
    "next_action",
  ]);
  assert.match(capsule.constraints, /token=\[redacted\]/);
  assert.doesNotMatch(JSON.stringify(capsule), /private-token-value|opaquecredentialvalue|opaqueawssecret|private\.example/);
  assert.ok(JSON.stringify(capsule).length <= 2048);
  assert.equal(parseTaskCapsule("ordinary compact summary without a capsule"), null);
  assert.equal(parseTaskCapsule(`
[AIRKIT_TASK_CAPSULE]
objective: incomplete
[/AIRKIT_TASK_CAPSULE]
`), null);
  assert.equal(parseTaskCapsule(`${compactCapsuleFixture("old")}\nQuoted above.\n${compactCapsuleFixture("current")}`), null);
  assert.equal(parseTaskCapsule(`${compactCapsuleFixture("current")}\ntrailing text`), null);
  assert.equal(parseTaskCapsule(compactCapsuleFixture("current").replace(
    "objective: current",
    "objective: stale\nobjective: current",
  )), null);
  assert.equal(parseTaskCapsule(compactCapsuleFixture("current").replace(
    "[/AIRKIT_TASK_CAPSULE]",
    "unexpected_field: unexpected\n[/AIRKIT_TASK_CAPSULE]",
  )), null);
});

test("PostCompact persists a workspace-scoped capsule for every SessionStart lifecycle source", async () => {
  const pluginData = await mkdtemp(join(tmpdir(), "airkit-context-data-"));
  const env = {
    AIRCLAUDE_MODE: "auto",
    AIRCLAUDE_PROFILE: "example-profile",
    AIRCLAUDE_ROUTE_BACKGROUND_MODEL: "fast-model",
    AIRCLAUDE_ROUTE_DEFAULT_MODEL: "strong-model",
    CLAUDE_PLUGIN_DATA: pluginData,
  };
  const cwd = "/workspace/example";
  const compactSummary = `
[AIRKIT_TASK_CAPSULE]
objective: Restore task state after compaction
constraints: Keep user settings untouched
decisions: Use a bounded plugin-data capsule
changed_files: src/context-heartbeat.mjs
verification: Manual compact fixture captured
repository_state: phase3 has local changes
next_action: Verify resume and clear
[/AIRKIT_TASK_CAPSULE]
`;

  try {
    assert.equal(await processContextHook({
      compact_summary: compactSummary,
      cwd,
      hook_event_name: "PostCompact",
      trigger: "manual",
    }, env), null);

    for (const source of ["startup", "resume", "clear", "compact"]) {
      const response = await processContextHook({
        cwd,
        hook_event_name: "SessionStart",
        source,
      }, env);
      const context = response.hookSpecificOutput.additionalContext;
      assert.equal(response.hookSpecificOutput.hookEventName, "SessionStart");
      assert.match(context, new RegExp(`Session lifecycle source is ${source}`));
      assert.match(context, /Objective: Restore task state after compaction/);
      assert.match(context, /Next action: Verify resume and clear/);
      assert.ok(context.length <= 3072);
    }

    const unrelated = await processContextHook({
      cwd: "/workspace/unrelated",
      hook_event_name: "SessionStart",
      source: "resume",
    }, env);
    assert.match(unrelated.hookSpecificOutput.additionalContext, /AirClaude session context is active/);
    assert.doesNotMatch(unrelated.hookSpecificOutput.additionalContext, /Objective:/);

    assert.equal(await processContextHook({
      compact_summary: "latest compact summary is missing its capsule",
      cwd,
      hook_event_name: "PostCompact",
      trigger: "auto",
    }, env), null);
    const cleared = await processContextHook({
      cwd,
      hook_event_name: "SessionStart",
      source: "compact",
    }, env);
    assert.doesNotMatch(cleared.hookSpecificOutput.additionalContext, /Objective:/);
  } finally {
    await rm(pluginData, { force: true, recursive: true });
  }
});

function compactCapsuleFixture(objective) {
  return `[AIRKIT_TASK_CAPSULE]
objective: ${objective}
constraints: fixture constraints
decisions: fixture decisions
changed_files: fixture.js
verification: fixture verified
repository_state: fixture state
next_action: fixture action
[/AIRKIT_TASK_CAPSULE]`;
}

test("airclaude launch does not set the dead ANTHROPIC_1M_CONTEXT env (1M comes from the [1m] model suffix)", async () => {
  const catalog = launchCatalog();
  const configDir = await mkdtemp(join(tmpdir(), "airkit-launch-1m-"));

  try {
    const plan = buildLaunchPlan(catalog, "launch-example", { configDir });
    // 1M context is NOT enabled by any env var (ANTHROPIC_1M_CONTEXT is a no-op in Claude Code 2.1.178);
    // it is gated on the resolved model string ending in `[1m]`, so the lever is launch.claudeModel,
    // not the launch env. Guard against re-introducing the dead env var.
    assert.equal(plan.launch.env.ANTHROPIC_1M_CONTEXT, undefined);
  } finally {
    await rm(configDir, { force: true, recursive: true });
  }
});

test("prepareLaunch dry run reports stale files and does not write targets", async () => {
  const catalog = launchCatalog();
  const configDir = await mkdtemp(join(tmpdir(), "airkit-launch-dry-run-"));
  const staleCcr = "{ \"stale\": true }\n";

  try {
    await mkdir(join(configDir, "ccr"), { recursive: true });
    await writeFile(join(configDir, "ccr", "launch-example.json"), staleCcr);

    const result = await prepareLaunch(catalog, "launch-example", {
      configDir,
      dryRun: true,
      mode: "auto",
      commandExists: async () => true,
      runCommand: async () => ({ ok: true, status: 0 }),
      spawnCommand: () => ({ status: 0 }),
    });

    assert.equal(result.write, false);
    assert.equal(result.files.ccrConfig.status, "stale");
    assert.equal(await readFile(join(configDir, "ccr", "launch-example.json"), "utf8"), staleCcr);
    assert.equal(result.liveCcrConfig.status, "would-manage");
  } finally {
    await rm(configDir, { force: true, recursive: true });
  }
});

for (const evidence of ["managed marker", "takeover record"]) {
  test(`Codex takeover ${evidence} blocks after the first management read and before later actions`, async () => {
    const root = await mkdtemp(join(tmpdir(), "airkit-codex-takeover-preflight-"));
    const home = join(root, "home");
    const configDir = join(root, "airkit");
    const codexDir = join(home, ".codex");
    const ccrDir = join(home, ".claude-code-router");
    const calls = [];
    const options = {
      commandExists: async () => calls.push("commandExists"),
      configDir,
      env: { DEMO_API_KEY: "runtime-secret", HOME: home },
      get ccrClient() {
        calls.push("createCcr3Client");
        return {
          getConfig: async () => calls.push("getConfig"),
          getVersion: async () => calls.push("getVersion"),
          saveConfig: async () => calls.push("saveConfig"),
          ensureGateway: async () => calls.push("ensureGateway"),
        };
      },
      runCommand: async () => {
        calls.push("credential-resolution");
        return { ok: true, status: 0, stdout: "private credential" };
      },
      runtimeVersions: passingRuntimeVersions(),
      spawnCommand: () => calls.push("spawn"),
    };

    try {
      await mkdir(codexDir, { recursive: true });
      await mkdir(ccrDir, { recursive: true });
      await writeFile(join(codexDir, "config.toml"), evidence === "managed marker"
        ? "# BEGIN CCR managed profile\nprivate-value = \"do-not-leak\"\n# END CCR managed profile\n"
        : "theme = \"dark\"\n");
      if (evidence === "takeover record") {
        await writeFile(join(ccrDir, "global-profile-takeover.json"), JSON.stringify({
          version: 1,
          profiles: [{
            agent: "codex",
            configFile: join(codexDir, "config.toml"),
            providerId: "do-not-leak",
          }],
        }));
      }

      await assert.rejects(
        prepareLaunch(launchCatalog(), "launch-example", options),
        (error) => {
          assert.match(error.message, /airkit repair codex-takeover/);
          assert.match(error.message, /airkit repair codex-takeover --write/);
          assert.doesNotMatch(error.message, /do-not-leak|private-value|providerId/);
          return true;
        },
      );

      assert.deepEqual(calls, ["createCcr3Client", "getConfig"]);
      await assert.rejects(readFile(join(configDir, "ccr", "launch-example.json")), { code: "ENOENT" });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
}

test("Codex takeover in live CCR config blocks before credential resolution or save", async () => {
  const root = await mkdtemp(join(tmpdir(), "airkit-codex-takeover-live-"));
  const home = join(root, "home");
  const calls = [];
  const catalog = launchCatalog();
  catalog.profiles[0].shell = { ccrTokenOpRef: ["op:", "//Test/API/token"].join("") };
  const ccrClient = {
    getVersion: async () => {
      calls.push("getVersion");
      return "3.0.4";
    },
    getConfig: async () => {
      calls.push("getConfig");
      return {
        profile: {
          profiles: [{
            agent: "codex",
            configFile: join(home, ".codex", "config.toml"),
            enabled: true,
            privateValue: "do-not-leak",
            scope: "global",
          }],
        },
      };
    },
    saveConfig: async () => calls.push("saveConfig"),
    ensureGateway: async () => calls.push("ensureGateway"),
  };

  try {
    await mkdir(join(home, ".codex"), { recursive: true });
    await writeFile(join(home, ".codex", "config.toml"), "theme = \"dark\"\n");

    await assert.rejects(
      prepareLaunch(catalog, "launch-example", {
        ccrClient,
        commandExists: async () => true,
        configDir: join(root, "airkit"),
        env: { HOME: home },
        launch: false,
        runCommand: async () => {
          calls.push("credential-resolution");
          return { ok: true, status: 0, stdout: "private credential" };
        },
        runtimeVersions: passingRuntimeVersions(),
        spawnCommand: () => calls.push("spawn"),
      }),
      (error) => {
        assert.match(error.message, /airkit repair codex-takeover/);
        assert.match(error.message, /airkit repair codex-takeover --write/);
        assert.doesNotMatch(error.message, /do-not-leak|privateValue/);
        return true;
      },
    );

    assert.deepEqual(calls, ["getConfig"]);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("launch fails closed on noncanonical takeover record shapes after the first management read", async () => {
  const invalidTexts = ["", ...[[], {}, { arbitrary: true }, { version: "1", profiles: [] }].map(JSON.stringify)];
  for (const [index, text] of invalidTexts.entries()) {
    const root = await mkdtemp(join(tmpdir(), `airkit-invalid-takeover-${index}-`));
    const stateDir = join(root, ".claude-code-router");
    const calls = [];
    try {
      await mkdir(stateDir, { recursive: true });
      await writeFile(join(stateDir, "global-profile-takeover.json"), text);
      await assert.rejects(prepareLaunch(launchCatalog(), "launch-example", {
        ccrClient: {
          getConfig: async () => { calls.push("getConfig"); return { profile: { profiles: [] } }; },
          getVersion: async () => { calls.push("getVersion"); return "3.0.4"; },
        },
        commandExists: async () => true,
        configDir: join(root, "airkit"),
        env: { DEMO_API_KEY: "runtime-secret", HOME: root },
        launch: false,
        runtimeVersions: passingRuntimeVersions(),
      }), /codex takeover state could not be verified/i);
      assert.deepEqual(calls, ["getConfig"]);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  }
});

test("Codex takeover safety probe reads config before any other RPC", async () => {
  const root = await mkdtemp(join(tmpdir(), "airkit-codex-takeover-order-"));
  const calls = [];
  const ccrClient = {
    getConfig: async () => {
      calls.push("getConfig");
      return { profile: { enabled: true, profiles: [] } };
    },
    getVersion: async () => {
      calls.push("getVersion");
      return "3.0.4";
    },
    saveConfig: async () => calls.push("saveConfig"),
  };

  try {
    await prepareLaunch(launchCatalog(), "launch-example", {
      ccrClient,
      commandExists: async () => true,
      configDir: join(root, "airkit"),
      env: { DEMO_API_KEY: "runtime-secret", HOME: root },
      launch: false,
      runtimeVersions: passingRuntimeVersions(),
    });

    assert.deepEqual(calls.slice(0, 3), ["getConfig", "getVersion", "getConfig"]);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("Codex takeover rechecks active config after getVersion changes service state", async () => {
  const root = await mkdtemp(join(tmpdir(), "airkit-codex-takeover-recheck-"));
  const home = join(root, "home");
  const calls = [];
  let hazardous = false;
  const ccrClient = {
    getConfig: async () => {
      calls.push("getConfig");
      return hazardous
        ? {
            profile: {
              profiles: [{
                agent: "codex",
                configFile: join(home, ".codex", "config.toml"),
                enabled: true,
                privateValue: "do-not-leak",
                scope: "global",
              }],
            },
          }
        : { profile: { enabled: true, profiles: [] } };
    },
    getVersion: async () => {
      calls.push("getVersion");
      hazardous = true;
      return "3.0.4";
    },
    saveConfig: async () => calls.push("saveConfig"),
    ensureGateway: async () => calls.push("ensureGateway"),
  };

  try {
    await assert.rejects(
      prepareLaunch(launchCatalog(), "launch-example", {
        ccrClient,
        commandExists: async () => true,
        configDir: join(root, "airkit"),
        env: { DEMO_API_KEY: "runtime-secret", HOME: home },
        runtimeVersions: passingRuntimeVersions(),
        runCommand: async () => {
          calls.push("credential-resolution");
          return { ok: true, status: 0, stdout: "private credential" };
        },
        spawnCommand: () => calls.push("spawn"),
      }),
      (error) => {
        assert.match(error.message, /airkit repair codex-takeover --write/);
        assert.doesNotMatch(error.message, /do-not-leak|privateValue/);
        return true;
      },
    );

    assert.deepEqual(calls, ["getConfig", "getVersion", "getConfig"]);
    await assert.rejects(readFile(join(root, "airkit", "ccr", "launch-example.json")), { code: "ENOENT" });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("Codex takeover launch sanitizes getVersion RPC failures", async () => {
  const catalogPath = await writeLaunchCatalog();
  const root = await mkdtemp(join(tmpdir(), "airkit-codex-version-error-"));
  const calls = [];
  const output = [];
  const sentinel = "private-version-rpc-payload";
  const ccrClient = {
    getConfig: async () => {
      calls.push("getConfig");
      return { profile: { enabled: true, profiles: [] } };
    },
    getVersion: async () => {
      calls.push("getVersion");
      throw new Error(`CCR RPC failed with ${sentinel}`);
    },
  };

  try {
    await assert.rejects(
      runAirclaudeCli(["--profile", "launch-example", "--config-dir", join(root, "airkit")], {
        catalogPath,
        ccrClient,
        commandExists: async () => true,
        env: { DEMO_API_KEY: "runtime-secret", HOME: root },
        runtimeVersions: passingRuntimeVersions(),
        stdout: { write: (chunk) => output.push(chunk) },
      }),
      (error) => {
        assert.match(error.message, /Unable to inspect CCR runtime version safely/);
        assert.match(error.message, /airkit repair codex-takeover --write/);
        assert.doesNotMatch(`${error.message}\n${output.join("")}`, new RegExp(sentinel));
        return true;
      },
    );

    assert.deepEqual(calls, ["getConfig", "getVersion"]);
  } finally {
    await rm(root, { force: true, recursive: true });
    await rm(resolve(catalogPath, ".."), { force: true, recursive: true });
  }
});

test("createCcr3Client autoStart false rejects missing and stale services without invoking runner", async () => {
  for (const serviceState of ["missing", "stale"]) {
    const root = await mkdtemp(join(tmpdir(), `airkit-ccr-auto-start-${serviceState}-`));
    const calls = [];
    try {
      if (serviceState === "stale") {
        const stateDir = join(root, ".claude-code-router");
        await mkdir(stateDir, { recursive: true });
        await writeFile(join(stateDir, "service.json"), JSON.stringify({
          url: "http://127.0.0.1:9/?ccr_web_token=synthetic-token",
        }));
      }
      const client = airkitRuntime.createCcr3Client({
        autoStart: false,
        env: { HOME: root },
        fetch: async () => {
          calls.push("fetch");
          throw new Error("synthetic stale service");
        },
        runCommand: async () => {
          calls.push("runner");
          return { ok: true, status: 0, stdout: "" };
        },
      });

      await assert.rejects(client.getConfig(), /CCR 3 management service is not running/);
      assert.ok(!calls.includes("runner"));
      assert.deepEqual(calls, serviceState === "missing" ? [] : ["fetch"]);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  }
});

test("missing CCR starts management-only before getConfig and launch performs no later action before safety", async () => {
  const root = await mkdtemp(join(tmpdir(), "airkit-codex-management-start-"));
  const stateDir = join(root, ".claude-code-router");
  const calls = [];
  const safeConfig = { profile: { enabled: true, profiles: [] } };
  try {
    await prepareLaunch(launchCatalog(), "launch-example", {
      commandExists: async () => true,
      configDir: join(root, "airkit"),
      createCcrClient: (clientOptions) => airkitRuntime.createCcr3Client({
        ...clientOptions,
        fetch: async (_url, request) => {
          const { args, method } = JSON.parse(request.body);
          calls.push(`rpc:${method}`);
          if (method === "saveConfig") assert.deepEqual(args[1], { applyProfile: false });
          const value = method === "getAppInfo" ? { version: "3.0.4" } : safeConfig;
          return { ok: true, json: async () => ({ value }) };
        },
        runCommand: async (command, args) => {
          calls.push(`run:${command}:${args.join(":")}`);
          await mkdir(stateDir, { recursive: true });
          await writeFile(join(stateDir, "service.json"), JSON.stringify({
            url: "http://127.0.0.1:9/?ccr_web_token=synthetic-token",
          }));
          return { ok: true, status: 0, stdout: "" };
        },
      }),
      env: { DEMO_API_KEY: "runtime-secret", HOME: root },
      launch: false,
      runtimeVersions: passingRuntimeVersions(),
    });
    assert.deepEqual(calls.slice(0, 4), [
      "run:ccr:start:--no-gateway",
      "rpc:getConfig",
      "rpc:getAppInfo",
      "rpc:getConfig",
    ]);
    assert.ok(calls.indexOf("rpc:saveConfig") > calls.indexOf("rpc:getConfig"));
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("management-only startup rejects hazardous first config before version, save, gateway, or spawn", async () => {
  const root = await mkdtemp(join(tmpdir(), "airkit-codex-management-hazard-"));
  const stateDir = join(root, ".claude-code-router");
  const calls = [];
  try {
    await assert.rejects(prepareLaunch(launchCatalog(), "launch-example", {
      commandExists: async () => true,
      configDir: join(root, "airkit"),
      createCcrClient: (clientOptions) => airkitRuntime.createCcr3Client({
        ...clientOptions,
        fetch: async (_url, request) => {
          const { method } = JSON.parse(request.body);
          calls.push(`rpc:${method}`);
          return { ok: true, json: async () => ({ value: {
            profile: { profiles: [{
              agent: "codex",
              configFile: join(root, ".codex", "config.toml"),
              enabled: true,
              privateValue: "must-not-leak",
              scope: "global",
            }] },
          } }) };
        },
        runCommand: async (command, args) => {
          calls.push(`run:${command}:${args.join(":")}`);
          await mkdir(stateDir, { recursive: true });
          await writeFile(join(stateDir, "service.json"), JSON.stringify({
            url: "http://127.0.0.1:9/?ccr_web_token=synthetic-token",
          }));
          return { ok: true, status: 0, stdout: "" };
        },
      }),
      env: { DEMO_API_KEY: "runtime-secret", HOME: root },
      runtimeVersions: passingRuntimeVersions(),
      spawnCommand: () => calls.push("spawn"),
    }), (error) => /codex-takeover --write/i.test(error.message) && !/must-not-leak/.test(error.message));
    assert.deepEqual(calls, ["run:ccr:start:--no-gateway", "rpc:getConfig"]);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("codex-takeover preview uses a non-starting client and performs zero writes", async () => {
  const codexPath = "/synthetic/home/.codex/config.toml";
  const output = [];
  const calls = [];
  const io = {
    chmod: async () => {},
    mkdir: async () => {},
    mkdtemp: async (prefix) => `${prefix}fixture-swap`,
    readFile: async (path) => {
      calls.push(`read:${path}`);
      if (path !== codexPath) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      return Buffer.from([
        "# BEGIN CCR managed profile",
        "private-value = \"do-not-leak\"",
        "# END CCR managed profile",
        "",
      ].join("\n"));
    },
    rename: async () => calls.push("rename"),
    realpath: async (path) => path,
    stat: async () => ({ mode: 0o100600 }),
    unlink: async () => calls.push("unlink"),
    writeFile: async () => calls.push("write"),
  };

  const exitCode = await runCli(["repair", "codex-takeover"], {
    catalogPath: "/does/not/exist/catalog.json",
    codexTakeoverIo: io,
    createCcrClient: (clientOptions) => {
      calls.push(`client:autoStart=${clientOptions.autoStart}`);
      return {
        getConfig: async () => {
          calls.push("getConfig");
          return {
            profile: {
              profiles: [{
                agent: "codex",
                configFile: codexPath,
                enabled: true,
                privateValue: "do-not-leak",
                scope: "global",
              }],
            },
          };
        },
      };
    },
    env: { HOME: "/synthetic/home" },
    stdout: { write: (chunk) => output.push(chunk) },
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(calls, [
    "client:autoStart=false",
    "getConfig",
    "read:/synthetic/home/.claude-code-router/global-profile-takeover.json",
    `read:${codexPath}`,
  ]);
  assert.match(output.join(""), /Preview.*Codex takeover/i);
  assert.match(output.join(""), new RegExp(codexPath.replaceAll(".", "\\.")));
  assert.match(output.join(""), /remove-managed-codex-blocks/);
  assert.match(output.join(""), /scope-codex-profiles-to-ccr/);
  assert.match(output.join(""), /airkit repair codex-takeover --write/);
  assert.doesNotMatch(output.join(""), /do-not-leak|private-value|privateValue/);
  assert.ok(!calls.some((call) => ["write", "rename", "unlink"].includes(call)));
});

test("codex-takeover preview sanitizes CCR RPC failures", async () => {
  const sentinel = "private-preview-rpc-payload";
  const calls = [];
  const output = [];

  await assert.rejects(
    runCli(["repair", "codex-takeover"], {
      catalogPath: "/does/not/exist/catalog.json",
      codexTakeoverIo: {
        chmod: async () => {},
        mkdir: async () => {},
        mkdtemp: async (prefix) => `${prefix}fixture-swap`,
        readFile: async (path) => {
          if (path !== "/synthetic/home/.codex/config.toml") {
            throw Object.assign(new Error("missing"), { code: "ENOENT" });
          }
          return Buffer.from("theme = \"dark\"\n");
        },
        rename: async () => calls.push("rename"),
        realpath: async (path) => path,
        stat: async () => ({ mode: 0o100600 }),
        unlink: async () => calls.push("unlink"),
        writeFile: async () => calls.push("write"),
      },
      createCcrClient: (clientOptions) => {
        calls.push(`client:autoStart=${clientOptions.autoStart}`);
        return {
          getConfig: async () => {
            calls.push("getConfig");
            throw new Error(`CCR RPC failed with ${sentinel}`);
          },
        };
      },
      env: { HOME: "/synthetic/home" },
      stdout: { write: (chunk) => output.push(chunk) },
    }),
    (error) => {
      assert.match(error.message, /Codex takeover repair preview failed/);
      assert.match(error.message, /airkit repair codex-takeover --write/);
      assert.doesNotMatch(`${error.message}\n${output.join("")}`, new RegExp(sentinel));
      return true;
    },
  );

  assert.deepEqual(calls, ["client:autoStart=false", "getConfig"]);
});

test("codex-takeover --write backs up exact bytes before RPC and reports only safe paths", async () => {
  const codexPath = "/synthetic/home/.codex/config.toml";
  const timestamp = "2026-07-15T01-02-03-004Z";
  const backupPath = `${codexPath}.backup-${timestamp}-cli-nonce`;
  const temporaryPath = `${codexPath}.airkit-repair-${timestamp}-cli-nonce.tmp`;
  const latest = Buffer.from([
    "theme = \"private-theme\"",
    "# BEGIN CCR managed profile",
    "private-value = \"do-not-leak\"",
    "# END CCR managed profile",
    "",
  ].join("\n"));
  const files = new Map([[codexPath, latest]]);
  const modes = new Map([[codexPath, 0o100640]]);
  const events = [];
  const output = [];
  const io = {
    chmod: async (path, mode) => modes.set(path, mode),
    mkdir: async () => {},
    mkdtemp: async (prefix) => `${prefix}fixture-swap`,
    readFile: async (path) => {
      events.push(`read:${path}`);
      if (!files.has(path)) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      return Buffer.from(files.get(path));
    },
    rename: async (from, to) => {
      events.push(`rename:${from}->${to}`);
      files.set(to, files.get(from));
      modes.set(to, modes.get(from));
      files.delete(from);
      modes.delete(from);
    },
    realpath: async (path) => {
      if (!files.has(path)) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      return path;
    },
    stat: async (path) => {
      events.push(`stat:${path}`);
      return { mode: modes.get(path) };
    },
    unlink: async (path) => {
      events.push(`unlink:${path}`);
      files.delete(path);
      modes.delete(path);
    },
    writeFile: async (path, value, options) => {
      events.push(`write:${path}`);
      assert.equal(options.flag, "wx");
      files.set(path, Buffer.from(value));
      modes.set(path, options.mode);
    },
  };
  const hazardousConfig = {
    profile: {
      profiles: [{
        agent: "codex",
        configFile: codexPath,
        enabled: true,
        privateValue: "do-not-leak",
        scope: "global",
      }],
    },
  };
  let activeRepairConfig = structuredClone(hazardousConfig);

  const exitCode = await runCli(["repair", "codex-takeover", "--write"], {
    catalogPath: "/does/not/exist/catalog.json",
    codexTakeoverIo: io,
    codexTakeoverNonce: () => "cli-nonce",
    codexTakeoverNow: () => new Date("2026-07-15T01:02:03.004Z"),
    createCcrClient: (clientOptions) => {
      events.push(`client:autoStart=${clientOptions.autoStart}`);
      return {
        getConfig: async () => {
          events.push("getConfig-or-start");
          return structuredClone(activeRepairConfig);
        },
        saveConfig: async (config) => {
          events.push("saveConfig");
          assert.equal(config.profile.profiles[0].scope, "ccr");
          assert.equal(config.profile.profiles[0].showAllSessions, true);
          activeRepairConfig = structuredClone(config);
        },
      };
    },
    env: { HOME: "/synthetic/home" },
    stdout: { write: (chunk) => output.push(chunk) },
  });

  assert.equal(exitCode, 0);
  assert.ok(events.indexOf("getConfig-or-start") < events.indexOf(`write:${backupPath}`));
  assert.ok(events.indexOf(`write:${backupPath}`) < events.indexOf("saveConfig"));
  assert.deepEqual(files.get(backupPath), latest);
  assert.equal(files.get(codexPath).toString("utf8"), "theme = \"private-theme\"\n");
  assert.ok(!files.has(temporaryPath));
  assert.match(output.join(""), new RegExp(backupPath.replaceAll(".", "\\.")));
  assert.match(output.join(""), new RegExp(codexPath.replaceAll(".", "\\.")));
  assert.doesNotMatch(output.join(""), /do-not-leak|private-theme|private-value|privateValue/);
});

test("prepareLaunch writes managed files, syncs CCR 3 through RPC, and preserves passthrough args", async () => {
  const catalog = launchCatalog();
  const configDir = await mkdtemp(join(tmpdir(), "airkit-launch-write-"));
  const spawned = [];
  const saved = [];
  const launchEvents = [];

  try {
    const ccrClient = ccrTestClient(saved);
    ccrClient.ensureGateway = async () => launchEvents.push("gateway-ready");
    const result = await prepareLaunch(catalog, "launch-example", {
      configDir,
      ccrClient,
      mode: "pro",
      env: { DEMO_API_KEY: "runtime-secret", HOME: "/tmp/airkit-isolated-home" },
      runtimeVersions: passingRuntimeVersions(),
      userArgs: ["--dangerously-skip-permissions"],
      commandExists: async (command) => ["ccr", "claude"].includes(command),
      runCommand: async (command, args) => ({
        ok: true,
        status: 0,
        stdout: command === "ccr" && args[0] === "activate" ? 'export ANTHROPIC_BASE_URL="http://127.0.0.1:3456"\n' : "",
      }),
      spawnCommand: (command, args, options) => {
        launchEvents.push("profile-launch");
        spawned.push({ command, args, env: options.env });
        return { status: 0 };
      },
    });

    assert.equal(result.write, true);
    assert.equal(result.liveCcrConfig.status, "managed");
    assert.equal(
      saved[0].profile.profiles.find((candidate) => candidate.id.endsWith("-pro")).model,
      "airkit-provider-launch-example-demo/strong-coder",
    );
    assert.equal(spawned.length, 1);
    assert.deepEqual(launchEvents, ["gateway-ready", "profile-launch"]);
    assert.equal(spawned[0].command, "ccr");
    assert.deepEqual(spawned[0].args.slice(0, 4), [
      "airkit-launch-example-pro",
      "cli",
      "--",
      "--append-system-prompt",
    ]);
    assert.match(
      spawned[0].args[4],
      /AirClaude mode pro routes default to strong-coder while Claude launch uses claude-sonnet-4-6\./,
    );
    assert.match(spawned[0].args[4], /AirKit reusable runtime lessons/);
    assert.match(spawned[0].args[4], /AirClaude active routing/);
    assert.match(spawned[0].args[4], /mode: pro/);
    assert.match(spawned[0].args[4], /background: demo,cheap-coder \(model cheap-coder\)/);
    // AirClaude selects its display model for this launch only; passthrough args
    // still follow and can override it for the same process.
  assert.equal(spawned[0].args[5], "--model");
  assert.equal(spawned[0].args[6], "claude-sonnet-4-6");
  assert.equal(spawned[0].args.at(-1), "--dangerously-skip-permissions");
    assert.deepEqual(spawned[0].env, {
      DEMO_API_KEY: "runtime-secret",
      HOME: "/tmp/airkit-isolated-home",
      AIRCLAUDE_MODE: "pro",
      AIRCLAUDE_PROFILE: "launch-example",
      AIRCLAUDE_ROUTE_BACKGROUND: "demo,cheap-coder",
      AIRCLAUDE_ROUTE_BACKGROUND_MODEL: "cheap-coder",
      AIRCLAUDE_ROUTE_BACKGROUND_PROVIDER: "demo",
      AIRCLAUDE_ROUTE_DEFAULT: "demo,strong-coder",
      AIRCLAUDE_ROUTE_DEFAULT_MODEL: "strong-coder",
      AIRCLAUDE_ROUTE_DEFAULT_PROVIDER: "demo",
      AIRCLAUDE_STATUSLINE_INPUT_PRICE_PER_MILLION: "2",
      AIRCLAUDE_STATUSLINE_LABEL: "airclaude pro strong-coder",
      CLAUDE_STATUSLINE_CACHE_DIR: "/tmp/airkit-isolated-home/.claude/cache/airclaude/launch-example/pro",
      POWERLEVEL9K_INSTANT_PROMPT: "off",
      CCR_PROFILE: "launch-example",
    });
  } finally {
    await rm(configDir, { force: true, recursive: true });
  }
});

test("prepareLaunch registers compatibility MCP additively with child-only expanded gateway credentials", async () => {
  const catalog = legacyCompatibilityCatalog();
  const configDir = await mkdtemp(join(tmpdir(), "airkit-compatibility-launch-"));
  const saved = [];
  const spawned = [];
  const unrelated = { id: "user-plugin", module: "/user/plugin.mjs" };
  const currentConfig = {
    APIKEY: "$CCR_GATEWAY_TOKEN",
    HOST: "$CCR_GATEWAY_HOST",
    PORT: "$CCR_GATEWAY_PORT",
    Providers: [],
    plugins: [unrelated],
    profile: { enabled: true, profiles: [] },
  };
  const ccrClient = {
    ensureGateway: async () => {},
    getConfig: async () => structuredClone(currentConfig),
    getVersion: async () => "3.0.4",
    saveConfig: async (config) => saved.push(config),
  };

  try {
    await prepareLaunch(catalog, "launch-example", {
      ccrClient,
      commandExists: async () => true,
      configDir,
      env: {
        CCR_GATEWAY_HOST: "127.0.0.1",
        CCR_GATEWAY_PORT: "4567",
        CCR_GATEWAY_TOKEN: "fixture-gateway-token",
        DEMO_API_KEY: "runtime-secret",
        HOME: configDir,
      },
      runtimeVersions: passingRuntimeVersions(),
      spawnCommand: (command, args, options) => {
        spawned.push({ args, command, env: options.env });
        return { status: 0 };
      },
    });

    assert.equal(saved[0].plugins.some((plugin) => plugin.id === unrelated.id), true);
    assert.equal(saved[0].plugins.find((plugin) => plugin.id === "airkit-compatibility").module,
      resolve(import.meta.dirname, "..", "src", "compat", "plugin.mjs"));
    const mcpIndex = spawned[0].args.indexOf("--mcp-config");
    assert.notEqual(mcpIndex, -1);
    assert.equal(spawned[0].args.includes("--strict-mcp-config"), false);
    assert.equal(spawned[0].args.includes("--settings"), false);
    assert.doesNotMatch(spawned[0].args.join(" "), /fixture-gateway-token/);
    assert.deepEqual(JSON.parse(spawned[0].args[mcpIndex + 1]), {
      mcpServers: {
        "airkit-compatibility": {
          headers: { Authorization: "Bearer ${AIRKIT_COMPATIBILITY_MCP_TOKEN}" },
          type: "http",
          url: "${AIRKIT_COMPATIBILITY_MCP_URL}",
        },
      },
    });
    assert.equal(spawned[0].env.AIRKIT_COMPATIBILITY_MCP_URL,
      "http://127.0.0.1:4567/airkit/compatibility/mcp");
    assert.equal(spawned[0].env.AIRKIT_COMPATIBILITY_MCP_TOKEN, "fixture-gateway-token");
  } finally {
    await rm(configDir, { force: true, recursive: true });
  }
});

test("prepareLaunch resolves ccrTokenOpRef once for the CCR 3 config merge", async () => {
  const catalog = compatibilityCatalog();
  for (const provider of catalog.profiles[0].ccr.Providers) {
    provider.api_key = "$ANTHROPIC_AUTH_TOKEN";
  }
  catalog.profiles[0].shell = { ccrTokenOpRef: "op://Test/API/token" };
  const configDir = await mkdtemp(join(tmpdir(), "airkit-launch-op-"));
  const calls = [];
  const saved = [];

  try {
    const result = await prepareLaunch(catalog, "launch-example", {
      configDir,
      ccrClient: ccrTestClient(saved),
      commandExists: async (command) => ["ccr", "claude", "op"].includes(command),
      env: { HOME: configDir },
      launch: false,
      runtimeVersions: passingRuntimeVersions(),
      runCommand: async (command, args, options = {}) => {
        calls.push({ command, args, token: options.env?.ANTHROPIC_AUTH_TOKEN });
        if (command === "op") return { ok: true, status: 0, stdout: "resolved-token" };
        return { ok: true, status: 0, stdout: "" };
      },
    });

    assert.equal(result.runtime.ccr.ok, true);
    assert.deepEqual(calls, [
      { command: "op", args: ["read", "op://Test/API/token", "--no-newline"], token: undefined },
    ]);
    assert.equal(
      saved[0].Providers.find((provider) => provider.id === "airkit-provider-launch-example-demo").api_key,
      "resolved-token",
    );
    assert.equal(
      saved[0].Providers.find((provider) =>
        provider.id === "airkit-provider-launch-example-anthropic-messages").api_key,
      "resolved-token",
    );
  } finally {
    await rm(configDir, { force: true, recursive: true });
  }
});

test("prepareLaunch never assigns the Anthropic token to a different unresolved placeholder", async () => {
  const catalog = compatibilityCatalog();
  catalog.profiles[0].ccr.Providers[1].api_key = "$OTHER_PROVIDER_TOKEN";
  catalog.profiles[0].shell = { ccrTokenOpRef: "op://Test/API/token" };
  const configDir = await mkdtemp(join(tmpdir(), "airkit-launch-other-token-"));

  try {
    await assert.rejects(
      () => prepareLaunch(catalog, "launch-example", {
        configDir,
        ccrClient: ccrTestClient([]),
        commandExists: async (command) => ["ccr", "claude", "op"].includes(command),
        env: { DEMO_API_KEY: "demo-token", HOME: configDir },
        launch: false,
        runtimeVersions: passingRuntimeVersions(),
        runCommand: async (command) => command === "op"
          ? { ok: true, status: 0, stdout: "resolved-token" }
          : { ok: true, status: 0, stdout: "" },
      }),
      /unresolved provider credentials: anthropic-messages \(OTHER_PROVIDER_TOKEN\)/,
    );
  } finally {
    await rm(configDir, { force: true, recursive: true });
  }
});

test("prepareLaunch fails fast when credential resolution hangs", async () => {
  const catalog = launchCatalog();
  catalog.profiles[0].shell = { ccrTokenOpRef: "op://Test/API/token" };
  const fakeBin = await mkdtemp(join(tmpdir(), "airkit-launch-hanging-op-"));
  const configDir = await mkdtemp(join(tmpdir(), "airkit-launch-timeout-"));

  try {
    const fakeOp = join(fakeBin, "op");
    await writeFile(fakeOp, "#!/bin/sh\n/bin/sleep 5\n");
    await chmod(fakeOp, 0o755);

    await assert.rejects(
      () =>
        prepareLaunch(catalog, "launch-example", {
          ccrClient: ccrTestClient([]),
          commandExists: async (command) => ["ccr", "claude", "op"].includes(command),
          commandTimeoutMs: 50,
          configDir,
          env: { HOME: configDir, PATH: fakeBin },
          liveCcrConfig: join(configDir, "live", "config.json"),
          runtimeVersions: passingRuntimeVersions(),
        }),
      /unable to read op:\/\/Test\/API\/token/,
    );
  } finally {
    await rm(fakeBin, { force: true, recursive: true });
    await rm(configDir, { force: true, recursive: true });
  }
});

test("runAirclaudeCli dry run supports positional pro mode and avoids launching", async () => {
  const catalogPath = await writeLaunchCatalog();
  const configDir = await mkdtemp(join(tmpdir(), "airkit-launch-cli-"));
  const output = [];

  try {
    const exitCode = await runAirclaudeCli(["pro", "--dry-run", "--profile", "launch-example", "--config-dir", configDir], {
      catalogPath,
      stdout: { write: (chunk) => output.push(chunk) },
      commandExists: async () => true,
      runCommand: async () => ({ ok: true, status: 0 }),
      spawnCommand: () => {
        throw new Error("dry run should not launch");
      },
    });

    assert.equal(exitCode, 0);
    assert.match(output.join(""), /mode: pro/);
    assert.match(output.join(""), /demo,strong-coder/);
    assert.doesNotMatch(output.join(""), /sk-/);
  } finally {
    await rm(configDir, { force: true, recursive: true });
    await rm(resolve(catalogPath, ".."), { force: true, recursive: true });
  }
});

test("runAirclaudeCli treats any profile-defined mode as a bare positional, not just auto/pro", async () => {
  const catalogPath = await writeLaunchCatalog();
  const configDir = await mkdtemp(join(tmpdir(), "airkit-launch-cli-"));
  const output = [];

  try {
    const exitCode = await runAirclaudeCli(["fast", "--dry-run", "--profile", "launch-example", "--config-dir", configDir], {
      catalogPath,
      stdout: { write: (chunk) => output.push(chunk) },
      commandExists: async () => true,
      runCommand: async () => ({ ok: true, status: 0 }),
      spawnCommand: () => {
        throw new Error("dry run should not launch");
      },
    });

    assert.equal(exitCode, 0);
    assert.match(output.join(""), /mode: fast/);
    assert.match(output.join(""), /default: demo,cheap-coder/);
  } finally {
    await rm(configDir, { force: true, recursive: true });
    await rm(resolve(catalogPath, ".."), { force: true, recursive: true });
  }
});

test("runAirclaudeCli forwards an unknown bare token to claude instead of treating it as a mode", async () => {
  const catalogPath = await writeLaunchCatalog();
  const configDir = await mkdtemp(join(tmpdir(), "airkit-launch-cli-"));
  const output = [];

  try {
    const exitCode = await runAirclaudeCli(["notamode", "--dry-run", "--profile", "launch-example", "--config-dir", configDir], {
      catalogPath,
      stdout: { write: (chunk) => output.push(chunk) },
      commandExists: async () => true,
      runCommand: async () => ({ ok: true, status: 0 }),
      spawnCommand: () => {
        throw new Error("dry run should not launch");
      },
    });

    // Unknown token is not a defined mode → stays on defaultMode (auto) and is
    // forwarded to claude as a user arg rather than throwing "does not define mode".
    assert.equal(exitCode, 0);
    assert.match(output.join(""), /mode: auto/);
    assert.match(output.join(""), /notamode/);
  } finally {
    await rm(configDir, { force: true, recursive: true });
    await rm(resolve(catalogPath, ".."), { force: true, recursive: true });
  }
});

test("CCR_LOG env overrides ccr.LOG for a single launch without editing the profile", async () => {
  const configDir = await mkdtemp(join(tmpdir(), "airkit-ccrlog-"));
  // Fresh catalog per call + explicit env so the assertions are hermetic.
  const planLog = (env = {}) => buildLaunchPlan(launchCatalog(), "launch-example", { configDir, env }).ccrConfig.LOG;

  try {
    assert.equal(planLog(), false); // profile default (ccr.LOG: false)
    assert.equal(planLog({ CCR_LOG: "1" }), true);
    assert.equal(planLog({ CCR_LOG: "true" }), true);
    assert.equal(planLog({ CCR_LOG: "off" }), false);
    assert.equal(planLog({ CCR_LOG: "0" }), false);
    // Blank or unrecognized values fall back to the profile's ccr.LOG default.
    assert.equal(planLog({ CCR_LOG: "" }), false);
    assert.equal(planLog({ CCR_LOG: "maybe" }), false);
  } finally {
    await rm(configDir, { force: true, recursive: true });
  }
});

test("runAirclaudeCli prints help without loading the catalog", async () => {
  for (const arg of ["-h", "--help"]) {
    const output = [];
    const exitCode = await runAirclaudeCli([arg], {
      catalogPath: "/does/not/exist/catalog.json",
      stdout: { write: (chunk) => output.push(chunk) },
      spawnCommand: () => {
        throw new Error("help should not launch");
      },
    });

    assert.equal(exitCode, 0);
    const help = output.join("");
    assert.match(help, /Usage: airclaude \[mode\]/);
    assert.match(help, /profile-defined routing mode/);
    assert.doesNotMatch(help, /\[auto\|pro\]/);
    assert.match(help, /airclaude pro/);
    assert.match(help, /--doctor/);
  }
});

function runAirkitWithEnv(env, ...args) {
  return spawnSync(process.execPath, [resolve(import.meta.dirname, "..", "src", "airkit.mjs"), ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

function appendSystemPromptText(args) {
  const prompts = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--append-system-prompt") prompts.push(args[index + 1] ?? "");
  }
  return prompts.join("\n");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function launchCatalog() {
  return {
    schema: 1,
    modelCatalog: {
      providers: [
        {
          id: "demo",
          models: [
            { id: "cheap-coder", pricingUsdPer1M: { input: 0.1 } },
            { id: "steady-coder", contextWindow: 256_000, pricingUsdPer1M: { input: 0.5 } },
            { id: "strong-coder", pricingUsdPer1M: { input: 2 } },
          ],
        },
      ],
    },
    profiles: [
      {
        name: "launch-example",
        visibility: "public",
        summary: "Launch-capable profile.",
        managedFiles: [],
        launch: {
          binary: "claude",
          args: [
            "--append-system-prompt",
            "AirClaude mode {{launchMode}} routes default to {{routeDefaultModel}} while Claude launch uses {{claudeModel}}.",
          ],
          env: { CCR_PROFILE: "{{profileName}}" },
          claudeModel: "claude-sonnet-4-6",
          defaultMode: "auto",
          modes: {
            auto: {},
            pro: {
              ccr: {
                Router: {
                  default: "demo,strong-coder",
                },
              },
            },
            fast: {
              ccr: {
                Router: {
                  default: "demo,cheap-coder",
                },
              },
            },
          },
        },
        ccr: {
          APIKEY: "ccr-local",
          LOG: false,
          Providers: [
            {
              name: "demo",
              type: "openai_chat_completions",
              api_base_url: "https://example.invalid/v1/chat/completions",
              api_key: "$DEMO_API_KEY",
              models: ["cheap-coder", "steady-coder", "strong-coder"],
            },
          ],
          Router: {
            default: "demo,steady-coder",
            background: "demo,cheap-coder",
          },
        },
      },
    ],
  };
}

function compatibilityCatalog() {
  const catalog = launchCatalog();
  catalog.profiles[0].ccr.Providers.push({
    name: "anthropic-messages",
    type: "anthropic_messages",
    api_base_url: "https://example.invalid/v1/messages",
    api_key: "$DEMO_API_KEY",
    models: ["claude-sonnet"],
  });
  catalog.profiles[0].ccr.plugins = [{
    id: "airkit-compatibility",
    module: "@lzong/ai-runtime-kit/compatibility-plugin",
    config: {
      fallback: {
        provider: "anthropic-messages",
        model: "claude-sonnet",
        maxContinuationTurns: 8,
      },
      advisor: { mode: "anthropic-fallback" },
      codeExecution: { mode: "anthropic-fallback" },
      mcpConnector: { mode: "anthropic-fallback" },
      toolSearch: { mode: "bridge" },
      webFetch: { mode: "native-first" },
      webSearch: { mode: "native-first" },
    },
  }];
  return catalog;
}

function legacyCompatibilityCatalog() {
  const catalog = compatibilityCatalog();
  catalog.profiles[0].ccr.plugins[0].config.webSearch = { mode: "mcp" };
  return catalog;
}

function passingRuntimeVersions() {
  return { claudeCode: "2.1.208", claudeCodeRouter: "3.0.4", node: "24.11.1" };
}

function ccrTestClient(saved) {
  return {
    getConfig: async () => ({
      Providers: [],
      Router: { builtInRules: {}, fallback: { mode: "off", models: [], retryCount: 1 }, rules: [] },
      profile: { enabled: true, profiles: [] },
    }),
    ensureGateway: async () => {},
    getVersion: async () => "3.0.4",
    saveConfig: async (config) => saved.push(config),
  };
}

async function writeLaunchCatalog() {
  const dir = await mkdtemp(join(tmpdir(), "airkit-launch-catalog-"));
  const path = join(dir, "catalog.json");
  await writeFile(path, `${JSON.stringify(launchCatalog(), null, 2)}\n`);
  return path;
}
