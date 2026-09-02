import assert from "node:assert/strict";
import test from "node:test";

import { runCli } from "../src/airkit.mjs";
import { runShieldCli } from "../src/shield/cli.mjs";

const SHIELD_COMMANDS = [
  "shield install [--write]",
  "shield start",
  "shield stop",
  "shield status",
  "shield doctor",
  "shield privacy provision --bundle /absolute/privacy-manifest --gitleaks /absolute/gitleaks [--write]",
  "shield launch --lane subscription|managed -- command [args...]",
];

function capture() {
  let value = "";
  return { stdout: { write(chunk) { value += String(chunk); } }, value: () => value };
}

test("airkit and shield help expose the documented Shield command contract", async () => {
  for (const argv of [["-h"], ["--help"]]) {
    const output = capture();
    const code = await runCli(argv, {
      catalogPath: "/does/not/exist/catalog.json",
      stdout: output.stdout,
    });

    assert.equal(code, 0);
    assert.match(output.value(), /shield <install\|start\|stop\|status\|doctor\|privacy\|launch> \[options\]/);
  }

  for (const argv of [[], ["help"], ["-h"], ["--help"]]) {
    const output = capture();
    const code = await runShieldCli(argv, { stdout: output.stdout });

    assert.equal(code, 0);
    for (const command of SHIELD_COMMANDS) assert.match(output.value(), new RegExp(command.replace(/[|()[\].?+*^$\\]/g, "\\$&")));
  }
});
