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
    id INTEGER PRIMARY KEY,
    event_id TEXT NOT NULL UNIQUE,
    event_version INTEGER NOT NULL CHECK (event_version = 1),
    source TEXT NOT NULL CHECK (length(source) > 0),
    source_version TEXT NOT NULL CHECK (length(source_version) > 0),
    source_event_id TEXT CHECK (source_event_id IS NULL OR length(source_event_id) > 0),
    observed_at TEXT NOT NULL CHECK (length(observed_at) > 0),
    received_at TEXT NOT NULL CHECK (length(received_at) > 0),
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
    payload_json TEXT CHECK (payload_json IS NULL OR json_valid(payload_json)),
    payload_hash TEXT CHECK (payload_hash IS NULL OR length(payload_hash) > 0),
    normalization_status TEXT NOT NULL CHECK (normalization_status IN (
      'pending',
      'normalized',
      'failed',
      'ignored'
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
  `CREATE INDEX IF NOT EXISTS idx_source_events_received_at
    ON source_events(received_at)`,
  `CREATE INDEX IF NOT EXISTS idx_source_events_payload_hash
    ON source_events(payload_hash)`,
  `CREATE INDEX IF NOT EXISTS idx_source_events_normalization_status
    ON source_events(normalization_status, received_at)`,
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
    id INTEGER PRIMARY KEY,
    request_id TEXT NOT NULL UNIQUE CHECK (length(request_id) > 0),
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
    request_id INTEGER NOT NULL REFERENCES requests(id) DEFERRABLE INITIALLY DEFERRED,
    source_event_id TEXT NOT NULL REFERENCES source_events(event_id) DEFERRABLE INITIALLY DEFERRED,
    blob_kind TEXT NOT NULL CHECK (blob_kind IN ('request', 'response', 'evidence')),
    payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
    created_at TEXT NOT NULL,
    UNIQUE (source_event_id, blob_kind)
  )`,
  `CREATE TABLE IF NOT EXISTS usage_observations (
    usage_observation_id INTEGER PRIMARY KEY,
    request_id INTEGER NOT NULL REFERENCES requests(id) DEFERRABLE INITIALLY DEFERRED,
    source_event_id TEXT NOT NULL REFERENCES source_events(event_id) DEFERRABLE INITIALLY DEFERRED,
    provider TEXT CHECK (provider IS NULL OR length(provider) > 0),
    model TEXT CHECK (model IS NULL OR length(model) > 0),
    observed_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS request_usage (
    request_usage_id INTEGER PRIMARY KEY,
    request_id INTEGER NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
    usage_observation_id INTEGER REFERENCES usage_observations(usage_observation_id) ON DELETE SET NULL,
    metric TEXT CHECK (metric IS NULL OR length(metric) > 0),
    value REAL CHECK (value IS NULL OR value >= 0),
    unit TEXT CHECK (unit IS NULL OR length(unit) > 0),
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

const COMPLETE_APPROVED_AUDIT_DESIGN_COLUMNS = Object.freeze([
  `ALTER TABLE requests ADD COLUMN attempt_id TEXT`,
  `ALTER TABLE requests ADD COLUMN attempt_number INTEGER CHECK (attempt_number IS NULL OR attempt_number >= 1)`,
  `ALTER TABLE requests ADD COLUMN session_record_id TEXT`,
  `ALTER TABLE requests ADD COLUMN repository_classification TEXT`,
  `ALTER TABLE requests ADD COLUMN worktree_path_encrypted TEXT CHECK (
    worktree_path_encrypted IS NULL OR (
      json_valid(worktree_path_encrypted)
      AND json_type(worktree_path_encrypted, '$.v') = 'integer'
      AND json_type(worktree_path_encrypted, '$.k') = 'text'
      AND json_type(worktree_path_encrypted, '$.n') = 'text'
      AND json_type(worktree_path_encrypted, '$.c') = 'text'
      AND json_type(worktree_path_encrypted, '$.t') = 'text'
    )
  )`,
  `ALTER TABLE requests ADD COLUMN branch TEXT`,
  `ALTER TABLE requests ADD COLUMN head_sha TEXT`,
  `ALTER TABLE requests ADD COLUMN selected_route TEXT`,
  `ALTER TABLE requests ADD COLUMN selected_provider TEXT`,
  `ALTER TABLE requests ADD COLUMN selected_account_id TEXT`,
  `ALTER TABLE requests ADD COLUMN selected_model TEXT`,
  `ALTER TABLE requests ADD COLUMN actual_provider TEXT`,
  `ALTER TABLE requests ADD COLUMN actual_account_id TEXT`,
  `ALTER TABLE requests ADD COLUMN actual_model TEXT`,
  `ALTER TABLE requests ADD COLUMN effort TEXT`,
  `ALTER TABLE requests ADD COLUMN completed_at TEXT`,
  `ALTER TABLE requests ADD COLUMN status_code INTEGER CHECK (status_code IS NULL OR status_code BETWEEN 100 AND 599)`,
  `ALTER TABLE requests ADD COLUMN failure_kind TEXT`,
  `ALTER TABLE requests ADD COLUMN duration_ms INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0)`,
  `ALTER TABLE requests ADD COLUMN request_payload_id TEXT`,
  `ALTER TABLE requests ADD COLUMN response_hash TEXT`,
  `ALTER TABLE requests ADD COLUMN response_bytes INTEGER CHECK (response_bytes IS NULL OR response_bytes >= 0)`,
  `ALTER TABLE requests ADD COLUMN capture_completeness TEXT CHECK (
    capture_completeness IS NULL OR capture_completeness IN (
      'complete',
      'metadata_only',
      'usage_only',
      'partial',
      'gap'
    )
  )`,
  `ALTER TABLE requests ADD COLUMN correlation_confidence REAL CHECK (
    correlation_confidence IS NULL OR (correlation_confidence >= 0 AND correlation_confidence <= 1)
  )`,
  `ALTER TABLE payload_blobs ADD COLUMN id TEXT`,
  `ALTER TABLE payload_blobs ADD COLUMN algorithm TEXT`,
  `ALTER TABLE payload_blobs ADD COLUMN key_id TEXT`,
  `ALTER TABLE payload_blobs ADD COLUMN nonce TEXT`,
  `ALTER TABLE payload_blobs ADD COLUMN ciphertext TEXT`,
  `ALTER TABLE payload_blobs ADD COLUMN auth_tag TEXT`,
  `ALTER TABLE payload_blobs ADD COLUMN wire_hash TEXT`,
  `ALTER TABLE payload_blobs ADD COLUMN evidence_hash TEXT`,
  `ALTER TABLE payload_blobs ADD COLUMN plaintext_bytes INTEGER CHECK (plaintext_bytes IS NULL OR plaintext_bytes >= 0)`,
  `ALTER TABLE payload_blobs ADD COLUMN redaction_count INTEGER CHECK (redaction_count IS NULL OR redaction_count >= 0)`,
  `ALTER TABLE payload_blobs ADD COLUMN expires_at TEXT`,
  `ALTER TABLE payload_blobs ADD COLUMN pruned_at TEXT`,
  `ALTER TABLE payload_blobs ADD COLUMN preserved_at TEXT`,
  `ALTER TABLE usage_observations ADD COLUMN id TEXT`,
  `ALTER TABLE usage_observations ADD COLUMN source TEXT`,
  `ALTER TABLE usage_observations ADD COLUMN uncached_input_tokens INTEGER CHECK (uncached_input_tokens IS NULL OR uncached_input_tokens >= 0)`,
  `ALTER TABLE usage_observations ADD COLUMN output_tokens INTEGER CHECK (output_tokens IS NULL OR output_tokens >= 0)`,
  `ALTER TABLE usage_observations ADD COLUMN reasoning_tokens INTEGER CHECK (reasoning_tokens IS NULL OR reasoning_tokens >= 0)`,
  `ALTER TABLE usage_observations ADD COLUMN cache_read_tokens INTEGER CHECK (cache_read_tokens IS NULL OR cache_read_tokens >= 0)`,
  `ALTER TABLE usage_observations ADD COLUMN cache_creation_tokens INTEGER CHECK (cache_creation_tokens IS NULL OR cache_creation_tokens >= 0)`,
  `ALTER TABLE usage_observations ADD COLUMN cache_creation_5m_tokens INTEGER CHECK (cache_creation_5m_tokens IS NULL OR cache_creation_5m_tokens >= 0)`,
  `ALTER TABLE usage_observations ADD COLUMN cache_creation_1h_tokens INTEGER CHECK (cache_creation_1h_tokens IS NULL OR cache_creation_1h_tokens >= 0)`,
  `ALTER TABLE usage_observations ADD COLUMN cache_miss_tokens INTEGER CHECK (cache_miss_tokens IS NULL OR cache_miss_tokens >= 0)`,
  `ALTER TABLE usage_observations ADD COLUMN total_tokens INTEGER CHECK (total_tokens IS NULL OR total_tokens >= 0)`,
  `ALTER TABLE usage_observations ADD COLUMN raw_usage_json TEXT CHECK (raw_usage_json IS NULL OR json_valid(raw_usage_json))`,
  `ALTER TABLE request_usage ADD COLUMN uncached_input_tokens INTEGER CHECK (uncached_input_tokens IS NULL OR uncached_input_tokens >= 0)`,
  `ALTER TABLE request_usage ADD COLUMN output_tokens INTEGER CHECK (output_tokens IS NULL OR output_tokens >= 0)`,
  `ALTER TABLE request_usage ADD COLUMN reasoning_tokens INTEGER CHECK (reasoning_tokens IS NULL OR reasoning_tokens >= 0)`,
  `ALTER TABLE request_usage ADD COLUMN cache_read_tokens INTEGER CHECK (cache_read_tokens IS NULL OR cache_read_tokens >= 0)`,
  `ALTER TABLE request_usage ADD COLUMN cache_creation_tokens INTEGER CHECK (cache_creation_tokens IS NULL OR cache_creation_tokens >= 0)`,
  `ALTER TABLE request_usage ADD COLUMN cache_creation_5m_tokens INTEGER CHECK (cache_creation_5m_tokens IS NULL OR cache_creation_5m_tokens >= 0)`,
  `ALTER TABLE request_usage ADD COLUMN cache_creation_1h_tokens INTEGER CHECK (cache_creation_1h_tokens IS NULL OR cache_creation_1h_tokens >= 0)`,
  `ALTER TABLE request_usage ADD COLUMN cache_miss_tokens INTEGER CHECK (cache_miss_tokens IS NULL OR cache_miss_tokens >= 0)`,
  `ALTER TABLE request_usage ADD COLUMN provider_total_tokens INTEGER CHECK (provider_total_tokens IS NULL OR provider_total_tokens >= 0)`,
  `ALTER TABLE request_usage ADD COLUMN effective_context_tokens INTEGER CHECK (effective_context_tokens IS NULL OR effective_context_tokens >= 0)`,
  `ALTER TABLE request_usage ADD COLUMN cache_read_rate REAL CHECK (cache_read_rate IS NULL OR cache_read_rate >= 0)`,
  `ALTER TABLE request_usage ADD COLUMN cache_write_rate REAL CHECK (cache_write_rate IS NULL OR cache_write_rate >= 0)`,
  `ALTER TABLE request_usage ADD COLUMN uncached_rate REAL CHECK (uncached_rate IS NULL OR uncached_rate >= 0)`,
  `ALTER TABLE request_usage ADD COLUMN cache_reuse_ratio REAL CHECK (cache_reuse_ratio IS NULL OR (cache_reuse_ratio >= 0 AND cache_reuse_ratio <= 1))`,
  `ALTER TABLE request_usage ADD COLUMN uncached_input_cost REAL CHECK (uncached_input_cost IS NULL OR uncached_input_cost >= 0)`,
  `ALTER TABLE request_usage ADD COLUMN cache_read_cost REAL CHECK (cache_read_cost IS NULL OR cache_read_cost >= 0)`,
  `ALTER TABLE request_usage ADD COLUMN cache_creation_5m_cost REAL CHECK (cache_creation_5m_cost IS NULL OR cache_creation_5m_cost >= 0)`,
  `ALTER TABLE request_usage ADD COLUMN cache_creation_1h_cost REAL CHECK (cache_creation_1h_cost IS NULL OR cache_creation_1h_cost >= 0)`,
  `ALTER TABLE request_usage ADD COLUMN reasoning_cost REAL CHECK (reasoning_cost IS NULL OR reasoning_cost >= 0)`,
  `ALTER TABLE request_usage ADD COLUMN output_cost REAL CHECK (output_cost IS NULL OR output_cost >= 0)`,
  `ALTER TABLE request_usage ADD COLUMN derived_total_cost REAL CHECK (derived_total_cost IS NULL OR derived_total_cost >= 0)`,
  `ALTER TABLE request_usage ADD COLUMN pricing_version_id INTEGER REFERENCES pricing_versions(pricing_version_id) DEFERRABLE INITIALLY DEFERRED`,
  `ALTER TABLE request_usage ADD COLUMN normalization_state TEXT`,
  `ALTER TABLE usage_value_provenance ADD COLUMN request_id INTEGER REFERENCES requests(id) DEFERRABLE INITIALLY DEFERRED`,
  `ALTER TABLE usage_value_provenance ADD COLUMN metric TEXT`,
  `ALTER TABLE usage_value_provenance ADD COLUMN value REAL`,
  `ALTER TABLE usage_value_provenance ADD COLUMN provenance TEXT`,
  `ALTER TABLE usage_value_provenance ADD COLUMN confidence REAL CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1))`,
  `ALTER TABLE usage_value_provenance ADD COLUMN conflict_group TEXT`,
  `ALTER TABLE repositories ADD COLUMN id TEXT`,
  `ALTER TABLE repositories ADD COLUMN identity_hash TEXT`,
  `ALTER TABLE repositories ADD COLUMN root_path_encrypted TEXT CHECK (
    root_path_encrypted IS NULL OR (
      json_valid(root_path_encrypted)
      AND json_type(root_path_encrypted, '$.v') = 'integer'
      AND json_type(root_path_encrypted, '$.k') = 'text'
      AND json_type(root_path_encrypted, '$.n') = 'text'
      AND json_type(root_path_encrypted, '$.c') = 'text'
      AND json_type(root_path_encrypted, '$.t') = 'text'
    )
  )`,
  `ALTER TABLE repositories ADD COLUMN remote_hash TEXT`,
  `ALTER TABLE repositories ADD COLUMN remote_display TEXT`,
  `ALTER TABLE repositories ADD COLUMN classification TEXT`,
  `ALTER TABLE repositories ADD COLUMN classification_source TEXT`,
  `ALTER TABLE repositories ADD COLUMN first_seen_at TEXT`,
  `ALTER TABLE repositories ADD COLUMN last_seen_at TEXT`,
  `ALTER TABLE provider_accounts ADD COLUMN id TEXT`,
  `ALTER TABLE provider_accounts ADD COLUMN account_hmac TEXT`,
  `ALTER TABLE provider_accounts ADD COLUMN logical_group TEXT`,
  `ALTER TABLE provider_accounts ADD COLUMN credential_kind TEXT`,
  `ALTER TABLE provider_accounts ADD COLUMN display_label TEXT`,
  `ALTER TABLE provider_accounts ADD COLUMN identity_source TEXT`,
  `ALTER TABLE provider_accounts ADD COLUMN first_seen_at TEXT`,
  `ALTER TABLE provider_accounts ADD COLUMN last_seen_at TEXT`,
  `ALTER TABLE sessions ADD COLUMN id TEXT`,
  `ALTER TABLE sessions ADD COLUMN client_session_id_hmac TEXT`,
  `ALTER TABLE sessions ADD COLUMN started_at TEXT`,
  `ALTER TABLE sessions ADD COLUMN last_seen_at TEXT`,
  `ALTER TABLE sessions ADD COLUMN initial_repository_id TEXT REFERENCES repositories(repository_id) DEFERRABLE INITIALLY DEFERRED`,
  `ALTER TABLE sessions ADD COLUMN launcher_mode TEXT`,
  `ALTER TABLE sessions ADD COLUMN capture_started_at TEXT`,
  `ALTER TABLE sessions ADD COLUMN capture_ended_at TEXT`,
  `ALTER TABLE evidence_gaps ADD COLUMN id TEXT`,
  `ALTER TABLE evidence_gaps ADD COLUMN started_at TEXT`,
  `ALTER TABLE evidence_gaps ADD COLUMN ended_at TEXT`,
  `ALTER TABLE evidence_gaps ADD COLUMN detected_by TEXT`,
  `ALTER TABLE evidence_gaps ADD COLUMN affected_client TEXT`,
  `ALTER TABLE evidence_gaps ADD COLUMN affected_session TEXT`,
  `ALTER TABLE evidence_gaps ADD COLUMN resolution TEXT`,
  `ALTER TABLE pricing_versions ADD COLUMN id TEXT`,
  `ALTER TABLE pricing_versions ADD COLUMN billing_model TEXT`,
  `ALTER TABLE pricing_versions ADD COLUMN effective_until TEXT`,
  `ALTER TABLE pricing_versions ADD COLUMN input_price REAL CHECK (input_price IS NULL OR input_price >= 0)`,
  `ALTER TABLE pricing_versions ADD COLUMN output_price REAL CHECK (output_price IS NULL OR output_price >= 0)`,
  `ALTER TABLE pricing_versions ADD COLUMN reasoning_price REAL CHECK (reasoning_price IS NULL OR reasoning_price >= 0)`,
  `ALTER TABLE pricing_versions ADD COLUMN cache_read_price REAL CHECK (cache_read_price IS NULL OR cache_read_price >= 0)`,
  `ALTER TABLE pricing_versions ADD COLUMN cache_creation_5m_price REAL CHECK (cache_creation_5m_price IS NULL OR cache_creation_5m_price >= 0)`,
  `ALTER TABLE pricing_versions ADD COLUMN cache_creation_1h_price REAL CHECK (cache_creation_1h_price IS NULL OR cache_creation_1h_price >= 0)`,
  `ALTER TABLE pricing_versions ADD COLUMN source_reference TEXT`,
  `ALTER TABLE pricing_versions ADD COLUMN verified_at TEXT`,
  `ALTER TABLE quota_observations ADD COLUMN id TEXT`,
  `ALTER TABLE quota_observations ADD COLUMN quota_window TEXT`,
  `ALTER TABLE quota_observations ADD COLUMN quota_utilization REAL CHECK (quota_utilization IS NULL OR quota_utilization >= 0)`,
  `ALTER TABLE quota_observations ADD COLUMN quota_remaining REAL CHECK (quota_remaining IS NULL OR quota_remaining >= 0)`,
  `ALTER TABLE quota_observations ADD COLUMN source TEXT`,
  `CREATE INDEX IF NOT EXISTS idx_requests_attempt_id
    ON requests(attempt_id)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_requests_attempt_id_unique
    ON requests(attempt_id)
    WHERE attempt_id IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS idx_requests_selected_provider_model
    ON requests(selected_provider, selected_model)`,
  `CREATE INDEX IF NOT EXISTS idx_requests_actual_provider_model
    ON requests(actual_provider, actual_model)`,
  `CREATE INDEX IF NOT EXISTS idx_payload_blobs_expires_pruned
    ON payload_blobs(expires_at, pruned_at)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_payload_blobs_id_unique
    ON payload_blobs(id)
    WHERE id IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS idx_usage_observations_source_event
    ON usage_observations(source, source_event_id)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_usage_observations_id_unique
    ON usage_observations(id)
    WHERE id IS NOT NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_request_usage_unique_request
    ON request_usage(request_id)`,
  `CREATE INDEX IF NOT EXISTS idx_usage_value_provenance_request_metric
    ON usage_value_provenance(request_id, metric)`,
  `CREATE INDEX IF NOT EXISTS idx_repositories_identity_hash
    ON repositories(identity_hash)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_repositories_id_unique
    ON repositories(id)
    WHERE id IS NOT NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_repositories_identity_hash_unique
    ON repositories(identity_hash)
    WHERE identity_hash IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS idx_provider_accounts_provider_group
    ON provider_accounts(provider, logical_group)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_provider_accounts_id_unique
    ON provider_accounts(id)
    WHERE id IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_client_session
    ON sessions(client, client_session_id_hmac)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_id_unique
    ON sessions(id)
    WHERE id IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS idx_evidence_gaps_window
    ON evidence_gaps(started_at, ended_at)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_evidence_gaps_id_unique
    ON evidence_gaps(id)
    WHERE id IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS idx_pricing_versions_effective_until
    ON pricing_versions(provider, billing_model, model, effective_until)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_pricing_versions_id_unique
    ON pricing_versions(id)
    WHERE id IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS idx_quota_observations_window
    ON quota_observations(provider_account_id, quota_window, observed_at)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_quota_observations_id_unique
    ON quota_observations(id)
    WHERE id IS NOT NULL`,
  `INSERT OR REPLACE INTO schema_meta (key, value)
    VALUES ('audit_schema_version', '3')`,
]);

const SHIELD_METADATA_AUDIT_STATEMENTS = Object.freeze([
  `CREATE TABLE IF NOT EXISTS shield_decisions (
    event_id TEXT PRIMARY KEY,
    logical_request_id TEXT NOT NULL CHECK (length(logical_request_id) > 0),
    session_id TEXT CHECK (session_id IS NULL OR length(session_id) > 0),
    lane TEXT NOT NULL CHECK (lane IN ('managed', 'subscription', 'unknown')),
    destination_class TEXT NOT NULL CHECK (destination_class IN ('managed', 'subscription', 'unknown')),
    policy_version TEXT NOT NULL CHECK (length(policy_version) > 0),
    gitleaks_version TEXT NOT NULL CHECK (length(gitleaks_version) > 0),
    privacy_version TEXT NOT NULL CHECK (length(privacy_version) > 0),
    action TEXT NOT NULL CHECK (action IN ('allow', 'block', 'redact', 'require_approval', 'unavailable', 'unauthorized', 'transition')),
    reasons TEXT NOT NULL CHECK (length(reasons) > 0),
    transform_count INTEGER NOT NULL CHECK (transform_count >= 0),
    override INTEGER NOT NULL CHECK (override IN (0, 1)),
    elapsed_ms REAL NOT NULL CHECK (elapsed_ms >= 0),
    observed_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS shield_policy_transitions (
    event_id TEXT PRIMARY KEY,
    logical_request_id TEXT NOT NULL CHECK (length(logical_request_id) > 0),
    session_id TEXT CHECK (session_id IS NULL OR length(session_id) > 0),
    lane TEXT NOT NULL CHECK (lane IN ('managed', 'subscription', 'unknown')),
    destination_class TEXT NOT NULL CHECK (destination_class IN ('managed', 'subscription', 'unknown')),
    policy_version TEXT NOT NULL CHECK (length(policy_version) > 0),
    gitleaks_version TEXT NOT NULL CHECK (length(gitleaks_version) > 0),
    privacy_version TEXT NOT NULL CHECK (length(privacy_version) > 0),
    action TEXT NOT NULL CHECK (action IN ('allow', 'block', 'redact', 'require_approval', 'unavailable', 'unauthorized', 'transition')),
    reasons TEXT NOT NULL CHECK (length(reasons) > 0),
    transform_count INTEGER NOT NULL CHECK (transform_count >= 0),
    override INTEGER NOT NULL CHECK (override IN (0, 1)),
    elapsed_ms REAL NOT NULL CHECK (elapsed_ms >= 0),
    observed_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_shield_decisions_request ON shield_decisions(logical_request_id, observed_at)`,
  `CREATE INDEX IF NOT EXISTS idx_shield_decisions_session ON shield_decisions(session_id, observed_at)`,
  `CREATE INDEX IF NOT EXISTS idx_shield_policy_transitions_request ON shield_policy_transitions(logical_request_id, observed_at)`,
  `INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('audit_schema_version', '4')`,
]);

const SHIELD_DECISION_SOURCE_STATEMENTS = Object.freeze([
  `ALTER TABLE shield_decisions ADD COLUMN decision_source TEXT NOT NULL DEFAULT 'evaluated'
    CHECK (decision_source IN ('evaluated', 'cache_hit', 'coalesced'))`,
  `ALTER TABLE shield_policy_transitions ADD COLUMN decision_source TEXT NOT NULL DEFAULT 'evaluated'
    CHECK (decision_source IN ('evaluated', 'cache_hit', 'coalesced'))`,
  `INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('audit_schema_version', '5')`,
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
  Object.freeze({
    id: "003_complete_approved_audit_design_columns",
    statements: COMPLETE_APPROVED_AUDIT_DESIGN_COLUMNS,
    checksum: checksumStatements(COMPLETE_APPROVED_AUDIT_DESIGN_COLUMNS),
  }),
  Object.freeze({
    id: "004_shield_metadata_audit",
    statements: SHIELD_METADATA_AUDIT_STATEMENTS,
    checksum: checksumStatements(SHIELD_METADATA_AUDIT_STATEMENTS),
  }),
  Object.freeze({
    id: "005_shield_decision_source",
    statements: SHIELD_DECISION_SOURCE_STATEMENTS,
    checksum: checksumStatements(SHIELD_DECISION_SOURCE_STATEMENTS),
  }),
]);

export function checksumMigration(migration) {
  return checksumStatements(migration.statements);
}

function checksumStatements(statements) {
  return createHash("sha256").update(statements.join(";\n"), "utf8").digest("hex");
}
