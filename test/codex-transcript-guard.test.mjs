import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  inspectCodexTranscriptGuard,
  repairCodexTranscriptGuard,
} from "../src/codex-transcript-guard.mjs";
import { runCli } from "../src/airkit.mjs";

const legacyTrackedJobs = `export function createProgressReporter({ stderr = false } = {}) {
  return (event) => {
    const stderrMessage = event.stderrMessage ?? event.message;
    if (stderr && stderrMessage) {
      process.stderr.write(\`[codex] \${stderrMessage}\\n\`);
    }
  };
}
`;

const legacyCodex = `function describeStartedItem(item) {
  switch (item.type) {
    case "dynamicToolCall":
      return { message: \`Running tool: \${item.tool}.\`, phase: "investigating" };
  }
}

function describeCompletedItem(item) {
  switch (item.type) {
    case "dynamicToolCall":
      return { message: \`Tool \${item.tool} \${item.status}.\`, phase: "investigating" };
  }
}
`;

async function installedPluginFixture() {
  const home = await mkdtemp(join(tmpdir(), "airkit-codex-transcript-"));
  const installPath = join(home, ".claude", "plugins", "cache", "openai-codex", "codex", "1.0.6");
  const sourceDir = join(installPath, "scripts", "lib");
  await mkdir(sourceDir, { recursive: true });
  await writeFile(join(sourceDir, "tracked-jobs.mjs"), legacyTrackedJobs);
  await writeFile(join(sourceDir, "codex.mjs"), legacyCodex);
  await writeFile(join(home, ".claude", "plugins", "installed_plugins.json"), `${JSON.stringify({
    version: 2,
    plugins: {
      "codex@openai-codex": [{ scope: "user", installPath, version: "1.0.6" }],
    },
  })}\n`);
  return { home, installPath, sourceDir };
}

test("transcript guard previews only the known OpenAI Codex dynamic-tool implementation", async () => {
  const fixture = await installedPluginFixture();
  const result = await inspectCodexTranscriptGuard({ env: { HOME: fixture.home } });

  assert.equal(result.state, "repairable");
  assert.equal(result.write, false);
  assert.deepEqual(result.actions, ["suppress-dynamic-tool-progress-from-stderr"]);
  assert.equal(result.affectedPaths.length, 2);
  assert.match(await readFile(join(fixture.sourceDir, "tracked-jobs.mjs"), "utf8"), /if \(stderr && stderrMessage\)/);
});

test("transcript guard backs up and repairs the known implementation without removing job-log progress", async () => {
  const fixture = await installedPluginFixture();
  const result = await repairCodexTranscriptGuard({
    env: { HOME: fixture.home },
    write: true,
    now: () => new Date("2026-08-10T08:00:00.000Z"),
  });

  assert.equal(result.state, "protected");
  assert.equal(result.write, true);
  assert.equal(result.backupPaths.length, 2);
  const trackedJobs = await readFile(join(fixture.sourceDir, "tracked-jobs.mjs"), "utf8");
  const codex = await readFile(join(fixture.sourceDir, "codex.mjs"), "utf8");
  assert.match(trackedJobs, /if \(stderr && !event\.hideFromStderr && stderrMessage\)/);
  assert.match(codex, /Running tool: \$\{item\.tool\}\.`, phase: "investigating", hideFromStderr: true/);
  assert.match(codex, /Tool \$\{item\.tool\} \$\{item\.status\}\.`, phase: "investigating", hideFromStderr: true/);
  assert.match(await readFile(result.backupPaths[0], "utf8"), /stderr && stderrMessage/);
});

test("transcript guard refuses an unrecognized plugin implementation", async () => {
  const fixture = await installedPluginFixture();
  await writeFile(join(fixture.sourceDir, "codex.mjs"), "export const changedUpstream = true;\n");

  const result = await repairCodexTranscriptGuard({ env: { HOME: fixture.home }, write: true });

  assert.equal(result.state, "unsupported");
  assert.equal(result.write, false);
  assert.equal(result.backupPaths.length, 0);
  assert.equal(await readFile(join(fixture.sourceDir, "codex.mjs"), "utf8"), "export const changedUpstream = true;\n");
});

test("transcript guard ignores a registry entry outside Claude's OpenAI plugin cache", async () => {
  const fixture = await installedPluginFixture();
  await writeFile(join(fixture.home, ".claude", "plugins", "installed_plugins.json"), `${JSON.stringify({
    version: 2,
    plugins: {
      "codex@openai-codex": [{ scope: "user", installPath: join(fixture.home, "untrusted"), version: "1.0.6" }],
    },
  })}\n`);

  const result = await inspectCodexTranscriptGuard({ env: { HOME: fixture.home } });

  assert.equal(result.state, "unsupported");
  assert.equal(result.affectedPaths.length, 0);
});

test("repair command previews the guard and requires --write before changing a plugin", async () => {
  let output = "";
  const seen = [];
  const exitCode = await runCli(["repair", "codex-transcript"], {
    env: { HOME: "/fixture" },
    repairCodexTranscriptGuard: async (options) => {
      seen.push(options);
      return {
        state: "repairable",
        write: options.write,
        actions: ["suppress-dynamic-tool-progress-from-stderr"],
        affectedPaths: ["/fixture/.claude/plugins/cache/openai-codex/codex/1.0.6/scripts/lib/codex.mjs"],
        backupPaths: [],
      };
    },
    stdout: { write: (text) => { output += text; } },
  });

  assert.equal(exitCode, 0);
  assert.equal(seen[0].write, false);
  assert.match(output, /Preview Codex transcript guard/);
  assert.match(output, /repair codex-transcript --write/);
});
