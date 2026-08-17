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
    await run({
      databasePath: join(root, "audit.sqlite"),
      backupDir: join(root, "backups"),
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function requestEvent(id, { observedAt = "2026-05-01T00:00:00.000Z" } = {}) {
  return createAuditEvent({
    event_id: `event-${id}`,
    source: "airkit-test",
    source_version: "1",
    source_event_id: `source-${id}`,
    observed_at: observedAt,
    event_kind: "request_payload",
    logical_request_id: `request-${id}`,
    session_id: `session-${id}`,
    client: "airclaude",
    payload: {
      provider: "oneportal",
      model: "gpt-5.6-terra",
      marker: id,
    },
  });
}

test("exportRows reads request metadata and normalized usage", async () => {
  await withStore(async ({ databasePath, backupDir }) => {
    const store = openAuditStore({ databasePath, backupDir, now: () => new Date("2026-08-14T00:00:00.000Z") });
    await store.ingestEvent(requestEvent("export"));
    await store.ingestEvent(createAuditEvent({
      event_id: "event-usage-export",
      source: "airkit-test",
      source_version: "1",
      source_event_id: "source-usage-export",
      observed_at: "2026-05-01T00:00:01.000Z",
      event_kind: "usage_reported",
      logical_request_id: "request-export",
      session_id: "session-export",
      client: "airclaude",
      payload: {
        provider: "oneportal",
        model: "gpt-5.6-terra",
        usage: {
          input_tokens: 21,
          output_tokens: 8,
          total_tokens: 29,
          cache_read_tokens: 9,
          cache_creation_tokens: 11,
        },
      },
    }));
    const rows = [];
    for await (const row of store.exportRows()) rows.push(row);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].provider, "oneportal");
    assert.equal(rows[0].model, "gpt-5.6-terra");
    assert.equal(rows[0].input_tokens, 21);
    assert.equal(rows[0].output_tokens, 8);
    assert.equal(rows[0].cache_read_tokens, 9);
    store.close();
  });
});

test("retention clears all request plaintext copies at the inclusive cutoff", async () => {
  await withStore(async ({ databasePath, backupDir }) => {
    const seed = openAuditStore({ databasePath, backupDir, now: () => new Date("2026-08-14T00:00:00.000Z") });
    for (const id of ["before", "exact", "after", "preserved"]) await seed.ingestEvent(requestEvent(id));
    seed.close();

    const raw = new DatabaseSync(databasePath);
    const update = raw.prepare(`
      UPDATE payload_blobs
      SET expires_at = ?, nonce = ?, ciphertext = ?, auth_tag = ?, preserved_at = ?
      WHERE source_event_id = ?
    `);
    update.run("2026-05-15T23:59:59.999Z", "n", "c", "t", null, "event-before");
    update.run("2026-05-16T00:00:00.000Z", "n", "c", "t", null, "event-exact");
    update.run("2026-05-16T00:00:00.001Z", "n", "c", "t", null, "event-after");
    update.run("2026-05-15T00:00:00.000Z", "n", "c", "t", "2026-05-01T00:00:00.000Z", "event-preserved");
    raw.close();

    let vacuumCalls = 0;
    const store = openAuditStore({
      databasePath,
      backupDir,
      now: () => new Date("2026-08-14T00:00:00.000Z"),
      backupDatabase() {},
      vacuum: () => { vacuumCalls += 1; },
    });
    const result = await store.prunePayloadBatch({ cutoff: "2026-05-16T00:00:00.000Z", batchSize: 10 });
    assert.deepEqual(result, { pruned: 2, preserved: 0, done: true });
    const blobs = store.query(`
      SELECT source_event_id, payload_json, nonce, ciphertext, auth_tag, wire_hash,
             evidence_hash, plaintext_bytes, pruned_at, preserved_at
      FROM payload_blobs ORDER BY source_event_id
    `);
    for (const id of ["event-before", "event-exact"]) {
      const row = blobs.find((item) => item.source_event_id === id);
      assert.equal(row.payload_json, "null");
      assert.equal(row.nonce, null);
      assert.equal(row.ciphertext, null);
      assert.equal(row.auth_tag, null);
      assert.ok(row.pruned_at);
    }
    assert.notEqual(blobs.find((row) => row.source_event_id === "event-after").payload_json, "null");
    assert.notEqual(blobs.find((row) => row.source_event_id === "event-preserved").payload_json, "null");
    assert.equal(store.query("SELECT payload_json FROM request_payloads WHERE event_id = 'event-exact'")[0].payload_json, "null");
    assert.equal(store.query("SELECT payload_json FROM source_events WHERE event_id = 'event-exact'")[0].payload_json, null);
    assert.equal(store.query("SELECT count(*) AS count FROM source_events WHERE event_kind = 'retention_pruned'")[0].count, 1);
    assert.equal(vacuumCalls, 1);
    store.close();
  });
});

test("preserve mode leaves expired payloads untouched", async () => {
  await withStore(async ({ databasePath, backupDir }) => {
    const seed = openAuditStore({ databasePath, backupDir, now: () => new Date("2026-08-14T00:00:00.000Z") });
    await seed.ingestEvent(requestEvent("keep"));
    seed.close();
    const raw = new DatabaseSync(databasePath);
    raw.prepare("UPDATE payload_blobs SET expires_at = ?, nonce = ?, ciphertext = ?, auth_tag = ?")
      .run("2026-05-16T00:00:00.000Z", "n", "c", "t");
    raw.close();
    const store = openAuditStore({ databasePath, backupDir, backupDatabase() {} });
    assert.deepEqual(await store.prunePayloadBatch({ cutoff: "2026-05-16T00:00:00.000Z", preserve: true }), { pruned: 0, preserved: 0, done: true });
    assert.notEqual(store.query("SELECT payload_json FROM payload_blobs")[0].payload_json, "null");
    store.close();
  });
});

test("retention marker failure rolls back payload clearing", async () => {
  await withStore(async ({ databasePath, backupDir }) => {
    const seed = openAuditStore({ databasePath, backupDir, now: () => new Date("2026-08-14T00:00:00.000Z") });
    await seed.ingestEvent(requestEvent("rollback"));
    seed.close();
    const raw = new DatabaseSync(databasePath);
    raw.prepare("UPDATE payload_blobs SET expires_at = ?, nonce = ?, ciphertext = ?, auth_tag = ?")
      .run("2026-05-16T00:00:00.000Z", "n", "c", "t");
    raw.exec(`CREATE TRIGGER fail_retention BEFORE INSERT ON source_events
      WHEN NEW.event_kind = 'retention_pruned' BEGIN SELECT RAISE(FAIL, 'blocked'); END`);
    raw.close();
    const store = openAuditStore({ databasePath, backupDir, backupDatabase() {} });
    await assert.rejects(() => store.prunePayloadBatch({ cutoff: "2026-05-16T00:00:00.000Z" }), /blocked/);
    const row = store.query("SELECT payload_json, nonce, ciphertext, auth_tag, pruned_at FROM payload_blobs")[0];
    assert.notEqual(row.payload_json, "null");
    assert.equal(row.nonce, "n");
    assert.equal(row.ciphertext, "c");
    assert.equal(row.auth_tag, "t");
    assert.equal(row.pruned_at, null);
    store.close();
  });
});
