import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { test } from "node:test";

import { reconcileCcrRequestLogs } from "../src/audit/reconcile/ccr.mjs";
import { reconcileClaudeCode } from "../src/audit/reconcile/claude-code.mjs";
import { processAuditHook } from "../src/audit/claude-hook.mjs";
import { createClaudeAuditHookEmitter } from "../src/audit/claude-hook-runtime.mjs";
import { processContextHook, runHeartbeatHook } from "../src/context-heartbeat.mjs";

test("CCR reconciliation pages by createdAt/id and preserves field provenance", async () => {
  const calls = [];
  const events = [];
  const rows = [
    { id: 1, created_at: "2026-08-17T01:00:00.000Z", status_code: 200, provider: "oneportal", model: "gpt-5.6-terra", input_tokens: 10 },
    { id: 2, created_at: "2026-08-17T01:01:00.000Z", status_code: 429, provider: "deepseek", model: "deepseek-v4-flash", input_tokens: 20 },
  ];
  const result = await reconcileCcrRequestLogs({
    pageSize: 1,
    cursor: { createdAt: "2026-08-17T00:00:00.000Z", id: 0 },
    rpc: {
      async getRequestLogs(input) {
        calls.push(input);
        const row = rows[calls.length - 1];
        return { rows: row ? [row] : [], has_more: Boolean(row && calls.length < rows.length) };
      },
    },
    emit: async (event) => events.push(event),
  });
  assert.equal(result.rows, 2);
  assert.equal(calls[0].page_size, 1);
  assert.deepEqual(calls[0].fields, ["id", "created_at", "status_code", "provider", "model", "input_tokens"]);
  assert.deepEqual(events.map((event) => event.payload.provenance.provider), ["ccr.request_logs.provider", "ccr.request_logs.provider"]);
  assert.equal(events[1].payload.status_code, 429);
  assert.deepEqual(result.cursor, { createdAt: rows[1].created_at, id: rows[1].id });
});

test("Claude JSONL reconciliation is incremental, bounded, and never invents wire hashes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "airkit-claude-audit-"));
  const path = join(directory, "session.jsonl");
  const first = [
    { type: "session_start", session_id: "session-1", cwd: "/Users/private/project" },
    { type: "user", session_id: "session-1", message: { content: "secret prompt" } },
  ].map((row) => JSON.stringify(row)).join("\n") + "\n";
  await writeFile(path, first);
  const events = [];
  const initial = await reconcileClaudeCode({ sessionPath: path, cursor: { offset: 0 }, emit: async (event) => events.push(event) });
  assert.equal(initial.events, 2);
  assert.ok(events.every((event) => !Object.hasOwn(event.payload, "wire_hash")));
  assert.ok(events.every((event) => !JSON.stringify(event).includes("secret prompt")));
  assert.equal(events[0].event_kind, "session_context");

  await writeFile(path, JSON.stringify({ type: "assistant", usage: { input_tokens: 12, output_tokens: 3 } }) + "\n", { flag: "a" });
  const next = [];
  const resumed = await reconcileClaudeCode({ sessionPath: path, cursor: initial.cursor, emit: async (event) => next.push(event) });
  assert.equal(resumed.events, 1);
  assert.equal(next[0].event_kind, "usage_reported");
  assert.equal(next[0].payload.usage.input_tokens, 12);
  assert.equal((await readFile(path, "utf8")).includes("secret prompt"), true);
});

test("audit hook emits lifecycle metadata and remains additive when its emitter fails", async () => {
  const events = [];
  const result = await processAuditHook(
    {
      hook_event_name: "UserPromptSubmit",
      session_id: "session-1",
      cwd: "/Users/private/project",
      prompt: "secret prompt",
    },
    { emit: async (event) => events.push(event) },
  );
  assert.equal(result, null);
  assert.equal(events[0].event_kind, "session_context");
  assert.equal(events[1].event_kind, "request_started");
  assert.ok(!JSON.stringify(events).includes("secret prompt"));

  const response = await processContextHook(
    { hook_event_name: "UserPromptSubmit" },
    { AIRCLAUDE_PROFILE: "test", __airkitAudit: { emit: async () => { throw new Error("offline"); } } },
  );
  assert.equal(response.hookSpecificOutput.hookEventName, "UserPromptSubmit");
});

test("Claude-Sub audit-only hooks emit without enabling AirClaude routing", async () => {
  const events = [];
  const response = await processContextHook(
    {
      hook_event_name: "UserPromptSubmit",
      session_id: "subscription-session",
      prompt: "private prompt",
    },
    {
      AIRKIT_AUDIT_ENABLED: "1",
      __airkitAudit: { emit: async (event) => events.push(event) },
    },
  );

  assert.equal(response, null);
  assert.deepEqual(events.map((event) => event.event_kind), ["session_context", "request_started"]);
  assert.ok(!JSON.stringify(events).includes("private prompt"));
});

test("audit stays additive for an AirClaude profile session instead of retiring context hooks", async () => {
  const events = [];
  const response = await processContextHook(
    {
      hook_event_name: "UserPromptSubmit",
      session_id: "profile-session",
      prompt: "private prompt",
    },
    {
      AIRCLAUDE_MODE: "auto",
      AIRCLAUDE_PROFILE: "launch-example",
      AIRKIT_AUDIT_ENABLED: "1",
      __airkitAudit: { emit: async (event) => events.push(event) },
    },
  );

  assert.equal(response.hookSpecificOutput.hookEventName, "UserPromptSubmit");
  assert.match(response.hookSpecificOutput.additionalContext, /AirClaude/);
  assert.deepEqual(events.map((event) => event.event_kind), ["session_context", "request_started"]);
  assert.ok(!JSON.stringify(events).includes("private prompt"));
});

test("Claude-Sub hook runtime builds an encrypted audit emitter from the local capability", async () => {
  let sent;
  const emitter = await createClaudeAuditHookEmitter({
    env: {
      AIRKIT_AUDIT_CAPABILITY_FILE: "/tmp/audit-capability",
      AIRKIT_AUDIT_SOCKET_PATH: "/tmp/auditd.sock",
    },
    readFileImpl: async () => "capability-value\n",
    masterKeyProvider: { get: async () => Buffer.alloc(32, 7) },
    createClient: (options) => ({
      options,
      async send(envelope) {
        sent = envelope;
        return { event_id: envelope.event_id, status: "committed" };
      },
    }),
  });

  await emitter.emit("session_context", {
    session_id: "sub-session",
    payload: { lifecycle: "SessionStart" },
  });

  assert.equal(typeof sent.event_id, "string");
  assert.ok(sent.event_id.length > 0);
  assert.equal(sent.encrypted.keyId, "payload-master-v1");
  assert.equal(sent.encrypted.ciphertext.includes("SessionStart"), false);
});

test("Claude-Sub hook command uses the audit-only path without AirClaude context", async () => {
  const events = [];
  const output = [];
  await runHeartbeatHook({
    env: { AIRKIT_AUDIT_ENABLED: "1" },
    input: Readable.from([JSON.stringify({
      hook_event_name: "UserPromptSubmit",
      session_id: "sub-session",
      prompt: "private prompt",
    })]),
    output: { write: (value) => output.push(value) },
    createAuditHookEmitter: async ({ env }) => {
      assert.equal(env.AIRKIT_AUDIT_ENABLED, "1");
      return { emit: async (event) => events.push(event) };
    },
  });

  assert.deepEqual(events.map((event) => event.event_kind), ["session_context", "request_started"]);
  assert.deepEqual(output, []);
});
