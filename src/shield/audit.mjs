import { createAuditEvent } from "../audit/event.mjs";
import { encryptAuditValue } from "../audit/crypto.mjs";

const ACTIONS = new Set(["allow", "block", "redact", "require_approval", "unavailable", "unauthorized", "transition"]);
const LANES = new Set(["managed", "subscription", "unknown"]);
const DESTINATION_CLASSES = new Set(["managed", "subscription", "unknown"]);
const DECISION_KEYS = ["action", "bundleVersion", "destinationClass", "detectorVersions", "elapsedMs", "lane", "override", "reasonCodes", "requestId", "transformCount"];

export function buildShieldDecisionEvent(decision, { now = () => new Date() } = {}) {
  return buildShieldEvent("shield_decision", decision, { now });
}

export function buildShieldPolicyTransitionEvent(transition, { now = () => new Date() } = {}) {
  return buildShieldEvent("shield_policy_transition", transition, { now });
}

function buildShieldEvent(eventKind, decision, { now }) {
  const metadata = assertShieldDecisionMetadata(decision);
  const observedAt = now();
  if (!(observedAt instanceof Date) || Number.isNaN(observedAt.getTime())) throw new TypeError("shield audit clock is invalid");
  return createAuditEvent({
    source: "airkit-shield",
    source_version: "1",
    logical_request_id: metadata.requestId,
    client: "airkit-shield",
    event_kind: eventKind,
    observed_at: observedAt.toISOString(),
    payload: {
      lane: metadata.lane,
      destination_class: metadata.destinationClass,
      policy_version: metadata.bundleVersion,
      gitleaks_version: metadata.detectorVersions.gitleaks ?? "unknown",
      privacy_version: metadata.detectorVersions.privacy ?? "unknown",
      action: metadata.action,
      reasons: metadata.reasonCodes,
      transform_count: metadata.transformCount,
      override: metadata.override,
      elapsed_ms: metadata.elapsedMs,
    },
  });
}

export function createShieldDecisionRecorder({ client = null, spool = null, masterKey = null, now } = {}) {
  if (client !== null && typeof client?.send !== "function") throw new TypeError("shield audit client is invalid");
  if (client !== null && (masterKey === null || masterKey === undefined)) throw new TypeError("shield audit transport requires a master key");
  if (spool !== null && (typeof spool?.stats !== "function" || typeof spool?.enqueue !== "function")) {
    throw new TypeError("shield audit spool is invalid");
  }

  return Object.freeze({
    async isReady() {
      if (!spool) return client !== null;
      try {
        return (await spool.stats())?.atCapacity !== true;
      } catch {
        return false;
      }
    },
    async recordShieldDecision(decision) {
      return persistShieldEvent(buildShieldDecisionEvent(decision, { now }), { client, spool, masterKey });
    },
    async recordShieldPolicyTransition(transition) {
      return persistShieldEvent(buildShieldPolicyTransitionEvent(transition, { now }), { client, spool, masterKey });
    },
  });
}

async function persistShieldEvent(event, { client, spool, masterKey }) {
  if (client) {
    try {
      const ack = await client.send(encryptShieldDecisionEvent(event, masterKey));
      if (ack?.status === "committed" || ack?.status === "duplicate") return Object.freeze({ durable: "ack" });
    } catch {
      // A trusted encrypted spool may provide the only durable fallback.
    }
  }
  if (!spool) throw unavailable();
  try {
    const state = await spool.stats();
    if (state?.atCapacity === true) throw unavailable();
    const entry = await spool.enqueue(event);
    if (entry?.event?.event_id !== event.event_id) throw unavailable();
    return Object.freeze({ durable: "spool" });
  } catch (error) {
    if (error?.code === "AIRKIT_SHIELD_AUDIT_UNAVAILABLE") throw error;
    throw unavailable();
  }
}

function encryptShieldDecisionEvent(event, masterKey) {
  return Object.freeze({
    event_id: event.event_id,
    encrypted: encryptAuditValue({
      masterKey,
      purpose: "request-evidence/v1",
      identity: event.event_id,
      plaintext: Buffer.from(JSON.stringify(event), "utf8"),
    }),
  });
}

export async function recordShieldDecision(decision, dependencies) {
  return createShieldDecisionRecorder(dependencies).recordShieldDecision(decision);
}

export function assertShieldDecisionMetadata(value) {
  if (!isPlainObject(value) || !hasExactKeys(value, DECISION_KEYS)
    || typeof value.requestId !== "string" || !/^[A-Za-z0-9._-]{1,128}$/.test(value.requestId)
    || !LANES.has(value.lane) || !DESTINATION_CLASSES.has(value.destinationClass)
    || typeof value.bundleVersion !== "string" || !/^[A-Za-z0-9._-]{1,128}$/.test(value.bundleVersion)
    || !isVersionMap(value.detectorVersions) || !ACTIONS.has(value.action)
    || !validReasonCodes(value.reasonCodes) || !Number.isInteger(value.transformCount) || value.transformCount < 0 || value.transformCount > 1_000_000
    || typeof value.override !== "boolean" || !Number.isFinite(value.elapsedMs) || value.elapsedMs < 0 || value.elapsedMs > 3_600_000) {
    throw new TypeError("shield decision metadata is invalid");
  }
  return Object.freeze({
    requestId: value.requestId,
    lane: value.lane,
    destinationClass: value.destinationClass,
    bundleVersion: value.bundleVersion,
    detectorVersions: Object.freeze({ ...value.detectorVersions }),
    action: value.action,
    reasonCodes: Object.freeze([...value.reasonCodes]),
    transformCount: value.transformCount,
    override: value.override,
    elapsedMs: value.elapsedMs,
  });
}

function unavailable() {
  const error = new Error("shield audit is unavailable");
  error.code = "AIRKIT_SHIELD_AUDIT_UNAVAILABLE";
  return error;
}

function hasExactKeys(value, expected) {
  const keys = Object.keys(value).sort();
  const ordered = [...expected].sort();
  return keys.length === ordered.length && keys.every((key, index) => key === ordered[index]);
}

function validReasonCodes(value) {
  return Array.isArray(value) && value.length > 0 && value.length <= 32
    && value.every((code) => typeof code === "string" && /^[A-Za-z0-9._-]{1,128}$/.test(code));
}

function isVersionMap(value) {
  return isPlainObject(value) && Object.keys(value).length <= 32
    && Object.entries(value).every(([name, version]) => /^[A-Za-z0-9._-]{1,128}$/.test(name)
      && typeof version === "string" && /^[A-Za-z0-9._-]{1,128}$/.test(version));
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}
