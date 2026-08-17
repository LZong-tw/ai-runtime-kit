#!/usr/bin/env node

import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { promisify } from "node:util";

export const PI_AUDIT_EVENT_TYPES = Object.freeze([
  "session_start",
  "before_agent_start",
  "turn_start",
  "turn_end",
]);

export function buildPiAuditContract(piVersion, { capturedAt = new Date().toISOString() } = {}) {
  const version = String(piVersion).trim().match(/\d+\.\d+\.\d+/)?.[0];
  if (!version) throw new Error("Pi version is unavailable");
  return {
    contractVersion: 1,
    piVersion: version,
    capturedAt,
    source: "installed-pi-extension-contract",
    events: [
      { type: "session_start", fields: ["session_id", "hasUI"] },
      { type: "before_agent_start", fields: ["prompt_bytes", "session_id"] },
      { type: "turn_start", fields: ["turn_id", "session_id"] },
      { type: "turn_end", fields: ["turn_id", "usage", "session_id"] },
    ],
    redaction: {
      payload: "metadata_only",
      omitted: ["prompt", "tool_input", "tool_output", "credentials", "local_paths"],
    },
  };
}

export async function capturePiContract({ output, piCommand = process.env.PI_COMMAND ?? "pi" } = {}) {
  if (typeof output !== "string" || output.length === 0) throw new TypeError("--output is required");
  const { stdout } = await promisify(execFile)(piCommand, ["--version"], { timeout: 15_000, maxBuffer: 16_384 });
  const contract = buildPiAuditContract(stdout);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(contract, null, 2)}\n`, { mode: 0o600 });
  return contract;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const outputIndex = process.argv.indexOf("--output");
  const output = outputIndex >= 0 ? process.argv[outputIndex + 1] : null;
  capturePiContract({ output }).catch((error) => {
    console.error(`capture-pi-audit-contract: ${error.message}`);
    process.exitCode = 1;
  });
}
