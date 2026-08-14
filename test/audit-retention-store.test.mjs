import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createAuditEvent } from "../src/audit/event.mjs";
import { openAuditStore } from "../src/audit/store.mjs";

async function withStore(run) {
  const root = await mkdtemp(join(tmpdir(), "airkit-audit-retention-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function payloadEvent(id = "request-1") {
  return createAuditEvent({
    event_id: `event-${id}`,
    source: "test",
    source_version: "1",
    source_event_id: `source-${id}`,
    observed_at: "2026-05-01T00:00:00.000Z",
    event_kind: "request_payload",
    logical_request_id: id,
    session_id: `session-${id}`,
    client: "airclaude",
    payload: { provider: "oneportal", model: "gpt-5.6-terra", marker: id },
  });
}

test("real store exports metadata and prunes plaintext at the exact cutoff", async () => {
  await withStore(async (root) => {
    const databasePath = join(root, "audit.sqlite");
    const backupDir = join(root, "backups");
    const store = openAuditStore({ databasePath, backupDir, now: () => new Date("2026-08-14T00:00:00.000Z") });
    await store.ingestEvent(payloadEvent());
    store.close();

    const raw = new DatabaseSync(databasePath);
    raw.prepare("UPDATE payload_blobs SET expires_at = ?, nonce = ?, ciphertext = ?, auth_tag = ?, wire_hash = ?, evidence_hash = ?, plaintext_bytes = ?")
      .run("2026-05-16T00:00:00.000Z", "n", "c", "t", "w", "e", 12);
    raw.close();

    let vacuumCalls = 0;
    const writable = openAuditStore({
      databasePath,
      backupDir,
      now: () => new Date("2026-08-14T00:00:00.000Z"),
      backupDatabase() {},
      vacuum: () => { vacuumCalls += 1; },
    });
    const result = await writable.prunePayloadBatch({ cutoff: "2026-05-16T00:00:00.000Z", batchSize: 10 });
    assert.deepEqual(result, { pruned: 1, preserved: 0, done: true });
    const blob = writable.query("SELECT payload_json, nonce, ciphertext, auth_tag, wire_hash, evidence_hash, plaintext_bytes, pruned_at FROM payload_blobs")[0];
    assert.equal(blob.payload_json, "null");
    assert.equal(blob.nonce, null);
    assert.equal(blob.ciphertext, null);
    assert.equal(blob.auth_tag, null);
    assert.equal(blob.wire_hash, "w");
    assert.equal(blob.evidence_hash, "e");
    assert.equal(blob.plaintext_bytes, 12);
    assert.ok(blob.pruned_at);
    assert.equal(writable.query("SELECT payload_json FROM request_payloads")[0].payload_json, "null");
    assert.equal(writable.query("SELECT payload_json FROM source_events WHERE event_kind = 'request_payload'")[0].payload_json, null);
    assert.equal(writable.query("SELECT count(*) AS count FROM source_events WHERE event_kind = 'retention_pruned'")[0].count, 1);
    assert.equal(vacuumCalls, 1);
    writable.close();

    const readonly = openAuditStore({ databasePath, readOnly: true });
    const rows = [];
    for await (const row of readonly.exportRows()) rows.push(row);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].model, "gpt-5.6-terra");
    readonly.close();
  });
});

test("retention uses an inclusive cutoff and never prunes preserved payloads", async () => {
  await withStore(async (root) => {
    const databasePath = join(root, "audit.sqlite");
    const backupDir = join(root, "backups");
    const seed = openAuditStore({ databasePath, backupDir, now: () => new Date("2026-08-14T00:00:00.000Z") });
    for (const id of ["before", "exact", "after", "preserved"]) await seed.ingestEvent(payloadEvent(id));
    seed.close();
    const raw = new DatabaseSync(databasePath);
    const update = raw.prepare("UPDATE payload_blobs SET expires_at = ?, nonce = ?, ciphertext = ?, auth_tag = ?, preserved_at = ? WHERE source_event_id = ?");
    update.run("2026-05-15T23:59:59.999Z", "n", "c", "t", null, "event-before");
    update.run("2026-05-16T00:00:00.000Z", "n", "c", "t", null, "event-exact");
    update.run("2026-05-16T00:00:00.001Z", "n", "c", "t", null, "event-after");
    update.run("2026-05-15T00:00:00.000Z", "n", "c", "t", "2026-05-01T00:00:00.000Z", "event-preserved");
    raw.close();
    const store = openAuditStore({ databasePath, backupDir, now: () => new Date("2026-08-14T00:00:00.000Z"), backupDatabase() {} });
    const result = await store.prunePayloadBatch({ cutoff: "2026-05-16T00:00:00.000Z", batchSize: 10 });
    assert.equal(result.pruned, 2);
    const rows = store.query("SELECT source_event_id, payload_json, pruned_at, preserved_at FROM payload_blobs ORDER BY source_event_id");
    assert.equal(rows.find((row) => row.source_event_id === "event-before").payload_json, "null");
    assert.equal(rows.find((row) => row.source_event_id === "event-exact").payload_json, "null");
    assert.notEqual(rows.find((row) => row.source_event_id === "event-after").payload_json, "null");
    assert.notEqual(rows.find((row) => row.source_event_id === "event-preserved").payload_json, "null");
    assert.ok(rows.find((row) => row.source_event_id === "event-preserved").preserved_at);
    store.close();
  });
});

test("retention marker failure rolls back payload clearing", async () => {
  await withStore(async (root) => {
    const databasePath = join(root, "audit.sqlite");
    const backupDir = join(root, "backups");
    const seed = openAuditStore({ databasePath, backupDir, now: () => new Date("2026-08-14T00:00:00.000Z") });
    await seed.ingestEvent(payloadEvent("rollback"));
    seed.close();
    const raw = new DatabaseSync(databasePath);
    raw.prepare("UPDATE payload_blobs SET expires_at = ?, nonce = ?, ciphertext = ?, auth_tag = ?")
      .run("2026-05-16T00:00:00.000Z", "n", "c", "t");
    raw.exec(`CREATE TRIGGER fail_retention BEFORE INSERT ON source_events
      WHEN NEW.event_kind = 'retention_pruned' BEGIN SELECT RAISE(FAIL, 'blocked'); END`);
    raw.close();
    const store = openAuditStore({ databasePath, backupDir, now: () => new Date("2026-08-14T00:00:00.000Z"), backupDatabase() {} });
    await assert.rejects(() => store.prunePayloadBatch({ cutoff: "2026-05-16T00:00:00.000Z", batchSize: 10 }), /blocked/);
    const row = store.query("SELECT payload_json, nonce, ciphertext, auth_tag, pruned_at FROM payload_blobs")[0];
    assert.notEqual(row.payload_json, "null");
    assert.equal(row.nonce, "n");
    assert.equal(row.ciphertext, "c");
    assert.equal(row.auth_tag, "t");
    assert.equal(row.pruned_at, null);
    store.close();
  });
});
