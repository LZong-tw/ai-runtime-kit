// Non-Claude model education hooks (spec 2026-10-15, §4.3–§5).
//
// Every rule is evaluated and logged to airkit-education.jsonl. A rule only
// changes what Claude Code sees when its level — a per-rule override, else its
// group flag — is "enforce" and, for the model-gated rules, the acting model is
// not Claude.
// Anything unexpected — bad flags, unreadable transcripts, state races — is
// logged and the hook lets the call through.
import { createHash } from "node:crypto";
import { appendFile, mkdir, open, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { classifyEarlyFinal, earlyFinalReason } from "./early-final.mjs";

export const EDUCATION_ENV = Object.freeze({
  spawnGuard: "AIRCLAUDE_EDUCATION_SPAWN_GUARD",
  subagentReport: "AIRCLAUDE_EDUCATION_SUBAGENT_REPORT",
  subagentNudge: "AIRCLAUDE_EDUCATION_SUBAGENT_NUDGE",
  errorHints: "AIRCLAUDE_EDUCATION_ERROR_HINTS",
  sameResultPoll: "AIRCLAUDE_EDUCATION_SAME_RESULT_POLL",
  cliFlagGuess: "AIRCLAUDE_EDUCATION_CLI_FLAG_GUESS",
  blockedRetry: "AIRCLAUDE_EDUCATION_BLOCKED_RETRY",
  sameTargetRepeat: "AIRCLAUDE_EDUCATION_SAME_TARGET_REPEAT",
  earlyFinal: "AIRCLAUDE_EDUCATION_EARLY_FINAL",
});
export const EDUCATION_DEFAULTS = Object.freeze({
  spawnGuard: "shadow",
  subagentReport: "shadow",
  subagentNudge: "shadow",
  errorHints: false,
  sameResultPoll: "shadow",
  cliFlagGuess: "shadow",
  blockedRetry: "shadow",
  sameTargetRepeat: "shadow",
  earlyFinal: "shadow",
});
// Hook scripts rendered before rule set 6 (8 for sameTargetRepeat) never set
// these, so unset means the default rather than a config error.
const LATER_FLAGS = new Set(["sameResultPoll", "cliFlagGuess", "blockedRetry", "sameTargetRepeat", "earlyFinal"]);
// Rules that can be switched one by one (launch.education.rules), keyed by the
// rule name the log uses, mapped to the group flag they fall back to.
// Log-only records (status-log, spawn-allow, …) follow their group.
export const EDUCATION_RULES = Object.freeze({
  D1: "spawnGuard",
  D2: "spawnGuard",
  D3: "spawnGuard",
  D4: "spawnGuard",
  "status-missing": "subagentReport",
  "poll-nudge": "subagentNudge",
  "subagent-cut": "subagentNudge",
  "unread-result": "subagentNudge",
  "running-note": "subagentNudge",
  "repeat-failure": "errorHints",
  "bash-enoent": "errorHints",
  "edit-mismatch": "errorHints",
  "read-missing": "errorHints",
  "same-result-poll": "sameResultPoll",
  "cli-flag-guess": "cliFlagGuess",
  "blocked-retry": "blockedRetry",
  "same-target-repeat": "sameTargetRepeat",
  "early-final": "earlyFinal",
  "phantom-wait": "earlyFinal",
});
export const EDUCATION_RULES_ENV = "AIRCLAUDE_EDUCATION_RULES";
export const EARLY_FINAL_MODELS_ENV = "AIRCLAUDE_EDUCATION_EARLY_FINAL_MODELS";
export const EARLY_FINAL_MODELS = Object.freeze(["^gpt-"]);
export const EARLY_FINAL_MAX_BLOCKS = 2;
export const EDUCATION_EVENTS = Object.freeze([
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "SubagentStart",
  "SubagentStop",
  "Stop",
  "SessionStart",
  "PostCompact",
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
// Loop rules (rule set 6, model-complaint report 2026-11-05 §5).
const LOOP_WINDOW_MS = 10 * 60_000;
const MAX_ACTORS = 20;
const SAME_RESULT_LIMIT = 5;
const SAME_RESULT_TOOLS = new Set(["Bash", "Read", "Grep", "Glob", "WebFetch", "WebSearch"]);
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const EMPTY_RESULT = /^(?:\(Bash completed with no output\)|No matches found|No files found)/;
// Commands that are waiting on purpose return the same thing until they stop.
// `watch` also matches `--watch`; kubectl's short `-w` is tied to kubectl
// because `grep -w` is a word match.
const WAITING_COMMAND = /\b(?:sleep|wait|watch|rollout status)\b|\bkubectl\b[^|;&\n]*\s-w(?=\s|$)/;
const CLI_GUESS_LIMIT = 3;
const CLI_ARG_ERROR = new RegExp([
  String.raw`\b(?:unknown|unrecognized|unexpected|invalid) (?:option|flag|argument|command|subcommand|choice)`,
  String.raw`flag provided but not defined`,
  String.raw`\bno such option\b`,
  String.raw`missing required (?:argument|option|flag)`,
  String.raw`\boption requires an argument\b`,
  String.raw`not configured\b`,
  "未配置",
].join("|"), "i");
// A usage banner counts only when the command failed: a README or a log that
// prints one is not an argument error.
const USAGE_LINE = /^\s*usage:/im;
// Their output is file content, so it says nothing about their own flags
// unless they failed.
const READERS = new Set(["cat", "head", "tail", "less", "sed", "awk", "grep", "rg", "jq", "echo", "printf"]);
const HELP_FLAG = /(?:^|\s)(?:--help|-h|help)(?=\s|$)/;
// `--help | head` shows the first screen only, which is how flags get guessed.
const PARTIAL_READ = /\|\s*(?:head|tail|grep|rg)\b/;
// Bash failures the sandbox causes. Retrying them unchanged fails the same way.
const SANDBOX_DENIAL = /Operation not permitted|\bEPERM\b|<sandbox_violations>/;
const SHELL_PREFIX = new RegExp(String.raw`^\s*(?:(?:cd|source|\.)\s+(?:"[^"]*"|'[^']*'|\S+)\s*(?:&&|;|\n)\s*|export\s+[^;&\n]*(?:&&|;|\n)\s*|[A-Za-z_]\w*=(?:"[^"]*"|'[^']*'|\S*)\s+|(?:env|command|time|exec|sudo)\s+|aws-vault\s+exec\s+\S+\s+--\s+)`);
const LEADING_CD = /^(?:\s*cd\s+(?:"[^"]*"|'[^']*'|\S+)\s*(?:&&|;)\s*)+/;
const SAME_RESULT_HINT = "結果一直沒變，來源可能在上游：去查是誰設定這個值，或先停下來回報";
const CLI_FLAG_HINT = "先讀完整的 `--help` 再試";
const BLOCKED_RETRY_HINT = "同樣的指令會再被擋：改用 unsandboxed，或停下來告訴使用者";
// same-target-repeat (rule set 8, kimi-loop report 2026-11-09 option 1).
const SAME_INPUT_LIMIT = 3;
const SAME_ID_LIMIT = 5;
const MAX_TARGETS = 200;
const ID_WORD_SPLIT = /[\s'"`=,;|&()<>{}[\]$\\]+/;
const SHELL_SEGMENT = /\|\||&&|[|;\n]/;
// Paths, URLs and scoped npm packages (`@scope/name`).
const PATH_WORD = /^(?:~|\.{1,2})?\/|:\/\/|\/[^/]*\/|^@[\w.-]+\//;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
// `#ff0000ff` is a colour, not a commit.
const HASH_COLOUR = /#[0-9a-f]+/gi;
// git commands that change the work tree, index or refs. Re-reading after one
// is progress, like after an edit.
const GIT_CHANGE = /\bgit\s+(?:(?:-C|-c)\s+\S+\s+|--?[\w-]+(?:=\S*)?\s+)*(?:add|am|apply|checkout|cherry-pick|commit|fetch|merge|mv|pull|rebase|reset|restore|revert|rm|stash|switch)\b/;
// Hex with at least one digit and one letter: commit, image digest, hash.
const HEX_ID = /^(?=[a-f]*\d)(?=\d*[a-f])[0-9a-f]{7,64}$/;
// Kubernetes name hashes (ReplicaSet pod-template-hash) use this alphabet.
const K8S_HASH = /^(?=[b-df-hj-np-tv-xz]*[24-9])(?=[24-9]*[b-df-hj-np-tv-xz])[b-df-hj-np-tv-xz24-9]{8,10}$/;
const SAME_TARGET_HINT = "同一個目標已經反覆查了好幾次：先退一步，去找上游決定這個值的來源（設定、manifest、部署紀錄），不要再重查同一個地方";
// Built-in agent types. Anything else may be a workflow or plugin agent whose
// prompt contract is unknown, so SubagentStop only logs for it (§4.4.2 rule 2).
const KNOWN_AGENT_TYPES = new Set([
  "general-purpose",
  "Explore",
  "Plan",
  "statusline-setup",
  "claude-code-guide",
  "output-style-setup",
  "fork",
]);
const READ_ONLY_AGENT_TYPES = new Set(["Explore", "Plan", "claude-code-guide"]);
const FAN_OUT = /平行|並行|同時|分頭|各自|多個\s*reviewer|in parallel|parallel(?:ize|ly)?|fan[- ]?out|每個.{0,40}都|subagents?|workflow|teammates?|子代理/i;
const BROAD_SEARCH = /search|find|locate|explore|survey|scan|grep|look (?:for|through)|搜尋|找出|盤點|調查/i;
const LIST_LINE = /^\s*(?:[-*•]|\d+[.)、])\s+\S/;
// The user asked for a plan only, or to hold until they say go: an early-final
// block must not push the model into implementing it.
const PLAN_ONLY = /不要動手|別動手|先不要(?:動手|改|修|實作|執行)|不要(?:改|修改)(?:程式|code)|只要計畫|只給計畫|先給我計畫|計畫就好|等我說\s*go|\bplan only\b|\bjust (?:the|a) plan\b|\b(?:don['’]t|do not) (?:change|edit|touch|implement|modify|write) (?:any|the|code|files?)|\bno code (?:yet|changes)\b|\bwait for my (?:go|ok|approval)\b/i;
const ITEM_TOKEN = /(?:!\d+|#\d+|\b[A-Z][A-Z0-9]+-\d+\b|(?:~|\.{1,2})?\/[\w.@-]+(?:\/[\w.@-]+)+)/g;
// Only an output instruction counts as a fixed format. The 44e50e8 pattern
// matched any "verbatim", "schema" or ".json" path anywhere in the prompt, so
// the replay (internal reports/model-perf) found most "fixed-format" records
// were workflow preambles and file names.
// Rule set 2 let "schema"/"JSON" sit anywhere within 100 characters of the
// verb ("Return to the main branch and check the schema") and dropped the
// zh-TW "以 JSON 格式回傳" forms rule set 1 caught. Now the verb and the format
// must share a clause and the format must be what is returned.
// Rule set 4: a verb used as a noun ("Parse the output JSON") is not an
// instruction, so the verb may not follow an article or possessive.
const OUTPUT_VERB = String.raw`(?<!\b(?:the|a|an|its|their|your|our|this|that|parse|parsed|of)\s+)(?:return|output|respond|reply|answer|emit|print)\b`;
const SAME_CLAUSE = String.raw`[^\n.;:!?。；：！？]{0,60}?`;
const JSON_WORD = String.raw`(?<![\w./-])json(?![\w-]|\.\w)`;
const ZH_OUTPUT_VERB = "(?:回傳|回覆|回應|輸出|產出|返回)";
const FIXED_FORMAT = new RegExp(
  [
    `${OUTPUT_VERB}(?:\\s+(?:a|an|the|only|valid|raw|strict|pure))*\\s+${JSON_WORD}`,
    `${OUTPUT_VERB}${SAME_CLAUSE}\\b(?:as|in|with|using)\\s+(?:(?:a|an|the|only|valid|raw|strict|this|that|following)\\s+)*(?:${JSON_WORD}|schema\\b(?!\\s+(?:link|url|file|path|docs?|version|migration|change|id)\\b))`,
    `${OUTPUT_VERB}${SAME_CLAUSE}\\bonly\\s+(?:valid\\s+)?${JSON_WORD}`,
    `${OUTPUT_VERB}${SAME_CLAUSE}(?:exactly this format|\\bverbatim\\b)`,
    // "The config must be valid JSON" describes a file; only the reply's own
    // format is an instruction. A bare "accepts JSON only" no longer counts.
    `\\b(?:answer|reply|response|output)\\s+(?:must|should)\\s+be\\s+(?:valid\\s+)?${JSON_WORD}`,
    // "回傳 JSON" / "輸出成 JSON", not "API 回傳的 JSON".
    `${ZH_OUTPUT_VERB}\\s*(?:成|為)?\\s*(?:純|合法的?|一個|一份)?\\s*${JSON_WORD}`,
    `(?:以|用)\\s*${JSON_WORD}\\s*(?:格式)?[^\\n。；！？]{0,8}?${ZH_OUTPUT_VERB}`,
    "原文照錄|原樣輸出|逐字輸出|只輸出|固定格式|照下列格式",
  ].join("|"),
  "i",
);
const STATUS_ASK = /\bSTATUS:/;
const STATUS_LINE = /^\s*\**STATUS\**\s*:/m;
// Claude Code's permission denials, seen in real transcripts (2026-07..11):
//   Permission for this action was denied by the Claude Code auto mode classifier. Reason: ...
//   Permission for this action has been denied. Reason: Stage 2 classifier error - ...
//   Permission to use <Tool> [with command ...] has been denied.
//   Permission for this command was denied by a built-in Claude Code safety check ...
//   Permission for this tool use was denied. The tool use was rejected ...
//   Auto mode could not evaluate this action and is blocking it for safety ...
//   <model> is temporarily unavailable, so auto mode cannot determine the safety of <Tool> ...
//   The user doesn't want to proceed with this tool use. The tool use was rejected ...
// Anchored at the start of the error (after an optional "Error: "), not at any
// line start, so Bash output that prints one of these sentences on a later
// line is not a denial.
const USER_DENIAL = /^[ \t]*(?:Error:[ \t]*)?The user doesn't want to proceed with this tool use\b/;
const PERMISSION_DENIAL = /^[ \t]*(?:Error:[ \t]*)?(?:Permission for this (?:action|command|tool use) (?:was|has been) denied|Permission to use \S+(?: with command [\s\S]{0,4000}?)? has been denied|Auto mode could not evaluate this action|\S+ is temporarily unavailable\b[^\n]*\bso auto mode cannot determine)/;
// The classifier itself says these clear on retry, so they must not mark a
// spawn as rejected for good.
const TRANSIENT_DENIAL = /usually transient|Stage 2 classifier error|Auto mode could not evaluate|temporarily unavailable/i;
// A Bash ENOENT is a cwd/path mistake only when the line reporting it names a
// path and the error is not really a sandbox, permission or missing-command
// failure. Rule set 2 took a path or quoted string from anywhere in the
// output, so stray echo/test lines counted, and missed zsh's lowercase
// "cd: no such file or directory: /nope".
const BASH_ENOENT = /No such file or directory|ENOENT/i;
const BASH_NOT_PATH = /Operation not permitted|EPERM|sandbox|command not found|Permission denied/i;
const BASH_PATH_ON_LINE = new RegExp(
  [
    // ls: foo: No such file or directory
    // (but not "Error: ENOENT: no such file or directory")
    String.raw`(?<!\S)(?!(?:Error|ENOENT)\b)[^\s:]+:\s*(?!(?:Error|ENOENT)\b)[^\s:]+:\s*No such file or directory`,
    // rg/jq: "dir/x": No such file ..., Could not open file /tmp/x.json: No such file ...
    String.raw`(?:['"\x60][^'"\x60\n]+['"\x60]|[^\s:'"\x60]*[/.][^\s:'"\x60]*):\s*No such file or directory`,
    // zsh cd, Python: no such file or directory: /nope
    // ("no" in "ENOENT: no such file or directory" is not a path)
    String.raw`(?:ENOENT|No such file or directory)\s*:\s*(?!no such file\b)[^\s:,]+`,
    // Node: ENOENT: no such file or directory, open '/tmp/foo'
    String.raw`(?:ENOENT|No such file or directory)[^\n]*?\b(?:open|stat|lstat|scandir|access|unlink|mkdir|rmdir|rename|chdir|realpath)\s+['"\x60]?[^\s'"\x60]+`,
  ].join("|"),
  "i",
);
const NPM_ENOENT_PATH = /^npm (?:error|ERR!) path \S+/m;
// Bumped whenever a rule's matching changes, so a shadow window can be read
// from one rule set only (education report --rules).
export const EDUCATION_RULES_VERSION = 8;
const STATUS_REASON = "Finish your reply with the report the task asked for: STATUS: done|blocked|partial, EVIDENCE: <paths/commands>, OPEN: <items>.";

export function readEducationConfig(env = process.env) {
  const config = {};
  const errors = [];
  for (const [key, name] of Object.entries(EDUCATION_ENV)) {
    const raw = env[name];
    if (key === "errorHints") {
      if (raw === "true" || raw === "false") config[key] = raw === "true";
      else if (LEVELS.has(raw)) config[key] = raw;
      else {
        config[key] = false;
        errors.push(`${name}=${raw === undefined ? "<unset>" : JSON.stringify(raw)}`);
      }
      continue;
    }
    if (LEVELS.has(raw)) config[key] = raw;
    else if (raw === undefined && LATER_FLAGS.has(key)) config[key] = EDUCATION_DEFAULTS[key];
    else {
      config[key] = "off";
      errors.push(`${name}=${raw === undefined ? "<unset>" : JSON.stringify(raw)}`);
    }
  }
  config.rules = readRuleOverrides(env[EDUCATION_RULES_ENV], errors);
  const models = earlyFinalModelSources(env);
  if (models === null) errors.push(`${EARLY_FINAL_MODELS_ENV}=${JSON.stringify(String(env[EARLY_FINAL_MODELS_ENV]).slice(0, 200))}`);
  config.earlyFinalModels = models ?? [];
  return { config, errors };
}

// Hook scripts rendered before per-rule switches never set the env, so unset
// is not an error. A bad override turns that rule off; bad JSON drops them all.
function readRuleOverrides(raw, errors) {
  const rules = {};
  if (raw === undefined) return rules;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    errors.push(`${EDUCATION_RULES_ENV}=${JSON.stringify(String(raw).slice(0, 200))}`);
    return rules;
  }
  for (const [rule, level] of Object.entries(parsed)) {
    if (!Object.hasOwn(EDUCATION_RULES, rule)) {
      errors.push(`${EDUCATION_RULES_ENV}.${rule} (unknown rule)`);
    } else if (LEVELS.has(level)) {
      rules[rule] = level;
    } else {
      rules[rule] = "off";
      errors.push(`${EDUCATION_RULES_ENV}.${rule}=${JSON.stringify(level)}`);
    }
  }
  return rules;
}

// A per-rule override wins over its group. errorHints=false has always logged
// without emitting, so it reads as shadow here.
// phantom-wait trusts the hook's view of background work, which misses shells
// and tasks the Stop payload does not list, so it only enforces when it is
// switched on by name; group enforce leaves it in shadow.
const EXPLICIT_ENFORCE = new Set(["phantom-wait"]);

function ruleLevel(config, rule) {
  const own = config.rules?.[rule];
  let level = own ?? config[EDUCATION_RULES[rule]];
  if (level === true) level = "enforce";
  if (level === false) level = "shadow";
  if (own === undefined && level === "enforce" && EXPLICIT_ENFORCE.has(rule)) return "shadow";
  return level;
}

function ruleOn(config, rule) {
  return ruleLevel(config, rule) !== "off";
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
    planOnly: PLAN_ONLY.test(text),
  };
}

// §4.4.2 rule 3: only an instruction in the last 1-3 non-empty lines counts,
// so a quoted transcript or example that mentions STATUS does not.
export function subagentPromptContract(prompt) {
  const text = typeof prompt === "string" ? prompt : "";
  const tail = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(-3);
  // Rule set 4: the closing STATUS request is the explicit contract; an
  // earlier format phrase must not turn it into fixed-format.
  if (tail.some((line) => STATUS_ASK.test(line) && !/^```/.test(line))) return "status";
  return FIXED_FORMAT.test(text) ? "fixed-format" : "none";
}

function bashNamesMissingPath(error) {
  if (NPM_ENOENT_PATH.test(error)) return true;
  return error.split(/\r?\n/).some((line) => BASH_ENOENT.test(line) && BASH_PATH_ON_LINE.test(line));
}

// The failure event has no stderr of its own: stdout and stderr arrive merged
// after "Exit code N". So only the sandbox's own annotation or a diagnostic
// line counts: one led by a program of the command ("cat: <path>: Operation
// not permitted", npm's "npm error code EPERM" or older "npm ERR!"), by the
// shell (the Bash tool's "(eval):1: operation not permitted: <path>", or a
// script's "zsh:1:"), or by an error label (Go's "error: open ...", Node's
// "Error: EPERM", Python's "PermissionError:"). A line of file content that
// mentions the error, such as grep's "logs/a.log: ...", does not.
const SANDBOX_DENIAL_LINE = /operation not permitted|\bEPERM\b/i;
const DIAGNOSTIC_LABEL = /^\s*(?:(?:(?:ba|z)?sh|\(eval\))(?::\d+)?:|(?:error|fatal|[A-Za-z]*Error)(?:\[[^\]]*\])?:)/i;
const PROGRAM_LABELS = [":", " error ", " ERR! "];
// npx is npm: its errors are led by "npm error", not "npx error".
const DIAGNOSTIC_ALIASES = { npx: ["npx", "npm"] };

function bashSandboxDenied(command, error) {
  if (error.includes("<sandbox_violations>")) return true;
  const programs = String(command ?? "").split(/\|\|?|&&|;|\n/).map(cliProgram).filter(Boolean)
    .flatMap((program) => DIAGNOSTIC_ALIASES[program] ?? [program]);
  return error.split(/\r?\n/).some((line) => SANDBOX_DENIAL_LINE.test(line)
    && (DIAGNOSTIC_LABEL.test(line)
      || programs.some((program) => PROGRAM_LABELS.some((label) => line.startsWith(`${program}${label}`)))));
}

export function errorHint(input, previousFailHash, { blockedRetry = true } = {}) {
  if (input?.is_interrupt === true) return null;
  const tool = input?.tool_name;
  const error = String(input?.error ?? "");
  const callHash = hash([tool, input?.tool_input ?? null]);
  // A permission denial is a decision, not a failed attempt: it gets no hint
  // and must not count toward repeat-failure.
  if (USER_DENIAL.test(error)) return { rule: null, hint: null, callHash, denied: "user" };
  if (PERMISSION_DENIAL.test(error)) return { rule: null, hint: null, callHash, denied: TRANSIENT_DENIAL.test(error) ? "transient" : "final" };
  // A sandbox boundary is a denial too: blocked-retry owns its retries, so
  // repeat-failure must not count them a second time. With blocked-retry off
  // nobody owns them, and repeat-failure keeps counting them as it always did.
  if (blockedRetry && tool === "Bash" && bashSandboxDenied(input?.tool_input?.command, error)) {
    return { rule: null, hint: null, callHash, denied: "sandbox" };
  }
  if (previousFailHash && previousFailHash === callHash) {
    return { rule: "repeat-failure", hint: "Identical failing call repeated; change approach.", callHash };
  }
  if (tool === "Bash" && BASH_ENOENT.test(error) && !BASH_NOT_PATH.test(error) && bashNamesMissingPath(error)) {
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

function emptyEarlyFinal(turn = 0) {
  return { turn, blocks: 0, lastPromiseHash: null, callsAtBlock: -1 };
}

function emptyState() {
  return { turn: 0, prompt: promptFeatures(""), ownCalls: 0, turnCalls: 0, lastFailHash: null, stopBlockedTurn: -1, rejectedSpawns: [], spawns: [], shells: [], blocked: [], helpSeen: [], loops: {}, earlyFinal: emptyEarlyFinal() };
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
  state.blocked = state.blocked.slice(-MAX_SPAWNS);
  state.helpSeen = state.helpSeen.slice(-MAX_SPAWNS);
  state.shells = (state.shells ?? []).slice(-MAX_SPAWNS);
  const actors = Object.keys(state.loops);
  for (const actor of actors.slice(0, Math.max(0, actors.length - MAX_ACTORS))) delete state.loops[actor];
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
    await appendFile(path, `${JSON.stringify({ ts: new Date().toISOString(), rules: EDUCATION_RULES_VERSION, ...record })}\n`);
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

// Identity of a call for the loop rules. Bash ignores its description and a
// leading `cd`, which models change between otherwise identical retries.
function callKey(tool, toolInput) {
  if (tool !== "Bash") {
    const { description, ...rest } = toolInput && typeof toolInput === "object" ? toolInput : {};
    return hash([tool, rest]);
  }
  const command = String(toolInput?.command ?? "").replace(LEADING_CD, "").replace(/\s+/g, " ").trim();
  return hash([tool, command, toolInput?.dangerouslyDisableSandbox === true, toolInput?.allowed_domains ?? null]);
}

// The program a Bash command runs, after cd/env/source prefixes. Heuristic:
// it reads the first pipeline segment only.
export function cliProgram(command) {
  let rest = String(command ?? "");
  for (let index = 0; index < 8; index += 1) {
    const next = rest.replace(SHELL_PREFIX, "");
    if (next === rest) break;
    rest = next;
  }
  const first = rest.split(/\||&&|;|\n/)[0].trim().split(/\s+/)[0] ?? "";
  const name = first.replace(/^["']|["']$/g, "").split("/").pop();
  return /^[\w.@+-]+$/.test(name) ? name : null;
}

function firstSegment(command) {
  return String(command ?? "").replace(LEADING_CD, "").split(/\||&&|;|\n/)[0];
}

function bashOutput(response) {
  if (typeof response === "string") return response;
  if (!response || typeof response !== "object") return "";
  return [response.stdout, response.stderr].filter((part) => typeof part === "string" && part !== "").join("\n");
}

// What a call returned, without fields that change on every call (durations,
// the query echoed back).
function resultText(tool, response) {
  if (typeof response === "string") return response;
  if (Array.isArray(response)) return contentText(response);
  if (!response || typeof response !== "object") return "";
  if (tool === "Bash") return bashOutput(response);
  if (tool === "Read") return typeof response.file?.content === "string" ? response.file.content : "";
  if (tool === "Grep" || tool === "Glob") {
    return typeof response.content === "string" && response.content !== "" ? response.content : (Array.isArray(response.filenames) ? response.filenames.join("\n") : "");
  }
  if (tool === "WebFetch") return String(response.result ?? "");
  if (Array.isArray(response.content)) return contentText(response.content);
  const { durationMs, durationSeconds, query, url, ...rest } = response;
  return JSON.stringify(rest);
}

function loopFor(state, actor) {
  state.loops[actor] ??= { sameResult: null, sameTarget: null, cli: {} };
  return state.loops[actor];
}

function rememberBlocked(state, actor, key, kind) {
  const now = Date.now();
  state.blocked = state.blocked.filter((entry) => now - entry.ts <= LOOP_WINDOW_MS);
  const entry = state.blocked.find((candidate) => candidate.actor === actor && candidate.key === key);
  if (entry) {
    entry.ts = now;
    entry.kind = kind;
  } else {
    state.blocked.push({ actor, key, kind, ts: now, retries: 0 });
  }
}

// blocked-retry: the same call again after a sandbox or permission denial.
// Spawns are D4's. A transient classifier denial says to retry, so only its
// second retry counts.
async function blockedRetry(input, state, config, model, log) {
  if (SPAWN_TOOLS.has(input.tool_name) || !ruleOn(config, "blocked-retry")) return null;
  const actor = input.agent_id ?? "";
  const key = callKey(input.tool_name, input.tool_input);
  const now = Date.now();
  state.blocked = state.blocked.filter((entry) => now - entry.ts <= LOOP_WINDOW_MS);
  const entry = state.blocked.find((candidate) => candidate.actor === actor && candidate.key === key);
  if (!entry) return null;
  entry.retries += 1;
  if (entry.kind === "transient" && entry.retries < 2) return null;
  const emit = gated(ruleLevel(config, "blocked-retry"), model);
  await log({ rule: "blocked-retry", decision: "hint", emitted: emit, reason: BLOCKED_RETRY_HINT, evidence: { tool: input.tool_name, kind: entry.kind, retries: entry.retries, callKey: key } });
  return emit ? context("PreToolUse", BLOCKED_RETRY_HINT) : null;
}

// cli-flag-guess: one program keeps failing on its arguments or config and
// its full --help was never read this session.
async function cliFlagGuess(input, state, config, model, log, failed) {
  if (input.tool_name !== "Bash" || !ruleOn(config, "cli-flag-guess")) return null;
  const command = input.tool_input?.command;
  const program = cliProgram(command);
  if (!program) return null;
  const loop = loopFor(state, input.agent_id ?? "");
  if (HELP_FLAG.test(firstSegment(command))) {
    if (!PARTIAL_READ.test(command) && !state.helpSeen.includes(program)) state.helpSeen.push(program);
    delete loop.cli[program];
    return null;
  }
  const text = (failed ? String(input.error ?? "") : bashOutput(input.tool_response)).slice(0, MAX_RESULT_CHARS);
  const argError = failed ? CLI_ARG_ERROR.test(text) || USAGE_LINE.test(text) : !READERS.has(program) && CLI_ARG_ERROR.test(text);
  if (!argError) {
    delete loop.cli[program];
    return null;
  }
  loop.cli[program] = (loop.cli[program] ?? 0) + 1;
  if (loop.cli[program] !== CLI_GUESS_LIMIT || state.helpSeen.includes(program)) return null;
  const emit = gated(ruleLevel(config, "cli-flag-guess"), model);
  await log({ rule: "cli-flag-guess", decision: "hint", emitted: emit, reason: CLI_FLAG_HINT, evidence: { program, failures: loop.cli[program], error: text.replace(/\s+/g, " ").slice(0, 200) } });
  return emit ? CLI_FLAG_HINT : null;
}

// same-result-poll: consecutive different queries by one actor keep getting
// the same non-empty answer, within one turn and ten minutes, with no edit in
// between. Calls with empty results or waiting commands neither count nor
// break the run.
async function sameResultPoll(input, state, config, model, log) {
  const tool = input.tool_name;
  if (!ruleOn(config, "same-result-poll")) return null;
  const loop = loopFor(state, input.agent_id ?? "");
  if (EDIT_TOOLS.has(tool)) {
    loop.sameResult = null;
    return null;
  }
  if (!SAME_RESULT_TOOLS.has(tool) && !String(tool).startsWith("mcp__")) return null;
  if (tool === "Bash" && WAITING_COMMAND.test(String(input.tool_input?.command ?? ""))) return null;
  const text = resultText(tool, input.tool_response).trim();
  if (text.length < 15 || EMPTY_RESULT.test(text)) return null;
  // The whole result: a shared header or a longer log can share a prefix.
  const key = hash(text);
  const now = Date.now();
  let run = loop.sameResult;
  if (!run || run.key !== key || run.turn !== state.turn || now - run.first > LOOP_WINDOW_MS) {
    run = loop.sameResult = { key, first: now, turn: state.turn, inputs: [], fired: false };
  }
  const inputKey = callKey(tool, input.tool_input);
  if (!run.inputs.includes(inputKey)) run.inputs.push(inputKey);
  if (run.fired || run.inputs.length < SAME_RESULT_LIMIT) return null;
  run.fired = true;
  const emit = gated(ruleLevel(config, "same-result-poll"), model);
  await log({ rule: "same-result-poll", decision: "hint", emitted: emit, reason: SAME_RESULT_HINT, evidence: { tool, calls: run.inputs.length, resultHash: key } });
  return emit ? SAME_RESULT_HINT : null;
}

// Rare identifiers a call names: hex ids, UUIDs and Kubernetes name hashes,
// outside paths, URLs and git commands. Common words never match these shapes.
// git is skipped because naming one commit across `git show`/`diff`/`log` is
// how a commit gets reviewed; an identical git call still counts as an input.
export function targetIdentifiers(tool, toolInput) {
  let segments;
  if (tool === "Bash") segments = String(toolInput?.command ?? "").split(SHELL_SEGMENT).filter((segment) => cliProgram(segment) !== "git");
  else {
    const { description, ...rest } = toolInput && typeof toolInput === "object" ? toolInput : {};
    segments = [JSON.stringify(rest)];
  }
  const ids = new Set();
  for (const segment of segments) {
    for (let word of segment.split(ID_WORD_SPLIT)) {
      if (!word || PATH_WORD.test(word)) continue;
      word = word.replace(UUID, (uuid) => {
        ids.add(uuid.toLowerCase());
        return " ";
      }).replace(HASH_COLOUR, " ");
      for (const part of word.split(/[^A-Za-z0-9]+/)) if (HEX_ID.test(part) || K8S_HASH.test(part)) ids.add(part);
    }
  }
  return [...ids];
}

// Count a key, keeping the most recently counted MAX_TARGETS. Keys are
// 16-hex hashes or ids that contain a letter or a dash, never array-index
// strings, so the object keeps insertion order and the first key is the oldest.
function bump(counts, key) {
  const count = (counts[key] ?? 0) + 1;
  delete counts[key];
  counts[key] = count;
  const keys = Object.keys(counts);
  if (keys.length > MAX_TARGETS) delete counts[keys[0]];
  return count;
}

function changesWorkTree(command) {
  return String(command).split(SHELL_SEGMENT).some((segment) => cliProgram(segment) === "git" && GIT_CHANGE.test(segment));
}

// same-target-repeat: within one turn, one actor runs the identical call with
// the identical result a third time, or names the same rare identifier in a
// fifth call. A poll whose output changes is not a repeat. Each target fires
// once per turn. An edit or a git commit/checkout/... starts the counts over:
// re-reading after it is progress. Waiting commands are polling on purpose
// and do not count. A failed call (`failed`) counts but never logs; the next
// successful call over the limit does.
async function sameTargetRepeat(input, state, config, model, log, failed = false) {
  const tool = input.tool_name;
  if (!ruleOn(config, "same-target-repeat")) return null;
  const loop = loopFor(state, input.agent_id ?? "");
  if (!loop.sameTarget || loop.sameTarget.turn !== state.turn) {
    loop.sameTarget = { turn: state.turn, calls: 0, inputs: {}, ids: {}, fired: [] };
  }
  const run = loop.sameTarget;
  const command = tool === "Bash" ? String(input.tool_input?.command ?? "") : "";
  if (!failed && (EDIT_TOOLS.has(tool) || changesWorkTree(command))) {
    run.inputs = {};
    run.ids = {};
    return null;
  }
  if (!SAME_RESULT_TOOLS.has(tool) && !String(tool).startsWith("mcp__")) return null;
  if (WAITING_COMMAND.test(command)) return null;
  run.calls += 1;
  const found = [];
  const inputKey = callKey(tool, input.tool_input);
  const result = failed ? String(input.error ?? "") : resultText(tool, input.tool_response);
  const repeats = bump(run.inputs, hash([inputKey, result]));
  if (repeats >= SAME_INPUT_LIMIT) found.push({ trigger: "same-input", target: inputKey, count: repeats });
  for (const id of targetIdentifiers(tool, input.tool_input)) {
    const count = bump(run.ids, id);
    // A long id may be part of a key, so the log keeps only its hash.
    if (count >= SAME_ID_LIMIT) found.push({ trigger: "same-identifier", target: id.length > 16 ? hash(id) : id, count });
  }
  if (failed) return null;
  const fresh = found.filter(({ trigger, target }) => !run.fired.includes(`${trigger}:${target}`));
  if (fresh.length === 0) return null;
  const emit = gated(ruleLevel(config, "same-target-repeat"), model);
  for (const { trigger, target, count } of fresh) {
    run.fired.push(`${trigger}:${target}`);
    if (run.fired.length > MAX_TARGETS) run.fired.shift();
    await log({ rule: "same-target-repeat", decision: "hint", emitted: emit, reason: SAME_TARGET_HINT, evidence: { trigger, tool, target, count, calls: run.calls } });
  }
  return emit ? SAME_TARGET_HINT : null;
}

function withHints(eventName, response, hints) {
  if (hints.length === 0) return response;
  return context(eventName, [response?.hookSpecificOutput?.additionalContext, ...hints].filter(Boolean).join(" "));
}

async function onUserPrompt(input, state) {
  if (typeof input.agent_id === "string") return null;
  state.turn += 1;
  state.ownCalls = 0;
  state.turnCalls = 0;
  state.prompt = promptFeatures(input.prompt);
  state.earlyFinal = emptyEarlyFinal(state.turn);
  return null;
}

// Compaction, resume, clear and fork start a new context, so the old promise
// and tool-call baseline must not carry over. A compaction happens inside the
// user's turn, though: it keeps the turn's block count (otherwise every auto
// compaction would hand out a fresh budget) and its background agents, which
// are still running. Resume and clear start over, and agents spawned before
// them will never report back, so they no longer count as running.
async function onLifecycle(input, state, config, log) {
  if (typeof input.agent_id === "string") return null;
  const compaction = input.hook_event_name === "PostCompact" || input.source === "compact";
  const resetBy = input.hook_event_name === "PostCompact" ? `compact:${input.trigger ?? "unknown"}` : `session:${input.source ?? "unknown"}`;
  const previous = state.earlyFinal?.turn === state.turn ? state.earlyFinal : emptyEarlyFinal(state.turn);
  const hadBudget = previous.blocks > 0;
  state.earlyFinal = emptyEarlyFinal(state.turn);
  if (compaction) state.earlyFinal.blocks = previous.blocks;
  state.turnCalls = 0;
  if (input.hook_event_name === "SessionStart" && !compaction && input.source !== "startup") {
    for (const spawn of state.spawns) if (spawn.background && !spawn.endedAt) spawn.orphaned = true;
    for (const shell of state.shells ?? []) shell.orphaned = true;
  }
  if (ruleOn(config, "early-final")) await log({ rule: "early-final", decision: "reset", emitted: false, reason: null, evidence: { resetBy, hadBudget, keptBlocks: state.earlyFinal.blocks } });
  return null;
}

async function onPreToolUse(input, state, config, model, log) {
  if (!SPAWN_TOOLS.has(input.tool_name)) return blockedRetry(input, state, config, model, log);
  if (config.spawnGuard === "off" && !["D1", "D2", "D3", "D4"].some((rule) => ruleOn(config, rule))) return null;
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
  // A rule switched off is skipped, so a later rule in the chain can still deny.
  if (ruleOn(config, "D4") && state.rejectedSpawns.includes(inputHash)) {
    deny = { rule: "D4", reason: "This exact spawn was already denied by a permission check. Change the request or do the work directly." };
  } else if (ruleOn(config, "D2") && silent) {
    deny = { rule: "D2", reason: `Inspect ${silent.agentId}'s transcript (or do it yourself) before respawning.` };
  } else if (ruleOn(config, "D1") && pending) {
    deny = { rule: "D1", reason: `An agent with this task is running/unread (${pending.agentId}). Read its output or transcript first.` };
  } else if (ruleOn(config, "D3") && signals.length === 0 && state.ownCalls === 0) {
    deny = { rule: "D3", reason: "Investigate directly first; spawn when work proves parallelizable." };
  }
  // spawn-allow is log-only and follows the group.
  if (deny === null && config.spawnGuard === "off") return null;
  const emit = deny !== null && gated(ruleLevel(config, deny.rule), model);
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
  const hints = [];
  const actor = input.agent_id ?? "";
  // stderr only: stdout can be a file or log that merely mentions the error.
  if (input.tool_name === "Bash" && ruleOn(config, "blocked-retry") && SANDBOX_DENIAL.test(String(input.tool_response?.stderr ?? ""))) {
    rememberBlocked(state, actor, callKey("Bash", input.tool_input), "sandbox");
  } else {
    // It went through, so a retry of it is no longer a blocked retry.
    const key = callKey(input.tool_name, input.tool_input);
    state.blocked = state.blocked.filter((entry) => entry.actor !== actor || entry.key !== key);
  }
  for (const hint of [
    await cliFlagGuess(input, state, config, model, log, false),
    await sameResultPoll(input, state, config, model, log),
    await sameTargetRepeat(input, state, config, model, log),
  ]) if (hint) hints.push(hint);
  return withHints("PostToolUse", await trackAfterTool(input, state, config, model, log), hints);
}

async function trackAfterTool(input, state, config, model, log) {
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

  // Background shells count as running work for the early-final guard. The
  // Bash response field naming the shell is unverified, so the tool_use_id
  // stands in when it is missing.
  if (tool === "Bash" && isParent && toolInput.run_in_background === true) {
    const id = [response?.backgroundTaskId, response?.shellId, response?.bash_id, input.tool_use_id].find((value) => typeof value === "string" && value !== "");
    if (id) {
      state.shells = state.shells ?? [];
      state.shells.push({ id, description: String(toolInput.description ?? "").slice(0, 200), turn: state.turn, settled: null });
    }
    return null;
  }

  if ((tool === "TaskStop" || tool === "KillShell") && isParent) {
    const id = toolInput.task_id ?? toolInput.shell_id ?? toolInput.id ?? null;
    settleBackground(state, id, "stopped");
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
    if (over.length === 0 || !ruleOn(config, "poll-nudge")) return null;
    const emit = gated(ruleLevel(config, "poll-nudge"), model);
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
  const found = errorHint(input, state.lastFailHash, { blockedRetry: ruleOn(config, "blocked-retry") });

  if (SPAWN_TOOLS.has(tool) && isParent) {
    if (found.denied === "final") {
      state.rejectedSpawns.push(hash(input.tool_input ?? {}));
      await log({ rule: "spawn-rejected", decision: "log-only", emitted: false, reason: null, evidence: { inputHash: hash(input.tool_input ?? {}) } });
    } else if (found.denied === "user") {
      // The user said no; resending the same spawn is as wrong as after a
      // classifier denial, but it is logged apart from permission checks.
      state.rejectedSpawns.push(hash(input.tool_input ?? {}));
      await log({ rule: "spawn-denied-user", decision: "log-only", emitted: false, reason: null, evidence: { inputHash: hash(input.tool_input ?? {}) } });
    } else if (found.denied === "transient") {
      // Retrying is what the denial itself recommends, so D4 must not fire.
      await log({ rule: "spawn-denied-transient", decision: "log-only", emitted: false, reason: null, evidence: { inputHash: hash(input.tool_input ?? {}) } });
    } else if (ruleOn(config, "subagent-cut")) {
      const reason = error.replace(/\s+/g, " ").slice(0, 160) || "unknown error";
      const hint = `Subagent ended without a report (${reason}); read its transcript or do the work directly.`;
      const emit = gated(ruleLevel(config, "subagent-cut"), model);
      await log({ rule: "subagent-cut", decision: "hint", emitted: emit, reason: hint, evidence: { tool } });
      if (emit) responses.push(hint);
    }
  }

  if (!found.denied) state.lastFailHash = found.callHash;
  if (found.rule && ruleOn(config, found.rule)) {
    const emit = gated(ruleLevel(config, found.rule), model);
    await log({ rule: found.rule, decision: "hint", emitted: emit, reason: found.hint, evidence: { tool, error: error.slice(0, 200) } });
    if (emit) responses.push(found.hint);
  }
  if (found.denied && !SPAWN_TOOLS.has(tool) && ruleOn(config, "blocked-retry")) {
    rememberBlocked(state, input.agent_id ?? "", callKey(tool, input.tool_input), found.denied);
  }
  const cliHint = await cliFlagGuess(input, state, config, model, log, true);
  if (cliHint) responses.push(cliHint);
  // A pipeline whose last grep matched nothing exits 1 and lands here; it
  // still ran, so it counts. A denied call never ran.
  if (!found.denied) await sameTargetRepeat(input, state, config, model, log, true);
  return responses.length > 0 ? context("PostToolUseFailure", responses.join(" ")) : null;
}

async function onSubagentStart(input, state) {
  if (typeof input.agent_id !== "string") return null;
  upsertSpawn(state, input.agent_id, { agentType: input.agent_type ?? null, startedAt: new Date().toISOString() });
  return null;
}

// An agent that ends with SubagentHandback has no closing text: its report is
// the tool input, and the parent receives it as a message once the tool
// result says it was delivered.
async function handback(path) {
  if (typeof path !== "string") return null;
  try {
    let found = null;
    for (const record of parseLines(await readTail(path))) {
      const content = Array.isArray(record?.message?.content) ? record.message.content : [];
      for (const block of content) {
        if (record.type === "assistant" && block?.type === "tool_use" && block.name === "SubagentHandback" && typeof block.input?.message === "string") {
          found = { id: block.id, message: block.input.message, delivered: false };
        } else if (found && record.type === "user" && block?.type === "tool_result" && block.tool_use_id === found.id) {
          found.delivered = block.is_error !== true;
        }
      }
    }
    return found;
  } catch {
    return null;
  }
}

// §4.4.2 (decision 4): every subagent, Claude included. Blocks only when the
// subagent's own prompt asked for STATUS, at most once per agent.
async function onSubagentStop(input, state, config, model, log) {
  if (typeof input.agent_id !== "string") return null;
  const transcriptPath = agentTranscriptPath(input);
  let message = String(input.last_assistant_message ?? "");
  let resultSource = message ? "last-message" : "none";
  const handed = message ? null : await handback(transcriptPath);
  if (handed) {
    message = handed.message;
    resultSource = "handback";
  }
  const statusReported = STATUS_LINE.test(message);
  const spawn = upsertSpawn(state, input.agent_id, {
    agentType: input.agent_type ?? null,
    endedAt: new Date().toISOString(),
    statusReported,
    result: message.slice(0, MAX_RESULT_CHARS),
    transcriptPath,
  });
  if (handed?.delivered) markRead(spawn, "handback");
  const groupOn = config.subagentReport !== "off";
  const missingLevel = ruleLevel(config, "status-missing");
  if (!groupOn && missingLevel === "off") return null;
  const contract = subagentPromptContract(await firstUserPrompt(transcriptPath));
  const knownType = KNOWN_AGENT_TYPES.has(input.agent_type);
  let rule = "status-log";
  let block = false;
  if (contract === "fixed-format") rule = "status-fixed-format";
  else if (!knownType) rule = "status-unknown-agent-type";
  else if (contract === "status" && !statusReported && missingLevel !== "off") {
    rule = "status-missing";
    block = input.stop_hook_active !== true && !spawn.reportBlocked;
  }
  // The log-only status-* records follow the group.
  if (rule !== "status-missing" && !groupOn) return null;
  const emit = block && missingLevel === "enforce";
  if (emit) spawn.reportBlocked = true;
  await log({
    rule,
    decision: block ? "block" : "log-only",
    emitted: emit,
    reason: block ? STATUS_REASON : null,
    evidence: { agentType: input.agent_type ?? null, contract, statusReported, resultSource, stopHookActive: input.stop_hook_active === true },
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
// "don't poll" note instead of a block. With no stored result there is no
// evidence either way, so those agents only get a hint.
async function onStop(input, state, config, model, log, persisted) {
  if (typeof input.agent_id === "string") return null;
  const response = await backgroundStop(input, state, config, model, log);
  if (response?.decision === "block") return response;
  return (await earlyFinal(input, state, config, model, log, persisted)) ?? response;
}

async function backgroundStop(input, state, config, model, log) {
  const unreadOn = ruleOn(config, "unread-result");
  const runningOn = ruleOn(config, "running-note");
  if (!unreadOn && !runningOn) return null;
  const background = Array.isArray(input.background_tasks) ? input.background_tasks : [];
  const running = background.filter((task) => task?.type === "subagent" && task.status === "running");
  const ended = state.spawns.filter((spawn) => spawn.background && spawn.endedAt && !spawn.read);
  if (ended.length > 0) {
    const since = ended.map((spawn) => spawn.endedAt).sort()[0];
    const texts = [...await assistantTextsSince(input.transcript_path, since), String(input.last_assistant_message ?? "")];
    for (const spawn of ended) if (texts.some((text) => quotes(text, spawn))) markRead(spawn, "quoted");
  }
  const unread = ended.filter((spawn) => !spawn.read);
  if (unreadOn && unread.length > 0) {
    const list = unread.map((spawn) => `${spawn.agentId} (${spawn.description || "no description"})`).join(", ");
    const reason = `Finished background agents have results you have not read: ${list}. Read their output (TaskOutput or the output file) and use it before ending the turn.`;
    const empty = unread.filter((spawn) => !spawn.result).map((spawn) => spawn.agentId);
    const once = input.stop_hook_active !== true && state.stopBlockedTurn !== state.turn;
    const decision = !once ? "log-only" : empty.length < unread.length ? "block" : "hint";
    const emit = once && gated(ruleLevel(config, "unread-result"), model);
    if (emit) state.stopBlockedTurn = state.turn;
    await log({ rule: "unread-result", decision, emitted: emit, reason, evidence: { agents: unread.map((spawn) => spawn.agentId), emptyResult: empty, stopHookActive: input.stop_hook_active === true } });
    if (emit) return decision === "block" ? { decision: "block", reason } : context("Stop", reason);
  }
  if (runningOn && running.length > 0) {
    const note = `${running.length} agent${running.length === 1 ? "" : "s"} still running; completion notices will arrive — end the turn or keep working, don't poll.`;
    const emit = gated(ruleLevel(config, "running-note"), model);
    await log({ rule: "running-note", decision: "hint", emitted: emit, reason: note, evidence: { agents: running.map((task) => task.id) } });
    if (emit) return context("Stop", note);
  }
  return null;
}

// The classifier was built from GPT finals only (plan §3.3), so other models
// are not judged unless the env lists them. Invalid lists judge no model.
export function earlyFinalModelSources(env = process.env) {
  const raw = env[EARLY_FINAL_MODELS_ENV];
  if (raw === undefined || raw === "") return [...EARLY_FINAL_MODELS];
  let sources;
  try {
    sources = JSON.parse(raw);
    if (!Array.isArray(sources) || sources.length === 0 || sources.length > 16) return null;
    for (const source of sources) {
      if (typeof source !== "string" || source.trim() === "") return null;
      new RegExp(source, "i");
    }
  } catch {
    return null;
  }
  return sources;
}

// "oneportal_responses,gpt-6.1-sol" and "openai/gpt-6.1-sol[1m]" are both gpt-6.1-sol.
function bareModel(model) {
  return String(model ?? "").trim().split(/[/,]/).at(-1)?.replace(/\[1m\]$/i, "") ?? "";
}

// The model stopped a task, or Claude Code reported it finished. Only the
// early-final guard reads "settled"; SubagentStop still owns endedAt.
function settleBackground(state, id, how) {
  if (typeof id !== "string" || id === "") return;
  const spawn = spawnFor(state, id);
  if (spawn && !spawn.settled) spawn.settled = how;
  for (const shell of state.shells ?? []) if (shell.id === id && !shell.settled) shell.settled = how;
}

// Anything still working in the background: subagents, workflows, shells.
// background_tasks is Claude Code's own view when the Stop payload has it; a
// tracked id it reports in any other state than running is settled.
function runningBackground(input, state) {
  const tasks = Array.isArray(input.background_tasks) ? input.background_tasks : [];
  const running = [];
  for (const task of tasks) {
    const id = task?.id ?? null;
    if (task?.status === "running") running.push(id ?? task?.type ?? "task");
    else if (typeof task?.status === "string") settleBackground(state, id, `reported-${task.status}`);
  }
  for (const spawn of state.spawns) {
    if (spawn.background && !spawn.endedAt && !spawn.orphaned && !spawn.settled && !running.includes(spawn.agentId)) running.push(spawn.agentId);
  }
  for (const shell of state.shells ?? []) {
    if (!shell.orphaned && !shell.settled && !running.includes(shell.id)) running.push(shell.id);
  }
  return running;
}

async function lastAssistantText(input) {
  if (typeof input.last_assistant_message === "string") return input.last_assistant_message;
  const texts = await assistantTextsSince(input.transcript_path, null);
  return texts.at(-1) ?? "";
}

// Plan §3: a GPT final that promises its next step instead of taking it gets
// sent back, at most EARLY_FINAL_MAX_BLOCKS times a turn. A repeat block needs
// both a new tool call and a different promise, so a model that keeps
// restating the same promise without acting ends the turn. Without a state
// file there is no count to keep, so a Stop that is already a continuation
// passes.
async function earlyFinal(input, state, config, model, log, persisted = true) {
  const finalOn = ruleOn(config, "early-final");
  const phantomOn = ruleOn(config, "phantom-wait");
  if (!finalOn && !phantomOn) return null;
  const patterns = (config.earlyFinalModels ?? []).map((source) => new RegExp(source, "i"));
  if (model === null || !patterns.some((pattern) => pattern.test(bareModel(model)))) return null;
  if (state.earlyFinal?.turn !== state.turn) state.earlyFinal = emptyEarlyFinal(state.turn);
  const budget = state.earlyFinal;
  const running = runningBackground(input, state);
  const verdict = classifyEarlyFinal(await lastAssistantText(input), { backgroundRunning: running.length });
  const rule = verdict.reason === "phantom-wait" ? "phantom-wait" : "early-final";
  if (!ruleOn(config, rule)) return null;
  const turnCalls = state.turnCalls ?? 0;
  const promiseHash = verdict.promise ? hash(verdict.promise) : null;
  let decision = verdict.decision === "continue" ? "block" : "allow";
  let reason = verdict.reason;
  if (decision === "block") {
    if (state.prompt?.planOnly) [decision, reason] = ["allow", "plan-only-turn"];
    else if (!persisted && input.stop_hook_active === true) [decision, reason] = ["allow", "no-state-stop-active"];
    else if (budget.blocks >= EARLY_FINAL_MAX_BLOCKS) [decision, reason] = ["allow", "budget-exhausted"];
    else if (budget.blocks > 0 && turnCalls <= budget.callsAtBlock) [decision, reason] = ["allow", "loop-no-new-call"];
    else if (budget.blocks > 0 && promiseHash === budget.lastPromiseHash) [decision, reason] = ["allow", "loop-same-promise"];
  }
  const emit = decision === "block" && gated(ruleLevel(config, rule), model);
  if (emit) Object.assign(budget, { blocks: budget.blocks + 1, lastPromiseHash: promiseHash, callsAtBlock: turnCalls });
  await log({
    rule,
    decision,
    emitted: emit,
    reason,
    evidence: {
      verdict: verdict.reason,
      promise: verdict.promise,
      vetoes: verdict.vetoes,
      backgroundRunning: running,
      blocks: budget.blocks,
      turnCalls,
      stopHookActive: input.stop_hook_active === true,
    },
  });
  if (!emit) return null;
  return { decision: "block", reason: earlyFinalReason(verdict.promise, { phantomWait: rule === "phantom-wait" }) };
}

export async function processEducationHook(input, env = process.env) {
  const eventName = input?.hook_event_name;
  if (!EDUCATION_EVENTS.includes(eventName)) return null;
  const base = { session_id: input.session_id ?? null, agent_id: input.agent_id ?? null, event: eventName, tool: input.tool_name ?? null };
  const { config, errors } = readEducationConfig(env);
  if (errors.length > 0) {
    await logRecord(env, { ...base, rule: "config", decision: "config-error", emitted: false, reason: `invalid or missing ${errors.join(", ")}; affected rules pass` });
  }
  const groupsOff = Object.keys(EDUCATION_ENV).every((key) => config[key] === "off" || config[key] === false);
  if (groupsOff && Object.values(config.rules).every((level) => level === "off")) return null;
  const path = statePath(env, input.session_id);
  const state = await loadState(path);
  const model = ["PreToolUse", "PostToolUse", "PostToolUseFailure", "SubagentStop", "Stop"].includes(eventName) ? await actorModel(input) : null;
  const log = (record) => logRecord(env, { ...base, model, flags: config, ...record });
  let response = null;
  if ((eventName === "PostToolUse" || eventName === "PostToolUseFailure") && typeof input.agent_id !== "string") {
    state.turnCalls = (state.turnCalls ?? 0) + 1;
  }
  if (eventName === "UserPromptSubmit") response = await onUserPrompt(input, state);
  else if (eventName === "PreToolUse") response = await onPreToolUse(input, state, config, model, log);
  else if (eventName === "PostToolUse") response = await onPostToolUse(input, state, config, model, log);
  else if (eventName === "PostToolUseFailure") response = await onPostToolUseFailure(input, state, config, model, log);
  else if (eventName === "SubagentStart") response = await onSubagentStart(input, state);
  else if (eventName === "SubagentStop") response = await onSubagentStop(input, state, config, model, log);
  else if (eventName === "Stop") response = await onStop(input, state, config, model, log, path !== null);
  else if (eventName === "SessionStart" || eventName === "PostCompact") response = await onLifecycle(input, state, config, log);
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
export function summarizeEducationLog(text, { now = Date.now(), days = 7, samples = 20, rules: rulesVersion = null } = {}) {
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
    // Records written before EDUCATION_RULES_VERSION existed carry no version: rule set 1.
    if (rulesVersion !== null && (record.rules ?? 1) !== rulesVersion) continue;
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
    rulesVersion,
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
    summary.rulesVersion === null || summary.rulesVersion === undefined ? `rule sets: all (current ${EDUCATION_RULES_VERSION}; pass --rules ${EDUCATION_RULES_VERSION} to read only it)` : `rule set ${summary.rulesVersion} only`,
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
