import assert from "node:assert/strict";
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { classifyEarlyFinal, earlyFinalReason } from "../src/early-final.mjs";
import { EARLY_FINAL_MAX_BLOCKS, processEducationHook } from "../src/education.mjs";

const PROMISE = "我已確認設定檔位置。\n\n接下來我會執行單元測試並回報結果。";
const OTHER_PROMISE = "測試已跑完。\n\n下一步我會修改 parser 並補上測試。";
const THIRD_PROMISE = "解析完成。\n\n接下來我會改寫 tokenizer 並再跑一次測試。";

// --- classifier -----------------------------------------------------------

test("a final that promises its next step instead of taking it continues", () => {
  for (const text of [PROMISE, OTHER_PROMISE, "I found the config.\n\nNext I will run the unit tests and report back."]) {
    const verdict = classifyEarlyFinal(text);
    assert.equal(verdict.decision, "continue", text);
    assert.equal(verdict.reason, "promise", text);
    assert.ok(verdict.promise, text);
  }
});

test("finished finals and finals without a promise pass", () => {
  for (const text of ["", "All tests pass. Here is the summary of changes.", "已完成，修改如下：\n\n- 改了 parser\n- 補了測試"]) {
    assert.equal(classifyEarlyFinal(text).decision, "allow", text);
  }
});

test("questions, authorization requests, phase gates, offers and blockers end the turn on purpose", () => {
  const cases = {
    question: "我已備妥修改。\n\n接下來我會執行 migration，要我現在就開始嗎？",
    authorization: "修改已備妥。\n\n接下來我會套用設定，但這需要你的授權，請確認是否可以。",
    "phase-gate": "第一階段完成。\n\n依計畫停在這裡等你審查，審查通過後我會進行第二階段。",
    offer: "初步分析完成。\n\n若你要我繼續，我會接著補上整合測試。",
    blocker: "我卡在權限不足。\n\n接下來我會讀取設定，但目前被擋住了，需要你協助開權限。",
  };
  for (const [veto, text] of Object.entries(cases)) {
    const verdict = classifyEarlyFinal(text);
    assert.equal(verdict.decision, "allow", veto);
    assert.equal(verdict.reason, "veto", veto);
    assert.ok(verdict.vetoes.includes(veto), `${veto}: ${verdict.vetoes}`);
  }
  assert.equal(classifyEarlyFinal("I checked the parser.\n\nNext I will run the unit tests. Should I also update the docs?").decision, "allow");
});

test("a final that hands the user a command to run passes", () => {
  const verdict = classifyEarlyFinal("請在你的終端機執行：\n\n```bash\nkubectl -n web get pods\n```\n\n完成後我會接著檢查結果。");
  assert.equal(verdict.decision, "allow");
  assert.ok(verdict.vetoes.includes("hands-command"));
});

test("a promised write step or production step is never pushed", () => {
  assert.equal(classifyEarlyFinal("測試通過。\n\n接下來我會把分支 merge 進 main。").reason, "next-step-write");
  const production = "已確認。\n\n下一步我會到 production 叢集查看 pod 狀態。";
  assert.equal(classifyEarlyFinal(production).reason, "production-gate");
  assert.equal(classifyEarlyFinal(production, { production: "allow" }).decision, "continue", "policy A only for the replay comparison");
});

test("background work still running lets a waiting final through; nothing running makes it a phantom wait", () => {
  const text = "背景查核還在執行，我會等結果回來再整理。";
  assert.deepEqual(
    [classifyEarlyFinal(text, { backgroundRunning: 1 }).decision, classifyEarlyFinal(text, { backgroundRunning: 1 }).reason],
    ["allow", "background-running"],
  );
  assert.equal(classifyEarlyFinal(PROMISE, { backgroundRunning: 2 }).decision, "allow");
  assert.equal(classifyEarlyFinal(text).reason, "phantom-wait");
});

test("the recorded promise is bounded and redacted", () => {
  const verdict = classifyEarlyFinal(`I will now check the logs with token sk-${"a".repeat(30)} and mail someone@example.com.`);
  assert.doesNotMatch(verdict.promise, /sk-a{10}|someone@example\.com/);
  const long = classifyEarlyFinal(`接下來我會${"檢查設定".repeat(80)}。`);
  assert.ok(long.promise.length <= 121, String(long.promise.length));
});

test("the continuation prompt only reopens the promised, authorized step", () => {
  const reason = earlyFinalReason("接下來我會執行單元測試並回報結果");
  assert.match(reason, /接下來我會執行單元測試並回報結果/);
  assert.match(reason, /已經要求並授權/);
  assert.match(reason, /不要擴大範圍/);
  assert.match(reason, /production/);
  assert.match(reason, /merge、apply、sync、deploy、刪除/);
  assert.match(reason, /直接結束這一輪/);
  assert.match(earlyFinalReason("我會等結果", { phantomWait: true }), /沒有任何背景工作還在執行/);
  assert.match(earlyFinalReason(null), /未擷取到/);
});

// --- hook -----------------------------------------------------------------

async function fixture(model = "gpt-6.1-sol") {
  const home = await mkdtemp(join(tmpdir(), "airkit-early-final-"));
  const transcript = join(home, "session.jsonl");
  await writeFile(transcript, `${JSON.stringify({ type: "user", message: { role: "user", content: "start" } })}\n${JSON.stringify({ type: "assistant", message: { model, content: [{ type: "text", text: "working" }] } })}\n`);
  const env = (overrides = {}) => ({
    HOME: home,
    CLAUDE_PLUGIN_DATA: join(home, "data"),
    AIRCLAUDE_EDUCATION_SPAWN_GUARD: "off",
    AIRCLAUDE_EDUCATION_SUBAGENT_REPORT: "off",
    AIRCLAUDE_EDUCATION_SUBAGENT_NUDGE: "off",
    AIRCLAUDE_EDUCATION_ERROR_HINTS: "false",
    ...overrides,
  });
  const base = { session_id: "s1", transcript_path: transcript, cwd: home };
  const hook = (input, overrides) => processEducationHook({ ...base, ...input }, env(overrides));
  const prompt = (text = "fix the parser") => hook({ hook_event_name: "UserPromptSubmit", prompt: text });
  const tool = (name = "Read") => hook({ hook_event_name: "PostToolUse", tool_name: name, tool_input: { file_path: "/x" }, tool_response: "ok" });
  const stop = (text, extra = {}, overrides) => hook({ hook_event_name: "Stop", stop_hook_active: false, last_assistant_message: text, ...extra }, overrides);
  const logs = async (rule) => {
    try {
      const all = (await readFile(join(home, ".claude-code-router", "logs", "airkit-education.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
      return rule ? all.filter((record) => record.rule === rule) : all;
    } catch {
      return [];
    }
  };
  return { transcript, hook, prompt, tool, stop, logs, cleanup: () => rm(home, { recursive: true, force: true }) };
}

const ENFORCE = { AIRCLAUDE_EDUCATION_EARLY_FINAL: "enforce" };

test("shadow is the default: an early final is logged as a block but never sent", async () => {
  const f = await fixture();
  try {
    await f.prompt();
    assert.equal(await f.stop(PROMISE), null);
    const [record] = await f.logs("early-final");
    assert.equal(record.decision, "block");
    assert.equal(record.emitted, false);
    assert.equal(record.reason, "promise");
    assert.equal(record.evidence.promise, "接下來我會執行單元測試並回報結果");
    assert.equal(record.flags.earlyFinal, "shadow");
  } finally {
    await f.cleanup();
  }
});

test("enforce sends the promised step back, and a reply without any tool call is judged too", async () => {
  const f = await fixture();
  try {
    await f.prompt();
    const out = await f.stop(PROMISE, {}, ENFORCE);
    assert.equal(out.decision, "block");
    assert.match(out.reason, /接下來我會執行單元測試並回報結果/);
    const [record] = await f.logs("early-final");
    assert.equal(record.emitted, true);
    assert.equal(record.evidence.turnCalls, 0, "no tool call this turn");
  } finally {
    await f.cleanup();
  }
});

test("off skips the rule, and phantom-wait can be switched on its own", async () => {
  const f = await fixture();
  try {
    await f.prompt();
    assert.equal(await f.stop(PROMISE, {}, { AIRCLAUDE_EDUCATION_EARLY_FINAL: "off" }), null);
    assert.deepEqual(await f.logs("early-final"), []);
    const wait = "背景查核還在執行，我會等結果回來再整理。";
    const rules = JSON.stringify({ "phantom-wait": "shadow" });
    assert.equal(await f.stop(wait, {}, { ...ENFORCE, AIRCLAUDE_EDUCATION_RULES: rules }), null, "phantom-wait in shadow");
    const [record] = await f.logs("phantom-wait");
    assert.deepEqual([record.decision, record.emitted], ["block", false]);
    assert.equal((await f.stop(wait, {}, { AIRCLAUDE_EDUCATION_RULES: JSON.stringify({ "phantom-wait": "enforce" }) })).decision, "block");
  } finally {
    await f.cleanup();
  }
});

test("only the listed models are judged; Claude never is", async () => {
  for (const model of ["claude-sonnet-5-5", "GLM-5.3"]) {
    const f = await fixture(model);
    try {
      await f.prompt();
      assert.equal(await f.stop(PROMISE, {}, ENFORCE), null, model);
      assert.deepEqual(await f.logs("early-final"), [], model);
    } finally {
      await f.cleanup();
    }
  }
  const f = await fixture("GLM-5.3");
  try {
    await f.prompt();
    const out = await f.stop(PROMISE, {}, { ...ENFORCE, AIRCLAUDE_EDUCATION_EARLY_FINAL_MODELS: '["^glm-"]' });
    assert.equal(out.decision, "block", "a profile can opt another model in");
  } finally {
    await f.cleanup();
  }
  const routed = await fixture("oneportal_responses,gpt-6-luna");
  try {
    await routed.prompt();
    assert.equal((await routed.stop(PROMISE, {}, ENFORCE)).decision, "block", "provider prefix is stripped");
  } finally {
    await routed.cleanup();
  }
});

test("an invalid model list is a config error and judges nothing", async () => {
  const f = await fixture();
  try {
    await f.prompt();
    assert.equal(await f.stop(PROMISE, {}, { ...ENFORCE, AIRCLAUDE_EDUCATION_EARLY_FINAL_MODELS: '["("]' }), null);
    assert.deepEqual(await f.logs("early-final"), []);
    assert.match((await f.logs("config")).at(-1).reason, /AIRCLAUDE_EDUCATION_EARLY_FINAL_MODELS/);
  } finally {
    await f.cleanup();
  }
});

test("running background agents, workflows or shells let the final through", async () => {
  const f = await fixture();
  try {
    await f.prompt();
    await f.hook({ hook_event_name: "PostToolUse", tool_name: "Agent", tool_input: { description: "scan" }, tool_response: { isAsync: true, agentId: "a1" } }, ENFORCE);
    assert.equal(await f.stop(PROMISE, {}, ENFORCE), null, "spawned agent has not ended");
    let record = (await f.logs("early-final")).at(-1);
    assert.deepEqual([record.decision, record.reason, record.evidence.backgroundRunning], ["allow", "background-running", ["a1"]]);
    await f.hook({ hook_event_name: "SubagentStop", agent_id: "a1", agent_type: "general-purpose", last_assistant_message: "STATUS: done" }, ENFORCE);
    assert.equal(await f.stop(PROMISE, { background_tasks: [{ id: "w1", type: "workflow", status: "running" }] }, ENFORCE), null);
    record = (await f.logs("early-final")).at(-1);
    assert.deepEqual(record.evidence.backgroundRunning, ["w1"]);
    assert.equal(await f.stop(PROMISE, { background_tasks: [{ id: "w1", type: "workflow", status: "completed" }] }, ENFORCE).then((out) => out.decision), "block");
  } finally {
    await f.cleanup();
  }
});

test("blocks are bounded per turn and a repeat needs a new tool call and a new promise", async () => {
  const f = await fixture();
  try {
    await f.prompt();
    assert.equal((await f.stop(PROMISE, {}, ENFORCE)).decision, "block");
    // Same promise, no tool call in between: the model is looping.
    assert.equal(await f.stop(PROMISE, { stop_hook_active: true }, ENFORCE), null);
    assert.equal((await f.logs("early-final")).at(-1).reason, "loop-no-new-call");
    await f.tool();
    assert.equal(await f.stop(PROMISE, { stop_hook_active: true }, ENFORCE), null);
    assert.equal((await f.logs("early-final")).at(-1).reason, "loop-same-promise");
    await f.tool();
    assert.equal((await f.stop(OTHER_PROMISE, { stop_hook_active: true }, ENFORCE)).decision, "block", "second block");
    await f.tool();
    assert.equal(EARLY_FINAL_MAX_BLOCKS, 2);
    assert.equal(await f.stop(THIRD_PROMISE, { stop_hook_active: true }, ENFORCE), null);
    assert.equal((await f.logs("early-final")).at(-1).reason, "budget-exhausted");
    // A new user turn restores the budget.
    await f.prompt("continue");
    assert.equal((await f.stop(PROMISE, {}, ENFORCE)).decision, "block");
  } finally {
    await f.cleanup();
  }
});

test("compaction, resume, clear and fork reset the turn budget", async () => {
  for (const reset of [
    { hook_event_name: "PostCompact", trigger: "auto" },
    { hook_event_name: "SessionStart", source: "compact" },
    { hook_event_name: "SessionStart", source: "resume" },
    { hook_event_name: "SessionStart", source: "clear" },
  ]) {
    const f = await fixture();
    try {
      await f.prompt();
      assert.equal((await f.stop(PROMISE, {}, ENFORCE)).decision, "block");
      await f.tool();
      assert.equal((await f.stop(OTHER_PROMISE, { stop_hook_active: true }, ENFORCE)).decision, "block");
      await f.hook(reset, ENFORCE);
      const record = (await f.logs("early-final")).find((entry) => entry.decision === "reset");
      assert.equal(record.evidence.hadBudget, true, JSON.stringify(reset));
      assert.equal((await f.stop(THIRD_PROMISE, {}, ENFORCE)).decision, "block", `budget restored after ${JSON.stringify(reset)}`);
    } finally {
      await f.cleanup();
    }
  }
  // A fork is a new session id, so it starts with a fresh state file.
  const f = await fixture();
  try {
    await f.prompt();
    await f.stop(PROMISE, {}, ENFORCE);
    await f.tool();
    await f.stop(OTHER_PROMISE, { stop_hook_active: true }, ENFORCE);
    await f.hook({ hook_event_name: "UserPromptSubmit", session_id: "fork", prompt: "go on" }, ENFORCE);
    assert.equal((await f.hook({ hook_event_name: "Stop", session_id: "fork", last_assistant_message: THIRD_PROMISE }, ENFORCE)).decision, "block");
  } finally {
    await f.cleanup();
  }
});

test("agents spawned before a resume no longer count as running", async () => {
  const f = await fixture();
  try {
    await f.prompt();
    await f.hook({ hook_event_name: "PostToolUse", tool_name: "Agent", tool_input: { description: "scan" }, tool_response: { isAsync: true, agentId: "a1" } }, ENFORCE);
    assert.equal(await f.stop(PROMISE, {}, ENFORCE), null);
    await f.hook({ hook_event_name: "SessionStart", source: "resume" }, ENFORCE);
    await f.prompt("continue");
    assert.equal((await f.stop(PROMISE, {}, ENFORCE)).decision, "block");
  } finally {
    await f.cleanup();
  }
});

test("subagent stops and question finals are never blocked", async () => {
  const f = await fixture();
  try {
    await f.prompt();
    assert.equal(await f.stop(PROMISE, { agent_id: "a9" }, ENFORCE), null);
    assert.equal(await f.stop("我已備妥修改。\n\n接下來我會執行 migration，要我現在就開始嗎？", {}, ENFORCE), null);
    const record = (await f.logs("early-final")).at(-1);
    assert.deepEqual([record.decision, record.reason, record.evidence.vetoes], ["allow", "veto", ["question"]]);
  } finally {
    await f.cleanup();
  }
});

test("without last_assistant_message the hook reads the final from the transcript", async () => {
  const f = await fixture();
  try {
    await f.prompt();
    assert.equal(await f.hook({ hook_event_name: "Stop", stop_hook_active: false }, ENFORCE), null, "'working' promises nothing");
    assert.equal((await f.logs("early-final")).at(-1).reason, "no-promise");
    const final = { type: "assistant", message: { model: "gpt-6.1-sol", content: [{ type: "text", text: PROMISE }] } };
    await appendFile(f.transcript, `${JSON.stringify(final)}\n`);
    assert.equal((await f.hook({ hook_event_name: "Stop", stop_hook_active: false }, ENFORCE)).decision, "block");
  } finally {
    await f.cleanup();
  }
});
