import { readFile } from "node:fs/promises";
import { join } from "node:path";

// Every launcher shares one Claude home, so a `/model` pick saved as default
// inside an airclaude session lands in the global settings.json that plain
// `claude` and `claude-sub` read too. Claude Code stores the opaque CCR route
// id there, which nothing but the AirKit gateway can serve.

// Resolved from the launch env alone: an env without a Claude home (only a
// test builds one) has no settings file to inherit.
export function globalSettingsPath(env = process.env) {
  const home = env.CLAUDE_CONFIG_DIR || (env.HOME && join(env.HOME, ".claude"));
  return home ? join(home, "settings.json") : null;
}

export async function readGlobalModel(env = process.env, readText = (path) => readFile(path, "utf8")) {
  const path = globalSettingsPath(env);
  if (!path) return null;
  let settings;
  try {
    settings = JSON.parse(await readText(path));
  } catch {
    return null;
  }
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) return null;
  if (typeof settings.model !== "string" || settings.model.trim() === "") return null;
  return { path, model: settings.model };
}

// Returns why `model` can only be served through CCR, or null when it is an id
// Anthropic itself accepts. `ccrOnlyIds` are the catalog's provider model ids.
export function ccrOnlyModelReason(model, ccrOnlyIds = []) {
  const bare = String(model).trim().replace(/\[1m\]$/i, "");
  if (/claude-ccr-h[0-9a-f]+/i.test(bare)) return "a CCR route id";
  if (/(^|-)airkit-mode$/i.test(bare)) return "the AirKit launcher model id";
  if (/[/,]/.test(bare)) return "a provider-prefixed CCR route";
  const lower = bare.toLowerCase();
  if (ccrOnlyIds.some((id) => String(id).toLowerCase() === lower)) return "a CCR provider model";
  return null;
}

// Provider model ids from the catalog that Anthropic does not serve itself.
export function catalogCcrOnlyModelIds(catalog) {
  const ids = new Set();
  for (const provider of catalog?.modelCatalog?.providers ?? []) {
    for (const model of provider?.models ?? []) if (typeof model?.id === "string") ids.add(model.id);
  }
  for (const profile of catalog?.profiles ?? []) {
    for (const provider of profile?.ccr?.Providers ?? []) {
      for (const id of provider?.models ?? []) if (typeof id === "string") ids.add(id);
    }
  }
  return [...ids].filter((id) => !/^claude-/i.test(id));
}

// Claude Code takes the model from --model, then ANTHROPIC_MODEL, then the
// local, project and user settings in that order. Anything above the user
// layer already outranks the shared settings.json, so overriding it with
// `--model default` would discard a legitimate choice. A CCR-only value up
// there is no choice to protect, so it does not count.
export async function higherModelSource({ env = process.env, cwd = process.cwd(), readText = (path) => readFile(path, "utf8"), ccrOnlyIds = [] } = {}) {
  if (env.ANTHROPIC_MODEL && !ccrOnlyModelReason(env.ANTHROPIC_MODEL, ccrOnlyIds)) return "ANTHROPIC_MODEL";
  if (!cwd) return null;
  for (const name of ["settings.local.json", "settings.json"]) {
    const path = join(cwd, ".claude", name);
    if (path === globalSettingsPath(env)) continue;
    try {
      const settings = JSON.parse(await readText(path));
      const model = settings?.model;
      if (typeof model === "string" && model.trim() !== "" && !ccrOnlyModelReason(model, ccrOnlyIds)) return path;
    } catch {}
  }
  return null;
}

export function hasModelArg(args = []) {
  return args.some((arg) => arg === "--model" || String(arg).startsWith("--model="));
}

export async function inspectGlobalModel({ env = process.env, readText, ccrOnlyIds = [] } = {}) {
  const found = await readGlobalModel(env, readText);
  if (!found) return null;
  const reason = ccrOnlyModelReason(found.model, ccrOnlyIds);
  return reason ? { ...found, reason } : null;
}

export function globalModelWarning(leak, neutralized) {
  const effect = neutralized
    ? "this launch overrides it with --model"
    : "any launch without --model would request it";
  return `airkit: ${leak.path} sets "model": "${leak.model}", ${leak.reason} that only the AirKit gateway can serve; ${effect}. Fix: remove the "model" key from ${leak.path}, or pick a real model with /model in plain claude.\n`;
}

// `--model` outranks ANTHROPIC_MODEL and every settings layer, and the value
// `default` resolves to Claude Code's own default model, so prepending it
// overrides the stored id for this launch only without touching the file.
// Prepended so it stays a root option ahead of any subcommand or `--`.
export async function neutralizeGlobalModel({ args = [], env = process.env, cwd, readText, ccrOnlyIds = [], stderr } = {}) {
  if (hasModelArg(args)) return { args, leak: null };
  const leak = await inspectGlobalModel({ env, readText, ccrOnlyIds });
  if (!leak || await higherModelSource({ env, cwd, readText, ccrOnlyIds })) return { args, leak: null };
  stderr?.write(globalModelWarning(leak, true));
  return { args: ["--model", "default", ...args], leak };
}
