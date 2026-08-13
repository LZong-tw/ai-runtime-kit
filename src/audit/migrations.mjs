import { createHash } from "node:crypto";

const INITIAL_AUDIT_STORE_STATEMENTS = Object.freeze([
  `CREATE TABLE IF NOT EXISTS schema_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS request_payloads (
    id INTEGER PRIMARY KEY,
    event_id TEXT NOT NULL UNIQUE
      REFERENCES source_events(event_id) DEFERRABLE INITIALLY DEFERRED,
    payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS source_events (
    event_id TEXT PRIMARY KEY,
    event_version INTEGER NOT NULL CHECK (event_version = 1),
    source TEXT NOT NULL CHECK (length(source) > 0),
    source_version TEXT NOT NULL CHECK (length(source_version) > 0),
    source_event_id TEXT CHECK (source_event_id IS NULL OR length(source_event_id) > 0),
    observed_at TEXT NOT NULL CHECK (length(observed_at) > 0),
    logical_request_id TEXT CHECK (logical_request_id IS NULL OR length(logical_request_id) > 0),
    attempt_id TEXT CHECK (attempt_id IS NULL OR length(attempt_id) > 0),
    session_id TEXT CHECK (session_id IS NULL OR length(session_id) > 0),
    client TEXT NOT NULL CHECK (length(client) > 0),
    event_kind TEXT NOT NULL CHECK (event_kind IN (
      'request_started',
      'request_payload',
      'route_selected',
      'provider_request',
      'provider_response',
      'usage_reported',
      'meter_reported',
      'quota_reported',
      'headroom_reported',
      'request_failed',
      'session_context',
      'repository_context',
      'collector_lifecycle',
      'collector_gap',
      'retention_pruned',
      'payload_revealed'
    )),
    provider TEXT CHECK (provider IS NULL OR length(provider) > 0),
    model TEXT CHECK (model IS NULL OR length(model) > 0),
    repository_id TEXT CHECK (repository_id IS NULL OR length(repository_id) > 0),
    request_payload_id INTEGER
      REFERENCES request_payloads(id) DEFERRABLE INITIALLY DEFERRED,
    inserted_at TEXT NOT NULL,
    UNIQUE (source, source_version, source_event_id)
  )`,
  `CREATE TABLE IF NOT EXISTS session_contexts (
    session_id TEXT PRIMARY KEY,
    client TEXT NOT NULL CHECK (length(client) > 0),
    first_observed_at TEXT NOT NULL,
    last_observed_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS repository_contexts (
    repository_id TEXT PRIMARY KEY,
    root_encrypted_path TEXT NOT NULL CHECK (
      json_valid(root_encrypted_path)
      AND json_type(root_encrypted_path, '$.v') = 'integer'
      AND json_type(root_encrypted_path, '$.k') = 'text'
      AND json_type(root_encrypted_path, '$.n') = 'text'
      AND json_type(root_encrypted_path, '$.c') = 'text'
      AND json_type(root_encrypted_path, '$.t') = 'text'
    ),
    remote_encrypted_path TEXT CHECK (
      remote_encrypted_path IS NULL OR (
        json_valid(remote_encrypted_path)
        AND json_type(remote_encrypted_path, '$.v') = 'integer'
        AND json_type(remote_encrypted_path, '$.k') = 'text'
        AND json_type(remote_encrypted_path, '$.n') = 'text'
        AND json_type(remote_encrypted_path, '$.c') = 'text'
        AND json_type(remote_encrypted_path, '$.t') = 'text'
      )
    ),
    first_observed_at TEXT NOT NULL,
    last_observed_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS provider_attempts (
    attempt_id TEXT PRIMARY KEY,
    logical_request_id TEXT NOT NULL CHECK (length(logical_request_id) > 0),
    provider TEXT CHECK (provider IS NULL OR length(provider) > 0),
    model TEXT CHECK (model IS NULL OR length(model) > 0),
    first_event_id TEXT NOT NULL
      REFERENCES source_events(event_id) DEFERRABLE INITIALLY DEFERRED,
    first_observed_at TEXT NOT NULL,
    last_observed_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS collector_gaps (
    id INTEGER PRIMARY KEY,
    source TEXT NOT NULL CHECK (length(source) > 0),
    reason TEXT NOT NULL CHECK (length(reason) > 0),
    details_json TEXT CHECK (details_json IS NULL OR json_valid(details_json)),
    recorded_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS audit_heartbeats (
    worker_id TEXT PRIMARY KEY,
    status TEXT NOT NULL CHECK (status IN ('alive', 'stopping', 'error')),
    details_json TEXT CHECK (details_json IS NULL OR json_valid(details_json)),
    last_seen_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_source_events_source
    ON source_events(source, source_version)`,
  `CREATE INDEX IF NOT EXISTS idx_source_events_source_event_id
    ON source_events(source_event_id)`,
  `CREATE INDEX IF NOT EXISTS idx_source_events_logical_request_id
    ON source_events(logical_request_id)`,
  `CREATE INDEX IF NOT EXISTS idx_source_events_session_id
    ON source_events(session_id)`,
  `CREATE INDEX IF NOT EXISTS idx_source_events_observed_at
    ON source_events(observed_at)`,
  `CREATE INDEX IF NOT EXISTS idx_source_events_provider_model
    ON source_events(provider, model)`,
  `CREATE INDEX IF NOT EXISTS idx_source_events_time_provider_model
    ON source_events(observed_at, provider, model)`,
  `CREATE INDEX IF NOT EXISTS idx_source_events_repository_id
    ON source_events(repository_id)`,
  `CREATE INDEX IF NOT EXISTS idx_provider_attempts_request
    ON provider_attempts(logical_request_id, provider, model)`,
  `CREATE INDEX IF NOT EXISTS idx_collector_gaps_source_time
    ON collector_gaps(source, recorded_at)`,
  `INSERT OR REPLACE INTO schema_meta (key, value)
    VALUES ('audit_schema_version', '1')`,
]);

const APPROVED_AUDIT_DESIGN_STATEMENTS = Object.freeze([
  `CREATE TABLE IF NOT EXISTS sessions (
    session_id TEXT PRIMARY KEY,
    client TEXT NOT NULL CHECK (length(client) > 0),
    first_observed_at TEXT NOT NULL,
    last_observed_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS repositories (
    repository_id TEXT PRIMARY KEY,
    root_encrypted_path TEXT NOT NULL CHECK (
      json_valid(root_encrypted_path)
      AND json_type(root_encrypted_path, '$.v') = 'integer'
      AND json_type(root_encrypted_path, '$.k') = 'text'
      AND json_type(root_encrypted_path, '$.n') = 'text'
      AND json_type(root_encrypted_path, '$.c') = 'text'
      AND json_type(root_encrypted_path, '$.t') = 'text'
    ),
    remote_encrypted_path TEXT CHECK (
      remote_encrypted_path IS NULL OR (
        json_valid(remote_encrypted_path)
        AND json_type(remote_encrypted_path, '$.v') = 'integer'
        AND json_type(remote_encrypted_path, '$.k') = 'text'
        AND json_type(remote_encrypted_path, '$.n') = 'text'
        AND json_type(remote_encrypted_path, '$.c') = 'text'
        AND json_type(remote_encrypted_path, '$.t') = 'text'
      )
    ),
    first_observed_at TEXT NOT NULL,
    last_observed_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS provider_accounts (
    provider_account_id TEXT PRIMARY KEY,
    provider TEXT NOT NULL CHECK (length(provider) > 0),
    account_hash TEXT NOT NULL CHECK (length(account_hash) > 0),
    first_observed_at TEXT NOT NULL,
    last_observed_at TEXT NOT NULL,
    UNIQUE (provider, account_hash)
  )`,
  `CREATE TABLE IF NOT EXISTS requests (
    request_id TEXT PRIMARY KEY,
    logical_request_id TEXT NOT NULL UNIQUE CHECK (length(logical_request_id) > 0),
    session_id TEXT REFERENCES sessions(session_id) DEFERRABLE INITIALLY DEFERRED,
    repository_id TEXT REFERENCES repositories(repository_id) DEFERRABLE INITIALLY DEFERRED,
    provider_account_id TEXT REFERENCES provider_accounts(provider_account_id) DEFERRABLE INITIALLY DEFERRED,
    provider TEXT CHECK (provider IS NULL OR length(provider) > 0),
    model TEXT CHECK (model IS NULL OR length(model) > 0),
    client TEXT NOT NULL CHECK (length(client) > 0),
    started_at TEXT NOT NULL,
    last_observed_at TEXT NOT NULL,
    first_source_event_id TEXT NOT NULL
      REFERENCES source_events(event_id) DEFERRABLE INITIALLY DEFERRED
  )`,
  `CREATE TABLE IF NOT EXISTS payload_blobs (
    payload_blob_id INTEGER PRIMARY KEY,
    request_id TEXT NOT NULL REFERENCES requests(request_id) DEFERRABLE INITIALLY DEFERRED,
    source_event_id TEXT NOT NULL REFERENCES source_events(event_id) DEFERRABLE INITIALLY DEFERRED,
    blob_kind TEXT NOT NULL CHECK (blob_kind IN ('request', 'response', 'evidence')),
    payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
    created_at TEXT NOT NULL,
    UNIQUE (source_event_id, blob_kind)
  )`,
  `CREATE TABLE IF NOT EXISTS usage_observations (
    usage_observation_id INTEGER PRIMARY KEY,
    request_id TEXT NOT NULL REFERENCES requests(request_id) DEFERRABLE INITIALLY DEFERRED,
    source_event_id TEXT NOT NULL REFERENCES source_events(event_id) DEFERRABLE INITIALLY DEFERRED,
    provider TEXT CHECK (provider IS NULL OR length(provider) > 0),
    model TEXT CHECK (model IS NULL OR length(model) > 0),
    observed_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS request_usage (
    request_usage_id INTEGER PRIMARY KEY,
    request_id TEXT NOT NULL REFERENCES requests(request_id) ON DELETE CASCADE,
    usage_observation_id INTEGER REFERENCES usage_observations(usage_observation_id) ON DELETE SET NULL,
    metric TEXT NOT NULL CHECK (length(metric) > 0),
    value REAL NOT NULL CHECK (value >= 0),
    unit TEXT NOT NULL CHECK (length(unit) > 0),
    UNIQUE (request_id, metric, usage_observation_id)
  )`,
  `CREATE TABLE IF NOT EXISTS usage_value_provenance (
    usage_value_provenance_id INTEGER PRIMARY KEY,
    request_usage_id INTEGER NOT NULL REFERENCES request_usage(request_usage_id) ON DELETE CASCADE,
    source_event_id TEXT NOT NULL REFERENCES source_events(event_id) DEFERRABLE INITIALLY DEFERRED,
    evidence_path TEXT NOT NULL CHECK (length(evidence_path) > 0),
    provenance_kind TEXT NOT NULL CHECK (provenance_kind IN ('provider', 'derived', 'fallback'))
  )`,
  `CREATE TABLE IF NOT EXISTS evidence_gaps (
    evidence_gap_id INTEGER PRIMARY KEY,
    source TEXT NOT NULL CHECK (length(source) > 0),
    source_event_id TEXT CHECK (source_event_id IS NULL OR length(source_event_id) > 0),
    reason TEXT NOT NULL CHECK (length(reason) > 0),
    details_json TEXT CHECK (details_json IS NULL OR json_valid(details_json)),
    recorded_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS pricing_versions (
    pricing_version_id INTEGER PRIMARY KEY,
    provider TEXT NOT NULL CHECK (length(provider) > 0),
    model TEXT NOT NULL CHECK (length(model) > 0),
    currency TEXT NOT NULL CHECK (length(currency) = 3),
    input_per_million REAL NOT NULL CHECK (input_per_million >= 0),
    output_per_million REAL NOT NULL CHECK (output_per_million >= 0),
    cache_write_per_million REAL CHECK (cache_write_per_million IS NULL OR cache_write_per_million >= 0),
    cache_read_per_million REAL CHECK (cache_read_per_million IS NULL OR cache_read_per_million >= 0),
    effective_from TEXT NOT NULL,
    effective_to TEXT,
    UNIQUE (provider, model, currency, effective_from),
    CHECK (effective_to IS NULL OR effective_to > effective_from)
  )`,
  `CREATE TABLE IF NOT EXISTS quota_observations (
    quota_observation_id INTEGER PRIMARY KEY,
    provider_account_id TEXT REFERENCES provider_accounts(provider_account_id) DEFERRABLE INITIALLY DEFERRED,
    provider TEXT NOT NULL CHECK (length(provider) > 0),
    quota_name TEXT NOT NULL CHECK (length(quota_name) > 0),
    observed_at TEXT NOT NULL,
    remaining REAL CHECK (remaining IS NULL OR remaining >= 0),
    quota_limit REAL CHECK (quota_limit IS NULL OR quota_limit >= 0),
    reset_at TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_requests_started_at
    ON requests(started_at)`,
  `CREATE INDEX IF NOT EXISTS idx_requests_provider_model
    ON requests(provider, model)`,
  `CREATE INDEX IF NOT EXISTS idx_requests_repository_id
    ON requests(repository_id)`,
  `CREATE INDEX IF NOT EXISTS idx_requests_session_id
    ON requests(session_id)`,
  `CREATE INDEX IF NOT EXISTS idx_payload_blobs_request_id
    ON payload_blobs(request_id)`,
  `CREATE INDEX IF NOT EXISTS idx_usage_observations_request_id
    ON usage_observations(request_id, observed_at)`,
  `CREATE INDEX IF NOT EXISTS idx_request_usage_request_id
    ON request_usage(request_id, metric)`,
  `CREATE INDEX IF NOT EXISTS idx_usage_value_provenance_usage
    ON usage_value_provenance(request_usage_id)`,
  `CREATE INDEX IF NOT EXISTS idx_evidence_gaps_source_time
    ON evidence_gaps(source, recorded_at)`,
  `CREATE INDEX IF NOT EXISTS idx_pricing_versions_provider_model
    ON pricing_versions(provider, model, effective_from)`,
  `CREATE INDEX IF NOT EXISTS idx_quota_observations_provider_time
    ON quota_observations(provider, observed_at)`,
  `INSERT OR REPLACE INTO schema_meta (key, value)
    VALUES ('audit_schema_version', '2')`,
]);

export const AUDIT_MIGRATIONS = Object.freeze([
  Object.freeze({
    id: "001_initial_audit_store",
    statements: INITIAL_AUDIT_STORE_STATEMENTS,
    checksum: checksumStatements(INITIAL_AUDIT_STORE_STATEMENTS),
  }),
  Object.freeze({
    id: "002_approved_audit_design_tables",
    statements: APPROVED_AUDIT_DESIGN_STATEMENTS,
    checksum: checksumStatements(APPROVED_AUDIT_DESIGN_STATEMENTS),
  }),
]);

export function checksumMigration(migration) {
  return checksumStatements(migration.statements);
}

function checksumStatements(statements) {
  return createHash("sha256").update(statements.join(";\n"), "utf8").digest("hex");
}
