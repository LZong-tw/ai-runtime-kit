import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { test } from "node:test";
import { educationHookEnv, renderHeartbeatManagedFiles } from "../src/context-heartbeat.mjs";
import {
  EDUCATION_EVENTS,
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

test("flags: valid values parse, missing or invalid fall back to off/false and are reported", () => {
  assert.deepEqual(readEducationConfig(flags({ AIRCLAUDE_EDUCATION_ERROR_HINTS: "true" })), {
    config: { spawnGuard: "shadow", subagentReport: "shadow", subagentNudge: "shadow", errorHints: true },
    errors: [],
  });
  const bad = readEducationConfig({ AIRCLAUDE_EDUCATION_SPAWN_GUARD: "on" });
  assert.equal(bad.config.spawnGuard, "off");
  assert.equal(bad.config.errorHints, false);
  assert.equal(bad.errors.length, 4);
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
  assert.equal(subagentPromptContract("Return the JSON schema below verbatim.\nSTATUS: done"), "fixed-format");
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

test("a classifier-rejected spawn is never resent (D4)", async () => {
  const f = await fixture();
  try {
    const env = f.env({ AIRCLAUDE_EDUCATION_SPAWN_GUARD: "enforce" });
    const toolInput = { description: "Deploy", prompt: "deploy it" };
    await processEducationHook({ ...f.base, hook_event_name: "UserPromptSubmit", prompt: "use subagents" }, env);
    await processEducationHook({ ...f.base, hook_event_name: "PostToolUseFailure", tool_name: "Agent", tool_input: toolInput, error: "Permission for this action was denied by the Claude Code auto mode classifier." }, env);
    const out = await processEducationHook({ ...f.base, hook_event_name: "PreToolUse", tool_name: "Agent", tool_input: toolInput }, env);
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /classifier/);
  } finally {
    await f.cleanup();
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
});
