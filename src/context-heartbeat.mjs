import { join } from "node:path";

export const HEARTBEAT_CONTEXT_LIMIT = 512;

function boundedLabel(value, fallback = "unset") {
  if (typeof value !== "string" || value.length === 0) return fallback;
  return value.replaceAll(/[^A-Za-z0-9._+:[\]/-]+/g, "_").slice(0, 80) || fallback;
}

export function buildHeartbeatResponse(input, env = process.env) {
  if (!env.AIRCLAUDE_PROFILE || input?.hook_event_name !== "UserPromptSubmit") return null;

  const context = [
    "AirClaude session context is active.",
    `Current routing mode is ${boundedLabel(env.AIRCLAUDE_MODE)}.`,
    `The default model is ${boundedLabel(env.AIRCLAUDE_ROUTE_DEFAULT_MODEL)}.`,
    `The background model is ${boundedLabel(env.AIRCLAUDE_ROUTE_BACKGROUND_MODEL)}.`,
    "Claude's displayed model is compatibility metadata, not proof of active provider routing.",
    "Durable task state consists of the current objective, accepted constraints and decisions, changed files, verification and repository state, and next action.",
  ].join(" ").slice(0, HEARTBEAT_CONTEXT_LIMIT);

  return {
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: context,
    },
  };
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

  const response = buildHeartbeatResponse(hookInput, env);
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
    description: "Adds bounded AirClaude route and task-state context beside new prompts",
    hooks: {
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
