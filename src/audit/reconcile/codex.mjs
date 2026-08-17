import { createHash } from "node:crypto";
import { open } from "node:fs/promises";

const DEFAULT_MAX_READ_BYTES = 256 * 1024;

export async function reconcileCodex({
  sessionPath,
  cursor = null,
  emit,
  maxBytes = DEFAULT_MAX_READ_BYTES,
  providerAttempts = false,
  now = () => new Date(),
} = {}) {
  if (typeof sessionPath !== "string" || sessionPath.length === 0) throw new TypeError("Codex session path is required");
  if (typeof emit !== "function") throw new TypeError("Codex audit emitter is required");
  if (!Number.isInteger(maxBytes) || maxBytes < 1) throw new RangeError("Codex read bound must be positive");
  const handle = await open(sessionPath, "r");
  try {
    const { size } = await handle.stat();
    let offset = Number.isInteger(cursor?.offset) && cursor.offset >= 0 && cursor.offset <= size ? cursor.offset : 0;
    if (offset > size) offset = 0;
    const chunk = Buffer.alloc(Math.min(maxBytes, Math.max(0, size - offset)));
    if (chunk.length > 0) await handle.read(chunk, 0, chunk.length, offset);
    const completeLength = chunk.lastIndexOf(0x0a) + 1;
    const complete = completeLength > 0 ? chunk.subarray(0, completeLength) : Buffer.alloc(0);
    const state = { sessionId: null, turnId: null, modelProvider: null };
    let events = 0;
    let skipped = 0;
    let lineOffset = offset;
    for (const line of complete.toString("utf8").split(/\r?\n/)) {
      const bytes = Buffer.byteLength(line, "utf8") + 1;
      if (!line.trim()) {
        lineOffset += bytes;
        continue;
      }
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        skipped += 1;
        lineOffset += bytes;
        continue;
      }
      const mapped = mapCodexRecord(record, { lineOffset, state, providerAttempts, now });
      if (mapped) {
        await emit(mapped);
        events += 1;
      } else {
        skipped += 1;
      }
      lineOffset += bytes;
    }
    return { events, skipped, cursor: { offset: offset + complete.length } };
  } finally {
    await handle.close();
  }
}

export function mapCodexRecord(record, { lineOffset = 0, state = {}, providerAttempts = false, now = () => new Date() } = {}) {
  if (!isRecord(record)) return null;
  const payload = isRecord(record.payload) ? record.payload : null;
  const timestamp = validTimestamp(record.timestamp) ?? now().toISOString();
  const sourceId = safeId(payload?.id ?? payload?.turn_id ?? record.id);
  if (record.type === "session_meta" && isRecord(payload)) {
    state.sessionId = safeId(payload.id);
    state.modelProvider = safeId(payload.model_provider);
    return event("session_context", record, state, lineOffset, {
      originator: safeText(payload.originator),
      cli_version: safeText(payload.cli_version),
      model_provider: state.modelProvider,
      source: safeText(payload.source),
      completeness: "metadata_only",
    }, timestamp);
  }
  if (record.type !== "event_msg" || !payload || typeof payload.type !== "string") return null;
  if (payload.type === "task_started") {
    state.turnId = safeId(payload.turn_id);
    return event("request_started", record, state, lineOffset, {
      turn_id: state.turnId,
      model_context_window: finite(payload.model_context_window),
      actual_provider: null,
      actual_model: null,
      provider_attempts_observed: providerAttempts,
      completeness: "metadata_only",
    }, timestamp);
  }
  if (payload.type === "token_count") {
    const usage = normalizeUsage(payload.info?.last_token_usage ?? payload.info?.total_token_usage);
    if (Object.keys(usage).length === 0) return null;
    return event("usage_reported", record, state, lineOffset, {
      usage,
      actual_provider: null,
      actual_model: null,
      provider_attempts_observed: providerAttempts,
      completeness: "metadata_only",
    }, timestamp);
  }
  if (payload.type === "task_complete") {
    const message = typeof payload.last_agent_message === "string" ? payload.last_agent_message : "";
    if (/^API Error:/i.test(message)) {
      return event("request_failed", record, state, lineOffset, {
        error_code: safeErrorCode(message),
        actual_provider: null,
        actual_model: null,
        provider_attempts_observed: providerAttempts,
        completeness: "metadata_only",
      }, timestamp);
    }
    return event("session_context", record, state, lineOffset, {
      phase: "task_complete",
      turn_id: safeId(payload.turn_id) ?? state.turnId,
      provider_attempts_observed: providerAttempts,
      completeness: "metadata_only",
    }, timestamp);
  }
  return null;
}

function event(kind, record, state, lineOffset, payload, observedAt) {
  const logicalRequestId = state.turnId ? `codex:${state.turnId}` : state.sessionId ? `codex:${state.sessionId}` : "codex:session";
  const stable = createHash("sha256").update(`${lineOffset}:${JSON.stringify(record)}`, "utf8").digest("hex");
  return {
    event_version: 1,
    event_id: `codex-${stable}`,
    source: "codex",
    source_version: "jsonl-v1",
    source_event_id: safeId(record.payload?.turn_id ?? record.timestamp) ?? `line-${lineOffset}`,
    observed_at: observedAt,
    logical_request_id: logicalRequestId,
    attempt_id: null,
    session_id: state.sessionId,
    client: "codex-cli",
    event_kind: kind,
    payload,
  };
}

function normalizeUsage(value) {
  if (!isRecord(value)) return {};
  const usage = {};
  for (const key of ["input_tokens", "cached_input_tokens", "output_tokens", "reasoning_output_tokens", "total_tokens"]) {
    const number = finite(value[key]);
    if (number !== null) usage[key] = number;
  }
  return usage;
}

function finite(value) {
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function safeId(value) {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value) ? value : null;
}

function safeText(value) {
  return typeof value === "string" && value.length <= 256 ? value : null;
}

function validTimestamp(value) {
  return typeof value === "string" && !Number.isNaN(Date.parse(value)) ? value : null;
}

function safeErrorCode(value) {
  return value.replace(/^API Error:\s*/i, "").replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 128);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
