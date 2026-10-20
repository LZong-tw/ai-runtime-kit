import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { claudeFamilyLane } from "./compat/config.mjs";

// Claude Code reads settings.modelSettings[<id>].autoCompactWindow from 2.1.296.
export const PER_MODEL_AUTOCOMPACT_MIN_VERSION = [2, 1, 296];

const MIN_WINDOW = 100_000;
const MAX_WINDOW = 1_000_000;
// Claude Code reserves min(maxOutput, 20000) for the summary and fires
// 13000 tokens below the remaining effective window.
const SUMMARY_RESERVE_CAP = 20_000;
const TRIGGER_BUFFER = 13_000;
const DEFAULT_MAX_OUTPUT = 20_000;

// Current /model ids per family. Ids outside this list still land on the
// top-level window, which is the smallest lane window, so they compact early
// rather than late.
const FAMILY_CLIENT_IDS = Object.freeze([
  "claude-opus-5-5",
  "claude-opus-5",
  "claude-sonnet-5-5",
  "claude-sonnet-5",
  "claude-haiku-5-5",
  "claude-haiku-4-5",
]);

export function validateAutoCompactEntry(label, value) {
  if (value === undefined) return;
  const keys = value && typeof value === "object" && !Array.isArray(value) ? Object.keys(value) : [];
  if (keys.length !== 1 || !["window", "ratio"].includes(keys[0])) {
    throw new Error(`${label}.autoCompact must be { "window": <int>|"auto" } or { "ratio": <number> }`);
  }
  if (keys[0] === "window") {
    const window = value.window;
    if (window !== "auto" && (!Number.isInteger(window) || window < MIN_WINDOW)) {
      throw new Error(`${label}.autoCompact.window must be "auto" or an integer of at least ${MIN_WINDOW}`);
    }
    return;
  }
  if (typeof value.ratio !== "number" || !(value.ratio > 0 && value.ratio <= 1)) {
    throw new Error(`${label}.autoCompact.ratio must be a number in (0, 1]`);
  }
}

// The window whose threshold equals the PCT threshold floor(eff * ratio);
// ratio * contextWindow would land 33K lower.
function ratioWindow(ratio, contextWindow, maxOutput) {
  const reserve = Math.min(maxOutput, SUMMARY_RESERVE_CAP);
  return Math.floor((contextWindow - reserve) * ratio) + reserve + TRIGGER_BUFFER;
}

export function laneWindow(entry, label) {
  const policy = entry?.autoCompact;
  if (policy === undefined || policy.window === "auto") return null;
  const contextWindow = Number.isInteger(entry.contextWindow) && entry.contextWindow > 0 ? entry.contextWindow : null;
  let window;
  if (policy.ratio !== undefined) {
    if (contextWindow === null) throw new Error(`${label}.autoCompact.ratio needs a contextWindow`);
    const maxOutput = Number.isInteger(entry.maxOutputTokens) ? entry.maxOutputTokens : DEFAULT_MAX_OUTPUT;
    window = ratioWindow(policy.ratio, contextWindow, maxOutput);
  } else {
    window = policy.window;
  }
  if (window < MIN_WINDOW) {
    throw new Error(`${label}.autoCompact resolves to ${window}, below the ${MIN_WINDOW} floor`);
  }
  return Math.min(window, MAX_WINDOW, contextWindow ?? MAX_WINDOW);
}

function versionAtLeast(version, minimum) {
  const match = String(version ?? "").match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) return false;
  const parts = match.slice(1).map(Number);
  for (let index = 0; index < minimum.length; index += 1) {
    if (parts[index] !== minimum[index]) return parts[index] > minimum[index];
  }
  return true;
}

function clientKey(model) {
  return model.replace(/\[1m\]$/i, "");
}

// lookupEntry(route) returns the catalog model entry serving a "provider,model"
// route, or null.
export function resolveAutoCompactPolicy({ enabled, binaryEligible, claudeCodeVersion, router, launchModel, lookupEntry, label }) {
  if (!enabled) return { status: "inactive", reason: "flag off" };
  if (!binaryEligible) return { status: "inactive", reason: "launch binary is not claude" };
  if (!claudeCodeVersion) return { status: "inactive", reason: "Claude Code version unknown" };
  if (!versionAtLeast(claudeCodeVersion, PER_MODEL_AUTOCOMPACT_MIN_VERSION)) {
    return { status: "inactive", reason: `Claude Code ${claudeCodeVersion} predates modelSettings (needs ${PER_MODEL_AUTOCOMPACT_MIN_VERSION.join(".")})` };
  }

  const lanes = {};
  for (const lane of ["default", "opus", "sonnet", "background"]) {
    const route = router?.[lane] ?? router?.default;
    if (typeof route !== "string") continue;
    lanes[lane] = { route, window: laneWindow(lookupEntry(route), `${label} ${lane} lane (${route})`) };
  }

  const byModel = {};
  const assign = (id, lane) => {
    const window = lanes[lane]?.window;
    if (window != null) byModel[clientKey(id)] = { lane, window };
  };
  if (typeof launchModel === "string" && launchModel !== "") assign(launchModel, "default");
  for (const id of FAMILY_CLIENT_IDS) assign(id, claudeFamilyLane(id));

  const windows = Object.values(byModel).map(({ window }) => window);
  if (windows.length === 0) return { status: "inactive", reason: "no lane has an autoCompact policy" };
  const fallbackWindow = Math.min(...windows);
  const settings = {
    env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: "", CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "100" },
    autoCompactWindow: fallbackWindow,
    modelSettings: Object.fromEntries(
      Object.entries(byModel).map(([id, { window }]) => [id, { autoCompactWindow: window }]),
    ),
  };
  const policyGeneration = createHash("sha256")
    .update(JSON.stringify({ byModel: Object.entries(byModel).sort(), fallbackWindow, claudeCodeVersion }))
    .digest("hex")
    .slice(0, 12);
  return { status: "active", policyGeneration, lanes, byModel, fallbackWindow, settings };
}

// The part of every request a session can never compact away, measured with
// o200k on Claude Code 2.1.304: system prompt, built-in tool schemas, sandbox
// and environment notes, the deferred-tool, agent, MCP and skills listings,
// and the git/memory/attribution reminders. Instruction files and the AirKit
// append are estimated per launch below because they vary by workspace.
export const CLAUDE_CODE_FIXED_BASELINE = 20_000;
// Warn once the fixed floor takes more than this share of a lane's compaction
// threshold: past it, a compacted session starts with too little room left.
export const THRASH_SHARE = 0.25;
const CHARS_PER_TOKEN = 3.5;

function instructionFiles(cwd, home) {
  const files = [join(home, ".claude", "CLAUDE.md")];
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    files.push(join(dir, "CLAUDE.md"), join(dir, ".claude", "CLAUDE.md"), join(dir, "CLAUDE.local.md"));
    if (dir === home || dir === dirname(dir)) break;
  }
  const slug = resolve(cwd).replace(/[^a-zA-Z0-9]/g, "-");
  files.push(join(home, ".claude", "projects", slug, "memory", "MEMORY.md"));
  return files;
}

export function estimateFixedContext({ appendPrompt = "", cwd = process.cwd(), home = homedir(), readFile = readFileSync } = {}) {
  let chars = appendPrompt.length;
  for (const file of new Set(instructionFiles(cwd, home))) {
    try {
      chars += readFile(file, "utf8").length;
    } catch {
      // absent files cost nothing
    }
  }
  return CLAUDE_CODE_FIXED_BASELINE + Math.ceil(chars / CHARS_PER_TOKEN);
}

export function compactionThreshold(window, maxOutput = DEFAULT_MAX_OUTPUT) {
  return window - Math.min(maxOutput, SUMMARY_RESERVE_CAP) - TRIGGER_BUFFER;
}

export function thrashWarnings(byModel, fixedTokens, maxOutput) {
  const warned = new Map();
  for (const [id, { lane, window }] of Object.entries(byModel)) {
    const threshold = compactionThreshold(window, maxOutput);
    if (fixedTokens <= threshold * THRASH_SHARE || warned.has(lane)) continue;
    const share = Math.round((fixedTokens / threshold) * 100);
    warned.set(lane, `${lane} lane (${id}): fixed context ~${fixedTokens} tokens is ${share}% of its ${threshold}-token compaction threshold; sessions will compact repeatedly`);
  }
  return [...warned.values()];
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function deepMerge(base, overlay) {
  const merged = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    merged[key] = isPlainObject(value) && isPlainObject(merged[key]) ? deepMerge(merged[key], value) : value;
  }
  return merged;
}

function parseSettingsValue(value, readFile) {
  const trimmed = String(value).trim();
  let text = trimmed;
  if (!trimmed.startsWith("{")) {
    try {
      text = readFile(trimmed, "utf8");
    } catch (error) {
      throw new Error(`cannot read --settings file ${trimmed}: ${error.message}`);
    }
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`--settings ${trimmed.startsWith("{") ? "JSON" : `file ${trimmed}`} is not valid JSON: ${error.message}`);
  }
  if (!isPlainObject(parsed)) throw new Error("--settings must be a JSON object");
  return parsed;
}

function extractSettings(args, readFile) {
  const rest = [];
  const found = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = String(args[index]);
    if (arg === "--settings" && index + 1 < args.length) {
      found.push(parseSettingsValue(args[index + 1], readFile));
      index += 1;
    } else if (arg.startsWith("--settings=")) {
      found.push(parseSettingsValue(arg.slice("--settings=".length), readFile));
    } else {
      rest.push(args[index]);
    }
  }
  return { rest, found };
}

// True when the args already choose an autocompact window, either with
// --autocompact or through a --settings key the per-model policy would
// overwrite. The policy then stands down rather than silently winning.
export function userSetsAutoCompact(args, readFile = readFileSync) {
  if (args.some((arg) => arg === "--autocompact" || String(arg).startsWith("--autocompact="))) return true;
  return extractSettings(args, readFile).found.some((settings) =>
    settings.autoCompactWindow !== undefined
    || settings.env?.CLAUDE_CODE_AUTO_COMPACT_WINDOW !== undefined
    || settings.env?.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE !== undefined
    || Object.values(isPlainObject(settings.modelSettings) ? settings.modelSettings : {})
      .some((entry) => entry?.autoCompactWindow !== undefined));
}

// Claude Code keeps only one --settings value, so every source collapses into
// a single object: launcher args first, then user args, then AirKit's keys.
export function collapseSettingsArgs(headArgs, tailArgs, airkitSettings, readFile = readFileSync) {
  if (!airkitSettings) return { head: headArgs, tail: tailArgs };
  const head = extractSettings(headArgs, readFile);
  const tail = extractSettings(tailArgs, readFile);
  const merged = [...head.found, ...tail.found, airkitSettings].reduce((acc, next) => deepMerge(acc, next), {});
  return { head: [...head.rest, "--settings", JSON.stringify(merged)], tail: tail.rest };
}
