import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, open, readdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

const LIFECYCLE_EVENTS = new Set(["PostToolUse", "SubagentStart", "SubagentStop"]);
const MAX_INPUT_BYTES = 1_000_000;
const MAX_STATE_BYTES = 1_000_000;
const MAX_TRANSCRIPT_READ_BYTES = 256 * 1024;
const MAX_PARENT_TRANSCRIPT_READ_BYTES = 2 * 1024 * 1024;
const MAX_PARENT_TRANSCRIPT_HEAD_BYTES = 512 * 1024;
const MAX_ENTRIES = 200;
const MAX_SEEN = 500;
const MAX_DIAGNOSTICS = 20;
const MAX_TEXT = 2_000;
const MAX_VISIBLE = 160;

export async function processSubagentObservabilityHook(input, env = process.env) {
  if (!isSubagentLifecycleEvent(input) || !validPluginData(env)) return null;
  const transcriptPath = transcriptPathValue(input);
  if (transcriptPath) await observeChildTranscript({ ...input, transcript_path: transcriptPath }, env);
  else await persistPendingChildState(input, env);
  return null;
}

export async function renderSubagentStatusLine(input, env = process.env) {
  await hydrateTaskStates(input, env);
  const parentAgentStates = await readParentAgentStates(transcriptPathValue(input));
  const rows = [];
  for (const task of Array.isArray(input?.tasks) ? input.tasks : []) {
    rows.push(await renderTaskRow(task, input, env, parentAgentStates));
  }
  return rows;
}

async function hydrateTaskStates(input, env) {
  if (!validPluginData(env)) return;
  const parentValue = statuslineParentValue(input);
  const transcriptPath = transcriptPathValue(input);
  if (!parentValue || typeof transcriptPath !== "string" || transcriptPath.length === 0) return;
  const sessionDirectory = join(dirname(transcriptPath), basename(transcriptPath, ".jsonl"), "subagents");
  let children;
  try {
    children = await readdir(sessionDirectory, { withFileTypes: true });
  } catch {
    return;
  }
  const tasks = Array.isArray(input?.tasks) ? input.tasks : [];
  for (const task of tasks) {
    const labels = taskLabelCandidates(task);
    if (labels.length === 0) continue;
    const parent = identity(parentValue);
    const childEntries = children.filter((entry) => entry.isFile()
      && entry.name.startsWith("agent-") && entry.name.endsWith(".jsonl"));
    const existing = parent
      ? await findParentChildStates(env.CLAUDE_PLUGIN_DATA, parent, taskIdentityCandidates(task), labels)
      : [];
    const candidates = [];
    for (const entry of childEntries) {
      const childLabels = await childTranscriptLabels(join(sessionDirectory, entry.name));
      if (labels.some((label) => childLabels.includes(label))) candidates.push({ entry, childLabels });
    }
    if (candidates.length !== 1 && existing.length === 1) {
      const stored = existing[0].child;
      const byIdentity = childEntries.filter((entry) => {
        const childId = entry.name.slice("agent-".length, -".jsonl".length);
        return childId === stored.label || childId.startsWith(`${stored.label}--`);
      });
      if (byIdentity.length === 1) candidates.splice(0, candidates.length, { entry: byIdentity[0], childLabels: [] });
      else if (candidates.length === 0 && childEntries.length === 1) {
        candidates.push({ entry: childEntries[0], childLabels: [] });
      }
    }
    if (candidates.length !== 1) continue;
    const childId = candidates[0].entry.name.slice("agent-".length, -".jsonl".length);
    if (!/^[A-Za-z0-9._-]+$/.test(childId)) continue;
    try {
      await observeChildTranscript({
        hook_event_name: "SubagentStart",
        session_id: parentValue,
        agent_id: childId,
        agent_type: labels[0],
        transcript_path: join(sessionDirectory, candidates[0].entry.name),
      }, env);
    } catch {
      // Statusline rendering must remain fail-open if hydration cannot persist.
    }
  }
}

async function childTranscriptLabels(path) {
  const labels = new Set(await childMetadataLabels(path));
  try {
    const prefix = await readFilePrefix(path, 64 * 1024);
    for (const line of prefix.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try { collectAgentLabels(JSON.parse(line), labels); } catch { /* ignore malformed prefix records */ }
      if (labels.size >= 8) break;
    }
    return [...labels];
  } catch {
    return [];
  }
}

async function childMetadataLabels(transcriptPath) {
  const metadataPath = transcriptPath.endsWith(".jsonl")
    ? `${transcriptPath.slice(0, -".jsonl".length)}.meta.json`
    : "";
  if (!metadataPath) return [];
  try {
    const metadata = JSON.parse(await readBoundedFile(metadataPath, 64 * 1024));
    return [...new Set([metadata?.name, metadata?.description]
      .filter((value) => typeof value === "string" && value.trim().length > 0)
      .map((value) => boundedMetadata(value, 120)))];
  } catch {
    return [];
  }
}

// A statusline suffix may only ever be a per-lane Shield protection enum. The
// sink enforces the whole shape so no caller can widen it into a channel for a
// token, cost, capability, path, origin or request body.
const STATUSLINE_SUFFIX = /^ \u00b7 Shield(?: (?:subscription|managed):(?:protected|blocked|unavailable)){2}$/;

function collectAgentLabels(value, labels, depth = 0) {
  if (!value || typeof value !== "object" || depth > 6 || labels.size >= 8) return;
  if (Array.isArray(value)) {
    for (const item of value) collectAgentLabels(item, labels, depth + 1);
    return;
  }
  if (value.type === "tool_use" && value.name === "Agent" && value.input && typeof value.input === "object") {
    for (const key of ["name", "agent_name", "agentName", "description"]) {
      if (typeof value.input[key] === "string" && value.input[key].trim().length > 0) {
        labels.add(boundedMetadata(value.input[key], 120));
      }
    }
  }
  for (const child of Object.values(value)) collectAgentLabels(child, labels, depth + 1);
}

export async function runSubagentStatusLine({ env = process.env, input = process.stdin, output = process.stdout, statuslineSuffix = "" } = {}) {
  const value = await readJsonInput(input);
  if (!value) return;
  const rows = await renderSubagentStatusLine(value, env);
  const suffix = typeof statuslineSuffix === "string" && STATUSLINE_SUFFIX.test(statuslineSuffix) ? statuslineSuffix : "";
  for (const [index, content] of rows.entries()) {
    const task = Array.isArray(value.tasks) ? value.tasks[index] : null;
    if (task && typeof task.id === "string" && task.id.length > 0) {
      output.write(`${JSON.stringify({ id: task.id, content: `${content}${suffix}` })}\n`);
    }
  }
}

function isSubagentLifecycleEvent(input) {
  return LIFECYCLE_EVENTS.has(input?.hook_event_name)
    && typeof input?.session_id === "string" && input.session_id.length > 0
    && typeof input?.agent_id === "string" && input.agent_id.length > 0;
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
  const labels = taskLabelsFromHook(input);
  const labeled = mergeStateLabels(previous, labels);
  const labelsChanged = labeled.labels.length !== previous.labels.length
    || labeled.labels.some((value, index) => value !== previous.labels[index]);
  previous = labeled;
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
      previous = addDiagnostic(emptyState(parent, child, labels), "diagnostic: child transcript was truncated; projection restarted");
    }
    if (previous.offset === size) {
      if (labelsChanged || (previous.diagnostics.length > 0 && previous.offset === 0)) {
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

async function persistPendingChildState(input, env) {
  const parent = identity(input.session_id, "unknown-parent");
  const child = identity(input.agent_id);
  if (!parent || !child) return;
  const directory = join(env.CLAUDE_PLUGIN_DATA, "subagent-timelines", parent.key, child.key);
  const timelinePath = join(directory, "timeline.md");
  const statePath = join(directory, ".state.json");
  const previous = await loadState(statePath, parent, child);
  const next = mergeStateLabels(previous, taskLabelsFromHook(input));
  await saveProjection(directory, timelinePath, statePath, next);
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
      labels: sanitizeLabels(state.labels),
    });
  } catch {
    return emptyState(parent, child);
  }
}

async function renderTaskRow(task, input, env, parentAgentStates = new Map()) {
  const parentValue = statuslineParentValue(input);
  const parent = typeof parentValue === "string" && parentValue.length > 0 ? identity(parentValue) : null;
  const childValues = taskIdentityCandidates(task);
  const labels = taskLabelCandidates(task);
  if (!validPluginData(env)) return waitingTaskRow(task, taskLabel(task), env);
  if (explicitTaskIdentities(task).length > 1) return ambiguousTaskRow(task);

  const matches = parent
    ? await findParentChildStates(env.CLAUDE_PLUGIN_DATA, parent, childValues, labels)
    : await findChildStates(env.CLAUDE_PLUGIN_DATA, childValues, labels);
  if (matches.length > 1) return ambiguousTaskRow(task);

  let child;
  let state;
  if (matches.length === 1) {
    ({ child, state } = matches[0]);
  } else {
    const fallback = childValues[0] ?? labels[0] ?? taskLabel(task);
    child = identity(fallback, "task");
    state = emptyState(parent ?? { hash: "unknown-parent" }, child);
  }

  const model = taskModel(task, input, env);
  const parentState = matches.length === 0 ? parentAgentStateForTask(task, parentAgentStates) : null;
  if (state.entries.length === 0) {
    const statusText = parentState?.text ?? "waiting for first event";
    const status = parentState?.status ?? task.status;
    return [taskDisplayLabel(task, child), ...(model ? [`model: ${model}`] : []), statusText, ...taskMetadata(task, status)].join(" | ");
  }
  const latestText = [...state.entries].reverse().find((entry) => entry.kind === "assistant")?.text;
  const latestTool = [...state.entries].reverse().find((entry) => entry.kind === "tool")?.name;
  const parts = [taskDisplayLabel(task, child), ...(model ? [`model: ${model}`] : []), oneLine(redactSensitive(latestText || "waiting for first event"))];
  if (latestTool) parts.push(`tool: ${latestTool}`);
  return [...parts, ...taskMetadata(task)].join(" | ");
}

async function readParentAgentStates(transcriptPath) {
  if (typeof transcriptPath !== "string" || transcriptPath.length === 0) return new Map();
  let content;
  try {
    content = await readParentTranscript(transcriptPath);
  } catch {
    return new Map();
  }

  const states = new Map();
  const calls = new Map();
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    if (record?.type === "assistant") {
      const blocks = Array.isArray(record.message?.content) ? record.message.content : [];
      for (const block of blocks) {
        if (block?.type !== "tool_use" || block.name !== "Agent" || typeof block.id !== "string") continue;
        const keys = agentCallLabels(block.input);
        if (keys.length === 0) continue;
        const state = { keys, status: "initializing", text: "initializing: waiting for Agent launch authorization" };
        calls.set(block.id, state);
        for (const key of keys) states.set(key, state);
      }
      continue;
    }
    if (record?.type !== "user") continue;
    const blocks = Array.isArray(record.message?.content) ? record.message.content : [];
    for (const result of blocks) {
      if (result?.type !== "tool_result" || typeof result.tool_use_id !== "string") continue;
      const state = calls.get(result.tool_use_id);
      if (!state) continue;
      const text = toolResultText(result.content);
      if (result.is_error === true && /automode-unavailable|cannot determine the safety/i.test(text)) {
        state.status = "launch-denied";
        state.text = "launch denied: auto mode safety check unavailable";
      } else if (result.is_error === true) {
        state.status = "launch-failed";
        state.text = "launch failed: Agent tool error";
      } else if (/async agent launched successfully/i.test(text)) {
        state.status = "running";
        state.text = "running: waiting for child event";
      }
      for (const key of state.keys) states.set(key, state);
    }
  }
  return states;
}

function agentCallLabels(input) {
  return [...new Set([input?.name, input?.agent_name, input?.agentName, input?.description]
    .filter((value) => typeof value === "string" && value.trim().length > 0)
    .map((value) => value.trim()))];
}

function parentAgentStateForTask(task, states) {
  for (const key of [...taskIdentityCandidates(task), ...taskLabelCandidates(task)]) {
    const state = states.get(key);
    if (state) return state;
  }
  return null;
}

function toolResultText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((block) => {
    if (typeof block === "string") return block;
    return typeof block?.text === "string" ? block.text : "";
  }).filter(Boolean).join(" ");
}

async function findParentChildStates(pluginData, parent, values, labels) {
  const root = join(pluginData, "subagent-timelines", parent.key);
  const identityMatches = [];
  const labelMatches = [];
  const seen = new Set();
  try {
    const children = await readdir(root, { withFileTypes: true });
    for (const childEntry of children) {
      if (!childEntry.isDirectory()) continue;
      const statePath = join(root, childEntry.name, ".state.json");
      const state = await loadStateWithoutParent(statePath);
      if (!state || state.parentHash !== parent.hash) continue;
      const child = storedIdentity(childEntry.name, state.childHash);
      const identityMatch = values.some((value) => identity(value)?.key === childEntry.name);
      if (identityMatch && !seen.has(childEntry.name)) {
        seen.add(childEntry.name);
        identityMatches.push({ child, state });
      } else if (labelsOverlap(state.labels, labels) && !seen.has(childEntry.name)) {
        seen.add(childEntry.name);
        labelMatches.push({ child, state });
      }
    }
  } catch {
    return [];
  }
  return identityMatches.length > 0 ? identityMatches : labelMatches;
}

async function findChildStates(pluginData, values, labels) {
  const root = join(pluginData, "subagent-timelines");
  const identityMatches = [];
  const labelMatches = [];
  const seen = new Set();
  try {
    const parents = await readdir(root, { withFileTypes: true });
    for (const parentEntry of parents) {
      if (!parentEntry.isDirectory()) continue;
      const parentPath = join(root, parentEntry.name);
      const children = await readdir(parentPath, { withFileTypes: true });
      for (const childEntry of children) {
        if (!childEntry.isDirectory()) continue;
        const statePath = join(parentPath, childEntry.name, ".state.json");
        const state = await loadStateWithoutParent(statePath);
        if (!state) continue;
        const child = storedIdentity(childEntry.name, state.childHash);
        const identityMatch = values.some((value) => identity(value)?.key === childEntry.name);
        if (identityMatch && !seen.has(`${parentEntry.name}/${childEntry.name}`)) {
          seen.add(`${parentEntry.name}/${childEntry.name}`);
          identityMatches.push({ child, state });
        } else if (labelsOverlap(state.labels, labels) && !seen.has(`${parentEntry.name}/${childEntry.name}`)) {
          seen.add(`${parentEntry.name}/${childEntry.name}`);
          labelMatches.push({ child, state });
        }
      }
    }
  } catch {
    return [];
  }
  return identityMatches.length > 0 ? identityMatches : labelMatches;
}

async function loadStateWithoutParent(path, child = null) {
  try {
    const state = JSON.parse(await readBoundedFile(path, MAX_STATE_BYTES));
    if (!state || typeof state.childHash !== "string" || (child && state.childHash !== child.hash)) return null;
    return boundState({
      parentHash: typeof state.parentHash === "string" ? state.parentHash : "unknown-parent",
      childHash: state.childHash,
      offset: Number.isInteger(state.offset) && state.offset >= 0 ? state.offset : 0,
      discardingOversizeLine: state.discardingOversizeLine === true,
      entries: sanitizeEntries(state.entries),
      seen: Array.isArray(state.seen) ? state.seen.filter((value) => typeof value === "string") : [],
      diagnostics: Array.isArray(state.diagnostics)
        ? state.diagnostics.filter((value) => typeof value === "string").map(redactSensitive)
        : [],
      labels: sanitizeLabels(state.labels),
    });
  } catch {
    return null;
  }
}

function taskMetadata(task, statusOverride = "") {
  const parts = [];
  const status = statusOverride || task.status;
  if (typeof status === "string" && status.trim().length > 0) parts.push(`status: ${boundedMetadata(status, 32)}`);
  if (task.elapsed_ms !== undefined) parts.push(`${boundedMetadata(task.elapsed_ms)}ms`);
  if (task.elapsed !== undefined) parts.push(boundedMetadata(task.elapsed));
  const tokenCount = task.tokenCount ?? task.output_tokens;
  if (tokenCount !== undefined) parts.push(`${boundedMetadata(tokenCount)} tokens`);
  if (task.input_tokens !== undefined) parts.push(`${boundedMetadata(task.input_tokens)} input tokens`);
  return parts;
}

function taskIdentityCandidates(task) {
  const explicit = explicitTaskIdentities(task);
  const nativeId = nativeTaskIdentity(task);
  return [...new Set([nativeId, ...explicit].filter(Boolean))];
}

function explicitTaskIdentities(task) {
  return [...new Set(["agent_id", "agentId", "child_id", "childId", "child_name", "childName"]
    .map((key) => typeof task?.[key] === "string" ? task[key] : "")
    .filter((value) => value.trim().length > 0))];
}

function nativeTaskIdentity(task) {
  return ["id", "task_id", "taskId"]
    .map((key) => typeof task?.[key] === "string" ? task[key] : "")
    .find((value) => value.trim().length > 0) ?? "";
}

function taskLabelCandidates(task) {
  return [...new Set([task?.name, task?.label, task?.description]
    .filter((value) => typeof value === "string" && value.trim().length > 0)
    .map((value) => value.trim()))];
}

function taskLabelsFromHook(input) {
  return [...new Set([
    input?.agent_type,
    input?.agentType,
    input?.agent_name,
    input?.agentName,
  ].filter((value) => typeof value === "string" && value.trim().length > 0)
    .map((value) => boundedMetadata(value, 120)))];
}

function sanitizeLabels(labels) {
  return [...new Set((Array.isArray(labels) ? labels : [])
    .filter((value) => typeof value === "string" && value.trim().length > 0)
    .map((value) => boundedMetadata(value, 120)))].slice(-8);
}

function mergeStateLabels(state, labels) {
  const merged = sanitizeLabels([...(state.labels ?? []), ...labels]);
  return { ...state, labels: merged };
}

function labelsOverlap(left, right) {
  const candidates = new Set(sanitizeLabels(right));
  return sanitizeLabels(left).some((value) => candidates.has(value));
}

function storedIdentity(key, hash) {
  const label = typeof key === "string" ? key.split("--")[0] || "task" : "task";
  return { hash, key, label };
}

function waitingTaskRow(task, label, env) {
  const model = taskModel(task, {}, env);
  return [label || taskLabel(task), ...(model ? [`model: ${model}`] : []), "waiting for first event", ...taskMetadata(task)].join(" | ");
}

function ambiguousTaskRow(task) {
  return [taskLabel(task), "ambiguous child transcript", ...taskMetadata(task)].join(" | ");
}

function taskModel(task, input, env) {
  const explicitRoute = firstString([
    task?.actual_route,
    task?.actualRoute,
    task?.selected_route,
    task?.selectedRoute,
    task?.route,
    task?.provider_model,
    task?.providerModel,
    input?.actual_route,
    input?.actualRoute,
    input?.selected_route,
    input?.selectedRoute,
    input?.route,
  ]);
  const explicitOpaqueRoute = decodeOpaqueClaudeRoute(explicitRoute);
  if (explicitOpaqueRoute) return routeLabel(explicitOpaqueRoute);
  if (isProviderQualifiedRoute(explicitRoute) && !isOpaqueClaudeModel(explicitRoute)) return routeLabel(explicitRoute);

  const value = task?.model ?? task?.model_name ?? task?.modelName ?? task?.agent_model ?? task?.agentModel;
  const nativeModel = modelString(value);
  const nativeOpaqueRoute = decodeOpaqueClaudeRoute(nativeModel);
  if (nativeOpaqueRoute) return routeLabel(nativeOpaqueRoute);
  if (isProviderQualifiedRoute(nativeModel) && !isOpaqueClaudeModel(nativeModel)) return routeLabel(nativeModel);
  const routeKey = nativeModel && nativeClaudeRouteKey(nativeModel);
  const route = routeKey
    ? env?.[`AIRCLAUDE_ROUTE_${routeKey}`] ?? env?.AIRCLAUDE_ROUTE_DEFAULT
    : isOpaqueClaudeModel(nativeModel)
      ? env?.AIRCLAUDE_ROUTE_DEFAULT
      : null;
  if (isProviderQualifiedRoute(route)) return routeLabel(route);
  if (typeof value === "string" && !isOpaqueClaudeModel(value)) return boundedMetadata(value, 100);
  if (value && typeof value === "object") {
    for (const key of ["display_name", "displayName", "name", "id"]) {
      if (typeof value[key] === "string" && value[key].trim().length > 0) return boundedMetadata(value[key], 100);
    }
  }
  return "";
}

function firstString(values) {
  return values.find((value) => typeof value === "string" && value.trim().length > 0) ?? "";
}

function modelString(value) {
  if (typeof value === "string" && value.trim().length > 0) return value.trim();
  if (value && typeof value === "object") {
    return firstString([value.display_name, value.displayName, value.name, value.id]);
  }
  return "";
}

function nativeClaudeRouteKey(model) {
  const normalized = model.toLowerCase();
  if (normalized.includes("opus")) return "OPUS";
  if (normalized.includes("sonnet")) return "SONNET";
  if (normalized.includes("haiku")) return "BACKGROUND";
  return "";
}

function isProviderQualifiedRoute(value) {
  return typeof value === "string" && /^[^,/\s]+[,/][^,/\s]+$/.test(value.trim());
}

function isOpaqueClaudeModel(value) {
  return typeof value === "string" && /(?:^|[\/,])claude-ccr-[^,\s/]+$/i.test(value.trim());
}

function decodeOpaqueClaudeRoute(value) {
  if (typeof value !== "string") return "";
  const match = value.trim().match(/(?:^|[\/,])claude-ccr-h([0-9a-f]+)(?:\[1m\])?$/i);
  if (!match || match[1].length % 2 !== 0 || match[1].length > 1024) return "";
  try {
    const decoded = Buffer.from(match[1], "hex").toString("utf8");
    return isProviderQualifiedRoute(decoded) ? decoded : "";
  } catch {
    return "";
  }
}

function routeLabel(value) {
  const trimmed = value.trim();
  const separator = trimmed.includes("/") ? "/" : ",";
  const index = trimmed.indexOf(separator);
  return boundedMetadata(`${trimmed.slice(0, index)}/${trimmed.slice(index + 1)}`, 120);
}

function taskLabel(task) {
  return boundedMetadata(
    typeof task?.name === "string" ? task.name : typeof task?.description === "string" ? task.description : "task",
    80,
  );
}

function taskDisplayLabel(task, child) {
  return taskLabelCandidates(task)[0] ?? child?.label ?? "task";
}

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

function emptyState(parent, child, labels = []) {
  return {
    parentHash: parent.hash,
    childHash: child.hash,
    offset: 0,
    discardingOversizeLine: false,
    entries: [],
    seen: [],
    diagnostics: [],
    labels: sanitizeLabels(labels),
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
    labels: sanitizeLabels(state.labels),
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

async function readFileTail(path, limit) {
  const file = await open(path, "r");
  try {
    const { size } = await file.stat();
    const start = Math.max(0, size - limit);
    const buffer = Buffer.allocUnsafe(size - start);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, start);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await file.close();
  }
}

function statuslineParentValue(input) {
  const explicit = input?.parent_id ?? input?.session_id;
  if (typeof explicit === "string" && explicit.length > 0) return explicit;
  const transcriptPath = transcriptPathValue(input);
  if (!transcriptPath) return "";
  const name = basename(transcriptPath, ".jsonl");
  return name.length > 0 ? name : "";
}

function transcriptPathValue(input) {
  return firstString([
    input?.transcript_path,
    input?.transcriptPath,
    input?.agent_transcript_path,
    input?.agentTranscriptPath,
  ]);
}

async function readParentTranscript(path) {
  const file = await open(path, "r");
  try {
    const { size } = await file.stat();
    if (size <= MAX_PARENT_TRANSCRIPT_READ_BYTES) {
      const buffer = Buffer.allocUnsafe(size);
      const { bytesRead } = await file.read(buffer, 0, size, 0);
      return buffer.subarray(0, bytesRead).toString("utf8");
    }
  } finally {
    await file.close();
  }
  const head = await readFilePrefix(path, MAX_PARENT_TRANSCRIPT_HEAD_BYTES);
  const tail = await readFileTail(path, MAX_PARENT_TRANSCRIPT_READ_BYTES - MAX_PARENT_TRANSCRIPT_HEAD_BYTES);
  return `${head}\n${tail}`;
}

async function readFilePrefix(path, limit) {
  const file = await open(path, "r");
  try {
    const { size } = await file.stat();
    const buffer = Buffer.allocUnsafe(Math.min(size, limit));
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await file.close();
  }
}
