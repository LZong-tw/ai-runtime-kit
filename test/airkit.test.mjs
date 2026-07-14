import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import * as airkitRuntime from "../src/airkit.mjs";

import {
  buildLaunchPlan,
  buildShellSnippet,
  doctorProfile,
  exportOssRelease,
  installProfile,
  loadCatalog,
  prepareLaunch,
  repairClaudeRestoreSessions,
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

test("OSS package allowlist excludes tests and migration artifacts", async () => {
  const expectedFiles = [
    "CLAUDE.md",
    "README.md",
    "docs/install.md",
    "docs/profile-schema.md",
    "docs/runtime-lessons.md",
    "profiles",
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
    { apiKeys: { demo: "resolved-at-runtime" } },
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
  assert.ok(merged.config.profile.profiles.some((candidate) => candidate.id === "unrelated-profile"));
  assert.ok(merged.config.Router.rules.some((rule) => rule.id === "unrelated-rule"));
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
      backupsDir: join(configDir, "backups"),
      ccrClient,
      commandExists: async (command) => ["ccr", "claude"].includes(command),
      configDir,
      env: { DEMO_API_KEY: "runtime-secret" },
      launch: false,
      liveCcrConfig: join(configDir, "live", "config.json"),
      mode: "pro",
      projectsDir: join(configDir, "projects"),
      repairRestore: false,
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
  assert.match(prompt, /Claude restore\/display model is compatibility metadata only/);
});

test("generated shell wrappers delegate to the managed CCR 3 launch path", async () => {
  const catalog = await loadCatalog();
  const snippet = buildShellSnippet(catalog, profile, { configDir: "/tmp/airkit-test" });

  assert.match(snippet, /airclaude-example\(\)/);
  assert.match(snippet, /command airclaude --profile 'openai-compatible-example' --/);
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
    assert.match(result.failures.join("\n"), /stale CCR config/);
    assert.match(result.failures.join("\n"), /missing command: ccr/);
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
    assert.deepEqual(plan.launch.args.slice(0, 6), [
      "airkit-launch-example-pro",
      "cli",
      "--",
      "--settings",
      "{\"apiKeyHelper\":\"\"}",
      "--append-system-prompt",
    ]);
    assert.match(
      plan.launch.args[6],
      /AirClaude mode pro routes default to strong-coder while Claude restore uses claude-sonnet-4-6\./,
    );
    assert.match(plan.launch.args[6], /AirKit reusable runtime lessons/);
    assert.match(plan.launch.args[6], /AirClaude active routing/);
    assert.match(plan.launch.args[6], /mode: pro/);
    assert.match(plan.launch.args[6], /default: demo,strong-coder \(model strong-coder\)/);
    assert.match(plan.launch.args[6], /background: demo,cheap-coder \(model cheap-coder\)/);
    assert.doesNotMatch(plan.launch.args[6], /- think:|- longContext:|- webSearch:/);
    assert.match(plan.launch.args[6], /Do not infer the active provider route from Claude Code's displayed model name/);
    assert.equal(plan.launch.env.AIRCLAUDE_PROFILE, "launch-example");
    assert.equal(plan.launch.env.AIRCLAUDE_MODE, "pro");
    assert.equal(plan.launch.env.AIRCLAUDE_ROUTE_DEFAULT, "demo,strong-coder");
    assert.equal(plan.launch.env.AIRCLAUDE_ROUTE_DEFAULT_MODEL, "strong-coder");
    assert.equal(plan.launch.env.AIRCLAUDE_ROUTE_THINK, undefined);
    assert.equal(plan.launch.env.AIRCLAUDE_ROUTE_LONG_CONTEXT_MODEL, undefined);
    assert.equal(plan.launch.env.AIRCLAUDE_STATUSLINE_LABEL, "airclaude pro strong-coder");
    assert.equal(plan.launch.env.AIRCLAUDE_STATUSLINE_INPUT_PRICE_PER_MILLION, "2");
    assert.equal(plan.launch.env.AIRCLAUDE_RESTORE_MODEL, "claude-sonnet-4-6");
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

test("airclaude launch does not set the dead ANTHROPIC_1M_CONTEXT env (1M comes from the [1m] model suffix)", async () => {
  const catalog = launchCatalog();
  const configDir = await mkdtemp(join(tmpdir(), "airkit-launch-1m-"));

  try {
    const plan = buildLaunchPlan(catalog, "launch-example", { configDir });
    // 1M context is NOT enabled by any env var (ANTHROPIC_1M_CONTEXT is a no-op in Claude Code 2.1.178);
    // it is gated on the resolved model string ending in `[1m]`, so the lever is launch.restore.model,
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

test("prepareLaunch writes managed files, syncs CCR 3 through RPC, and preserves passthrough args", async () => {
  const catalog = launchCatalog();
  const configDir = await mkdtemp(join(tmpdir(), "airkit-launch-write-"));
  const spawned = [];
  const saved = [];

  try {
    const result = await prepareLaunch(catalog, "launch-example", {
      configDir,
      ccrClient: ccrTestClient(saved),
      mode: "pro",
      env: { DEMO_API_KEY: "runtime-secret" },
      repairRestore: false,
      runtimeVersions: passingRuntimeVersions(),
      userArgs: ["--dangerously-skip-permissions"],
      commandExists: async (command) => ["ccr", "claude"].includes(command),
      runCommand: async (command, args) => ({
        ok: true,
        status: 0,
        stdout: command === "ccr" && args[0] === "activate" ? 'export ANTHROPIC_BASE_URL="http://127.0.0.1:3456"\n' : "",
      }),
      spawnCommand: (command, args, options) => {
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
    assert.equal(spawned[0].command, "ccr");
    assert.deepEqual(spawned[0].args.slice(0, 6), [
      "airkit-launch-example-pro",
      "cli",
      "--",
      "--settings",
      "{\"apiKeyHelper\":\"\"}",
      "--append-system-prompt",
    ]);
    assert.match(
      spawned[0].args[6],
      /AirClaude mode pro routes default to strong-coder while Claude restore uses claude-sonnet-4-6\./,
    );
    assert.match(spawned[0].args[6], /AirKit reusable runtime lessons/);
    assert.match(spawned[0].args[6], /AirClaude active routing/);
    assert.match(spawned[0].args[6], /mode: pro/);
    assert.match(spawned[0].args[6], /background: demo,cheap-coder \(model cheap-coder\)/);
    // airclaude pins the masked restore model as --model so FRESH sessions get the
  // masked window too; user passthrough args still follow (and would override).
  assert.equal(spawned[0].args[7], "--model");
  assert.equal(spawned[0].args[8], "claude-sonnet-4-6");
  assert.equal(spawned[0].args.at(-1), "--dangerously-skip-permissions");
    assert.deepEqual(spawned[0].env, {
      AIRCLAUDE_MODE: "pro",
      AIRCLAUDE_PROFILE: "launch-example",
      AIRCLAUDE_RESTORE_MODEL: "claude-sonnet-4-6",
      AIRCLAUDE_ROUTE_BACKGROUND: "demo,cheap-coder",
      AIRCLAUDE_ROUTE_BACKGROUND_MODEL: "cheap-coder",
      AIRCLAUDE_ROUTE_BACKGROUND_PROVIDER: "demo",
      AIRCLAUDE_ROUTE_DEFAULT: "demo,strong-coder",
      AIRCLAUDE_ROUTE_DEFAULT_MODEL: "strong-coder",
      AIRCLAUDE_ROUTE_DEFAULT_PROVIDER: "demo",
      AIRCLAUDE_STATUSLINE_INPUT_PRICE_PER_MILLION: "2",
      AIRCLAUDE_STATUSLINE_LABEL: "airclaude pro strong-coder",
      CLAUDE_STATUSLINE_CACHE_DIR: join(homedir(), ".claude", "cache", "airclaude", "launch-example", "pro"),
      POWERLEVEL9K_INSTANT_PROMPT: "off",
      CCR_PROFILE: "launch-example",
    });
  } finally {
    await rm(configDir, { force: true, recursive: true });
  }
});

test("prepareLaunch resolves ccrTokenOpRef once for the CCR 3 config merge", async () => {
  const catalog = launchCatalog();
  catalog.profiles[0].shell = { ccrTokenOpRef: "op://Test/API/token" };
  const configDir = await mkdtemp(join(tmpdir(), "airkit-launch-op-"));
  const calls = [];
  const saved = [];

  try {
    const result = await prepareLaunch(catalog, "launch-example", {
      configDir,
      ccrClient: ccrTestClient(saved),
      commandExists: async (command) => ["ccr", "claude", "op"].includes(command),
      env: {},
      launch: false,
      repairRestore: false,
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
  } finally {
    await rm(configDir, { force: true, recursive: true });
  }
});

test("repairClaudeRestoreSessions rewrites persisted routed models and keeps a backup", async () => {
  const catalog = launchCatalog();
  const projectsDir = await mkdtemp(join(tmpdir(), "airkit-restore-projects-"));
  const backupsDir = await mkdtemp(join(tmpdir(), "airkit-restore-backups-"));
  const projectDir = join(projectsDir, "-Users-example-project");
  const sessionPath = join(projectDir, "session.jsonl");

  try {
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      sessionPath,
      [
        JSON.stringify({ type: "user", message: { role: "user", content: "hi" } }),
        JSON.stringify({ type: "assistant", message: { role: "assistant", model: "steady-coder" } }),
        JSON.stringify({ type: "assistant", message: { role: "assistant", model: "demo,strong-coder" } }),
        JSON.stringify({ type: "assistant", message: { role: "assistant", model: "sonnet" } }),
        JSON.stringify({ type: "assistant", message: { role: "assistant", model: "claude-sonnet-4-6" } }),
        JSON.stringify({
          type: "system",
          subtype: "compact_boundary",
          content: "Conversation compacted",
          compactMetadata: { trigger: "manual" },
        }),
        JSON.stringify({
          type: "user",
          isCompactSummary: true,
          message: { role: "user", content: "This session is being continued from a previous conversation." },
        }),
        "not json",
        "",
      ].join("\n"),
    );

    const result = await repairClaudeRestoreSessions(catalog, "launch-example", {
      backupsDir,
      projectsDir,
      write: true,
    });
    const repaired = await readFile(sessionPath, "utf8");

    assert.equal(result.scannedFiles, 1);
    assert.equal(result.repairedFiles, 1);
    assert.equal(result.repairedLines, 3);
    assert.match(repaired, /"model":"claude-sonnet-4-6"/);
    assert.doesNotMatch(repaired, /steady-coder/);
    assert.doesNotMatch(repaired, /demo,strong-coder/);
    assert.match(repaired, /claude-sonnet-4-6/);
    assert.match(repaired, /"subtype":"compact_boundary"/);
    assert.match(repaired, /"isCompactSummary":true/);
    assert.match(repaired, /not json/);
    assert.equal(result.backups.length, 1);
    assert.match(await readFile(result.backups[0], "utf8"), /steady-coder/);
  } finally {
    await rm(projectsDir, { force: true, recursive: true });
    await rm(backupsDir, { force: true, recursive: true });
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
          env: { PATH: fakeBin },
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

test("prepareLaunch repairs restore metadata before launching", async () => {
  const catalog = launchCatalog();
  const configDir = await mkdtemp(join(tmpdir(), "airkit-launch-restore-"));
  const projectsDir = await mkdtemp(join(tmpdir(), "airkit-launch-restore-projects-"));
  const backupsDir = await mkdtemp(join(tmpdir(), "airkit-launch-restore-backups-"));
  const projectDir = join(projectsDir, "-Users-example-project");

  try {
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      join(projectDir, "session.jsonl"),
      `${JSON.stringify({ type: "assistant", message: { role: "assistant", model: "demo,strong-coder" } })}\n`,
    );

    const result = await prepareLaunch(catalog, "launch-example", {
      backupsDir,
      ccrClient: ccrTestClient([]),
      commandExists: async (command) => ["ccr", "claude"].includes(command),
      configDir,
      env: { DEMO_API_KEY: "runtime-secret" },
      liveCcrConfig: join(configDir, "live", "config.json"),
      projectsDir,
      runtimeVersions: passingRuntimeVersions(),
      runCommand: async (command, args) => {
        if (command === "ccr" && args[0] === "activate") {
          return { ok: true, status: 0, stdout: 'export ANTHROPIC_AUTH_TOKEN="ccr-local"\n' };
        }
        return { ok: true, status: 0, stdout: "" };
      },
      spawnCommand: () => ({ status: 0 }),
    });

    assert.equal(result.restoreRepair.repairedFiles, 1);
    assert.match(await readFile(join(projectDir, "session.jsonl"), "utf8"), /"model":"claude-sonnet-4-6"/);
  } finally {
    await rm(configDir, { force: true, recursive: true });
    await rm(projectsDir, { force: true, recursive: true });
    await rm(backupsDir, { force: true, recursive: true });
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

test("runAirclaudeCli can repair restore metadata without launching", async () => {
  const catalogPath = await writeLaunchCatalog();
  const projectsDir = await mkdtemp(join(tmpdir(), "airkit-restore-cli-projects-"));
  const backupsDir = await mkdtemp(join(tmpdir(), "airkit-restore-cli-backups-"));
  const projectDir = join(projectsDir, "-Users-example-project");
  const output = [];

  try {
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      join(projectDir, "session.jsonl"),
      `${JSON.stringify({ type: "assistant", message: { role: "assistant", model: "strong-coder" } })}\n`,
    );

    const exitCode = await runAirclaudeCli(["--repair-restore", "--profile", "launch-example"], {
      backupsDir,
      catalogPath,
      projectsDir,
      stdout: { write: (chunk) => output.push(chunk) },
      spawnCommand: () => {
        throw new Error("repair should not launch");
      },
    });

    assert.equal(exitCode, 0);
    assert.match(output.join(""), /repaired files: 1/);
    assert.match(await readFile(join(projectDir, "session.jsonl"), "utf8"), /"model":"claude-sonnet-4-6"/);
  } finally {
    await rm(projectsDir, { force: true, recursive: true });
    await rm(backupsDir, { force: true, recursive: true });
    await rm(resolve(catalogPath, ".."), { force: true, recursive: true });
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
            { id: "steady-coder", pricingUsdPer1M: { input: 0.5 } },
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
            "--settings",
            "{\"apiKeyHelper\":\"\"}",
            "--append-system-prompt",
            "AirClaude mode {{launchMode}} routes default to {{routeDefaultModel}} while Claude restore uses {{restoreModel}}.",
          ],
          env: { CCR_PROFILE: "{{profileName}}" },
          restore: { model: "claude-sonnet-4-6", models: ["sonnet"] },
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
