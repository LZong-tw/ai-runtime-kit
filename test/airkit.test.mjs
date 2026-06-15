import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

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

test("buildShellSnippet syncs the rendered CCR config before launching wrappers", async () => {
  const catalog = await loadCatalog();
  const configDir = await mkdtemp(join(tmpdir(), "airkit-oss-sync-"));

  try {
    const snippet = buildShellSnippet(catalog, profile, { configDir });

    assert.match(snippet, /AIRKIT_CCR_CONFIG_OPENAI_COMPATIBLE_EXAMPLE=/);
    assert.match(snippet, /airkit-sync-ccr-config-openai-compatible-example/);
    assert.match(snippet, /cclaude-example\(\) \{/);
    assert.match(snippet, /airkit-sync-ccr-config-openai-compatible-example \|\| return/);
    assert.match(snippet, /--append-system-prompt/);
    assert.match(snippet, /AirKit reusable runtime lessons/);
  } finally {
    await rm(configDir, { force: true, recursive: true });
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
});

test("installed shell snippet can sync the rendered CCR config into CCR live config", async () => {
  const catalog = await loadCatalog();
  const configDir = await mkdtemp(join(tmpdir(), "airkit-oss-install-"));

  try {
    const result = await installProfile(catalog, profile, { configDir, write: true });
    const liveConfig = join(configDir, "live", "config.json");
    const syncResult = spawnSync(
      "zsh",
      [
        "-fc",
        'source "$1" && AIRKIT_CCR_LIVE_CONFIG="$2" airkit-sync-ccr-config-openai-compatible-example',
        "airkit-sync-test",
        result.files.shellSnippet,
        liveConfig,
      ],
      { encoding: "utf8" },
    );

    assert.equal(syncResult.status, 0, syncResult.stderr);
    assert.match(await readFile(liveConfig, "utf8"), /steady-coder/);
  } finally {
    await rm(configDir, { force: true, recursive: true });
  }
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
          transformers: [{ path: "{{configDir}}/ccr/transformers/drop-reasoning.js" }],
          Providers: [
            {
              name: "custom",
              api_base_url: "https://example.invalid/v1/chat/completions",
              api_key: "$CUSTOM_API_KEY",
              models: ["steady-coder"],
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
    assert.equal(spawned[0].args[4], "--dangerously-skip-permissions");
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
          },
        },
        ccr: {
          APIKEY: "ccr-local",
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
