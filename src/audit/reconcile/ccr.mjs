const CCR_LOG_FIELDS = Object.freeze([
  "id",
  "created_at",
  "status_code",
  "provider",
  "model",
  "input_tokens",
]);

export async function reconcileCcrRequestLogs({ rpc, cursor = null, pageSize = 100, emit }) {
  if (typeof rpc?.getRequestLogs !== "function") throw new TypeError("CCR request log RPC is required");
  if (typeof emit !== "function") throw new TypeError("CCR audit emitter is required");
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 1_000) {
    throw new RangeError("CCR request log page size must be between 1 and 1000");
  }
  let nextCursor = normalizeCursor(cursor);
  let total = 0;
  for (;;) {
    const page = await rpc.getRequestLogs({
      cursor: nextCursor,
      page_size: pageSize,
      fields: [...CCR_LOG_FIELDS],
    });
    const rows = Array.isArray(page?.rows) ? page.rows : Array.isArray(page?.logs) ? page.logs : [];
    for (const row of rows) {
      const event = mapCcrRow(row);
      await emit(event);
      total += 1;
      nextCursor = { createdAt: event.payload.created_at, id: event.payload.id };
    }
    if (rows.length === 0 || page?.has_more === false || page?.hasMore === false) break;
    if (rows.length < pageSize && page?.has_more !== true && page?.hasMore !== true) break;
    if (rows.length === 0) break;
  }
  return { rows: total, cursor: nextCursor };
}

function mapCcrRow(row) {
  const sourceEventId = stringOrNull(row?.id);
  const logicalRequestId = stringOrNull(row?.logical_request_id ?? row?.request_id) ??
    (sourceEventId ? `ccr:${sourceEventId}` : null);
  const payload = {};
  const provenance = {};
  for (const field of CCR_LOG_FIELDS) {
    if (row?.[field] === undefined) continue;
    payload[field] = row[field];
    provenance[field] = `ccr.request_logs.${field}`;
  }
  payload.provenance = provenance;
  return {
    event_version: 1,
    event_id: sourceEventId ? `ccr-request-${sourceEventId}` : undefined,
    source: "ccr",
    source_version: "request-logs-v1",
    source_event_id: sourceEventId,
    observed_at: stringOrNull(row?.created_at) ?? new Date().toISOString(),
    logical_request_id: logicalRequestId,
    session_id: stringOrNull(row?.session_id),
    client: "ccr",
    event_kind: "request_started",
    payload,
  };
}

function normalizeCursor(cursor) {
  if (!cursor || typeof cursor !== "object") return null;
  const createdAt = stringOrNull(cursor.createdAt ?? cursor.created_at);
  const id = Number.isInteger(cursor.id) || typeof cursor.id === "string" ? cursor.id : null;
  return createdAt === null && id === null ? null : { createdAt, id };
}

function stringOrNull(value) {
  return typeof value === "string" && value.length > 0 ? value : value == null ? null : String(value);
}
