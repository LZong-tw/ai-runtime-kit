// Non-Claude model education hooks (spec 2026-10-15, §4.3–§5).
//
// Every rule is evaluated and logged to airkit-education.jsonl. A rule only
// changes what Claude Code sees when its flag is "enforce" (or errorHints is
// true) and, for the model-gated rules, the acting model is not Claude.
// Anything unexpected — bad flags, unreadable transcripts, state races — is
// logged and the hook lets the call through.
import { createHash } from "node:crypto";
import { appendFile, mkdir, open, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const EDUCATION_ENV = Object.freeze({
  spawnGuard: "AIRCLAUDE_EDUCATION_SPAWN_GUARD",
  subagentReport: "AIRCLAUDE_EDUCATION_SUBAGENT_REPORT",
  subagentNudge: "AIRCLAUDE_EDUCATION_SUBAGENT_NUDGE",
  errorHints: "AIRCLAUDE_EDUCATION_ERROR_HINTS",
});
export const EDUCATION_DEFAULTS = Object.freeze({
  spawnGuard: "shadow",
  subagentReport: "shadow",
  subagentNudge: "shadow",
  errorHints: false,
});
export const EDUCATION_EVENTS = Object.freeze([
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "SubagentStart",
  "SubagentStop",
  "Stop",
]);

const LEVELS = new Set(["off", "shadow", "enforce"]);
const SPAWN_TOOLS = new Set(["Agent", "Task"]);
const EXPLORE_TOOLS = new Set(["Read", "Grep", "Glob", "Bash"]);
const POLL_TOOLS = new Set(["SendMessage", "TaskGet", "ScheduleWakeup"]);
const POLL_LIMIT = 3;
const MAX_SPAWNS = 50;
const MAX_RESULT_CHARS = 8192;
const TAIL_BYTES = 256 * 1024;
const SHINGLE = 32;
// Built-in agent types. Anything else may be a workflow or plugin agent whose
// prompt contract is unknown, so SubagentStop only logs for it (§4.4.2 rule 2).
const KNOWN_AGENT_TYPES = new Set([
  "general-purpose",
  "Explore",
  "Plan",
  "statusline-setup",
  "claude-code-guide",
  "output-style-setup",
]);
const READ_ONLY_AGENT_TYPES = new Set(["Explore", "Plan", "claude-code-guide"]);
const FAN_OUT = /平行|並行|同時|分頭|各自|多個\s*reviewer|in parallel|parallel(?:ize|ly)?|fan[- ]?out|每個.{0,40}都|subagents?|workflow|teammates?|子代理/i;
const BROAD_SEARCH = /search|find|locate|explore|survey|scan|grep|look (?:for|through)|搜尋|找出|盤點|調查/i;
const LIST_LINE = /^\s*(?:[-*•]|\d+[.)、])\s+\S/;
const ITEM_TOKEN = /(?:!\d+|#\d+|\b[A-Z][A-Z0-9]+-\d+\b|(?:~|\.{1,2})?\/[\w.@-]+(?:\/[\w.@-]+)+)/g;
const FIXED_FORMAT = /verbatim|原文照錄|原樣|逐字|\bjson\b|json schema|\bschema\b|exact(?:ly)? (?:format|this format)|固定格式|only output|output only/i;
const STATUS_ASK = /\bSTATUS:/;
const STATUS_LINE = /^\s*\**STATUS\**\s*:/m;
const CLASSIFIER_DENIAL = /denied by the Claude Code auto mode classifier|classifier/i;
const STATUS_REASON = "Finish your reply with the report the task asked for: STATUS: done|blocked|partial, EVIDENCE: <paths/commands>, OPEN: <items>.";

export function readEducationConfig(env = process.env) {
  const config = {};
  const errors = [];
  for (const [key, name] of Object.entries(EDUCATION_ENV)) {
    const raw = env[name];
    if (key === "errorHints") {
      if (raw === "true" || raw === "false") config[key] = raw === "true";
      else {
        config[key] = false;
        errors.push(`${name}=${raw === undefined ? "<unset>" : JSON.stringify(raw)}`);
      }
      continue;
    }
    if (LEVELS.has(raw)) config[key] = raw;
    else {
      config[key] = "off";
      errors.push(`${name}=${raw === undefined ? "<unset>" : JSON.stringify(raw)}`);
    }
  }
  return { config, errors };
}

export function educationLogPath(env = process.env) {
  return join(env.HOME || homedir(), ".claude-code-router", "logs", "airkit-education.jsonl");
}

export function isClaudeModel(model) {
  return typeof model === "string" && /^claude-/i.test(model);
}

export function normalizeTask(text) {
  return String(text ?? "").toLowerCase().replace(/[`'"*_]/g, "").replace(/\s+/g, " ").trim().slice(0, 300);
}

function hash(value) {
  return createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value ?? null)).digest("hex").slice(0, 16);
}

export function promptFeatures(prompt) {
  const text = typeof prompt === "string" ? prompt : "";
  const listLines = text.split(/\r?\n/).filter((line) => LIST_LINE.test(line)).length;
  const tokens = new Set(text.match(ITEM_TOKEN) ?? []);
  return {
    chars: text.length,
    items: Math.max(listLines, tokens.size),
    fanOut: FAN_OUT.test(text),
  };
}

// §4.4.2 rule 3: only an instruction in the last 1-3 non-empty lines counts,
// so a quoted transcript or example that mentions STATUS does not.
export function subagentPromptContract(prompt) {
  const text = typeof prompt === "string" ? prompt : "";
  if (FIXED_FORMAT.test(text)) return "fixed-format";
  const tail = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(-3);
  return tail.some((line) => STATUS_ASK.test(line) && !/^```/.test(line)) ? "status" : "none";
}

export function errorHint(input, previousFailHash) {
  if (input?.is_interrupt === true) return null;
  const tool = input?.tool_name;
  const error = String(input?.error ?? "");
  const callHash = hash([tool, input?.tool_input ?? null]);
  if (previousFailHash && previousFailHash === callHash) {
    return { rule: "repeat-failure", hint: "Identical failing call repeated; change approach.", callHash };
  }
  if (tool === "Bash" && /No such file or directory|ENOENT/.test(error)) {
    // P0.5 fixture: the hook's cwd stays at the project directory after a
    // Bash `cd`, so printing it would point the model at the wrong place.
    return { rule: "bash-enoent", hint: "Bash cwd persists across calls; run `pwd` or use absolute paths.", callHash };
  }
  if ((tool === "Edit" || tool === "MultiEdit") && /String to replace not found|Found \d+ matches/.test(error)) {
    return { rule: "edit-mismatch", hint: "Re-Read the target lines before retrying; do not resend the same old_string.", callHash };
  }
  if (tool === "Read" && /does not exist|No such file|ENOENT/i.test(error)) {
    return { rule: "read-missing", hint: "Do not guess paths; locate it with ls/rg first.", callHash };
  }
  return { rule: null, hint: null, callHash };
}

function contentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((block) => block?.type === "text" && typeof block.text === "string").map((block) => block.text).join("\n");
}

async function readTail(path, bytes = TAIL_BYTES) {
  const handle = await open(path, "r");
  try {
    const { size } = await handle.stat();
    const start = Math.max(0, size - bytes);
    const buffer = Buffer.alloc(size - start);
    await handle.read(buffer, 0, buffer.length, start);
    const lines = buffer.toString("utf8").split("\n");
    if (start > 0) lines.shift();
    return lines;
  } finally {
    await handle.close();
  }
}

function parseLines(lines) {
  const records = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      // A partially written last line is normal while the session is live.
    }
  }
  return records;
}

export async function transcriptModel(path) {
  if (typeof path !== "string" || path === "") return null;
  try {
    const records = parseLines(await readTail(path));
    for (let index = records.length - 1; index >= 0; index -= 1) {
      const model = records[index]?.message?.model;
      if (records[index]?.type === "assistant" && typeof model === "string" && model !== "<synthetic>") return model;
    }
  } catch {
    // Missing transcript: model unknown.
  }
  return null;
}

export function agentTranscriptPath(input) {
  if (typeof input?.agent_transcript_path === "string") return input.agent_transcript_path;
  if (typeof input?.agent_id !== "string" || typeof input?.transcript_path !== "string") return null;
  if (!input.transcript_path.endsWith(".jsonl")) return null;
  return join(input.transcript_path.slice(0, -".jsonl".length), "subagents", `agent-${input.agent_id}.jsonl`);
}

// §5: rules follow the model of whoever is acting. Inside a subagent that is
// the subagent's own model, never the parent's.
async function actorModel(input) {
  if (typeof input?.agent_id === "string") return transcriptModel(agentTranscriptPath(input));
  return transcriptModel(input?.transcript_path);
}

async function firstUserPrompt(path) {
  if (typeof path !== "string") return null;
  try {
    const raw = await readFile(path, "utf8");
    for (const line of raw.slice(0, 1_000_000).split("\n")) {
      if (!line.trim()) continue;
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      if (record?.type === "user" && record.message?.role === "user") return contentText(record.message.content);
    }
  } catch {
    // Unknown prompt: callers treat it as no contract.
  }
  return null;
}

function emptyState() {
  return { turn: 0, prompt: promptFeatures(""), ownCalls: 0, lastFailHash: null, stopBlockedTurn: -1, rejectedSpawns: [], spawns: [] };
}

function statePath(env, sessionId) {
  if (!env.CLAUDE_PLUGIN_DATA || typeof sessionId !== "string" || sessionId === "") return null;
  return join(env.CLAUDE_PLUGIN_DATA, "education", `${hash(sessionId)}.json`);
}

async function loadState(path) {
  if (!path) return emptyState();
  try {
    const state = JSON.parse(await readFile(path, "utf8"));
    return state && Array.isArray(state.spawns) ? { ...emptyState(), ...state } : emptyState();
  } catch {
    return emptyState();
  }
}

async function saveState(path, state) {
  if (!path) return;
  state.spawns = state.spawns.slice(-MAX_SPAWNS);
  state.rejectedSpawns = state.rejectedSpawns.slice(-MAX_SPAWNS);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, JSON.stringify(state), { mode: 0o600 });
  await rename(temporary, path);
}

function spawnFor(state, agentId) {
  return state.spawns.find((spawn) => spawn.agentId === agentId) ?? null;
}

function upsertSpawn(state, agentId, fields) {
  let spawn = spawnFor(state, agentId);
  if (!spawn) {
    spawn = { agentId, polls: 0, read: false, nudged: false, reportBlocked: false };
    state.spawns.push(spawn);
  }
  Object.assign(spawn, fields);
  return spawn;
}

function markRead(spawn, how) {
  if (!spawn.read) {
    spawn.read = true;
    spawn.readBy = how;
  }
}

// Distinctive 32-char windows of a result, minus anything also present in the
// description: quoting only the header or the task name does not count (§4.4.3 a).
export function resultShingles(result, description = "") {
  const text = String(result ?? "").replace(/\s+/g, " ").trim();
  const exclude = String(description ?? "").replace(/\s+/g, " ").toLowerCase();
  const shingles = [];
  if (text.length < SHINGLE) return shingles;
  const step = Math.max(8, Math.floor(text.length / 64));
  for (let index = 0; index + SHINGLE <= text.length; index += step) {
    const window = text.slice(index, index + SHINGLE);
    if (!/[\p{L}\p{N}]{4}/u.test(window) || exclude.includes(window.toLowerCase())) continue;
    shingles.push(window);
  }
  return shingles;
}

function quotes(text, spawn) {
  const haystack = String(text ?? "").replace(/\s+/g, " ");
  return resultShingles(spawn.result, spawn.description).some((window) => haystack.includes(window));
}

// Paths and commands the result names; a later tool call touching one of them
// counts as acting on the result (§4.4.3 b). String matching, so it is noisy.
function resultTokens(spawn) {
  const tokens = String(spawn.result ?? "").match(/(?:~|\.{0,2})\/[\w.@-]+(?:\/[\w.@-]+)+|`[^`\n]{6,80}`/g) ?? [];
  return [...new Set(tokens.map((token) => token.replace(/^`|`$/g, "")))].filter((token) => token.length >= 6);
}

async function logRecord(env, record) {
  try {
    const path = educationLogPath(env);
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, `${JSON.stringify({ ts: new Date().toISOString(), ...record })}\n`);
  } catch {
    // Logging must never break the session.
  }
}

function gated(level, model) {
  return level === "enforce" && model !== null && !isClaudeModel(model);
}

function context(eventName, text) {
  return { hookSpecificOutput: { hookEventName: eventName, additionalContext: text } };
}

async function onUserPrompt(input, state) {
  if (typeof input.agent_id === "string") return null;
  state.turn += 1;
  state.ownCalls = 0;
  state.prompt = promptFeatures(input.prompt);
  return null;
}

async function onPreToolUse(input, state, config, model, log) {
  if (!SPAWN_TOOLS.has(input.tool_name) || config.spawnGuard === "off") return null;
  const toolInput = input.tool_input ?? {};
  const descNorm = normalizeTask(toolInput.description || toolInput.prompt);
  const inputHash = hash(toolInput);
  const prompt = state.prompt ?? promptFeatures("");
  const signals = [];
  if (prompt.fanOut) signals.push("fan-out-intent");
  if (prompt.items >= 3) signals.push("divisible-task");
  if (state.ownCalls >= 3) signals.push("explored-first");
  if (READ_ONLY_AGENT_TYPES.has(toolInput.subagent_type) && BROAD_SEARCH.test(`${toolInput.description ?? ""} ${toolInput.prompt ?? ""}`)) {
    signals.push("read-only-search");
  }
  const downgrades = [];
  if (state.rejectedSpawns.length > 0) downgrades.push("previous-spawn-rejected");
  if (state.spawns.filter((spawn) => spawn.endedAt && !spawn.statusReported).length >= 2) downgrades.push("unfinished-agents");

  let deny = null;
  const sameTask = state.spawns.filter((spawn) => spawn.descNorm && spawn.descNorm === descNorm);
  const silent = sameTask.find((spawn) => spawn.endedAt && !spawn.statusReported && !spawn.read);
  const pending = sameTask.find((spawn) => !spawn.endedAt || !spawn.read);
  if (state.rejectedSpawns.includes(inputHash)) {
    deny = { rule: "D4", reason: "This exact spawn was already rejected by the permission classifier. Change the request or do the work directly." };
  } else if (silent) {
    deny = { rule: "D2", reason: `Inspect ${silent.agentId}'s transcript (or do it yourself) before respawning.` };
  } else if (pending) {
    deny = { rule: "D1", reason: `An agent with this task is running/unread (${pending.agentId}). Read its output or transcript first.` };
  } else if (signals.length === 0 && state.ownCalls === 0) {
    deny = { rule: "D3", reason: "Investigate directly first; spawn when work proves parallelizable." };
  }
  const emit = deny !== null && gated(config.spawnGuard, model);
  await log({
    rule: deny?.rule ?? "spawn-allow",
    decision: deny ? "deny" : "allow",
    emitted: emit,
    reason: deny?.reason ?? null,
    evidence: { signals, downgrades, ownCalls: state.ownCalls, promptChars: prompt.chars, promptItems: prompt.items, descNorm, inputHash, subagentType: toolInput.subagent_type ?? null },
  });
  if (!emit) return null;
  return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: deny.reason } };
}

async function onPostToolUse(input, state, config, model, log) {
  const tool = input.tool_name;
  const toolInput = input.tool_input ?? {};
  const response = input.tool_response;
  const isParent = typeof input.agent_id !== "string";
  if (isParent && EXPLORE_TOOLS.has(tool)) state.ownCalls += 1;

  if (SPAWN_TOOLS.has(tool) && isParent && response && typeof response === "object") {
    const agentId = typeof response.agentId === "string" ? response.agentId : null;
    if (agentId) {
      const spawn = upsertSpawn(state, agentId, {
        descNorm: normalizeTask(toolInput.description || toolInput.prompt),
        description: String(toolInput.description ?? "").slice(0, 200),
        background: response.isAsync === true,
        outputFile: typeof response.outputFile === "string" ? response.outputFile : null,
        turn: state.turn,
      });
      // A foreground agent's result is the tool result itself.
      if (response.isAsync !== true) markRead(spawn, "foreground");
    }
    return null;
  }

  if (tool === "TaskOutput") {
    const spawn = spawnFor(state, toolInput.task_id ?? toolInput.agentId);
    if (spawn) markRead(spawn, "task-output");
    return null;
  }

  if (tool === "Read" && typeof toolInput.file_path === "string") {
    for (const spawn of state.spawns) {
      if (toolInput.file_path === spawn.outputFile || toolInput.file_path === spawn.transcriptPath) markRead(spawn, "read-output");
    }
  }

  if (POLL_TOOLS.has(tool) && isParent) {
    const target = toolInput.to ?? toolInput.task_id ?? toolInput.taskId ?? null;
    const targets = target ? state.spawns.filter((spawn) => spawn.agentId === target || spawn.name === target)
      : state.spawns.filter((spawn) => !spawn.endedAt);
    const over = [];
    for (const spawn of targets) {
      spawn.polls += 1;
      if (spawn.polls > POLL_LIMIT && !spawn.nudged) over.push(spawn);
    }
    if (over.length === 0 || config.subagentNudge === "off") return null;
    const emit = gated(config.subagentNudge, model);
    for (const spawn of over) spawn.nudged = true;
    const hint = "Stop polling; completion arrives on its own, or read its output/transcript.";
    await log({ rule: "poll-nudge", decision: "hint", emitted: emit, reason: hint, evidence: { tool, agents: over.map((spawn) => spawn.agentId), polls: over.map((spawn) => spawn.polls) } });
    return emit ? context("PostToolUse", hint) : null;
  }

  if (isParent) {
    const serialized = JSON.stringify(toolInput);
    for (const spawn of state.spawns) {
      if (spawn.read || !spawn.endedAt) continue;
      if (resultTokens(spawn).some((token) => serialized.includes(token))) markRead(spawn, "acted-on-result");
    }
  }
  return null;
}

async function onPostToolUseFailure(input, state, config, model, log) {
  const tool = input.tool_name;
  const isParent = typeof input.agent_id !== "string";
  if (isParent && EXPLORE_TOOLS.has(tool)) state.ownCalls += 1;
  if (input.is_interrupt === true) return null;
  const error = String(input.error ?? "");
  const responses = [];

  if (SPAWN_TOOLS.has(tool) && isParent) {
    if (CLASSIFIER_DENIAL.test(error)) {
      state.rejectedSpawns.push(hash(input.tool_input ?? {}));
      await log({ rule: "spawn-rejected", decision: "log-only", emitted: false, reason: null, evidence: { inputHash: hash(input.tool_input ?? {}) } });
    } else if (config.subagentNudge !== "off") {
      const reason = error.replace(/\s+/g, " ").slice(0, 160) || "unknown error";
      const hint = `Subagent ended without a report (${reason}); read its transcript or do the work directly.`;
      const emit = gated(config.subagentNudge, model);
      await log({ rule: "subagent-cut", decision: "hint", emitted: emit, reason: hint, evidence: { tool } });
      if (emit) responses.push(hint);
    }
  }

  const found = errorHint(input, state.lastFailHash);
  state.lastFailHash = found.callHash;
  if (found.rule) {
    const emit = config.errorHints === true && model !== null && !isClaudeModel(model);
    await log({ rule: found.rule, decision: "hint", emitted: emit, reason: found.hint, evidence: { tool, error: error.slice(0, 200) } });
    if (emit) responses.push(found.hint);
  }
  return responses.length > 0 ? context("PostToolUseFailure", responses.join(" ")) : null;
}

async function onSubagentStart(input, state) {
  if (typeof input.agent_id !== "string") return null;
  upsertSpawn(state, input.agent_id, { agentType: input.agent_type ?? null, startedAt: new Date().toISOString() });
  return null;
}

// §4.4.2: every parent, Claude included. Blocks only when the subagent's own
// prompt asked for STATUS, at most once per agent.
async function onSubagentStop(input, state, config, log) {
  if (typeof input.agent_id !== "string") return null;
  const message = String(input.last_assistant_message ?? "");
  const statusReported = STATUS_LINE.test(message);
  const transcriptPath = agentTranscriptPath(input);
  const spawn = upsertSpawn(state, input.agent_id, {
    agentType: input.agent_type ?? null,
    endedAt: new Date().toISOString(),
    statusReported,
    result: message.slice(0, MAX_RESULT_CHARS),
    transcriptPath,
  });
  if (config.subagentReport === "off") return null;
  const contract = subagentPromptContract(await firstUserPrompt(transcriptPath));
  const knownType = KNOWN_AGENT_TYPES.has(input.agent_type);
  let rule = "status-log";
  let block = false;
  if (contract === "fixed-format") rule = "status-fixed-format";
  else if (!knownType) rule = "status-unknown-agent-type";
  else if (contract === "status" && !statusReported) {
    rule = "status-missing";
    block = input.stop_hook_active !== true && !spawn.reportBlocked;
  }
  const emit = block && config.subagentReport === "enforce";
  if (emit) spawn.reportBlocked = true;
  await log({
    rule,
    decision: block ? "block" : "log-only",
    emitted: emit,
    reason: block ? STATUS_REASON : null,
    evidence: { agentType: input.agent_type ?? null, contract, statusReported, stopHookActive: input.stop_hook_active === true },
  });
  return emit ? { decision: "block", reason: STATUS_REASON } : null;
}

async function assistantTextsSince(path, since) {
  if (typeof path !== "string") return [];
  try {
    const texts = [];
    for (const record of parseLines(await readTail(path))) {
      if (record?.type !== "assistant") continue;
      if (since && typeof record.timestamp === "string" && record.timestamp < since) continue;
      const text = contentText(record.message?.content);
      if (text) texts.push(text);
    }
    return texts;
  } catch {
    return [];
  }
}

// §4.4.3: parent only, non-Claude only. A finished background agent whose
// result the parent never used blocks once per turn; running agents get a
// "don't poll" note instead of a block.
async function onStop(input, state, config, model, log) {
  if (typeof input.agent_id === "string" || config.subagentNudge === "off") return null;
  const background = Array.isArray(input.background_tasks) ? input.background_tasks : [];
  const running = background.filter((task) => task?.type === "subagent" && task.status === "running");
  const ended = state.spawns.filter((spawn) => spawn.background && spawn.endedAt && !spawn.read);
  if (ended.length > 0) {
    const since = ended.map((spawn) => spawn.endedAt).sort()[0];
    const texts = [...await assistantTextsSince(input.transcript_path, since), String(input.last_assistant_message ?? "")];
    for (const spawn of ended) if (texts.some((text) => quotes(text, spawn))) markRead(spawn, "quoted");
  }
  const unread = ended.filter((spawn) => !spawn.read);
  if (unread.length > 0) {
    const list = unread.map((spawn) => `${spawn.agentId} (${spawn.description || "no description"})`).join(", ");
    const reason = `Finished background agents have results you have not read: ${list}. Read their output (TaskOutput or the output file) and use it before ending the turn.`;
    const block = input.stop_hook_active !== true && state.stopBlockedTurn !== state.turn;
    const emit = block && gated(config.subagentNudge, model);
    if (emit) state.stopBlockedTurn = state.turn;
    await log({ rule: "unread-result", decision: block ? "block" : "log-only", emitted: emit, reason, evidence: { agents: unread.map((spawn) => spawn.agentId), stopHookActive: input.stop_hook_active === true } });
    if (emit) return { decision: "block", reason };
  }
  if (running.length > 0) {
    const note = `${running.length} agent${running.length === 1 ? "" : "s"} still running; completion notices will arrive — end the turn or keep working, don't poll.`;
    const emit = gated(config.subagentNudge, model);
    await log({ rule: "running-note", decision: "hint", emitted: emit, reason: note, evidence: { agents: running.map((task) => task.id) } });
    if (emit) return context("Stop", note);
  }
  return null;
}

export async function processEducationHook(input, env = process.env) {
  const eventName = input?.hook_event_name;
  if (!EDUCATION_EVENTS.includes(eventName)) return null;
  const base = { session_id: input.session_id ?? null, agent_id: input.agent_id ?? null, event: eventName, tool: input.tool_name ?? null };
  const { config, errors } = readEducationConfig(env);
  if (errors.length > 0) {
    await logRecord(env, { ...base, rule: "config", decision: "config-error", emitted: false, reason: `invalid or missing ${errors.join(", ")}; affected rules pass` });
  }
  if (Object.values(config).every((value) => value === "off" || value === false)) return null;
  const path = statePath(env, input.session_id);
  const state = await loadState(path);
  const model = ["PreToolUse", "PostToolUse", "PostToolUseFailure", "Stop"].includes(eventName) ? await actorModel(input) : null;
  const log = (record) => logRecord(env, { ...base, model, flags: config, ...record });
  let response = null;
  if (eventName === "UserPromptSubmit") response = await onUserPrompt(input, state);
  else if (eventName === "PreToolUse") response = await onPreToolUse(input, state, config, model, log);
  else if (eventName === "PostToolUse") response = await onPostToolUse(input, state, config, model, log);
  else if (eventName === "PostToolUseFailure") response = await onPostToolUseFailure(input, state, config, model, log);
  else if (eventName === "SubagentStart") response = await onSubagentStart(input, state);
  else if (eventName === "SubagentStop") response = await onSubagentStop(input, state, config, log);
  else if (eventName === "Stop") response = await onStop(input, state, config, model, log);
  await saveState(path, state);
  return response;
}

export async function runEducationHook({ env = process.env, input = process.stdin, output = process.stdout } = {}) {
  let raw = "";
  for await (const chunk of input) {
    raw += chunk;
    if (raw.length > 1_000_000) return;
  }
  let hookInput;
  try {
    hookInput = JSON.parse(raw);
  } catch {
    return;
  }
  let response = null;
  try {
    response = await processEducationHook(hookInput, env);
  } catch (error) {
    await logRecord(env, { session_id: hookInput?.session_id ?? null, event: hookInput?.hook_event_name ?? null, rule: "internal", decision: "error", emitted: false, reason: String(error?.message ?? error).slice(0, 300) });
    return;
  }
  if (response) output.write(`${JSON.stringify(response)}\n`);
}

// P4 observation: rules stay in shadow for a week, then each is judged by its
// hand-labelled false-positive rate (spec §6.2/§7). This only counts and
// samples; deciding precision stays with a human reading the samples.
export function summarizeEducationLog(text, { now = Date.now(), days = 7, samples = 20 } = {}) {
  const since = now - days * 86_400_000;
  const rules = new Map();
  const sessions = new Set();
  let records = 0;
  let malformed = 0;
  let first = null;
  for (const line of String(text).split("\n")) {
    if (!line.trim()) continue;
    let record;
    try { record = JSON.parse(line); } catch { malformed += 1; continue; }
    const ts = Date.parse(record?.ts);
    if (!Number.isFinite(ts) || ts < since || ts > now) continue;
    records += 1;
    if (record.session_id) sessions.add(record.session_id);
    if (first === null || ts < first) first = ts;
    const key = record.rule ?? "unknown";
    const entry = rules.get(key) ?? { rule: key, total: 0, emitted: 0, decisions: {}, models: {}, samples: [], seen: 0 };
    entry.total += 1;
    if (record.emitted) entry.emitted += 1;
    entry.decisions[record.decision ?? "unknown"] = (entry.decisions[record.decision ?? "unknown"] ?? 0) + 1;
    const family = modelFamily(record.model);
    entry.models[family] = (entry.models[family] ?? 0) + 1;
    // Reservoir sampling keyed on the line hash: spread over the whole week,
    // and the same log always yields the same samples.
    entry.seen += 1;
    if (entry.samples.length < samples) entry.samples.push(sampleOf(record));
    else {
      const slot = Math.floor(stableFraction(line) * entry.seen);
      if (slot < samples) entry.samples[slot] = sampleOf(record);
    }
    rules.set(key, entry);
  }
  const list = [...rules.values()]
    .map(({ seen, ...entry }) => ({ ...entry, samples: entry.samples.sort((a, b) => a.ts.localeCompare(b.ts)) }))
    .sort((a, b) => b.total - a.total || a.rule.localeCompare(b.rule));
  return {
    since: new Date(since).toISOString(),
    until: new Date(now).toISOString(),
    days,
    coverageDays: first === null ? 0 : Math.round(((now - first) / 86_400_000) * 10) / 10,
    records,
    malformed,
    sessions: sessions.size,
    rules: list,
  };
}

function modelFamily(model) {
  if (typeof model !== "string" || model === "") return "unknown";
  if (isClaudeModel(model)) return "claude";
  const lower = model.toLowerCase();
  for (const family of ["gpt-6", "gpt", "glm", "kimi", "deepseek", "grok"]) {
    if (lower.includes(family)) return family;
  }
  return "other";
}

function sampleOf(record) {
  return {
    ts: String(record.ts),
    session_id: record.session_id ?? null,
    agent_id: record.agent_id ?? null,
    event: record.event ?? null,
    tool: record.tool ?? null,
    model: record.model ?? null,
    decision: record.decision ?? null,
    reason: record.reason ? String(record.reason).slice(0, 200) : null,
  };
}

function stableFraction(line) {
  return parseInt(createHash("sha256").update(line).digest("hex").slice(0, 8), 16) / 0x1_0000_0000;
}

const SAMPLED_DECISIONS = new Set(["deny", "block", "hint"]);

export function renderEducationSummary(summary) {
  const lines = [
    `Education log ${summary.since} → ${summary.until} (${summary.days}d window, ${summary.coverageDays}d of data)`,
    `records ${summary.records}, sessions ${summary.sessions}${summary.malformed ? `, malformed lines ${summary.malformed}` : ""}`,
  ];
  if (summary.coverageDays < summary.days) {
    lines.push(`note: less than ${summary.days} days of data; do not decide enforce yet`);
  }
  lines.push("", "rule | total | emitted | decisions | models");
  for (const entry of summary.rules) {
    const fmt = (counts) => Object.entries(counts).map(([key, value]) => `${key} ${value}`).join(", ");
    lines.push(`${entry.rule} | ${entry.total} | ${entry.emitted} | ${fmt(entry.decisions)} | ${fmt(entry.models)}`);
  }
  for (const entry of summary.rules) {
    if (!Object.keys(entry.decisions).some((decision) => SAMPLED_DECISIONS.has(decision))) continue;
    lines.push("", `## ${entry.rule} — ${entry.samples.length} sample(s) to label true/false positive`);
    for (const sample of entry.samples) {
      lines.push(`- ${sample.ts} ${sample.session_id ?? "-"}${sample.agent_id ? `/${sample.agent_id}` : ""} ${sample.event ?? "-"} ${sample.tool ?? "-"} ${sample.model ?? "-"} ${sample.decision ?? "-"}: ${sample.reason ?? ""}`);
    }
  }
  return `${lines.join("\n")}\n`;
}
