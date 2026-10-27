import { chmodSync, mkdirSync, openSync, closeSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { xdgStateHome } from "../audit/paths.mjs";
import { redactEvidence } from "../audit/redaction.mjs";

export const MAX_UPSTREAM_BODY_BYTES = 64 * 1024;
const require = createRequire(import.meta.url);
const DAY = 24 * 60 * 60 * 1000;
const NOOP_STORE = Object.freeze({ record() {}, prune() {}, close() {} });
const COLUMNS = [
  "request_id", "at", "kind", "path", "mode", "in_model", "out_model",
  "client_status", "upstream_status", "outcome", "received_to_upstream_ms",
  "upstream_first_byte_ms", "total_ms", "transform_ms", "error_json",
];
const PRIVATE_HEADERS = new Set([
  "authorization", "proxy-authorization", "cookie", "set-cookie", "x-api-key", "x-ccr-core-auth",
]);

// Loaded on first open: a top-level import would print node's SQLite
// ExperimentalWarning on every CLI command that merely imports the gateway.
function loadDatabaseSync() {
  const emitWarning = process.emitWarning;
  process.emitWarning = function (warning, ...rest) {
    const text = String(warning?.message ?? warning);
    const type = typeof rest[0] === "string" ? rest[0] : rest[0]?.type ?? warning?.name;
    if (type === "ExperimentalWarning" && text.includes("SQLite")) return;
    return emitWarning.call(this, warning, ...rest);
  };
  try {
    return require("node:sqlite").DatabaseSync;
  } finally {
    process.emitWarning = emitWarning;
  }
}

export function openRequestErrorStore({ env = process.env, path, now = Date.now } = {}) {
  let db;
  try {
    path ??= join(xdgStateHome(env), "airkit", "compat-requests.sqlite");
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    // Create privately before SQLite opens it (including its WAL sidecars).
    closeSync(openSync(path, "a", 0o600));
    chmodSync(path, 0o600);
    const DatabaseSync = loadDatabaseSync();
    db = new DatabaseSync(path);
    db.exec(`PRAGMA busy_timeout = 2000; PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS compat_requests (
        request_id TEXT PRIMARY KEY, at INTEGER NOT NULL,
        kind TEXT CHECK(kind IN ('success', 'error', 'fallback_error')),
        path TEXT, mode TEXT, in_model TEXT, out_model TEXT,
        client_status INTEGER, upstream_status INTEGER, outcome TEXT,
        received_to_upstream_ms REAL, upstream_first_byte_ms REAL,
        total_ms REAL, transform_ms REAL, error_json TEXT
      );
      CREATE INDEX IF NOT EXISTS compat_requests_kind_at ON compat_requests(kind, at);`);
    const pruneRows = db.prepare(`DELETE FROM compat_requests
      WHERE (kind IN ('error', 'fallback_error') AND at < ?)
         OR (kind = 'success' AND at < ?)`);
    // A fallback rejection is recorded before the handler's terminal timings.
    // Merge those into the same request row without losing the upstream evidence.
    const insert = db.prepare(`INSERT INTO compat_requests (${COLUMNS.join(",")})
      VALUES (${COLUMNS.map(() => "?").join(",")})
      ON CONFLICT(request_id) DO UPDATE SET ${COLUMNS.slice(1).map((column) =>
        column === "kind" || column === "error_json"
          ? `${column} = CASE WHEN compat_requests.kind = 'fallback_error' THEN compat_requests.${column} ELSE COALESCE(excluded.${column}, compat_requests.${column}) END`
          : `${column} = COALESCE(excluded.${column}, compat_requests.${column})`).join(",")}`);
    let lastPruned = -Infinity;
    const store = {
      record(row) {
        try {
          if (now() - lastPruned >= 60 * 60 * 1000) store.prune();
          insert.run(...COLUMNS.map((column) => row[column] ?? (column === "at" ? now() : null)));
        } catch { /* Diagnostics must never interrupt forwarding. */ }
      },
      prune() {
        try {
          const at = now();
          lastPruned = at;
          pruneRows.run(at - 30 * DAY, at - 7 * DAY);
        } catch { /* Best effort retention. */ }
      },
      close() {
        try { db.close(); } catch { /* Includes repeated close. */ }
      },
    };
    store.prune();
    return store;
  } catch {
    try { db?.close(); } catch { /* Failed open is a no-op store. */ }
    return NOOP_STORE;
  }
}

export function truncateUpstreamBody(value) {
  const bytes = Buffer.from(String(value ?? ""), "utf8");
  let end = Math.min(bytes.length, MAX_UPSTREAM_BODY_BYTES);
  // Do not leave an incomplete UTF-8 codepoint at the byte limit.
  if (end < bytes.length) while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return { upstreamBody: bytes.subarray(0, end).toString("utf8"), upstreamBodyTruncated: bytes.length > end };
}

export function serializeError(error, { upstreamBody } = {}) {
  try {
    const causes = [];
    let cause = error?.cause;
    for (let depth = 0; cause != null && depth < 5; depth += 1, cause = cause.cause) {
      causes.push({ name: cause.name ?? "Error", message: cause.message ?? String(cause), code: cause.code ?? null });
    }
    const headers = Object.fromEntries(
      (typeof error?.headers?.entries === "function" ? [...error.headers.entries()] : Object.entries(error?.headers ?? {}))
        .filter(([name]) => !PRIVATE_HEADERS.has(name.toLowerCase())),
    );
    const body = truncateUpstreamBody(upstreamBody ?? error?.upstreamBody ?? "");
    return redactEvidence({
      name: error?.name ?? "Error",
      message: error?.message ?? String(error),
      code: error?.code ?? null,
      status: error?.status ?? error?.statusCode ?? null,
      causes,
      headers,
      ...body,
      upstreamBodyTruncated: body.upstreamBodyTruncated || error?.upstreamBodyTruncated === true,
      ...(Array.isArray(error?.families) ? { families: error.families } : {}),
    }).value;
  } catch {
    return { name: "Error", message: "Error evidence unavailable" };
  }
}

// Also contain failures from a caller-supplied diagnostic store.
export function recordRequest(store, row) {
  try { store?.record(row); } catch { /* Never fail a request for diagnostics. */ }
}
