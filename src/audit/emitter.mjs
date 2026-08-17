import { createHash } from "node:crypto";

import { encryptAuditValue } from "./crypto.mjs";
import { createAuditEvent } from "./event.mjs";
import { redactEvidence } from "./redaction.mjs";

const SOURCE = "airkit-compatibility";
const SOURCE_VERSION = "1";
const CLIENT = "airkit";
const MAX_GAP_REASON_LENGTH = 160;

/**
 * Build the small, fail-open boundary used by compatibility adapters.
 * A spool is deliberately preferred over a client: the spool is the local
 * encrypted durability boundary and must not be bypassed with plaintext.
 */
export function createAuditEmitter(options = {}) {
  const {
    spool = null,
    client = null,
    masterKey = null,
    launchInstanceId = null,
    sessionContext = null,
    source = SOURCE,
    sourceVersion = SOURCE_VERSION,
    clientName = CLIENT,
  } = options;
  const pending = new Set();

  async function emit(kind, fields = {}) {
    try {
      const event = buildEvent({
        kind,
        fields,
        launchInstanceId,
        sessionContext,
        source,
        sourceVersion,
        clientName,
      });
      pending.add(event.event_id);
      await persist(event, { spool, client, masterKey });
      pending.delete(event.event_id);
      return event;
    } catch (error) {
      pending.clear();
      await emitGap({
        kind,
        fields,
        launchInstanceId,
        sessionContext,
        source,
        sourceVersion,
        clientName,
        error,
        spool,
        client,
        masterKey,
      });
      return null;
    }
  }

  async function flush() {
    try {
      if (typeof client?.flush === "function") await client.flush();
      if (typeof spool?.deliverPending === "function") return await spool.deliverPending();
    } catch {
      // Audit delivery is advisory and must never affect the caller.
    }
    return [];
  }

  return { emit, flush };
}

export function hashAuditBody(body) {
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body ?? "");
  return createHash("sha256").update(bytes).digest("hex");
}

async function persist(event, { spool, client, masterKey }) {
  if (typeof spool?.enqueue === "function") {
    await spool.enqueue(event);
    return;
  }
  if (typeof client?.send === "function") {
    if (masterKey === null || masterKey === undefined) {
      throw new Error("audit transport client requires masterKey");
    }
    await client.send(encryptEvent(event, masterKey));
  }
}

async function emitGap(options) {
  const {
    kind,
    fields,
    launchInstanceId,
    sessionContext,
    source,
    sourceVersion,
    clientName,
    error,
    spool,
    client,
    masterKey,
  } = options;
  try {
    const logicalRequestId = fields?.logical_request_id ?? sessionContext?.logical_request_id ?? null;
    const gap = buildEvent({
      kind: "collector_gap",
      fields: {
        logical_request_id: logicalRequestId,
        session_id: fields?.session_id ?? sessionContext?.session_id ?? null,
        payload: {
          failed_event_kind: typeof kind === "string" ? kind.slice(0, 64) : "unknown",
          reason: "audit_emit_failed",
          error: safeErrorCode(error),
        },
      },
      launchInstanceId,
      sessionContext,
      source,
      sourceVersion,
      clientName,
    });
    if (typeof spool?.enqueue === "function") await spool.enqueue(gap);
    else if (typeof client?.send === "function") {
      if (masterKey === null || masterKey === undefined) {
        throw new Error("audit transport client requires masterKey");
      }
      await client.send(encryptEvent(gap, masterKey));
    }
  } catch {
    // A broken audit path must not produce a second failure or leak details.
  }
}

function encryptEvent(event, masterKey) {
  return {
    event_id: event.event_id,
    encrypted: encryptAuditValue({
      masterKey,
      purpose: "request-evidence/v1",
      identity: event.event_id,
      plaintext: Buffer.from(JSON.stringify(event), "utf8"),
    }),
  };
}

function buildEvent({ kind, fields, launchInstanceId, sessionContext, source, sourceVersion, clientName }) {
  if (typeof kind !== "string" || kind.length === 0) throw new TypeError("audit event kind is required");
  const logicalRequestId = fields?.logical_request_id ?? sessionContext?.logical_request_id ?? null;
  const payloadInput = fields?.payload ?? fields?.evidence ?? fields;
  const redacted = redactEvidence(payloadInput).value;
  return createAuditEvent({
    source,
    source_version: sourceVersion,
    source_event_id: launchInstanceId,
    logical_request_id: logicalRequestId,
    session_id: fields?.session_id ?? sessionContext?.session_id ?? null,
    client: clientName,
    event_kind: kind,
    payload: redacted,
  });
}

function safeErrorCode(error) {
  const code = typeof error?.code === "string" ? error.code : "audit_failure";
  return code.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, MAX_GAP_REASON_LENGTH);
}
