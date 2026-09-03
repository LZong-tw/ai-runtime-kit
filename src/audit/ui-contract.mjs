const UI_SCHEMA_VERSION = 1;
const MAX_ARGUMENTS = 2;
const MAX_ARGUMENT_LENGTH = 256;
const ALLOWED_STATES = new Set(["healthy", "degraded", "stopped", "blocked"]);
const SHIELD_STATES = new Set(["protected", "approval", "blocked", "unavailable"]);

// The UI contract is deliberately narrower than the audit-store schema. A CCR
// UI must be able to render useful metadata without becoming a payload reveal
// surface or inheriting database/path/credential fields.
const QUERY_FIELDS = Object.freeze({
  requests: [
    "request_id", "logical_request_id", "session_id", "repository_id", "provider", "model",
    "client", "started_at", "last_observed_at", "actual_provider", "actual_model", "status_code",
    "capture_completeness", "correlation_confidence",
  ],
  request: [
    "request_id", "logical_request_id", "session_id", "repository_id", "provider", "model",
    "client", "started_at", "last_observed_at", "actual_provider", "actual_model", "status_code",
    "capture_completeness", "correlation_confidence",
  ],
  sessions: ["session_id", "client", "first_observed_at", "last_observed_at"],
  clients: ["client", "event_count", "first_observed_at", "last_observed_at", "completeness"],
  accounts: ["provider_account_id", "provider", "first_observed_at", "last_observed_at", "logical_group", "credential_kind", "identity_source"],
  repos: ["repository_id", "id", "classification", "classification_source", "first_seen_at", "last_seen_at"],
  usage: [
    "request_id", "provider", "model", "metric", "value", "unit", "cache_read_tokens",
    "cache_creation_5m_tokens", "cache_creation_1h_tokens", "uncached_input_tokens",
    "output_tokens", "derived_total_cost", "normalization_state",
  ],
  cache: [
    "request_id", "provider", "model", "cache_read_tokens", "cache_creation_5m_tokens",
    "cache_creation_1h_tokens", "cache_miss_tokens", "uncached_input_tokens",
    "cache_reuse_ratio", "normalization_state",
  ],
  gaps: ["gap_kind", "source", "reason", "recorded_at", "affected_client", "affected_session", "resolution"],
  shield_decisions: [
    "logical_request_id", "session_id", "lane", "destination_class", "policy_version",
    "gitleaks_version", "privacy_version", "action", "reasons", "transform_count", "decision_source", "override",
    "elapsed_ms", "observed_at",
  ],
  shield_decision: [
    "logical_request_id", "session_id", "lane", "destination_class", "policy_version",
    "gitleaks_version", "privacy_version", "action", "reasons", "transform_count", "decision_source", "override",
    "elapsed_ms", "observed_at",
  ],
  shield_policy_transitions: [
    "logical_request_id", "session_id", "lane", "destination_class", "policy_version",
    "gitleaks_version", "privacy_version", "action", "reasons", "transform_count", "decision_source", "override",
    "elapsed_ms", "observed_at",
  ],
});

const QUERY_NAMES = new Set(Object.keys(QUERY_FIELDS));

export function createAuditUiAdapter({ query, status } = {}) {
  if (typeof query !== "function") throw new TypeError("audit UI query function is required");
  if (typeof status !== "function") throw new TypeError("audit UI status function is required");

  return {
    query: (name, args = []) => queryAuditUi({ query, name, args }),
    status: () => statusAuditUi({ status }),
  };
}

export async function queryAuditUi({ query, name, args = [] } = {}) {
  const validation = validateQuery(name, args);
  if (!validation.ok) return invalidQuery(validation.reason);

  try {
    const result = await query(name, validation.args);
    const state = normalizeState(result?.state);
    const rows = Array.isArray(result?.rows)
      ? result.rows.map((row) => projectRow(name, row))
      : [];
    return {
      schema_version: UI_SCHEMA_VERSION,
      state,
      query: name,
      rows,
      empty: rows.length === 0,
      metadata_only: true,
      payload_included: false,
      projection: "audit-ui-metadata-v1",
      ...(state === "healthy" ? {} : { gap: { code: "audit_query_degraded" } }),
    };
  } catch {
    return degradedQuery(name, "audit_query_unavailable");
  }
}

export async function statusAuditUi({ status } = {}) {
  if (typeof status !== "function") return degradedStatus("audit_status_unavailable");
  try {
    const result = await status();
    const state = normalizeState(result?.state);
    return {
      schema_version: UI_SCHEMA_VERSION,
      state,
      database: projectStatusSection(result?.database, ["present", "ok"]),
      service: projectStatusSection(result?.service, ["installed", "loaded", "stale"]),
      keychain: projectStatusSection(result?.keychain, ["present"]),
      shield: projectShieldStatus(result?.shield),
      metadata_only: true,
      payload_included: false,
      projection: "audit-ui-status-v1",
      ...(state === "healthy" ? {} : { gap: { code: "audit_service_degraded" } }),
    };
  } catch {
    return degradedStatus("audit_status_unavailable");
  }
}

export function projectShieldStatus(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const state = SHIELD_STATES.has(value.state) ? value.state : "unavailable";
  const fields = ["policy_version", "gitleaks_version", "privacy_version", "coverage", "bypass"];
  return Object.fromEntries([
    ["state", state],
    ...fields
      .filter((field) => Object.hasOwn(value, field))
      .map((field) => [field, safeShieldScalar(value[field])]),
  ]);
}

function validateQuery(name, args) {
  if (!QUERY_NAMES.has(name)) return { ok: false, reason: "unknown_query" };
  if (!Array.isArray(args) || args.length > MAX_ARGUMENTS) return { ok: false, reason: "invalid_query_arguments" };
  const normalized = [];
  for (const arg of args) {
    if (typeof arg !== "string" || arg.length === 0 || arg.length > MAX_ARGUMENT_LENGTH) {
      return { ok: false, reason: "invalid_query_arguments" };
    }
    normalized.push(arg);
  }
  if (name === "shield_decision" && !isShieldOpaqueId(normalized[0])) {
    return { ok: false, reason: "invalid_query_arguments" };
  }
  return { ok: true, args: normalized };
}

function projectRow(name, row) {
  const projected = {};
  if (!row || typeof row !== "object" || Array.isArray(row)) return projected;
  for (const field of QUERY_FIELDS[name]) {
    if (Object.hasOwn(row, field)) projected[field] = safeScalar(row[field]);
  }
  return projected;
}

function projectStatusSection(value, fields) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(fields
    .filter((field) => Object.hasOwn(value, field))
    .map((field) => [field, safeScalar(value[field])]));
}

function safeScalar(value) {
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value !== "string") return null;
  return scrubText(value).slice(0, 512);
}

function safeShieldScalar(value) {
  if (typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string" && /^[A-Za-z0-9._-]{1,128}$/.test(value)) return value;
  return null;
}

function scrubText(value) {
  return value
    .replaceAll(/(?:https?|ssh):\/\/[^\s"'<>]+/gi, "[redacted-url]")
    .replaceAll(/\/(?:Users|private|var|tmp|opt|Volumes|Library|Applications|System|bin|sbin|etc|usr|dev|home)\/[^\s"'<>),;]*/gi, "[redacted-path]")
    .replaceAll(/(?:authorization|bearer|api[_-]?key|token|password|secret)\s*[:=]?\s*[^\s,;]+/gi, "$1: [redacted]");
}

function invalidQuery(reason) {
  return {
    schema_version: UI_SCHEMA_VERSION,
    state: "degraded",
    query: null,
    rows: [],
    empty: true,
    metadata_only: true,
    payload_included: false,
    projection: "audit-ui-metadata-v1",
    error: { code: reason },
  };
}

function degradedQuery(name, code) {
  return {
    schema_version: UI_SCHEMA_VERSION,
    state: "degraded",
    query: name,
    rows: [],
    empty: true,
    metadata_only: true,
    payload_included: false,
    projection: "audit-ui-metadata-v1",
    gap: { code },
  };
}

function degradedStatus(code) {
  return {
    schema_version: UI_SCHEMA_VERSION,
    state: "degraded",
    database: {},
    service: {},
    keychain: {},
    shield: { state: "unavailable" },
    metadata_only: true,
    payload_included: false,
    projection: "audit-ui-status-v1",
    gap: { code },
  };
}

function normalizeState(value) {
  return ALLOWED_STATES.has(value) ? value : "degraded";
}
import { isShieldOpaqueId } from "./event.mjs";
