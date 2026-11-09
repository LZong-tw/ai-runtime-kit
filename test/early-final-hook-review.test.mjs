// Reviewer cases for the early-final hook (review of ca487c5, 2026-11-09):
// budgets across compaction, missing state, background work the hook tracks
// and plan-only turns.
//
// Not asserted either way, left to the owner: a long-lived background shell
// (a dev server) counts as running work, so it lets every final through until
// it is stopped or reported finished. That is requirement (2) read literally.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { processEducationHook } from "../src/education.mjs";

const PROMISE = "我已確認設定檔位置。\n\n接下來我會執行單元測試並回報結果。";
const FIX_PROMISE = "parser 已修好。\n\n接下來我會跑完整測試確認沒有 regression。";
const WAITING = "背景查核還在執行，我會等結果回來再整理。";

async function fixture({ pluginData = true, extraEnv = {} } = {}) {
  const home = await mkdtemp(join(tmpdir(), "airkit-ef-review-"));
  const transcript = join(home, "s.jsonl");
  await writeFile(transcript, `${JSON.stringify({ type: "assistant", message: { model: "gpt-6.1-sol", content: [{ type: "text", text: "x" }] } })}\n`);
  const env = {
    HOME: home,
    AIRCLAUDE_EDUCATION_SPAWN_GUARD: "off",
    AIRCLAUDE_EDUCATION_SUBAGENT_REPORT: "off",
    AIRCLAUDE_EDUCATION_SUBAGENT_NUDGE: "off",
    AIRCLAUDE_EDUCATION_ERROR_HINTS: "false",
    AIRCLAUDE_EDUCATION_EARLY_FINAL: "enforce",
    ...(pluginData ? { CLAUDE_PLUGIN_DATA: join(home, "data") } : {}),
    ...extraEnv,
  };
  const hook = (input) => processEducationHook({ session_id: "s1", transcript_path: transcript, cwd: home, ...input }, env);
  return {
    hook,
    prompt: (prompt = "fix the parser") => hook({ hook_event_name: "UserPromptSubmit", prompt }),
    tool: () => hook({ hook_event_name: "PostToolUse", tool_name: "Read", tool_input: { file_path: "/x" }, tool_response: "ok" }),
    spawn: (agentId = "a1") => hook({ hook_event_name: "PostToolUse", tool_name: "Agent", tool_input: { description: "scan" }, tool_response: { isAsync: true, agentId } }),
    shell: (id = "b1") => hook({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: "toolu_1", tool_input: { command: "npm test", run_in_background: true }, tool_response: { backgroundTaskId: id } }),
    stop: (text, extra = {}) => hook({ hook_event_name: "Stop", stop_hook_active: false, last_assistant_message: text, ...extra }),
    cleanup: () => rm(home, { recursive: true, force: true }),
  };
}

const PHANTOM_ENFORCE = { AIRCLAUDE_EDUCATION_RULES: JSON.stringify({ "phantom-wait": "enforce" }) };

test("FP-hook: a question and an if-it-were-me answer pass under enforce, also with no tool call", async () => {
  const f = await fixture();
  try {
    const results = [];
    for (const text of ["要繼續第二階段嗎？我會等你回覆。", "如果是我，我會先處理 corpus 的位置，再決定 completionGuard 的去留。"]) {
      await f.prompt("你覺得呢？");
      results.push((await f.stop(text, { background_tasks: [] }))?.decision ?? "allow");
    }
    assert.deepEqual(results, ["allow", "allow"]);
  } finally {
    await f.cleanup();
  }
});

test("FN-hook: a background spawn reported completed, or stopped with TaskStop, no longer holds the guard open", async () => {
  for (const variant of ["completed", "taskstop"]) {
    const f = await fixture();
    try {
      await f.prompt("fix");
      await f.spawn("a1");
      let background_tasks = [];
      if (variant === "completed") background_tasks = [{ id: "a1", type: "subagent", status: "completed" }];
      else await f.hook({ hook_event_name: "PostToolUse", tool_name: "TaskStop", tool_input: { task_id: "a1" }, tool_response: "stopped" });
      await f.prompt("next turn");
      assert.equal((await f.stop(FIX_PROMISE, { background_tasks }))?.decision, "block", variant);
    } finally {
      await f.cleanup();
    }
  }
});

test("FN-hook control: with nothing spawned the same final is sent back", async () => {
  const f = await fixture();
  try {
    await f.prompt("fix");
    assert.equal((await f.stop(FIX_PROMISE, { background_tasks: [] }))?.decision, "block");
  } finally {
    await f.cleanup();
  }
});

test("F5: without a state file a Stop that is already a continuation passes", async () => {
  const f = await fixture({ pluginData: false });
  try {
    await f.prompt();
    let blocks = 0;
    for (let i = 0; i < 6; i++) if ((await f.stop(PROMISE, { stop_hook_active: i > 0 }))?.decision === "block") blocks += 1;
    assert.equal(blocks, 1);
  } finally {
    await f.cleanup();
  }
});

test("F6: mid-turn auto-compaction does not reset the per-turn block cap", async () => {
  const f = await fixture();
  try {
    await f.prompt();
    let blocks = 0;
    for (let cycle = 0; cycle < 3; cycle++) {
      if ((await f.stop(PROMISE, { stop_hook_active: cycle > 0 }))?.decision === "block") blocks += 1;
      await f.tool();
      if ((await f.stop(PROMISE.replace("單元", "整合"), { stop_hook_active: true }))?.decision === "block") blocks += 1;
      await f.hook({ hook_event_name: "PostCompact", trigger: "auto" });
    }
    assert.equal(blocks, 2);
  } finally {
    await f.cleanup();
  }
});

test("F7: SessionStart(compact) keeps a running background agent running; resume orphans it", async () => {
  const f = await fixture({ extraEnv: PHANTOM_ENFORCE });
  try {
    await f.prompt("scan");
    await f.spawn("a1");
    await f.hook({ hook_event_name: "SessionStart", source: "compact" });
    assert.equal(await f.stop(WAITING), null);
    await f.hook({ hook_event_name: "SessionStart", source: "resume" });
    await f.prompt("go on");
    assert.equal((await f.stop(WAITING))?.decision, "block", "an agent spawned before a resume never reports back");
  } finally {
    await f.cleanup();
  }
});

test("F8: a plan-only request is not pushed into implementation", async () => {
  const f = await fixture();
  try {
    await f.prompt("先給我計畫就好，不要動手改程式，等我說 go");
    assert.equal(await f.stop("計畫如下：\n\n1. 改 parser\n2. 補測試\n\n接下來我會先修改 parser。"), null);
    await f.prompt("go");
    assert.equal((await f.stop("計畫如下：\n\n1. 改 parser\n2. 補測試\n\n接下來我會先修改 parser。"))?.decision, "block", "the next turn is not plan-only");
  } finally {
    await f.cleanup();
  }
});

test("F10: group enforce leaves phantom-wait in shadow; naming it enforces it", async () => {
  const shadow = await fixture();
  try {
    await shadow.prompt("run the tests");
    assert.equal(await shadow.stop("npm test 還在背景跑，我會等它跑完。"), null);
  } finally {
    await shadow.cleanup();
  }
  const enforced = await fixture({ extraEnv: PHANTOM_ENFORCE });
  try {
    await enforced.prompt("run the tests");
    assert.equal((await enforced.stop("npm test 還在背景跑，我會等它跑完。"))?.decision, "block");
  } finally {
    await enforced.cleanup();
  }
});

test("background shells count as running until stopped or reported finished", async () => {
  for (const settle of ["kill", "taskstop", "reported"]) {
    const f = await fixture({ extraEnv: PHANTOM_ENFORCE });
    try {
      await f.prompt("run the tests in the background");
      await f.shell("b1");
      assert.equal(await f.stop(WAITING), null, "shell b1 is running");
      let background_tasks;
      if (settle === "kill") await f.hook({ hook_event_name: "PostToolUse", tool_name: "KillShell", tool_input: { shell_id: "b1" }, tool_response: "killed" });
      else if (settle === "taskstop") await f.hook({ hook_event_name: "PostToolUse", tool_name: "TaskStop", tool_input: { task_id: "b1" }, tool_response: "stopped" });
      else background_tasks = [{ id: "b1", type: "shell", status: "completed" }];
      await f.prompt("next");
      assert.equal((await f.stop(WAITING, background_tasks ? { background_tasks } : {}))?.decision, "block", settle);
    } finally {
      await f.cleanup();
    }
  }
});
