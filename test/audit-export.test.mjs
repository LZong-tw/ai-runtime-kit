import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { encryptAuditValue } from "../src/audit/crypto.mjs";
import { createAuditEvent } from "../src/audit/event.mjs";
import { runAuditCli } from "../src/audit/cli.mjs";
import { exportAuditData } from "../src/audit/export.mjs";
import { createRevealExportCoordinator } from "../src/audit/reveal-export.mjs";
import { openAuditStore } from "../src/audit/store.mjs";

const rows = [
  {
    request_id: "request-secret",
    logical_request_id: "logical-secret",
    provider: "oneportal",
    model: "gpt-5.6-terra",
    client: "airclaude",
    failure_kind: "failed /Users/test/private-repo https://user:pass@example.test/x Bearer abc123",
    root_path: "/Users/test/private-repo",
    remote_url: "https://token:password@example.test/repo.git",
    account_hmac: "hmac-secret",
    payload_json: '{"prompt":"do not export"}',
    input_tokens: 12,
  },
];

function readStore() {
  return {
    async *exportRows() {
      yield* rows;
    },
  };
}

test("default export is pseudonymized metadata-only JSONL", async () => {
  const chunks = [];
  const result = await exportAuditData(readStore(), { output: (chunk) => chunks.push(chunk) });
  const text = chunks.join("");
  assert.equal(result.format, "jsonl");
  assert.equal(text.includes("request-secret"), false);
  assert.equal(text.includes("hmac-secret"), false);
  assert.equal(text.includes("/Users/test"), false);
  assert.equal(text.includes("https://"), false);
  assert.equal(text.includes("abc123"), false);
  assert.equal(text.includes("private-repo"), false);
  assert.equal(text.includes("do not export"), false);
  assert.match(text, /gpt-5\.6-terra/);
  assert.match(text, /id_[0-9a-f]{16}/);
});

test("payload and decryption are both required and authorization is consumed", async () => {
  await assert.rejects(
    () => exportAuditData(readStore(), { includePayload: true }),
    /decrypt authorization/,
  );
  await assert.rejects(
    () => exportAuditData(readStore(), { decrypt: true }),
    /includePayload/,
  );
  let consumed = 0;
  const root = await mkdtemp(join(tmpdir(), "airkit-audit-export-"));
  const outputPath = join(root, "decrypted.jsonl");
  const result = await exportAuditData(readStore(), {
    includePayload: true,
    decrypt: true,
    interactive: true,
    authorizer: { async consume() { consumed += 1; return true; } },
    outputPath,
    decryptRow: async (row) => ({ ...row, payload_json: "authorized payload" }),
  });
  assert.equal(consumed, 1);
  assert.equal(result.rows, 1);
  assert.match(await readFile(outputPath, "utf8"), /authorized payload/);
  await rm(root, { recursive: true, force: true });
});

test("decrypted export is denied outside an interactive terminal", async () => {
  await assert.rejects(() => exportAuditData(readStore(), {
    includePayload: true,
    decrypt: true,
    authorizer: { async consume() { return true; } },
    outputPath: "/tmp/should-not-be-created.jsonl",
    decryptRow: async () => ({ payload: "secret" }),
    interactive: false,
  }), /interactive terminal/);
});

test("failed export cleans up a temporary destination", async () => {
  const writes = [];
  await assert.rejects(() => exportAuditData(readStore(), {
    output: {
      async write(chunk) { writes.push(chunk); throw new Error("disk full"); },
      async abort() { writes.splice(0, writes.length); writes.push("aborted"); },
    },
  }), /disk full/);
  assert.deepEqual(writes, ["aborted"]);
});

test("reveal authorization binds the complete export manifest and decrypts only authorized evidence", async () => {
  const masterKey = Buffer.alloc(32, 9);
  const encrypted = encryptAuditValue({
    masterKey,
    purpose: "request-evidence/v1",
    identity: "attempt-1",
    aad: "payload-1",
    plaintext: JSON.stringify({ payload: "authorized payload" }),
  });
  const calls = [];
  const coordinator = createRevealExportCoordinator({
    masterKeyProvider: { get: async () => masterKey },
    confirm: async ({ rows }) => rows === 1,
    publicKey: { verify: async () => true },
    authorizer: {
      async challenge(fields) { calls.push(["challenge", fields]); return fields; },
      async verifyAndConsume(fields) { calls.push(["verify", fields]); return true; },
    },
  });
  const row = {
    request_id: "request-1",
    payload_event_id: "payload-1",
    attempt_id: "attempt-1",
    key_id: encrypted.keyId,
    nonce: encrypted.nonce,
    ciphertext: encrypted.ciphertext,
    auth_tag: encrypted.authTag,
  };
  assert.equal(await coordinator.authorizeExport({ rows: [row], outputPath: "/tmp/audit.jsonl", format: "jsonl" }), true);
  assert.match(calls[0][1].requestId, /^audit-export-/);
  assert.equal(calls[0][1].sessionId, "audit-export");
  assert.deepEqual(await coordinator.decryptRow(row), { payload: "authorized payload" });
  await assert.rejects(() => coordinator.decryptRow({ ...row, request_id: "outside" }), { code: "AIRKIT_AUDIT_REVEAL_UNAVAILABLE" });
});

test("decrypted CSV keeps payload quoting and signal cleanup preserves termination", async () => {
  const root = await mkdtemp(join(tmpdir(), "airkit-audit-export-signal-"));
  const outputPath = join(root, "decrypted.csv");
  const signalHandlers = new Map();
  const killed = [];
  const signalProcess = {
    pid: 321,
    once(signal, handler) {
      signalHandlers.set(signal, handler);
      if (signal === "SIGINT") queueMicrotask(() => handler(signal));
    },
    removeListener(signal) { signalHandlers.delete(signal); },
    kill(pid, signal) { killed.push([pid, signal]); },
  };
  await assert.rejects(() => exportAuditData({
    async *exportRows() { yield { request_id: "r", payload_event_id: "p" }; },
  }, {
    format: "csv",
    includePayload: true,
    decrypt: true,
    authorizeExport: async () => true,
    decryptRow: async () => ({ payload: "line 1, line 2\nline 3" }),
    outputPath,
    signalProcess,
  }), /interrupted/);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(killed, [[321, "SIGINT"]]);
  await assert.rejects(() => readFile(outputPath), { code: "ENOENT" });
  await rm(root, { recursive: true, force: true });
});

test("default audit CLI decrypts evidence produced by the real encrypted store", async () => {
  const root = await mkdtemp(join(tmpdir(), "airkit-audit-export-real-"));
  const databasePath = join(root, "audit.sqlite");
  const backupDir = join(root, "backups");
  const masterKey = Buffer.alloc(32, 4);
  const seed = openAuditStore({ databasePath, backupDir, masterKey });
  await seed.ingestEvent(createAuditEvent({
    event_id: "event-real",
    source: "test",
    source_version: "1",
    source_event_id: "source-real",
    observed_at: "2026-08-14T00:00:00.000Z",
    event_kind: "request_payload",
    logical_request_id: "logical-real",
    attempt_id: "attempt-real",
    session_id: "session-real",
    client: "airclaude",
    payload: { marker: "real encrypted payload" },
  }));
  seed.close();
  const raw = new DatabaseSync(databasePath);
  const encryptedRow = raw.prepare("SELECT ciphertext, nonce, auth_tag, key_id FROM payload_blobs").get();
  raw.close();
  assert.ok(encryptedRow.ciphertext);

  const outputPath = join(root, "decrypted.jsonl");
  let challengeCalls = 0;
  const result = await runAuditCli(["export", "--format", "jsonl", "--include-payload", "--decrypt", "--output", outputPath], {
    env: { HOME: root, XDG_STATE_HOME: root, AIRKIT_AUDIT_DATABASE_PATH: databasePath, AIRKIT_AUDIT_BACKUP_DIR: backupDir, AIRKIT_GUI_UID: "501" },
    openAuditStore: (options) => openAuditStore({ ...options, masterKey }),
    masterKeyProvider: { get: async () => masterKey },
    revealAuthorizer: {
      async challenge(fields) { challengeCalls += 1; return fields; },
      async verifyAndConsume() { return true; },
    },
    publicKey: { verify: async () => true },
    confirmReveal: async ({ rows }) => rows === 1,
    stdout: { write() {} },
  });
  assert.equal(result, 0);
  assert.equal(challengeCalls, 1);
  assert.match(await readFile(outputPath, "utf8"), /real encrypted payload/);
  await rm(root, { recursive: true, force: true });
});
