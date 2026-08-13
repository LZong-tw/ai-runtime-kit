import { randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { basename, join } from "node:path";

import { decryptAuditValue, encryptAuditValue, unpackEncryptedValue } from "./crypto.mjs";
import { createAuditEvent, validateAuditEvent } from "./event.mjs";
import { canonicalizeEvidence } from "./redaction.mjs";

const OVERFLOW_GAP_FILE = ".overflow-gap.json";
const TEMP_SUFFIX = ".tmp";
const DEFAULT_NEAR_LIMIT_RATIO = 0.8;
const DEFAULT_MAX_EVENTS = 512;
const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;
const SPOOL_FILE_MODE = 0o600;
const SPOOL_DIR_MODE = 0o700;
const OVERFLOW_GAP_PROFILES = Object.freeze([
  { source: 256, sourceVersion: 128, client: 128, sourceEventId: 256, logicalRequestId: 256, sessionId: 256 },
  { source: 128, sourceVersion: 64, client: 64, sourceEventId: 64, logicalRequestId: 64, sessionId: 64 },
  { source: 64, sourceVersion: 32, client: 32, sourceEventId: 0, logicalRequestId: 0, sessionId: 0 },
  { source: 16, sourceVersion: 16, client: 16, sourceEventId: 0, logicalRequestId: 0, sessionId: 0 },
  { source: 1, sourceVersion: 1, client: 1, sourceEventId: 0, logicalRequestId: 0, sessionId: 0 },
]);

const defaultIo = {
  chmod,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
};

export function createEncryptedSpool(options = {}) {
  const {
    paths,
    masterKey,
    maxEvents = DEFAULT_MAX_EVENTS,
    maxBytes = DEFAULT_MAX_BYTES,
    nearLimitRatio = DEFAULT_NEAR_LIMIT_RATIO,
    io = defaultIo,
    now = () => new Date(),
  } = options;

  if (!paths?.spoolDir) throw new TypeError("paths.spoolDir is required");
  if (!paths?.rootDir) throw new TypeError("paths.rootDir is required");
  if (!Number.isInteger(maxEvents) || maxEvents < 1) throw new TypeError("maxEvents must be a positive integer");
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) throw new TypeError("maxBytes must be positive");
  if (!Number.isFinite(nearLimitRatio) || nearLimitRatio <= 0 || nearLimitRatio > 1) {
    throw new TypeError("nearLimitRatio must be within (0, 1]");
  }

  let mutation = Promise.resolve();
  let nextSequence = null;

  return {
    enqueue: (event) => serialize(() => enqueue(event)),
    entries,
    deliverPending,
    acknowledge: (entry, ack) => serialize(() => acknowledge(entry, ack)),
    stats,
  };

  async function enqueue(event) {
    const validated = validateAuditEvent(event);
    await ensureSpoolDir(io, paths.spoolDir);

    const state = await inspectState();
    const existing = state.validEntries.find((entry) => entry.entry.event.event_id === validated.event_id);
    if (existing) return existing.entry;

    const sequence = takeSequence(state);
    const candidate = createStoredEntry(validated, { now, sequence });
    const candidateBytes = encodeStoredEntry(candidate, masterKey).length;
    const reserveGap = buildFittingOverflowEntry({
      previousGap: state.overflowGap?.entry?.event ?? null,
      droppedEvent: validated,
      now,
      sequence: sequence + 1,
      masterKey,
      maxBytes,
    });
    if (canRetainEvent(state, candidateBytes, reserveGap.bytes)) {
      const recordPath = recordPathFor(paths.spoolDir, validated.event_id);
      await writeStoredEntry(recordPath, candidate);
      return requireValidEntry(await loadEntry(io, recordPath, masterKey), recordPath);
    }

    const overflowEntry = buildFittingOverflowEntry({
      previousGap: state.overflowGap?.entry?.event ?? null,
      droppedEvent: validated,
      now,
      sequence,
      masterKey,
      maxBytes,
    });
    if (overflowEntry.bytes > maxBytes) {
      throw new Error("encrypted overflow gap exceeds maxBytes");
    }
    const recordPath = overflowGapPath(paths.spoolDir);
    await writeStoredEntry(recordPath, overflowEntry.stored);
    return requireValidEntry(await loadEntry(io, recordPath, masterKey), recordPath);
  }

  async function entries() {
    const state = await inspectState();
    return state.validEntries.map((entry) => entry.entry);
  }

  async function deliverPending() {
    return entries();
  }

  async function acknowledge(entry, ack) {
    if (!entry || typeof entry !== "object" || typeof entry.path !== "string") {
      throw new TypeError("entry must be a spool entry");
    }
    if (!isAckStatus(ack?.status) || ack?.event_id !== entry.event?.event_id) {
      throw new Error("spool entries are deleted only after a matching ACK");
    }

    await io.rm(entry.path, { force: true });
    await fsyncDirectory(io, paths.spoolDir);
  }

  async function stats() {
    const state = await inspectState();
    const pendingCount = state.validEntries.length;
    const fileCount = state.fileEntries.length;
    const byteCount = state.fileEntries.reduce((sum, entry) => sum + entry.bytes, 0);
    const nearLimit = limitRatio(fileCount, maxEvents) >= nearLimitRatio
      || limitRatio(byteCount, maxBytes) >= nearLimitRatio;
    const atCapacity = fileCount >= maxEvents || byteCount >= maxBytes;

    return {
      pendingCount,
      corruptCount: state.corruptEntries.length,
      fileCount,
      byteCount,
      nearLimit,
      atCapacity,
    };
  }

  async function inspectState() {
    await ensureSpoolDir(io, paths.spoolDir);
    const names = await io.readdir(paths.spoolDir);
    const candidates = names
      .filter((name) => name.endsWith(".json") && !name.endsWith(TEMP_SUFFIX))
      .sort();

    const validEntries = [];
    const corruptEntries = [];
    for (const name of candidates) {
      const loaded = await loadEntry(io, join(paths.spoolDir, name), masterKey);
      if (loaded.state === "missing") continue;
      if (loaded.state === "valid") validEntries.push(loaded);
      if (loaded.state === "corrupt") corruptEntries.push(loaded);
    }

    validEntries.sort(compareEntries);
    const overflowGap = validEntries.find((entry) => entry.path === overflowGapPath(paths.spoolDir)) ?? null;
    return {
      validEntries,
      corruptEntries,
      overflowGap,
      fileEntries: [...validEntries, ...corruptEntries],
      maxSequence: Math.max(
        0,
        ...validEntries.map((entry) => entry.entry.sequence ?? 0),
        ...corruptEntries.map((entry) => entry.sequence ?? 0),
      ),
    };
  }

  function canRetainEvent(state, candidateBytes, reserveGapBytes) {
    const fileCount = state.fileEntries.length;
    const byteCount = state.fileEntries.reduce((sum, entry) => sum + entry.bytes, 0);
    const reserveCount = state.overflowGap ? 0 : 1;
    const reserveBytes = Math.max(0, reserveGapBytes - (state.overflowGap?.bytes ?? 0));
    return fileCount + 1 + reserveCount <= maxEvents && byteCount + candidateBytes + reserveBytes <= maxBytes;
  }

  async function writeStoredEntry(path, stored) {
    const encoded = encodeStoredEntry(stored, masterKey);
    await atomicWrite(io, path, encoded);
  }

  function serialize(work) {
    const current = mutation.then(work, work);
    mutation = current.catch(() => {});
    return current;
  }

  function takeSequence(state) {
    if (nextSequence === null) {
      nextSequence = state.maxSequence + 1;
    }
    const sequence = nextSequence;
    nextSequence += 1;
    return sequence;
  }
}

function createStoredEntry(event, { now, sequence }) {
  return {
    kind: "audit-spool-entry/v1",
    sequence,
    enqueued_at: toIsoTimestamp(now),
    event,
  };
}

function encodeStoredEntry(stored, masterKey) {
  const plaintext = Buffer.from(canonicalizeEvidence(stored), "utf8");
  const encrypted = encryptAuditValue({
    masterKey,
    purpose: "spool-event/v1",
    identity: stored.event.event_id,
    aad: aadFor(stored.event.event_id),
    plaintext,
  });
  return Buffer.from(canonicalizeEvidence({
    kind: "audit-spool-record/v1",
    event_id: stored.event.event_id,
    sequence: stored.sequence,
    encrypted,
  }), "utf8");
}

async function loadEntry(io, path, masterKey) {
  let record = null;
  try {
    const file = await io.readFile(path, "utf8");
    record = JSON.parse(file);
    if (
      record?.kind !== "audit-spool-record/v1"
      || typeof record?.event_id !== "string"
      || !Number.isInteger(record?.sequence)
      || record.sequence < 1
    ) {
      throw new Error("invalid spool record");
    }
    const encrypted = unpackEncryptedValue(JSON.stringify(record.encrypted));
    const decrypted = decryptAuditValue({
      masterKey,
      purpose: "spool-event/v1",
      identity: record.event_id,
      aad: aadFor(record.event_id),
      encrypted,
    });
    const parsed = JSON.parse(decrypted.toString("utf8"));
    const event = validateAuditEvent(parsed.event);
    const bytes = (await io.stat(path)).size;
    return {
      state: "valid",
      path,
      bytes,
      entry: Object.freeze({
        path,
        bytes,
        sequence: record.sequence,
        event,
        enqueued_at: parsed.enqueued_at,
        encrypted,
        packed: file,
      }),
    };
  } catch (error) {
    if (error?.code === "ENOENT") return { state: "missing", path, bytes: 0 };
    const bytes = await sizeOf(io, path);
    return {
      state: "corrupt",
      path,
      bytes,
      sequence: Number.isInteger(record?.sequence) ? record.sequence : null,
      error,
    };
  }
}

async function ensureSpoolDir(io, directory) {
  await io.mkdir(directory, { recursive: true, mode: SPOOL_DIR_MODE });
  await io.chmod(directory, SPOOL_DIR_MODE);
}

async function atomicWrite(io, path, bytes) {
  await ensureSpoolDir(io, dirnameOf(path));
  const temporary = join(dirnameOf(path), `.${basename(path)}.${randomUUID()}${TEMP_SUFFIX}`);
  let handle;
  try {
    handle = await io.open(temporary, "wx", SPOOL_FILE_MODE);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = null;
    await io.chmod(temporary, SPOOL_FILE_MODE);
    await io.rename(temporary, path);
    await io.chmod(path, SPOOL_FILE_MODE);
    await fsyncDirectory(io, dirnameOf(path));
  } finally {
    if (handle) await handle.close();
    await io.rm(temporary, { force: true });
  }
}

async function fsyncDirectory(io, directory) {
  const handle = await io.open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function buildOverflowGapEvent(previousGap, droppedEvent, profile) {
  const previousDropped = Number.isInteger(previousGap?.payload?.dropped_events)
    ? previousGap.payload.dropped_events
    : 0;
  return createAuditEvent({
    event_id: randomUUID(),
    source: truncateRequired(droppedEvent.source, profile.source),
    source_version: truncateRequired(droppedEvent.source_version, profile.sourceVersion),
    source_event_id: truncateOptional(droppedEvent.event_id, profile.sourceEventId),
    observed_at: droppedEvent.observed_at,
    logical_request_id: truncateOptional(droppedEvent.logical_request_id, profile.logicalRequestId),
    session_id: truncateOptional(droppedEvent.session_id, profile.sessionId),
    client: truncateRequired(droppedEvent.client, profile.client),
    event_kind: "collector_gap",
    payload: {
      reason: "spool-overflow",
      dropped_events: previousDropped + 1,
      retained_payload_ciphertext: false,
    },
  });
}

function compareEntries(left, right) {
  return (left.entry.sequence ?? 0) - (right.entry.sequence ?? 0)
    || left.path.localeCompare(right.path);
}

function recordPathFor(spoolDir, eventId) {
  return join(spoolDir, `${encodeURIComponent(eventId)}.json`);
}

function overflowGapPath(spoolDir) {
  return join(spoolDir, OVERFLOW_GAP_FILE);
}

function aadFor(eventId) {
  return Buffer.from(`airkit-audit-spool:${eventId}`, "utf8");
}

async function sizeOf(io, path) {
  try {
    return (await io.stat(path)).size;
  } catch {
    return 0;
  }
}

function dirnameOf(path) {
  return path.slice(0, path.lastIndexOf("/")) || ".";
}

function requireValidEntry(loaded, path) {
  if (loaded.state !== "valid") {
    throw new Error(`failed to reload encrypted spool entry: ${path}`);
  }
  return loaded.entry;
}

function isAckStatus(status) {
  return status === "committed" || status === "duplicate";
}

function limitRatio(value, max) {
  return max <= 0 ? 1 : value / max;
}

function buildFittingOverflowEntry({ previousGap, droppedEvent, now, sequence, masterKey, maxBytes }) {
  let smallest = null;
  for (const profile of OVERFLOW_GAP_PROFILES) {
    const stored = createStoredEntry(buildOverflowGapEvent(previousGap, droppedEvent, profile), { now, sequence });
    const bytes = encodeStoredEntry(stored, masterKey).length;
    const candidate = { stored, bytes };
    smallest = candidate;
    if (bytes <= maxBytes) return candidate;
  }
  return smallest;
}

function truncateRequired(value, limit) {
  const normalized = typeof value === "string" && value.length > 0 ? value : "x";
  if (!Number.isInteger(limit) || limit < 1) return normalized.slice(0, 1);
  return normalized.length <= limit ? normalized : normalized.slice(0, limit);
}

function truncateOptional(value, limit) {
  if (value === null || value === undefined) return null;
  if (!Number.isInteger(limit) || limit < 1) return null;
  const normalized = typeof value === "string" ? value : `${value}`;
  return normalized.length <= limit ? normalized : normalized.slice(0, limit);
}

function toIsoTimestamp(now) {
  const value = now();
  if (!(value instanceof Date) || Number.isNaN(value.valueOf())) {
    throw new TypeError("now must return a valid Date");
  }
  return value.toISOString();
}
