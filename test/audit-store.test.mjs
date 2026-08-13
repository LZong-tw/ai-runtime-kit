import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
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

const APPROVED_SCHEMA_COLUMNS = Object.freeze({
  requests: [
    "request_id",
    "logical_request_id",
    "attempt_id",
    "attempt_number",
    "session_id",
    "session_record_id",
    "client",
    "repository_id",
    "repository_classification",
    "worktree_path_encrypted",
    "branch",
    "head_sha",
    "selected_route",
    "selected_provider",
    "selected_account_id",
    "selected_model",
    "actual_provider",
    "actual_account_id",
    "actual_model",
    "effort",
    "started_at",
    "completed_at",
    "status_code",
    "failure_kind",
    "duration_ms",
    "request_payload_id",
    "response_hash",
    "response_bytes",
    "capture_completeness",
    "correlation_confidence",
  ],
  payload_blobs: [
    "id",
    "request_id",
    "algorithm",
    "key_id",
    "nonce",
    "ciphertext",
    "auth_tag",
    "wire_hash",
    "evidence_hash",
    "plaintext_bytes",
    "redaction_count",
    "created_at",
    "expires_at",
    "pruned_at",
    "preserved_at",
  ],
  usage_observations: [
    "id",
    "request_id",
    "source",
    "source_event_id",
    "observed_at",
    "uncached_input_tokens",
    "output_tokens",
    "reasoning_tokens",
    "cache_read_tokens",
    "cache_creation_tokens",
    "cache_creation_5m_tokens",
    "cache_creation_1h_tokens",
    "cache_miss_tokens",
    "total_tokens",
    "raw_usage_json",
  ],
  request_usage: [
    "request_id",
    "uncached_input_tokens",
    "output_tokens",
    "reasoning_tokens",
    "cache_read_tokens",
    "cache_creation_tokens",
    "cache_creation_5m_tokens",
    "cache_creation_1h_tokens",
    "cache_miss_tokens",
    "provider_total_tokens",
    "effective_context_tokens",
    "cache_read_rate",
    "cache_write_rate",
    "uncached_rate",
    "cache_reuse_ratio",
    "uncached_input_cost",
    "cache_read_cost",
    "cache_creation_5m_cost",
    "cache_creation_1h_cost",
    "reasoning_cost",
    "output_cost",
    "derived_total_cost",
    "pricing_version_id",
    "normalization_state",
  ],
  usage_value_provenance: [
    "request_id",
    "metric",
    "value",
    "provenance",
    "confidence",
    "source_event_id",
    "conflict_group",
  ],
  repositories: [
    "id",
    "identity_hash",
    "root_path_encrypted",
    "remote_hash",
    "remote_display",
    "classification",
    "classification_source",
    "first_seen_at",
    "last_seen_at",
  ],
  provider_accounts: [
    "id",
    "provider",
    "account_hmac",
    "logical_group",
    "credential_kind",
    "display_label",
    "identity_source",
    "first_seen_at",
    "last_seen_at",
  ],
  sessions: [
    "id",
    "client",
    "client_session_id_hmac",
    "started_at",
    "last_seen_at",
    "initial_repository_id",
    "launcher_mode",
    "capture_started_at",
    "capture_ended_at",
  ],
  evidence_gaps: [
    "id",
    "source",
    "started_at",
    "ended_at",
    "reason",
    "detected_by",
    "affected_client",
    "affected_session",
    "resolution",
  ],
  pricing_versions: [
    "id",
    "provider",
    "billing_model",
    "model",
    "effective_from",
    "effective_until",
    "currency",
    "input_price",
    "output_price",
    "reasoning_price",
    "cache_read_price",
    "cache_creation_5m_price",
    "cache_creation_1h_price",
    "source_reference",
    "verified_at",
  ],
  quota_observations: [
    "id",
    "provider_account_id",
    "quota_window",
    "quota_utilization",
    "quota_remaining",
    "observed_at",
    "source",
  ],
});

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

      const tableNames = new Set(store.query("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name")
        .map((row) => row.name));
      for (const expected of [
        "audit_migrations",
        "evidence_gaps",
        "payload_blobs",
        "pricing_versions",
        "provider_accounts",
        "quota_observations",
        "repositories",
        "request_payloads",
        "request_usage",
        "requests",
        "sessions",
        "schema_meta",
        "source_events",
        "usage_observations",
        "usage_value_provenance",
      ]) {
        assert.ok(tableNames.has(expected), `missing approved table ${expected}`);
      }

      const indexNames = store.query("SELECT name FROM sqlite_schema WHERE type = 'index' ORDER BY name")
        .map((row) => row.name);
      for (const expected of [
        "idx_payload_blobs_request_id",
        "idx_quota_observations_provider_time",
        "idx_request_usage_request_id",
        "idx_requests_provider_model",
        "idx_requests_repository_id",
        "idx_requests_session_id",
        "idx_requests_started_at",
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

test("approved design tables expose every approved column", async () => {
  await withRoot(async (paths) => {
    const store = openTestStore(paths);
    try {
      for (const [table, expectedColumns] of Object.entries(APPROVED_SCHEMA_COLUMNS)) {
        const actualColumns = new Set(store.query(`PRAGMA table_info(${table})`).map((row) => row.name));
        for (const column of expectedColumns) {
          assert.ok(actualColumns.has(column), `${table} is missing approved column ${column}`);
        }
      }
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

test("migration backups retain the newest three snapshots", async () => {
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
    assert.equal(names.length, 3);
    assert.deepEqual(names, [
      "audit-2026-old-5.sqlite",
      "audit-2026-old-6.sqlite",
      "audit-20260813T020304005Z.sqlite",
    ]);
  });
});

test("verify reports foreign-key and schema failures", async () => {
  await withRoot(async (paths) => {
    let store = openTestStore(paths);
    await store.ingestEvent(createFixture());
    store.close();

    const raw = new DatabaseSync(paths.databasePath);
    raw.exec("PRAGMA foreign_keys = OFF; DELETE FROM request_payloads; PRAGMA foreign_keys = ON");
    raw.close();

    store = openTestStore(paths, { readOnly: true });
    try {
      assert.throws(
        () => store.verify(),
        (error) => error.code === "AIRKIT_AUDIT_VERIFY_FAILED" && /foreign key/i.test(error.message),
      );
    } finally {
      store.close();
    }
  });
});

test("writer lock canonicalizes database identity across symlinks", async () => {
  await withRoot(async (paths) => {
    const aliasPath = join(paths.root, "audit-alias.sqlite");
    const store = openTestStore(paths);
    try {
      await symlink(paths.databasePath, aliasPath);
      assert.throws(
        () => openTestStore({ ...paths, databasePath: aliasPath }),
        (error) => error.code === "AIRKIT_AUDIT_WRITER_BUSY",
      );
    } finally {
      store.close();
    }
  });
});

test("migration backups include WAL frames from a live source database", async () => {
  await withRoot(async (paths) => {
    await mkdir(paths.backupDir, { recursive: true });
    const raw = new DatabaseSync(paths.databasePath);
    raw.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE legacy_wal_rows (id INTEGER PRIMARY KEY, marker TEXT NOT NULL);
      INSERT INTO legacy_wal_rows (marker) VALUES ('row only visible through wal');
    `);

    try {
      const store = openTestStore(paths);
      store.close();

      const [backupName] = (await readdir(paths.backupDir)).filter((name) => name.endsWith(".sqlite")).sort();
      const backup = new DatabaseSync(join(paths.backupDir, backupName), { readOnly: true });
      try {
        assert.equal(
          backup.prepare("SELECT marker FROM legacy_wal_rows WHERE id = 1").get().marker,
          "row only visible through wal",
        );
      } finally {
        backup.close();
      }
    } finally {
      raw.close();
    }
  });
});

test("public query only allows read-only SQL", async () => {
  await withRoot(async (paths) => {
    const store = openTestStore(paths);
    try {
      assert.equal(store.query("SELECT count(*) AS n FROM source_events")[0].n, 0);
      assert.throws(() => store.query("INSERT INTO source_events (event_id) VALUES ('bad')"), /read-only/i);
      assert.throws(() => store.query("DELETE FROM source_events"), /read-only/i);
      assert.throws(() => store.query("UPDATE schema_meta SET value = '2'"), /read-only/i);
      assert.throws(() => store.query("PRAGMA foreign_keys = OFF"), /read-only/i);
      assert.equal(store.query("PRAGMA foreign_keys")[0].foreign_keys, 1);
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
    const sourceFixturePath = join(paths.root, "request-logs-source.sqlite");
    const auditCopyPath = paths.databasePath;
    const fixture = new DatabaseSync(sourceFixturePath);
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

    const sourceBefore = sha256(await readFile(sourceFixturePath));
    await copyFile(sourceFixturePath, auditCopyPath);
    assert.equal(sha256(await readFile(auditCopyPath)), sourceBefore);

    const store = openTestStore(paths);
    try {
      assert.equal(sha256(await readFile(sourceFixturePath)), sourceBefore);
      assert.equal(store.query("SELECT count(*) AS n FROM request_logs")[0].n, 1);
      assert.equal(store.query("SELECT count(*) AS n FROM audit_migrations")[0].n, AUDIT_MIGRATIONS.length);
      assert.ok(
        new Set(store.query("PRAGMA table_info(requests)").map((row) => row.name))
          .has("capture_completeness"),
      );
    } finally {
      store.close();
    }

    const sourceReadOnly = new DatabaseSync(sourceFixturePath, { readOnly: true });
    try {
      assert.deepEqual(
        sourceReadOnly.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name").all()
          .map((row) => row.name),
        ["request_logs"],
      );
    } finally {
      sourceReadOnly.close();
    }
  });
});
