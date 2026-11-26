import { chmodSync, mkdirSync, openSync, closeSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { xdgStateHome } from "../audit/paths.mjs";
import { redactEvidence } from "../audit/redaction.mjs";

export const MAX_UPSTREAM_BODY_BYTES = 64 * 1024;
const require = createRequire(import.meta.url);
const DAY = 24 * 60 * 60 * 1000;
const NOOP_STORE = Object.freeze({ record() {}, prune() {}, close() {} });
// Columns added after the table first shipped. CREATE TABLE IF NOT EXISTS
// leaves an existing file alone, so these are added on open instead.
const ADDED_COLUMNS = [
  ["prefix_status", "TEXT"], ["prefix_reason", "TEXT"], ["prefix_origin", "TEXT"],
  ["prefix_field", "TEXT"], ["prefix_index", "INTEGER"], ["prefix_inbound_index", "INTEGER"],
  ["prefix_messages", "INTEGER"], ["cache_read_tokens", "INTEGER"],
  ["cache_creation_tokens", "INTEGER"], ["cache_miss_tokens", "INTEGER"],
];
const COLUMNS = [
  "request_id", "at", "kind", "path", "mode", "in_model", "out_model",
  "client_status", "upstream_status", "outcome", "received_to_upstream_ms",
  "upstream_first_byte_ms", "total_ms", "transform_ms", "error_json",
  ...ADDED_COLUMNS.map(([name]) => name),
];
const PRIVATE_HEADERS = new Set([
  "authorization", "proxy-authorization", "cookie", "set-cookie", "x-api-key", "x-ccr-core-auth",
  "chatgpt-account-id",
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
    // DatabaseSync blocks the event loop while it waits on another writer, so
    // keep the wait short and drop the diagnostic row instead of stalling traffic.
    db.exec(`PRAGMA busy_timeout = 50; PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS compat_requests (
        request_id TEXT PRIMARY KEY, at INTEGER NOT NULL,
        kind TEXT CHECK(kind IN ('success', 'error', 'fallback_error')),
        path TEXT, mode TEXT, in_model TEXT, out_model TEXT,
        client_status INTEGER, upstream_status INTEGER, outcome TEXT,
        received_to_upstream_ms REAL, upstream_first_byte_ms REAL,
        total_ms REAL, transform_ms REAL, error_json TEXT
      );
      CREATE INDEX IF NOT EXISTS compat_requests_kind_at ON compat_requests(kind, at);`);
    const columns = addMissingColumns(db);
    const pruneRows = db.prepare(`DELETE FROM compat_requests
      WHERE (kind IN ('error', 'fallback_error') AND at < ?)
         OR (kind = 'success' AND at < ?)`);
    // A fallback rejection is recorded before the handler's terminal timings.
    // Merge those into the same request row without losing the upstream evidence.
    const insert = db.prepare(`INSERT INTO compat_requests (${columns.join(",")})
      VALUES (${columns.map(() => "?").join(",")})
      ON CONFLICT(request_id) DO UPDATE SET ${columns.slice(1).map((column) =>
        column === "kind" || column === "error_json"
          ? `${column} = CASE WHEN compat_requests.kind = 'fallback_error' THEN compat_requests.${column} ELSE COALESCE(excluded.${column}, compat_requests.${column}) END`
          : `${column} = COALESCE(excluded.${column}, compat_requests.${column})`).join(",")}`);
    let lastPruned = -Infinity;
    const store = {
      record(row) {
        try {
          if (now() - lastPruned >= 60 * 60 * 1000) store.prune();
          insert.run(...columns.map((column) => row[column] ?? (column === "at" ? now() : null)));
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

// Several launchers can open the same file at once, so a lost race ("duplicate
// column") is expected. Any column that still could not be added is left out
// of the insert: a missing diagnostic column must not cost the whole row.
function addMissingColumns(db) {
  const present = () => new Set(db.prepare("PRAGMA table_info(compat_requests)").all().map((row) => row.name));
  const before = present();
  for (const [name, type] of ADDED_COLUMNS) {
    if (before.has(name)) continue;
    try { db.exec(`ALTER TABLE compat_requests ADD COLUMN ${name} ${type}`); } catch { /* Re-checked below. */ }
  }
  const after = present();
  return COLUMNS.filter((column) => after.has(column));
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
