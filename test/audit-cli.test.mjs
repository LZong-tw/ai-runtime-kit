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

test("embedded absolute paths inside reason strings are scrubbed to basename-only metadata", async () => {
  const output = capture();
  const exitCode = await runAuditCli(["status"], {
    stdout: output.stdout,
    audit: {
      async status() {
        return {
          state: "degraded",
          reason: "failed at /Users/test/.local/state/airkit-audit/audit.sqlite while reading /private/tmp/airkit-audit/error.log.",
        };
      },
    },
  });

  assert.equal(exitCode, 1);
  assert.equal(output.text().includes("/Users/test/"), false);
  assert.equal(output.text().includes("/private/tmp/"), false);
  assert.match(output.text(), /reason: failed at …\/audit\.sqlite while reading …\/error\.log\./);
});

test("retention and export commands pass explicit safety flags", async () => {
  const calls = [];
  const audit = {
    async prune(options) { calls.push(["prune", options]); return { state: options.write ? "healthy" : "stopped" }; },
    async export(options) { calls.push(["export", options]); return { state: "healthy", rows: 0 }; },
  };
  const output = capture();
  assert.equal(await runAuditCli(["prune", "--write", "--retention-days", "30", "--batch-size", "7"], { stdout: output.stdout, audit }), 0);
  assert.equal(await runAuditCli(["export", "--format", "csv", "--output", "/tmp/audit.csv", "--include-payload", "--decrypt"], { stdout: output.stdout, audit }), 0);
  assert.deepEqual(calls, [
    ["prune", { write: true, preserve: false, retentionDays: 30, batchSize: 7 }],
    ["export", { format: "csv", includePayload: true, decrypt: true, outputPath: "/tmp/audit.csv" }],
  ]);
});

test("stdout export is not contaminated by a CLI status footer", async () => {
  const output = capture();
  const exitCode = await runAuditCli(["export"], {
    stdout: output.stdout,
    audit: {
      async export() {
        output.stdout.write('{"model":"gpt-5.6-terra"}\n');
        return { state: "healthy", rows: 1 };
      },
    },
  });
  assert.equal(exitCode, 0);
  assert.equal(output.text(), '{"model":"gpt-5.6-terra"}\n');
});

test("registry mutations and client query commands use the audit service boundary", async () => {
  const calls = [];
  const audit = {
    async repo(options) { calls.push(["repo", options]); return { state: options.write ? "healthy" : "stopped", ...options }; },
    async account(options) { calls.push(["account", options]); return { state: options.write ? "healthy" : "stopped", ...options }; },
    async query(name, args) { calls.push(["query", name, args]); return { state: "healthy", rows: [{ client: "codex-desktop", completeness: "metadata_only" }] }; },
  };
  const output = capture();
  assert.equal(await runAuditCli(["repo", "classify", "repo-1", "personal", "--write"], { audit, stdout: output.stdout }), 0);
  assert.equal(await runAuditCli(["account", "group", "acct-1", "personal-main", "--write"], { audit, stdout: output.stdout }), 0);
  assert.equal(await runAuditCli(["clients"], { audit, stdout: output.stdout }), 0);
  assert.deepEqual(calls, [
    ["repo", { action: "classify", repositoryId: "repo-1", classification: "personal", write: true }],
    ["account", { action: "group", accountId: "acct-1", group: "personal-main", write: true }],
    ["query", "clients", []],
  ]);
  assert.match(output.text(), /metadata_only/);
});
