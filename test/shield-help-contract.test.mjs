import assert from "node:assert/strict";
import test from "node:test";

import { runCli } from "../src/airkit.mjs";
import { runShieldCli } from "../src/shield/cli.mjs";

const SHIELD_COMMANDS = [
  "shield install [--lane subscription|managed] [--write]",
  "shield uninstall [--lane subscription|managed] [--write]",
  "shield start",
  "shield stop",
  "shield status",
  "shield doctor",
  "shield policy <status [--lane subscription|managed]|install --bundle /absolute/policy-bundle --public-key /absolute/policy-public-key [--lane subscription|managed] [--write]>",
  "shield privacy provision --bundle /absolute/privacy-manifest --gitleaks /absolute/gitleaks --gitleaks-rules /absolute/gitleaks-rules.toml [--policy-bundle /absolute/policy-bundle] [--lane subscription|managed] [--write]",
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
    assert.match(output.value(), /shield <install\|uninstall\|start\|stop\|status\|doctor\|policy\|privacy\|launch> \[options\]/);
  }

  for (const argv of [[], ["help"], ["-h"], ["--help"]]) {
    const output = capture();
    const code = await runShieldCli(argv, { stdout: output.stdout });

    assert.equal(code, 0);
    for (const command of SHIELD_COMMANDS) assert.match(output.value(), new RegExp(command.replace(/[|()[\].?+*^$\\]/g, "\\$&")));
  }
});

test("shield uninstall previews by default, exits 0, hides paths and rejects an ambiguous lane", async () => {
  const seen = [];
  const shield = { async uninstall(options) {
    seen.push(options);
    return { state: options.write ? "stopped" : "preview", exitCode: 0, write: options.write, lane: options.lane,
      service: { label: `com.airkit.shield.${options.lane}`, installed: true, removed: options.write, operations: [{ op: "unlink", path: "/private/plist" }] } };
  } };
  const output = capture();
  assert.equal(await runShieldCli(["uninstall", "--lane", "managed"], { stdout: output.stdout, shield }), 0);
  assert.deepEqual(seen, [{ write: false, lane: "managed" }]);
  assert.match(output.value(), /state: preview/);
  assert.doesNotMatch(output.value(), /\/private\/plist/);
  assert.equal(await runShieldCli(["uninstall", "--write"], { stdout: capture().stdout, shield }), 0);
  assert.deepEqual(seen[1], { write: true, lane: "subscription" });
  for (const argv of [["uninstall", "--lane", "subscription", "--lane", "managed"], ["uninstall", "--lane", "managed", "--lane", "subscription"], ["uninstall", "--lane", "other"]]) {
    await assert.rejects(runShieldCli(argv, { stdout: capture().stdout, shield }), /usage: shield uninstall/);
  }
  assert.equal(seen.length, 2);
});
