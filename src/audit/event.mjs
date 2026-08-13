import { randomUUID } from "node:crypto";

export const AUDIT_EVENT_VERSION = 1;

export const AUDIT_EVENT_KINDS = Object.freeze([
  "request_started",
  "request_payload",
  "route_selected",
  "provider_request",
  "provider_response",
  "usage_reported",
  "meter_reported",
  "quota_reported",
  "headroom_reported",
  "request_failed",
  "session_context",
  "repository_context",
  "collector_lifecycle",
  "collector_gap",
  "retention_pruned",
  "payload_revealed",
]);

const AUDIT_EVENT_KIND_SET = new Set(AUDIT_EVENT_KINDS);
const PROVIDER_ATTEMPT_KINDS = new Set([
  "provider_request",
  "provider_response",
]);
const REQUEST_KINDS = new Set([
  "request_started",
  "request_payload",
  "route_selected",
  "usage_reported",
  "meter_reported",
  "quota_reported",
  "headroom_reported",
  "request_failed",
]);
const MAX_CANONICAL_PAYLOAD_BYTES = 64 * 1024;

export class AuditEventError extends Error {
  constructor(message) {
    super(message);
    this.name = "AuditEventError";
    this.code = "AIRKIT_AUDIT_INVALID_EVENT";
  }
}

export function createAuditEvent(fields = {}) {
  assertRecord(fields, "audit event fields");
  return {
    event_id: fields.event_id ?? randomUUID(),
    event_version: fields.event_version ?? fields.audit_event_version ?? AUDIT_EVENT_VERSION,
    source: fields.source,
    source_version: fields.source_version,
    source_event_id: fields.source_event_id ?? null,
    observed_at: fields.observed_at ?? fields.occurred_at ?? new Date().toISOString(),
    logical_request_id: fields.logical_request_id ?? null,
    attempt_id: fields.attempt_id ?? null,
    session_id: fields.session_id ?? null,
    client: fields.client,
    event_kind: fields.event_kind,
    payload: fields.payload ?? fields.evidence ?? null,
  };
}

export function validateAuditEvent(event) {
  assertAuditRecord(event, "audit event");

  if (event.event_version !== AUDIT_EVENT_VERSION) {
    throwInvalid(`event_version must be ${AUDIT_EVENT_VERSION}`);
  }
  if (!isNonEmptyString(event.event_id)) {
    throwInvalid("event_id is required");
  }
  if (!isNonEmptyString(event.source)) {
    throwInvalid("source is required");
  }
  if (!isNonEmptyString(event.source_version)) {
    throwInvalid("source_version is required");
  }
  if (
    event.source_event_id !== null &&
    event.source_event_id !== undefined &&
    !isNonEmptyString(event.source_event_id)
  ) {
    throwInvalid("source_event_id must be a non-empty string when present");
  }
  if (!AUDIT_EVENT_KIND_SET.has(event.event_kind)) {
    throwInvalid(`event_kind must be one of: ${AUDIT_EVENT_KINDS.join(", ")}`);
  }
  if (!isNonEmptyString(event.observed_at) || Number.isNaN(Date.parse(event.observed_at))) {
    throwInvalid("observed_at must be an ISO timestamp string");
  }
  if (
    REQUEST_KINDS.has(event.event_kind) &&
    !PROVIDER_ATTEMPT_KINDS.has(event.event_kind) &&
    !isNonEmptyString(event.logical_request_id)
  ) {
    throwInvalid("logical_request_id is required for audit events");
  }
  if (PROVIDER_ATTEMPT_KINDS.has(event.event_kind) && !isNonEmptyString(event.attempt_id)) {
    throwInvalid(`attempt_id is required for ${event.event_kind}`);
  }
  if (
    PROVIDER_ATTEMPT_KINDS.has(event.event_kind) &&
    !isNonEmptyString(event.logical_request_id)
  ) {
    throwInvalid(`logical_request_id is required for ${event.event_kind}`);
  }
  if (
    event.logical_request_id !== null &&
    event.logical_request_id !== undefined &&
    !isNonEmptyString(event.logical_request_id)
  ) {
    throwInvalid("logical_request_id must be a non-empty string when present");
  }
  if (
    event.attempt_id !== null &&
    event.attempt_id !== undefined &&
    !isNonEmptyString(event.attempt_id)
  ) {
    throwInvalid("attempt_id must be a non-empty string when present");
  }
  if (
    event.session_id !== null &&
    event.session_id !== undefined &&
    !isNonEmptyString(event.session_id)
  ) {
    throwInvalid("session_id must be a non-empty string when present");
  }
  if (!isNonEmptyString(event.client)) {
    throwInvalid("client is required");
  }

  const payload = cloneJsonSafeValue(event.payload ?? null, "payload");
  let encodedPayload;
  try {
    encodedPayload = JSON.stringify(payload);
  } catch {
    throwInvalid("payload must be JSON-safe");
  }
  if (Buffer.byteLength(encodedPayload, "utf8") > MAX_CANONICAL_PAYLOAD_BYTES) {
    throwInvalid(`payload must be at most ${MAX_CANONICAL_PAYLOAD_BYTES} bytes`);
  }

  return Object.freeze({
    event_id: event.event_id,
    event_version: event.event_version,
    source: event.source,
    source_version: event.source_version,
    source_event_id: event.source_event_id ?? null,
    observed_at: event.observed_at,
    logical_request_id: event.logical_request_id,
    attempt_id: event.attempt_id ?? null,
    session_id: event.session_id ?? null,
    client: event.client,
    event_kind: event.event_kind,
    payload,
  });
}

function cloneJsonSafeValue(value, label, seen = new WeakSet()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throwInvalid(`${label} must be JSON-safe`);
    return value;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throwInvalid(`${label} must be JSON-safe`);
    seen.add(value);
    const copy = value.map((entry, index) => cloneJsonSafeValue(entry, `${label}[${index}]`, seen));
    seen.delete(value);
    return copy;
  }
  if (isPlainRecord(value)) {
    if (seen.has(value)) throwInvalid(`${label} must be JSON-safe`);
    seen.add(value);
    const copy = {};
    for (const [key, entry] of Object.entries(value)) {
      copy[key] = cloneJsonSafeValue(entry, `${label}.${key}`, seen);
    }
    seen.delete(value);
    return copy;
  }
  throwInvalid(`${label} must be JSON-safe`);
}

function assertAuditRecord(value, label) {
  if (!isRecord(value)) throwInvalid(`${label} must be an object`);
}

function assertRecord(value, label) {
  if (!isRecord(value)) {
    throw new TypeError(`${label} must be an object`);
  }
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isPlainRecord(value) {
  if (!isRecord(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function throwInvalid(message) {
  throw new AuditEventError(message);
}
