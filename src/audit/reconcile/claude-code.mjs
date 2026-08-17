import { open } from "node:fs/promises";

const MAX_READ_BYTES = 256 * 1024;

export async function reconcileClaudeCode({ sessionPath, cursor = null, emit, maxBytes = MAX_READ_BYTES }) {
  if (typeof sessionPath !== "string" || sessionPath.length === 0) throw new TypeError("Claude session path is required");
  if (typeof emit !== "function") throw new TypeError("Claude audit emitter is required");
  if (!Number.isInteger(maxBytes) || maxBytes < 1) throw new RangeError("Claude JSONL bound must be positive");
  const handle = await open(sessionPath, "r");
  const { size } = await handle.stat();
  let offset = Number.isInteger(cursor?.offset) && cursor.offset >= 0 && cursor.offset <= size
    ? cursor.offset
    : 0;
  if (offset > size) offset = 0;
  const chunk = Buffer.alloc(Math.min(maxBytes, Math.max(0, size - offset)));
  if (chunk.byteLength > 0) await handle.read(chunk, 0, chunk.byteLength, offset);
  await handle.close();
  const completeLength = chunk.lastIndexOf(0x0a) + 1;
  const complete = completeLength > 0 ? chunk.subarray(0, completeLength) : Buffer.alloc(0);
  let events = 0;
  for (const line of complete.toString("utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    const event = mapClaudeRecord(record);
    if (!event) continue;
    await emit(event);
    events += 1;
  }
  return { events, cursor: { offset: offset + complete.byteLength } };
}

function mapClaudeRecord(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) return null;
  const sessionId = stringOrNull(record.session_id);
  const sourceEventId = stringOrNull(record.uuid ?? record.id);
  const logicalRequestId = stringOrNull(record.logical_request_id ?? record.request_id) ??
    (sessionId ? `claude:${sessionId}` : null);
  const observedAt = stringOrNull(record.timestamp) ?? new Date().toISOString();
  const provenance = { record_type: "claude-code.jsonl.type" };
  if (record.type === "session_start" || record.type === "session_startup" || record.type === "session_end") {
    return baseEvent("session_context", sourceEventId, logicalRequestId, sessionId, observedAt, {
      lifecycle: record.type,
      provenance,
    });
  }
  if (record.type === "user" || record.type === "prompt") {
    return baseEvent("request_started", sourceEventId, logicalRequestId, sessionId, observedAt, {
      prompt_bytes: boundedByteLength(record.message?.content ?? record.prompt),
      provenance: { ...provenance, prompt_bytes: "derived:utf8-byte-length" },
    });
  }
  const usage = allowlistedUsage(record.usage ?? record.message?.usage);
  if (record.type === "assistant" && Object.keys(usage).length > 0) {
    return baseEvent("usage_reported", sourceEventId, logicalRequestId, sessionId, observedAt, {
      usage,
      provenance: { ...provenance, usage: "claude-code.jsonl.usage" },
    });
  }
  return null;
}

function baseEvent(eventKind, sourceEventId, logicalRequestId, sessionId, observedAt, payload) {
  return {
    event_version: 1,
    event_id: sourceEventId ? `claude-code-${sourceEventId}` : undefined,
    source: "claude-code",
    source_version: "jsonl-v1",
    source_event_id: sourceEventId,
    observed_at: observedAt,
    logical_request_id: logicalRequestId,
    session_id: sessionId,
    client: "claude-code",
    event_kind: eventKind,
    payload,
  };
}

function allowlistedUsage(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const usage = {};
  for (const key of ["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"]) {
    const number = value[key];
    if (Number.isFinite(number) && number >= 0) usage[key] = number;
  }
  return usage;
}

function boundedByteLength(value) {
  if (typeof value !== "string") return 0;
  return Math.min(Buffer.byteLength(value, "utf8"), 65_536);
}

function stringOrNull(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}
