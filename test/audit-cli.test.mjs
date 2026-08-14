import assert from "node:assert/strict";
import test from "node:test";

import { runAuditCli } from "../src/audit/cli.mjs";

function capture() {
  let text = "";
  return {
    stdout: {
      write(chunk) {
        text += String(chunk);
      },
    },
    text: () => text,
  };
}

test("status emits metadata-only output and deterministic health exit codes", async () => {
  const cases = [
    ["healthy", 0],
    ["degraded", 1],
    ["stopped", 2],
    ["blocked", 3],
  ];

  for (const [state, expectedCode] of cases) {
    const output = capture();
    const exitCode = await runAuditCli(["status"], {
      stdout: output.stdout,
      audit: {
        async status() {
          return {
            state,
            capability: "capability-123",
            payloadPlaintext: "secret payload",
            requestHmac: "deadbeef",
            masterKeyHex: "0123456789abcdef",
            plistPath: "/Users/test/Library/LaunchAgents/com.airkit.auditd.plist",
            socketPath: "/Users/test/.local/state/airkit-audit/auditd.sock",
          };
        },
      },
    });

    assert.equal(exitCode, expectedCode);
    assert.match(output.text(), new RegExp(`state: ${state}`));
    assert.equal(output.text().includes("secret payload"), false);
    assert.equal(output.text().includes("deadbeef"), false);
    assert.equal(output.text().includes("0123456789abcdef"), false);
    assert.equal(output.text().includes("/Users/test/"), false);
    assert.match(output.text(), /auditd\.sock/);
  }
});

test("install and update preview by default, and write only when requested", async () => {
  const calls = [];
  const audit = {
    async install(options) {
      calls.push(["install", options]);
      return { state: options.write ? "healthy" : "stopped", write: options.write };
    },
    async update(options) {
      calls.push(["update", options]);
      return { state: options.write ? "healthy" : "degraded", write: options.write };
    },
  };

  const preview = capture();
  assert.equal(await runAuditCli(["install"], { stdout: preview.stdout, audit }), 2);

  const durable = capture();
  assert.equal(await runAuditCli(["update", "--write"], { stdout: durable.stdout, audit }), 0);

  assert.deepEqual(calls, [
    ["install", { write: false }],
    ["update", { write: true }],
  ]);
});

test("verify dispatches to the injected audit verifier", async () => {
  const output = capture();
  const exitCode = await runAuditCli(["verify"], {
    stdout: output.stdout,
    audit: {
      async verify() {
        return { state: "healthy", verified: true };
      },
    },
  });

  assert.equal(exitCode, 0);
  assert.match(output.text(), /verified: true/);
});
