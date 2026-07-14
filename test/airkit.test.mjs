import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import * as airkitRuntime from "../src/airkit.mjs";

import {
  buildCcrConfig,
  buildLaunchPlan,
  buildShellSnippet,
  doctorProfile,
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
  assert.equal(merged.config.Providers.find((provider) => provider.name === "demo").api_key, "resolved-at-runtime");
  assert.deepEqual(
    merged.config.profile.profiles
      .filter((candidate) => candidate.id.startsWith("airkit-launch-example-"))
      .map(({ id, model, scope, surface }) => ({ id, model, scope, surface })),
    [
      {
        id: "airkit-launch-example-auto",
        model: "demo/steady-coder",
        scope: "ccr",
        surface: "cli",
      },
      {
        id: "airkit-launch-example-fast",
        model: "demo/cheap-coder",
        scope: "ccr",
        surface: "cli",
      },
      {
        id: "airkit-launch-example-pro",
        model: "demo/strong-coder",
        scope: "ccr",
        surface: "cli",
      },
    ],
  );
  assert.ok(merged.config.profile.profiles.some((candidate) => candidate.id === "unrelated-profile"));
  assert.ok(merged.config.Router.rules.some((rule) => rule.id === "unrelated-rule"));
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
  assert.match(output.join(""), /Re-run with --write/);
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
  assert.match(prompt, /think: openai-compatible,reasoning-coder \(model reasoning-coder\)/);
  assert.match(prompt, /longContext: openai-compatible,long-context-coder \(model long-context-coder\)/);
  assert.match(prompt, /background: openai-compatible,fast-coder \(model fast-coder\)/);
  assert.match(prompt, /Claude restore\/display model is compatibility metadata only/);
});

test("managed files are installed and CCR config templates resolve to the config dir", async () => {
  const configDir = await mkdtemp(join(tmpdir(), "airkit-oss-managed-"));
  const previewDir = await mkdtemp(join(tmpdir(), "airkit-oss-managed-preview-"));
  const transformerPath = join(configDir, "ccr", "transformers", "drop-reasoning.js");
  const transformerContent = "module.exports = { profile: '{{profileName}}', root: '{{configDir}}' };\n";
  const catalog = {
    schema: 1,
    profiles: [
      {
        name: "custom-transformer",
        visibility: "public",
        summary: "Profile with a custom CCR transformer.",
        managedFiles: [
          {
            label: "drop reasoning transformer",
            path: "ccr/transformers/drop-reasoning.js",
            content: transformerContent,
          },
        ],
        ccr: {
          // Options for a custom (path-loaded) transformer MUST ride the top-level
          // transformers entry — CCR instantiates `new Require(path)(entry.options)` once and
          // stores the instance, so the `[name, {options}]` form in transformer.use would do
          // `new instance()` → "o is not a constructor" and drop the whole provider. The
          // renderer must preserve + template-substitute this options object.
          transformers: [
            {
              path: "{{configDir}}/ccr/transformers/drop-reasoning.js",
              options: { restoreModel: "{{profileName}}-1m" },
            },
          ],
          Providers: [
            {
              name: "custom",
              api_base_url: "https://example.invalid/v1/chat/completions",
              api_key: "$CUSTOM_API_KEY",
              models: ["steady-coder"],
              transformer: { use: ["drop-reasoning"] },
            },
          ],
          Router: { default: "custom,steady-coder" },
        },
      },
    ],
  };

  try {
    const config = buildCcrConfig(catalog, "custom-transformer", { configDir });
    const result = await installProfile(catalog, "custom-transformer", { configDir, write: true });
    const update = await updateProfile(catalog, "custom-transformer", { configDir, previewDir, write: false });

    assert.equal(config.transformers[0].path, transformerPath);
    // options preserved + template-substituted on the transformers entry (the only place CCR
    // accepts options for a path transformer); string-form use references the instance by name.
    assert.deepEqual(config.transformers[0].options, { restoreModel: "custom-transformer-1m" });
    assert.deepEqual(config.Providers[0].transformer.use, ["drop-reasoning"]);
    assert.deepEqual(result.files.managedFiles, [{ label: "drop reasoning transformer", path: transformerPath }]);
    assert.equal(update.files.managedFiles[0].label, "drop reasoning transformer");
    assert.equal(
      await readFile(transformerPath, "utf8"),
      `module.exports = { profile: 'custom-transformer', root: '${configDir}' };\n`,
    );
  } finally {
    await rm(previewDir, { force: true, recursive: true });
    await rm(configDir, { force: true, recursive: true });
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
              name: "cclaude-wrapper",
              command: "cclaude",
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
      new RegExp(`cclaude '--strict-mcp-config' '--mcp-config' '${escapeRegExp(configDir)}/claude/empty-mcp\\.json'`),
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
    assert.match(await readFile(result.files.shellSnippet.preview, "utf8"), /cclaude-example/);
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
    assert.match(output.join(""), /Usage: airkit/);
    assert.match(output.join(""), /airclaude/);
    assert.match(output.join(""), /init --profile/);
  }
});

test("buildLaunchPlan applies pro mode CCR routing overlay without mutating the catalog", async () => {
  const catalog = launchCatalog();
  const configDir = await mkdtemp(join(tmpdir(), "airkit-launch-plan-"));

  try {
    const plan = buildLaunchPlan(catalog, "launch-example", { configDir, mode: "pro" });

    assert.equal(plan.mode, "pro");
    assert.equal(plan.ccrConfig.Router.default, "demo,strong-coder");
    assert.equal(plan.ccrConfig.Router.think, "demo,strong-coder");
    assert.equal(plan.ccrConfig.Router.background, "demo,cheap-coder");
    assert.equal(catalog.profiles[0].ccr.Router.default, "demo,steady-coder");
    assert.deepEqual(plan.launch.args.slice(0, 3), [
      "--settings",
      "{\"apiKeyHelper\":\"\"}",
      "--append-system-prompt",
    ]);
    assert.match(
      plan.launch.args[3],
      /AirClaude mode pro routes default to strong-coder while Claude restore uses claude-sonnet-4-6\./,
    );
    assert.match(plan.launch.args[3], /AirKit reusable runtime lessons/);
    assert.match(plan.launch.args[3], /AirClaude active routing/);
    assert.match(plan.launch.args[3], /mode: pro/);
    assert.match(plan.launch.args[3], /default: demo,strong-coder \(model strong-coder\)/);
    assert.match(plan.launch.args[3], /think: demo,strong-coder \(model strong-coder\)/);
    assert.match(plan.launch.args[3], /longContext: demo,strong-coder \(model strong-coder\)/);
    assert.match(plan.launch.args[3], /background: demo,cheap-coder \(model cheap-coder\)/);
    assert.match(plan.launch.args[3], /Do not infer the active provider route from Claude Code's displayed model name/);
    assert.equal(plan.launch.env.AIRCLAUDE_PROFILE, "launch-example");
    assert.equal(plan.launch.env.AIRCLAUDE_MODE, "pro");
    assert.equal(plan.launch.env.AIRCLAUDE_ROUTE_DEFAULT, "demo,strong-coder");
    assert.equal(plan.launch.env.AIRCLAUDE_ROUTE_DEFAULT_MODEL, "strong-coder");
    assert.equal(plan.launch.env.AIRCLAUDE_ROUTE_THINK, "demo,strong-coder");
    assert.equal(plan.launch.env.AIRCLAUDE_ROUTE_LONG_CONTEXT_MODEL, "strong-coder");
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

test("runtime ships its bundled transformer for any provider that lists it in transformer.use", async () => {
  const catalog = launchCatalog();
  catalog.profiles[0].ccr.Providers[0].transformer = { use: ["drop-reasoning"] };
  const configDir = await mkdtemp(join(tmpdir(), "airkit-ship-transformer-"));

  try {
    const plan = buildLaunchPlan(catalog, "launch-example", { configDir });
    const injected = plan.files.managedFiles.find((file) => /ccr\/transformers\/drop-reasoning\.js$/.test(file.path));
    assert.ok(injected, "runtime should ship the drop-reasoning transformer it bundles when a provider uses it");
  } finally {
    await rm(configDir, { force: true, recursive: true });
  }
});

test("bundled drop-reasoning transformer fills missing usage tokens so context tracking and compact work", async () => {
  const require = createRequire(import.meta.url);
  const Transformer = require(resolve(import.meta.dirname, "..", "transformers", "drop-reasoning.cjs"));
  const instance = new Transformer();

  const streamResponse = new Response(
    [
      'event: message_start\ndata: {"type":"message_start","message":{"model":"steady-coder","usage":{"input_tokens":0,"output_tokens":0}}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello world, this is the model response."}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":0}}\n\n',
      "data: [DONE]\n\n",
    ].join(""),
    { headers: { "Content-Type": "text/event-stream" } },
  );

  const context = {
    req: { body: { system: "You are a helpful assistant.", messages: [{ role: "user", content: "x".repeat(8000) }] } },
  };

  const body = await (await instance.transformResponseOut(streamResponse, context)).text();
  const messageStart = JSON.parse(body.match(/data: (\{"type":"message_start".*?\})\n/)[1]);
  const messageDelta = JSON.parse(body.match(/data: (\{"type":"message_delta".*?\})\n/)[1]);

  assert.ok(messageStart.message.usage.input_tokens > 200, `input_tokens=${messageStart.message.usage.input_tokens}`);
  assert.ok(messageStart.message.usage.input_tokens < 20000, `input_tokens=${messageStart.message.usage.input_tokens}`);
  assert.ok(messageDelta.usage.output_tokens >= 1, `output_tokens=${messageDelta.usage.output_tokens}`);
});

test("bundled drop-reasoning transformer keeps real usage tokens when the provider reports them", async () => {
  const require = createRequire(import.meta.url);
  const Transformer = require(resolve(import.meta.dirname, "..", "transformers", "drop-reasoning.cjs"));
  const instance = new Transformer();

  const streamResponse = new Response(
    [
      'event: message_start\ndata: {"type":"message_start","message":{"model":"steady-coder","usage":{"input_tokens":4321,"output_tokens":0}}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{},"usage":{"output_tokens":99}}\n\n',
      "data: [DONE]\n\n",
    ].join(""),
    { headers: { "Content-Type": "text/event-stream" } },
  );

  const context = { req: { body: { messages: [{ role: "user", content: "short" }] } } };
  const body = await (await instance.transformResponseOut(streamResponse, context)).text();
  const messageStart = JSON.parse(body.match(/data: (\{"type":"message_start".*?\})\n/)[1]);
  const messageDelta = JSON.parse(body.match(/data: (\{"type":"message_delta".*?\})\n/)[1]);

  assert.equal(messageStart.message.usage.input_tokens, 4321);
  assert.equal(messageDelta.usage.output_tokens, 99);
});

test("bundled drop-reasoning transformer synthesizes usage for an OpenAI-format stream that omits it", async () => {
  const require = createRequire(import.meta.url);
  const Transformer = require(resolve(import.meta.dirname, "..", "transformers", "drop-reasoning.cjs"));
  const instance = new Transformer();

  // Real LiteLLM/OpenAI gateway shape: data-only SSE, chat.completion.chunk, no usage anywhere.
  const streamResponse = new Response(
    [
      'data: {"id":"x","object":"chat.completion.chunk","model":"deepseek-v3.2","choices":[{"index":0,"delta":{"role":"assistant","content":""}}]}\n\n',
      'data: {"id":"x","object":"chat.completion.chunk","model":"deepseek-v3.2","choices":[{"index":0,"delta":{"content":"Hello world response"}}]}\n\n',
      'data: {"id":"x","object":"chat.completion.chunk","model":"deepseek-v3.2","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
      "data: [DONE]\n\n",
    ].join(""),
    { headers: { "Content-Type": "text/event-stream" } },
  );

  const context = {
    req: { body: { system: "You are a helpful assistant.", messages: [{ role: "user", content: "x".repeat(8000) }] } },
  };

  const body = await (await instance.transformResponseOut(streamResponse, context)).text();
  const usageChunk = body
    .split("\n")
    .filter((line) => line.startsWith("data: ") && line.slice(6).trim() !== "[DONE]")
    .map((line) => JSON.parse(line.slice(6)))
    .find((chunk) => chunk.usage && typeof chunk.usage.prompt_tokens === "number");

  assert.ok(usageChunk, "an OpenAI chunk must carry synthesized usage so CCR's converter can read it");
  assert.ok(usageChunk.usage.prompt_tokens > 200, `prompt_tokens=${usageChunk.usage.prompt_tokens}`);
  assert.ok(usageChunk.usage.prompt_tokens < 20000, `prompt_tokens=${usageChunk.usage.prompt_tokens}`);
  assert.ok(usageChunk.usage.completion_tokens >= 1, `completion_tokens=${usageChunk.usage.completion_tokens}`);
});

test("bundled drop-reasoning transformer keeps real OpenAI usage when the gateway reports it", async () => {
  const require = createRequire(import.meta.url);
  const Transformer = require(resolve(import.meta.dirname, "..", "transformers", "drop-reasoning.cjs"));
  const instance = new Transformer();

  const streamResponse = new Response(
    [
      'data: {"id":"x","object":"chat.completion.chunk","model":"deepseek-v3.2","choices":[{"index":0,"delta":{"content":"hi"}}]}\n\n',
      'data: {"id":"x","object":"chat.completion.chunk","model":"deepseek-v3.2","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1234,"completion_tokens":88,"total_tokens":1322}}\n\n',
      "data: [DONE]\n\n",
    ].join(""),
    { headers: { "Content-Type": "text/event-stream" } },
  );

  const context = { req: { body: { messages: [{ role: "user", content: "short" }] } } };
  const body = await (await instance.transformResponseOut(streamResponse, context)).text();
  const usageChunk = body
    .split("\n")
    .filter((line) => line.startsWith("data: ") && line.slice(6).trim() !== "[DONE]")
    .map((line) => JSON.parse(line.slice(6)))
    .find((chunk) => chunk.usage && typeof chunk.usage.prompt_tokens === "number");

  assert.ok(usageChunk, "the real usage chunk must survive");
  assert.equal(usageChunk.usage.prompt_tokens, 1234);
  assert.equal(usageChunk.usage.completion_tokens, 88);
});

test("bundled drop-reasoning transformer does not pre-synthesize usage when the gateway sends it in a trailing chunk", async () => {
  const require = createRequire(import.meta.url);
  const Transformer = require(resolve(import.meta.dirname, "..", "transformers", "drop-reasoning.cjs"));
  const instance = new Transformer();

  // include_usage shape: real usage arrives in a SEPARATE chunk (choices:[]) AFTER finish_reason.
  // Synthesizing on the finish chunk would emit an estimate that races/duplicates the real usage,
  // so the finish chunk must stay usage-free and only the trailing real chunk should carry usage.
  const streamResponse = new Response(
    [
      'data: {"id":"x","object":"chat.completion.chunk","model":"deepseek-v3.2","choices":[{"index":0,"delta":{"content":"hi there"}}]}\n\n',
      'data: {"id":"x","object":"chat.completion.chunk","model":"deepseek-v3.2","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
      'data: {"id":"x","object":"chat.completion.chunk","model":"deepseek-v3.2","choices":[],"usage":{"prompt_tokens":1234,"completion_tokens":88,"total_tokens":1322}}\n\n',
      "data: [DONE]\n\n",
    ].join(""),
    { headers: { "Content-Type": "text/event-stream" } },
  );

  const context = { req: { body: { system: "x".repeat(8000), messages: [{ role: "user", content: "short" }] } } };
  const body = await (await instance.transformResponseOut(streamResponse, context)).text();
  const usageChunks = body
    .split("\n")
    .filter((line) => line.startsWith("data: ") && line.slice(6).trim() !== "[DONE]")
    .map((line) => JSON.parse(line.slice(6)))
    .filter((chunk) => chunk.usage && typeof chunk.usage.prompt_tokens === "number");

  assert.equal(usageChunks.length, 1, "only the gateway's real usage chunk should carry usage — no pre-synthesized estimate");
  assert.equal(usageChunks[0].usage.prompt_tokens, 1234);
  assert.equal(usageChunks[0].usage.completion_tokens, 88);
});

test("bundled drop-reasoning transformer asks the gateway to stream usage on streaming requests", async () => {
  const require = createRequire(import.meta.url);
  const Transformer = require(resolve(import.meta.dirname, "..", "transformers", "drop-reasoning.cjs"));
  const instance = new Transformer();

  // Provider streams OpenAI but omits usage; request include_usage so the gateway emits a final
  // usage chunk (real prompt/completion tokens, and cache tokens if it reports them). The built-in
  // "streamoptions" transformer cannot be listed in this provider's use (it breaks registration), so
  // we set it ourselves on the OpenAI request body that transformRequestIn receives.
  const streamed = await instance.transformRequestIn({ stream: true, messages: [{ role: "user", content: "hi" }] });
  assert.deepEqual(streamed.stream_options, { include_usage: true });

  const nonStreamed = await instance.transformRequestIn({ messages: [{ role: "user", content: "hi" }] });
  assert.equal(nonStreamed.stream_options, undefined);
});

test("bundled drop-reasoning transformer preserves a cache-only usage chunk instead of synthesizing over it", async () => {
  const require = createRequire(import.meta.url);
  const Transformer = require(resolve(import.meta.dirname, "..", "transformers", "drop-reasoning.cjs"));
  const instance = new Transformer();

  // A gateway may report usage with cached_tokens but a 0/absent prompt_tokens on the finish chunk.
  // That is still real provider usage — synthesis must defer to it so cached_tokens reaches CCR.
  const streamResponse = new Response(
    [
      'data: {"id":"x","object":"chat.completion.chunk","model":"deepseek-v3.2","choices":[{"index":0,"delta":{"content":"hi"}}]}\n\n',
      'data: {"id":"x","object":"chat.completion.chunk","model":"deepseek-v3.2","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":0,"completion_tokens":0,"prompt_tokens_details":{"cached_tokens":900}}}\n\n',
      "data: [DONE]\n\n",
    ].join(""),
    { headers: { "Content-Type": "text/event-stream" } },
  );

  const context = { req: { body: { system: "x".repeat(8000), messages: [{ role: "user", content: "short" }] } } };
  const body = await (await instance.transformResponseOut(streamResponse, context)).text();
  const usageChunk = body
    .split("\n")
    .filter((line) => line.startsWith("data: ") && line.slice(6).trim() !== "[DONE]")
    .map((line) => JSON.parse(line.slice(6)))
    .find((chunk) => chunk.usage && chunk.usage.prompt_tokens_details);

  assert.ok(usageChunk, "the cache-bearing usage chunk must survive");
  assert.equal(usageChunk.usage.prompt_tokens_details.cached_tokens, 900);
  // synthesis (which would write prompt_tokens = the ~2000 input estimate and drop the cache field)
  // must NOT have run — the original prompt_tokens:0 is preserved untouched.
  assert.equal(usageChunk.usage.prompt_tokens, 0);
});

test("bundled drop-reasoning transformer strips reasoning_content from an OpenAI-format stream", async () => {
  const require = createRequire(import.meta.url);
  const Transformer = require(resolve(import.meta.dirname, "..", "transformers", "drop-reasoning.cjs"));
  const instance = new Transformer();

  // A deepseek-style reasoning model interleaves reasoning_content with content and tool calls.
  // If reasoning_content survives, CCR's converter injects a `thinking` block and bumps the
  // content-block index, so Claude Code's accumulator throws "Content block is not a text block".
  const streamResponse = new Response(
    [
      'data: {"id":"x","object":"chat.completion.chunk","model":"deepseek-v4-pro","choices":[{"index":0,"delta":{"reasoning_content":"Let me think about the query first."}}]}\n\n',
      'data: {"id":"x","object":"chat.completion.chunk","model":"deepseek-v4-pro","choices":[{"index":0,"delta":{"content":"Running the query now."}}]}\n\n',
      'data: {"id":"x","object":"chat.completion.chunk","model":"deepseek-v4-pro","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"name":"Bash","arguments":"{}"}}]}}]}\n\n',
      'data: {"id":"x","object":"chat.completion.chunk","model":"deepseek-v4-pro","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n',
      "data: [DONE]\n\n",
    ].join(""),
    { headers: { "Content-Type": "text/event-stream" } },
  );

  const context = { req: { body: { messages: [{ role: "user", content: "x".repeat(400) }] } } };
  const body = await (await instance.transformResponseOut(streamResponse, context)).text();

  assert.ok(!body.includes("reasoning_content"), "reasoning_content must not survive the streamed OpenAI chunks");
  assert.ok(body.includes("Running the query now."), "visible content must be preserved");
  assert.ok(body.includes('"name":"Bash"'), "tool calls must be preserved");
});

test("bundled drop-reasoning transformer drops a whitespace-only content delta after tool_calls", async () => {
  const require = createRequire(import.meta.url);
  const Transformer = require(resolve(import.meta.dirname, "..", "transformers", "drop-reasoning.cjs"));
  const instance = new Transformer();

  // Observed deepseek-v3.2 shape: after the final tool_call's arguments, the model emits a trailing
  // content:"\n". CCR's converter appends it as a text_delta to the still-open tool_use block, so
  // Claude Code throws "Content block is not a text block". The transformer must drop that content.
  const streamResponse = new Response(
    [
      'data: {"id":"x","object":"chat.completion.chunk","model":"deepseek-v3.2","choices":[{"index":0,"delta":{"content":"Listing dirs."}}]}\n\n',
      'data: {"id":"x","object":"chat.completion.chunk","model":"deepseek-v3.2","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"Bash","arguments":"{\\"command\\":\\"ls\\"}"}}]}}]}\n\n',
      'data: {"id":"x","object":"chat.completion.chunk","model":"deepseek-v3.2","choices":[{"index":0,"delta":{"content":"\\n"}}]}\n\n',
      'data: {"id":"x","object":"chat.completion.chunk","model":"deepseek-v3.2","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n',
      "data: [DONE]\n\n",
    ].join(""),
    { headers: { "Content-Type": "text/event-stream" } },
  );

  const context = { req: { body: { messages: [{ role: "user", content: "short" }] } } };
  const body = await (await instance.transformResponseOut(streamResponse, context)).text();
  const contentValues = body
    .split("\n")
    .filter((line) => line.startsWith("data: ") && line.slice(6).trim() !== "[DONE]")
    .map((line) => { try { return JSON.parse(line.slice(6)); } catch { return null; } })
    .filter(Boolean)
    .flatMap((c) => (c.choices ?? []).map((ch) => ch?.delta?.content))
    .filter((v) => typeof v === "string");

  // The leading real text survives; the trailing whitespace-after-tool_call is gone.
  assert.deepEqual(contentValues, ["Listing dirs."], "only the pre-tool text content should remain");
  assert.ok(body.includes('"name":"Bash"'), "the tool call must be preserved");
});

test("bundled drop-reasoning transformer strips reasoning_content from a non-streamed OpenAI response", async () => {
  const require = createRequire(import.meta.url);
  const Transformer = require(resolve(import.meta.dirname, "..", "transformers", "drop-reasoning.cjs"));
  const instance = new Transformer();

  const jsonResponse = new Response(
    JSON.stringify({
      id: "x",
      object: "chat.completion",
      model: "deepseek-v4-pro",
      choices: [{ index: 0, message: { role: "assistant", content: "Answer.", reasoning_content: "Hidden reasoning." } }],
    }),
    { headers: { "Content-Type": "application/json" } },
  );

  const context = { req: { body: { messages: [{ role: "user", content: "short" }] } } };
  const body = await (await instance.transformResponseOut(jsonResponse, context)).text();

  assert.ok(!body.includes("reasoning_content"), "reasoning_content must not survive the JSON response");
  assert.ok(body.includes("Answer."), "visible content must be preserved");
});

test("bundled drop-reasoning transformer routes the auto-mode classifier to the configured model", async () => {
  const require = createRequire(import.meta.url);
  const Transformer = require(resolve(import.meta.dirname, "..", "transformers", "drop-reasoning.cjs"));
  const instance = new Transformer({ classifierModel: "gpt-5.4-mini" });

  // Claude Code's auto-mode permission classifier fingerprint: a side query whose system prompt
  // opens with this exact sentence. Through CCR it carries an Opus model id and would otherwise
  // fall through to Router.default.
  const classifierString = await instance.transformRequestIn({
    model: "claude-opus-4-8",
    system: "You are a security monitor for autonomous AI coding agents. Decide whether to block.",
    messages: [{ role: "user", content: "ran: rm -rf /" }],
  });
  assert.equal(classifierString.model, "gpt-5.4-mini", "string-system classifier request must be rerouted");

  const classifierBlocks = await instance.transformRequestIn({
    model: "claude-opus-4-8",
    system: [{ type: "text", text: "You are a security monitor for autonomous AI coding agents." }],
    messages: [{ role: "user", content: "x" }],
  });
  assert.equal(classifierBlocks.model, "gpt-5.4-mini", "block-array-system classifier request must be rerouted");

  // Normal traffic must be untouched.
  const normal = await instance.transformRequestIn({
    model: "claude-sonnet-4-6",
    system: "You are Claude Code, a helpful coding assistant.",
    messages: [{ role: "user", content: "fix the bug" }],
  });
  assert.equal(normal.model, "claude-sonnet-4-6", "non-classifier traffic must not be rerouted");
});

test("bundled drop-reasoning transformer leaves the classifier model alone when no classifierModel is set", async () => {
  const require = createRequire(import.meta.url);
  const Transformer = require(resolve(import.meta.dirname, "..", "transformers", "drop-reasoning.cjs"));
  const instance = new Transformer();

  const out = await instance.transformRequestIn({
    model: "claude-opus-4-8",
    system: "You are a security monitor for autonomous AI coding agents.",
    messages: [{ role: "user", content: "x" }],
  });
  assert.equal(out.model, "claude-opus-4-8", "without classifierModel the request model is unchanged");
});

test("bundled drop-reasoning transformer masks provider models and tool names for Claude Code restore", async () => {
  const require = createRequire(import.meta.url);
  const Transformer = require(resolve(import.meta.dirname, "..", "transformers", "drop-reasoning.cjs"));
  const instance = new Transformer();

  const longToolName = "mcp__plugin_atlassian_atlassian__createCompassComponentRelationship";
  const request = {
    tools: [
      {
        type: "function",
        function: {
          name: longToolName,
          description: "Create a Compass component relationship. " + "x".repeat(1200),
          parameters: { type: "object", properties: {} },
        },
      },
    ],
    tool_choice: { type: "function", function: { name: longToolName } },
  };
  const transformedRequest = await instance.transformRequestIn(request);
  const providerToolName = transformedRequest.tools[0].function.name;

  assert.match(providerToolName, /^airtool_[a-z0-9_]+$/);
  assert.ok(providerToolName.length <= 64);
  assert.equal(transformedRequest.tool_choice.function.name, providerToolName);
  assert.notEqual(providerToolName, longToolName);
  assert.ok(transformedRequest.tools[0].function.description.length <= 1024);
  assert.match(transformedRequest.tools[0].function.description, new RegExp(longToolName));

  const jsonResponse = new Response(JSON.stringify({ model: "some-provider-model", choices: [] }), {
    headers: { "Content-Type": "application/json" },
  });
  assert.equal((await (await instance.transformResponseOut(jsonResponse)).json()).model, "claude-sonnet-4-6");

  const toolResponse = new Response(
    JSON.stringify({
      model: "some-provider-model",
      choices: [{ message: { tool_calls: [{ id: "call_1", type: "function", function: { name: providerToolName, arguments: "{}" } }] } }],
    }),
    { headers: { "Content-Type": "application/json" } },
  );
  const restoredToolBody = await (await instance.transformResponseOut(toolResponse)).json();
  assert.equal(restoredToolBody.choices[0].message.tool_calls[0].function.name, longToolName);

  const streamResponse = new Response('data: {"model":"some-provider-model","choices":[]}\n\ndata: [DONE]\n\n', {
    headers: { "Content-Type": "text/event-stream" },
  });
  const streamBody = await (await instance.transformResponseOut(streamResponse)).text();
  assert.match(streamBody, /"model":"claude-sonnet-4-6"/);
  assert.doesNotMatch(streamBody, /some-provider-model/);

  const thinkingStream = new Response(
    [
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"redacted_thinking","data":"secret"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"hidden reasoning"}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
    ].join(""),
    { headers: { "Content-Type": "text/event-stream" } },
  );
  const sanitizedThinkingBody = await (await instance.transformResponseOut(thinkingStream)).text();
  assert.match(sanitizedThinkingBody, /"content_block":\{"type":"text","text":""\}/);
  assert.match(sanitizedThinkingBody, /"delta":\{"type":"text_delta","text":"\[reasoning omitted\]"\}/);
  assert.doesNotMatch(sanitizedThinkingBody, /redacted_thinking|thinking_delta|hidden reasoning|secret/);
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
    assert.equal(result.liveCcrConfig.status, "would-sync");
  } finally {
    await rm(configDir, { force: true, recursive: true });
  }
});

test("prepareLaunch writes managed files, syncs live CCR config, and preserves passthrough args", async () => {
  const catalog = launchCatalog();
  const configDir = await mkdtemp(join(tmpdir(), "airkit-launch-write-"));
  const liveCcrConfig = join(configDir, "live", "config.json");
  const spawned = [];

  try {
    const result = await prepareLaunch(catalog, "launch-example", {
      configDir,
      liveCcrConfig,
      mode: "pro",
      env: {},
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
    assert.equal(result.liveCcrConfig.status, "synced");
    assert.match(await readFile(liveCcrConfig, "utf8"), /strong-coder/);
    assert.equal(spawned.length, 1);
    assert.equal(spawned[0].command, "claude");
    assert.deepEqual(spawned[0].args.slice(0, 3), [
      "--settings",
      "{\"apiKeyHelper\":\"\"}",
      "--append-system-prompt",
    ]);
    assert.match(
      spawned[0].args[3],
      /AirClaude mode pro routes default to strong-coder while Claude restore uses claude-sonnet-4-6\./,
    );
    assert.match(spawned[0].args[3], /AirKit reusable runtime lessons/);
    assert.match(spawned[0].args[3], /AirClaude active routing/);
    assert.match(spawned[0].args[3], /mode: pro/);
    assert.match(spawned[0].args[3], /background: demo,cheap-coder \(model cheap-coder\)/);
    // airclaude pins the masked restore model as --model so FRESH sessions get the
  // masked window too; user passthrough args still follow (and would override).
  assert.equal(spawned[0].args[4], "--model");
  assert.equal(spawned[0].args[5], "claude-sonnet-4-6");
  assert.equal(spawned[0].args.at(-1), "--dangerously-skip-permissions");
    assert.deepEqual(spawned[0].env, {
      ANTHROPIC_BASE_URL: "http://127.0.0.1:3456",
      AIRCLAUDE_MODE: "pro",
      AIRCLAUDE_PROFILE: "launch-example",
      AIRCLAUDE_RESTORE_MODEL: "claude-sonnet-4-6",
      AIRCLAUDE_ROUTE_BACKGROUND: "demo,cheap-coder",
      AIRCLAUDE_ROUTE_BACKGROUND_MODEL: "cheap-coder",
      AIRCLAUDE_ROUTE_BACKGROUND_PROVIDER: "demo",
      AIRCLAUDE_ROUTE_DEFAULT: "demo,strong-coder",
      AIRCLAUDE_ROUTE_DEFAULT_MODEL: "strong-coder",
      AIRCLAUDE_ROUTE_DEFAULT_PROVIDER: "demo",
      AIRCLAUDE_ROUTE_LONG_CONTEXT: "demo,strong-coder",
      AIRCLAUDE_ROUTE_LONG_CONTEXT_MODEL: "strong-coder",
      AIRCLAUDE_ROUTE_LONG_CONTEXT_PROVIDER: "demo",
      AIRCLAUDE_ROUTE_THINK: "demo,strong-coder",
      AIRCLAUDE_ROUTE_THINK_MODEL: "strong-coder",
      AIRCLAUDE_ROUTE_THINK_PROVIDER: "demo",
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

test("prepareLaunch resolves ccrTokenOpRef through op only for CCR restart", async () => {
  const catalog = launchCatalog();
  catalog.profiles[0].shell = { ccrTokenOpRef: "op://Test/API/token" };
  const configDir = await mkdtemp(join(tmpdir(), "airkit-launch-op-"));
  const calls = [];
  const spawned = [];

  try {
    const result = await prepareLaunch(catalog, "launch-example", {
      configDir,
      liveCcrConfig: join(configDir, "live", "config.json"),
      commandExists: async (command) => ["ccr", "claude", "op"].includes(command),
      env: {},
      runCommand: async (command, args, options = {}) => {
        calls.push({ command, args, token: options.env?.ANTHROPIC_AUTH_TOKEN });
        if (command === "op") return { ok: true, status: 0, stdout: "resolved-token" };
        if (command === "ccr" && args[0] === "activate") {
          return { ok: true, status: 0, stdout: 'export ANTHROPIC_AUTH_TOKEN="ccr-local"\n' };
        }
        return { ok: true, status: 0, stdout: "" };
      },
      spawnCommand: (command, args, options) => {
        spawned.push({ command, args, token: options.env.ANTHROPIC_AUTH_TOKEN });
        return { status: 0 };
      },
    });

    assert.equal(result.runtime.ccr.ok, true);
    assert.deepEqual(calls, [
      { command: "op", args: ["read", "op://Test/API/token", "--no-newline"], token: undefined },
      { command: "ccr", args: ["restart"], token: "resolved-token" },
      { command: "ccr", args: ["activate"], token: undefined },
    ]);
    assert.equal(spawned[0].token, "ccr-local");
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
          commandExists: async (command) => ["ccr", "claude", "op"].includes(command),
          commandTimeoutMs: 50,
          configDir,
          env: { PATH: fakeBin },
          liveCcrConfig: join(configDir, "live", "config.json"),
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
      commandExists: async (command) => ["ccr", "claude"].includes(command),
      configDir,
      env: {},
      liveCcrConfig: join(configDir, "live", "config.json"),
      projectsDir,
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
    assert.match(output.join(""), /Usage: airclaude/);
    assert.match(output.join(""), /airclaude pro/);
    assert.match(output.join(""), /--doctor/);
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
                  think: "demo,strong-coder",
                  longContext: "demo,strong-coder",
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
              api_base_url: "https://example.invalid/v1/chat/completions",
              api_key: "$DEMO_API_KEY",
              models: ["cheap-coder", "steady-coder", "strong-coder"],
            },
          ],
          Router: {
            default: "demo,steady-coder",
            background: "demo,cheap-coder",
            think: "demo,steady-coder",
            longContext: "demo,steady-coder",
          },
        },
      },
    ],
  };
}

async function writeLaunchCatalog() {
  const dir = await mkdtemp(join(tmpdir(), "airkit-launch-catalog-"));
  const path = join(dir, "catalog.json");
  await writeFile(path, `${JSON.stringify(launchCatalog(), null, 2)}\n`);
  return path;
}
