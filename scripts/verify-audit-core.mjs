#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAuditEvent } from "../src/audit/event.mjs";
import { resolveAuditPaths } from "../src/audit/paths.mjs";
import { createEncryptedSpool } from "../src/audit/spool.mjs";
import { openAuditStore } from "../src/audit/store.mjs";
import { createAuditClient } from "../src/audit/transport.mjs";
import { createAuditDaemon } from "../src/audit/daemon.mjs";
import { encryptAuditValue } from "../src/audit/crypto.mjs";
import { runAuditCli } from "../src/audit/cli.mjs";

const MASTER_KEY = Buffer.alloc(32, 0x31);
const CAPABILITY = "audit-core-capability-v1";
// AIRKIT_AUDIT state is always rooted in the scenario's temporary HOME.

export async function verifyCoreScenario({ root } = {}) {
  root ??= await mkdtemp(join(tmpdir(), "airkit-audit-core-"));
  const env = {
    HOME: root,
    XDG_STATE_HOME: root,
    AIRKIT_GUI_UID: "501",
  };
  const paths = resolveAuditPaths({
    env,
    overrides: {
      rootDir: join(root, "audit"),
      spoolDir: join(root, "spool"),
      socketPath: join(root, "audit", "auditd.sock"),
      querySocketPath: join(root, "audit", "auditd-query.sock"),
    },
  });
  const databasePath = join(paths.rootDir, "audit.sqlite");
  const backupDir = join(paths.rootDir, "backups");
  const event = createAuditEvent({
    event_id: "audit-core-event",
    source: "audit-core-verifier",
    source_version: "1",
    source_event_id: "audit-core-source",
    observed_at: "2026-08-14T00:00:00.000Z",
    event_kind: "request_payload",
    logical_request_id: "audit-core-request",
    attempt_id: "audit-core-attempt",
    session_id: "audit-core-session",
    client: "airclaude",
    payload: { marker: "default-export-secret-scan", secret: "do not export" },
  });
  const envelope = {
    event_id: event.event_id,
    encrypted: encryptAuditValue({
      masterKey: MASTER_KEY,
      purpose: "request-evidence/v1",
      identity: event.event_id,
      plaintext: JSON.stringify(event),
    }),
  };
  const spool = createEncryptedSpool({ paths, masterKey: MASTER_KEY });
  // spool-before-send: persist the event before opening the daemon client.
  const pending = await spool.enqueue(event);
  assert.equal((await spool.entries()).length, 1);

  const createStore = () => openAuditStore({ databasePath, backupDir, masterKey: MASTER_KEY });
  let daemon;
  try {
    daemon = createAuditDaemon({
      paths,
      capability: CAPABILITY,
      keyProvider: { async getMasterKey() { return MASTER_KEY; } },
      storeFactory: createStore,
    });
    await daemon.start();
    const client = createAuditClient({ socketPath: paths.socketPath, capability: CAPABILITY });
    const committed = await client.send(envelope);
    assert.equal(committed.status, "committed");
    // duplicate: the same event is idempotent and must ACK after the store result.
    const duplicate = await client.send(envelope);
    assert.equal(duplicate.status, "duplicate");
    await spool.acknowledge(pending, duplicate);
    assert.equal((await spool.entries()).length, 0);
  } finally {
    await daemon?.stop().catch(() => {});
  }

  // daemon-restart: a fresh daemon can reopen the same SQLite store.
  let restarted;
  try {
    restarted = createAuditDaemon({
      paths,
      capability: CAPABILITY,
      keyProvider: { async getMasterKey() { return MASTER_KEY; } },
      storeFactory: createStore,
    });
    await restarted.start();
    assert.equal(restarted.status().listening, true);
    const afterRestart = createAuditClient({ socketPath: paths.socketPath, capability: CAPABILITY });
    assert.equal((await afterRestart.send(envelope)).status, "duplicate");
  } finally {
    await restarted?.stop().catch(() => {});
  }

  const retentionEvents = ["exact", "after", "preserved"].map((suffix) => createAuditEvent({
    event_id: `audit-core-${suffix}`,
    source: "audit-core-verifier",
    source_version: "1",
    source_event_id: `audit-core-source-${suffix}`,
    observed_at: "2026-08-14T00:00:00.000Z",
    event_kind: "request_payload",
    logical_request_id: `audit-core-request-${suffix}`,
    attempt_id: `audit-core-attempt-${suffix}`,
    session_id: `audit-core-session-${suffix}`,
    client: "airclaude",
    payload: { marker: `retention-${suffix}` },
  }));
  const seeded = createStore();
  try {
    for (const retentionEvent of retentionEvents) await seeded.ingestEvent(retentionEvent);
  } finally {
    seeded.close();
  }

  const cutoff = "2026-05-16T00:00:00.000Z";
  const raw = new DatabaseSync(databasePath);
  try {
    const before = raw.prepare("SELECT ciphertext, nonce, auth_tag FROM payload_blobs WHERE source_event_id = ?")
      .get(event.event_id);
    assert.ok(before.ciphertext && before.nonce && before.auth_tag);
    raw.prepare("UPDATE payload_blobs SET expires_at = ? WHERE source_event_id = ?").run("2026-05-15T23:59:59.999Z", event.event_id);
    raw.prepare("UPDATE payload_blobs SET expires_at = ? WHERE source_event_id = ?").run(cutoff, "audit-core-exact");
    raw.prepare("UPDATE payload_blobs SET expires_at = ? WHERE source_event_id = ?").run("2026-05-16T00:00:00.001Z", "audit-core-after");
    raw.prepare("UPDATE payload_blobs SET expires_at = ?, preserved_at = ? WHERE source_event_id = ?")
      .run("2026-05-01T00:00:00.000Z", "2026-05-02T00:00:00.000Z", "audit-core-preserved");
  } finally {
    raw.close();
  }
  const writable = openAuditStore({ databasePath, backupDir, masterKey: MASTER_KEY });
  try {
    const pruned = await writable.prunePayloadBatch({ cutoff, batchSize: 10 });
    assert.equal(pruned.pruned, 2);
    assert.equal(writable.query("SELECT count(*) AS count FROM source_events WHERE event_kind = 'retention_pruned'")[0].count, 1);
  } finally {
    writable.close();
  }
  const retentionCheck = new DatabaseSync(databasePath);
  try {
    const rows = retentionCheck.prepare(`
      SELECT pb.source_event_id, pb.payload_json, pb.nonce, pb.ciphertext, pb.auth_tag,
        pb.pruned_at, pb.preserved_at, rp.payload_json AS request_payload_json,
        se.payload_json AS source_payload_json
      FROM payload_blobs pb
      JOIN request_payloads rp ON rp.event_id = pb.source_event_id
      JOIN source_events se ON se.event_id = pb.source_event_id
      WHERE pb.source_event_id IN (?, ?, ?, ?)
    `).all(event.event_id, "audit-core-exact", "audit-core-after", "audit-core-preserved");
    const byEvent = new Map(rows.map((row) => [row.source_event_id, row]));
    for (const id of [event.event_id, "audit-core-exact"]) {
      const row = byEvent.get(id);
      assert.equal(row.payload_json, "null");
      assert.equal(row.nonce, null);
      assert.equal(row.ciphertext, null);
      assert.equal(row.auth_tag, null);
      assert.ok(row.pruned_at);
      assert.equal(row.request_payload_json, "null");
      assert.equal(row.source_payload_json, null);
    }
    for (const id of ["audit-core-after", "audit-core-preserved"]) {
      const row = byEvent.get(id);
      assert.notEqual(row.payload_json, "null");
      assert.ok(row.ciphertext && row.nonce && row.auth_tag);
    }
    assert.ok(byEvent.get("audit-core-preserved").preserved_at);
  } finally {
    retentionCheck.close();
  }
  // migration-backup: every writable reopen snapshots the database before migration/verification.
  assert.ok((await readdir(backupDir)).some((name) => name.endsWith(".sqlite")));

  const cliDependencies = {
    env: {
      ...env,
      AIRKIT_AUDIT_DATABASE_PATH: databasePath,
      AIRKIT_AUDIT_BACKUP_DIR: backupDir,
    },
    masterKeyProvider: {
      async inspect() { return false; },
      async get() { return MASTER_KEY; },
    },
    openAuditStore: (options) => openAuditStore({ ...options, masterKey: MASTER_KEY }),
    runLaunchctl: async () => ({ ok: false, stderr: "could not find service" }),
  };
  let exportOutput = "";
  const exportExit = await runAuditCli(["export"], {
    ...cliDependencies,
    stdout: { write(chunk) { exportOutput += String(chunk); } },
  });
  assert.equal(exportExit, 0);
  const exportLines = exportOutput.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  assert.ok(exportLines.length >= 1);
  assert.ok(exportLines.every((row) => !Object.hasOwn(row, "payload")));
  const exportValues = exportLines.flatMap((row) => Object.values(row)).filter((value) => typeof value === "string").join("\n");
  assert.doesNotMatch(exportValues, /do not export|default-export-secret-scan|https?:\/\/|authorization|bearer|api[_-]?key|password|secret/i);
  assert.doesNotMatch(exportValues, /(?:token|credential)\s*[:=]/i);

  let degradedOutput = "";
  const degradedExit = await runAuditCli(["status"], {
    ...cliDependencies,
    stdout: { write(chunk) { degradedOutput += chunk; } },
  });
  // degraded: status is visible and exits non-zero without exposing secrets.
  assert.equal(degradedExit, 1);
  assert.match(degradedOutput, /degraded/);
  return { state: "healthy", checks: ["spool-before-send", "duplicate", "daemon-restart", "migration-backup", "retention-pruned", "default-export-secret-scan", "degraded"] };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const root = await mkdtemp(join(tmpdir(), "airkit-audit-core-"));
  try {
    await verifyCoreScenario({ root });
    process.stdout.write("audit core verification: healthy\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
