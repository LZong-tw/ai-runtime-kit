import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const LIFECYCLE_EVENTS = new Set(["PostToolUse", "SubagentStart", "SubagentStop"]);
const MAX_INPUT_BYTES = 1_000_000;
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
  const parentId = safeId(input.session_id, "unknown-parent");
  const childId = safeId(input.agent_id, "");
  if (!childId) return;
  const directory = join(env.CLAUDE_PLUGIN_DATA, "subagent-timelines", parentId, childId);
  const timelinePath = join(directory, "timeline.md");
  const statePath = join(directory, ".state.json");
  const previous = await loadState(statePath, parentId, childId);
  let bytes;
  try {
    bytes = await readFile(input.transcript_path);
  } catch {
    await saveProjection(directory, timelinePath, statePath, {
      ...previous,
      diagnostics: [...previous.diagnostics, "diagnostic: child transcript is missing or unreadable"].slice(-20),
    });
    return;
  }

  const offset = previous.offset <= bytes.length ? previous.offset : 0;
  const records = bytes.subarray(offset);
  const completeLength = completeLineLength(records);
  const complete = records.subarray(0, completeLength);
  const next = { ...previous, offset: offset + completeLength };
  for (const line of complete.toString("utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      next.diagnostics = [...next.diagnostics, "diagnostic: ignored malformed child transcript record"].slice(-20);
      continue;
    }
    if (!record || typeof record !== "object" || Array.isArray(record)) {
      next.diagnostics = [...next.diagnostics, "diagnostic: ignored non-object child transcript record"].slice(-20);
      continue;
    }
    const fingerprint = createHash("sha256").update(line).digest("hex");
    if (next.seen.includes(fingerprint)) continue;
    next.seen = [...next.seen, fingerprint].slice(-500);
    const projections = projectRecord(record);
    if (projections.length > 0) next.entries.push(...projections);
  }
  await saveProjection(directory, timelinePath, statePath, next);
}

function completeLineLength(buffer) {
  const lastNewline = buffer.lastIndexOf(10);
  return lastNewline < 0 ? 0 : lastNewline + 1;
}

function projectRecord(record) {
  if (record.type === "assistant") {
    const content = record.message?.content;
    const text = assistantText(content);
    const tools = Array.isArray(content)
      ? content.filter((block) => block?.type === "tool_use" && typeof block.name === "string")
        .map((block) => block.name.trim()).filter(Boolean)
      : [];
    const projections = [];
    if (text) projections.push({ kind: "assistant", text: text.slice(0, MAX_TEXT) });
    if (tools.length > 0) projections.push({ kind: "tool", name: tools.join(", ").slice(0, 200) });
    return projections;
  }
  if (record.type === "user") {
    const result = toolResult(record.message?.content ?? record.content);
    if (result !== null) return [{ kind: "tool-result", bytes: Buffer.byteLength(result, "utf8") }];
  }
  return [];
}

function assistantText(content) {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content.filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text.trim()).filter(Boolean).join("\n").trim();
}

function toolResult(content) {
  if (!Array.isArray(content)) return null;
  const result = content.find((block) => block?.type === "tool_result");
  if (!result) return null;
  if (typeof result.content === "string") return result.content;
  if (result.content === undefined || result.content === null) return "";
  try { return JSON.stringify(result.content); } catch { return ""; }
}

async function saveProjection(directory, timelinePath, statePath, state) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const timeline = renderTimeline(state);
  await atomicWrite(timelinePath, timeline);
  await atomicWrite(statePath, `${JSON.stringify(state)}\n`);
}

function renderTimeline(state) {
  const lines = ["# Subagent timeline", ""];
  for (const entry of state.entries) {
    if (entry.kind === "assistant") lines.push(`- assistant: ${entry.text.replaceAll(/\s+/g, " ")}`);
    if (entry.kind === "tool") lines.push(`- tool: ${entry.name}`);
    if (entry.kind === "tool-result") lines.push(`- tool result: ${entry.bytes} bytes`);
  }
  lines.push(...state.diagnostics);
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

async function loadState(path, parentId, childId) {
  try {
    const state = JSON.parse(await readFile(path, "utf8"));
    if (!state || state.parentId !== parentId || state.childId !== childId) throw new Error("invalid state");
    return {
      parentId, childId,
      offset: Number.isInteger(state.offset) && state.offset >= 0 ? state.offset : 0,
      entries: Array.isArray(state.entries) ? state.entries : [],
      seen: Array.isArray(state.seen) ? state.seen.filter((value) => typeof value === "string") : [],
      diagnostics: Array.isArray(state.diagnostics) ? state.diagnostics.filter((value) => typeof value === "string") : [],
    };
  } catch {
    return { parentId, childId, offset: 0, entries: [], seen: [], diagnostics: [] };
  }
}

async function renderTaskRow(task, input, env) {
  const parentId = safeId(input?.parent_id ?? input?.session_id, "unknown-parent");
  const identity = taskIdentity(task);
  if (!identity || !validPluginData(env)) return `ambiguous child transcript: ${taskLabel(task)}`;
  const childId = safeId(identity, "");
  if (!childId) return `ambiguous child transcript: ${taskLabel(task)}`;
  const path = join(env.CLAUDE_PLUGIN_DATA, "subagent-timelines", parentId, childId, ".state.json");
  const state = await loadState(path, parentId, childId);
  if (state.entries.length === 0) return `${childId}: waiting for first event`;
  const latestText = [...state.entries].reverse().find((entry) => entry.kind === "assistant")?.text;
  const latestTool = [...state.entries].reverse().find((entry) => entry.kind === "tool")?.name;
  const parts = [childId, latestText || "waiting for first event"];
  if (latestTool) parts.push(`tool: ${latestTool}`);
  if (task.elapsed_ms !== undefined) parts.push(`${task.elapsed_ms}ms`);
  if (task.elapsed !== undefined) parts.push(`${task.elapsed}`);
  if (task.output_tokens !== undefined) parts.push(`${task.output_tokens} tokens`);
  if (task.input_tokens !== undefined) parts.push(`${task.input_tokens} input tokens`);
  return oneLine(parts.join(" | "));
}

function taskIdentity(task) {
  const candidates = ["agent_id", "child_id", "child_name", "name"]
    .map((key) => typeof task?.[key] === "string" ? task[key].trim() : "")
    .filter(Boolean);
  return candidates.length > 0 && new Set(candidates).size === 1 ? candidates[0] : null;
}

function taskLabel(task) { return typeof task?.name === "string" ? task.name : "task"; }

function oneLine(value) {
  const normalized = value.replaceAll(/[\r\n\t]+/g, " ").replaceAll(/\s+/g, " ").trim();
  return normalized.length <= MAX_VISIBLE ? normalized : `${normalized.slice(0, MAX_VISIBLE - 1)}…`;
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
