import { chmod, mkdir, rm } from "node:fs/promises";
import { createServer } from "node:net";

import { decryptAuditValue } from "./crypto.mjs";
import { createAuditQueryServer, queryAuditStore } from "./query.mjs";
import { encodeAuditFrame, verifyEnvelopeAuthorization, createAuditFrameDecoder } from "./transport.mjs";

const DEFAULT_MAX_FRAME_BYTES = 256 * 1024;
const DEFAULT_READ_TIMEOUT_MS = 5_000;

export function createAuditDaemon(options = {}) {
  const paths = options.paths;
  const keyProvider = options.keyProvider;
  const storeFactory = options.storeFactory;
  const capability = options.capability;
  const clock = options.clock ?? { now: () => Date.now() };
  const maxFrameBytes = options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
  const readTimeoutMs = options.readTimeoutMs ?? DEFAULT_READ_TIMEOUT_MS;
  const stderr = options.stderr ?? process.stderr;

  if (!paths?.rootDir || !paths?.socketPath) throw new TypeError("paths.rootDir and paths.socketPath are required");
  if (!isNonEmptyString(capability)) throw new TypeError("capability is required");
  if (!isClock(clock)) throw new TypeError("clock.now is required");
  if (typeof storeFactory !== "function") throw new TypeError("storeFactory must be a function");
  if (!isKeyProvider(keyProvider)) throw new TypeError("keyProvider.getMasterKey is required");

  let server = null;
  let queryServer = null;
  let store = null;
  let startPromise = null;
  let stopPromise = null;
  let listening = false;
  let draining = false;
  let masterKeyPromise = null;
  const inFlight = new Set();
  const counters = {
    accepted: 0,
    completed: 0,
    rejected: 0,
  };

  return {
    start,
    stop,
    status,
  };

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
    return {
      listening,
      draining,
      activeConnections: inFlight.size,
      accepted: counters.accepted,
      completed: counters.completed,
      rejected: counters.rejected,
      socketPath: paths.socketPath,
      querySocketPath: paths.querySocketPath ?? null,
      queryListening: queryServer?.status().listening ?? false,
      startedAt: startPromise ? new Date(clock.now()).toISOString() : null,
    };
  }

  async function startOnce() {
    await mkdir(paths.rootDir, { recursive: true, mode: 0o700 });
    await chmod(paths.rootDir, 0o700);
    await rm(paths.socketPath, { force: true });

    store = await Promise.resolve(storeFactory({ paths }));
    if (paths.querySocketPath) {
      queryServer = createAuditQueryServer({
        socketPath: paths.querySocketPath,
        capability,
        maxFrameBytes,
        readTimeoutMs,
        query: (request) => queryAuditStore(store, request.operation, request.params, { limit: request.limit }),
      });
      await queryServer.start();
    }
    server = createServer({ allowHalfOpen: true }, (socket) => {
      counters.accepted += 1;
      const work = handleConnection(socket)
        .catch((error) => {
          socket.destroy();
          counters.rejected += 1;
          emitDiagnostic(stderr, diagnosticCode(error), {
            active: inFlight.size,
            accepted: counters.accepted,
            rejected: counters.rejected,
          });
        })
        .finally(() => {
          inFlight.delete(work);
        });
      inFlight.add(work);
    });

    try {
      await new Promise((resolve, reject) => {
        const onError = (error) => {
          server.off("listening", onListening);
          reject(error);
        };
        const onListening = () => {
          server.off("error", onError);
          resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(paths.socketPath);
      });
      await chmod(paths.socketPath, 0o600);
      listening = true;
      return status();
    } catch (error) {
      listening = false;
      if (server) {
        server.close();
        server = null;
      }
      await queryServer?.stop().catch(() => {});
      queryServer = null;
      if (store?.close) store.close();
      store = null;
      startPromise = null;
      await rm(paths.socketPath, { force: true }).catch(() => {});
      throw error;
    }
  }

  async function stopOnce() {
    draining = true;
    if (server) {
      await new Promise((resolve) => {
        server.close(() => resolve());
      });
      server = null;
      listening = false;
    }
    await queryServer?.stop();
    queryServer = null;
    await rm(paths.socketPath, { force: true }).catch(() => {});
    await Promise.allSettled([...inFlight]);
    if (store?.close) store.close();
    store = null;
    return status();
  }

  async function handleConnection(socket) {
    const frame = await readFrame(socket);
    if (!verifyEnvelopeAuthorization(frame, capability)) {
      throw codedError("AIRKIT_AUDIT_AUTHORIZATION_FAILED", "authorization failed");
    }

    const masterKey = await getMasterKey();
    const plaintext = decryptAuditValue({
      masterKey,
      purpose: "request-evidence/v1",
      identity: frame.event_id,
      encrypted: frame.encrypted,
    });

    let event;
    try {
      event = JSON.parse(plaintext.toString("utf8"));
    } catch {
      throw codedError("AIRKIT_AUDIT_INVALID_PAYLOAD", "decrypted payload must be valid JSON");
    }
    if (!isRecord(event) || event.event_id !== frame.event_id) {
      throw codedError("AIRKIT_AUDIT_INVALID_PAYLOAD", "decrypted payload event_id mismatch");
    }

    const result = await store.ingestEvent(event);
    if (result?.status !== "committed" && result?.status !== "duplicate") {
      throw codedError("AIRKIT_AUDIT_INVALID_STORE_RESULT", "store must return committed or duplicate");
    }

    await new Promise((resolve, reject) => {
      socket.end(encodeAuditFrame({
        event_id: frame.event_id,
        status: result.status,
      }), (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
    counters.completed += 1;
  }

  async function readFrame(socket) {
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
        if (error) {
          socket.destroy();
          reject(error);
        } else {
          resolve(value);
        }
      };

      socket.setTimeout(readTimeoutMs);
      socket.on("data", (chunk) => {
        try {
          const decoded = decoder.push(chunk);
          if (decoded !== null) finish(null, decoded);
        } catch (error) {
          finish(error);
        }
      });
      socket.once("end", () => finish(codedError("AIRKIT_AUDIT_INCOMPLETE_FRAME", "frame ended before completion")));
      socket.once("timeout", () => finish(codedError("AIRKIT_AUDIT_FRAME_TIMEOUT", "frame read timeout")));
      socket.once("error", (error) => finish(error));
    });
  }

  function getMasterKey() {
    if (!masterKeyPromise) {
      masterKeyPromise = Promise.resolve(keyProvider.getMasterKey());
    }
    return masterKeyPromise;
  }
}

function emitDiagnostic(stderr, code, fields) {
  const parts = [`code=${code}`];
  for (const [key, value] of Object.entries(fields ?? {})) {
    if (typeof value === "number" && Number.isFinite(value)) {
      parts.push(`${key}=${value}`);
    }
  }
  stderr.write(`AIRKIT_AUDITD ${parts.join(" ")}\n`);
}

function diagnosticCode(error) {
  return typeof error?.code === "string" ? error.code : "AIRKIT_AUDITD_TRANSPORT_ERROR";
}

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function isClock(value) {
  return value !== null && typeof value === "object" && typeof value.now === "function";
}

function isKeyProvider(value) {
  return value !== null && typeof value === "object" && typeof value.getMasterKey === "function";
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
