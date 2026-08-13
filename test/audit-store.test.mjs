import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { DatabaseSync } from "node:sqlite";

import { AUDIT_EVENT_VERSION, createAuditEvent } from "../src/audit/event.mjs";
import { AUDIT_MIGRATIONS } from "../src/audit/migrations.mjs";
import { openAuditStore } from "../src/audit/store.mjs";

const REQUIRED_NODE = [22, 13, 0];

function requireNodeFloor() {
  const actual = process.versions.node.split(".").map(Number);
  for (let index = 0; index < REQUIRED_NODE.length; index += 1) {
    if (actual[index] > REQUIRED_NODE[index]) return;
    if (actual[index] < REQUIRED_NODE[index]) {
      throw new Error(`audit store tests require Node >=22.13.0, got ${process.versions.node}`);
    }
  }
}

requireNodeFloor();

function createFixture(overrides = {}) {
  return createAuditEvent({
    event_id: "event_01",
    event_version: AUDIT_EVENT_VERSION,
    source: "airkit-test",
    source_version: "1.0.0",
    source_event_id: "source_event_01",
    observed_at: "2026-08-13T01:02:03.004Z",
    event_kind: "request_payload",
    logical_request_id: "req_01",
    attempt_id: null,
    session_id: "session_01",
    client: "airclaude",
    payload: {
      provider: "oneportal",
      model: "claude-sonnet-5",
      repository: {
        root: packEncryptedPath({ nonce: "00", ciphertext: "root" }),
        remote: packEncryptedPath({ nonce: "01", ciphertext: "remote" }),
      },
      body: { messages: [{ role: "user", content: "hello" }] },
    },
    ...overrides,
  });
}

function packEncryptedPath({ nonce, ciphertext }) {
  return { v: 1, k: "path-key-v1", n: nonce, c: ciphertext, t: "tag" };
}

async function withRoot(run) {
  const root = await mkdtemp(join(tmpdir(), "airkit-audit-store-"));
  try {
    await run({
      root,
      databasePath: join(root, "audit.sqlite"),
      backupDir: join(root, "backups"),
    });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

async function mkdtemp(prefix) {
  const { mkdtemp: realMkdtemp } = await import("node:fs/promises");
  return realMkdtemp(prefix);
}

function openTestStore(paths, overrides = {}) {
  return openAuditStore({
    databasePath: paths.databasePath,
    backupDir: paths.backupDir,
    Database: DatabaseSync,
    now: () => new Date("2026-08-13T02:03:04.005Z"),
    ...overrides,
  });
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

test("clean create installs the approved schema, pragmas, and searchable indexes", async () => {
  await withRoot(async (paths) => {
    const store = openTestStore(paths);
    try {
      const migrationRows = store.query(
        "SELECT id, checksum, applied_at FROM audit_migrations ORDER BY id",
      );
      assert.equal(migrationRows.length, AUDIT_MIGRATIONS.length);
      assert.deepEqual(migrationRows.map((row) => row.id), AUDIT_MIGRATIONS.map((migration) => migration.id));
      assert.ok(migrationRows.every((row) => /^[a-f0-9]{64}$/.test(row.checksum)));
      assert.ok(migrationRows.every((row) => row.applied_at === "2026-08-13T02:03:04.005Z"));

      const tableNames = store.query("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name")
        .map((row) => row.name);
      assert.deepEqual(tableNames, [
        "audit_heartbeats",
        "audit_migrations",
        "collector_gaps",
        "provider_attempts",
        "repository_contexts",
        "request_payloads",
        "schema_meta",
        "session_contexts",
        "source_events",
      ]);

      const indexNames = store.query("SELECT name FROM sqlite_schema WHERE type = 'index' ORDER BY name")
        .map((row) => row.name);
      for (const expected of [
        "idx_source_events_logical_request_id",
        "idx_source_events_observed_at",
        "idx_source_events_provider_model",
        "idx_source_events_repository_id",
        "idx_source_events_session_id",
        "idx_source_events_source",
        "idx_source_events_source_event_id",
        "idx_source_events_time_provider_model",
        "sqlite_autoindex_source_events_1",
        "sqlite_autoindex_source_events_2",
      ]) {
        assert.ok(indexNames.includes(expected), `missing index ${expected}`);
      }

      assert.equal(store.query("PRAGMA foreign_keys")[0].foreign_keys, 1);
      assert.equal(store.query("PRAGMA journal_mode")[0].journal_mode, "wal");
      assert.deepEqual(store.verify(), { ok: true });
    } finally {
      store.close();
    }
  });
});

test("duplicate source events commit exactly once", async () => {
  await withRoot(async (paths) => {
    const store = openTestStore(paths);
    try {
      const event = createFixture();

      assert.deepEqual(await store.ingestEvent(event), { status: "committed" });
      assert.deepEqual(await store.ingestEvent(event), { status: "duplicate" });
      assert.equal(store.query("SELECT count(*) AS n FROM source_events")[0].n, 1);
      assert.equal(store.query("SELECT count(*) AS n FROM request_payloads")[0].n, 1);

      const stored = await store.getEvent(event.event_id);
      assert.equal(stored.event_id, event.event_id);
      assert.equal(stored.request_payload.payload_json, JSON.stringify(event.payload));
    } finally {
      store.close();
    }
  });
});

test("request payload insertion and event update are atomic under constraint failures", async () => {
  await withRoot(async (paths) => {
    const store = openTestStore(paths);
    try {
      await assert.rejects(
        store.ingestEvent(createFixture({
          event_id: "event_bad_path",
          source_event_id: "source_bad_path",
          payload: {
            provider: "oneportal",
            model: "claude-sonnet-5",
            repository: { root: { version: 1, nonce: "not-packed" } },
          },
        })),
        /encrypted path/i,
      );
      assert.equal(store.query("SELECT count(*) AS n FROM source_events")[0].n, 0);
      assert.equal(store.query("SELECT count(*) AS n FROM request_payloads")[0].n, 0);
    } finally {
      store.close();
    }
  });
});

test("migration checksum mismatch rejects the database before applying new work", async () => {
  await withRoot(async (paths) => {
    let store = openTestStore(paths);
    store.close();

    const raw = new DatabaseSync(paths.databasePath);
    raw.exec("UPDATE audit_migrations SET checksum = 'bad' WHERE id = '001_initial_audit_store'");
    raw.close();

    assert.throws(
      () => openTestStore(paths),
      (error) =>
        error.code === "AIRKIT_AUDIT_MIGRATION_CHECKSUM_MISMATCH" &&
        /001_initial_audit_store/.test(error.message),
    );
  });
});

test("interrupted migration rows stop startup and preserve a backup", async () => {
  await withRoot(async (paths) => {
    await mkdir(paths.backupDir, { recursive: true });
    const raw = new DatabaseSync(paths.databasePath);
    raw.exec(`
      CREATE TABLE audit_migrations (
        id TEXT PRIMARY KEY,
        checksum TEXT NOT NULL,
        applied_at TEXT,
        started_at TEXT NOT NULL
      );
      INSERT INTO audit_migrations (id, checksum, applied_at, started_at)
        VALUES ('001_initial_audit_store', '${"0".repeat(64)}', NULL, '2026-08-13T01:00:00.000Z');
    `);
    raw.close();

    assert.throws(
      () => openTestStore(paths),
      (error) =>
        error.code === "AIRKIT_AUDIT_MIGRATION_INTERRUPTED" &&
        /001_initial_audit_store/.test(error.message),
    );
    assert.ok((await readdir(paths.backupDir)).some((name) => name.endsWith(".sqlite")));
  });
});

test("migration backups retain the newest five snapshots", async () => {
  await withRoot(async (paths) => {
    await mkdir(paths.backupDir, { recursive: true });
    for (let index = 0; index < 7; index += 1) {
      await writeFile(join(paths.backupDir, `audit-2026-old-${index}.sqlite`), `old-${index}`);
    }
    const legacy = new DatabaseSync(paths.databasePath);
    legacy.exec("CREATE TABLE legacy_marker (id TEXT PRIMARY KEY)");
    legacy.close();

    const store = openTestStore(paths);
    store.close();

    const names = (await readdir(paths.backupDir)).filter((name) => name.endsWith(".sqlite")).sort();
    assert.equal(names.length, 5);
    assert.deepEqual(names, [
      "audit-2026-old-3.sqlite",
      "audit-2026-old-4.sqlite",
      "audit-2026-old-5.sqlite",
      "audit-2026-old-6.sqlite",
      "audit-20260813T020304005Z.sqlite",
    ]);
  });
});

test("verify reports foreign-key and schema failures", async () => {
  await withRoot(async (paths) => {
    const store = openTestStore(paths);
    try {
      await store.ingestEvent(createFixture());
      store.query("PRAGMA foreign_keys = OFF");
      store.query("DELETE FROM request_payloads");
      store.query("PRAGMA foreign_keys = ON");

      assert.throws(
        () => store.verify(),
        (error) => error.code === "AIRKIT_AUDIT_VERIFY_FAILED" && /foreign key/i.test(error.message),
      );
    } finally {
      store.close();
    }
  });
});

test("corrupt database files are rejected without creating a fresh store over them", async () => {
  await withRoot(async (paths) => {
    await writeFile(paths.databasePath, "not a sqlite database");

    assert.throws(
      () => openTestStore(paths),
      (error) =>
        error.code === "AIRKIT_AUDIT_DATABASE_CORRUPT" &&
        /not a database|malformed|file is not a database|corrupt/i.test(error.cause?.message ?? error.message),
    );
  });
});

test("read-only stores can query but reject writes", async () => {
  await withRoot(async (paths) => {
    let store = openTestStore(paths);
    await store.ingestEvent(createFixture());
    store.close();

    store = openTestStore(paths, { readOnly: true });
    try {
      assert.equal(store.query("SELECT count(*) AS n FROM source_events")[0].n, 1);
      await assert.rejects(store.ingestEvent(createFixture({ event_id: "event_readonly" })), /read-only/i);
      await assert.rejects(store.recordGap({ source: "airkit-test", reason: "spool overflow" }), /read-only/i);
      await assert.rejects(store.heartbeat({ worker_id: "collector-1", status: "alive" }), /read-only/i);
    } finally {
      store.close();
    }
  });
});

test("audit migrations never mutate the CCR fixture bytes", async () => {
  await withRoot(async (paths) => {
    const fixturePath = join(paths.root, "request-logs-fixture.sqlite");
    const fixture = new DatabaseSync(fixturePath);
    fixture.exec(`
      CREATE TABLE request_logs (
        id INTEGER PRIMARY KEY,
        request_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      INSERT INTO request_logs (request_id, provider, model, created_at)
        VALUES ('req_01', 'oneportal', 'claude-sonnet-5', '2026-08-13T01:00:00.000Z');
    `);
    fixture.close();

    const before = sha256(await readFile(fixturePath));
    await copyFile(fixturePath, paths.databasePath);

    const store = openTestStore(paths);
    store.close();

    assert.equal(sha256(await readFile(fixturePath)), before);
  });
});
