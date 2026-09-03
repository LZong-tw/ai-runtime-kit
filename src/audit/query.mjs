import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { createConnection, createServer } from "node:net";

import { createAuditFrameDecoder, encodeAuditFrame } from "./transport.mjs";
import { isShieldOpaqueId } from "./event.mjs";

const MAX_QUERY_LIMIT = 200;
const DEFAULT_QUERY_LIMIT = 100;
const QUERY_VERSION = 1;

const AUDIT_QUERY_SQL = Object.freeze({
  requests: `SELECT request_id, logical_request_id, session_id, repository_id, provider, model,
    client, started_at, last_observed_at, actual_provider, actual_model, status_code,
    capture_completeness, correlation_confidence FROM requests ORDER BY started_at, id`,
  request: `SELECT request_id, logical_request_id, session_id, repository_id, provider, model,
    client, started_at, last_observed_at, actual_provider, actual_model, status_code,
    capture_completeness, correlation_confidence FROM requests
    WHERE request_id = ? OR logical_request_id = ? ORDER BY started_at, id`,
  sessions: "SELECT session_id, client, first_observed_at, last_observed_at FROM sessions ORDER BY first_observed_at, session_id",
  clients: `SELECT client, COUNT(*) AS event_count, MIN(observed_at) AS first_observed_at,
    MAX(observed_at) AS last_observed_at,
    CASE WHEN SUM(event_kind = 'provider_request') > 0 AND SUM(event_kind = 'usage_reported') > 0
      THEN 'complete' WHEN COUNT(*) > 0 THEN 'metadata_only' ELSE 'gap' END AS completeness
    FROM source_events GROUP BY client ORDER BY client`,
  accounts: `SELECT provider_account_id, provider, first_observed_at, last_observed_at,
    logical_group, credential_kind, display_label, identity_source
    FROM provider_accounts ORDER BY provider, provider_account_id`,
  repos: `SELECT repository_id, id, classification, classification_source,
    remote_display, first_seen_at, last_seen_at FROM repositories ORDER BY repository_id`,
  usage: `SELECT r.request_id, r.provider, r.model, ru.metric, ru.value, ru.unit,
    ru.cache_read_tokens, ru.cache_creation_5m_tokens, ru.cache_creation_1h_tokens,
    ru.uncached_input_tokens, ru.output_tokens, ru.derived_total_cost, ru.normalization_state
    FROM request_usage ru JOIN requests r ON r.id = ru.request_id ORDER BY r.started_at, ru.request_usage_id`,
  cache: `SELECT r.request_id, r.provider, r.model, ru.cache_read_tokens,
    ru.cache_creation_5m_tokens, ru.cache_creation_1h_tokens, ru.cache_miss_tokens,
    ru.uncached_input_tokens, ru.cache_reuse_ratio, ru.normalization_state
    FROM request_usage ru JOIN requests r ON r.id = ru.request_id
    WHERE ru.cache_read_tokens IS NOT NULL OR ru.cache_creation_5m_tokens IS NOT NULL
      OR ru.cache_creation_1h_tokens IS NOT NULL OR ru.cache_miss_tokens IS NOT NULL
    ORDER BY r.started_at, ru.request_usage_id`,
  gaps: `SELECT 'evidence' AS gap_kind, source, reason, recorded_at, affected_client,
    affected_session, resolution FROM evidence_gaps
    UNION ALL SELECT 'collector', source, reason, recorded_at, NULL, NULL, NULL FROM collector_gaps
    ORDER BY recorded_at`,
  shield_decisions: `SELECT logical_request_id, session_id, lane, destination_class, policy_version,
    gitleaks_version, privacy_version, action, reasons, transform_count, override, elapsed_ms, observed_at
    FROM shield_decisions ORDER BY observed_at, event_id`,
  shield_decision: `SELECT logical_request_id, session_id, lane, destination_class, policy_version,
    gitleaks_version, privacy_version, action, reasons, transform_count, override, elapsed_ms, observed_at
    FROM shield_decisions WHERE logical_request_id = ? ORDER BY observed_at, event_id`,
  shield_policy_transitions: `SELECT logical_request_id, session_id, lane, destination_class, policy_version,
    gitleaks_version, privacy_version, action, reasons, transform_count, override, elapsed_ms, observed_at
    FROM shield_policy_transitions ORDER BY observed_at, event_id`,
});

export const AUDIT_QUERY_OPERATIONS = Object.freeze(Object.keys(AUDIT_QUERY_SQL));

export function queryAuditStore(store, operation, params = {}, { limit = DEFAULT_QUERY_LIMIT } = {}) {
  if (!store || typeof store.query !== "function") throw new TypeError("query store is required");
  const normalized = normalizeQueryArguments(operation, params, limit);
  const sql = `${AUDIT_QUERY_SQL[operation]}\nLIMIT ?`;
  const values = operation === "request"
    ? [normalized.id, normalized.id, normalized.limit]
    : operation === "shield_decision"
      ? [normalized.id, normalized.limit]
    : [normalized.limit];
  return store.query(sql, values);
}

export function createAuditQueryServer({ socketPath, capability, query, maxFrameBytes = 256 * 1024, readTimeoutMs = 5_000 } = {}) {
  assertSocketPath(socketPath);
  assertCapability(capability);
  if (typeof query !== "function") throw new TypeError("query handler is required");

  let server = null;
  let startPromise = null;
  let stopPromise = null;
  const inFlight = new Set();
  let listening = false;

  return { start, stop, status };

  async function start() {
    if (startPromise) return startPromise;
    startPromise = startOnce();
    return startPromise;
  }

  async function stop() {
    if (stopPromise) return stopPromise;
    stopPromise = stopOnce();
    return stopPromise;
  }

  function status() {
    return { listening, socketPath, activeConnections: inFlight.size };
  }

  async function startOnce() {
    await mkdir(dirname(socketPath), { recursive: true, mode: 0o700 });
    await chmod(dirname(socketPath), 0o700);
    await rm(socketPath, { force: true });
    server = createServer({ allowHalfOpen: true }, (socket) => {
      const work = handleConnection(socket).finally(() => inFlight.delete(work));
      inFlight.add(work);
      work.catch(() => socket.destroy());
    });
    try {
      await new Promise((resolve, reject) => {
        const onError = (error) => { server.off("listening", onListening); reject(error); };
        const onListening = () => { server.off("error", onError); resolve(); };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(socketPath);
      });
      await chmod(socketPath, 0o600);
      listening = true;
      return status();
    } catch (error) {
      listening = false;
      await rm(socketPath, { force: true }).catch(() => {});
      server?.close();
      server = null;
      startPromise = null;
      throw error;
    }
  }

  async function stopOnce() {
    if (server) {
      await new Promise((resolve) => server.close(() => resolve()));
      server = null;
      listening = false;
    }
    await Promise.allSettled([...inFlight]);
    await rm(socketPath, { force: true }).catch(() => {});
    return status();
  }

  async function handleConnection(socket) {
    socket.setTimeout(readTimeoutMs);
    let requestId = null;
    try {
      const request = await readFrame(socket, { maxFrameBytes, readTimeoutMs });
      requestId = request?.request_id ?? null;
      if (!verifyAuditQueryRequest(request, capability)) throw queryError("AIRKIT_AUDIT_QUERY_AUTHORIZATION_FAILED");
      const rows = await query(request);
      if (!Array.isArray(rows)) throw queryError("AIRKIT_AUDIT_QUERY_INVALID_RESULT");
      socket.end(encodeAuditFrame({
        version: QUERY_VERSION,
        request_id: request.request_id,
        status: "ok",
        rows: rows.slice(0, request.limit),
      }));
    } catch (error) {
      if (error?.code === "AIRKIT_AUDIT_QUERY_AUTHORIZATION_FAILED" || error?.code === "AIRKIT_AUDIT_QUERY_INVALID_REQUEST") {
        socket.destroy();
        return;
      }
      socket.end(encodeAuditFrame({
        version: QUERY_VERSION,
        request_id: requestId,
        status: "error",
        code: error?.code ?? "AIRKIT_AUDIT_QUERY_FAILED",
      }));
    }
  }
}

export function createAuditQueryClient({ socketPath, capability, timeoutMs = 5_000, maxFrameBytes = 256 * 1024 } = {}) {
  assertSocketPath(socketPath);
  assertCapability(capability);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError("timeoutMs must be positive");

  return {
    query(operation, params = {}) {
      const request = authenticateAuditQueryRequest({
        version: QUERY_VERSION,
        request_id: randomUUID(),
        operation,
        params,
      }, capability);
      const decoder = createAuditFrameDecoder({ maxFrameBytes, readTimeoutMs: timeoutMs });
      return new Promise((resolve, reject) => {
        const socket = createConnection(socketPath);
        let settled = false;
        const finish = (error, value) => {
          if (settled) return;
          settled = true;
          if (error) reject(error);
          else resolve(value);
        };
        socket.setTimeout(timeoutMs);
        socket.once("connect", () => socket.end(encodeAuditFrame(request)));
        socket.on("data", (chunk) => {
          try {
            const response = decoder.push(chunk);
            if (response === null) return;
            if (response.request_id !== request.request_id) throw queryError("AIRKIT_AUDIT_QUERY_RESPONSE_MISMATCH");
            if (response.status === "error") throw queryError(response.code ?? "AIRKIT_AUDIT_QUERY_FAILED");
            if (response.status !== "ok" || !Array.isArray(response.rows)) throw queryError("AIRKIT_AUDIT_QUERY_INVALID_RESPONSE");
            finish(null, response);
          } catch (error) {
            socket.destroy();
            finish(error);
          }
        });
        socket.once("timeout", () => { socket.destroy(); finish(queryError("AIRKIT_AUDIT_QUERY_TIMEOUT")); });
        socket.once("error", (error) => finish(error));
        socket.once("close", () => { if (!settled) finish(queryError("AIRKIT_AUDIT_QUERY_CONNECTION_CLOSED")); });
      });
    },
  };
}

export function authenticateAuditQueryRequest(request, capability) {
  assertCapability(capability);
  const normalized = normalizeQueryRequest(request);
  return { ...normalized, mac: signQueryRequest(normalized, capability) };
}

export function verifyAuditQueryRequest(request, capability) {
  try {
    assertCapability(capability);
    const normalized = normalizeQueryRequest(request);
    const expected = signQueryRequest(normalized, capability);
    return typeof request?.mac === "string" && safeEqual(request.mac, expected);
  } catch {
    return false;
  }
}

function normalizeQueryRequest(request) {
  if (!request || request.version !== QUERY_VERSION || typeof request.request_id !== "string" || request.request_id.length === 0) {
    throw queryError("AIRKIT_AUDIT_QUERY_INVALID_REQUEST");
  }
  const params = request.params ?? {};
  if (!params || typeof params !== "object" || Array.isArray(params)) throw queryError("AIRKIT_AUDIT_QUERY_INVALID_REQUEST");
  const allowedParams = new Set(["id", "limit"]);
  if (Object.keys(params).some((key) => !allowedParams.has(key))) throw queryError("AIRKIT_AUDIT_QUERY_INVALID_REQUEST");
  const normalizedArgs = {};
  if (params.id !== undefined) {
    if (typeof params.id !== "string" || params.id.length === 0 || params.id.length > 512) throw queryError("AIRKIT_AUDIT_QUERY_INVALID_REQUEST");
    normalizedArgs.id = params.id;
  }
  const limit = normalizeLimit(request.limit ?? params.limit ?? DEFAULT_QUERY_LIMIT);
  if (!AUDIT_QUERY_OPERATIONS.includes(request.operation)) throw queryError("AIRKIT_AUDIT_QUERY_OPERATION_NOT_ALLOWED");
  if ((request.operation === "request" || request.operation === "shield_decision") && !normalizedArgs.id) throw queryError("AIRKIT_AUDIT_QUERY_INVALID_REQUEST");
  if (request.operation === "shield_decision" && !isShieldOpaqueId(normalizedArgs.id)) throw queryError("AIRKIT_AUDIT_QUERY_INVALID_SHIELD_IDENTIFIER");
  return {
    version: QUERY_VERSION,
    request_id: request.request_id,
    operation: request.operation,
    params: normalizedArgs,
    limit,
  };
}

function normalizeQueryArguments(operation, params, limit) {
  if (!AUDIT_QUERY_OPERATIONS.includes(operation)) throw queryError("AIRKIT_AUDIT_QUERY_OPERATION_NOT_ALLOWED");
  const input = Array.isArray(params) ? { id: params[0] } : (params ?? {});
  const id = input.id;
  if ((operation === "request" || operation === "shield_decision") && (typeof id !== "string" || id.length === 0)) {
    throw queryError("AIRKIT_AUDIT_QUERY_INVALID_REQUEST");
  }
  if (operation === "shield_decision" && !isShieldOpaqueId(id)) {
    throw queryError("AIRKIT_AUDIT_QUERY_INVALID_SHIELD_IDENTIFIER");
  }
  return { id, limit: normalizeLimit(limit) };
}

function normalizeLimit(value) {
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_QUERY_LIMIT) {
    throw queryError("AIRKIT_AUDIT_QUERY_LIMIT_INVALID");
  }
  return limit;
}

function signQueryRequest(request, capability) {
  return createHmac("sha256", capability).update(stableJson(request), "utf8").digest("hex");
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

async function readFrame(socket, { maxFrameBytes, readTimeoutMs }) {
  const decoder = createAuditFrameDecoder({ maxFrameBytes, readTimeoutMs });
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      socket.removeAllListeners("data");
      socket.removeAllListeners("end");
      socket.removeAllListeners("error");
      socket.removeAllListeners("timeout");
      if (error) reject(error);
      else resolve(value);
    };
    socket.on("data", (chunk) => { try { const frame = decoder.push(chunk); if (frame !== null) finish(null, frame); } catch (error) { finish(error); } });
    socket.once("end", () => finish(queryError("AIRKIT_AUDIT_QUERY_INCOMPLETE_FRAME")));
    socket.once("timeout", () => finish(queryError("AIRKIT_AUDIT_QUERY_TIMEOUT")));
    socket.once("error", (error) => finish(error));
  });
}

function queryError(code) {
  return Object.assign(new Error(code), { code });
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left), "utf8");
  const b = Buffer.from(String(right), "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

function assertSocketPath(value) {
  if (typeof value !== "string" || value.length === 0 || !value.startsWith("/")) throw new TypeError("query socketPath must be absolute");
}

function assertCapability(value) {
  if (typeof value !== "string" || value.length === 0) throw new TypeError("query capability must be non-empty");
}
