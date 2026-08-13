import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  realpathSync,
  readdirSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { validateAuditEvent } from "./event.mjs";
import { AUDIT_MIGRATIONS, checksumMigration } from "./migrations.mjs";

const BACKUP_RETAIN_COUNT = 3;
const OPEN_WRITERS = new Set();
const READONLY_PRAGMAS = new Set([
  "foreign_keys",
  "foreign_key_check",
  "foreign_key_list",
  "index_info",
  "index_list",
  "index_xinfo",
  "integrity_check",
  "journal_mode",
  "quick_check",
  "table_info",
  "table_xinfo",
]);
const LEDGER_SQL = `CREATE TABLE IF NOT EXISTS audit_migrations (
  id TEXT PRIMARY KEY,
  checksum TEXT NOT NULL,
  applied_at TEXT,
  started_at TEXT NOT NULL
)`;

export class AuditStoreError extends Error {
  constructor(message, { code, cause } = {}) {
    super(message, { cause });
    this.name = "AuditStoreError";
    this.code = code ?? "AIRKIT_AUDIT_STORE_ERROR";
  }
}

export function openAuditStore(options = {}) {
  const {
    databasePath,
    backupDir,
    readOnly = false,
    Database = DatabaseSync,
    backupDatabase = defaultBackupDatabase,
    now = () => new Date(),
  } = options;

  if (typeof databasePath !== "string" || databasePath.length === 0) {
    throw new TypeError("databasePath is required");
  }
  if (!readOnly && (typeof backupDir !== "string" || backupDir.length === 0)) {
    throw new TypeError("backupDir is required for writable audit stores");
  }

  const writerKey = canonicalDatabasePath(databasePath);
  if (!readOnly) {
    if (OPEN_WRITERS.has(writerKey)) {
      throw new AuditStoreError(`audit store already has a writer for ${databasePath}`, {
        code: "AIRKIT_AUDIT_WRITER_BUSY",
      });
    }
    OPEN_WRITERS.add(writerKey);
  }

  let db;
  let closed = false;
  try {
    if (!readOnly) {
      mkdirSync(dirname(databasePath), { recursive: true });
      mkdirSync(backupDir, { recursive: true });
      if (existsSync(databasePath)) {
        backupDatabase({ databasePath, backupDir, Database, now });
      } else {
        pruneBackups(backupDir);
      }
    }

    db = new Database(databasePath, { readOnly });
    configureConnection(db, { readOnly });
    assertReadableDatabase(db);
    if (readOnly) {
      verifyMigrationLedger(db);
    } else {
      migrate(db, now);
    }
  } catch (error) {
    if (db) safeClose(db);
    if (!readOnly) OPEN_WRITERS.delete(writerKey);
    throw normalizeOpenError(error);
  }

  return {
    ingestEvent,
    getEvent,
    recordGap,
    heartbeat,
    verify,
    query,
    close,
  };

  async function ingestEvent(event) {
    assertWritable();
    const validated = validateAuditEvent(event);
    const duplicate = findDuplicate(validated);
    if (duplicate) return { status: "duplicate" };

    const observed = isoNow(now);
    const payloadJson = JSON.stringify(validated.payload ?? null);
    const payloadMeta = payloadMetadata(validated.payload);

    execTransaction(db, () => {
      if (validated.session_id) {
        upsertSession(validated, observed);
      }
      if (payloadMeta.repository) {
        upsertRepository(payloadMeta.repository, observed);
      }
      if (payloadMeta.providerAccount) {
        upsertProviderAccount(payloadMeta.providerAccount, observed);
      }

      db.prepare(`
        INSERT INTO source_events (
          event_id,
          event_version,
          source,
          source_version,
          source_event_id,
          observed_at,
          logical_request_id,
          attempt_id,
          session_id,
          client,
          event_kind,
          provider,
          model,
          repository_id,
          inserted_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        validated.event_id,
        validated.event_version,
        validated.source,
        validated.source_version,
        validated.source_event_id,
        validated.observed_at,
        validated.logical_request_id,
        validated.attempt_id,
        validated.session_id,
        validated.client,
        validated.event_kind,
        payloadMeta.provider,
        payloadMeta.model,
        payloadMeta.repository?.id ?? null,
        observed,
      );

      if (validated.event_kind === "request_payload") {
        const payloadResult = db.prepare(`
          INSERT INTO request_payloads (event_id, payload_json, created_at)
          VALUES (?, ?, ?)
        `).run(validated.event_id, payloadJson, observed);
        db.prepare(`
          UPDATE source_events
          SET request_payload_id = ?
          WHERE event_id = ?
        `).run(Number(payloadResult.lastInsertRowid), validated.event_id);
      }

      if (validated.logical_request_id) {
        upsertRequest(validated, payloadMeta, observed);
        if (validated.event_kind === "request_payload") {
          db.prepare(`
            INSERT INTO payload_blobs (
              request_id,
              source_event_id,
              blob_kind,
              payload_json,
              created_at
            ) VALUES (?, ?, 'request', ?, ?)
            ON CONFLICT(source_event_id, blob_kind) DO NOTHING
          `).run(validated.logical_request_id, validated.event_id, payloadJson, observed);
        }
        if (validated.event_kind === "usage_reported") {
          insertUsageObservation(validated, payloadMeta);
        }
      }

      if (validated.attempt_id) {
        upsertProviderAttempt(validated, payloadMeta, observed);
      }
    });

    return { status: "committed" };
  }

  async function getEvent(eventId) {
    assertOpen();
    if (typeof eventId !== "string" || eventId.length === 0) {
      throw new TypeError("eventId must be a non-empty string");
    }
    const event = db.prepare("SELECT * FROM source_events WHERE event_id = ?").get(eventId);
    if (!event) return null;
    const requestPayload = event.request_payload_id === null
      ? null
      : db.prepare("SELECT * FROM request_payloads WHERE id = ?").get(event.request_payload_id);
    return {
      ...event,
      request_payload: requestPayload ?? null,
    };
  }

  async function recordGap(fields = {}) {
    assertWritable();
    if (typeof fields.source !== "string" || fields.source.length === 0) {
      throw new TypeError("source is required");
    }
    if (typeof fields.reason !== "string" || fields.reason.length === 0) {
      throw new TypeError("reason is required");
    }
    const recordedAt = isoNow(now);
    const detailsJson = fields.details === undefined ? null : JSON.stringify(fields.details);
    const result = db.prepare(`
      INSERT INTO collector_gaps (source, reason, details_json, recorded_at)
      VALUES (?, ?, ?, ?)
    `).run(
      fields.source,
      fields.reason,
      detailsJson,
      recordedAt,
    );
    db.prepare(`
      INSERT INTO evidence_gaps (source, source_event_id, reason, details_json, recorded_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      fields.source,
      fields.source_event_id ?? null,
      fields.reason,
      detailsJson,
      recordedAt,
    );
    return { status: "committed", id: Number(result.lastInsertRowid) };
  }

  async function heartbeat(fields = {}) {
    assertWritable();
    if (typeof fields.worker_id !== "string" || fields.worker_id.length === 0) {
      throw new TypeError("worker_id is required");
    }
    const status = fields.status ?? "alive";
    db.prepare(`
      INSERT INTO audit_heartbeats (worker_id, status, details_json, last_seen_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(worker_id) DO UPDATE SET
        status = excluded.status,
        details_json = excluded.details_json,
        last_seen_at = excluded.last_seen_at
    `).run(
      fields.worker_id,
      status,
      fields.details === undefined ? null : JSON.stringify(fields.details),
      isoNow(now),
    );
    return { status: "committed" };
  }

  function verify() {
    assertOpen();
    assertReadableDatabase(db);
    verifyMigrationLedger(db);
    const tables = new Set(db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all()
      .map((row) => row.name));
    for (const table of [
      "audit_migrations",
      "audit_heartbeats",
      "collector_gaps",
      "evidence_gaps",
      "payload_blobs",
      "pricing_versions",
      "provider_accounts",
      "provider_attempts",
      "quota_observations",
      "repositories",
      "repository_contexts",
      "request_payloads",
      "request_usage",
      "requests",
      "schema_meta",
      "session_contexts",
      "sessions",
      "source_events",
      "usage_observations",
      "usage_value_provenance",
    ]) {
      if (!tables.has(table)) {
        throw new AuditStoreError(`audit schema is missing table ${table}`, {
          code: "AIRKIT_AUDIT_VERIFY_FAILED",
        });
      }
    }
    const fkFailures = db.prepare("PRAGMA foreign_key_check").all();
    if (fkFailures.length > 0) {
      throw new AuditStoreError(`audit foreign key check failed: ${JSON.stringify(fkFailures)}`, {
        code: "AIRKIT_AUDIT_VERIFY_FAILED",
      });
    }
    return { ok: true };
  }

  function query(sql, params = []) {
    assertOpen();
    if (typeof sql !== "string" || sql.trim().length === 0) {
      throw new TypeError("sql must be a non-empty string");
    }
    assertReadOnlySql(sql);
    const values = Array.isArray(params) ? params : [params];
    return db.prepare(sql).all(...values);
  }

  function close() {
    if (closed) return;
    safeClose(db);
    closed = true;
    if (!readOnly) OPEN_WRITERS.delete(writerKey);
  }

  function findDuplicate(event) {
    const byEventId = db.prepare("SELECT event_id FROM source_events WHERE event_id = ?").get(event.event_id);
    if (byEventId) return byEventId;
    if (!event.source_event_id) return null;
    return db.prepare(`
      SELECT event_id
      FROM source_events
      WHERE source = ?
        AND source_version = ?
        AND source_event_id = ?
    `).get(event.source, event.source_version, event.source_event_id);
  }

  function upsertSession(event, observed) {
    db.prepare(`
      INSERT INTO session_contexts (session_id, client, first_observed_at, last_observed_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        last_observed_at = excluded.last_observed_at
    `).run(event.session_id, event.client, observed, event.observed_at);
    db.prepare(`
      INSERT INTO sessions (session_id, client, first_observed_at, last_observed_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        last_observed_at = excluded.last_observed_at
    `).run(event.session_id, event.client, observed, event.observed_at);
  }

  function upsertRepository(repository, observed) {
    db.prepare(`
      INSERT INTO repository_contexts (
        repository_id,
        root_encrypted_path,
        remote_encrypted_path,
        first_observed_at,
        last_observed_at
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(repository_id) DO UPDATE SET
        remote_encrypted_path = excluded.remote_encrypted_path,
        last_observed_at = excluded.last_observed_at
    `).run(
      repository.id,
      repository.root,
      repository.remote,
      observed,
      observed,
    );
    db.prepare(`
      INSERT INTO repositories (
        repository_id,
        root_encrypted_path,
        remote_encrypted_path,
        first_observed_at,
        last_observed_at
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(repository_id) DO UPDATE SET
        remote_encrypted_path = excluded.remote_encrypted_path,
        last_observed_at = excluded.last_observed_at
    `).run(
      repository.id,
      repository.root,
      repository.remote,
      observed,
      observed,
    );
  }

  function upsertProviderAccount(providerAccount, observed) {
    db.prepare(`
      INSERT INTO provider_accounts (
        provider_account_id,
        provider,
        account_hash,
        first_observed_at,
        last_observed_at
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(provider_account_id) DO UPDATE SET
        last_observed_at = excluded.last_observed_at
    `).run(
      providerAccount.id,
      providerAccount.provider,
      providerAccount.accountHash,
      observed,
      observed,
    );
  }

  function upsertRequest(event, payload, observed) {
    db.prepare(`
      INSERT INTO requests (
        request_id,
        logical_request_id,
        session_id,
        repository_id,
        provider_account_id,
        provider,
        model,
        client,
        started_at,
        last_observed_at,
        first_source_event_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(request_id) DO UPDATE SET
        session_id = COALESCE(excluded.session_id, requests.session_id),
        repository_id = COALESCE(excluded.repository_id, requests.repository_id),
        provider_account_id = COALESCE(excluded.provider_account_id, requests.provider_account_id),
        provider = COALESCE(excluded.provider, requests.provider),
        model = COALESCE(excluded.model, requests.model),
        last_observed_at = excluded.last_observed_at
    `).run(
      event.logical_request_id,
      event.logical_request_id,
      event.session_id,
      payload.repository?.id ?? null,
      payload.providerAccount?.id ?? null,
      payload.provider,
      payload.model,
      event.client,
      event.observed_at,
      observed,
      event.event_id,
    );
  }

  function insertUsageObservation(event, payload) {
    const observationResult = db.prepare(`
      INSERT INTO usage_observations (
        request_id,
        source_event_id,
        provider,
        model,
        observed_at
      ) VALUES (?, ?, ?, ?, ?)
    `).run(
      event.logical_request_id,
      event.event_id,
      payload.provider,
      payload.model,
      event.observed_at,
    );

    const usage = usageMetrics(event.payload);
    for (const [metric, value] of Object.entries(usage)) {
      const usageResult = db.prepare(`
        INSERT INTO request_usage (
          request_id,
          usage_observation_id,
          metric,
          value,
          unit
        ) VALUES (?, ?, ?, ?, 'tokens')
      `).run(
        event.logical_request_id,
        Number(observationResult.lastInsertRowid),
        metric,
        value,
      );
      db.prepare(`
        INSERT INTO usage_value_provenance (
          request_usage_id,
          source_event_id,
          evidence_path,
          provenance_kind
        ) VALUES (?, ?, ?, 'provider')
      `).run(
        Number(usageResult.lastInsertRowid),
        event.event_id,
        `$.usage.${metric}`,
      );
    }
  }

  function upsertProviderAttempt(event, payload, observed) {
    db.prepare(`
      INSERT INTO provider_attempts (
        attempt_id,
        logical_request_id,
        provider,
        model,
        first_event_id,
        first_observed_at,
        last_observed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(attempt_id) DO UPDATE SET
        provider = COALESCE(excluded.provider, provider_attempts.provider),
        model = COALESCE(excluded.model, provider_attempts.model),
        last_observed_at = excluded.last_observed_at
    `).run(
      event.attempt_id,
      event.logical_request_id,
      payload.provider,
      payload.model,
      event.event_id,
      event.observed_at,
      observed,
    );
  }

  function assertOpen() {
    if (closed) {
      throw new AuditStoreError("audit store is closed", {
        code: "AIRKIT_AUDIT_STORE_CLOSED",
      });
    }
  }

  function assertWritable() {
    assertOpen();
    if (readOnly) {
      throw new AuditStoreError("audit store is read-only", {
        code: "AIRKIT_AUDIT_READ_ONLY",
      });
    }
  }
}

function configureConnection(db, { readOnly }) {
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  if (!readOnly) {
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA secure_delete = ON");
    db.exec("PRAGMA auto_vacuum = INCREMENTAL");
  }
}

function assertReadableDatabase(db) {
  const quickCheck = db.prepare("PRAGMA quick_check").all();
  if (quickCheck.length !== 1 || quickCheck[0].quick_check !== "ok") {
    throw new AuditStoreError(`audit database quick_check failed: ${JSON.stringify(quickCheck)}`, {
      code: "AIRKIT_AUDIT_DATABASE_CORRUPT",
    });
  }
}

function migrate(db, now) {
  db.exec(LEDGER_SQL);
  const rows = migrationRows(db);
  const interrupted = rows.find((row) => row.applied_at === null);
  if (interrupted) {
    throw new AuditStoreError(`audit migration ${interrupted.id} was interrupted`, {
      code: "AIRKIT_AUDIT_MIGRATION_INTERRUPTED",
    });
  }

  for (const migration of AUDIT_MIGRATIONS) {
    const expectedChecksum = checksumMigration(migration);
    const existing = rows.find((row) => row.id === migration.id);
    if (existing) {
      if (existing.checksum !== expectedChecksum) {
        throw new AuditStoreError(`audit migration ${migration.id} checksum mismatch`, {
          code: "AIRKIT_AUDIT_MIGRATION_CHECKSUM_MISMATCH",
        });
      }
      continue;
    }

    execTransaction(db, () => {
      db.prepare(`
        INSERT INTO audit_migrations (id, checksum, started_at, applied_at)
        VALUES (?, ?, ?, NULL)
      `).run(migration.id, expectedChecksum, isoNow(now));
      db.exec(migration.statements.join(";\n"));
      db.prepare("UPDATE audit_migrations SET applied_at = ? WHERE id = ?")
        .run(isoNow(now), migration.id);
    });
  }
  verifyMigrationLedger(db);
}

function verifyMigrationLedger(db) {
  let rows;
  try {
    rows = migrationRows(db);
  } catch (error) {
    throw new AuditStoreError("audit database has not been migrated", {
      code: "AIRKIT_AUDIT_NEEDS_MIGRATION",
      cause: error,
    });
  }
  const interrupted = rows.find((row) => row.applied_at === null);
  if (interrupted) {
    throw new AuditStoreError(`audit migration ${interrupted.id} was interrupted`, {
      code: "AIRKIT_AUDIT_MIGRATION_INTERRUPTED",
    });
  }
  for (const migration of AUDIT_MIGRATIONS) {
    const row = rows.find((entry) => entry.id === migration.id);
    if (!row) {
      throw new AuditStoreError(`audit migration ${migration.id} has not been applied`, {
        code: "AIRKIT_AUDIT_NEEDS_MIGRATION",
      });
    }
    if (row.checksum !== checksumMigration(migration)) {
      throw new AuditStoreError(`audit migration ${migration.id} checksum mismatch`, {
        code: "AIRKIT_AUDIT_MIGRATION_CHECKSUM_MISMATCH",
      });
    }
  }
}

function migrationRows(db) {
  return db.prepare("SELECT id, checksum, applied_at, started_at FROM audit_migrations ORDER BY id").all();
}

function execTransaction(db, work) {
  db.exec("BEGIN IMMEDIATE");
  try {
    work();
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function defaultBackupDatabase({ databasePath, backupDir, Database = DatabaseSync, now }) {
  mkdirSync(backupDir, { recursive: true });
  if (existsSync(databasePath) && statSync(databasePath).size > 0) {
    const source = new Database(databasePath);
    try {
      source.exec("PRAGMA wal_checkpoint(FULL)");
    } finally {
      safeClose(source);
    }
    const stamp = isoNow(now).replaceAll("-", "").replaceAll(":", "").replace(".", "");
    copyFileSync(databasePath, join(backupDir, `audit-${stamp}.sqlite`));
  }
  pruneBackups(backupDir);
}

function pruneBackups(backupDir) {
  if (!existsSync(backupDir)) return;
  const backups = readdirSync(backupDir)
    .filter((name) => name.endsWith(".sqlite"))
    .sort();
  for (const name of backups.slice(0, Math.max(0, backups.length - BACKUP_RETAIN_COUNT))) {
    unlinkSync(join(backupDir, name));
  }
}

function payloadMetadata(payload) {
  if (!isRecord(payload)) {
    return { provider: null, model: null, providerAccount: null, repository: null };
  }
  const provider = stringOrNull(payload.provider ?? payload.provider_id);
  return {
    provider,
    model: stringOrNull(payload.model ?? payload.model_id),
    providerAccount: providerAccountMetadata(provider, payload),
    repository: repositoryMetadata(payload.repository),
  };
}

function providerAccountMetadata(provider, payload) {
  if (!provider) return null;
  const accountHash = stringOrNull(
    payload.provider_account_hash
      ?? payload.provider_account_hmac
      ?? payload.account_hash
      ?? payload.account_hmac,
  );
  if (!accountHash) return null;
  return {
    id: createHash("sha256").update(`${provider}\n${accountHash}`, "utf8").digest("hex"),
    provider,
    accountHash,
  };
}

function repositoryMetadata(repository) {
  if (repository === undefined || repository === null) return null;
  if (!isRecord(repository)) {
    throw new AuditStoreError("repository context must be an object", {
      code: "AIRKIT_AUDIT_INVALID_REPOSITORY",
    });
  }
  const root = packScalarEncryptedPath(repository.root ?? repository.path, "repository root encrypted path");
  const remote = repository.remote === undefined || repository.remote === null
    ? null
    : packScalarEncryptedPath(repository.remote, "repository remote encrypted path");
  return {
    id: createHash("sha256").update(`${root}\n${remote ?? ""}`, "utf8").digest("hex"),
    root,
    remote,
  };
}

function packScalarEncryptedPath(value, label) {
  if (!isRecord(value)) {
    throw new AuditStoreError(`${label} must be a packed scalar encrypted path`, {
      code: "AIRKIT_AUDIT_INVALID_ENCRYPTED_PATH",
    });
  }
  const packed = {
    v: value.v,
    k: value.k,
    n: value.n,
    c: value.c,
    t: value.t,
  };
  if (!Number.isInteger(packed.v) || packed.v < 1) {
    throwInvalidEncryptedPath(label);
  }
  for (const field of ["k", "n", "c", "t"]) {
    if (typeof packed[field] !== "string" || packed[field].length === 0) {
      throwInvalidEncryptedPath(label);
    }
  }
  return JSON.stringify(packed);
}

function throwInvalidEncryptedPath(label) {
  throw new AuditStoreError(`${label} must be packed as {v,k,n,c,t}`, {
    code: "AIRKIT_AUDIT_INVALID_ENCRYPTED_PATH",
  });
}

function normalizeOpenError(error) {
  if (error instanceof AuditStoreError) return error;
  if (/not a database|malformed|file is not a database|corrupt/i.test(error.message)) {
    return new AuditStoreError("audit database is corrupt", {
      code: "AIRKIT_AUDIT_DATABASE_CORRUPT",
      cause: error,
    });
  }
  return error;
}

function canonicalDatabasePath(databasePath) {
  try {
    return realpathSync.native(databasePath);
  } catch {
    const parent = realpathSync.native(dirname(resolve(databasePath)));
    return join(parent, basename(databasePath));
  }
}

function assertReadOnlySql(sql) {
  const trimmed = sql.trim();
  const singleStatement = trimmed.replace(/;\s*$/, "");
  if (/;\s*\S/.test(singleStatement)) {
    throw new AuditStoreError("audit store query is read-only and accepts one statement", {
      code: "AIRKIT_AUDIT_QUERY_READ_ONLY",
    });
  }

  const command = /^[A-Za-z]+/.exec(singleStatement)?.[0]?.toUpperCase();
  if (command === "SELECT") return;
  if (command === "WITH" && !/\b(INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER|PRAGMA|VACUUM|ATTACH|DETACH)\b/i.test(singleStatement)) {
    return;
  }
  if (command === "PRAGMA" && isReadOnlyPragma(singleStatement)) return;
  throw new AuditStoreError("audit store query is read-only", {
    code: "AIRKIT_AUDIT_QUERY_READ_ONLY",
  });
}

function isReadOnlyPragma(sql) {
  if (sql.includes("=")) return false;
  const match = /^PRAGMA\s+(?:["'`[]?)([A-Za-z_]+)(?:["'`\]]?)(?:\s*\([^)]*\))?\s*$/i.exec(sql);
  return match ? READONLY_PRAGMAS.has(match[1].toLowerCase()) : false;
}

function usageMetrics(payload) {
  const source = isRecord(payload?.usage) ? payload.usage : payload;
  if (!isRecord(source)) return {};
  const metrics = {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      metrics[key] = value;
    }
  }
  return metrics;
}

function safeClose(db) {
  try {
    db.close();
  } catch {
    // Closing a failed DatabaseSync should not mask the original error.
  }
}

function isoNow(now) {
  const value = now();
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function stringOrNull(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
