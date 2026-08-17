import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createPiAuditRuntime } from "../src/audit/adapters/pi-extension.mjs";
import { runExternalClientCli } from "../src/airkit.mjs";

test("Pi audit runtime emits metadata-only lifecycle observations without provider attempts", async () => {
  const emitted = [];
  const root = await mkdtemp(join(tmpdir(), "airkit-pi-audit-test-"));
  const runtime = await createPiAuditRuntime({
    auditEmitter: { emit: async (kind, fields) => emitted.push({ kind, fields }) },
    tempRoot: root,
  });

  try {
    await writeFile(runtime.eventLogPath, [
      JSON.stringify({ type: "session_start", session_id: "session-1", hasUI: true }),
      JSON.stringify({ type: "before_agent_start", session_id: "session-1", prompt_bytes: 321 }),
      JSON.stringify({ type: "turn_start", session_id: "session-1", turn_id: "session-1:2" }),
      JSON.stringify({ type: "turn_end", session_id: "session-1", turn_id: "session-1:2", usage: { input_tokens: 21, output_tokens: 5, cache_read_input_tokens: 13 } }),
    ].join("\n"), "utf8");

    await runtime.drain();

    assert.deepEqual(emitted.map(({ kind }) => kind), [
      "session_context",
      "session_context",
      "session_context",
      "usage_reported",
    ]);
    assert.equal(emitted.some(({ kind }) => kind === "provider_request" || kind === "provider_response"), false);
    assert.equal(emitted[3].fields.logical_request_id, "pi:session-1:2");
    assert.equal(emitted[3].fields.payload.usage.input_tokens, 21);
  } finally {
    await runtime.cleanup();
    await rm(root, { force: true, recursive: true });
  }
});

test("airpi appends one managed extension and preserves user extension ordering", async () => {
  const calls = [];
  const root = await mkdtemp(join(tmpdir(), "airkit-airpi-test-"));

  try {
    const exitCode = await runExternalClientCli("pi", [
      "--profile", "launch-example",
      "-e", "/tmp/first-extension.mjs",
      "--extension=/tmp/second-extension.mjs",
      "hello",
    ], {
      auditEmitter: { emit: async () => {} },
      tempRoot: root,
      catalog: { profiles: [{ name: "launch-example" }] },
      prepareExternalClient: async () => ({
        externalClient: { origin: "http://127.0.0.1:4312/v1", token: "local-token", close: async () => {} },
      }),
      spawnCommand: (command, args, options) => {
        calls.push({ command, args, options });
        return { status: 0 };
      },
    });

    assert.equal(exitCode, 0);
    const args = calls[0].args;
    const extensionArgs = [];
    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index];
      if (arg === "-e" || arg === "--extension") extensionArgs.push(args[index + 1]);
      else if (arg.startsWith("--extension=")) extensionArgs.push(arg.slice("--extension=".length));
    }
    assert.deepEqual(extensionArgs.slice(0, 2), [
      "/tmp/first-extension.mjs",
      "/tmp/second-extension.mjs",
    ]);
    assert.equal(extensionArgs.length, 3);
    assert.match(extensionArgs[2], /airkit-pi-audit-extension\.mjs$/);
    assert.equal(calls[0].options.env.AIRKIT_PI_AUDIT_EVENTS_PATH.endsWith("airkit-pi-audit-events.jsonl"), true);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("airpi fail-opens when managed Pi audit setup cannot write temp files", async () => {
  const calls = [];
  const root = await mkdtemp(join(tmpdir(), "airkit-airpi-fail-open-"));
  const blockedPath = join(root, "not-a-directory");
  await writeFile(blockedPath, "blocked", "utf8");

  try {
    const exitCode = await runExternalClientCli("pi", ["--profile", "launch-example", "hello"], {
      auditEmitter: { emit: async () => {} },
      tempRoot: blockedPath,
      catalog: { profiles: [{ name: "launch-example" }] },
      prepareExternalClient: async () => ({
        externalClient: { origin: "http://127.0.0.1:4312/v1", token: "local-token", close: async () => {} },
      }),
      spawnCommand: (command, args, options) => {
        calls.push({ command, args, options });
        return { status: 0 };
      },
    });

    assert.equal(exitCode, 0);
    assert.equal(calls[0].args.some((arg) => arg === "--extension" || arg.startsWith("--extension=")), false);
    assert.equal("AIRKIT_PI_AUDIT_EVENTS_PATH" in calls[0].options.env, false);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
