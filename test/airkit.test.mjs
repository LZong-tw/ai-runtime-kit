import { chmod, mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
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
  processCompletionGuardHook,
  processContextHook,
  processSubagentOutputHook,
} from "../src/context-heartbeat.mjs";
import {
  routeBareClaudeModel,
  validateCompatibilityConfig,
  validateCompatibilityProviderBinding,
} from "../src/compat/config.mjs";
import compatibilityPlugin, { createMessagesHandler } from "../src/compat/plugin.mjs";

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

test("runtime requirements hard-cut to Node 22, Claude Code 2.1.208, and CCR 3.0.18", async () => {
  const packageJson = JSON.parse(
    await readFile(resolve(import.meta.dirname, "..", "package.json"), "utf8"),
  );

  assert.equal(packageJson.engines.node, ">=22");
  assert.deepEqual(airkitRuntime.RUNTIME_REQUIREMENTS, {
    claudeCode: ">=2.1.208",
    claudeCodeRouter: ">=3.0.18 <4",
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
    [{ maxOutputTokens: 1023 }, /maxOutputTokens must be an integer from 1024 to 512000/],
    [{ maxOutputTokens: 512001 }, /maxOutputTokens must be an integer from 1024 to 512000/],
    [{ maxOutputTokens: "64000" }, /maxOutputTokens must be an integer from 1024 to 512000/],
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
  assert.equal(ccrVerifier.isSupportedCcrVersion("3.0.18"), true);
  assert.equal(ccrVerifier.isSupportedCcrVersion("3.0.17"), false);
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
  const expectedIdentity = {
    name: "@untionglim/ai-runtime-kit",
    version: "0.2.17",
    publishConfig: { access: "public" },
    repository: {
      type: "git",
      url: "git+https://github.com/LZong-tw/ai-runtime-kit.git",
    },
  };
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
  const legacyPackage = ["@lzong", "ai-runtime-kit"].join("/");
  const legacyScope = legacyPackage.split("/")[0];
  const legacyReference = new RegExp(`${legacyPackage}|node_modules["', )]+${legacyScope}`);
  for (const relativePath of [
    "scripts/verify-ccr3-e2e.mjs",
    "docs/install.md",
    "docs/profile-schema.md",
  ]) {
    const text = await readFile(resolve(import.meta.dirname, "..", relativePath), "utf8");
    assert.doesNotMatch(text, legacyReference);
  }
  const outDir = await mkdtemp(join(tmpdir(), "airkit-export-"));

  try {
    await exportOssRelease({ outDir });
    const exportedPackage = JSON.parse(await readFile(join(outDir, "package.json"), "utf8"));

    assert.deepEqual(packageJson.files, expectedFiles);
    assert.deepEqual(exportedPackage.files, expectedFiles);
    for (const candidate of [packageJson, exportedPackage]) {
      assert.equal(candidate.name, expectedIdentity.name);
      assert.equal(candidate.version, expectedIdentity.version);
      assert.deepEqual(candidate.publishConfig, expectedIdentity.publishConfig);
      assert.deepEqual(candidate.repository, expectedIdentity.repository);
      assert.equal(candidate.dependencies, undefined);
    }
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
      "| WebFetch (`webFetch`) | `native-first` | The client definition stays on the selected executor route; AirKit does not claim native execution is verified. Explicit `anthropic-fallback` mode uses the complete Anthropic route. |",
      "| Code Execution (`codeExecution`) | `anthropic-fallback` | The complete request uses the configured Anthropic route so container and continuation state stay intact. |",
      "| Advisor (`advisor`) | `bridge` or `anthropic-fallback` | Bridge mode simulates Claude's Advisor tool with a bounded transcript review through the configured Anthropic route and resumes with a canonical `advisor_tool_result`; fallback mode strips the definition by default. |",
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
      "prefix-observability.mjs",
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

test("CCR 3 merge preserves canonical fields added to an owned profile", () => {
  const currentProfile = {
    agent: "claude-code",
    enabled: true,
    fableModel: "",
    haikuModel: "",
    id: "airkit-launch-example-auto",
    managedCompact: false,
    model: "stale/model",
    name: "stale name",
    opusModel: "",
    scope: "ccr",
    settingsFile: "/tmp/stale-settings.json",
    smallFastModel: "stale/small",
    sonnetModel: "",
    surface: "auto",
  };
  const merged = airkitRuntime.buildCcr3ManagedConfig(
    launchCatalog(),
    "launch-example",
    { profile: { profiles: [currentProfile] } },
    { configDir: "/tmp/airkit-profile-canonical-fields" },
  );
  const profile = merged.config.profile.profiles.find(({ id }) => id === currentProfile.id);

  assert.deepEqual(
    Object.fromEntries(["fableModel", "haikuModel", "managedCompact", "opusModel", "sonnetModel"].map((key) => [key, profile[key]])),
    {
      fableModel: "",
      haikuModel: "",
      managedCompact: false,
      opusModel: "",
      sonnetModel: "",
    },
  );
});

test("CCR 3 merge translates base routes into gateway rules for bare Claude models", () => {
  const current = {
    Router: {
      builtInRules: { "claude-code": { enabled: true } },
      fallback: { mode: "off", models: [], retryCount: 1 },
      rules: [
        { id: "unrelated-rule", name: "Keep me", enabled: true, target: "unrelated/keep-me" },
        { id: "airkit-launch-example-route-default", name: "Stale managed", enabled: true },
      ],
    },
  };

  const merged = airkitRuntime.buildCcr3ManagedConfig(launchCatalog(), "launch-example", current, {
    configDir: "/tmp/airkit-config",
  });

  assert.deepEqual(
    merged.config.Router.rules.map(({ id }) => id),
    [
      "unrelated-rule",
      "airkit-launch-example-route-background",
      "airkit-launch-example-route-opus",
      "airkit-launch-example-route-default",
    ],
    "foreign rules stay first; stale managed rules are replaced",
  );
  const [, background, opus, sonnet] = merged.config.Router.rules;
  assert.deepEqual(background.condition, {
    left: "request.body.model",
    operator: "starts-with",
    right: "claude-haiku-",
  });
  assert.deepEqual(background.rewrites, [{
    key: "request.body.model",
    operation: "set",
    value: "airkit-provider-launch-example-demo/cheap-coder",
  }]);
  for (const rule of [background, opus, sonnet]) {
    assert.deepEqual(
      rule.rewrite,
      rule.rewrites[0],
      "single-rewrite rules carry CCR's canonical rewrite/rewrites pair, or every prepare re-saves and restarts the gateway",
    );
  }
  assert.deepEqual(opus.condition, {
    left: "request.body.model",
    operator: "starts-with",
    right: "claude-opus-",
  });
  assert.deepEqual(opus.rewrites, [{
    key: "request.body.model",
    operation: "set",
    value: "airkit-provider-launch-example-demo/steady-coder",
  }]);
  assert.deepEqual(sonnet.condition, {
    left: "request.body.model",
    operator: "starts-with",
    right: "claude-sonnet-",
  });
  assert.deepEqual(sonnet.rewrites, [{
    key: "request.body.model",
    operation: "set",
    value: "airkit-provider-launch-example-demo/steady-coder",
  }]);
  assert.equal(background.type, "condition");
  assert.equal(background.enabled, true);
  assert.deepEqual(merged.config.Router.builtInRules, { "claude-code": { enabled: true } });
  assert.deepEqual(merged.config.Router.fallback, { mode: "off", models: [], retryCount: 1 });

  const repeated = airkitRuntime.buildCcr3ManagedConfig(launchCatalog(), "launch-example", merged.config, {
    configDir: "/tmp/airkit-config",
  });
  assert.deepEqual(repeated.config.Router, merged.config.Router, "router merge is idempotent");
});

test("managed providers can use an endpoint-owned CCR id instead of the profile namespace", () => {
  const catalog = launchCatalog();
  catalog.profiles[0].ccr.Providers[0].managedId = "airkit-provider-shared-demo";

  const merged = airkitRuntime.buildCcr3ManagedConfig(catalog, "launch-example", {}, {
    configDir: "/tmp/airkit-managed-provider-id",
  });

  assert.equal(merged.config.Providers[0].id, "airkit-provider-shared-demo");
  assert.equal(merged.config.Providers[0].name, "airkit-provider-shared-demo");
  assert.equal(merged.config.Providers[0].managedId, undefined);
  assert.equal(
    airkitRuntime.buildCcrConfig(catalog, "launch-example").Providers[0].managedId,
    undefined,
  );
  assert.equal(
    merged.config.Router.rules.at(-1).rewrites[0].value,
    "airkit-provider-shared-demo/steady-coder",
  );
});

test("managed state stranded by a profile that left the catalog is removed, and other profiles survive", async () => {
  const catalog = launchCatalog();
  catalog.profiles = [...catalog.profiles, { ...catalog.profiles[0], name: "second-example" }];

  const current = {
    Providers: [
      { id: "unrelated-provider", name: "unrelated-provider", api_base_url: "https://example.invalid/v1", models: ["keep-me"] },
      { id: "airkit-provider-gone-example-demo", name: "airkit-provider-gone-example-demo", api_base_url: "https://gone.invalid/v1", models: ["Kimi-K3"] },
      { id: "airkit-provider-second-example-demo", name: "airkit-provider-second-example-demo", api_base_url: "https://second.invalid/v1", models: ["steady-coder"] },
    ],
    Router: {
      rules: [
        // The shape that broke a live install: an older AirKit build emitted a
        // bare `claude-` prefix, and CCR takes the first matching rule, so this
        // orphan outranks every correctly scoped rule that follows it.
        {
          id: "airkit-gone-example-route-default",
          name: "Orphan catch-all",
          enabled: true,
          type: "condition",
          condition: { left: "request.body.model", operator: "starts-with", right: "claude-" },
          rewrite: { key: "request.body.model", operation: "set", value: "airkit-provider-gone-example-demo/Kimi-K3" },
        },
        { id: "airkit-second-example-route-default", name: "Second profile", enabled: true },
        { id: "unrelated-rule", name: "Keep me", enabled: true, target: "unrelated/keep-me" },
      ],
    },
    profile: {
      profiles: [
        { id: "airkit-gone-example-auto", name: "Orphan profile" },
        { id: "airkit-second-example-auto", name: "Second profile auto" },
        { id: "unrelated-profile", name: "Keep me" },
      ],
    },
  };

  const merged = airkitRuntime.buildCcr3ManagedConfig(catalog, "launch-example", current, {
    configDir: "/tmp/airkit-config",
  });

  assert.deepEqual(merged.pruned, {
    profiles: ["airkit-gone-example-auto"],
    providers: ["airkit-provider-gone-example-demo"],
    rules: ["airkit-gone-example-route-default"],
  }, "removals are reported so a launch never shrinks the live config silently");

  const ruleIds = merged.config.Router.rules.map(({ id }) => id);
  assert.ok(!ruleIds.includes("airkit-gone-example-route-default"), "the orphan rule is gone");
  assert.ok(ruleIds.includes("airkit-second-example-route-default"), "another catalog profile's rule survives");
  assert.ok(ruleIds.includes("unrelated-rule"), "foreign rules are never touched");

  const providerIds = merged.config.Providers.map(({ id }) => id);
  assert.ok(!providerIds.includes("airkit-provider-gone-example-demo"), "the orphan provider is gone");
  assert.ok(providerIds.includes("airkit-provider-second-example-demo"), "another catalog profile's provider survives");
  assert.ok(providerIds.includes("unrelated-provider"), "foreign providers are never touched");

  const profileIds = merged.config.profile.profiles.map(({ id }) => id);
  assert.ok(!profileIds.includes("airkit-gone-example-auto"), "the orphan CCR profile is gone");
  assert.ok(profileIds.includes("airkit-second-example-auto"), "another catalog profile's CCR profile survives");
  assert.ok(profileIds.includes("unrelated-profile"), "foreign CCR profiles are never touched");
});

test("state belonging to a profile installed from another catalog is not treated as orphaned", async () => {
  // One CCR install can be driven by two catalogs (the private overlay repo and
  // the OSS checkout ship different profile sets), so ownership taken from the
  // loaded catalog alone would let a launch from either side delete the other's
  // live state.
  const configDir = await mkdtemp(join(tmpdir(), "airkit-owners-"));
  try {
    await mkdir(join(configDir, "ccr"), { recursive: true });
    await writeFile(join(configDir, "ccr", "other-catalog-profile.json"), "{}\n");

    const current = {
      Providers: [
        { id: "airkit-provider-other-catalog-profile-demo", name: "airkit-provider-other-catalog-profile-demo", api_base_url: "https://other.invalid/v1", models: ["steady-coder"] },
        { id: "airkit-provider-gone-example-demo", name: "airkit-provider-gone-example-demo", api_base_url: "https://gone.invalid/v1", models: ["Kimi-K3"] },
      ],
      Router: {
        rules: [
          { id: "airkit-other-catalog-profile-route-default", name: "Other catalog", enabled: true },
          { id: "airkit-gone-example-route-default", name: "Orphan", enabled: true },
        ],
      },
      profile: {
        profiles: [
          { id: "airkit-other-catalog-profile-auto", name: "Other catalog auto" },
          { id: "airkit-gone-example-auto", name: "Orphan auto" },
        ],
      },
    };

    const merged = airkitRuntime.buildCcr3ManagedConfig(launchCatalog(), "launch-example", current, { configDir });

    assert.deepEqual(merged.pruned, {
      profiles: ["airkit-gone-example-auto"],
      providers: ["airkit-provider-gone-example-demo"],
      rules: ["airkit-gone-example-route-default"],
    }, "only the profile with no catalog entry and no generated config is removed");

    assert.ok(
      merged.config.Router.rules.some(({ id }) => id === "airkit-other-catalog-profile-route-default"),
      "a generated profile config claims its own prefix even when this catalog never declares it",
    );
    assert.ok(merged.config.Providers.some(({ id }) => id === "airkit-provider-other-catalog-profile-demo"));
    assert.ok(merged.config.profile.profiles.some(({ id }) => id === "airkit-other-catalog-profile-auto"));
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
});

test("a profile whose slug prefixes another profile's slug does not replace that profile's state", async () => {
  // Slugs contain dashes, so "launch" claims every id belonging to
  // "launch-example" under a plain startsWith test. That deletion is the
  // dangerous kind: state read as the launching profile's own is replaced
  // without ever being reported as pruned.
  const catalog = launchCatalog();
  catalog.profiles = [...catalog.profiles, { ...catalog.profiles[0], name: "launch" }];

  const current = {
    Providers: [
      { id: "airkit-provider-launch-example-demo", name: "airkit-provider-launch-example-demo", api_base_url: "https://sibling.invalid/v1", models: ["steady-coder"] },
    ],
    Router: { rules: [{ id: "airkit-launch-example-route-default", name: "Sibling route", enabled: true }] },
    profile: { profiles: [{ id: "airkit-launch-example-auto", name: "Sibling auto" }] },
  };

  const merged = airkitRuntime.buildCcr3ManagedConfig(catalog, "launch", current, {
    configDir: "/tmp/airkit-nested-slugs",
  });

  assert.deepEqual(merged.pruned, { profiles: [], providers: [], rules: [] }, "nothing is orphaned here");
  assert.ok(
    merged.config.Router.rules.some(({ id }) => id === "airkit-launch-example-route-default"),
    "the longer-slug profile keeps its rule when the shorter-slug profile launches",
  );
  assert.ok(merged.config.Providers.some(({ id }) => id === "airkit-provider-launch-example-demo"));
  assert.ok(merged.config.profile.profiles.some(({ id }) => id === "airkit-launch-example-auto"));
});

test("a launch still replaces its own state that it no longer generates", async () => {
  // The longest-owner rule must not turn into a licence to keep everything: a
  // mode or provider dropped from the launching profile has to go.
  const current = {
    Providers: [
      { id: "airkit-provider-launch-example-retired", name: "airkit-provider-launch-example-retired", api_base_url: "https://retired.invalid/v1", models: ["gone"] },
    ],
    Router: { rules: [{ id: "airkit-launch-example-route-retired", name: "Retired route", enabled: true }] },
    profile: { profiles: [{ id: "airkit-launch-example-retired-mode", name: "Retired mode" }] },
  };

  const merged = airkitRuntime.buildCcr3ManagedConfig(launchCatalog(), "launch-example", current, {
    configDir: "/tmp/airkit-own-stale",
  });

  assert.ok(!merged.config.Router.rules.some(({ id }) => id === "airkit-launch-example-route-retired"));
  assert.ok(!merged.config.Providers.some(({ id }) => id === "airkit-provider-launch-example-retired"));
  assert.ok(!merged.config.profile.profiles.some(({ id }) => id === "airkit-launch-example-retired-mode"));
  assert.deepEqual(merged.pruned, { profiles: [], providers: [], rules: [] },
    "refreshing the launching profile's own state is routine, not a reported removal");
});

test("outer compatibility routing and managed core rules preserve unknown Claude models", async () => {
  const merged = airkitRuntime.buildCcr3ManagedConfig(
    compatibilityCatalog(),
    "launch-example",
    {},
    { configDir: "/tmp/airkit-outer-core-routing" },
  );
  const pluginConfig = merged.compatibility;
  const coreModels = [];

  const handler = createMessagesHandler({
    config: pluginConfig,
    coreClient: {
      async forwardRaw({ body }) {
        const request = JSON.parse(body.toString());
        const matchingRule = merged.config.Router.rules.find((rule) =>
          request.model.startsWith(rule.condition.right));
        coreModels.push(matchingRule ? matchingRule.rewrites[0].value : request.model);
      },
    },
    policies: {},
  });
  const invoke = async (model) => {
    const raw = Buffer.from(JSON.stringify({ model, max_tokens: 8, messages: [] }));
    await handler(
      { headers: {}, method: "POST", signal: undefined },
      {},
      { readBody: async () => raw },
    );
    return coreModels.at(-1);
  };

  assert.equal(await invoke("claude-fable-5"), "claude-fable-5");
  assert.equal(await invoke("provider/claude-sonnet-5"), "provider/claude-sonnet-5");
  assert.equal(
    await invoke("claude-sonnet-5"),
    "airkit-provider-launch-example-demo/steady-coder",
  );
  assert.equal(
    await invoke("claude-haiku-4-5-20251001"),
    "airkit-provider-launch-example-demo/cheap-coder",
  );
  assert.equal(
    await invoke("claude-opus-5"),
    "airkit-provider-launch-example-demo/steady-coder",
  );
});

test("CCR 3 managed providers can route upstream through a per-launch proxy", () => {
  const merged = airkitRuntime.buildCcr3ManagedConfig(
    compatibilityCatalog(),
    "launch-example",
    {},
    {
      apiKeys: { demo: "resolved-at-runtime" },
      env: {
        AIRCLAUDE_PROVIDER_BASE_URL: "http://127.0.0.1:8804/v1/chat/completions",
        AIRCLAUDE_ANTHROPIC_PROVIDER_BASE_URL: "http://127.0.0.1:8807/v1/messages",
      },
    },
  );

  assert.equal(
    merged.config.Providers[0].api_base_url,
    "http://127.0.0.1:8804/v1/chat/completions",
  );
  assert.equal(
    merged.config.Providers[1].api_base_url,
    "http://127.0.0.1:8807/v1/messages",
  );
});

test("prepareLaunch uses the process Headroom provider URL when no test env is injected", async () => {
  const catalog = compatibilityCatalog();
  const configDir = await mkdtemp(join(tmpdir(), "airkit-headroom-launch-"));
  const saved = [];
  const originalProviderBaseUrl = process.env.AIRCLAUDE_PROVIDER_BASE_URL;
  const originalDemoApiKey = process.env.DEMO_API_KEY;
  process.env.AIRCLAUDE_PROVIDER_BASE_URL = "http://127.0.0.1:8804/v1/chat/completions";
  process.env.DEMO_API_KEY = "resolved-at-runtime";

  try {
    await prepareLaunch(catalog, "launch-example", {
      ccrClient: ccrTestClient(saved),
      configDir,
      commandExists: async () => true,
      launch: false,
      runtimeVersions: passingRuntimeVersions(),
      runCommand: async () => ({ ok: true, status: 0, stdout: "gateway-key", stderr: "" }),
    });

    assert.equal(saved.length, 1);
    assert.equal(
      saved[0].Providers.find((provider) => provider.name === "airkit-provider-launch-example-demo").api_base_url,
      "http://127.0.0.1:8804/v1/chat/completions",
    );
  } finally {
    if (originalProviderBaseUrl === undefined) delete process.env.AIRCLAUDE_PROVIDER_BASE_URL;
    else process.env.AIRCLAUDE_PROVIDER_BASE_URL = originalProviderBaseUrl;
    if (originalDemoApiKey === undefined) delete process.env.DEMO_API_KEY;
    else process.env.DEMO_API_KEY = originalDemoApiKey;
    await rm(configDir, { force: true, recursive: true });
  }
});

test("CCR compatibility requires a managed Anthropic Messages provider and local model", () => {
  const cases = [
    ["missing provider", (catalog) => {
      catalog.profiles[0].ccr.plugins[0].config.fallback.provider = "missing";
    }, /fallback provider must resolve exactly once: missing/],
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

test("CCR compatibility migrates the catalog plugin into adapter metadata and preserves unrelated plugins", () => {
  const catalog = compatibilityCatalog();
  const unrelated = { id: "user-plugin", module: "/user/plugin.mjs", config: { keep: true } };
  const merged = airkitRuntime.buildCcr3ManagedConfig(catalog, "launch-example", {
    Providers: [],
    observability: { keep: "this-field" },
    plugins: [unrelated, { id: "airkit-compatibility", module: "/stale/plugin.mjs" }],
    profile: { profiles: [] },
  }, { configDir: "/tmp/airkit-compatibility" });

  assert.deepEqual(merged.config.plugins, [unrelated]);
  assert.equal(merged.config.plugins.some((plugin) => plugin.id === "airkit-compatibility"), false);
  assert.deepEqual(merged.config.observability, { keep: "this-field", requestLogs: true });
  assert.deepEqual(
    merged.compatibility.routes,
    {
      default: "airkit-provider-launch-example-demo/steady-coder",
      background: "airkit-provider-launch-example-demo/cheap-coder",
    },
    "adapter receives managed base routes for bare Claude model rewriting",
  );
  assert.deepEqual(
    merged.compatibility.modeRoutes,
    {
      auto: {
        default: "airkit-provider-launch-example-demo/steady-coder",
        background: "airkit-provider-launch-example-demo/cheap-coder",
      },
      fast: {
        default: "airkit-provider-launch-example-demo/cheap-coder",
        background: "airkit-provider-launch-example-demo/cheap-coder",
      },
      pro: {
        default: "airkit-provider-launch-example-demo/strong-coder",
        background: "airkit-provider-launch-example-demo/cheap-coder",
      },
    },
    "the adapter receives each mode's route table",
  );
  for (const profile of merged.config.profile.profiles) {
    const mode = profile.id.replace("airkit-launch-example-", "");
    assert.equal(
      profile.env.ANTHROPIC_CUSTOM_HEADERS,
      `x-airkit-mode: ${mode}`,
      "each launch mode labels its own requests so the adapter can route them",
    );
  }
  assert.equal(
    merged.compatibility.fallback.provider,
    "airkit-provider-launch-example-anthropic-messages",
  );
  assert.ok(merged.config.Providers.some((provider) =>
    provider.id === "airkit-provider-launch-example-anthropic-messages" &&
    provider.type === "anthropic_messages" &&
    provider.models.includes("claude-sonnet")));

  const repeated = airkitRuntime.buildCcr3ManagedConfig(
    catalog,
    "launch-example",
    merged.config,
    { configDir: "/tmp/airkit-compatibility" },
  );
  assert.deepEqual(repeated.config, merged.config);
});

test("a non-compatibility profile removes a stale compatibility gateway route", () => {
  const unrelated = { id: "user-plugin", module: "/user/plugin.mjs" };
  const merged = airkitRuntime.buildCcr3ManagedConfig(launchCatalog(), "launch-example", {
    plugins: [unrelated, { id: "airkit-compatibility", module: "/stale/plugin.mjs" }],
    profile: { profiles: [] },
  }, { configDir: "/tmp/airkit-stale-compatibility" });

  assert.deepEqual(merged.config.plugins, [unrelated]);
});

test("CCR compatibility preserves the managed opus route selector", () => {
  const catalog = compatibilityCatalog();
  catalog.profiles[0].ccr.Providers.push(
    {
      name: "oneportal-anthropic",
      type: "anthropic_messages",
      api_base_url: "https://oneportal.example.invalid/v1/messages",
      api_key: "$DEMO_API_KEY",
      models: ["claude-sonnet-5"],
    },
    {
      name: "web-litellm-anthropic",
      type: "anthropic_messages",
      api_base_url: "https://litellm.example.invalid/v1/messages",
      api_key: "$DEMO_API_KEY",
      models: ["claude-opus-5"],
    },
  );
  catalog.profiles[0].ccr.Router = {
    default: "oneportal-anthropic,claude-sonnet-5",
    background: "oneportal-anthropic,claude-sonnet-5",
    opus: "web-litellm-anthropic,claude-opus-5",
  };

  const merged = airkitRuntime.buildCcr3ManagedConfig(catalog, "launch-example", {}, {
    configDir: "/tmp/airkit-compatibility-opus",
  });
  const compatibility = merged.compatibility;

  assert.deepEqual(compatibility.routes, {
    default: "airkit-provider-launch-example-oneportal-anthropic/claude-sonnet-5",
    background: "airkit-provider-launch-example-oneportal-anthropic/claude-sonnet-5",
    opus: "airkit-provider-launch-example-web-litellm-anthropic/claude-opus-5",
  });
});

test("CCR compatibility binds every family fallback to its managed provider", () => {
  const catalog = compatibilityCatalog();
  catalog.profiles[0].ccr.Providers.push({
    name: "advisor-anthropic",
    type: "anthropic_messages",
    api_base_url: "https://advisor.example.invalid/v1/messages",
    api_key: "$DEMO_API_KEY",
    models: ["claude-opus-5"],
  });
  catalog.profiles[0].ccr.plugins[0].config.advisor = {
    mode: "anthropic-fallback",
    fallback: {
      provider: "advisor-anthropic",
      model: "claude-opus-5",
    },
  };

  const merged = airkitRuntime.buildCcr3ManagedConfig(catalog, "launch-example", {}, {
    configDir: "/tmp/airkit-family-fallback",
  });
  const compatibility = merged.compatibility;

  assert.equal(
    compatibility.advisor.fallback.provider,
    "airkit-provider-launch-example-advisor-anthropic",
  );
  assert.doesNotThrow(() => validateCompatibilityProviderBinding(
    compatibility,
    merged.config.Providers,
  ));
});

test("a non-lowercase catalog mode renders one canonical label everywhere", () => {
  const catalog = compatibilityCatalog();
  const modes = catalog.profiles[0].launch.modes;
  modes.GLM = { ccr: { Router: { default: "demo,strong-coder" } } };
  delete modes.pro;

  const merged = airkitRuntime.buildCcr3ManagedConfig(catalog, "launch-example", {}, {
    configDir: "/tmp/airkit-canonical-mode",
  });

  const compatibility = merged.compatibility;
  assert.equal(Object.hasOwn(compatibility.modeRoutes, "glm"), true, "table key is normalized");
  assert.equal(Object.hasOwn(compatibility.modeRoutes, "GLM"), false);
  const profile = merged.config.profile.profiles.find((candidate) => candidate.id.endsWith("-glm"));
  assert.equal(
    profile.env.ANTHROPIC_CUSTOM_HEADERS,
    "x-airkit-mode: glm",
    "the stamped header uses the same normalized label as the table key",
  );
});

test("a catalog mode that cannot round-trip through the header is rejected", () => {
  const catalog = compatibilityCatalog();
  // A literal assignment would hit the prototype setter and silently create
  // nothing — exactly the hazard under test — so define the own key the way
  // JSON.parse would.
  Object.defineProperty(catalog.profiles[0].launch.modes, "__proto__", {
    configurable: true,
    enumerable: true,
    value: { ccr: { Router: { default: "demo,strong-coder" } } },
    writable: true,
  });

  assert.throws(
    () => airkitRuntime.buildCcr3ManagedConfig(catalog, "launch-example", {}),
    /launch mode cannot be labeled through x-airkit-mode: __proto__/,
  );
});

test("CCR compatibility rejects removed Advisor model fields before CCR RPC or credentials", async () => {
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
    /advisor\.(?:model|fallbackModel).*removed/i,
  );
  assert.equal(ccrClientCreations, 0);
  assert.equal(credentialCalls, 0);
});

test("CCR compatibility rejects provider linkage before CCR RPC or credentials", async () => {
  const catalog = compatibilityCatalog();
  catalog.profiles[0].ccr.Providers[1].type = "openai_chat_completions";
  catalog.profiles[0].shell = { ccrTokenOpRef: "op://Test/API/token" };
  let ccrClientCreations = 0;
  let credentialCalls = 0;

  await assert.rejects(
    () => prepareLaunch(catalog, "launch-example", {
      configDir: "/tmp/airkit-compatibility-linkage",
      createCcrClient: () => {
        ccrClientCreations += 1;
        return {};
      },
      runCommand: async () => {
        credentialCalls += 1;
        return { ok: true, status: 0, stdout: "unused" };
      },
    }),
    /fallback provider must use anthropic_messages/,
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
    /must not set apiKeyHelper; it overrides the AirKit gateway token/,
  );
});

test("CCR 3 launch rejects passthrough args that set an apiKeyHelper", () => {
  assert.throws(
    () => buildLaunchPlan(launchCatalog(), "launch-example", {
      mode: "auto",
      userArgs: ["--settings", "{\"apiKeyHelper\":\"/tmp/foreign-helper.sh\"}"],
    }),
    /must not set apiKeyHelper; it overrides the AirKit gateway token/,
  );
});

test("CCR 3 launch rejects profile and passthrough args that replace the default system prompt", () => {
  for (const args of [
    ["--system-prompt", "replacement"],
    ["--system-prompt=replacement"],
    ["--system-prompt-file", "/tmp/replacement.md"],
    ["--system-prompt-file=/tmp/replacement.md"],
  ]) {
    const catalog = launchCatalog();
    catalog.profiles[0].launch.args = args;
    assert.throws(
      () => buildLaunchPlan(catalog, "launch-example", { mode: "auto" }),
      /must not replace Claude Code's default system prompt/,
    );
    assert.throws(
      () => buildLaunchPlan(launchCatalog(), "launch-example", { mode: "auto", userArgs: args }),
      /must not replace Claude Code's default system prompt/,
    );
  }
});

test("CCR 3 launch rejects a profile env that redirects the Claude home", () => {
  for (const key of ["CLAUDE_CONFIG_DIR", "HOME"]) {
    const catalog = launchCatalog();
    catalog.profiles[0].launch.env[key] = "/tmp/airkit-split-home";
    assert.throws(
      () => buildLaunchPlan(catalog, "launch-example", { mode: "auto" }),
      new RegExp(`launch\\.env must not set ${key}`),
      key,
    );
  }
});

test("the mode header joins inherited custom headers and replaces a stale mode label", () => {
  const plan = buildLaunchPlan(launchCatalog(), "launch-example", {
    mode: "pro",
    env: { ANTHROPIC_CUSTOM_HEADERS: "x-tenant: tenant-a\nX-AirKit-Mode: glm" },
  });

  assert.equal(
    plan.launch.env.ANTHROPIC_CUSTOM_HEADERS,
    "x-tenant: tenant-a\nx-airkit-mode: pro",
    "inherited headers survive; only a stale outer mode label is replaced",
  );
});

test("plain Claude launch uses managed CCR without AirClaude argument overlays", () => {
  const catalog = launchCatalog();
  catalog.profiles[0].launch.modes.plain = {};
  catalog.profiles[0].launch.context = {
    autoCompactPercentage: 25,
    autoCompactWindow: 240000,
  };

  const plan = buildLaunchPlan(catalog, "launch-example", {
    mode: "plain",
    plainClaude: true,
    userArgs: ["--model", "opus", "-p", "hi"],
  });

  assert.equal(plan.mode, "plain");
  assert.deepEqual(plan.launch.args, []);
  assert.deepEqual(plan.launch.userArgs, ["--model", "opus", "-p", "hi"]);
  assert.equal(plan.launch.env.ANTHROPIC_CUSTOM_HEADERS, "x-airkit-mode: plain");
  assert.equal(plan.launch.env.CLAUDE_CONFIG_DIR, undefined);
  assert.equal(plan.launch.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, undefined);
  assert.equal(plan.launch.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE, undefined);
  assert.equal(plan.launch.env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY, "1");
  for (const arg of ["--permission-mode", "--append-system-prompt", "--model", "--plugin-dir"]) {
    assert.equal(plan.launch.args.includes(arg), false, `${arg} must not be added to a plain launch`);
  }
});

test("mode-specific append prompt applies only to its selected managed mode", () => {
  const catalog = launchCatalog();
  catalog.profiles[0].launch.modes.auto.appendSystemPrompt = "DeepSeek-only evidence delta";

  const auto = buildLaunchPlan(catalog, "launch-example", {
    configDir: "/tmp/airkit-mode-prompt",
    mode: "auto",
  });
  const pro = buildLaunchPlan(catalog, "launch-example", {
    configDir: "/tmp/airkit-mode-prompt",
    mode: "pro",
  });
  const plain = buildLaunchPlan(catalog, "launch-example", {
    configDir: "/tmp/airkit-mode-prompt",
    mode: "auto",
    plainClaude: true,
  });

  const autoPrompt = auto.launch.args[auto.launch.args.indexOf("--append-system-prompt") + 1];
  assert.match(autoPrompt, /DeepSeek-only evidence delta/);
  assert.doesNotMatch(pro.launch.args.join(" "), /DeepSeek-only evidence delta/);
  assert.equal(plain.launch.args.includes("--append-system-prompt"), false);
});

test("launch spawns Claude against the shared home, not an isolated CCR profile", async () => {
  const home = await mkdtemp(join(tmpdir(), "airkit-shared-home-"));
  const configDir = await mkdtemp(join(tmpdir(), "airkit-shared-config-"));
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
        getConfig: async () => ({
          HOST: "127.0.0.1",
          PORT: 3456,
          Providers: [],
          Router: {},
          profile: { profiles: [] },
        }),
        getVersion: async () => "3.0.18",
        saveConfig: async () => {},
      },
      commandExists: async () => true,
      configDir,
      env: {
        ANTHROPIC_API_KEY: "stale-key",
        ANTHROPIC_MODEL: "stale-model",
        CCR_CLAUDE_CODE_MODEL: "stale-ccr-model",
        CLAUDE_CODE_USE_BEDROCK: "1",
        DEMO_API_KEY: "runtime-secret",
        HOME: home,
      },
      inspectCodexTakeoverFiles: async () => ({ inspection: { hazards: [] } }),
      runCommand: async () => ({ ok: true, status: 0, stdout: "gateway-key-from-helper" }),
      runtimeVersions: passingRuntimeVersions(),
      spawnCommand: (command, args, options) => {
        calls.push({ command, args, env: options.env });
        return { status: 0 };
      },
    });

    const [spawned] = calls;
    assert.equal(spawned.command, "claude");
    assert.equal(spawned.args.includes("--settings"), false, "statusline is inherited natively now");
    assert.equal(
      Object.hasOwn(spawned.env, "CLAUDE_CONFIG_DIR"),
      false,
      "the shared ~/.claude must be inherited, never redirected",
    );
    assert.equal(spawned.env.ANTHROPIC_BASE_URL, "http://127.0.0.1:3456");
    assert.equal(spawned.env.ANTHROPIC_API_BASE_URL, "http://127.0.0.1:3456");
    assert.equal(Object.hasOwn(spawned.env, "CLAUDE_AGENT_API_BASE_URL"), false);
    assert.equal(spawned.env.ANTHROPIC_AUTH_TOKEN, "gateway-key-from-helper");
    assert.equal(spawned.env.ANTHROPIC_CUSTOM_HEADERS, "x-airkit-mode: auto");
    assert.equal(
      spawned.env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY,
      "1",
      "direct launch must carry the discovery opt-in the CCR profile env used to inject",
    );
    for (const key of ["ANTHROPIC_API_KEY", "ANTHROPIC_MODEL", "CCR_CLAUDE_CODE_MODEL", "CLAUDE_CODE_USE_BEDROCK"]) {
      assert.equal(Object.hasOwn(spawned.env, key), false, `${key} must not reach the child`);
    }
    assert.equal(
      Object.hasOwn(spawned.env, "DEMO_API_KEY"),
      false,
      "upstream provider credential placeholders are cleared from the child, so Bash tools cannot inherit them",
    );
    assert.equal(
      [...spawned.args, JSON.stringify(calls.map(({ command, args }) => ({ command, args })))]
        .join(" ")
        .includes("gateway-key-from-helper"),
      false,
      "the gateway key never appears in argv",
    );
  } finally {
    await rm(home, { force: true, recursive: true });
    await rm(configDir, { force: true, recursive: true });
  }
});

test("a profile-pinned gateway address survives to the spawned child", async () => {
  const home = await mkdtemp(join(tmpdir(), "airkit-pinned-home-"));
  const configDir = await mkdtemp(join(tmpdir(), "airkit-pinned-config-"));
  const catalog = launchCatalog();
  catalog.profiles[0].ccr.HOST = "127.0.0.1";
  catalog.profiles[0].ccr.PORT = 9314;
  const calls = [];

  try {
    const result = await prepareLaunch(catalog, "launch-example", {
      ccrClient: {
        ensureGateway: async () => {},
        getConfig: async () => ({
          HOST: "127.0.0.1",
          PORT: 3456,
          Providers: [],
          Router: {},
          profile: { profiles: [] },
        }),
        getVersion: async () => "3.0.18",
        saveConfig: async () => {},
      },
      commandExists: async () => true,
      configDir,
      env: { DEMO_API_KEY: "runtime-secret", HOME: home },
      runCommand: async () => ({ ok: true, status: 0, stdout: "gateway-key-from-helper" }),
      runtimeVersions: passingRuntimeVersions(),
      spawnCommand: (command, args, options) => {
        calls.push({ command, args, env: options.env });
        return { status: 0 };
      },
    });

    assert.equal(result.launch.gatewayPinned, true);
    // The live CCR config says 3456, but the profile pinned 9314: the child
    // must receive what the plan (and any dry run) reported.
    assert.equal(calls[0].env.ANTHROPIC_BASE_URL, "http://127.0.0.1:9314");
    assert.equal(calls[0].env.ANTHROPIC_API_BASE_URL, "http://127.0.0.1:9314");
    assert.equal(Object.hasOwn(calls[0].env, "CLAUDE_AGENT_API_BASE_URL"), false);
  } finally {
    await rm(home, { force: true, recursive: true });
    await rm(configDir, { force: true, recursive: true });
  }
});

test("launch refuses when the inherited Claude home sets an apiKeyHelper", async () => {
  const home = await mkdtemp(join(tmpdir(), "airkit-helper-home-"));
  const configDir = await mkdtemp(join(tmpdir(), "airkit-helper-config-"));
  const spawned = [];
  await mkdir(join(home, ".claude"), { recursive: true });
  await writeFile(
    join(home, ".claude", "settings.json"),
    JSON.stringify({ apiKeyHelper: "/tmp/foreign-helper.sh" }),
  );

  try {
    await assert.rejects(
      () => prepareLaunch(launchCatalog(), "launch-example", {
        ccrClient: {
          ensureGateway: async () => {},
          getConfig: async () => ({
            HOST: "127.0.0.1",
            PORT: 3456,
            Providers: [],
            Router: {},
            profile: { profiles: [] },
          }),
          getVersion: async () => "3.0.18",
          saveConfig: async () => {},
        },
        commandExists: async () => true,
        configDir,
        env: { DEMO_API_KEY: "runtime-secret", HOME: home },
        runCommand: async () => ({ ok: true, status: 0, stdout: "gateway-key-from-helper" }),
        runtimeVersions: passingRuntimeVersions(),
        spawnCommand: (command, args, options) => {
          spawned.push({ command, args, env: options.env });
          return { status: 0 };
        },
      }),
      /settings\.json sets apiKeyHelper, which overrides the AirKit gateway token/,
    );
    assert.deepEqual(spawned, [], "the child is never spawned under a foreign apiKeyHelper");
  } finally {
    await rm(home, { force: true, recursive: true });
    await rm(configDir, { force: true, recursive: true });
  }
});

test("a missing gateway key helper triggers one profile apply and a retry", async () => {
  const home = await mkdtemp(join(tmpdir(), "airkit-mint-home-"));
  const configDir = await mkdtemp(join(tmpdir(), "airkit-mint-config-"));
  const events = [];
  const tokens = [];
  let helperReady = false;

  try {
    await prepareLaunch(launchCatalog(), "launch-example", {
      ccrClient: {
        // A save with applyProfile:false never mints the per-profile key
        // helper, so the first launch in a fresh CCR home finds none.
        applyProfile: async () => {
          events.push("applyProfile");
          helperReady = true;
        },
        ensureGateway: async () => {},
        getConfig: async () => ({
          HOST: "127.0.0.1",
          PORT: 3456,
          Providers: [],
          Router: {},
          profile: { profiles: [] },
        }),
        getVersion: async () => "3.0.18",
        saveConfig: async () => {},
      },
      commandExists: async () => true,
      configDir,
      env: { DEMO_API_KEY: "runtime-secret", HOME: home },
      runCommand: async () => (helperReady
        ? { ok: true, status: 0, stdout: "minted-gateway-key" }
        : { ok: false, status: 127, stdout: "" }),
      runtimeVersions: passingRuntimeVersions(),
      spawnCommand: (command, args, options) => {
        tokens.push(options.env.ANTHROPIC_AUTH_TOKEN);
        return { status: 0 };
      },
    });

    assert.deepEqual(events, ["applyProfile"], "exactly one apply pass mints the helper");
    assert.deepEqual(tokens, ["minted-gateway-key"]);
  } finally {
    await rm(home, { force: true, recursive: true });
    await rm(configDir, { force: true, recursive: true });
  }
});

test("a gateway key helper that still fails after the apply pass blocks the launch", async () => {
  const home = await mkdtemp(join(tmpdir(), "airkit-mint-fail-home-"));
  const configDir = await mkdtemp(join(tmpdir(), "airkit-mint-fail-config-"));
  const events = [];
  const spawned = [];

  try {
    await assert.rejects(
      () => prepareLaunch(launchCatalog(), "launch-example", {
        ccrClient: {
          applyProfile: async () => events.push("applyProfile"),
          ensureGateway: async () => {},
          getConfig: async () => ({
            HOST: "127.0.0.1",
            PORT: 3456,
            Providers: [],
            Router: {},
            profile: { profiles: [] },
          }),
          getVersion: async () => "3.0.18",
          saveConfig: async () => {},
        },
        commandExists: async () => true,
        configDir,
        env: { DEMO_API_KEY: "runtime-secret", HOME: home },
        runCommand: async () => ({ ok: false, status: 127, stdout: "" }),
        runtimeVersions: passingRuntimeVersions(),
        spawnCommand: (command, args, options) => {
          spawned.push({ command, args });
          return { status: 0 };
        },
      }),
      /restart the CCR gateway daemon so it re-applies its managed profiles/,
    );
    assert.deepEqual(events, ["applyProfile"], "the apply pass runs once, not in a loop");
    assert.deepEqual(spawned, [], "no child is spawned without a gateway key");
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
    getVersion: async () => "3.0.18",
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
      runtimeVersions: { claudeCode: "2.1.208", claudeCodeRouter: "3.0.18", node: "24.11.1" },
    });

    assert.equal(result.launch.command, "claude");
    assert.equal(result.launch.managedProfileId, "airkit-launch-example-pro");
    assert.equal(result.launch.args.includes("cli"), false, "CCR no longer wraps the launch");
    assert.match(
      result.launch.gatewayTokenCommand,
      /bin\/ccr-claude-code-api-key-airkit-launch-example-pro$/,
    );
    assert.ok(calls.some((call) => call.command === "saveConfig"));
    assert.ok(!calls.some((call) => ["restart", "activate"].includes(call.args?.[0])));
  } finally {
    await rm(configDir, { force: true, recursive: true });
  }
});

test("runtime check reports installed versions against the hard-cut requirements", async () => {
  const output = [];
  const exitCode = await runCli(["runtime", "check"], {
    runtimeVersions: { claudeCode: "2.1.208", claudeCodeRouter: "3.0.18", node: "24.11.1" },
    stdout: { write: (chunk) => output.push(chunk) },
  });

  assert.equal(exitCode, 0);
  assert.match(output.join(""), /Node\.js\s+24\.11\.1\s+required >=22\s+ok/);
  assert.match(output.join(""), /Claude Code\s+2\.1\.208\s+required >=2\.1\.208\s+ok/);
  assert.match(output.join(""), /Claude Code Router\s+3\.0\.18\s+required >=3\.0\.18 <4\s+ok/);
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
  assert.match(output.join(""), /@musistudio\/claude-code-router@3\.0\.18/);
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
        return { profileResolved: true, version: "3.0.18" };
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
        "@musistudio/claude-code-router@3.0.18",
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
  assert.match(prompt, /Advisor capability/);
  assert.match(prompt, /找 Advisor/);
  assert.match(prompt, /advisor_tool_result/);
  assert.match(prompt, /never claim Advisor was consulted without a returned result/i);
  assert.match(prompt, /AirClaude active routing/);
  assert.match(prompt, /mode: auto/);
  assert.match(prompt, /default: openai-compatible,steady-coder \(model steady-coder\)/);
  assert.match(prompt, /background: openai-compatible,fast-coder \(model fast-coder\)/);
  assert.doesNotMatch(prompt, /- think:|- longContext:|- webSearch:/);
  assert.match(prompt, /Claude launch\/display model is the launcher's own id, not a served model/);
  // The example profile routes every Claude family to `default`, so there is no
  // in-session pick to describe and the extra line stays out.
  assert.doesNotMatch(prompt, /Picking a Claude model in session/);
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

test("plainClaude renders a nonrecursive raw Claude delegate", () => {
  const catalog = launchCatalog();
  catalog.profiles[0].shell = { plainClaude: true };

  const snippet = buildShellSnippet(catalog, "launch-example", {
    configDir: "/tmp/airkit-test",
  });

  assert.match(
    snippet,
    /claude\(\) \{\n  command airclaude --plain --profile 'launch-example' -- "\$@"\n\}/,
  );
  assert.doesNotMatch(snippet, /ANTHROPIC_AUTH_TOKEN_OP_REF|api-key-helper/);
});

test("plainClaude requires a CCR-backed launch and a boolean value", async () => {
  const catalog = launchCatalog();
  const nonCcrProfile = {
    ...catalog.profiles[0],
    ccr: undefined,
    name: "non-ccr",
    shell: { plainClaude: true },
  };
  const noLaunchProfile = {
    ...catalog.profiles[0],
    launch: undefined,
    name: "no-launch",
    shell: { plainClaude: true },
  };

  assert.throws(
    () => buildShellSnippet({ profiles: [nonCcrProfile] }, "non-ccr"),
    /shell\.plainClaude requires CCR/,
  );
  assert.throws(
    () => buildShellSnippet({ profiles: [noLaunchProfile] }, "no-launch"),
    /shell\.plainClaude requires CCR/,
  );

  const root = await mkdtemp(join(tmpdir(), "airkit-invalid-plain-claude-"));
  try {
    for (const [index, plainClaude] of ["true", 1, null].entries()) {
      const invalidCatalog = launchCatalog();
      invalidCatalog.profiles[0].shell = { plainClaude };
      const catalogPath = join(root, `${index}.json`);
      await writeFile(catalogPath, `${JSON.stringify(invalidCatalog)}\n`);
      await assert.rejects(loadCatalog(catalogPath), /shell\.plainClaude must be a boolean/);
    }
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("plainClaude rejects a wrapper that would shadow its Claude delegate", () => {
  const catalog = launchCatalog();
  catalog.profiles[0].shell = {
    plainClaude: true,
    wrappers: [{ command: "airclaude", name: "claude" }],
  };

  assert.throws(
    () => buildShellSnippet(catalog, "launch-example"),
    /shell\.plainClaude cannot be combined with shell\.wrappers named "claude"/,
  );
});

test("plainClaude requires a usable CCR launch contract", () => {
  const catalog = launchCatalog();
  const validProfile = catalog.profiles[0];
  const invalidContracts = [
    { ccr: {}, launch: {} },
    { ccr: validProfile.ccr, launch: { ...validProfile.launch, binary: "" } },
    { ccr: { Providers: [], Router: {} }, launch: validProfile.launch },
  ];

  for (const [index, contract] of invalidContracts.entries()) {
    const profile = {
      ...validProfile,
      ...contract,
      name: `invalid-plain-contract-${index}`,
      shell: { plainClaude: true },
    };

    assert.throws(
      () => buildShellSnippet({ profiles: [profile] }, profile.name),
      /shell\.plainClaude requires a usable CCR launch contract/,
    );
  }
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

test("shell exports render before wrapper functions with value and command forms", () => {
  const catalog = {
    schema: 1,
    profiles: [
      {
        name: "exports-example",
        visibility: "public",
        summary: "Profile with shell exports.",
        ccr: { Providers: [], Router: {} },
        shell: {
          exports: [
            { name: "ANTHROPIC_BASE_URL", value: "http://127.0.0.1:3456" },
            { name: "AIRKIT_NOTE", value: "it's a 'quoted' value" },
            { name: "AIRKIT_HOME_MARK", value: "{{home}}/mark" },
            { name: "ANTHROPIC_API_KEY", command: "{{home}}/.claude-code-router/bin/helper" },
          ],
          wrappers: [{ name: "cc", command: "airclaude" }],
        },
      },
    ],
  };

  const snippet = buildShellSnippet(catalog, "exports-example", { configDir: "/tmp/airkit-test" });

  assert.equal(
    snippet,
    [
      "# Generated by airkit for profile: exports-example",
      "# Profile with shell exports.",
      "# Global routing exports (replaces CCR global agent profile)",
      "export ANTHROPIC_BASE_URL='http://127.0.0.1:3456'",
      "export AIRKIT_NOTE='it'\\''s a '\\''quoted'\\'' value'",
      `export AIRKIT_HOME_MARK='${homedir()}/mark'`,
      `if [[ -x '${homedir()}/.claude-code-router/bin/helper' ]]; then`,
      `  export ANTHROPIC_API_KEY="$('${homedir()}/.claude-code-router/bin/helper')"`,
      "else",
      `  print -u2 'airkit: credential helper for ANTHROPIC_API_KEY missing (${homedir()}/.claude-code-router/bin/helper); export skipped'`,
      "fi",
      "cc() {",
      "  command airclaude --profile 'exports-example' --mode 'auto' -- \"$@\"",
      "}",
      "",
    ].join("\n"),
  );
});

test("catalog rejects invalid shell exports", async () => {
  const root = await mkdtemp(join(tmpdir(), "airkit-invalid-shell-exports-"));
  const catalog = launchCatalog();
  const cases = [
    [[{ name: "GOOD_NAME", value: "a", command: "b" }], /must set exactly one of value or command/],
    [[{ name: "GOOD_NAME" }], /must set exactly one of value or command/],
    [[{ name: "bad_name", value: "a" }], /invalid name/],
    [[{ name: "1BAD", value: "a" }], /invalid name/],
    [[{ value: "a" }], /invalid name/],
    [[{ name: "GOOD_NAME", value: 7 }], /value must be a string/],
    [[{ name: "GOOD_NAME", command: ["x"] }], /command must be a string/],
    [["not-an-object"], /shell export must be an object/],
    [{ name: "GOOD_NAME", value: "a" }, /shell\.exports must be an array/],
  ];

  try {
    for (const [index, [exports, expected]] of cases.entries()) {
      catalog.profiles[0].shell = { exports };
      const catalogPath = join(root, `${index}.json`);
      await writeFile(catalogPath, `${JSON.stringify(catalog)}\n`);
      await assert.rejects(loadCatalog(catalogPath), expected);
    }
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("profile without shell exports renders a byte-identical snippet", () => {
  const catalog = {
    schema: 1,
    profiles: [
      {
        name: "compat-check",
        visibility: "public",
        summary: "Snapshot profile.",
        ccr: { Providers: [], Router: {} },
        shell: { wrappers: [{ name: "cc", command: "airclaude", env: { CCR_PROFILE: "compat-check" } }] },
      },
    ],
  };

  const snippet = buildShellSnippet(catalog, "compat-check", { configDir: "/tmp/airkit-test" });

  assert.equal(
    snippet,
    "# Generated by airkit for profile: compat-check\n# Snapshot profile.\ncc() {\n  local -x CCR_PROFILE='compat-check'\n  command airclaude --profile 'compat-check' --mode 'auto' -- \"$@\"\n}\n",
  );
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
      ccrClient: { getConfig: async () => ({}) },
      commandExists: async (command) => command !== "ccr",
      configDir,
      sourceShellSnippet: async () => ({ ok: true }),
    });

    assert.equal(result.ok, false);
    assert.equal(result.runtime.managedState.count, 0, "an empty live config has nothing orphaned");
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

test("doctorProfile warns and names CCR state owned by no installed profile", async () => {
  const catalog = await loadCatalog();
  const configDir = await mkdtemp(join(tmpdir(), "airkit-oss-doctor-orphans-"));

  try {
    await installProfile(catalog, profile, { configDir, write: true });

    const live = {
      Providers: [{ id: "airkit-provider-gone-example-demo" }, { id: "unrelated-provider" }],
      Router: { rules: [{ id: "airkit-gone-example-route-default" }, { id: "unrelated-rule" }] },
      profile: { profiles: [{ id: "airkit-gone-example-auto" }, { id: "unrelated-profile" }] },
    };

    const result = await doctorProfile(catalog, profile, {
      ccrClient: { getConfig: async () => live },
      commandExists: async () => true,
      configDir,
      sourceShellSnippet: async () => ({ ok: true }),
    });

    const managedState = result.runtime.managedState;
    assert.deepEqual(managedState.orphans, {
      profiles: ["airkit-gone-example-auto"],
      providers: ["airkit-provider-gone-example-demo"],
      rules: ["airkit-gone-example-route-default"],
    });
    assert.equal(managedState.count, 3);
    assert.equal(managedState.warn, true, "leftovers are surfaced, not silent");
    assert.match(managedState.reason, /airkit-gone-example-route-default/);
    assert.match(managedState.reason, /airkit-provider-gone-example-demo/);
    assert.match(managedState.reason, /airkit-gone-example-auto/);
    assert.ok(
      !managedState.reason.includes("unrelated-"),
      "foreign CCR artifacts are never reported as AirKit's to remove",
    );

    // Another profile's residue must not fail the profile being diagnosed: the
    // installation contract reads a nonzero doctor exit as blocked, and a launch
    // clears this on its own.
    assert.equal(result.ok, true, "an unrelated profile's leftovers do not block this profile");
    assert.deepEqual(result.failures, []);
  } finally {
    await rm(configDir, { force: true, recursive: true });
  }
});

test("doctor reports a stopped management service as missing information, not a failure", async () => {
  const catalog = await loadCatalog();
  const configDir = await mkdtemp(join(tmpdir(), "airkit-oss-doctor-nostate-"));

  try {
    await installProfile(catalog, profile, { configDir, write: true });

    const result = await doctorProfile(catalog, profile, {
      ccrClient: { getConfig: async () => { throw new Error("CCR 3 management service is not running"); } },
      commandExists: async () => true,
      configDir,
      sourceShellSnippet: async () => ({ ok: true }),
    });

    assert.equal(result.runtime.managedState.skipped, true);
    assert.equal(result.runtime.managedState.ok, true, "doctor never turns an unreadable source into a verdict");
    assert.ok(!result.failures.some((reason) => reason?.includes("owned by no installed profile")));
  } finally {
    await rm(configDir, { force: true, recursive: true });
  }
});

// The plugin host resolves each module once per process, so a module newer than
// that process cannot be the one running. These lock in the signal, because the
// symptom it replaces is a plugin that fails identically after every restart.
async function pluginFreshnessDoctor(pluginDir, overrides = {}) {
  const catalog = await loadCatalog();
  const configDir = await mkdtemp(join(tmpdir(), "airkit-oss-doctor-freshness-"));
  try {
    await installProfile(catalog, profile, { configDir, write: true });
    const result = await doctorProfile(catalog, profile, {
      ccrClient: {
        getConfig: async () => ({
          plugins: pluginDir ? [{ id: "airkit-compatibility", module: join(pluginDir, "plugin.mjs") }] : [],
        }),
      },
      commandExists: async () => true,
      configDir,
      // Pin supervision rather than letting the check shell out: whether this
      // particular machine has the launchd job loaded must not decide which
      // remediation the assertions below expect.
      runCommand: async () => ({ ok: false, status: 1, stdout: "", stderr: "" }),
      sourceShellSnippet: async () => ({ ok: true }),
      ...overrides,
    });
    return result;
  } finally {
    await rm(configDir, { force: true, recursive: true });
  }
}

test("doctor warns when a plugin module is newer than the process that loaded it", async () => {
  const pluginDir = await mkdtemp(join(tmpdir(), "airkit-oss-plugin-"));
  try {
    await writeFile(join(pluginDir, "plugin.mjs"), "export default {};\n");

    const result = await pluginFreshnessDoctor(pluginDir, {
      pluginHostStartedAt: new Date("2000-01-01T00:00:00Z"),
    });

    const check = result.runtime.pluginFreshness;
    assert.equal(check.warn, true, "a module the host cannot have loaded must be surfaced");
    assert.equal(check.stale.length, 1);
    assert.match(check.stale[0], /plugin\.mjs/);
    assert.match(check.reason, /ccr stop && ccr start/, "the fix belongs in the message");
    // Same reasoning as orphaned state: this is not a verdict on the profile.
    assert.equal(result.ok, true);
    assert.deepEqual(result.failures, []);
  } finally {
    await rm(pluginDir, { force: true, recursive: true });
  }
});

test("doctor warns when a second CCR management service is running", async () => {
  const pluginDir = await mkdtemp(join(tmpdir(), "airkit-oss-plugin-duplicate-"));
  try {
    await writeFile(join(pluginDir, "plugin.mjs"), "export default {};\n");

    const result = await pluginFreshnessDoctor(pluginDir, {
      pluginHostStartedAt: new Date("2000-01-01T00:00:00Z"),
      runCommand: async (command, args) => {
        if (command === "pgrep") return { ok: true, status: 0, stderr: "", stdout: "4711\n4712\n" };
        if (command === "launchctl" && args[0] === "print") return { ok: true, status: 0, stderr: "", stdout: "" };
        if (command === "launchctl" && args[0] === "list") {
          return { ok: true, status: 0, stderr: "", stdout: "4712\t0\tcom.airkit.ccr-daemon\n" };
        }
        return { ok: false, status: 1, stderr: "", stdout: "" };
      },
    });

    const check = result.runtime.managementServices;
    assert.equal(check.warn, true);
    assert.deepEqual(check.pids, ["4711", "4712"]);
    assert.equal(check.supervisedPid, "4712", "the user needs to know which one survives a restart");
    assert.match(check.reason, /launchctl kickstart -k/);
    assert.match(check.reason, /every pid other than 4712/);
    // Two services say something is wrong with the machine, not with the profile.
    assert.equal(result.ok, true);
    assert.deepEqual(result.failures, []);
  } finally {
    await rm(pluginDir, { force: true, recursive: true });
  }
});

test("a single management service is reported without a warning", async () => {
  const pluginDir = await mkdtemp(join(tmpdir(), "airkit-oss-plugin-single-"));
  try {
    await writeFile(join(pluginDir, "plugin.mjs"), "export default {};\n");

    const result = await pluginFreshnessDoctor(pluginDir, {
      pluginHostStartedAt: new Date("2000-01-01T00:00:00Z"),
      runCommand: async (command) =>
        command === "pgrep"
          ? { ok: true, status: 0, stderr: "", stdout: "4711\n" }
          : { ok: false, status: 1, stderr: "", stdout: "" },
    });

    assert.equal(result.runtime.managementServices.warn, undefined);
    assert.deepEqual(result.runtime.managementServices.pids, ["4711"]);
  } finally {
    await rm(pluginDir, { force: true, recursive: true });
  }
});

test("the stale-plugin remedy names the supervisor when launchd owns the daemon", async () => {
  const pluginDir = await mkdtemp(join(tmpdir(), "airkit-oss-plugin-supervised-"));
  try {
    await writeFile(join(pluginDir, "plugin.mjs"), "export default {};\n");

    const result = await pluginFreshnessDoctor(pluginDir, {
      pluginHostStartedAt: new Date("2000-01-01T00:00:00Z"),
      runCommand: async (command, args) => ({
        ok: command === "launchctl" && args[0] === "print",
        status: 0,
        stderr: "",
        stdout: "",
      }),
    });

    const check = result.runtime.pluginFreshness;
    assert.equal(check.supervisor, `gui/${process.getuid()}/com.airkit.ccr-daemon`);
    assert.match(check.reason, /launchctl kickstart -k gui\/\d+\/com\.airkit\.ccr-daemon/);
    // Telling a supervised user to stop the daemon sends them to the command
    // that produces the duplicate service this check is meant to keep them out of.
    assert.doesNotMatch(check.reason, /ccr stop/);
  } finally {
    await rm(pluginDir, { force: true, recursive: true });
  }
});

test("a stale sibling import is caught, not only the entry module", async () => {
  // This is the case that actually happened: plugin.mjs was untouched and a
  // sibling it imports had moved, so checking the entry's mtime alone would have
  // reported everything fresh while the plugin failed on every restart.
  const pluginDir = await mkdtemp(join(tmpdir(), "airkit-oss-plugin-sibling-"));
  try {
    const entry = join(pluginDir, "plugin.mjs");
    await writeFile(entry, "import './config.mjs';\n");
    await writeFile(join(pluginDir, "config.mjs"), "export const ROUTE_KEYS = new Set();\n");
    const ancient = new Date("2001-01-01T00:00:00Z");
    await utimes(entry, ancient, ancient);

    const result = await pluginFreshnessDoctor(pluginDir, {
      pluginHostStartedAt: new Date("2002-01-01T00:00:00Z"),
    });

    const check = result.runtime.pluginFreshness;
    assert.equal(check.warn, true, "the entry is older than the host, but its sibling is not");
    assert.equal(check.stale.length, 1);
  } finally {
    await rm(pluginDir, { force: true, recursive: true });
  }
});

test("a plugin host newer than every module is not reported stale", async () => {
  const pluginDir = await mkdtemp(join(tmpdir(), "airkit-oss-plugin-fresh-"));
  try {
    await writeFile(join(pluginDir, "plugin.mjs"), "export default {};\n");

    const result = await pluginFreshnessDoctor(pluginDir, {
      pluginHostStartedAt: new Date(Date.now() + 60_000),
    });

    const check = result.runtime.pluginFreshness;
    assert.equal(check.warn, undefined);
    assert.deepEqual(check.stale, []);
  } finally {
    await rm(pluginDir, { force: true, recursive: true });
  }
});

test("freshness reports missing information rather than guessing", async () => {
  const noPlugins = await pluginFreshnessDoctor(null, {
    pluginHostStartedAt: new Date("2000-01-01T00:00:00Z"),
  });
  assert.equal(noPlugins.runtime.pluginFreshness.skipped, true);
  assert.match(noPlugins.runtime.pluginFreshness.reason, /no CCR plugins registered/);

  // A host that cannot be located is unknown, never "fresh": claiming fresh here
  // would be the silent failure this check exists to remove.
  const pluginDir = await mkdtemp(join(tmpdir(), "airkit-oss-plugin-nohost-"));
  try {
    await writeFile(join(pluginDir, "plugin.mjs"), "export default {};\n");
    const noHost = await pluginFreshnessDoctor(pluginDir, {
      runCommand: () => ({ ok: false, status: 1, stdout: "", stderr: "" }),
    });
    assert.equal(noHost.runtime.pluginFreshness.skipped, true);
    assert.match(noHost.runtime.pluginFreshness.reason, /not running/);
    assert.equal(noHost.ok, true);
  } finally {
    await rm(pluginDir, { force: true, recursive: true });
  }
});

// Drives the real process lookup instead of injecting pluginHostStartedAt, so
// the pgrep/ps chain itself is covered rather than only the mtime comparison.
function fakeProcessTable({ candidates, cores, starts }) {
  const answer = (stdout) => ({ ok: stdout !== "", status: stdout === "" ? 1 : 0, stderr: "", stdout });
  return async (command, args) => {
    if (command === "pgrep") {
      return answer((args[1].includes("ai-gateway") ? cores : candidates).join("\n"));
    }
    if (command === "ps") {
      const pid = args[3];
      return answer(args[1] === "ppid=" ? String(starts[pid]?.parent ?? "") : (starts[pid]?.lstart ?? ""));
    }
    return answer("");
  };
}

test("the plugin host is attributed to the parent of the gateway core, not a sibling", async () => {
  const pluginDir = await mkdtemp(join(tmpdir(), "airkit-oss-plugin-parentage-"));
  try {
    await writeFile(join(pluginDir, "plugin.mjs"), "export default {};\n");

    // The live shape this was written against: two services match the daemon-child
    // command line and started in the same second, so only the core's ppid tells
    // them apart. The sibling is deliberately the newer of the two.
    const result = await pluginFreshnessDoctor(pluginDir, {
      runCommand: fakeProcessTable({
        candidates: ["96321", "96373"],
        cores: ["96470"],
        starts: {
          96321: { lstart: "Thu Jul 30 11:00:46 2036" },
          96373: { lstart: "Thu Jul 30 11:00:46 2000" },
          96470: { parent: 96373 },
        },
      }),
    });

    const check = result.runtime.pluginFreshness;
    assert.equal(check.warn, true, "the host is the 2000 parent, so a current module is stale");
    assert.match(check.hostStartedAt, /^2000-/, "a sibling's start time must never be used");
  } finally {
    await rm(pluginDir, { force: true, recursive: true });
  }
});

test("a plugin host with no gateway core is still located when the match is unique", async () => {
  const pluginDir = await mkdtemp(join(tmpdir(), "airkit-oss-plugin-nocore-"));
  try {
    await writeFile(join(pluginDir, "plugin.mjs"), "export default {};\n");

    // `--restart-stale` and `ccr start --no-gateway` both leave this state, and it
    // is where a false clean would hurt most: the host is up with plugins loaded.
    const unique = await pluginFreshnessDoctor(pluginDir, {
      runCommand: fakeProcessTable({
        candidates: ["96373"],
        cores: [],
        starts: { 96373: { lstart: "Thu Jul 30 11:00:46 2000" } },
      }),
    });
    assert.equal(unique.runtime.pluginFreshness.warn, true);
    assert.match(unique.runtime.pluginFreshness.hostStartedAt, /^2000-/);

    // Ambiguity is missing information, not absence. Reporting "not running" for a
    // service that is running would be the false clean this check exists to remove.
    const ambiguous = await pluginFreshnessDoctor(pluginDir, {
      runCommand: fakeProcessTable({
        candidates: ["96321", "96373"],
        cores: [],
        starts: {
          96321: { lstart: "Thu Jul 30 11:00:46 2000" },
          96373: { lstart: "Thu Jul 30 11:00:46 2000" },
        },
      }),
    });
    assert.equal(ambiguous.runtime.pluginFreshness.skipped, true);
    assert.match(ambiguous.runtime.pluginFreshness.reason, /cannot tell which of 2/);
    assert.doesNotMatch(ambiguous.runtime.pluginFreshness.reason, /not running/);
  } finally {
    await rm(pluginDir, { force: true, recursive: true });
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
      ccrClient: { getConfig: async () => ({}) },
      commandExists: async () => true,
      configDir,
      sourceShellSnippet: async () => ({ ok: true }),
    });

    assert.deepEqual(result.runtime.compatibility.capabilities, {
      advisor: "stripped",
      codeExecution: "anthropic-fallback",
      mcpConnector: "anthropic-fallback",
      toolSearch: "bridged",
      webFetch: "anthropic-fallback",
      webSearch: "native",
    });
    assert.match(result.runtime.compatibility.notes.join("\n"), /passthrough/);
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
      // Point CCR's state dir at an empty directory so this stays a check of
      // rendered files: the developer's own live CCR state must not decide
      // whether the CLI contract passes.
      { CCR_INTERNAL_HOME_DIR: configDir, PATH: `${fakeBin}:${process.env.PATH ?? ""}` },
      "doctor",
      "--profile",
      profile,
      "--config-dir",
      configDir,
    );

    assert.equal(result.status, 0);
    assert.match(result.stdout, /skip orphaned CCR state: not inspected/);
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
    assert.equal(plan.launch.command, "claude");
    assert.equal(plan.launch.args[0], "--append-system-prompt");
    assert.match(
      plan.launch.args[1],
      /AirClaude mode pro routes default to strong-coder while Claude launch uses claude-sonnet-5\./,
    );
    assert.match(plan.launch.args[1], /AirKit reusable runtime lessons/);
    assert.match(plan.launch.args[1], /AirClaude active routing/);
    assert.match(plan.launch.args[1], /mode: pro/);
    assert.match(plan.launch.args[1], /default: demo,strong-coder \(model strong-coder\)/);
    assert.match(plan.launch.args[1], /background: demo,cheap-coder \(model cheap-coder\)/);
    assert.doesNotMatch(plan.launch.args[1], /- think:|- longContext:|- webSearch:/);
    assert.match(plan.launch.args[1], /Do not infer the active provider route from Claude Code's displayed model name/);
    assert.match(plan.launch.args[1], /\[AIRKIT_TASK_CAPSULE\]/);
    for (const field of [
      "objective",
      "constraints",
      "decisions",
      "changed_files",
      "verification",
      "repository_state",
      "next_action",
    ]) {
      assert.match(plan.launch.args[1], new RegExp(`${field}:`));
    }
    assert.match(plan.launch.args[1], /Never include credentials or provider-private payloads in the capsule/);
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

test("airclaude exposes family routes to statusline side-channel state", () => {
  const catalog = launchCatalog();
  catalog.profiles[0].ccr.Router.opus = "demo,strong-coder";
  catalog.profiles[0].ccr.Router.sonnet = "demo,steady-coder";

  const plan = buildLaunchPlan(catalog, "launch-example", {
    configDir: "/tmp/airkit-statusline-routes",
  });

  assert.equal(plan.launch.env.AIRCLAUDE_ROUTE_OPUS, "demo,strong-coder");
  assert.equal(plan.launch.env.AIRCLAUDE_ROUTE_OPUS_MODEL, "strong-coder");
  assert.equal(plan.launch.env.AIRCLAUDE_ROUTE_SONNET, "demo,steady-coder");
  assert.equal(plan.launch.env.AIRCLAUDE_ROUTE_SONNET_MODEL, "steady-coder");
});

test("airclaude exposes the selected route context window to statusline", () => {
  const plan = buildLaunchPlan(launchCatalog(), "launch-example", {
    configDir: "/tmp/airkit-statusline-context-window",
  });

  assert.equal(plan.launch.env.AIRCLAUDE_STATUSLINE_CONTEXT_WINDOW, "256000");
});

test("airclaude exposes a model-aware statusline price map when the profile owns verified pricing", () => {
  const catalog = launchCatalog();
  catalog.profiles[0].statusline = {
    modelPricingUsdPer1M: {
      "gpt-5.6-luna": { input: 0.2, inputCacheHit: 0.02, output: 1.2 },
      "gpt-5.6-terra": { input: 2, inputCacheHit: 0.2, output: 12 },
    },
  };

  const plan = buildLaunchPlan(catalog, "launch-example", {
    configDir: "/tmp/airkit-statusline-prices",
  });

  assert.deepEqual(JSON.parse(plan.launch.env.AIRCLAUDE_STATUSLINE_PRICE_MAP_JSON), {
    "gpt-5.6-luna": { input: 0.2, inputCacheHit: 0.02, output: 1.2 },
    "gpt-5.6-terra": { input: 2, inputCacheHit: 0.2, output: 12 },
  });
  assert.equal(plan.launch.env.AIRCLAUDE_STATUSLINE_INPUT_PRICE_PER_MILLION, undefined);
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

test("a dedicated launch id frees the sonnet route and keeps full output length", async () => {
  const catalog = compatibilityCatalog();
  const profile = catalog.profiles[0];
  const configDir = await mkdtemp(join(tmpdir(), "airkit-launch-id-"));
  // Claude Code strips `[1m]` before it builds the request, so the catalog can
  // carry the suffix while the plugin must be told the bare id that arrives.
  profile.launch.claudeModel = "claude-airkit-mode[1m]";
  profile.launch.context = { maxOutputTokens: 64000 };
  profile.ccr.Router.sonnet = "anthropic-messages,claude-sonnet";

  try {
    const plan = buildLaunchPlan(catalog, "launch-example", { configDir, env: { HOME: configDir } });
    const merged = airkitRuntime.buildCcr3ManagedConfig(catalog, "launch-example", {}, { configDir });
    const compatibility = merged.compatibility;

    assert.equal(compatibility.launchModel, "claude-airkit-mode", "the `[1m]` marker never reaches the wire");
    assert.doesNotThrow(() => validateCompatibilityConfig(compatibility));
    assert.equal(
      compatibility.routes.sonnet,
      "airkit-provider-launch-example-anthropic-messages/claude-sonnet",
    );
    assert.equal(
      compatibility.modeRoutes.pro.sonnet,
      "airkit-provider-launch-example-anthropic-messages/claude-sonnet",
      "modes inherit the base sonnet route, so one key covers every mode",
    );
    assert.equal(
      compatibility.modeRoutes.fast.sonnet,
      "airkit-provider-launch-example-anthropic-messages/claude-sonnet",
    );
    assert.equal(
      routeBareClaudeModel(
        { model: "claude-airkit-mode", max_tokens: 8, messages: [] },
        compatibility.modeRoutes.pro,
        compatibility.launchModel,
      ).model,
      "airkit-provider-launch-example-demo/strong-coder",
      "the launcher's own traffic is the mode's model",
    );
    assert.equal(
      routeBareClaudeModel(
        { model: "claude-sonnet-5", max_tokens: 8, messages: [] },
        compatibility.modeRoutes.pro,
        compatibility.launchModel,
      ).model,
      "airkit-provider-launch-example-anthropic-messages/claude-sonnet",
      "an in-session Sonnet pick is no longer swallowed by the mode",
    );
    // An id Claude Code does not recognize falls back to 32000 max output; this
    // override is what makes the rename free.
    assert.equal(plan.launch.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS, "64000");

    // The session is told where an in-session pick actually lands, because with
    // a dedicated launch id that pick does change the route.
    const prompt = appendSystemPromptText(plan.launch.args);
    assert.match(prompt, /- sonnet: anthropic-messages,claude-sonnet \(model claude-sonnet\)/);
    assert.match(prompt, /Picking a Claude model in session does change the route/);
    assert.match(prompt, /not a served model: claude-airkit-mode\[1m\]/);
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

test("GPT completion guard continues one Stop after a tool-bearing turn without retaining request content", async () => {
  const pluginData = await mkdtemp(join(tmpdir(), "airkit-completion-guard-"));
  const env = {
    AIRCLAUDE_PROFILE: "example-profile",
    AIRCLAUDE_ROUTE_DEFAULT_MODEL: "gpt-5.6-terra",
    AIRCLAUDE_COMPLETION_GUARD_MAX_STOP_BLOCKS: "1",
    CLAUDE_PLUGIN_DATA: pluginData,
  };
  const sessionId = "private-session-id";

  try {
    assert.equal(await processCompletionGuardHook({
      hook_event_name: "UserPromptSubmit",
      prompt: "private user prompt that must never be stored",
      session_id: sessionId,
      transcript_path: "/private/transcript.jsonl",
    }, env), null);
    assert.equal(await processCompletionGuardHook({
      hook_event_name: "Stop",
      session_id: sessionId,
    }, env), null, "a tool-free turn is never continued");

    assert.equal(await processCompletionGuardHook({
      hook_event_name: "PostToolUse",
      session_id: sessionId,
      tool_input: { secret: "must not persist" },
    }, env), null);
    assert.deepEqual(await processCompletionGuardHook({
      hook_event_name: "Stop",
      session_id: sessionId,
    }, env), {
      hookSpecificOutput: {
        hookEventName: "Stop",
        additionalContext: "Continue working when safe. Finish every requested deliverable, verify each result, and do not stop after partial completion.",
      },
    });
    await processCompletionGuardHook({ hook_event_name: "PostToolUse", session_id: sessionId }, env);
    assert.equal(await processCompletionGuardHook({
      hook_event_name: "Stop",
      session_id: sessionId,
    }, env), null, "a later tool use cannot restore the consumed block");
    assert.equal(await processCompletionGuardHook({
      hook_event_name: "Stop",
      session_id: sessionId,
    }, env), null, "the one allowed block has been consumed");

    await processCompletionGuardHook({ hook_event_name: "UserPromptSubmit", session_id: sessionId }, env);
    await processCompletionGuardHook({ hook_event_name: "PostToolUse", session_id: sessionId }, env);
    assert.equal(await processCompletionGuardHook({
      hook_event_name: "Stop",
      session_id: sessionId,
      stop_hook_active: true,
    }, env), null, "the recursive Stop invocation is ignored");
    assert.deepEqual(await processCompletionGuardHook({
      hook_event_name: "Stop",
      session_id: sessionId,
    }, env), {
      hookSpecificOutput: {
        hookEventName: "Stop",
        additionalContext: "Continue working when safe. Finish every requested deliverable, verify each result, and do not stop after partial completion.",
      },
    });

    const [stateFile] = await readdir(join(pluginData, "completion-guard"));
    const state = await readFile(join(pluginData, "completion-guard", stateFile), "utf8");
    assert.doesNotMatch(state, /private user prompt|private-session-id|private\/transcript|must not persist/);
  } finally {
    await rm(pluginData, { force: true, recursive: true });
  }
});

test("DeepSeek completion guard continues the full deliverable instead of stopping early", async () => {
  const pluginData = await mkdtemp(join(tmpdir(), "airkit-deepseek-completion-guard-"));
  const env = {
    AIRCLAUDE_MODE: "auto",
    AIRCLAUDE_PROFILE: "example-profile",
    AIRCLAUDE_ROUTE_DEFAULT_MODEL: "deepseek-v4-flash",
    AIRCLAUDE_COMPLETION_GUARD_MAX_STOP_BLOCKS: "1",
    CLAUDE_PLUGIN_DATA: pluginData,
  };

  try {
    await processCompletionGuardHook({
      hook_event_name: "PostToolUse",
      session_id: "deepseek-session-id",
    }, env);
    assert.deepEqual(await processCompletionGuardHook({
      hook_event_name: "Stop",
      session_id: "deepseek-session-id",
    }, env), {
      hookSpecificOutput: {
        hookEventName: "Stop",
        additionalContext: "Continue working when safe. Finish every requested deliverable, verify each result, and do not stop after partial completion.",
      },
    });
  } finally {
    await rm(pluginData, { force: true, recursive: true });
  }
});

test("completion guard ignores Claude and unlisted Chinese models after a route switch", async () => {
  const pluginData = await mkdtemp(join(tmpdir(), "airkit-completion-guard-models-"));
  const transcriptPath = join(pluginData, "session.jsonl");
  const env = {
    AIRCLAUDE_MODE: "auto",
    AIRCLAUDE_PROFILE: "example-profile",
    AIRCLAUDE_ROUTE_DEFAULT_MODEL: "deepseek-v4-flash",
    AIRCLAUDE_COMPLETION_GUARD_MAX_STOP_BLOCKS: "1",
    CLAUDE_PLUGIN_DATA: pluginData,
  };
  const writeAssistantModel = async (model) => {
    await writeFile(transcriptPath, `${JSON.stringify({ type: "assistant", message: { model } })}\n`);
  };
  const postToolUse = () => processCompletionGuardHook({
    hook_event_name: "PostToolUse",
    session_id: "model-switch-session",
    transcript_path: transcriptPath,
  }, env);
  const stop = () => processCompletionGuardHook({
    hook_event_name: "Stop",
    session_id: "model-switch-session",
    transcript_path: transcriptPath,
  }, env);

  try {
    await writeAssistantModel("claude-opus-5");
    await postToolUse();
    assert.equal(await stop(), null);

    await writeAssistantModel("gpt-5.6-luna");
    await postToolUse();
    assert.equal((await stop()).hookSpecificOutput.hookEventName, "Stop");

    await writeAssistantModel("Kimi-K3");
    await postToolUse();
    assert.equal(await stop(), null);

    await writeAssistantModel("GLM-5.2");
    await postToolUse();
    assert.equal(await stop(), null);
  } finally {
    await rm(pluginData, { force: true, recursive: true });
  }
});

test("GPT completion guard is inert when disabled", async () => {
  const pluginData = await mkdtemp(join(tmpdir(), "airkit-completion-guard-disabled-"));
  try {
    const env = { AIRCLAUDE_PROFILE: "example-profile", CLAUDE_PLUGIN_DATA: pluginData };
    await processCompletionGuardHook({ hook_event_name: "PostToolUse", session_id: "session-id" }, env);
    assert.equal(await processCompletionGuardHook({ hook_event_name: "Stop", session_id: "session-id" }, env), null);
  } finally {
    await rm(pluginData, { force: true, recursive: true });
  }
});

test("subagent output guard bounds transcript-like Agent results without touching ordinary output", () => {
  const transcript = [
    { type: "system", subtype: "init" },
    ...Array.from({ length: 120 }, (_, index) => ({
      type: "progress",
      message: { text: `progress ${index} ${"x".repeat(320)}` },
    })),
    { type: "assistant", message: { content: [{ type: "text", text: "Final summary: inspected the repository and found no blocker." }] } },
  ].map((record) => JSON.stringify(record)).join("\n");
  const input = {
    hook_event_name: "PostToolUse",
    tool_name: "Agent",
    tool_response: {
      result: transcript,
      usage: { input_tokens: 123, output_tokens: 456 },
      total_cost_usd: 0.12,
      duration_ms: 789,
    },
  };

  const guarded = processSubagentOutputHook(input);
  assert.equal(guarded.hookSpecificOutput.hookEventName, "PostToolUse");
  assert.equal(guarded.hookSpecificOutput.updatedToolOutput.usage.output_tokens, 456);
  assert.match(guarded.hookSpecificOutput.updatedToolOutput.result, /Final summary: inspected the repository/);
  assert.ok(guarded.hookSpecificOutput.updatedToolOutput.result.length <= 12_000);
  assert.doesNotMatch(guarded.hookSpecificOutput.updatedToolOutput.result, /progress 119/);

  const taskOutput = processSubagentOutputHook({
    hook_event_name: "PostToolUse",
    tool_name: "TaskOutput",
    tool_response: { retrieval_status: "success", task: { output: transcript, status: "completed" } },
  });
  assert.match(taskOutput.hookSpecificOutput.updatedToolOutput.task.output, /Final summary: inspected the repository/);
  assert.equal(taskOutput.hookSpecificOutput.updatedToolOutput.task.status, "completed");

  const ordinary = { ...input, tool_response: { ...input.tool_response, result: "A normal long result\n".repeat(20_000) } };
  assert.equal(processSubagentOutputHook(ordinary), null);
  assert.equal(processSubagentOutputHook({ ...input, tool_name: "Read" }), null);
});

test("launch mode exports its completion guard limit only for the selected mode", () => {
  const catalog = launchCatalog();
  catalog.profiles[0].launch.modes.fast.completionGuard = { maxStopBlocks: 1 };

  const guarded = buildLaunchPlan(catalog, "launch-example", { mode: "fast" });
  const unguarded = buildLaunchPlan(catalog, "launch-example", {
    mode: "auto",
    env: { AIRCLAUDE_COMPLETION_GUARD_MAX_STOP_BLOCKS: "1" },
  });

  assert.equal(guarded.launch.env.AIRCLAUDE_COMPLETION_GUARD_MAX_STOP_BLOCKS, "1");
  assert.equal(unguarded.launch.env.AIRCLAUDE_COMPLETION_GUARD_MAX_STOP_BLOCKS, undefined);
  assert.ok(unguarded.launch.clearEnv.includes("AIRCLAUDE_COMPLETION_GUARD_MAX_STOP_BLOCKS"));
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
    const renderedHooks = JSON.parse(await readFile(hooks.path, "utf8")).hooks;
    assert.deepEqual(Object.keys(renderedHooks).sort(), [
      "PostCompact",
      "PostToolUse",
      "SessionStart",
      "Stop",
      "UserPromptSubmit",
    ]);
    assert.equal(renderedHooks.Stop[0].hooks[0].command, "node");
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
      return "3.0.18";
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
          getVersion: async () => { calls.push("getVersion"); return "3.0.18"; },
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
      return "3.0.18";
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
      return "3.0.18";
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

test("a rotated management token is re-read once and never force-starts a live service", async () => {
  const root = await mkdtemp(join(tmpdir(), "airkit-ccr-token-rotation-"));
  const stateDir = join(root, ".claude-code-router");
  const servicePath = join(stateDir, "service.json");
  const tokens = [];
  const calls = [];
  try {
    await mkdir(stateDir, { recursive: true });
    const rotate = async (token) => {
      live = token;
      await writeFile(servicePath, JSON.stringify({ url: `http://127.0.0.1:3462/?ccr_web_token=${token}` }));
    };
    let live;
    await rotate("before-restart");

    const client = airkitRuntime.createCcr3Client({
      // autoStart false proves the recovery reads the file rather than starting
      // a service: something is answering on the wire, so there is nothing to start.
      autoStart: false,
      env: { HOME: root },
      fetch: async (url, init) => {
        const token = init.headers["x-ccr-web-auth"];
        tokens.push(token);
        if (token !== live) return { ok: false, status: 401 };
        return { json: async () => ({ value: { PORT: 3456 } }), ok: true, status: 200 };
      },
      runCommand: async () => {
        calls.push("runner");
        return { ok: true, status: 0, stdout: "" };
      },
    });

    // The client caches service.json on its first RPC, which is what makes the
    // token it holds go stale when --restart-stale replaces the service.
    await client.getConfig();
    await rotate("after-restart");

    assert.deepEqual(await client.getConfig(), { PORT: 3456 });
    assert.deepEqual(
      tokens,
      ["before-restart", "before-restart", "after-restart"],
      "the stale token is tried once, then exactly one retry with the rotated one",
    );
    assert.deepEqual(calls, [], "a service that answers must never be started");
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("an unauthorized RPC that is not token rotation fails without a retry", async () => {
  const root = await mkdtemp(join(tmpdir(), "airkit-ccr-unauthorized-"));
  const stateDir = join(root, ".claude-code-router");
  const attempts = [];
  try {
    await mkdir(stateDir, { recursive: true });
    await writeFile(join(stateDir, "service.json"), JSON.stringify({
      url: "http://127.0.0.1:3462/?ccr_web_token=unchanged",
    }));

    const client = airkitRuntime.createCcr3Client({
      autoStart: false,
      env: { HOME: root },
      fetch: async () => {
        attempts.push("fetch");
        return { ok: false, status: 403 };
      },
      runCommand: async () => ({ ok: true, status: 0, stdout: "" }),
    });

    await assert.rejects(client.getConfig(), /CCR RPC getConfig failed: HTTP 403/);
    assert.deepEqual(attempts, ["fetch"], "an unchanged token must not be retried");
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("a supervised daemon is started through launchctl, never beside it", async () => {
  const root = await mkdtemp(join(tmpdir(), "airkit-supervised-start-"));
  const stateDir = join(root, ".claude-code-router");
  const commands = [];
  try {
    const client = airkitRuntime.createCcr3Client({
      env: { HOME: root },
      fetch: async () => ({ ok: true, json: async () => ({ value: { profile: { profiles: [] } } }) }),
      runCommand: async (command, args) => {
        commands.push(`${command} ${args.join(" ")}`);
        if (command === "launchctl" && args[0] === "kickstart") {
          await mkdir(stateDir, { recursive: true });
          await writeFile(join(stateDir, "service.json"), JSON.stringify({
            url: "http://127.0.0.1:9/?ccr_web_token=synthetic-token",
          }));
        }
        return { ok: true, status: 0, stderr: "", stdout: "" };
      },
    });

    await client.getConfig();

    // Without -k: this call has to start a job that is down and do nothing to
    // one that is up. `-k` here would kill a healthy service out from under
    // every session attached to it.
    assert.ok(commands.includes(`launchctl kickstart gui/${process.getuid()}/com.airkit.ccr-daemon`));
    assert.ok(
      !commands.some((command) => command.startsWith("ccr ")),
      "starting CCR beside launchd is exactly what produces a second management service",
    );
  } finally {
    await rm(root, { force: true, recursive: true });
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
          const value = method === "getAppInfo" ? { version: "3.0.18" } : safeConfig;
          return { ok: true, json: async () => ({ value }) };
        },
        runCommand: async (command, args) => {
          // No launchd job owns the daemon here, so the client must take the
          // plain start path rather than kickstarting somebody else's label.
          if (command === "launchctl") return { ok: false, status: 1, stdout: "", stderr: "Could not find service" };
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
          // No launchd job owns the daemon here, so the client must take the
          // plain start path rather than kickstarting somebody else's label.
          if (command === "launchctl") return { ok: false, status: 1, stdout: "", stderr: "Could not find service" };
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
      runCommand: async () => ({ ok: true, status: 0, stdout: "gateway-key-from-helper" }),
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
    assert.equal(spawned[0].command, "claude");
    assert.equal(spawned[0].args[0], "--append-system-prompt");
    assert.match(
      spawned[0].args[1],
      /AirClaude mode pro routes default to strong-coder while Claude launch uses claude-sonnet-5\./,
    );
    assert.match(spawned[0].args[1], /AirKit reusable runtime lessons/);
    assert.match(spawned[0].args[1], /AirClaude active routing/);
    assert.match(spawned[0].args[1], /mode: pro/);
    assert.match(spawned[0].args[1], /background: demo,cheap-coder \(model cheap-coder\)/);
    // AirClaude selects its display model for this launch only; passthrough args
    // still follow and can override it for the same process.
    assert.equal(spawned[0].args[2], "--model");
    assert.equal(spawned[0].args[3], "claude-sonnet-5");
    assert.equal(spawned[0].args.at(-1), "--dangerously-skip-permissions");
    assert.deepEqual(spawned[0].env, {
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
      ANTHROPIC_CUSTOM_HEADERS: "x-airkit-mode: pro",
      CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1",
      ANTHROPIC_API_BASE_URL: "http://127.0.0.1:3456",
      ANTHROPIC_BASE_URL: "http://127.0.0.1:3456",
      ANTHROPIC_AUTH_TOKEN: "gateway-key-from-helper",
    });
  } finally {
    await rm(configDir, { force: true, recursive: true });
  }
});

test("prepareLaunch starts the adapter, removes legacy routes, and keeps its gateway key out of persisted config and argv", async () => {
  const catalog = legacyCompatibilityCatalog();
  catalog.profiles[0].ccr.HOST = "127.0.0.1";
  catalog.profiles[0].ccr.PORT = 9314;
  const configDir = await mkdtemp(join(tmpdir(), "airkit-compatibility-launch-"));
  const saved = [];
  const spawned = [];
  const adapters = [];
  const childEvents = new Map();
  let adapterClosed = 0;
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
    getVersion: async () => "3.0.18",
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
      runCommand: async () => ({ ok: true, status: 0, stdout: "gateway-key-from-helper" }),
      runtimeVersions: passingRuntimeVersions(),
      startCompatibilityMiddleware: async (options) => {
        adapters.push(options);
        return {
          close: async () => { adapterClosed += 1; },
          origin: "http://127.0.0.1:4599",
        };
      },
      spawnCommand: (command, args, options) => {
        spawned.push({ args, command, env: options.env });
        const child = {
          once(event, listener) {
            childEvents.set(event, [...(childEvents.get(event) ?? []), listener]);
            return this;
          },
        };
        queueMicrotask(() => childEvents.get("exit")?.forEach((listener) => listener(0)));
        return child;
      },
    });

    assert.equal(saved[0].plugins.some((plugin) => plugin.id === unrelated.id), true);
    assert.equal(saved[0].plugins.some((plugin) => plugin.id === "airkit-compatibility"), false);
    assert.equal(saved[0].observability.requestLogs, true);
    assert.equal(JSON.stringify(saved[0]).includes("fixture-gateway-token"), false);
    assert.equal(adapters.length, 1);
    assert.equal(adapters[0].gatewayOrigin, "http://127.0.0.1:9314");
    assert.equal(adapters[0].gatewayToken, "gateway-key-from-helper");
    const settingsIndex = spawned[0].args.indexOf("--settings");
    assert.notEqual(settingsIndex, -1);
    assert.deepEqual(JSON.parse(spawned[0].args[settingsIndex + 1]), {
      env: {
        ANTHROPIC_API_BASE_URL: "http://127.0.0.1:4599",
        ANTHROPIC_BASE_URL: "http://127.0.0.1:4599",
        CLAUDE_AGENT_API_BASE_URL: "http://127.0.0.1:4599",
        CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "0",
      },
    });
    const mcpIndex = spawned[0].args.indexOf("--mcp-config");
    assert.notEqual(mcpIndex, -1);
    assert.equal(spawned[0].args.includes("--strict-mcp-config"), false);
    assert.equal(spawned[0].args.filter((arg) => arg === "--settings").length, 1);
    assert.doesNotMatch(spawned[0].args.join(" "), /fixture-gateway-token|gateway-key-from-helper/);
    assert.deepEqual(JSON.parse(spawned[0].args[mcpIndex + 1]), {
      mcpServers: {
        "airkit-compatibility": {
          headers: { "x-api-key": "${AIRKIT_COMPATIBILITY_MCP_TOKEN}" },
          type: "http",
          url: "${AIRKIT_COMPATIBILITY_MCP_URL}",
        },
      },
    });
    assert.equal(spawned[0].env.AIRKIT_COMPATIBILITY_MCP_URL,
      "http://127.0.0.1:4599/airkit/compatibility/mcp");
    assert.equal(spawned[0].env.AIRKIT_COMPATIBILITY_MCP_TOKEN, "gateway-key-from-helper");
    assert.equal(
      spawned[0].env.ANTHROPIC_BASE_URL,
      "http://127.0.0.1:4599",
      "the adapter overrides even an environment-referenced CCR gateway address",
    );
    assert.equal(
      spawned[0].env.CLAUDE_AGENT_API_BASE_URL,
      "http://127.0.0.1:4599",
      "named in-process teammates must use the same compatibility adapter",
    );
    assert.equal(
      spawned[0].env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB,
      "0",
      "Claude Agent subprocesses must retain the adapter route",
    );
    assert.equal(adapterClosed, 1, "prepareLaunch waits for Claude to exit before returning");
    childEvents.get("error")?.forEach((listener) => listener(new Error("after exit")));
    assert.equal(adapterClosed, 1, "the adapter closes exactly once after Claude exits");
  } finally {
    await rm(configDir, { force: true, recursive: true });
  }
});

test("prepareLaunch uses an asynchronous default child so compatibility middleware can run", async () => {
  const catalog = compatibilityCatalog();
  catalog.profiles[0].launch.args = ["-e", "setTimeout(() => {}, 200)", "--"];
  catalog.profiles[0].launch.binary = process.execPath;
  const configDir = await mkdtemp(join(tmpdir(), "airkit-compatibility-async-launch-"));
  let adapterClosed = 0;
  let adapterWasLiveDuringChild = false;

  try {
    const result = await prepareLaunch(catalog, "launch-example", {
      ccrClient: ccrTestClient([]),
      commandExists: async () => true,
      configDir,
      env: { DEMO_API_KEY: "runtime-secret", HOME: configDir },
      runCommand: async () => ({ ok: true, status: 0, stdout: "gateway-key-from-helper" }),
      runtimeVersions: passingRuntimeVersions(),
      startCompatibilityMiddleware: async () => {
        setTimeout(() => { adapterWasLiveDuringChild = adapterClosed === 0; }, 20);
        return {
          close: async () => { adapterClosed += 1; },
          origin: "http://127.0.0.1:4599",
        };
      },
    });

    assert.equal(typeof result.child?.pid, "number");
    assert.equal(adapterWasLiveDuringChild, true, "the parent event loop advances while the child is running");
    assert.equal(adapterClosed, 1);
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

test("provider-specific credential references require configured placeholder providers", async () => {
  const root = await mkdtemp(join(tmpdir(), "airkit-provider-token-schema-"));
  const catalog = launchCatalog();
  catalog.profiles[0].ccr.Providers.push({
    name: "secondary-provider",
    type: "openai_chat_completions",
    api_base_url: "https://example.invalid/v1/chat/completions",
    api_key: "$SECONDARY_PROVIDER_API_KEY",
    models: ["secondary-model"],
  });
  catalog.profiles[0].shell = {
    ccrTokenOpRef: "op://Test/API/primary",
    providerTokenOpRefs: { "secondary-provider": "op://Test/API/secondary" },
  };

  const cases = [
    [catalog, null],
    [{ ...catalog, profiles: [{ ...catalog.profiles[0], shell: {
      ...catalog.profiles[0].shell,
      providerTokenOpRefs: { unknown: "op://Test/API/secondary" },
    } }] }, /providerTokenOpRefs references unknown provider: unknown/],
    [{ ...catalog, profiles: [{ ...catalog.profiles[0], shell: {
      ...catalog.profiles[0].shell,
      providerTokenOpRefs: { "secondary-provider": "not-an-op-reference" },
    } }] }, /providerTokenOpRefs\.secondary-provider must be an op:\/\/ reference/],
    [{ ...catalog, profiles: [{ ...catalog.profiles[0], ccr: {
      ...catalog.profiles[0].ccr,
      Providers: catalog.profiles[0].ccr.Providers.map((provider) => provider.name === "secondary-provider"
        ? { ...provider, api_key: "literal-api-key" }
        : provider),
    } }] }, /providerTokenOpRefs\.secondary-provider requires an environment-placeholder api_key/],
  ];

  try {
    for (const [index, [candidate, expected]] of cases.entries()) {
      const catalogPath = join(root, `${index}.json`);
      await writeFile(catalogPath, `${JSON.stringify(candidate)}\n`);
      if (expected) await assert.rejects(loadCatalog(catalogPath, { includeLocal: false }), expected);
      else await assert.doesNotReject(loadCatalog(catalogPath, { includeLocal: false }));
    }
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("provider-specific credential references isolate managed provider tokens", async () => {
  const catalog = launchCatalog();
  catalog.profiles[0].ccr.Providers[0].api_key = "$ANTHROPIC_AUTH_TOKEN";
  catalog.profiles[0].ccr.Providers.push({
    name: "secondary-provider",
    type: "openai_chat_completions",
    api_base_url: "https://example.invalid/v1/chat/completions",
    api_key: "$SECONDARY_PROVIDER_API_KEY",
    models: ["secondary-model"],
  });
  catalog.profiles[0].shell = {
    ccrTokenOpRef: "op://Test/API/primary",
    providerTokenOpRefs: { "secondary-provider": "op://Test/API/secondary" },
  };
  const configDir = await mkdtemp(join(tmpdir(), "airkit-provider-token-resolution-"));
  const saved = [];
  const calls = [];

  try {
    await prepareLaunch(catalog, "launch-example", {
      configDir,
      ccrClient: ccrTestClient(saved),
      commandExists: async () => true,
      env: { HOME: configDir },
      launch: false,
      runtimeVersions: passingRuntimeVersions(),
      runCommand: async (command, args) => {
        calls.push({ command, args });
        return {
          ok: true,
          status: 0,
          stdout: args[1] === "op://Test/API/secondary" ? "secondary-token-sentinel" : "primary-token-sentinel",
        };
      },
    });

    assert.deepEqual(calls, [
      { command: "op", args: ["read", "op://Test/API/secondary", "--no-newline"] },
      { command: "op", args: ["read", "op://Test/API/primary", "--no-newline"] },
    ]);
    assert.equal(
      saved[0].Providers.find((provider) => provider.id === "airkit-provider-launch-example-demo").api_key,
      "primary-token-sentinel",
    );
    assert.equal(
      saved[0].Providers.find((provider) => provider.id === "airkit-provider-launch-example-secondary-provider").api_key,
      "secondary-token-sentinel",
    );
    const renderedCcr = JSON.stringify(airkitRuntime.buildCcrConfig(catalog, "launch-example", { configDir }));
    const renderedShell = buildShellSnippet(catalog, "launch-example", { configDir });
    assert.doesNotMatch(renderedCcr, /(?:primary|secondary)-token-sentinel/);
    assert.doesNotMatch(renderedShell, /(?:primary|secondary)-token-sentinel/);
  } finally {
    await rm(configDir, { force: true, recursive: true });
  }
});

test("a launch from inside a launched session never adopts the gateway key as the provider credential", async () => {
  const catalog = compatibilityCatalog();
  for (const provider of catalog.profiles[0].ccr.Providers) {
    provider.api_key = "$ANTHROPIC_AUTH_TOKEN";
  }
  catalog.profiles[0].shell = { ccrTokenOpRef: "op://Test/API/token" };
  const configDir = await mkdtemp(join(tmpdir(), "airkit-launch-nested-"));
  const saved = [];

  try {
    // Reproduces running airkit inside an airclaude session: the environment
    // carries the local gateway key — and possibly a stale op-ref override —
    // neither of which is a credential source for the upstream provider.
    const opReads = [];
    await prepareLaunch(catalog, "launch-example", {
      configDir,
      ccrClient: ccrTestClient(saved),
      commandExists: async (command) => ["ccr", "claude", "op"].includes(command),
      env: {
        AIRCLAUDE_MODE: "pro",
        AIRCLAUDE_PROFILE: "launch-example",
        ANTHROPIC_AUTH_TOKEN: "local-gateway-key",
        CCR_ANTHROPIC_AUTH_TOKEN_OP_REF: "op://Stale/Inherited/ref",
        HOME: configDir,
      },
      launch: false,
      runCommand: async (command, args) => {
        if (command === "op") {
          opReads.push(args[1]);
          return { ok: true, status: 0, stdout: "upstream-token" };
        }
        return { ok: true, status: 0, stdout: "" };
      },
      runtimeVersions: passingRuntimeVersions(),
    });

    assert.deepEqual(
      opReads,
      ["op://Test/API/token"],
      "a nested run resolves the profile's own op ref, never an inherited override",
    );
    for (const provider of saved[0].Providers) {
      assert.equal(provider.api_key, "upstream-token", `${provider.id} keeps the upstream credential`);
      assert.notEqual(provider.api_key, "local-gateway-key");
    }
  } finally {
    await rm(configDir, { force: true, recursive: true });
  }
});

test("launch fails closed when Claude Code is missing from PATH", async () => {
  const configDir = await mkdtemp(join(tmpdir(), "airkit-launch-no-claude-"));

  try {
    await assert.rejects(
      () => prepareLaunch(launchCatalog(), "launch-example", {
        configDir,
        ccrClient: ccrTestClient([]),
        commandExists: async (command) => command === "ccr",
        env: { DEMO_API_KEY: "runtime-secret", HOME: configDir },
        runtimeVersions: passingRuntimeVersions(),
      }),
      /missing command: claude/,
    );
  } finally {
    await rm(configDir, { force: true, recursive: true });
  }
});

test("a dry run proves the launch contract without resolving the gateway key", async () => {
  const configDir = await mkdtemp(join(tmpdir(), "airkit-launch-dry-"));
  const calls = [];

  try {
    const result = await prepareLaunch(launchCatalog(), "launch-example", {
      configDir,
      commandExists: async () => true,
      dryRun: true,
      env: { DEMO_API_KEY: "runtime-secret", HOME: configDir },
      mode: "pro",
      runCommand: async (command, args) => {
        calls.push({ command, args });
        return { ok: true, status: 0, stdout: "" };
      },
      runtimeVersions: passingRuntimeVersions(),
      userArgs: ["--resume"],
    });

    assert.equal(result.write, false);
    assert.equal(result.launch.command, "claude");
    assert.deepEqual(result.launch.userArgs, ["--resume"]);
    assert.equal(Object.hasOwn(result.launch.env, "ANTHROPIC_AUTH_TOKEN"), false);
    assert.equal(
      calls.some(({ command }) => command.includes("ccr-claude-code-api-key")),
      false,
      "a dry run must not run the gateway key helper",
    );
    assert.equal(result.launch.env.ANTHROPIC_CUSTOM_HEADERS, "x-airkit-mode: pro");
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

// A stale plugin host must be announced before the child starts, because a
// launch renders its own report only after the session ends.
async function staleHostLaunch(extraArgv, { ccrResult, launchctlResult, restartStale, supervised = false }) {
  const catalog = launchCatalog();
  const catalogPath = await writeLaunchCatalog(catalog);
  const configDir = await mkdtemp(join(tmpdir(), "airkit-restart-stale-"));
  const pluginDir = await mkdtemp(join(tmpdir(), "airkit-restart-stale-plugin-"));
  const events = [];
  const output = [];
  const ccrClient = ccrTestClient([]);
  const liveConfig = await ccrClient.getConfig();
  // The freshness check reads the *live* plugin list, so it has to be injected
  // on top of the real config shape rather than replacing it.
  ccrClient.getConfig = async () => ({
    ...liveConfig,
    plugins: [{ id: "airkit-compatibility", module: join(pluginDir, "plugin.mjs") }],
  });
  ccrClient.ensureGateway = async () => events.push("gateway-ready");

  await writeFile(join(pluginDir, "plugin.mjs"), "export default {};\n");

  try {
    await runAirclaudeCli(["--profile", "launch-example", ...extraArgv], {
      catalogPath,
      ccrClient,
      commandExists: async (command) => ["ccr", "claude"].includes(command),
      configDir,
      env: { DEMO_API_KEY: "runtime-secret", HOME: "/tmp/airkit-restart-stale-home" },
      // The host predates the module, so the check must fire.
      pluginHostStartedAt: new Date("2000-01-01T00:00:00Z"),
      runCommand: async (command, args) => {
        if (command === "launchctl") {
          // `print` answers whether the daemon is supervised at all; every other
          // launchctl verb is the restart itself and belongs in the event log.
          if (args[0] === "print") return { ok: supervised, status: supervised ? 0 : 1, stdout: "", stderr: "" };
          events.push(`launchctl ${args.join(" ")}`);
          return launchctlResult ?? { ok: true, status: 0, stdout: "", stderr: "" };
        }
        if (command !== "ccr") return { ok: true, status: 0, stdout: "gateway-key-from-helper", stderr: "" };
        events.push(`ccr ${args.join(" ")}`);
        return ccrResult ?? { ok: true, status: 0, stdout: "", stderr: "" };
      },
      restartStale,
      runtimeVersions: passingRuntimeVersions(),
      spawnCommand: () => {
        events.push("spawn");
        return { status: 0 };
      },
      stdout: { write: (chunk) => output.push(chunk) },
    });
    return { events, output: output.join("") };
  } finally {
    await rm(pluginDir, { force: true, recursive: true });
    await rm(configDir, { force: true, recursive: true });
    await rm(resolve(catalogPath, ".."), { force: true, recursive: true });
  }
}

test("a stale plugin host is reported before the session starts and left alone", async () => {
  const { events, output } = await staleHostLaunch([], { restartStale: false });

  assert.match(output, /warn CCR plugin freshness/);
  assert.match(output, /ccr stop && ccr start/, "the message has to name the fix");
  assert.match(output, /--restart-stale/, "and the flag that performs it");
  // The warning has to precede the child, or it arrives after the session ends.
  assert.ok(
    output.indexOf("warn CCR plugin freshness") >= 0 && events.indexOf("spawn") === events.length - 1,
    "the announcement comes before the spawn",
  );
  assert.ok(
    !events.some((event) => event.startsWith("ccr stop")),
    "reporting must never stop a service the user did not ask to stop",
  );
});

test("--restart-stale reloads the plugin host before the gateway and the child", async () => {
  const { events, output } = await staleHostLaunch(["--restart-stale"], { restartStale: true });

  assert.match(output, /--restart-stale: running/);
  assert.match(output, /plugin host restarted/);
  // Order matters: the reload has to land before the gateway comes up, and both
  // before the child, or the session attaches to the service being replaced.
  const sequence = events.filter((event) => event.startsWith("ccr ") || ["gateway-ready", "spawn"].includes(event));
  assert.deepEqual(sequence, ["ccr stop", "ccr start --no-gateway", "gateway-ready", "spawn"]);
});

test("--restart-stale restarts a supervised daemon in place instead of stopping it", async () => {
  const { events, output } = await staleHostLaunch(["--restart-stale"], { restartStale: true, supervised: true });

  assert.match(output, /launchctl kickstart -k gui\/\d+\/com\.airkit\.ccr-daemon/);
  assert.match(output, /plugin host restarted/);
  const sequence = events.filter((event) =>
    event.startsWith("ccr ") || event.startsWith("launchctl ") || ["gateway-ready", "spawn"].includes(event));
  assert.deepEqual(sequence, [
    `launchctl kickstart -k gui/${process.getuid()}/com.airkit.ccr-daemon`,
    "gateway-ready",
    "spawn",
  ]);
  // `ccr stop` hands the replacement to launchd, and the `ccr start` that would
  // follow races it — the pair is how two management services end up running.
  assert.ok(!events.some((event) => event.startsWith("ccr ")), "no CCR lifecycle command may run beside the supervisor");
});

test("a failed supervised kickstart is named and never falls through to ccr stop", async () => {
  const { events, output } = await staleHostLaunch(["--restart-stale"], {
    launchctlResult: { ok: false, status: 1, stderr: "Could not find service", stdout: "" },
    restartStale: true,
    supervised: true,
  });

  assert.match(output, /launchctl kickstart failed: Could not find service/);
  assert.doesNotMatch(output, /plugin host restarted/);
  assert.ok(!events.some((event) => event.startsWith("ccr ")), "the fallback would be the racing path itself");
  assert.ok(events.includes("spawn"), "a failed reload must not block the session");
});

test("a failed --restart-stale reload is named and the session still starts", async () => {
  const { events, output } = await staleHostLaunch(["--restart-stale"], {
    ccrResult: { ok: false, status: 1, stdout: "", stderr: "ccr: service is not managed by this user" },
    restartStale: true,
  });

  assert.match(output, /ccr stop failed: ccr: service is not managed by this user/);
  // Stop failed, so start must not run against a service in an unknown state —
  // and the launch still proceeds, because the previous host is still up and
  // blocking the session would be worse than running against a stale plugin.
  assert.deepEqual(events.filter((event) => event.startsWith("ccr ")), ["ccr stop"]);
  assert.ok(events.includes("spawn"), "a failed reload must not block the session");
});

test("plain Claude CLI spawns only user arguments after the gateway is ready", async () => {
  const catalog = launchCatalog();
  catalog.profiles[0].launch.modes.plain = {};
  const catalogPath = await writeLaunchCatalog(catalog);
  const configDir = await mkdtemp(join(tmpdir(), "airkit-plain-cli-"));
  const events = [];
  const spawnCalls = [];
  const ccrClient = ccrTestClient([]);
  ccrClient.ensureGateway = async () => events.push("gateway-ready");

  try {
    const exitCode = await runAirclaudeCli([
      "--plain",
      "--profile", "launch-example",
      "--model", "opus",
      "-p", "hi",
    ], {
      catalogPath,
      ccrClient,
      commandExists: async (command) => ["ccr", "claude"].includes(command),
      configDir,
      env: { DEMO_API_KEY: "runtime-secret", HOME: "/tmp/airkit-plain-home" },
      runCommand: async () => ({ ok: true, status: 0, stdout: "gateway-key-from-helper" }),
      runtimeVersions: passingRuntimeVersions(),
      spawnCommand: (command, args, options) => {
        events.push("spawn");
        spawnCalls.push({ args, command, env: options.env });
        return { status: 0 };
      },
      stdout: { write: () => {} },
    });

    assert.equal(exitCode, 0);
    assert.deepEqual(events, ["gateway-ready", "spawn"]);
    assert.equal(spawnCalls.length, 1);
    assert.equal(spawnCalls[0].command, "claude");
    assert.deepEqual(spawnCalls[0].args, ["--model", "opus", "-p", "hi"]);
  } finally {
    await rm(configDir, { force: true, recursive: true });
    await rm(resolve(catalogPath, ".."), { force: true, recursive: true });
  }
});

test("plain Claude CLI rejects a different positional mode", async () => {
  const catalog = launchCatalog();
  catalog.profiles[0].launch.modes.plain = {};
  const catalogPath = await writeLaunchCatalog(catalog);
  const configDir = await mkdtemp(join(tmpdir(), "airkit-plain-mode-"));

  try {
    for (const args of [
      ["--plain", "pro"],
      ["pro", "--plain"],
    ]) {
      await assert.rejects(
        () => runAirclaudeCli([...args, "--dry-run", "--profile", "launch-example", "--config-dir", configDir], {
          catalogPath,
          commandExists: async () => true,
          stdout: { write: () => {} },
        }),
        /--plain cannot be combined with positional mode "pro"/,
      );
    }
  } finally {
    await rm(configDir, { force: true, recursive: true });
    await rm(resolve(catalogPath, ".."), { force: true, recursive: true });
  }
});

test("plain Claude CLI excludes compatibility MCP launch overlays", async () => {
  const catalog = legacyCompatibilityCatalog();
  catalog.profiles[0].launch.modes.plain = {};
  const catalogPath = await writeLaunchCatalog(catalog);
  const configDir = await mkdtemp(join(tmpdir(), "airkit-plain-compatibility-"));
  const spawnCalls = [];
  const ccrClient = {
    ensureGateway: async () => {},
    getConfig: async () => ({
      APIKEY: "$CCR_GATEWAY_TOKEN",
      HOST: "$CCR_GATEWAY_HOST",
      PORT: "$CCR_GATEWAY_PORT",
      Providers: [],
      Router: { builtInRules: {}, fallback: { mode: "off", models: [], retryCount: 1 }, rules: [] },
      profile: { enabled: true, profiles: [] },
    }),
    getVersion: async () => "3.0.18",
    saveConfig: async () => {},
  };

  try {
    const exitCode = await runAirclaudeCli(["--plain", "--profile", "launch-example", "-p", "hi"], {
      catalogPath,
      ccrClient,
      commandExists: async (command) => ["ccr", "claude"].includes(command),
      configDir,
      env: {
        CCR_GATEWAY_HOST: "127.0.0.1",
        CCR_GATEWAY_PORT: "4567",
        CCR_GATEWAY_TOKEN: "fixture-gateway-token",
        DEMO_API_KEY: "runtime-secret",
        HOME: "/tmp/airkit-plain-home",
      },
      runCommand: async () => ({ ok: true, status: 0, stdout: "gateway-key-from-helper" }),
      runtimeVersions: passingRuntimeVersions(),
      spawnCommand: (command, args, options) => {
        spawnCalls.push({ args, command, env: options.env });
        return { status: 0 };
      },
      stdout: { write: () => {} },
    });

    assert.equal(exitCode, 0);
    assert.equal(spawnCalls.length, 1);
    assert.deepEqual(spawnCalls[0].args, ["-p", "hi"]);
    assert.equal(spawnCalls[0].env.AIRKIT_COMPATIBILITY_MCP_TOKEN, undefined);
    assert.equal(spawnCalls[0].env.AIRKIT_COMPATIBILITY_MCP_URL, undefined);
    assert.equal(spawnCalls[0].env.ANTHROPIC_CUSTOM_HEADERS, "x-airkit-mode: plain");
    assert.equal(spawnCalls[0].env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY, "1");
    assert.equal(spawnCalls[0].env.ANTHROPIC_BASE_URL, "http://127.0.0.1:4567");
  } finally {
    await rm(configDir, { force: true, recursive: true });
    await rm(resolve(catalogPath, ".."), { force: true, recursive: true });
  }
});

test("plain Claude CLI fails closed when the gateway is not healthy", async () => {
  const catalog = launchCatalog();
  catalog.profiles[0].launch.modes.plain = {};
  const catalogPath = await writeLaunchCatalog(catalog);
  const configDir = await mkdtemp(join(tmpdir(), "airkit-plain-gateway-"));
  const spawnCalls = [];
  let ensureGatewayCalls = 0;
  const ccrClient = ccrTestClient([]);
  ccrClient.ensureGateway = async () => {
    ensureGatewayCalls += 1;
    throw new Error("CCR gateway is not healthy");
  };

  try {
    await assert.rejects(
      () => runAirclaudeCli(["--plain", "--profile", "launch-example", "-p", "hi"], {
        catalogPath,
        ccrClient,
        commandExists: async (command) => ["ccr", "claude"].includes(command),
        configDir,
        env: { DEMO_API_KEY: "runtime-secret", HOME: "/tmp/airkit-plain-home" },
        runtimeVersions: passingRuntimeVersions(),
        spawnCommand: (...args) => spawnCalls.push(args),
        stdout: { write: () => {} },
      }),
      /CCR gateway is not healthy/,
    );
    assert.equal(spawnCalls.length, 0);
    assert.equal(ensureGatewayCalls, 1);
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
          claudeModel: "claude-sonnet-5",
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
    module: "@untionglim/ai-runtime-kit/compatibility-plugin",
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
  return { claudeCode: "2.1.208", claudeCodeRouter: "3.0.18", node: "24.11.1" };
}

function ccrTestClient(saved) {
  return {
    getConfig: async () => ({
      HOST: "127.0.0.1",
      PORT: 3456,
      Providers: [],
      Router: { builtInRules: {}, fallback: { mode: "off", models: [], retryCount: 1 }, rules: [] },
      profile: { enabled: true, profiles: [] },
    }),
    ensureGateway: async () => {},
    getVersion: async () => "3.0.18",
    saveConfig: async (config) => saved.push(config),
  };
}

async function writeLaunchCatalog(catalog = launchCatalog()) {
  const dir = await mkdtemp(join(tmpdir(), "airkit-launch-catalog-"));
  const path = join(dir, "catalog.json");
  await writeFile(path, `${JSON.stringify(catalog, null, 2)}\n`);
  return path;
}
