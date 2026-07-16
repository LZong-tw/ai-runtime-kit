import assert from "node:assert/strict";
import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { delimiter, isAbsolute, join } from "node:path";
import test from "node:test";

import { runCapture } from "../scripts/capture-claude-tool-contract.mjs";

const claudePath = process.env.CLAUDE_PATH ?? "claude";

test("published package includes its tool-contract verifier", async () => {
  const packageJson = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );
  assert.equal(
    packageJson.files.includes("scripts/capture-claude-tool-contract.mjs"),
    true,
  );
  assert.equal(
    packageJson.scripts["verify:tool-contract"],
    "node scripts/capture-claude-tool-contract.mjs",
  );
});

test("wire capture proves native web tools through a fake provider", async (context) => {
  try {
    await access(await resolveCommand(claudePath), constants.X_OK);
  } catch {
    context.skip(`Claude Code is not installed at ${claudePath}`);
    return;
  }

  const result = await runCapture({ claudePath, tool: "WebSearch" });
  if (result.status === "unsupported") {
    context.skip(result.reason);
    return;
  }

  assert.equal(result.status, "enforced");
  assert.equal(result.realHomeAccessDenied, true);
  assert.equal(result.loopbackEnforced, true);
  assert.equal(result.realHomeReferenced, false);
  assert.equal(result.initialTools.includes("WebSearch"), true);
  assert.deepEqual(result.serverTypes, ["tool_use", "tool_result"]);
  assert.equal(result.continuation.toolResultId, result.toolUseId);
  assert.equal(result.continuation.requestIndex, 1);
  assert.equal(result.loopbackOnly, true);
  assert.match(result.claudeVersion, /^2\./);
  assert.equal(JSON.stringify(result).includes(process.env.HOME), false);
});

async function resolveCommand(command) {
  if (isAbsolute(command)) return command;
  for (const directory of String(process.env.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, command);
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Keep searching PATH.
    }
  }
  return command;
}
