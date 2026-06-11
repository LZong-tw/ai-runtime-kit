import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildCcrConfig,
  buildShellSnippet,
  doctorProfile,
  installProfile,
  loadCatalog,
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
  } finally {
    await rm(configDir, { force: true, recursive: true });
  }
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

    assert.ok(
      snippet.includes(
        `  cclaude '--strict-mcp-config' '--mcp-config' '${configDir}/claude/empty-mcp.json' "$@"`,
      ),
    );
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

function runAirkitWithEnv(env, ...args) {
  return spawnSync(process.execPath, [resolve(import.meta.dirname, "..", "src", "airkit.mjs"), ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}
