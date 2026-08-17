import { createHash } from "node:crypto";
import { open } from "node:fs/promises";

const DEFAULT_MAX_READ_BYTES = 256 * 1024;
const HEADROOM_FIELDS = Object.freeze([
  "v",
  "ts",
  "before",
  "after",
  "saved",
  "cost_usd",
  "model",
  "client",
  "source",
  "pid",
]);

export async function tailHeadroomSavings({
  filePath,
  cursor = null,
  emit,
  maxBytes = DEFAULT_MAX_READ_BYTES,
  now = () => new Date(),
} = {}) {
  if (typeof filePath !== "string" || filePath.length === 0) throw new TypeError("Headroom file path is required");
  if (typeof emit !== "function") throw new TypeError("Headroom audit emitter is required");
  if (!Number.isInteger(maxBytes) || maxBytes < 1) throw new RangeError("Headroom read bound must be positive");

  const handle = await open(filePath, "r");
  try {
    const { size } = await handle.stat();
    let offset = Number.isInteger(cursor?.offset) && cursor.offset >= 0 && cursor.offset <= size
      ? cursor.offset
      : 0;
    if (offset > size) offset = 0;
    const chunk = Buffer.alloc(Math.min(maxBytes, Math.max(0, size - offset)));
    if (chunk.length > 0) await handle.read(chunk, 0, chunk.length, offset);
    const completeLength = chunk.lastIndexOf(0x0a) + 1;
    const complete = completeLength > 0 ? chunk.subarray(0, completeLength) : Buffer.alloc(0);
    let events = 0;
    let skipped = 0;
    let lineOffset = offset;
    for (const line of complete.toString("utf8").split(/\r?\n/)) {
      const bytes = Buffer.byteLength(line, "utf8") + 1;
      if (!line.trim()) {
        lineOffset += bytes;
        continue;
      }
      let row;
      try {
        row = JSON.parse(line);
      } catch {
        skipped += 1;
        lineOffset += bytes;
        continue;
      }
      const mapped = mapHeadroomRow(row, { lineOffset, now });
      if (mapped) {
        await emit(mapped);
        events += 1;
      } else {
        skipped += 1;
      }
      lineOffset += bytes;
    }
    return {
      events,
      skipped,
      cursor: { offset: offset + complete.length },
    };
  } finally {
    await handle.close();
  }
}

export function mapHeadroomRow(row, { lineOffset = 0, now = () => new Date() } = {}) {
  if (!isRecord(row)) return null;
  const before = finiteNonNegative(row.before);
  const after = finiteNonNegative(row.after);
  const saved = finiteNonNegative(row.saved);
  if (before === null && after === null && saved === null) return null;

  const safe = {};
  for (const field of HEADROOM_FIELDS) {
    const value = row[field];
    if (field === "v" && Number.isFinite(value)) safe.v = value;
    else if (field === "ts" && typeof value === "string" && !Number.isNaN(Date.parse(value))) safe.ts = value;
    else if (["before", "after", "saved", "cost_usd"].includes(field)) {
      const number = field === "cost_usd" ? finiteNonNegative(value) : finiteNonNegative(value);
      if (number !== null) safe[field] = number;
    } else if (["model", "client", "source"].includes(field) && typeof value === "string" && value.length <= 256) {
      safe[field] = value;
    } else if (field === "pid" && Number.isInteger(value) && value >= 0) {
      safe[field] = value;
    }
  }

  const exactRequestId = safeId(row.audit_event_id ?? row.airkit_event_id);
  const rowHash = createHash("sha256").update(JSON.stringify(safe), "utf8").digest("hex");
  const observedAt = safe.ts ?? now().toISOString();
  return {
    event_version: 1,
    event_id: `headroom-${rowHash}`,
    source: "headroom",
    source_version: "jsonl-v1",
    source_event_id: `headroom-${rowHash}`,
    observed_at: observedAt,
    logical_request_id: exactRequestId,
    attempt_id: null,
    session_id: null,
    client: safe.client ?? "headroom",
    event_kind: "headroom_reported",
    payload: {
      ...safe,
      correlation: exactRequestId ? "exact" : "bounded_time_candidate",
      request_id: exactRequestId,
      line_offset: lineOffset,
      metric_family: "headroom_savings",
    },
  };
}

function finiteNonNegative(value) {
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function safeId(value) {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value) ? value : null;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
