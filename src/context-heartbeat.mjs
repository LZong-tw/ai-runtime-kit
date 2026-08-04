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
const COMPLETION_GUARD_REASON = "Continue working when safe; do not stop after partial completion.";

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

  await saveCompletionGuardState(statePath, { armed: false, stopBlocks: state.stopBlocks + 1 });
  return { decision: "block", reason: COMPLETION_GUARD_REASON };
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
