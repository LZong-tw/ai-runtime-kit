import assert from "node:assert/strict";
import test from "node:test";

import { runCli } from "../src/airkit.mjs";
import { runShieldCli } from "../src/shield/cli.mjs";

const SHIELD_COMMANDS = [
  "shield install [--lane subscription|managed] [--write]",
  "shield start",
  "shield stop",
  "shield status",
  "shield doctor",
  "shield policy <status [--lane subscription|managed]|install --bundle /absolute/policy-bundle --public-key /absolute/policy-public-key [--lane subscription|managed] [--write]>",
  "shield privacy provision --bundle /absolute/privacy-manifest --gitleaks /absolute/gitleaks [--policy-bundle /absolute/policy-bundle] [--lane subscription|managed] [--write]",
  "shield launch --lane subscription|managed [--target http://127.0.0.1:port] -- command [args...]",
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
    assert.match(output.value(), /shield <install\|start\|stop\|status\|doctor\|policy\|privacy\|launch> \[options\]/);
  }

  for (const argv of [[], ["help"], ["-h"], ["--help"]]) {
    const output = capture();
    const code = await runShieldCli(argv, { stdout: output.stdout });

    assert.equal(code, 0);
    for (const command of SHIELD_COMMANDS) assert.match(output.value(), new RegExp(command.replace(/[|()[\].?+*^$\\]/g, "\\$&")));
  }
});
