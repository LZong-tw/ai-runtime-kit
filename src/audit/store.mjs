import { createHash, randomUUID } from "node:crypto";
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
import { encryptAuditValue } from "./crypto.mjs";
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
    vacuum = () => db?.exec("PRAGMA incremental_vacuum"),
    masterKey,
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
    exportManifest,
    verify,
    query,
    classifyRepository,
    groupProviderAccount,
    prunePayloadBatch,
    exportRows,
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
    const sourcePayloadJson = JSON.stringify(sourceEventPayloadMetadata(validated, payloadMeta));
    const sourcePayloadHash = createHash("sha256").update(sourcePayloadJson, "utf8").digest("hex");
    const encryptedEvidence = validated.event_kind === "request_payload" && masterKey
      ? encryptAuditValue({
        masterKey,
        purpose: "request-evidence/v1",
        identity: validated.attempt_id ?? validated.event_id,
        aad: validated.event_id,
        plaintext: payloadJson,
      })
      : null;

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

      const markerId = randomUUID();
      db.prepare(`
        INSERT INTO source_events (
          event_id,
          event_version,
          source,
          source_version,
          source_event_id,
          observed_at,
          received_at,
          logical_request_id,
          attempt_id,
          session_id,
          client,
          event_kind,
          payload_json,
          payload_hash,
          normalization_status,
          provider,
          model,
          repository_id,
          inserted_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        validated.event_id,
        validated.event_version,
        validated.source,
        validated.source_version,
        validated.source_event_id,
        validated.observed_at,
        observed,
        validated.logical_request_id,
        validated.attempt_id,
        validated.session_id,
        validated.client,
        validated.event_kind,
        sourcePayloadJson,
        sourcePayloadHash,
        "pending",
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
        const requestRecordId = upsertRequest(validated, payloadMeta, observed);
        if (validated.event_kind === "request_payload") {
          db.prepare(`
            INSERT INTO payload_blobs (
              request_id,
              source_event_id,
              blob_kind,
              payload_json,
              created_at,
              id,
              algorithm,
              key_id,
              nonce,
              ciphertext,
              auth_tag,
              wire_hash,
              evidence_hash,
              plaintext_bytes,
              redaction_count,
              expires_at
            ) VALUES (?, ?, 'request', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(source_event_id, blob_kind) DO NOTHING
          `).run(
            requestRecordId,
            validated.event_id,
            payloadJson,
            observed,
            encryptedEvidence ? `request-${validated.event_id}` : null,
            encryptedEvidence ? "aes-256-gcm" : null,
            encryptedEvidence?.keyId ?? null,
            encryptedEvidence?.nonce ?? null,
            encryptedEvidence?.ciphertext ?? null,
            encryptedEvidence?.authTag ?? null,
            sourcePayloadHash,
            encryptedEvidence ? createHash("sha256").update(payloadJson, "utf8").digest("hex") : null,
            encryptedEvidence ? Buffer.byteLength(payloadJson, "utf8") : null,
            0,
            encryptedEvidence ? new Date(Date.parse(observed) + 90 * 86400000).toISOString() : null,
          );
        }
        if (validated.event_kind === "usage_reported") {
          insertUsageObservation(validated, payloadMeta, requestRecordId);
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

  async function exportManifest() {
    assertOpen();
    return db.prepare(`
      SELECT r.request_id, pb.source_event_id AS payload_event_id, se.attempt_id
      FROM requests r
      LEFT JOIN payload_blobs pb ON pb.request_id = r.id AND pb.blob_kind = 'request'
      LEFT JOIN source_events se ON se.event_id = pb.source_event_id
      ORDER BY r.started_at, r.id
    `).all();
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

  function classifyRepository(repositoryId, classification) {
    assertWritable();
    const result = db.prepare(`
      UPDATE repositories
      SET classification = ?, classification_source = 'manual', last_seen_at = COALESCE(last_seen_at, ?)
      WHERE repository_id = ? OR id = ?
    `).run(String(classification), isoNow(now), String(repositoryId), String(repositoryId));
    return { changes: Number(result.changes ?? 0) };
  }

  function groupProviderAccount(accountId, group) {
    assertWritable();
    const result = db.prepare(`
      UPDATE provider_accounts
      SET logical_group = ?, identity_source = COALESCE(identity_source, 'manual'), last_seen_at = COALESCE(last_seen_at, ?)
      WHERE provider_account_id = ? OR id = ?
    `).run(String(group), isoNow(now), String(accountId), String(accountId));
    return { changes: Number(result.changes ?? 0) };
  }

  async function prunePayloadBatch(options = {}) {
    assertWritable();
    const cutoff = normalizeIsoTimestamp(options.cutoff, "cutoff");
    const batchSize = normalizePositiveInteger(options.batchSize ?? 500, "batchSize");
    if (options.preserve === true) {
      return { pruned: 0, preserved: 0, done: true };
    }

    const candidates = db.prepare(`
      SELECT payload_blob_id, source_event_id
      FROM payload_blobs
      WHERE blob_kind = 'request'
        AND pruned_at IS NULL
        AND preserved_at IS NULL
        AND expires_at IS NOT NULL
        AND expires_at <= ?
      ORDER BY expires_at, payload_blob_id
      LIMIT ?
    `).all(cutoff, batchSize);
    if (candidates.length === 0) {
      return { pruned: 0, preserved: 0, done: true };
    }

    const prunedAt = isoNow(now);
    execTransaction(db, () => {
      const clearBlob = db.prepare(`
        UPDATE payload_blobs
        SET
          payload_json = ?,
          nonce = NULL,
          ciphertext = NULL,
          auth_tag = NULL,
          pruned_at = ?
        WHERE payload_blob_id = ?
      `);
      const clearPayload = db.prepare(`
        UPDATE request_payloads
        SET payload_json = ?
        WHERE event_id = ?
      `);
      for (const candidate of candidates) {
        clearBlob.run("null", prunedAt, candidate.payload_blob_id);
        clearPayload.run("null", candidate.source_event_id);
      }
      insertRetentionPrunedEvent({
        cutoff,
        batchSize,
        prunedAt,
        sourceEventIds: candidates.map((candidate) => candidate.source_event_id),
      });
    });

    vacuum();

    const remaining = db.prepare(`
      SELECT count(*) AS count
      FROM payload_blobs
      WHERE blob_kind = 'request'
        AND pruned_at IS NULL
        AND preserved_at IS NULL
        AND expires_at IS NOT NULL
        AND expires_at <= ?
    `).get(cutoff).count;

    return {
      pruned: candidates.length,
      preserved: 0,
      done: remaining === 0,
    };
  }

  async function* exportRows() {
    assertOpen();
    const rows = db.prepare(`
      SELECT
        requests.request_id AS request_id,
        requests.logical_request_id AS logical_request_id,
        requests.session_id AS session_id,
        COALESCE(requests.actual_provider, requests.selected_provider, requests.provider) AS provider,
        COALESCE(requests.actual_model, requests.selected_model, requests.model) AS model,
        requests.client AS client,
        requests.status_code AS status_code,
        requests.failure_kind AS failure_kind,
        requests.effort AS effort,
        requests.started_at AS started_at,
        requests.last_observed_at AS last_observed_at,
        requests.completed_at AS completed_at,
        requests.duration_ms AS duration_ms,
        request_usage.uncached_input_tokens AS input_tokens,
        request_usage.output_tokens AS output_tokens,
        request_usage.reasoning_tokens AS reasoning_tokens,
        request_usage.provider_total_tokens AS total_tokens,
        request_usage.cache_read_tokens AS cache_read_tokens,
        request_usage.cache_creation_tokens AS cache_creation_tokens,
        requests.capture_completeness AS capture_completeness,
        payload_blobs.source_event_id AS payload_event_id,
        source_events.attempt_id AS attempt_id,
        payload_blobs.payload_json AS payload_json,
        payload_blobs.key_id AS key_id,
        payload_blobs.nonce AS nonce,
        payload_blobs.ciphertext AS ciphertext,
        payload_blobs.auth_tag AS auth_tag,
        payload_blobs.wire_hash AS wire_hash,
        payload_blobs.evidence_hash AS evidence_hash,
        payload_blobs.plaintext_bytes AS plaintext_bytes,
        payload_blobs.redaction_count AS redaction_count,
        payload_blobs.expires_at AS expires_at,
        payload_blobs.pruned_at AS pruned_at,
        payload_blobs.preserved_at AS preserved_at
      FROM requests
      LEFT JOIN request_usage
        ON request_usage.request_id = requests.id
      LEFT JOIN payload_blobs
        ON payload_blobs.payload_blob_id = (
          SELECT candidate.payload_blob_id
          FROM payload_blobs AS candidate
          WHERE candidate.request_id = requests.id
            AND candidate.blob_kind = 'request'
          ORDER BY candidate.created_at DESC, candidate.payload_blob_id DESC
          LIMIT 1
        )
      LEFT JOIN source_events
        ON source_events.event_id = payload_blobs.source_event_id
      ORDER BY requests.started_at, requests.id
    `).all();

    for (const row of rows) {
      yield row;
    }
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
    return db.prepare("SELECT id FROM requests WHERE request_id = ?")
      .get(event.logical_request_id).id;
  }

  function insertUsageObservation(event, payload, requestRecordId) {
    const usage = usageMetrics(event.payload);
    const observationResult = db.prepare(`
      INSERT INTO usage_observations (
        request_id,
        source,
        source_event_id,
        provider,
        model,
        observed_at,
        uncached_input_tokens,
        output_tokens,
        reasoning_tokens,
        cache_read_tokens,
        cache_creation_tokens,
        cache_creation_5m_tokens,
        cache_creation_1h_tokens,
        cache_miss_tokens,
        total_tokens,
        raw_usage_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      requestRecordId,
      event.source,
      event.event_id,
      payload.provider,
      payload.model,
      event.observed_at,
      usageValue(usage, "uncached_input_tokens", "input_tokens"),
      usageValue(usage, "output_tokens"),
      usageValue(usage, "reasoning_tokens"),
      usageValue(usage, "cache_read_tokens"),
      usageValue(usage, "cache_creation_tokens"),
      usageValue(usage, "cache_creation_5m_tokens"),
      usageValue(usage, "cache_creation_1h_tokens"),
      usageValue(usage, "cache_miss_tokens"),
      usageValue(usage, "total_tokens"),
      JSON.stringify(usage),
    );

    db.prepare(`
      INSERT INTO request_usage (
        request_id,
        usage_observation_id,
        uncached_input_tokens,
        output_tokens,
        reasoning_tokens,
        cache_read_tokens,
        cache_creation_tokens,
        cache_creation_5m_tokens,
        cache_creation_1h_tokens,
        cache_miss_tokens,
        provider_total_tokens,
        normalization_state
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'normalized')
      ON CONFLICT(request_id) DO UPDATE SET
        usage_observation_id = excluded.usage_observation_id,
        uncached_input_tokens = excluded.uncached_input_tokens,
        output_tokens = excluded.output_tokens,
        reasoning_tokens = excluded.reasoning_tokens,
        cache_read_tokens = excluded.cache_read_tokens,
        cache_creation_tokens = excluded.cache_creation_tokens,
        cache_creation_5m_tokens = excluded.cache_creation_5m_tokens,
        cache_creation_1h_tokens = excluded.cache_creation_1h_tokens,
        cache_miss_tokens = excluded.cache_miss_tokens,
        provider_total_tokens = excluded.provider_total_tokens,
        normalization_state = excluded.normalization_state
    `).run(
      requestRecordId,
      Number(observationResult.lastInsertRowid),
      usageValue(usage, "uncached_input_tokens", "input_tokens"),
      usageValue(usage, "output_tokens"),
      usageValue(usage, "reasoning_tokens"),
      usageValue(usage, "cache_read_tokens"),
      usageValue(usage, "cache_creation_tokens"),
      usageValue(usage, "cache_creation_5m_tokens"),
      usageValue(usage, "cache_creation_1h_tokens"),
      usageValue(usage, "cache_miss_tokens"),
      usageValue(usage, "provider_total_tokens", "total_tokens"),
    );

    const usageResult = db.prepare("SELECT request_usage_id FROM request_usage WHERE request_id = ?")
      .get(requestRecordId);
    for (const [metric, value] of Object.entries(usage)) {
      db.prepare(`
        INSERT INTO usage_value_provenance (
          request_usage_id,
          request_id,
          metric,
          value,
          provenance,
          confidence,
          source_event_id,
          evidence_path,
          provenance_kind
        ) VALUES (?, ?, ?, ?, 'provider', 1, ?, ?, 'provider')
      `).run(
        usageResult.request_usage_id,
        requestRecordId,
        metric,
        value,
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

  function insertRetentionPrunedEvent({ cutoff, batchSize, prunedAt, sourceEventIds }) {
    const payloadJson = JSON.stringify({
      cutoff,
      pruned: sourceEventIds.length,
      batch_size: batchSize,
    });
    const payloadHash = createHash("sha256").update(payloadJson, "utf8").digest("hex");
    const digest = createHash("sha256")
      .update(cutoff, "utf8")
      .update("\n", "utf8")
      .update(prunedAt, "utf8")
      .update("\n", "utf8")
      .update(sourceEventIds.join(","), "utf8")
      .digest("hex");
    const eventId = `retention_pruned_${digest.slice(0, 24)}`;

    db.prepare(`
      INSERT INTO source_events (
        event_id,
        event_version,
        source,
        source_version,
        source_event_id,
        observed_at,
        received_at,
        logical_request_id,
        attempt_id,
        session_id,
        client,
        event_kind,
        payload_json,
        payload_hash,
        normalization_status,
        provider,
        model,
        repository_id,
        inserted_at
      ) VALUES (?, 1, 'airkit-audit', '1', ?, ?, ?, NULL, NULL, NULL, 'airkit', 'retention_pruned', ?, ?, 'normalized', NULL, NULL, NULL, ?)
    `).run(
      eventId,
      eventId,
      prunedAt,
      prunedAt,
      payloadJson,
      payloadHash,
      prunedAt,
    );
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

function sourceEventPayloadMetadata(event, payload) {
  return {
    event_kind: event.event_kind,
    provider: payload.provider,
    model: payload.model,
    provider_account_id: payload.providerAccount?.id ?? null,
    repository_id: payload.repository?.id ?? null,
    has_payload: event.payload !== null && event.payload !== undefined,
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

function normalizeIsoTimestamp(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty ISO timestamp`);
  }
  const date = new Date(value);
  if (Number.isNaN(date.valueOf()) || date.toISOString() !== value) {
    throw new RangeError(`${label} must be an exact ISO timestamp`);
  }
  return value;
}

function normalizePositiveInteger(value, label) {
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(`${label} must be a positive integer`);
  }
  return value;
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

function usageValue(metrics, ...names) {
  for (const name of names) {
    if (Object.hasOwn(metrics, name)) return metrics[name];
  }
  return null;
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
