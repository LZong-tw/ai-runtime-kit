#!/usr/bin/env node

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function captureCodexContract({
  output,
  codexCommand = process.env.CODEX_COMMAND ?? "codex",
  now = () => new Date(),
} = {}) {
  if (typeof output !== "string" || output.length === 0) throw new TypeError("--output is required");
  const isolatedHome = await mkdtemp(join(tmpdir(), "airkit-codex-contract-"));
  try {
    const env = { ...process.env, CODEX_HOME: isolatedHome };
    const versionResult = await execFileAsync(codexCommand, ["--version"], {
      env,
      timeout: 15_000,
      maxBuffer: 32 * 1024,
    });
    const helpResult = await execFileAsync(codexCommand, ["exec", "--help"], {
      env,
      timeout: 15_000,
      maxBuffer: 64 * 1024,
    });
    const version = String(versionResult.stdout).match(/\d+\.\d+\.\d+(?:[-.][0-9A-Za-z.-]+)?/)?.[0];
    if (!version) throw new Error("Codex version is unavailable");
    const help = `${versionResult.stdout}\n${helpResult.stdout}\n${helpResult.stderr}`;
    const contract = {
      contractVersion: 1,
      codexVersion: version,
      capturedAt: now().toISOString(),
      source: "installed-codex-cli-contract",
      responses_route_supported: false,
      observed_cli_shapes: {
        session_meta: ["id", "cli_version", "source", "model_provider"],
        event_msg: ["task_started", "task_complete", "token_count"],
        response_item: ["type", "role"],
        token_usage: ["input_tokens", "cached_input_tokens", "output_tokens", "reasoning_output_tokens", "total_tokens"],
      },
      probe: {
        exec_help_available: help.includes("codex exec") || help.includes("--json"),
        provider_attempts_observed: false,
      },
      redaction: {
        payload: "metadata_only",
        omitted: ["prompt", "response_text", "tool_input", "tool_output", "credentials", "local_paths"],
      },
    };
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, `${JSON.stringify(contract, null, 2)}\n`, { mode: 0o600 });
    return contract;
  } finally {
    await rm(isolatedHome, { recursive: true, force: true });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const outputIndex = process.argv.indexOf("--output");
  const output = outputIndex >= 0 ? process.argv[outputIndex + 1] : null;
  captureCodexContract({ output }).catch((error) => {
    console.error(`capture-codex-audit-contract: ${error.message}`);
    process.exitCode = 1;
  });
}
