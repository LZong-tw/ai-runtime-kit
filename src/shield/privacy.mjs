import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";

import { attestShieldCheckpoint } from "./checkpoint.mjs";

const PROTOCOL = "airkit-privacy-ndjson-v1";
const MAX_BODY_BYTES = 1_048_576;
const MAX_FRAME_BYTES = 1_048_576;
const DEFAULT_TIMEOUT_MS = 2_000;
const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;
const KNOWN_LABELS = new Set([
  "address", "credit-card", "email", "ip-address", "person", "phone", "ssn", "token",
  "account_number", "private_address", "private_email", "private_person",
  "private_phone", "private_url", "private_date", "secret",
]);

export async function createPrivacyFilter({ provision, spawnWorker = defaultSpawnWorker, validateWorker = validatePrivacyWorkerAsset, validateCheckpoint = attestShieldCheckpoint, validateFile = validatePrivacyPinnedFile, timeoutMs = DEFAULT_TIMEOUT_MS, startupTimeoutMs = DEFAULT_STARTUP_TIMEOUT_MS } = {}) {
  const privacy = assertPrivacyProvision(provision);
  if (typeof spawnWorker !== "function") throw new TypeError("shield privacy worker launcher is required");
  if (typeof validateWorker !== "function") throw new TypeError("shield privacy worker validator is required");
  if (typeof validateCheckpoint !== "function") throw new TypeError("shield privacy checkpoint validator is required");
  if (typeof validateFile !== "function") throw new TypeError("shield privacy file validator is required");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) throw new TypeError("shield privacy worker timeout is invalid");
  if (!Number.isInteger(startupTimeoutMs) || startupTimeoutMs < 1 || startupTimeoutMs > 60_000) throw new TypeError("shield privacy startup timeout is invalid");

  try { await validateWorker(privacy.worker); } catch { throw new Error("shield privacy worker unavailable"); }
  let assertCheckpointUnchanged;
  let assertSourceUnchanged;
  if (privacy.checkpoint) {
    try { assertCheckpointUnchanged = await validateCheckpoint(privacy.checkpoint); } catch { throw new Error("shield privacy checkpoint unavailable"); }
    if (typeof assertCheckpointUnchanged !== "function") throw new Error("shield privacy checkpoint unavailable");
    try { assertSourceUnchanged = await validateCheckpoint(privacy.source, { label: "source" }); } catch { throw new Error("shield privacy source unavailable"); }
    if (typeof assertSourceUnchanged !== "function") throw new Error("shield privacy source unavailable");
    try {
      await validateFile(privacy.adapter, { label: "adapter" });
      await validateFile(privacy.tokenizer, { label: "tokenizer" });
    } catch { throw new Error("shield privacy pinned file unavailable"); }
  }

  let worker;
  try {
    worker = spawnWorker({
      command: privacy.checkpoint ? process.execPath : privacy.worker.command,
      args: privacy.checkpoint ? [privacy.worker.command, ...privacy.worker.args] : privacy.worker.args,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch {
    throw new Error("shield privacy worker unavailable");
  }
  if (!worker?.stdin || !worker?.stdout || typeof worker.stdin.write !== "function" || typeof worker.stdout.on !== "function") {
    throw new Error("shield privacy worker unavailable");
  }

  const pending = new Map();
  let remainder = Buffer.alloc(0);
  let stderrBytes = 0;
  let closed = false;
  const failAll = () => {
    for (const entry of pending.values()) entry.resolve(null);
    pending.clear();
  };
  const close = () => {
    if (closed) return;
    closed = true;
    failAll();
    try { worker.kill?.(); } catch {}
  };
  const failWorker = () => { close(); };
  worker.once?.("error", failWorker);
  worker.once?.("exit", failWorker);
  worker.stdout.on("data", (chunk) => {
    if (closed) return;
    const incomingBytes = Buffer.isBuffer(chunk) || chunk instanceof Uint8Array ? chunk.byteLength : Buffer.byteLength(chunk);
    if (incomingBytes > MAX_FRAME_BYTES || remainder.byteLength > MAX_FRAME_BYTES - incomingBytes) { failWorker(); return; }
    const next = Buffer.concat([remainder, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
    const lines = next.toString("utf8").split("\n");
    remainder = Buffer.from(lines.pop() ?? "");
    if (remainder.byteLength > MAX_FRAME_BYTES) { failWorker(); return; }
    for (const line of lines) {
      if (Buffer.byteLength(line) > MAX_FRAME_BYTES) { failWorker(); return; }
      consumeReply(line, pending);
    }
  });
  worker.stderr?.on?.("data", (chunk) => {
    stderrBytes += Buffer.byteLength(chunk);
    if (stderrBytes > MAX_FRAME_BYTES) failWorker();
  });

  const request = async (message, deadlineMs = timeoutMs) => {
    if (closed) return null;
    const id = randomUUID();
    const payload = JSON.stringify({ ...message, id, protocol: PROTOCOL });
    if (Buffer.byteLength(payload) > MAX_FRAME_BYTES) return null;
    return await new Promise((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        resolve(null);
      }, deadlineMs);
      pending.set(id, { expectedType: message.type, resolve: (reply) => { clearTimeout(timer); resolve(reply); } });
      try { worker.stdin.write(`${payload}\n`); } catch { pending.delete(id); clearTimeout(timer); resolve(null); }
    });
  };

  const health = await request({ type: "health" }, startupTimeoutMs);
  if (!validHealth(health, privacy.version)) {
    close();
    throw new Error("shield privacy worker unavailable");
  }
  return Object.freeze({
    version: privacy.version,
    async scan(body) {
      if (closed || !validBody(body)) return unavailable();
      if (assertCheckpointUnchanged) {
        try {
          await assertCheckpointUnchanged();
          await assertSourceUnchanged();
          await validateFile(privacy.adapter, { label: "adapter" });
          await validateFile(privacy.tokenizer, { label: "tokenizer" });
        } catch { close(); return unavailable(); }
      }
      const reply = await request({ type: "scan", body: Buffer.from(body).toString("base64") });
      return normalizeScanReply(reply);
    },
    close,
  });
}

export async function runPrivacyWorkerSelfTest(provision, { spawnWorker = defaultSpawnWorker, validateWorker = validatePrivacyWorkerAsset, validateCheckpoint = attestShieldCheckpoint, validateFile = validatePrivacyPinnedFile, timeoutMs = DEFAULT_TIMEOUT_MS, startupTimeoutMs = DEFAULT_STARTUP_TIMEOUT_MS } = {}) {
  const filter = await createPrivacyFilter({ provision, spawnWorker, validateWorker, validateCheckpoint, validateFile, timeoutMs, startupTimeoutMs });
  try {
    const opf = Boolean(provision?.privacy?.checkpoint);
    const email = opf ? "alice@example.com" : "AIRKIT_PRIVACY_PROTOCOL_PROBE_EMAIL";
    const original = Buffer.from(JSON.stringify({ content: email }));
    const result = await filter.scan(original);
    if (!isVerifiedRedaction({ original, result }) || !result.findings.some((finding) => finding.label === (opf ? "private_email" : "email")) || result.redactedBody.includes(email)) {
      throw new Error("shield privacy worker self-test failed");
    }
    return Object.freeze({ version: filter.version });
  } catch {
    throw new Error("shield privacy worker self-test failed");
  } finally {
    filter.close();
  }
}

function consumeReply(line, pending) {
  let reply;
  try { reply = JSON.parse(line); } catch { failPending(pending); return; }
  if (!isPlainObject(reply) || typeof reply.id !== "string" || typeof reply.type !== "string") { failPending(pending); return; }
  const entry = pending.get(reply.id);
  if (!entry || entry.expectedType !== reply.type) { failPending(pending); return; }
  pending.delete(reply.id);
  entry.resolve(reply);
}

function failPending(pending) {
  for (const entry of pending.values()) entry.resolve(null);
  pending.clear();
}

function validHealth(reply, version) {
  return isPlainObject(reply) && reply.type === "health" && reply.protocol === PROTOCOL && reply.version === version;
}

function normalizeScanReply(reply) {
  if (!isPlainObject(reply) || reply.type !== "scan" || typeof reply.status !== "string") return unavailable();
  if (reply.status === "unknown") return Object.freeze({ status: "unknown", findings: Object.freeze([]) });
  if (reply.status !== "ok" || !Array.isArray(reply.findings) || reply.findings.length > 128) return unavailable();
  const findings = [];
  for (const finding of reply.findings) {
    if (!isPlainObject(finding) || !KNOWN_LABELS.has(finding.label) || !Number.isInteger(finding.count) || finding.count < 1 || finding.count > 1024) {
      return Object.freeze({ status: "unknown", findings: Object.freeze([]) });
    }
    findings.push(Object.freeze({ label: finding.label, count: finding.count }));
  }
  const result = { status: "ok", findings: Object.freeze(findings) };
  if (reply.redactions !== undefined) {
    const redactions = normalizeRedactions(reply.redactions);
    if (redactions === null) return unavailable();
    result.redactions = redactions;
  }
  if (reply.redactedBody !== undefined) {
    const redactedBody = decodeRedactedBody(reply.redactedBody);
    if (redactedBody === null) return unavailable();
    result.redactedBody = redactedBody;
  }
  return Object.freeze(result);
}

function normalizeRedactions(value) {
  if (!Array.isArray(value) || value.length > 128) return null;
  const result = [];
  for (const entry of value) {
    if (!isPlainObject(entry) || !KNOWN_LABELS.has(entry.label) || !Number.isInteger(entry.count) || entry.count < 1 || entry.count > 1024) return null;
    const spans = entry.spans === undefined ? undefined : normalizeSpans(entry.spans, entry.count);
    if (spans === null) return null;
    result.push(Object.freeze({ label: entry.label, count: entry.count, ...(spans === undefined ? {} : { spans }) }));
  }
  return Object.freeze(result);
}

function normalizeSpans(value, count) {
  if (!Array.isArray(value) || value.length !== count) return null;
  const spans = [];
  for (const span of value) {
    if (!isPlainObject(span) || !Number.isInteger(span.start) || !Number.isInteger(span.end) || span.start < 0 || span.end <= span.start || span.end > MAX_BODY_BYTES) return null;
    spans.push(Object.freeze({ start: span.start, end: span.end }));
  }
  return Object.freeze(spans);
}

export function isVerifiedRedaction({ original, result } = {}) {
  if (!validBody(original) || result?.status !== "ok" || !Buffer.isBuffer(result.redactedBody) || result.redactedBody.equals(Buffer.from(original))) return false;
  if (!Array.isArray(result.findings) || !Array.isArray(result.redactions)) return false;
  const counts = new Map();
  for (const redaction of result.redactions) {
    if (!Array.isArray(redaction.spans) || redaction.spans.length !== redaction.count) return false;
    for (const span of redaction.spans) {
      if (!Number.isInteger(span.start) || !Number.isInteger(span.end) || span.start < 0 || span.end <= span.start || span.end > original.byteLength) return false;
      const originalValue = Buffer.from(original).subarray(span.start, span.end);
      if (result.redactedBody.includes(originalValue)) return false;
    }
    counts.set(redaction.label, (counts.get(redaction.label) ?? 0) + redaction.count);
  }
  return result.findings.every((finding) => counts.get(finding.label) >= finding.count);
}

function decodeRedactedBody(value) {
  if (typeof value !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return null;
  const body = Buffer.from(value, "base64");
  if (body.byteLength === 0 || body.byteLength > MAX_BODY_BYTES) return null;
  try { JSON.parse(body.toString("utf8")); } catch { return null; }
  return Buffer.from(body);
}

function assertPrivacyProvision(provision) {
  const privacy = provision?.privacy;
  if (!isPlainObject(privacy) || !safeIdentifier(privacy.version) || !isPlainObject(privacy.worker)
    || !isAbsoluteCanonical(privacy.worker.command) || !Array.isArray(privacy.worker.args)
    || !privacy.worker.args.every((argument) => typeof argument === "string" && argument.length > 0 && argument.length <= 256)
    || !/^[a-f0-9]{64}$/.test(privacy.worker.sha256 ?? "")) {
    throw new TypeError("shield privacy provision is invalid");
  }
  if (privacy.checkpoint !== undefined && (!validTree(privacy.checkpoint) || !validTree(privacy.source)
    || !validPinnedFile(privacy.adapter) || privacy.adapter.path !== resolve(dirname(privacy.worker.command), "opf-adapter.mjs")
    || !validPinnedFile(privacy.tokenizer, true) || !validOpfRuntimeArgs(privacy))) {
    throw new TypeError("shield privacy provision is invalid");
  }
  return Object.freeze({
    version: privacy.version,
    worker: Object.freeze({ command: privacy.worker.command, args: Object.freeze([...privacy.worker.args]), sha256: privacy.worker.sha256 }),
    ...(privacy.checkpoint ? {
      checkpoint: Object.freeze({ ...privacy.checkpoint }),
      source: Object.freeze({ ...privacy.source }),
      adapter: Object.freeze({ ...privacy.adapter }),
      tokenizer: Object.freeze({ ...privacy.tokenizer }),
    } : {}),
  });
}

function validTree(value) {
  return isPlainObject(value) && Object.keys(value).sort().join(",") === "path,sha256,version"
    && isAbsoluteCanonical(value.path) && resolve(value.path) === value.path
    && /^[a-f0-9]{64}$/.test(value.sha256 ?? "") && safeIdentifier(value.version);
}

function validPinnedFile(value, tokenizer = false) {
  return isPlainObject(value) && Object.keys(value).sort().join(",") === (tokenizer ? "path,sha256,version" : "path,sha256")
    && isAbsoluteCanonical(value.path) && resolve(value.path) === value.path
    && /^[a-f0-9]{64}$/.test(value.sha256 ?? "")
    && (!tokenizer || (value.version === "o200k_base" && value.path.endsWith("/fb374d419588a4632f3f557e76b4b70aebbca790")));
}

function validOpfRuntimeArgs(privacy) {
  const args = privacy.worker.args;
  return args.length === 22 && args[0] === "--python" && isAbsoluteCanonical(args[1]) && resolve(args[1]) === args[1]
    && args[2] === "--checkpoint" && args[3] === privacy.checkpoint.path
    && args[4] === "--checkpoint-sha256" && args[5] === privacy.checkpoint.sha256
    && args[6] === "--checkpoint-version" && args[7] === privacy.checkpoint.version
    && args[8] === "--opf-source" && args[9] === privacy.source.path
    && args[10] === "--opf-source-sha256" && args[11] === privacy.source.sha256
    && args[12] === "--adapter-sha256" && args[13] === privacy.adapter.sha256
    && args[14] === "--tokenizer" && args[15] === privacy.tokenizer.path
    && args[16] === "--tokenizer-sha256" && args[17] === privacy.tokenizer.sha256
    && args[18] === "--startup-timeout-ms" && args[19] === "30000"
    && args[20] === "--scan-timeout-ms" && args[21] === "2000";
}

async function validatePrivacyPinnedFile(asset, { label } = {}) {
  try {
    const [entry, canonical, bytes] = await Promise.all([lstat(asset.path), realpath(asset.path), readFile(asset.path)]);
    if (canonical !== asset.path || !entry.isFile() || entry.isSymbolicLink() || (entry.mode & 0o022) !== 0
      || (typeof process.getuid === "function" && entry.uid !== process.getuid())
      || createHash("sha256").update(bytes).digest("hex") !== asset.sha256) throw new Error("pinned file drift");
  } catch { throw new Error(`shield privacy ${label ?? "file"} validation failed`); }
}

export async function validatePrivacyWorkerAsset(worker, { io = { lstat, readFile, realpath } } = {}) {
  if (!isPlainObject(worker) || !isAbsolute(worker.command) || resolve(worker.command) !== worker.command || !/^[a-f0-9]{64}$/.test(worker.sha256 ?? "")) {
    throw new Error("shield privacy worker provision is invalid");
  }
  let entry;
  let canonicalPath;
  let bytes;
  try { [entry, canonicalPath, bytes] = await Promise.all([io.lstat(worker.command), io.realpath(worker.command), io.readFile(worker.command)]); }
  catch { throw new Error("shield privacy worker validation failed"); }
  if (canonicalPath !== worker.command || entry.isSymbolicLink?.() || !entry.isFile?.() || (entry.mode & 0o022) !== 0 || (entry.mode & 0o100) === 0
    || (typeof process.getuid === "function" && entry.uid !== process.getuid())
    || createHash("sha256").update(bytes).digest("hex") !== worker.sha256) {
    throw new Error("shield privacy worker validation failed");
  }
  return Object.freeze({ command: worker.command, sha256: worker.sha256 });
}

function validBody(body) { return (Buffer.isBuffer(body) || body instanceof Uint8Array) && body.byteLength <= MAX_BODY_BYTES; }
function unavailable() { return Object.freeze({ status: "unavailable", findings: Object.freeze([]) }); }
function safeIdentifier(value) { return typeof value === "string" && /^[A-Za-z0-9._-]{1,128}$/.test(value); }
function isAbsoluteCanonical(value) { return typeof value === "string" && value.startsWith("/") && !value.includes("//") && !value.includes("/../") && !value.endsWith("/.."); }
function isPlainObject(value) { return value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype; }
function defaultSpawnWorker({ command, args, shell, stdio }) { return spawn(command, args, { shell, stdio }); }
