import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { test } from "node:test";
import { educationHookEnv, renderHeartbeatManagedFiles } from "../src/context-heartbeat.mjs";
import {
  EDUCATION_EVENTS,
  EDUCATION_RULES_VERSION,
  errorHint,
  isClaudeModel,
  processEducationHook,
  promptFeatures,
  readEducationConfig,
  resultShingles,
  runEducationHook,
  subagentPromptContract,
} from "../src/education.mjs";

const flags = (overrides = {}) => ({
  AIRCLAUDE_EDUCATION_SPAWN_GUARD: "shadow",
  AIRCLAUDE_EDUCATION_SUBAGENT_REPORT: "shadow",
  AIRCLAUDE_EDUCATION_SUBAGENT_NUDGE: "shadow",
  AIRCLAUDE_EDUCATION_ERROR_HINTS: "false",
  ...overrides,
});

async function fixture(model = "gpt-6-sol") {
  const home = await mkdtemp(join(tmpdir(), "airkit-education-"));
  const transcript = join(home, "session.jsonl");
  await writeAssistant(transcript, model);
  const env = (overrides) => ({ HOME: home, CLAUDE_PLUGIN_DATA: join(home, "data"), ...flags(overrides) });
  const base = { session_id: "s1", transcript_path: transcript, cwd: home };
  const logs = async () => {
    try {
      return (await readFile(join(home, ".claude-code-router", "logs", "airkit-education.jsonl"), "utf8"))
        .trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    } catch {
      return [];
    }
  };
  return { home, transcript, env, base, logs, cleanup: () => rm(home, { recursive: true, force: true }) };
}

async function writeAssistant(path, model, text = "working", extra = "") {
  await writeFile(path, `${JSON.stringify({ type: "user", message: { role: "user", content: "start" } })}\n${JSON.stringify({ type: "assistant", timestamp: new Date().toISOString(), message: { model, content: [{ type: "text", text }] } })}\n${extra}`);
}

async function writeAgent(transcriptPath, agentId, prompt, model = "gpt-6-sol") {
  const dir = join(transcriptPath.slice(0, -".jsonl".length), "subagents");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `agent-${agentId}.jsonl`), [
    JSON.stringify({ type: "user", message: { role: "user", content: prompt } }),
    JSON.stringify({ type: "assistant", message: { model, content: [{ type: "text", text: "ok" }] } }),
  ].join("\n") + "\n");
}

// Background agents can end by calling SubagentHandback: the report travels in
// the tool input and the final assistant message has no text at all.
async function writeHandbackAgent(transcriptPath, agentId, prompt, report, { delivered = true } = {}) {
  const dir = join(transcriptPath.slice(0, -".jsonl".length), "subagents");
  await mkdir(dir, { recursive: true });
  const result = delivered
    ? { type: "tool_result", tool_use_id: `hb-${agentId}`, content: [{ type: "text", text: '{"success":true,"message":"Report delivered to your caller."}' }] }
    : { type: "tool_result", tool_use_id: `hb-${agentId}`, is_error: true, content: "Delivery failed." };
  await writeFile(join(dir, `agent-${agentId}.jsonl`), [
    JSON.stringify({ type: "user", message: { role: "user", content: prompt } }),
    JSON.stringify({ type: "assistant", message: { model: "gpt-6-sol", content: [{ type: "tool_use", id: `hb-${agentId}`, name: "SubagentHandback", input: { message: report } }] } }),
    JSON.stringify({ type: "user", message: { role: "user", content: [result] } }),
  ].join("\n") + "\n");
}

test("flags: valid values parse, missing or invalid fall back to off/false and are reported", () => {
  assert.deepEqual(readEducationConfig(flags({ AIRCLAUDE_EDUCATION_ERROR_HINTS: "true" })), {
    config: { spawnGuard: "shadow", subagentReport: "shadow", subagentNudge: "shadow", errorHints: true, rules: {} },
    errors: [],
  });
  const bad = readEducationConfig({ AIRCLAUDE_EDUCATION_SPAWN_GUARD: "on" });
  assert.equal(bad.config.spawnGuard, "off");
  assert.equal(bad.config.errorHints, false);
  assert.equal(bad.errors.length, 4, "an unset rules env is not an error");
  assert.equal(readEducationConfig(flags({ AIRCLAUDE_EDUCATION_ERROR_HINTS: "enforce" })).config.errorHints, "enforce");
});

test("flags: per-rule overrides parse; bad JSON drops them, a bad entry turns that rule off", () => {
  const rules = (raw) => readEducationConfig(flags({ AIRCLAUDE_EDUCATION_RULES: raw }));
  assert.deepEqual(rules('{"read-missing":"enforce","D3":"off"}'), {
    config: { spawnGuard: "shadow", subagentReport: "shadow", subagentNudge: "shadow", errorHints: false, rules: { "read-missing": "enforce", D3: "off" } },
    errors: [],
  });
  for (const raw of ["{nope", "[]", "null", '"D3"']) {
    const parsed = rules(raw);
    assert.deepEqual(parsed.config.rules, {}, raw);
    assert.equal(parsed.errors.length, 1, raw);
  }
  const unknown = rules('{"status-log":"enforce","D1":"enforce"}');
  assert.deepEqual(unknown.config.rules, { D1: "enforce" }, "log-only records cannot be switched one by one");
  assert.match(unknown.errors[0], /status-log/);
  const invalid = rules('{"D1":"on","D2":true}');
  assert.deepEqual(invalid.config.rules, { D1: "off", D2: "off" });
  assert.equal(invalid.errors.length, 2);
});

test("prompt features count list items and fan-out intent", () => {
  assert.deepEqual(promptFeatures("fix the bug"), { chars: 11, items: 0, fanOut: false });
  const listed = promptFeatures("Review these:\n- !12\n- !13\n- !14");
  assert.equal(listed.items, 3);
  assert.equal(promptFeatures("請平行處理這三個 MR").fanOut, true);
  assert.equal(promptFeatures("use subagents for each repo").fanOut, true);
});

test("subagent contract needs STATUS in the closing lines and yields to fixed formats", () => {
  assert.equal(subagentPromptContract("Do X.\nFinish with STATUS: done|blocked|partial, EVIDENCE: paths"), "status");
  assert.equal(subagentPromptContract("Example transcript:\nSTATUS: done\nmore\ncontext\nhere\nNow summarize it."), "none");
  assert.equal(subagentPromptContract("Return the JSON schema below verbatim."), "fixed-format");
  assert.equal(subagentPromptContract(null), "none");
});

test("error hints follow the fixture-verified rules", () => {
  const bash = errorHint({ tool_name: "Bash", tool_input: { command: "ls x" }, error: "Exit code 1\nls: x: No such file or directory" });
  assert.equal(bash.rule, "bash-enoent");
  assert.match(bash.hint, /pwd/);
  assert.doesNotMatch(bash.hint, /\/tmp|cwd:/, "never print the hook cwd: it does not follow `cd`");
  assert.equal(errorHint({ tool_name: "Edit", tool_input: {}, error: "String to replace not found in file." }).rule, "edit-mismatch");
  assert.equal(errorHint({ tool_name: "Read", tool_input: {}, error: "File does not exist." }).rule, "read-missing");
  assert.equal(errorHint({ tool_name: "Bash", is_interrupt: true, error: "No such file" }), null);
  const first = errorHint({ tool_name: "Bash", tool_input: { command: "x" }, error: "boom" });
  assert.equal(first.rule, null);
  assert.equal(errorHint({ tool_name: "Bash", tool_input: { command: "x" }, error: "boom" }, first.callHash).rule, "repeat-failure");
});

// The workflow harness preamble says "relays, verbatim"; under 44e50e8 that
// alone turned every STATUS contract into fixed-format.
const harnessPrompt = "Read profiles/catalog.json.\nThe harness relays, verbatim and indented below.\nInvestigate carefully.\nUse local evidence.\nFinish with STATUS: done|blocked|partial";

test("fixed format means an output instruction, not a mention of JSON, schema or verbatim", () => {
  assert.equal(subagentPromptContract(harnessPrompt), "status");
  assert.equal(subagentPromptContract("Read profiles/catalog.json"), "none");
  assert.equal(subagentPromptContract("Return catalog.json"), "none");
  assert.equal(subagentPromptContract("Check the schema migration.\nFinish with STATUS: done"), "status");
  for (const prompt of ["Return ONLY JSON matching this schema", "Return results in JSON", "Reply with exactly this format:", "Output the diff verbatim", "只輸出表格", "照下列格式回覆"]) {
    assert.equal(subagentPromptContract(prompt), "fixed-format", prompt);
  }
  // Rule set 4: an explicit closing STATUS request beats an earlier format phrase.
  assert.equal(subagentPromptContract("Return results in JSON.\nkeys: a, b\nnotes\nFinish with STATUS: done"), "status");
  assert.equal(subagentPromptContract("Return results in JSON.\nFinish with STATUS: done\nthen\nstop\nhere"), "fixed-format");
});

// Rule set 2 lost these (rule set 1 caught them through a bare \bjson\b); a
// JSON-only subagent misread as "status" would be blocked into adding STATUS.
test("fixed format covers zh-TW and 'must be JSON' output instructions", () => {
  for (const prompt of [
    "請以 JSON 格式回傳結果",
    "回傳 JSON，不要其他文字",
    "用 JSON 回覆",
    "輸出成 JSON 格式",
    "Your answer must be valid JSON only.",
    "Respond in JSON.",
    "Output as JSON",
  ]) {
    assert.equal(subagentPromptContract(prompt), "fixed-format", prompt);
  }
});

test("fixed format needs the format in the same clause as the output verb", () => {
  for (const prompt of [
    "Return to the main branch and check the schema",
    "Read their output ... the output is JSON-ish",
    "Output goes to report.json. Finish with STATUS: done",
    "Return the parsed package.json fields",
    "回傳 package.json 的內容",
    "Reply to the reviewer about the JSON parser",
    // Rule set 4 counterexamples: descriptions of data, not output formats.
    "API 回傳的 JSON 有缺欄位，請調查",
    "The config file must be valid JSON.",
    "The endpoint accepts JSON only.",
    "Parse the output JSON and list failures.",
    "Reply in the PR thread with the schema link.",
  ]) {
    assert.notEqual(subagentPromptContract(prompt), "fixed-format", prompt);
  }
});

test("a closing STATUS request wins over any fixed-format phrase", () => {
  for (const prompt of [
    "請以 JSON 格式回傳結果\n最後寫 STATUS: done",
    "回傳 JSON，不要其他文字\nSTATUS: done",
    "Your answer must be valid JSON only.\nFinish with STATUS: done",
    "Return the JSON schema below verbatim.\nSTATUS: done",
    "API 回傳的 JSON 有缺欄位\nFinish with STATUS: done|blocked|partial",
  ]) {
    assert.equal(subagentPromptContract(prompt), "status", prompt);
  }
});

test("bash-enoent needs a named missing path and skips sandbox, permission and missing-command errors", () => {
  const bash = (error) => errorHint({ tool_name: "Bash", tool_input: { command: error }, error }).rule;
  for (const error of [
    "ls: foo: No such file or directory",
    "rg: x: No such file or directory (os error 2)",
    "npm error code ENOENT\nnpm error path /repo/package.json",
    "Error: ENOENT: no such file or directory, open '/tmp/foo'",
    // zsh reports a failed cd in lower case; rule set 2 never matched it.
    "Exit code 1\ncd: no such file or directory: /nope",
    "Exit code 1\nbash: cd: /nope: No such file or directory",
    'Exit code 2\n"runs/out.json": No such file or directory (os error 2)',
    "Exit code 2\njq: error: Could not open file /tmp/pods.json: No such file or directory",
  ]) {
    assert.equal(bash(error), "bash-enoent", error);
  }
  for (const error of [
    "mkdir: x: Operation not permitted\nNo such file or directory",
    "fatal: failed to move '/a' to '/b': Operation not permitted\nNo such file or directory",
    "zsh: command not found: foo",
    "ENOENT",
    "sandbox: /foo: No such file or directory",
    "EPERM\nENOENT /foo",
    // The path has to be on the line that reports the missing file.
    "ugrep: warning: : No such file or directory\nfoo/bar baz",
    "=== any k8s ===\nNo such file or directory\n/usr/bin/foo 'x'",
    "Error: No such file or directory",
    // "no" is the first word of the message, not a path.
    "Error: ENOENT: no such file or directory",
    "ENOENT: no such file or directory",
  ]) {
    assert.equal(bash(error), null, error);
  }
});

// Claude Code's own denial texts, cut to their opening sentences, from local
// transcripts 2026-07..11 (approximate counts in brackets). Free-text reasons
// and commands are redacted.
const FINAL_DENIALS = [
  // [~500]
  "Permission for this action was denied by the Claude Code auto mode classifier. Reason: Blocked by classifier. If you have other tasks that don't depend on this action, continue working on those.",
  // [~140]
  "Permission for this action was denied by the Claude Code auto mode classifier. Reason: The server-side auto mode classifier judged this action dangerous (it gave no explanation). If you have other tasks that don't depend on this action, continue working on those.",
  // [~430, reason is free text]
  "Permission for this action was denied by the Claude Code auto mode classifier. Reason: [Category] <redacted reason>.. If you have other tasks that don't depend on this action, continue working on those.",
  // older wording, no "classifier" in it at all
  "Permission for this action has been denied. Reason: <redacted reason>.. If you have other tasks that don't depend on this action, continue working on those.",
  "Permission to use WebFetch has been denied. IMPORTANT: You *may* attempt to accomplish this action using other tools that might naturally be used to accomplish this goal, e.g. using head instead of cat.",
  "Permission to use Bash with command <redacted>\n<redacted second line> has been denied.",
  "Permission for this command was denied by a built-in Claude Code safety check, not by the user.",
  "Permission for this tool use was denied. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). Try a different approach or report the limitation to complete your task.",
  // toolUseResult carries an "Error: " prefix
  "Error: Permission for this action was denied by the Claude Code auto mode classifier. Reason: Blocked by classifier.",
];
const TRANSIENT_DENIALS = [
  // [~30] rule set 2 matched none of its patterns
  "Permission for this action has been denied. Reason: Stage 2 classifier error - blocking based on stage 1 assessment. If you have other tasks that don't depend on this action, continue working on those.",
  // [~95]
  "Permission for this action was denied by the Claude Code auto mode classifier. Reason: Stage 2 classifier error - blocking based on stage 1 assessment (usually transient — retrying often succeeds). If you have other tasks that don't depend on this action, continue working on those.",
  // [~75]
  "Auto mode could not evaluate this action and is blocking it for safety — run with --debug for details. This is not a judgment that the action is unsafe.",
  // [~110]
  "claude-sonnet-5[1m] is temporarily unavailable (timed out), so auto mode cannot determine the safety of Bash right now. Wait a moment and then try this action again.",
];

const USER_DENIAL = "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.";

test("a user rejection is a user denial: no hint, no repeat-failure", () => {
  for (const error of [USER_DENIAL, `Error: ${USER_DENIAL}`]) {
    const denied = errorHint({ tool_name: "Bash", tool_input: { command: "x" }, error });
    assert.deepEqual([denied.rule, denied.denied], [null, "user"], error);
    assert.equal(errorHint({ tool_name: "Bash", tool_input: { command: "x" }, error }, denied.callHash).rule, null, error);
  }
});

test("a denial sentence on a later line of Bash output is not a denial", () => {
  for (const error of [
    "Exit code 1\nPermission for this action was denied by the Claude Code auto mode classifier. Reason: x",
    "Exit code 1\ngrep hit:\nPermission to use Bash has been denied.",
    `Exit code 1\n${USER_DENIAL}`,
    `\n${USER_DENIAL}`,
  ]) {
    assert.equal(errorHint({ tool_name: "Bash", tool_input: { command: "x" }, error }).denied, undefined, error);
  }
});

test("real permission denials get no hint and never count toward repeat-failure", () => {
  for (const [errors, kind] of [[FINAL_DENIALS, "final"], [TRANSIENT_DENIALS, "transient"]]) {
    for (const error of errors) {
      const denied = errorHint({ tool_name: "Bash", tool_input: { command: "x" }, error });
      assert.deepEqual([denied.rule, denied.denied], [null, kind], error);
      assert.equal(errorHint({ tool_name: "Bash", tool_input: { command: "x" }, error }, denied.callHash).rule, null, error);
    }
  }
  for (const error of [
    "the classifier model crashed",
    "Blocked by classifier",
    "rm: x: Permission denied",
    "grep output: Permission for this action was denied by the Claude Code auto mode classifier.",
  ]) {
    assert.equal(errorHint({ tool_name: "Bash", tool_input: { command: "x" }, error }).denied, undefined, error);
  }
});

test("a classifier denial between two identical failures leaves the repeat visible", async () => {
  const f = await fixture();
  try {
    const env = f.env({ AIRCLAUDE_EDUCATION_ERROR_HINTS: "true" });
    const fail = { ...f.base, hook_event_name: "PostToolUseFailure", tool_name: "Bash", tool_input: { command: "make" }, error: "make: *** [all] Error 2" };
    const denied = { ...fail, tool_input: { command: "rm -rf build" }, error: "Permission for this action was denied by the Claude Code auto mode classifier." };
    await processEducationHook(fail, env);
    assert.equal(await processEducationHook(denied, env), null);
    assert.equal(await processEducationHook(denied, env), null, "a re-denied call is not a repeat failure");
    const again = await processEducationHook(fail, env);
    assert.match(again.hookSpecificOutput.additionalContext, /Identical failing call/);
    const logged = await f.logs();
    assert.deepEqual(logged.map((entry) => entry.rule), ["repeat-failure"]);
    assert.ok(logged.every((entry) => entry.rules === EDUCATION_RULES_VERSION));
  } finally {
    await f.cleanup();
  }
});

test("Claude detection and result shingles ignore the description", () => {
  assert.equal(isClaudeModel("claude-sonnet-5"), true);
  assert.equal(isClaudeModel("gpt-6-sol"), false);
  assert.equal(isClaudeModel(null), false);
  const description = "Audit the gateway retry logic thoroughly";
  const shingles = resultShingles(`${description}. Found the retry loop at src/compat/gateway.mjs:252 never caps attempts.`, description);
  assert.ok(shingles.length > 0);
  assert.ok(shingles.every((window) => !description.toLowerCase().includes(window.toLowerCase())));
});

test("shadow spawn guard logs D3 for a cold spawn but never denies", async () => {
  const f = await fixture();
  try {
    await processEducationHook({ ...f.base, hook_event_name: "UserPromptSubmit", prompt: "fix the flaky test" }, f.env());
    const out = await processEducationHook({ ...f.base, hook_event_name: "PreToolUse", tool_name: "Agent", tool_input: { description: "fix test", prompt: "fix it", subagent_type: "general-purpose" } }, f.env());
    assert.equal(out, null);
    const [record] = (await f.logs()).filter((entry) => entry.event === "PreToolUse");
    assert.equal(record.rule, "D3");
    assert.equal(record.decision, "deny");
    assert.equal(record.emitted, false);
    assert.equal(record.model, "gpt-6-sol");
  } finally {
    await f.cleanup();
  }
});

test("enforce denies only non-Claude actors, and fan-out intent allows the spawn", async () => {
  const f = await fixture();
  try {
    const env = f.env({ AIRCLAUDE_EDUCATION_SPAWN_GUARD: "enforce" });
    const spawn = { ...f.base, hook_event_name: "PreToolUse", tool_name: "Agent", tool_input: { description: "fix test", prompt: "fix it" } };
    await processEducationHook({ ...f.base, hook_event_name: "UserPromptSubmit", prompt: "fix the flaky test" }, env);
    const denied = await processEducationHook(spawn, env);
    assert.equal(denied.hookSpecificOutput.permissionDecision, "deny");
    assert.match(denied.hookSpecificOutput.permissionDecisionReason, /Investigate directly first/);

    await processEducationHook({ ...f.base, hook_event_name: "UserPromptSubmit", prompt: "Review these in parallel:\n- !1\n- !2\n- !3" }, env);
    assert.equal(await processEducationHook(spawn, env), null);

    await writeAssistant(f.transcript, "claude-sonnet-5");
    await processEducationHook({ ...f.base, hook_event_name: "UserPromptSubmit", prompt: "fix the flaky test" }, env);
    assert.equal(await processEducationHook({ ...spawn, tool_input: { description: "other", prompt: "x" } }, env), null);
  } finally {
    await f.cleanup();
  }
});

test("D1 blocks respawning an unread background agent with the same task", async () => {
  const f = await fixture();
  try {
    const env = f.env({ AIRCLAUDE_EDUCATION_SPAWN_GUARD: "enforce" });
    await processEducationHook({ ...f.base, hook_event_name: "UserPromptSubmit", prompt: "audit in parallel" }, env);
    const toolInput = { description: "Audit gateway", prompt: "audit" };
    await processEducationHook({ ...f.base, hook_event_name: "PostToolUse", tool_name: "Agent", tool_input: toolInput, tool_response: { isAsync: true, status: "async_launched", agentId: "a1", outputFile: "/tmp/a1.output" } }, env);
    const out = await processEducationHook({ ...f.base, hook_event_name: "PreToolUse", tool_name: "Agent", tool_input: { ...toolInput, prompt: "audit again" } }, env);
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /a1/);
    await processEducationHook({ ...f.base, hook_event_name: "PostToolUse", tool_name: "Read", tool_input: { file_path: "/tmp/a1.output" }, tool_response: {} }, env);
    await processEducationHook({ ...f.base, hook_event_name: "SubagentStop", agent_id: "a1", agent_type: "general-purpose", last_assistant_message: "STATUS: done" }, env);
    assert.equal(await processEducationHook({ ...f.base, hook_event_name: "PreToolUse", tool_name: "Agent", tool_input: toolInput }, env), null);
  } finally {
    await f.cleanup();
  }
});

test("a finally denied spawn is never resent (D4), whoever denied it", async () => {
  for (const error of [FINAL_DENIALS[0], FINAL_DENIALS[3], FINAL_DENIALS[7]]) {
    const f = await fixture();
    try {
      const env = f.env({ AIRCLAUDE_EDUCATION_SPAWN_GUARD: "enforce", AIRCLAUDE_EDUCATION_SUBAGENT_NUDGE: "enforce" });
      const toolInput = { description: "Deploy", prompt: "deploy it" };
      await processEducationHook({ ...f.base, hook_event_name: "UserPromptSubmit", prompt: "use subagents" }, env);
      assert.equal(await processEducationHook({ ...f.base, hook_event_name: "PostToolUseFailure", tool_name: "Agent", tool_input: toolInput, error }, env), null, error);
      const out = await processEducationHook({ ...f.base, hook_event_name: "PreToolUse", tool_name: "Agent", tool_input: toolInput }, env);
      assert.match(out.hookSpecificOutput.permissionDecisionReason, /already denied by a permission check/, error);
      const logged = await f.logs();
      assert.ok(logged.some((entry) => entry.rule === "spawn-rejected"), error);
      assert.ok(!logged.some((entry) => entry.rule === "subagent-cut"), "a denial is not a subagent that ended without a report");
    } finally {
      await f.cleanup();
    }
  }
});

test("a user-rejected spawn is logged as a user denial, never subagent-cut", async () => {
  const f = await fixture();
  try {
    const env = f.env({ AIRCLAUDE_EDUCATION_SPAWN_GUARD: "enforce", AIRCLAUDE_EDUCATION_SUBAGENT_NUDGE: "enforce" });
    const toolInput = { description: "Deploy", prompt: "deploy it" };
    await processEducationHook({ ...f.base, hook_event_name: "UserPromptSubmit", prompt: "use subagents" }, env);
    assert.equal(await processEducationHook({ ...f.base, hook_event_name: "PostToolUseFailure", tool_name: "Agent", tool_input: toolInput, error: USER_DENIAL }, env), null);
    assert.equal(await processEducationHook({ ...f.base, hook_event_name: "PostToolUseFailure", tool_name: "Agent", tool_input: toolInput, error: USER_DENIAL }, env), null);
    const rules = (await f.logs()).map((entry) => entry.rule);
    assert.ok(rules.includes("spawn-denied-user"));
    assert.ok(!rules.includes("subagent-cut"));
    assert.ok(!rules.includes("repeat-failure"));
  } finally {
    await f.cleanup();
  }
});

test("a transiently denied spawn may be retried: no D4, no downgrade, no subagent-cut", async () => {
  for (const error of TRANSIENT_DENIALS) {
    const f = await fixture();
    try {
      const env = f.env({ AIRCLAUDE_EDUCATION_SPAWN_GUARD: "enforce", AIRCLAUDE_EDUCATION_SUBAGENT_NUDGE: "enforce" });
      const toolInput = { description: "Deploy", prompt: "deploy it" };
      await processEducationHook({ ...f.base, hook_event_name: "UserPromptSubmit", prompt: "use subagents" }, env);
      assert.equal(await processEducationHook({ ...f.base, hook_event_name: "PostToolUseFailure", tool_name: "Agent", tool_input: toolInput, error }, env), null, error);
      await processEducationHook({ ...f.base, hook_event_name: "PreToolUse", tool_name: "Agent", tool_input: toolInput }, env);
      const logged = await f.logs();
      assert.deepEqual(logged.filter((entry) => entry.rule !== "spawn-allow").map((entry) => entry.rule), ["spawn-denied-transient"], error);
      const retry = logged.find((entry) => entry.rule === "spawn-allow");
      assert.ok(retry, error);
      assert.ok(!JSON.stringify(retry).includes("previous-spawn-rejected"), error);
    } finally {
      await f.cleanup();
    }
  }
});

test("SubagentStop blocks once when the subagent's own prompt asked for STATUS", async () => {
  const f = await fixture("claude-sonnet-5");
  try {
    const env = f.env({ AIRCLAUDE_EDUCATION_SUBAGENT_REPORT: "enforce" });
    await writeAgent(f.transcript, "a2", "Look into it.\nFinish with STATUS: done|blocked|partial, EVIDENCE: <paths>, OPEN: <items>.");
    const stop = { ...f.base, hook_event_name: "SubagentStop", agent_id: "a2", agent_type: "general-purpose", stop_hook_active: false, last_assistant_message: "I looked." };
    const first = await processEducationHook(stop, env);
    assert.equal(first.decision, "block");
    assert.match(first.reason, /STATUS: done\|blocked\|partial/);
    assert.equal(await processEducationHook(stop, env), null, "at most one block per agent");
    assert.equal(await processEducationHook({ ...stop, stop_hook_active: true }, env), null);
  } finally {
    await f.cleanup();
  }
});

test("SubagentStop only logs for unknown agent types, missing contracts and shadow mode", async () => {
  const f = await fixture();
  try {
    await writeAgent(f.transcript, "a3", "Do it.\nFinish with STATUS: done|blocked|partial");
    await writeAgent(f.transcript, "a4", "Just do it.");
    const enforce = f.env({ AIRCLAUDE_EDUCATION_SUBAGENT_REPORT: "enforce" });
    const stop = { ...f.base, hook_event_name: "SubagentStop", stop_hook_active: false, last_assistant_message: "done" };
    assert.equal(await processEducationHook({ ...stop, agent_id: "a3", agent_type: "workflow-reviewer" }, enforce), null);
    assert.equal(await processEducationHook({ ...stop, agent_id: "a4", agent_type: "general-purpose" }, enforce), null);
    assert.equal(await processEducationHook({ ...stop, agent_id: "a3", agent_type: "general-purpose" }, f.env()), null);
    const rules = (await f.logs()).filter((entry) => entry.event === "SubagentStop").map((entry) => entry.rule);
    assert.deepEqual(rules, ["status-unknown-agent-type", "status-log", "status-missing"]);
  } finally {
    await f.cleanup();
  }
});

test("Stop blocks once per turn on an unread finished background agent, and quoting clears it", async () => {
  const f = await fixture();
  try {
    const env = f.env({ AIRCLAUDE_EDUCATION_SUBAGENT_NUDGE: "enforce" });
    const result = "STATUS: done\nThe retry loop at src/compat/gateway.mjs:252 never caps attempts and leaks sockets.";
    await processEducationHook({ ...f.base, hook_event_name: "UserPromptSubmit", prompt: "investigate in parallel" }, env);
    await processEducationHook({ ...f.base, hook_event_name: "PostToolUse", tool_name: "Agent", tool_input: { description: "Audit gateway" }, tool_response: { isAsync: true, agentId: "b1", outputFile: "/tmp/b1.output" } }, env);
    await processEducationHook({ ...f.base, hook_event_name: "SubagentStop", agent_id: "b1", agent_type: "general-purpose", last_assistant_message: result }, env);
    const stop = { ...f.base, hook_event_name: "Stop", stop_hook_active: false, last_assistant_message: "All agents finished.", background_tasks: [] };
    const first = await processEducationHook(stop, env);
    assert.equal(first.decision, "block");
    assert.match(first.reason, /b1/);
    assert.equal(await processEducationHook(stop, env), null, "one block per turn");

    await processEducationHook({ ...f.base, hook_event_name: "UserPromptSubmit", prompt: "continue" }, env);
    const quoted = await processEducationHook({ ...stop, last_assistant_message: "Agent b1 says: the retry loop at src/compat/gateway.mjs:252 never caps attempts." }, env);
    assert.equal(quoted, null);
  } finally {
    await f.cleanup();
  }
});

test("a report delivered through SubagentHandback counts as read and as the agent's result", async () => {
  const f = await fixture();
  try {
    const env = f.env({ AIRCLAUDE_EDUCATION_SUBAGENT_REPORT: "enforce", AIRCLAUDE_EDUCATION_SUBAGENT_NUDGE: "enforce" });
    const ask = "Audit it.\nFinish with STATUS: done|blocked|partial, EVIDENCE: <paths>, OPEN: <items>.";
    const report = "STATUS: done\nEVIDENCE: src/compat/gateway.mjs:252\nOPEN: none";
    await processEducationHook({ ...f.base, hook_event_name: "UserPromptSubmit", prompt: "investigate in parallel" }, env);
    for (const id of ["h1", "h2"]) {
      await processEducationHook({ ...f.base, hook_event_name: "PostToolUse", tool_name: "Agent", tool_input: { description: `Audit ${id}` }, tool_response: { isAsync: true, agentId: id, outputFile: `/tmp/${id}.output` } }, env);
    }
    await writeHandbackAgent(f.transcript, "h1", ask, report);
    await writeHandbackAgent(f.transcript, "h2", ask, report, { delivered: false });
    const subagentStop = { ...f.base, hook_event_name: "SubagentStop", agent_type: "general-purpose", stop_hook_active: false, last_assistant_message: "" };
    assert.equal(await processEducationHook({ ...subagentStop, agent_id: "h1" }, env), null, "the handback carries STATUS");
    assert.equal(await processEducationHook({ ...subagentStop, agent_id: "h2" }, env), null);

    const stop = await processEducationHook({ ...f.base, hook_event_name: "Stop", stop_hook_active: false, last_assistant_message: "Done.", background_tasks: [] }, env);
    assert.equal(stop.decision, "block", "an undelivered handback is still an unread result");
    assert.match(stop.reason, /h2/);
    assert.doesNotMatch(stop.reason, /h1/);
    const records = await f.logs();
    const sources = records.filter((entry) => entry.event === "SubagentStop").map((entry) => [entry.rule, entry.evidence.resultSource]);
    assert.deepEqual(sources, [["status-log", "handback"], ["status-log", "handback"]]);
  } finally {
    await f.cleanup();
  }
});

test("Stop only hints when an unread agent's result is empty", async () => {
  const f = await fixture();
  try {
    const env = f.env({ AIRCLAUDE_EDUCATION_SUBAGENT_NUDGE: "enforce" });
    await processEducationHook({ ...f.base, hook_event_name: "UserPromptSubmit", prompt: "investigate in parallel" }, env);
    await processEducationHook({ ...f.base, hook_event_name: "PostToolUse", tool_name: "Agent", tool_input: { description: "Audit gateway" }, tool_response: { isAsync: true, agentId: "c2", outputFile: "/tmp/c2.output" } }, env);
    await processEducationHook({ ...f.base, hook_event_name: "SubagentStop", agent_id: "c2", agent_type: "general-purpose", last_assistant_message: "" }, env);
    const stop = { ...f.base, hook_event_name: "Stop", stop_hook_active: false, last_assistant_message: "Done.", background_tasks: [] };
    const first = await processEducationHook(stop, env);
    assert.equal(first.decision, undefined);
    assert.match(first.hookSpecificOutput.additionalContext, /c2/);
    assert.equal(await processEducationHook(stop, env), null, "one hint per turn");
    const [record] = (await f.logs()).filter((entry) => entry.rule === "unread-result");
    assert.equal(record.decision, "hint");
    assert.deepEqual(record.evidence.emptyResult, ["c2"]);
  } finally {
    await f.cleanup();
  }
});

// Decision 4: the STATUS check is the one rule that is not model-gated.
test("SubagentStop blocks a Claude subagent whose prompt asked for STATUS", async () => {
  const f = await fixture();
  try {
    const env = f.env({ AIRCLAUDE_EDUCATION_SUBAGENT_REPORT: "enforce" });
    await writeAgent(f.transcript, "k1", "Look into it.\nFinish with STATUS: done|blocked|partial", "claude-sonnet-5");
    const stop = { ...f.base, hook_event_name: "SubagentStop", agent_id: "k1", agent_type: "general-purpose", stop_hook_active: false, last_assistant_message: "I looked." };
    const first = await processEducationHook(stop, env);
    assert.equal(first.decision, "block");
    assert.equal(await processEducationHook(stop, env), null, "at most one block per agent");
    const [record] = (await f.logs()).filter((entry) => entry.event === "SubagentStop");
    assert.equal(record.rule, "status-missing");
    assert.equal(record.emitted, true);
    assert.equal(record.model, "claude-sonnet-5");
  } finally {
    await f.cleanup();
  }
});

test("SubagentStop for a Claude subagent stays log-only without a STATUS prompt or under shadow", async () => {
  const f = await fixture("claude-sonnet-5");
  try {
    await writeAgent(f.transcript, "k2", "Just look into it.", "claude-sonnet-5");
    await writeAgent(f.transcript, "k3", "Look into it.\nFinish with STATUS: done|blocked|partial", "claude-sonnet-5");
    const stop = { ...f.base, hook_event_name: "SubagentStop", agent_type: "general-purpose", stop_hook_active: false, last_assistant_message: "I looked." };
    assert.equal(await processEducationHook({ ...stop, agent_id: "k2" }, f.env({ AIRCLAUDE_EDUCATION_SUBAGENT_REPORT: "enforce" })), null);
    assert.equal(await processEducationHook({ ...stop, agent_id: "k3" }, f.env()), null);
    const records = (await f.logs()).filter((entry) => entry.event === "SubagentStop");
    assert.deepEqual(records.map((entry) => [entry.rule, entry.decision, entry.emitted]), [
      ["status-log", "log-only", false],
      ["status-missing", "block", false],
    ]);
  } finally {
    await f.cleanup();
  }
});

test("SubagentStop blocks when both the parent and the subagent are Claude", async () => {
  const f = await fixture("claude-opus-5");
  try {
    const env = f.env({ AIRCLAUDE_EDUCATION_SUBAGENT_REPORT: "enforce" });
    await writeAgent(f.transcript, "k4", "Look into it.\nFinish with STATUS: done|blocked|partial", "claude-sonnet-5");
    const stop = { ...f.base, hook_event_name: "SubagentStop", agent_id: "k4", agent_type: "general-purpose", stop_hook_active: false, last_assistant_message: "I looked." };
    assert.equal((await processEducationHook(stop, env)).decision, "block");
  } finally {
    await f.cleanup();
  }
});

test("fork agents are a known type; empty and workflow agent types stay log-only", async () => {
  const f = await fixture();
  try {
    const env = f.env({ AIRCLAUDE_EDUCATION_SUBAGENT_REPORT: "enforce" });
    const ask = "Look into it.\nFinish with STATUS: done|blocked|partial";
    await writeAgent(f.transcript, "f1", ask);
    await writeAgent(f.transcript, "f2", ask);
    const stop = { ...f.base, hook_event_name: "SubagentStop", stop_hook_active: false, last_assistant_message: "I looked." };
    assert.equal((await processEducationHook({ ...stop, agent_id: "f1", agent_type: "fork" }, env)).decision, "block");
    assert.equal(await processEducationHook({ ...stop, agent_id: "f2", agent_type: "" }, env), null);
    // Spec §4.4.2: workflow agents only log, even now that their agent_type is
    // known to be "workflow-subagent"; enforcing them needs a spec decision.
    await writeAgent(f.transcript, "f3", ask);
    assert.equal(await processEducationHook({ ...stop, agent_id: "f3", agent_type: "workflow-subagent" }, env), null);
    const rules = (await f.logs()).filter((entry) => entry.event === "SubagentStop").map((entry) => entry.rule);
    assert.deepEqual(rules, ["status-missing", "status-unknown-agent-type", "status-unknown-agent-type"]);
  } finally {
    await f.cleanup();
  }
});

test("Stop with running agents adds a don't-poll note; polling past the limit nudges once", async () => {
  const f = await fixture();
  try {
    const env = f.env({ AIRCLAUDE_EDUCATION_SUBAGENT_NUDGE: "enforce" });
    await processEducationHook({ ...f.base, hook_event_name: "PostToolUse", tool_name: "Agent", tool_input: { description: "x" }, tool_response: { isAsync: true, agentId: "c1" } }, env);
    const note = await processEducationHook({ ...f.base, hook_event_name: "Stop", stop_hook_active: false, background_tasks: [{ id: "c1", type: "subagent", status: "running" }] }, env);
    assert.match(note.hookSpecificOutput.additionalContext, /still running/);
    const poll = { ...f.base, hook_event_name: "PostToolUse", tool_name: "SendMessage", tool_input: { to: "c1", message: "status?" }, tool_response: {} };
    const outputs = [];
    for (let index = 0; index < 5; index += 1) outputs.push(await processEducationHook(poll, env));
    assert.deepEqual(outputs.map((out) => out === null), [true, true, true, false, true]);
  } finally {
    await f.cleanup();
  }
});

test("error hints stay silent unless the flag is true and the actor is non-Claude", async () => {
  const f = await fixture();
  try {
    const failure = { ...f.base, hook_event_name: "PostToolUseFailure", tool_name: "Bash", tool_input: { command: "ls nope" }, error: "Exit code 1\nls: nope: No such file or directory" };
    assert.equal(await processEducationHook(failure, f.env()), null);
    const on = await processEducationHook({ ...failure, tool_input: { command: "ls other" } }, f.env({ AIRCLAUDE_EDUCATION_ERROR_HINTS: "true" }));
    assert.match(on.hookSpecificOutput.additionalContext, /pwd/);
    await writeAssistant(f.transcript, "claude-opus-5-5");
    assert.equal(await processEducationHook({ ...failure, tool_input: { command: "ls third" } }, f.env({ AIRCLAUDE_EDUCATION_ERROR_HINTS: "true" })), null);
  } finally {
    await f.cleanup();
  }
});

test("subagent hooks use the subagent's own model, not the parent's", async () => {
  const f = await fixture("claude-sonnet-5");
  try {
    await writeAgent(f.transcript, "d1", "work", "kimi-k3");
    const out = await processEducationHook({ ...f.base, agent_id: "d1", agent_type: "general-purpose", hook_event_name: "PostToolUseFailure", tool_name: "Read", tool_input: { file_path: "/x" }, error: "File does not exist." }, f.env({ AIRCLAUDE_EDUCATION_ERROR_HINTS: "true" }));
    assert.match(out.hookSpecificOutput.additionalContext, /ls\/rg/);
  } finally {
    await f.cleanup();
  }
});

test("SubagentStop records the subagent's own model", async () => {
  const f = await fixture("claude-sonnet-5");
  try {
    await writeAgent(f.transcript, "e1", "Just do it.", "kimi-k3");
    await processEducationHook({ ...f.base, hook_event_name: "SubagentStop", agent_id: "e1", agent_type: "general-purpose", last_assistant_message: "done" }, f.env());
    const [record] = (await f.logs()).filter((entry) => entry.event === "SubagentStop");
    assert.equal(record.model, "kimi-k3");
  } finally {
    await f.cleanup();
  }
});

test("a rule override wins over its group in both directions", async () => {
  const f = await fixture();
  try {
    const failure = { ...f.base, hook_event_name: "PostToolUseFailure", tool_name: "Read", tool_input: { file_path: "/x" }, error: "File does not exist." };
    const env = f.env({ AIRCLAUDE_EDUCATION_RULES: JSON.stringify({ "read-missing": "enforce" }) });
    const on = await processEducationHook(failure, env);
    assert.match(on.hookSpecificOutput.additionalContext, /ls\/rg/, "errorHints=false, read-missing=enforce emits for gpt");
    await writeAssistant(f.transcript, "claude-sonnet-5");
    assert.equal(await processEducationHook({ ...failure, tool_input: { file_path: "/y" } }, env), null, "still model-gated");
  } finally {
    await f.cleanup();
  }
});

test("a rule switched off neither logs nor emits, but its state still updates", async () => {
  const f = await fixture();
  try {
    const env = f.env({ AIRCLAUDE_EDUCATION_ERROR_HINTS: "true", AIRCLAUDE_EDUCATION_RULES: JSON.stringify({ "edit-mismatch": "off" }) });
    const failure = { ...f.base, hook_event_name: "PostToolUseFailure", tool_name: "Edit", tool_input: { file_path: "/a", old_string: "x" }, error: "String to replace not found in file." };
    assert.equal(await processEducationHook(failure, env), null);
    assert.deepEqual((await f.logs()).map((entry) => entry.rule), []);
    const repeat = await processEducationHook(failure, env);
    assert.match(repeat.hookSpecificOutput.additionalContext, /Identical failing call/, "lastFailHash was kept");
  } finally {
    await f.cleanup();
  }
});

test("D3 off lets a cold spawn through under an enforced spawn guard", async () => {
  const f = await fixture();
  try {
    const env = f.env({ AIRCLAUDE_EDUCATION_SPAWN_GUARD: "enforce", AIRCLAUDE_EDUCATION_RULES: JSON.stringify({ D3: "off" }) });
    await processEducationHook({ ...f.base, hook_event_name: "UserPromptSubmit", prompt: "fix the flaky test" }, env);
    assert.equal(await processEducationHook({ ...f.base, hook_event_name: "PreToolUse", tool_name: "Agent", tool_input: { description: "fix test", prompt: "fix it" } }, env), null);
    assert.deepEqual((await f.logs()).map((entry) => entry.rule), ["spawn-allow"]);
  } finally {
    await f.cleanup();
  }
});

test("a spawn rule switched off is skipped, so the next rule in the chain decides", async () => {
  const run = async (rules) => {
    const f = await fixture();
    try {
      const env = f.env({ AIRCLAUDE_EDUCATION_SPAWN_GUARD: "enforce", AIRCLAUDE_EDUCATION_RULES: JSON.stringify(rules) });
      const toolInput = { description: "Deploy", prompt: "deploy it" };
      await processEducationHook({ ...f.base, hook_event_name: "UserPromptSubmit", prompt: "use subagents" }, env);
      await processEducationHook({ ...f.base, hook_event_name: "PostToolUse", tool_name: "Agent", tool_input: toolInput, tool_response: { isAsync: true, agentId: "g1", outputFile: "/tmp/g1.output" } }, env);
      await processEducationHook({ ...f.base, hook_event_name: "SubagentStop", agent_id: "g1", agent_type: "general-purpose", last_assistant_message: "done" }, env);
      await processEducationHook({ ...f.base, hook_event_name: "PostToolUseFailure", tool_name: "Agent", tool_input: toolInput, error: FINAL_DENIALS[0] }, env);
      await processEducationHook({ ...f.base, hook_event_name: "PreToolUse", tool_name: "Agent", tool_input: toolInput }, env);
      const [record] = (await f.logs()).filter((entry) => entry.event === "PreToolUse");
      return [record.rule, record.decision];
    } finally {
      await f.cleanup();
    }
  };
  assert.deepEqual(await run({}), ["D4", "deny"]);
  assert.deepEqual(await run({ D4: "off" }), ["D2", "deny"]);
  assert.deepEqual(await run({ D1: "off", D2: "off", D3: "off", D4: "off" }), ["spawn-allow", "allow"]);
});

test("unread-result off stops the Stop block but keeps the running note", async () => {
  const f = await fixture();
  try {
    const env = f.env({ AIRCLAUDE_EDUCATION_SUBAGENT_NUDGE: "enforce", AIRCLAUDE_EDUCATION_RULES: JSON.stringify({ "unread-result": "off" }) });
    await processEducationHook({ ...f.base, hook_event_name: "PostToolUse", tool_name: "Agent", tool_input: { description: "a" }, tool_response: { isAsync: true, agentId: "h1" } }, env);
    await processEducationHook({ ...f.base, hook_event_name: "PostToolUse", tool_name: "Agent", tool_input: { description: "b" }, tool_response: { isAsync: true, agentId: "h2" } }, env);
    await processEducationHook({ ...f.base, hook_event_name: "SubagentStop", agent_id: "h1", agent_type: "general-purpose", last_assistant_message: "Found it in src/compat/gateway.mjs:252" }, env);
    const out = await processEducationHook({ ...f.base, hook_event_name: "Stop", stop_hook_active: false, background_tasks: [{ id: "h2", type: "subagent", status: "running" }] }, env);
    assert.match(out.hookSpecificOutput.additionalContext, /still running/);
    assert.deepEqual((await f.logs()).filter((entry) => entry.event === "Stop").map((entry) => entry.rule), ["running-note"]);
  } finally {
    await f.cleanup();
  }
});

test("every group off but one rule enforced still runs the hook", async () => {
  const f = await fixture();
  try {
    const env = f.env({
      AIRCLAUDE_EDUCATION_SPAWN_GUARD: "off",
      AIRCLAUDE_EDUCATION_SUBAGENT_REPORT: "off",
      AIRCLAUDE_EDUCATION_SUBAGENT_NUDGE: "off",
      AIRCLAUDE_EDUCATION_ERROR_HINTS: "false",
      AIRCLAUDE_EDUCATION_RULES: JSON.stringify({ D3: "enforce" }),
    });
    await processEducationHook({ ...f.base, hook_event_name: "UserPromptSubmit", prompt: "fix the flaky test" }, env);
    const denied = await processEducationHook({ ...f.base, hook_event_name: "PreToolUse", tool_name: "Agent", tool_input: { description: "fix test", prompt: "fix it" } }, env);
    assert.equal(denied.hookSpecificOutput.permissionDecision, "deny");
    await writeAgent(f.transcript, "m1", "Just do it.");
    await processEducationHook({ ...f.base, hook_event_name: "SubagentStop", agent_id: "m1", agent_type: "general-purpose", last_assistant_message: "done" }, env);
    assert.deepEqual((await f.logs()).map((entry) => entry.rule), ["D3"], "log-only records follow their group");
  } finally {
    await f.cleanup();
  }
});

test("status-missing can be switched on while its group is off, and off while its group enforces", async () => {
  const f = await fixture();
  try {
    await writeAgent(f.transcript, "n1", "Look into it.\nFinish with STATUS: done|blocked|partial");
    await writeAgent(f.transcript, "n2", "Look into it.\nFinish with STATUS: done|blocked|partial");
    const stop = { ...f.base, hook_event_name: "SubagentStop", agent_type: "general-purpose", stop_hook_active: false, last_assistant_message: "I looked." };
    const on = f.env({ AIRCLAUDE_EDUCATION_SUBAGENT_REPORT: "off", AIRCLAUDE_EDUCATION_RULES: JSON.stringify({ "status-missing": "enforce" }) });
    assert.equal((await processEducationHook({ ...stop, agent_id: "n1" }, on)).decision, "block");
    const off = f.env({ AIRCLAUDE_EDUCATION_SUBAGENT_REPORT: "enforce", AIRCLAUDE_EDUCATION_RULES: JSON.stringify({ "status-missing": "off" }) });
    assert.equal(await processEducationHook({ ...stop, agent_id: "n2" }, off), null);
    assert.deepEqual((await f.logs()).map((entry) => [entry.rule, entry.decision]), [["status-missing", "block"], ["status-log", "log-only"]]);
  } finally {
    await f.cleanup();
  }
});

test("invalid flags log a config error and every rule passes", async () => {
  const f = await fixture();
  try {
    const env = { HOME: f.home, CLAUDE_PLUGIN_DATA: join(f.home, "data"), AIRCLAUDE_EDUCATION_SPAWN_GUARD: "loud" };
    assert.equal(await processEducationHook({ ...f.base, hook_event_name: "PreToolUse", tool_name: "Agent", tool_input: { prompt: "x" } }, env), null);
    const [record] = await f.logs();
    assert.equal(record.decision, "config-error");
  } finally {
    await f.cleanup();
  }
});

test("a broken rules env logs a config error and falls back to the groups", async () => {
  const f = await fixture();
  try {
    const env = f.env({ AIRCLAUDE_EDUCATION_SPAWN_GUARD: "enforce", AIRCLAUDE_EDUCATION_RULES: "{D3:off" });
    await processEducationHook({ ...f.base, hook_event_name: "UserPromptSubmit", prompt: "fix the flaky test" }, env);
    const denied = await processEducationHook({ ...f.base, hook_event_name: "PreToolUse", tool_name: "Agent", tool_input: { description: "fix test", prompt: "fix it" } }, env);
    assert.equal(denied.hookSpecificOutput.permissionDecision, "deny");
    const logged = await f.logs();
    assert.ok(logged.some((entry) => entry.decision === "config-error" && entry.reason.includes("AIRCLAUDE_EDUCATION_RULES")));
  } finally {
    await f.cleanup();
  }
});

test("runEducationHook ignores malformed input and writes JSON responses", async () => {
  const f = await fixture();
  try {
    const run = async (raw, env) => {
      let written = "";
      const output = new Writable({ write(chunk, _encoding, callback) { written += chunk; callback(); } });
      await runEducationHook({ env, input: Readable.from([raw]), output });
      return written;
    };
    assert.equal(await run("{not json", f.env()), "");
    const failure = { ...f.base, hook_event_name: "PostToolUseFailure", tool_name: "Edit", tool_input: {}, error: "String to replace not found in file." };
    const written = await run(JSON.stringify(failure), f.env({ AIRCLAUDE_EDUCATION_ERROR_HINTS: "true" }));
    assert.match(JSON.parse(written).hookSpecificOutput.additionalContext, /Re-Read/);
  } finally {
    await f.cleanup();
  }
});

test("managed files add the education hook only on request, in shadow by default", () => {
  const without = renderHeartbeatManagedFiles("/cfg");
  assert.equal(without.some((file) => file.relativePath.includes("education")), false);
  const files = renderHeartbeatManagedFiles("/cfg", "file:///runtime/src/context-heartbeat.mjs", { education: true });
  const hooks = JSON.parse(files.find((file) => file.relativePath.endsWith("hooks/hooks.json")).content).hooks;
  for (const event of EDUCATION_EVENTS) {
    assert.ok(hooks[event].some((entry) => entry.hooks[0].args[0].endsWith("/scripts/education/hook.mjs")), event);
  }
  assert.equal(hooks.UserPromptSubmit.length, 2, "heartbeat hook kept");
  const script = files.find((file) => file.relativePath.endsWith("education/hook.mjs")).content;
  assert.match(script, /file:\/\/\/runtime\/src\/education\.mjs/);
  assert.match(script, /"AIRCLAUDE_EDUCATION_SPAWN_GUARD":"shadow"/);
  assert.match(script, /"AIRCLAUDE_EDUCATION_ERROR_HINTS":"false"/);
  assert.deepEqual(educationHookEnv({ errorHints: true }).AIRCLAUDE_EDUCATION_ERROR_HINTS, "true");
  assert.match(script, /"AIRCLAUDE_EDUCATION_RULES":"\{\}"/, "no overrides still bakes an empty set");
  assert.equal(Object.keys(educationHookEnv({ errorHints: true })).length, 5);
  assert.equal(educationHookEnv({ rules: { "read-missing": "enforce" } }).AIRCLAUDE_EDUCATION_RULES, '{"read-missing":"enforce"}');
});
