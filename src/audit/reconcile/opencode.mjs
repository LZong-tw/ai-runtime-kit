import { DatabaseSync } from "node:sqlite";

const PAGE_SIZE = 100;

export async function scanOpenCode({ dbPath, cursor = null, pageSize = PAGE_SIZE, emit, openReadOnly } = {}) {
  if (typeof dbPath !== "string" || dbPath.length === 0) throw new TypeError("OpenCode database path is required");
  if (typeof emit !== "function") throw new TypeError("OpenCode audit emitter is required");
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 1_000) throw new RangeError("OpenCode page size is invalid");
  const opener = openReadOnly ?? (async (path) => new DatabaseSync(path, { readOnly: true }));
  const db = await opener(dbPath);
  try {
    const messages = readMessages(db, cursor, pageSize);
    const sessionIds = new Set();
    let count = 0;
    let nextCursor = normalizeCursor(cursor);
    for (const row of messages) {
      const event = mapMessage(row);
      if (!event) continue;
      await emit(event);
      count += 1;
      sessionIds.add(row.session_id);
      nextCursor = { timeCreated: row.time_created, id: row.id };
    }
    for (const row of readSessions(db, sessionIds)) {
      await emit(mapSessionMeter(row));
      count += 1;
    }
    return { events: count, cursor: nextCursor, completeness: "complete" };
  } catch (error) {
    await emit({
      event_version: 1,
      source: "opencode",
      source_version: "reconciler-v1",
      source_event_id: null,
      observed_at: new Date().toISOString(),
      logical_request_id: null,
      attempt_id: null,
      session_id: null,
      client: "opencode",
      event_kind: "collector_gap",
      payload: { reason: "unsupported_schema", detail: safeError(error) },
    });
    return { events: 1, cursor: normalizeCursor(cursor), completeness: "metadata_only" };
  } finally {
    db?.close?.();
  }
}

function readMessages(db, cursor, pageSize) {
  const statement = db.prepare("SELECT id, session_id, time_created, data FROM message WHERE (time_created > ? OR (time_created = ? AND id > ?)) ORDER BY time_created, id LIMIT ?");
  const normalized = normalizeCursor(cursor);
  return statement.all(normalized.timeCreated, normalized.timeCreated, normalized.id, pageSize);
}

function readSessions(db, sessionIds) {
  if (sessionIds.size === 0) return [];
  const placeholders = [...sessionIds].map(() => "?").join(",");
  const statement = db.prepare(`SELECT id, time_updated, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write FROM session WHERE id IN (${placeholders})`);
  return statement.all(...sessionIds);
}

function mapMessage(row) {
  let data;
  try { data = JSON.parse(row.data); } catch { return null; }
  if (data?.role !== "assistant") return null;
  const tokens = data.tokens;
  if (!tokens || typeof tokens !== "object") return null;
  const usage = {
    input_tokens: numberOrNull(tokens.input),
    output_tokens: numberOrNull(tokens.output),
    reasoning_tokens: numberOrNull(tokens.reasoning),
    cache_read_input_tokens: numberOrNull(tokens.cache?.read),
    cache_creation_input_tokens: numberOrNull(tokens.cache?.write),
  };
  return {
    event_version: 1,
    event_id: `opencode-message-${row.id}`,
    source: "opencode",
    source_version: "message-v1",
    source_event_id: row.id,
    observed_at: new Date(Number(row.time_created)).toISOString(),
    logical_request_id: `opencode:${row.id}`,
    session_id: row.session_id,
    client: "opencode",
    event_kind: "usage_reported",
    payload: {
      usage: Object.fromEntries(Object.entries(usage).filter(([, value]) => value !== null)),
      model: typeof data.modelID === "string" ? data.modelID : null,
      provider: typeof data.providerID === "string" ? data.providerID : null,
      provenance: { usage: "opencode.message.data.tokens", model: "opencode.message.data.modelID", provider: "opencode.message.data.providerID" },
    },
  };
}

function mapSessionMeter(row) {
  return {
    event_version: 1,
    event_id: `opencode-session-meter-${row.id}`,
    source: "opencode",
    source_version: "session-v1",
    source_event_id: row.id,
    observed_at: new Date(Number(row.time_updated)).toISOString(),
    logical_request_id: null,
    session_id: row.id,
    client: "opencode",
    event_kind: "meter_reported",
    payload: {
      total: {
        input_tokens: numberOrNull(row.tokens_input),
        output_tokens: numberOrNull(row.tokens_output),
        reasoning_tokens: numberOrNull(row.tokens_reasoning),
        cache_read_input_tokens: numberOrNull(row.tokens_cache_read),
        cache_creation_input_tokens: numberOrNull(row.tokens_cache_write),
      },
      provenance: { total: "opencode.session.tokens_*" },
    },
  };
}

function normalizeCursor(cursor) {
  return {
    timeCreated: Number.isFinite(cursor?.timeCreated) ? cursor.timeCreated : 0,
    id: typeof cursor?.id === "string" ? cursor.id : "",
  };
}

function numberOrNull(value) {
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function safeError(error) {
  return error instanceof Error ? error.message.slice(0, 160) : "unsupported OpenCode schema";
}
