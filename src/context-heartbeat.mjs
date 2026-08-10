import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export const HEARTBEAT_CONTEXT_LIMIT = 512;
export const TASK_CAPSULE_CONTEXT_LIMIT = 3072;
const TASK_CAPSULE_FIELD_LIMIT = 240;
const TASK_CAPSULE_FIELDS = Object.freeze([
  "objective",
  "constraints",
  "decisions",
  "changed_files",
  "verification",
  "repository_state",
  "next_action",
]);
const SESSION_SOURCES = new Set(["startup", "resume", "clear", "compact"]);
const COMPLETION_GUARD_REASON = "Continue working when safe. Finish every requested deliverable, verify each result, and do not stop after partial completion.";
const COMPLETION_GUARD_MODEL_PATTERNS = Object.freeze([/^gpt(?:-|$)/i, /^deepseek-/i]);
const TRANSCRIPT_TAIL_LIMIT = 256 * 1024;
const SUBAGENT_TOOL_NAMES = new Set(["Agent", "Task", "TaskOutput"]);
const SUBAGENT_RESULT_SCAN_LIMIT = 256 * 1024;
const SUBAGENT_RESULT_MAX_CHARS = 32 * 1024;
const SUBAGENT_RESULT_OUTPUT_LIMIT = 12 * 1024;

function boundedLabel(value, fallback = "unset") {
  if (typeof value !== "string" || value.length === 0) return fallback;
  return value.replaceAll(/[^A-Za-z0-9._+:[\]/-]+/g, "_").slice(0, 80) || fallback;
}

export function buildHeartbeatResponse(input, env = process.env) {
  if (!env.AIRCLAUDE_PROFILE || input?.hook_event_name !== "UserPromptSubmit") return null;

  const context = routeContext(env, [
    "AirClaude session context is active.",
    "Durable task state consists of the current objective, accepted constraints and decisions, changed files, verification and repository state, and next action.",
  ]).slice(0, HEARTBEAT_CONTEXT_LIMIT);

  return {
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: context,
    },
  };
}

export function parseTaskCapsule(summary) {
  if (typeof summary !== "string") return null;
  const opening = "[AIRKIT_TASK_CAPSULE]";
  const closing = "[/AIRKIT_TASK_CAPSULE]";
  const trimmed = summary.trim();
  const start = trimmed.indexOf(opening);
  const end = trimmed.indexOf(closing, start + 1);
  if (start < 0 || end < 0 || !trimmed.endsWith(closing)) return null;
  if (start !== trimmed.lastIndexOf(opening) || end !== trimmed.lastIndexOf(closing)) return null;

  const values = new Map();
  const body = trimmed.slice(start + opening.length, end);
  for (const line of body.split(/\r?\n/)) {
    const candidate = line.trim();
    if (!candidate) continue;
    const separator = candidate.indexOf(":");
    if (separator < 1) return null;
    const field = candidate.slice(0, separator).trim().toLowerCase();
    if (!TASK_CAPSULE_FIELDS.includes(field) || values.has(field)) return null;
    values.set(field, sanitizeCapsuleValue(candidate.slice(separator + 1)));
  }
  if (TASK_CAPSULE_FIELDS.some((field) => !values.get(field))) return null;
  return Object.fromEntries(TASK_CAPSULE_FIELDS.map((field) => [field, values.get(field)]));
}

export async function processContextHook(input, env = process.env) {
  if (!env.AIRCLAUDE_PROFILE) return null;
  const completionGuardResponse = await processCompletionGuardHook(input, env);
  if (completionGuardResponse) return completionGuardResponse;
  const subagentOutputResponse = await processSubagentOutputHook(input, env);
  if (subagentOutputResponse) return subagentOutputResponse;
  if (input?.hook_event_name === "UserPromptSubmit") return buildHeartbeatResponse(input, env);

  if (input?.hook_event_name === "PostCompact") {
    const capsule = parseTaskCapsule(input.compact_summary);
    if (validWorkspace(input.cwd) && env.CLAUDE_PLUGIN_DATA) {
      if (capsule) {
        await saveTaskCapsule(input.cwd, env.CLAUDE_PLUGIN_DATA, capsule);
      } else {
        await removeTaskCapsule(input.cwd, env.CLAUDE_PLUGIN_DATA);
      }
    }
    return null;
  }

  if (input?.hook_event_name !== "SessionStart" || !SESSION_SOURCES.has(input.source)) return null;
  const capsule = validWorkspace(input.cwd) && env.CLAUDE_PLUGIN_DATA
    ? await loadTaskCapsule(input.cwd, env.CLAUDE_PLUGIN_DATA)
    : null;
  const capsuleContext = capsule ? formatTaskCapsule(capsule) : "";
  const context = routeContext(env, [
    "AirClaude session context is active.",
    `Session lifecycle source is ${input.source}.`,
    capsuleContext,
  ]).slice(0, TASK_CAPSULE_CONTEXT_LIMIT);
  return {
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: context,
    },
  };
}

export async function processSubagentOutputHook(input, env = process.env) {
  if (input?.hook_event_name !== "PostToolUse" || !SUBAGENT_TOOL_NAMES.has(input.tool_name)) return null;
  const toolResponse = input.tool_response;
  const resultPath = input.tool_name === "TaskOutput" ? ["task", "output"] : ["result"];
  const result = resultPath.reduce((value, key) => value?.[key], toolResponse);
  if (typeof result !== "string" || result.length <= SUBAGENT_RESULT_MAX_CHARS || !looksLikeSubagentTranscript(result)) {
    return null;
  }

  const updatedToolOutput = structuredClone(toolResponse);
  let target = updatedToolOutput;
  for (const key of resultPath.slice(0, -1)) target = target[key];
  const artifactPath = await persistSubagentTranscript(input, env, result);
  target[resultPath.at(-1)] = boundedSubagentResult(result, artifactPath);
  return {
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      updatedToolOutput,
    },
  };
}

function looksLikeSubagentTranscript(result) {
  const tail = result.length > SUBAGENT_RESULT_SCAN_LIMIT ? result.slice(-SUBAGENT_RESULT_SCAN_LIMIT) : result;
  let structuredRecords = 0;
  let transcriptRecords = 0;
  for (const line of tail.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (!record || typeof record !== "object" || Array.isArray(record)) continue;
    structuredRecords += 1;
    if (["assistant", "system", "progress", "user"].includes(record.type)) transcriptRecords += 1;
    if (structuredRecords >= 4) break;
  }
  return structuredRecords >= 2 && transcriptRecords >= 1;
}

async function persistSubagentTranscript(input, env, result) {
  if (typeof env?.CLAUDE_PLUGIN_DATA !== "string" || env.CLAUDE_PLUGIN_DATA.length === 0) return null;
  const sessionId = boundedLabel(input?.session_id, "unknown-session");
  const digest = createHash("sha256").update(result).digest("hex").slice(0, 24);
  const artifactDirectory = join(env.CLAUDE_PLUGIN_DATA, "subagent-transcripts", sessionId);
  const artifactPath = join(artifactDirectory, `${digest}.jsonl`);
  const temporaryPath = join(artifactDirectory, `.${digest}-${randomUUID()}.tmp`);
  try {
    await mkdir(artifactDirectory, { recursive: true });
    await writeFile(temporaryPath, result, { mode: 0o600 });
    await rename(temporaryPath, artifactPath);
    return artifactPath;
  } catch {
    await rm(temporaryPath, { force: true });
    return null;
  }
}

function boundedSubagentResult(result, artifactPath) {
  const tail = result.length > SUBAGENT_RESULT_SCAN_LIMIT ? result.slice(-SUBAGENT_RESULT_SCAN_LIMIT) : result;
  for (const line of tail.split(/\r?\n/).reverse()) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (record?.type !== "assistant") continue;
    const text = assistantText(record.message?.content);
    if (text) return truncateSubagentResult(text, artifactPath);
  }
  return truncateSubagentResult("[AirKit] Bounded a transcript-like subagent result.", artifactPath);
}

function assistantText(content) {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block && block.type === "text" && typeof block.text === "string")
    .map((block) => block.text.trim())
    .filter(Boolean)
    .join("\n")
    .trim();
}

function truncateSubagentResult(text, artifactPath) {
  const artifact = artifactPath
    ? `\n[AirKit] Full transcript artifact: ${artifactPath}`
    : "\n[AirKit] Full transcript remains in the host session storage.";
  if (text.length + artifact.length <= SUBAGENT_RESULT_OUTPUT_LIMIT) return `${text}${artifact}`;
  const suffix = `\n[AirKit] Result truncated.${artifact}`;
  return `${text.slice(0, SUBAGENT_RESULT_OUTPUT_LIMIT - suffix.length)}${suffix}`;
}

export async function processCompletionGuardHook(input, env = process.env) {
  const maxStopBlocks = completionGuardMaxStopBlocks(env);
  const statePath = completionGuardStatePath(input, env);
  if (!maxStopBlocks || !statePath) return null;

  if (input?.hook_event_name === "UserPromptSubmit") {
    await rm(statePath, { force: true });
    return null;
  }

  if (input?.hook_event_name === "PostToolUse") {
    const state = await loadCompletionGuardState(statePath);
    await saveCompletionGuardState(statePath, { armed: true, stopBlocks: state?.stopBlocks ?? 0 });
    return null;
  }

  if (input?.hook_event_name !== "Stop" || input.stop_hook_active === true) return null;
  const state = await loadCompletionGuardState(statePath);
  if (!state?.armed || state.stopBlocks >= maxStopBlocks) return null;

  const model = await completionGuardModel(input, env);
  if (!isCompletionGuardModel(model)) {
    await saveCompletionGuardState(statePath, { armed: false, stopBlocks: state.stopBlocks });
    return null;
  }

  await saveCompletionGuardState(statePath, { armed: false, stopBlocks: state.stopBlocks + 1 });
  return {
    hookSpecificOutput: {
      hookEventName: "Stop",
      additionalContext: COMPLETION_GUARD_REASON,
    },
  };
}

async function completionGuardModel(input, env) {
  const transcriptPath = input?.transcript_path;
  if (typeof transcriptPath === "string" && transcriptPath.length > 0) {
    return readTranscriptModel(transcriptPath);
  }
  return env.AIRCLAUDE_ACTIVE_MODEL ?? env.AIRCLAUDE_ROUTE_DEFAULT_MODEL ?? null;
}

function isCompletionGuardModel(model) {
  const normalized = String(model ?? "")
    .trim()
    .split(/[\/,]/)
    .at(-1)
    ?.replace(/\[1m\]$/i, "");
  return COMPLETION_GUARD_MODEL_PATTERNS.some((pattern) => pattern.test(normalized ?? ""));
}

async function readTranscriptModel(transcriptPath) {
  try {
    const raw = await readFile(transcriptPath, "utf8");
    const tail = raw.length > TRANSCRIPT_TAIL_LIMIT ? raw.slice(-TRANSCRIPT_TAIL_LIMIT) : raw;
    for (const line of tail.split(/\r?\n/).reverse()) {
      if (!line.trim()) continue;
      const record = JSON.parse(line);
      const model = record?.type === "assistant" ? record.message?.model : null;
      if (typeof model === "string" && model.trim() !== "") return model;
    }
  } catch {
    // A missing or malformed transcript is not enough evidence to continue a turn.
  }
  return null;
}

export async function runHeartbeatHook({ env = process.env, input = process.stdin, output = process.stdout } = {}) {
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

  const response = await processContextHook(hookInput, env);
  if (response) output.write(`${JSON.stringify(response)}\n`);
}

export function renderHeartbeatManagedFiles(configDir, runtimeModuleUrl = import.meta.url) {
  const root = join(configDir, "plugins", "airkit-context");
  const manifest = {
    name: "airkit-context",
    version: "1.0.0",
    description: "AirClaude session context heartbeat",
  };
  const hooks = {
    description: "Keeps bounded AirClaude route and task state across long sessions",
    hooks: {
      PostCompact: [{
        matcher: "manual|auto",
        hooks: [{
          args: ["${CLAUDE_PLUGIN_ROOT}/scripts/user-prompt-submit.mjs"],
          command: "node",
          type: "command",
        }],
      }],
      PostToolUse: [{
        hooks: [{
          args: ["${CLAUDE_PLUGIN_ROOT}/scripts/user-prompt-submit.mjs"],
          command: "node",
          type: "command",
        }],
      }],
      SessionStart: [{
        matcher: "startup|resume|clear|compact",
        hooks: [{
          args: ["${CLAUDE_PLUGIN_ROOT}/scripts/user-prompt-submit.mjs"],
          command: "node",
          type: "command",
        }],
      }],
      Stop: [{
        hooks: [{
          args: ["${CLAUDE_PLUGIN_ROOT}/scripts/user-prompt-submit.mjs"],
          command: "node",
          type: "command",
        }],
      }],
      UserPromptSubmit: [{
        hooks: [{
          args: ["${CLAUDE_PLUGIN_ROOT}/scripts/user-prompt-submit.mjs"],
          command: "node",
          type: "command",
        }],
      }],
    },
  };
  const script = `import { runHeartbeatHook } from ${JSON.stringify(runtimeModuleUrl)};\nawait runHeartbeatHook();\n`;

  return [
    {
      content: `${JSON.stringify(manifest, null, 2)}\n`,
      label: "AirClaude context plugin manifest",
      path: join(root, ".claude-plugin", "plugin.json"),
      relativePath: "plugins/airkit-context/.claude-plugin/plugin.json",
    },
    {
      content: `${JSON.stringify(hooks, null, 2)}\n`,
      label: "AirClaude context plugin hooks",
      path: join(root, "hooks", "hooks.json"),
      relativePath: "plugins/airkit-context/hooks/hooks.json",
    },
    {
      content: script,
      label: "AirClaude context heartbeat hook",
      path: join(root, "scripts", "user-prompt-submit.mjs"),
      relativePath: "plugins/airkit-context/scripts/user-prompt-submit.mjs",
    },
  ];
}

function routeContext(env, extra = []) {
  return [
    ...extra.filter(Boolean),
    `Current routing mode is ${boundedLabel(env.AIRCLAUDE_MODE)}.`,
    `The default model is ${boundedLabel(env.AIRCLAUDE_ROUTE_DEFAULT_MODEL)}.`,
    `The background model is ${boundedLabel(env.AIRCLAUDE_ROUTE_BACKGROUND_MODEL)}.`,
    "Claude's displayed model is compatibility metadata, not proof of active provider routing.",
  ].join(" ");
}

function sanitizeCapsuleValue(value) {
  return String(value)
    .replaceAll(/[\u0000-\u001f\u007f]+/g, " ")
    .replaceAll(
      /\b((?:[A-Z][A-Z0-9_]*(?:TOKEN|KEY|SECRET|PASSWORD))|api[_-]?key|token|password|secret|endpoint|api[_-]?base[_-]?url)(\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s;,]+)/gi,
      "$1$2[redacted]",
    )
    .replaceAll(/\bBearer\s+[^\s;,]+/gi, "Bearer [redacted]")
    .replaceAll(/\b(?:sk-|ghp_|xox[baprs]-)[A-Za-z0-9_-]{8,}/gi, "[redacted]")
    .replaceAll(/https?:\/\/[^\s;,]+/gi, "[redacted-url]")
    .replaceAll(/\s+/g, " ")
    .trim()
    .slice(0, TASK_CAPSULE_FIELD_LIMIT);
}

function formatTaskCapsule(capsule) {
  const labels = {
    objective: "Objective",
    constraints: "Constraints",
    decisions: "Decisions",
    changed_files: "Changed files",
    verification: "Verification",
    repository_state: "Repository state",
    next_action: "Next action",
  };
  return TASK_CAPSULE_FIELDS.map((field) => `${labels[field]}: ${capsule[field]}.`).join(" ");
}

function validWorkspace(cwd) {
  return typeof cwd === "string" && cwd.length > 0 && cwd.length <= 4096;
}

function completionGuardMaxStopBlocks(env) {
  const value = env.AIRCLAUDE_COMPLETION_GUARD_MAX_STOP_BLOCKS;
  if (!/^[1-9]\d*$/.test(value ?? "")) return 0;
  return Number(value);
}

function completionGuardStatePath(input, env) {
  if (!env.AIRCLAUDE_PROFILE || !env.CLAUDE_PLUGIN_DATA) return null;
  const sessionId = input?.session_id;
  if (typeof sessionId !== "string" || sessionId.length === 0 || sessionId.length > 4096) return null;
  const key = createHash("sha256").update(sessionId).digest("hex").slice(0, 24);
  return join(env.CLAUDE_PLUGIN_DATA, "completion-guard", `${key}.json`);
}

function validCompletionGuardState(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    && typeof value.armed === "boolean"
    && Number.isInteger(value.stopBlocks) && value.stopBlocks >= 0;
}

async function saveCompletionGuardState(path, state) {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function loadCompletionGuardState(path) {
  try {
    const state = JSON.parse(await readFile(path, "utf8"));
    return validCompletionGuardState(state) ? state : null;
  } catch (error) {
    if (error?.code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
}

function taskCapsulePath(cwd, pluginData) {
  const workspace = createHash("sha256").update(cwd).digest("hex").slice(0, 24);
  return join(pluginData, "capsules", `${workspace}.json`);
}

async function saveTaskCapsule(cwd, pluginData, capsule) {
  const path = taskCapsulePath(cwd, pluginData);
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await mkdir(join(pluginData, "capsules"), { recursive: true });
  try {
    await writeFile(temporary, `${JSON.stringify(capsule)}\n`, { mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function removeTaskCapsule(cwd, pluginData) {
  await rm(taskCapsulePath(cwd, pluginData), { force: true });
}

async function loadTaskCapsule(cwd, pluginData) {
  try {
    const capsule = JSON.parse(await readFile(taskCapsulePath(cwd, pluginData), "utf8"));
    if (!capsule || typeof capsule !== "object" || Array.isArray(capsule)) return null;
    if (TASK_CAPSULE_FIELDS.some((field) => typeof capsule[field] !== "string" || !capsule[field])) return null;
    return Object.fromEntries(
      TASK_CAPSULE_FIELDS.map((field) => [field, sanitizeCapsuleValue(capsule[field])]),
    );
  } catch (error) {
    if (error?.code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
}
