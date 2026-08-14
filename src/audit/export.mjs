import { createHash, randomBytes } from "node:crypto";
import { open, rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

const METADATA_FIELDS = Object.freeze([
  "provider", "model", "client", "status_code", "failure_kind", "effort",
  "started_at", "last_observed_at", "completed_at", "duration_ms",
  "input_tokens", "output_tokens", "reasoning_tokens", "total_tokens",
  "cache_read_tokens", "cache_creation_tokens", "capture_completeness",
]);

export async function exportAuditData(readStore, options = {}) {
  const {
    format = "jsonl",
    includePayload = false,
    decrypt = false,
    authorizer,
    authorizeExport,
    output,
    outputPath,
    decryptRow,
    interactive = false,
    signalProcess = process,
  } = options;
  if (!new Set(["jsonl", "csv"]).has(format)) throw new RangeError("format must be jsonl or csv");
  if (decrypt && !includePayload) throw new Error("includePayload is required before decrypt");
  if (includePayload && (!decrypt || typeof decryptRow !== "function" || (!authorizeExport && (!authorizer || typeof authorizer.consume !== "function")))) {
    throw new Error("decrypt authorization is required for payload export");
  }
  if (decrypt && !interactive && !authorizeExport) {
    const error = new Error("decrypted export requires an interactive terminal");
    error.code = "AIRKIT_AUDIT_REVEAL_NONINTERACTIVE";
    throw error;
  }
  if (decrypt && !outputPath) {
    const error = new Error("decrypted export requires an outputPath; stdout is not rollback-safe");
    error.code = "AIRKIT_AUDIT_REVEAL_NONINTERACTIVE";
    throw error;
  }
  if (!readStore || typeof readStore.exportRows !== "function") {
    const error = new Error("audit read store does not support export");
    error.code = "AIRKIT_AUDIT_EXPORT_UNAVAILABLE";
    throw error;
  }
  const salt = randomBytes(16);
  let count = 0;
  const rows = includePayload && typeof readStore.exportManifest === "function"
    ? await readStore.exportManifest()
    : [];
  if (includePayload && rows.length === 0 && typeof readStore.exportManifest !== "function") {
    for await (const row of readStore.exportRows()) rows.push(row);
  }
  if (includePayload) {
    const authorized = authorizeExport
      ? await authorizeExport({ rows, outputPath, format })
      : await authorizer.consume();
    if (!authorized) throw new Error("decrypt authorization denied");
  }
  const sink = outputPath ? await createAtomicFileSink(outputPath, { signalProcess }) : normalizeSink(output);
  try {
    const fields = includePayload ? [...METADATA_FIELDS, "payload"] : METADATA_FIELDS;
    if (format === "csv") await sink.write(`${fields.join(",")}\n`);
    for await (const row of readStore.exportRows()) {
      const safe = await projectRow(row, { salt, includePayload, decryptRow });
      const line = format === "csv" ? csvLine(safe, fields) : `${JSON.stringify(safe)}\n`;
      await sink.write(line);
      count += 1;
    }
    await sink.end();
    return { state: "healthy", format, rows: count, metadata_only: !includePayload };
  } catch (error) {
    await sink.abort();
    throw error;
  }
}

async function projectRow(row, { salt, includePayload, decryptRow }) {
  const result = {};
  for (const idField of ["request_id", "logical_request_id", "session_id"]) {
    if (row[idField] !== undefined) result[idField] = pseudonymize(row[idField], salt);
  }
  for (const field of METADATA_FIELDS) {
    if (row[field] !== undefined) result[field] = safeDimension(row[field]);
  }
  if (includePayload) {
    if (typeof decryptRow !== "function") throw new Error("decryptRow is required for decrypted export");
    const decrypted = await decryptRow(row);
    result.payload = decrypted?.payload ?? decrypted?.payload_json ?? decrypted ?? null;
  }
  return result;
}

function pseudonymize(value, salt) {
  return `id_${createHash("sha256").update(salt).update(String(value)).digest("hex").slice(0, 16)}`;
}

function csvLine(value, fields) {
  return `${fields.map((field) => csvCell(value[field])).join(",")}\n`;
}

function csvCell(value) {
  if (value === undefined || value === null) return "";
  const text = typeof value === "object" ? JSON.stringify(value) : String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function normalizeSink(output) {
  if (typeof output === "function") {
    return { write: async (chunk) => output(chunk), end: async () => {}, abort: async () => {} };
  }
  if (!output || typeof output.write !== "function") throw new TypeError("output must be a function or writable sink");
  return {
    write: async (chunk) => output.write(chunk),
    end: async () => output.end?.(),
    abort: async () => output.abort?.(),
  };
}

function safeDimension(value) {
  if (typeof value !== "string") return value;
  return value
    .replace(/(?:https?|ssh):\/\/[^\s"'<>]+/gi, "[redacted-url]")
    .replace(/\/(?:Users|private|var|tmp|opt|Volumes|Library|Applications|System|bin|sbin|etc|usr|dev|home)\/[^\s"'<>),;]*/g, "[redacted-path]")
    .replace(/(?:authorization|bearer|api[_-]?key|token|password)\s*[:=]?\s*[^\s,;]+/gi, "[redacted-secret]");
}

async function createAtomicFileSink(target, { signalProcess = process } = {}) {
  const temp = join(dirname(target), `.${basename(target)}.tmp-${randomBytes(8).toString("hex")}`);
  const handle = await open(temp, "wx", 0o600);
  let committed = false;
  const signalCleanup = () => {
    signalProcess.removeListener("SIGINT", onSignal);
    signalProcess.removeListener("SIGTERM", onSignal);
  };
  let interrupted = false;
  const onSignal = (signal) => {
    interrupted = true;
    void (async () => {
      await handle.close().catch(() => {});
      await unlink(temp).catch(() => {});
      signalCleanup();
      if (typeof signalProcess.kill === "function" && signalProcess.pid) signalProcess.kill(signalProcess.pid, signal);
    })();
  };
  signalProcess.once("SIGINT", onSignal);
  signalProcess.once("SIGTERM", onSignal);
  return {
    async write(chunk) {
      if (interrupted) throw new Error("audit export interrupted");
      await handle.write(String(chunk));
    },
    async end() {
      await handle.sync();
      await handle.close();
      await rename(temp, target);
      committed = true;
      signalCleanup();
    },
    async abort() {
      if (!committed) {
        await handle.close().catch(() => {});
        await unlink(temp).catch(() => {});
      }
      signalCleanup();
    },
  };
}
