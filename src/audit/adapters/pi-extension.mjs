import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const EXTENSION_FILENAME = "airkit-pi-audit-extension.mjs";
const EVENTS_FILENAME = "airkit-pi-audit-events.jsonl";
const EVENTS_ENV = "AIRKIT_PI_AUDIT_EVENTS_PATH";
const BRIDGE_SOURCE = "pi-extension";
const BRIDGE_VERSION = "1";

export async function createPiAuditRuntime(options = {}) {
  const {
    auditEmitter = null,
    tempRoot = tmpdir(),
    stderr = process.stderr,
    mkdirImpl = mkdir,
    mkdtempImpl = mkdtemp,
    readFileImpl = readFile,
    rmImpl = rm,
    writeFileImpl = writeFile,
  } = options;
  if (typeof auditEmitter?.emit !== "function") return null;

  try {
    await mkdirImpl(tempRoot, { recursive: true });
    const directory = await mkdtempImpl(join(tempRoot, "airkit-pi-audit-"));
    const extensionPath = join(directory, EXTENSION_FILENAME);
    const eventLogPath = join(directory, EVENTS_FILENAME);
    await writeFileImpl(extensionPath, buildPiAuditExtensionSource(), { mode: 0o600 });
    await writeFileImpl(eventLogPath, "", "utf8");

    let drainedLines = 0;
    return {
      extensionPath,
      env: { [EVENTS_ENV]: eventLogPath },
      eventLogPath,
      async drain() {
        try {
          const raw = await readFileImpl(eventLogPath, "utf8");
          const lines = raw.split("\n").filter(Boolean).slice(drainedLines);
          drainedLines += lines.length;
          for (const line of lines) {
            const record = parsePiAuditRecord(line);
            if (!record) continue;
            await emitPiAuditRecord(auditEmitter, record);
          }
        } catch (error) {
          writeWarning(stderr, `airkit: Pi audit drain skipped (${safeMessage(error)})`);
        }
      },
      async cleanup() {
        await rmImpl(directory, { force: true, recursive: true });
      },
    };
  } catch (error) {
    writeWarning(stderr, `airkit: Pi audit disabled (${safeMessage(error)})`);
    return null;
  }
}

export function buildPiAuditExtensionSource() {
  return `import { appendFileSync } from "node:fs";

const eventsPath = process.env.${EVENTS_ENV};

function writeRecord(record) {
  if (!eventsPath) return;
  try {
    appendFileSync(eventsPath, \`\${JSON.stringify(record)}\\n\`, "utf8");
  } catch {}
}

function usageOf(message) {
  const usage = message && typeof message === "object" ? message.usage : null;
  if (!usage || typeof usage !== "object") return null;
  const normalized = {};
  for (const [source, target] of [
    ["input", "input_tokens"],
    ["output", "output_tokens"],
    ["reasoning", "reasoning_tokens"],
    ["cacheRead", "cache_read_input_tokens"],
    ["cacheWrite", "cache_creation_input_tokens"],
  ]) {
    const value = usage[source];
    if (Number.isFinite(value) && value >= 0) normalized[target] = value;
  }
  return Object.keys(normalized).length === 0 ? null : normalized;
}

function sessionId(ctx) {
  try {
    return ctx?.sessionManager?.getSessionId?.() ?? null;
  } catch {
    return null;
  }
}

export default function airkitPiAuditExtension(pi) {
  pi.on("session_start", (_event, ctx) => {
    writeRecord({ type: "session_start", session_id: sessionId(ctx), hasUI: Boolean(ctx?.hasUI) });
  });
  pi.on("before_agent_start", (event, ctx) => {
    writeRecord({
      type: "before_agent_start",
      session_id: sessionId(ctx),
      prompt_bytes: Buffer.byteLength(event?.prompt ?? "", "utf8"),
    });
  });
  pi.on("turn_start", (event, ctx) => {
    const id = sessionId(ctx);
    writeRecord({ type: "turn_start", session_id: id, turn_id: id ? \`\${id}:\${event?.turnIndex ?? 0}\` : null });
  });
  pi.on("turn_end", (event, ctx) => {
    const id = sessionId(ctx);
    writeRecord({
      type: "turn_end",
      session_id: id,
      turn_id: id ? \`\${id}:\${event?.turnIndex ?? 0}\` : null,
      usage: usageOf(event?.message),
    });
  });
}
`;
}

async function emitPiAuditRecord(auditEmitter, record) {
  if (record.type === "session_start") {
    await auditEmitter.emit("session_context", {
      session_id: stringOrNull(record.session_id),
      payload: {
        phase: "session_start",
        has_ui: Boolean(record.hasUI),
        provenance: { has_ui: "pi.session_start.hasUI" },
      },
    });
    return;
  }
  if (record.type === "before_agent_start") {
    await auditEmitter.emit("session_context", {
      session_id: stringOrNull(record.session_id),
      payload: {
        phase: "before_agent_start",
        prompt_bytes: finiteOrNull(record.prompt_bytes),
        provenance: { prompt_bytes: "pi.before_agent_start.prompt_bytes" },
      },
    });
    return;
  }
  if (record.type === "turn_start") {
    await auditEmitter.emit("session_context", {
      session_id: stringOrNull(record.session_id),
      payload: {
        phase: "turn_start",
        turn_id: stringOrNull(record.turn_id),
        provenance: { turn_id: "pi.turn_start.turn_id" },
      },
    });
    return;
  }
  if (record.type === "turn_end" && isPlainRecord(record.usage)) {
    await auditEmitter.emit("usage_reported", {
      logical_request_id: stringOrNull(record.turn_id) ? `pi:${record.turn_id}` : "pi:turn",
      session_id: stringOrNull(record.session_id),
      payload: {
        usage: sanitizeUsage(record.usage),
        provenance: { usage: "pi.turn_end.usage" },
      },
    });
  }
}

function parsePiAuditRecord(line) {
  try {
    const record = JSON.parse(line);
    return isPlainRecord(record) && typeof record.type === "string" ? record : null;
  } catch {
    return null;
  }
}

function sanitizeUsage(value) {
  const usage = {};
  for (const [key, entry] of Object.entries(value)) {
    const normalized = finiteOrNull(entry);
    if (normalized !== null) usage[key] = normalized;
  }
  return usage;
}

function finiteOrNull(value) {
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function stringOrNull(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function isPlainRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function safeMessage(error) {
  return error instanceof Error ? error.message : "unknown error";
}

function writeWarning(stderr, message) {
  try {
    stderr?.write?.(`${message}\n`);
  } catch {
    // Audit helpers must stay fail-open.
  }
}

export const PI_AUDIT_EXTENSION_SOURCE = BRIDGE_SOURCE;
export const PI_AUDIT_EXTENSION_VERSION = BRIDGE_VERSION;
