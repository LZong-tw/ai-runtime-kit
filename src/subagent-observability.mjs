import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const LIFECYCLE_EVENTS = new Set(["PostToolUse", "SubagentStart", "SubagentStop"]);
const MAX_INPUT_BYTES = 1_000_000;
const MAX_STATE_BYTES = 1_000_000;
const MAX_TRANSCRIPT_READ_BYTES = 256 * 1024;
const MAX_ENTRIES = 200;
const MAX_SEEN = 500;
const MAX_DIAGNOSTICS = 20;
const MAX_TEXT = 2_000;
const MAX_VISIBLE = 160;

export async function processSubagentObservabilityHook(input, env = process.env) {
  if (!isSubagentLifecycleEvent(input) || !validPluginData(env)) return null;
  await observeChildTranscript(input, env);
  return null;
}

export async function renderSubagentStatusLine(input, env = process.env) {
  const rows = [];
  for (const task of Array.isArray(input?.tasks) ? input.tasks : []) {
    rows.push(await renderTaskRow(task, input, env));
  }
  return rows;
}

export async function runSubagentStatusLine({ env = process.env, input = process.stdin, output = process.stdout } = {}) {
  const value = await readJsonInput(input);
  if (!value) return;
  const rows = await renderSubagentStatusLine(value, env);
  for (const [index, content] of rows.entries()) {
    const task = Array.isArray(value.tasks) ? value.tasks[index] : null;
    if (task && typeof task.id === "string" && task.id.length > 0) {
      output.write(`${JSON.stringify({ id: task.id, content })}\n`);
    }
  }
}

function isSubagentLifecycleEvent(input) {
  return LIFECYCLE_EVENTS.has(input?.hook_event_name)
    && typeof input?.session_id === "string" && input.session_id.length > 0
    && typeof input?.transcript_path === "string" && input.transcript_path.length > 0;
}

function validPluginData(env) {
  return typeof env?.CLAUDE_PLUGIN_DATA === "string" && env.CLAUDE_PLUGIN_DATA.length > 0;
}

async function observeChildTranscript(input, env) {
  const parent = identity(input.session_id, "unknown-parent");
  const child = identity(input.agent_id);
  if (!parent || !child) return;
  const directory = join(env.CLAUDE_PLUGIN_DATA, "subagent-timelines", parent.key, child.key);
  const timelinePath = join(directory, "timeline.md");
  const statePath = join(directory, ".state.json");
  let previous = await loadState(statePath, parent, child);
  let transcript;
  try {
    transcript = await open(input.transcript_path, "r");
  } catch {
    previous = addDiagnostic(previous, "diagnostic: child transcript is missing or unreadable");
    await saveProjection(directory, timelinePath, statePath, previous);
    return;
  }

  try {
    const { size } = await transcript.stat();
    if (previous.offset > size) {
      previous = addDiagnostic(emptyState(parent, child), "diagnostic: child transcript was truncated; projection restarted");
    }
    if (previous.offset === size) {
      if (previous.diagnostics.length > 0 && previous.offset === 0) {
        await saveProjection(directory, timelinePath, statePath, previous);
      }
      return;
    }

    const length = Math.min(MAX_TRANSCRIPT_READ_BYTES, size - previous.offset);
    const buffer = Buffer.allocUnsafe(length);
    const { bytesRead } = await transcript.read(buffer, 0, length, previous.offset);
    if (bytesRead === 0) return;
    const next = projectTranscriptChunk(previous, buffer.subarray(0, bytesRead));
    await saveProjection(directory, timelinePath, statePath, next);
  } finally {
    await transcript.close();
  }
}

function projectTranscriptChunk(previous, bytes) {
  let next = { ...previous };
  let records = bytes;
  if (next.discardingOversizeLine) {
    const newline = records.indexOf(10);
    if (newline < 0) return { ...next, offset: next.offset + records.length };
    next = { ...next, offset: next.offset + newline + 1, discardingOversizeLine: false };
    records = records.subarray(newline + 1);
  }

  const completeLength = completeLineLength(records);
  if (completeLength === 0) {
    if (records.length < MAX_TRANSCRIPT_READ_BYTES) return next;
    return addDiagnostic({
      ...next,
      offset: next.offset + records.length,
      discardingOversizeLine: true,
    }, "diagnostic: ignored oversized child transcript record");
  }

  next.offset += completeLength;
  for (const line of records.subarray(0, completeLength).toString("utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      next = addDiagnostic(next, "diagnostic: ignored malformed child transcript record");
      continue;
    }
    if (!record || typeof record !== "object" || Array.isArray(record)) {
      next = addDiagnostic(next, "diagnostic: ignored non-object child transcript record");
      continue;
    }
    const fingerprint = createHash("sha256").update(line).digest("hex");
    if (next.seen.includes(fingerprint)) continue;
    next.seen = [...next.seen, fingerprint].slice(-MAX_SEEN);
    const projections = projectRecord(record);
    if (projections.length > 0) next.entries = [...next.entries, ...projections].slice(-MAX_ENTRIES);
  }
  return next;
}

function completeLineLength(buffer) {
  const lastNewline = buffer.lastIndexOf(10);
  return lastNewline < 0 ? 0 : lastNewline + 1;
}

function projectRecord(record) {
  if (record.type === "assistant") {
    const content = record.message?.content;
    const text = redactSensitive(assistantText(content));
    const tools = Array.isArray(content)
      ? content.filter((block) => block?.type === "tool_use" && typeof block.name === "string")
        .map((block) => boundedMetadata(block.name, 80)).filter(Boolean)
      : [];
    const projections = [];
    if (text) projections.push({ kind: "assistant", text: text.slice(0, MAX_TEXT) });
    if (tools.length > 0) projections.push({ kind: "tool", name: tools.join(", ").slice(0, 200) });
    return projections;
  }
  if (record.type === "user") {
    return toolResults(record.message?.content ?? record.content)
      .map((bytes) => ({ kind: "tool-result", bytes }));
  }
  return [];
}

function assistantText(content) {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content.filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text.trim()).filter(Boolean).join("\n").trim();
}

function toolResults(content) {
  if (!Array.isArray(content)) return [];
  return content.filter((block) => block?.type === "tool_result").map((result) => {
    if (typeof result.content === "string") return Buffer.byteLength(result.content, "utf8");
    if (result.content === undefined || result.content === null) return 0;
    try { return Buffer.byteLength(JSON.stringify(result.content), "utf8"); } catch { return 0; }
  });
}

async function saveProjection(directory, timelinePath, statePath, state) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const bounded = boundState(state);
  const timeline = renderTimeline(bounded);
  await atomicWrite(timelinePath, timeline);
  await atomicWrite(statePath, `${JSON.stringify(bounded)}\n`);
}

function renderTimeline(state) {
  const lines = ["# Subagent timeline", ""];
  for (const entry of state.entries) {
    if (entry.kind === "assistant") lines.push(`- assistant: ${oneLine(redactSensitive(entry.text), MAX_TEXT)}`);
    if (entry.kind === "tool") lines.push(`- tool: ${entry.name}`);
    if (entry.kind === "tool-result") lines.push(`- tool result: ${entry.bytes} bytes`);
  }
  lines.push(...state.diagnostics.map((value) => redactSensitive(value)));
  return `${lines.join("\n")}\n`;
}

async function atomicWrite(path, content) {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, path);
    await chmod(path, 0o600);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function loadState(path, parent, child) {
  try {
    const state = JSON.parse(await readBoundedFile(path, MAX_STATE_BYTES));
    if (!state || state.parentHash !== parent.hash || state.childHash !== child.hash) throw new Error("invalid state");
    return boundState({
      parentHash: parent.hash,
      childHash: child.hash,
      offset: Number.isInteger(state.offset) && state.offset >= 0 ? state.offset : 0,
      discardingOversizeLine: state.discardingOversizeLine === true,
      entries: sanitizeEntries(state.entries),
      seen: Array.isArray(state.seen) ? state.seen.filter((value) => typeof value === "string") : [],
      diagnostics: Array.isArray(state.diagnostics)
        ? state.diagnostics.filter((value) => typeof value === "string").map(redactSensitive)
        : [],
    });
  } catch {
    return emptyState(parent, child);
  }
}

async function renderTaskRow(task, input, env) {
  const parent = identity(input?.parent_id ?? input?.session_id, "unknown-parent");
  const child = identity(taskIdentity(task));
  if (!parent || !child || !validPluginData(env)) return `ambiguous child transcript: ${taskLabel(task)}`;
  const path = join(env.CLAUDE_PLUGIN_DATA, "subagent-timelines", parent.key, child.key, ".state.json");
  const state = await loadState(path, parent, child);
  if (state.entries.length === 0) {
    return [child.label, "waiting for first event", ...taskMetadata(task)].join(" | ");
  }
  const latestText = [...state.entries].reverse().find((entry) => entry.kind === "assistant")?.text;
  const latestTool = [...state.entries].reverse().find((entry) => entry.kind === "tool")?.name;
  const parts = [child.label, oneLine(redactSensitive(latestText || "waiting for first event"))];
  if (latestTool) parts.push(`tool: ${latestTool}`);
  return [...parts, ...taskMetadata(task)].join(" | ");
}

function taskMetadata(task) {
  const parts = [];
  if (task.elapsed_ms !== undefined) parts.push(`${boundedMetadata(task.elapsed_ms)}ms`);
  if (task.elapsed !== undefined) parts.push(boundedMetadata(task.elapsed));
  const tokenCount = task.tokenCount ?? task.output_tokens;
  if (tokenCount !== undefined) parts.push(`${boundedMetadata(tokenCount)} tokens`);
  if (task.input_tokens !== undefined) parts.push(`${boundedMetadata(task.input_tokens)} input tokens`);
  return parts;
}

function taskIdentity(task) {
  const explicit = ["agent_id", "child_id", "child_name"]
    .map((key) => typeof task?.[key] === "string" ? task[key] : "")
    .filter((value) => value.trim().length > 0);
  if (explicit.length > 0) return new Set(explicit).size === 1 ? explicit[0] : null;
  const nativeId = ["id", "task_id", "taskId"]
    .map((key) => typeof task?.[key] === "string" ? task[key] : "")
    .find((value) => value.trim().length > 0);
  return nativeId || null;
}

function taskLabel(task) { return boundedMetadata(typeof task?.name === "string" ? task.name : "task", 80); }

function oneLine(value, limit = MAX_VISIBLE) {
  const normalized = String(value).replaceAll(/[\r\n\t]+/g, " ").replaceAll(/\s+/g, " ").trim();
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit - 1)}…`;
}

async function readJsonInput(input) {
  if (input && typeof input === "object" && !input[Symbol.asyncIterator] && !input[Symbol.iterator]) return input;
  let raw = "";
  try {
    for await (const chunk of input) {
      raw += chunk;
      if (Buffer.byteLength(raw, "utf8") > MAX_INPUT_BYTES) return null;
    }
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function safeId(value, fallback) {
  if (typeof value !== "string") return fallback;
  const safe = value.trim().replaceAll(/[^A-Za-z0-9._-]+/g, "_").replaceAll(/^\.+|\.+$/g, "").slice(0, 80);
  return safe || fallback;
}

function identity(value, fallback = "") {
  const raw = typeof value === "string" && value.length > 0 ? value : fallback;
  const label = safeId(raw, "");
  if (!label) return null;
  const hash = createHash("sha256").update(raw).digest("hex");
  return { hash, key: `${label.slice(0, 48)}--${hash}`, label };
}

function emptyState(parent, child) {
  return {
    parentHash: parent.hash,
    childHash: child.hash,
    offset: 0,
    discardingOversizeLine: false,
    entries: [],
    seen: [],
    diagnostics: [],
  };
}

function addDiagnostic(state, diagnostic) {
  if (state.diagnostics.at(-1) === diagnostic) return state;
  return { ...state, diagnostics: [...state.diagnostics, diagnostic].slice(-MAX_DIAGNOSTICS) };
}

function boundState(state) {
  return {
    ...state,
    entries: sanitizeEntries(state.entries).slice(-MAX_ENTRIES),
    seen: Array.isArray(state.seen) ? state.seen.slice(-MAX_SEEN) : [],
    diagnostics: Array.isArray(state.diagnostics)
      ? state.diagnostics.map((value) => redactSensitive(value)).slice(-MAX_DIAGNOSTICS)
      : [],
  };
}

function sanitizeEntries(entries) {
  if (!Array.isArray(entries)) return [];
  const sanitized = [];
  for (const entry of entries.slice(-MAX_ENTRIES)) {
    if (entry?.kind === "assistant" && typeof entry.text === "string") {
      sanitized.push({ kind: "assistant", text: redactSensitive(entry.text).slice(0, MAX_TEXT) });
    }
    if (entry?.kind === "tool" && typeof entry.name === "string") {
      sanitized.push({ kind: "tool", name: boundedMetadata(entry.name, 200) });
    }
    if (entry?.kind === "tool-result" && Number.isSafeInteger(entry.bytes) && entry.bytes >= 0) {
      sanitized.push({ kind: "tool-result", bytes: entry.bytes });
    }
  }
  return sanitized;
}

function redactSensitive(value) {
  return String(value)
    .replaceAll(/[\u0000-\u001f\u007f]+/g, " ")
    .replaceAll(
      /\b((?:[A-Z][A-Z0-9_]*(?:TOKEN|KEY|SECRET|PASSWORD))|api[_-]?key|token|password|secret|endpoint|api[_-]?base[_-]?url)(\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s;,]+)/gi,
      "$1$2[redacted]",
    )
    .replaceAll(/\bAuthorization\s*[:=]\s*[^\s;,]+(?:\s+[^\s;,]+)?/gi, "Authorization: [redacted]")
    .replaceAll(/\bBearer\s+[^\s;,]+/gi, "Bearer [redacted]")
    .replaceAll(/\b(?:sk-|ghp_|xox[baprs]-)[A-Za-z0-9_-]{8,}/gi, "[redacted]")
    .replaceAll(/https?:\/\/[^\s;,]+/gi, "[redacted-url]")
    .replaceAll(/\s+/g, " ")
    .trim();
}

function boundedMetadata(value, limit = 32) {
  return oneLine(redactSensitive(value), limit);
}

async function readBoundedFile(path, limit) {
  const file = await open(path, "r");
  try {
    const { size } = await file.stat();
    if (size > limit) throw new Error("file exceeds bound");
    const buffer = Buffer.allocUnsafe(size);
    const { bytesRead } = await file.read(buffer, 0, size, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await file.close();
  }
}
