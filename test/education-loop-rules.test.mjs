import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { EDUCATION_RULES, EDUCATION_RULES_VERSION, cliProgram, errorHint, processEducationHook, summarizeEducationLog } from "../src/education.mjs";

// Rule set 6: same-result-poll, cli-flag-guess and blocked-retry
// (reports/model-complaint-2026-11-05.md §5 in the internal repository).

async function fixture(model = "kimi-k3", flags = {}) {
  const home = await mkdtemp(join(tmpdir(), "airkit-loop-"));
  const transcript = join(home, "session.jsonl");
  await writeFile(transcript, `${JSON.stringify({ type: "assistant", message: { model, content: [{ type: "text", text: "working" }] } })}\n`);
  const env = {
    HOME: home,
    CLAUDE_PLUGIN_DATA: join(home, "data"),
    AIRCLAUDE_EDUCATION_SPAWN_GUARD: "off",
    AIRCLAUDE_EDUCATION_SUBAGENT_REPORT: "off",
    AIRCLAUDE_EDUCATION_SUBAGENT_NUDGE: "off",
    AIRCLAUDE_EDUCATION_ERROR_HINTS: "off",
    ...flags,
  };
  const base = { session_id: "s1", transcript_path: transcript, cwd: home };
  const send = (event) => processEducationHook({ ...base, ...event }, env);
  const pre = (tool_name, tool_input, extra = {}) => send({ hook_event_name: "PreToolUse", tool_name, tool_input, ...extra });
  const ok = (tool_name, tool_input, tool_response, extra = {}) => send({ hook_event_name: "PostToolUse", tool_name, tool_input, tool_response, ...extra });
  const fail = (tool_name, tool_input, error, extra = {}) => send({ hook_event_name: "PostToolUseFailure", tool_name, tool_input, error, ...extra });
  const logs = async (rule) => {
    try {
      return (await readFile(join(home, ".claude-code-router", "logs", "airkit-education.jsonl"), "utf8"))
        .trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((record) => !rule || record.rule === rule);
    } catch {
      return [];
    }
  };
  return { send, pre, ok, fail, logs, cleanup: () => rm(home, { recursive: true, force: true }) };
}

const bash = (command, extra = {}) => ({ command, description: "check", ...extra });
const out = (stdout, stderr = "") => ({ stdout, stderr, interrupted: false, isImage: false });
const SAME = "replicas: 3 (set by HelmRelease spec.values.replicaCount)";

test("rule set 6 registers the three loop rules under their own groups", () => {
  assert.equal(EDUCATION_RULES_VERSION, 6);
  assert.equal(EDUCATION_RULES["same-result-poll"], "sameResultPoll");
  assert.equal(EDUCATION_RULES["cli-flag-guess"], "cliFlagGuess");
  assert.equal(EDUCATION_RULES["blocked-retry"], "blockedRetry");
});

test("same-result-poll logs once when five different queries return the same answer", async () => {
  const f = await fixture();
  try {
    for (let index = 0; index < 4; index += 1) {
      assert.equal(await f.ok("Bash", bash(`kubectl get deploy web -o jsonpath=${index}`), out(SAME)), null);
    }
    assert.equal((await f.logs("same-result-poll")).length, 0, "four is under the threshold");
    assert.equal(await f.ok("Grep", { pattern: "replicas" }, { mode: "content", content: SAME, numLines: 1 }), null, "shadow never injects");
    await f.ok("Bash", bash("kubectl describe deploy web"), out(SAME));
    const records = await f.logs("same-result-poll");
    assert.equal(records.length, 1, "one run, one record");
    assert.equal(records[0].decision, "hint");
    assert.equal(records[0].emitted, false);
    assert.equal(records[0].rules, 6);
    assert.equal(records[0].evidence.calls, 5);
    assert.equal(records[0].reason, "結果一直沒變，來源可能在上游：去查是誰設定這個值，或先停下來回報");
  } finally {
    await f.cleanup();
  }
});

test("same-result-poll enforce injects the hint for a non-Claude model only", async () => {
  for (const [model, expected] of [["kimi-k3", true], ["claude-sonnet-5-5", false]]) {
    const f = await fixture(model, { AIRCLAUDE_EDUCATION_SAME_RESULT_POLL: "enforce" });
    try {
      let last = null;
      for (let index = 0; index < 5; index += 1) last = await f.ok("Bash", bash(`kubectl get deploy web #${index}`), out(SAME));
      assert.equal(Boolean(last?.hookSpecificOutput?.additionalContext?.includes("結果一直沒變")), expected, model);
      assert.equal((await f.logs("same-result-poll")).length, 1);
    } finally {
      await f.cleanup();
    }
  }
});

test("same-result-poll false positives: one command polled, empty results, edits, a changed result", async () => {
  const f = await fixture();
  try {
    // The same command five times is polling, not five different queries.
    for (let index = 0; index < 6; index += 1) await f.ok("Bash", bash("kubectl get deploy web"), out(SAME));
    // A description change alone does not make it a different query.
    for (let index = 0; index < 3; index += 1) await f.ok("Bash", bash("kubectl get deploy web", { description: `try ${index}` }), out(SAME));
    // Different searches that all find nothing.
    for (let index = 0; index < 6; index += 1) await f.ok("Grep", { pattern: `nothing${index}` }, { mode: "files_with_matches", filenames: [], numFiles: 0 });
    for (let index = 0; index < 6; index += 1) await f.ok("Bash", bash(`test -f /x${index}`), out(""));
    // Waiting commands are expected to repeat themselves.
    for (let index = 0; index < 6; index += 1) await f.ok("Bash", bash(`sleep ${index}; kubectl rollout status deploy/web`), out(SAME));
    assert.equal((await f.logs("same-result-poll")).length, 0);

    // Empty and waiting calls were neutral, so the polled command's run is
    // still open; a different answer closes it.
    await f.ok("Bash", bash("cat reset"), out("a different answer that is long enough"));
    // Four, then an edit, then four more: the edit starts a new run.
    for (let index = 0; index < 4; index += 1) await f.ok("Bash", bash(`cat a${index}`), out(SAME));
    await f.ok("Edit", { file_path: "/x", old_string: "a", new_string: "b" }, { filePath: "/x" });
    for (let index = 4; index < 8; index += 1) await f.ok("Bash", bash(`cat a${index}`), out(SAME));
    // Four, then a different answer, then four more.
    await f.ok("Bash", bash("cat other"), out("a different answer that is long enough"));
    for (let index = 8; index < 12; index += 1) await f.ok("Bash", bash(`cat a${index}`), out(SAME));
    assert.equal((await f.logs("same-result-poll")).length, 0);

    // Five Edits return the same success line; edits never count.
    for (let index = 0; index < 6; index += 1) {
      await f.ok("Edit", { file_path: `/f${index}`, old_string: "a", new_string: "b" }, "The file has been updated successfully.");
    }
    assert.equal((await f.logs("same-result-poll")).length, 0);
  } finally {
    await f.cleanup();
  }
});

test("same-result-poll keeps parallel actors apart and restarts on a new user turn", async () => {
  const f = await fixture();
  try {
    // Parent and a subagent interleave; neither reaches five on its own.
    for (let index = 0; index < 4; index += 1) {
      await f.ok("Bash", bash(`get parent ${index}`), out(SAME));
      await f.ok("Bash", bash(`get child ${index}`), out(SAME), { agent_id: "a1", agent_type: "Explore" });
    }
    await f.send({ hook_event_name: "UserPromptSubmit", prompt: "try again" });
    await f.ok("Bash", bash("get parent 9"), out(SAME));
    assert.equal((await f.logs("same-result-poll")).length, 0);
  } finally {
    await f.cleanup();
  }
});

test("cli-flag-guess logs on the third consecutive argument error of one CLI", async () => {
  const f = await fixture("deepseek-v4-1-flash");
  try {
    await f.fail("Bash", bash("devops logs --stream web"), "Exit code 2\nError: unknown flag: --stream");
    await f.fail("Bash", bash("cd /repo && devops oo --stream web"), "Exit code 2\nerror: unexpected argument '--stream' found\n\nUsage: devops oo [OPTIONS]");
    assert.equal((await f.logs("cli-flag-guess")).length, 0);
    // A config warning on a zero exit counts too (case #2: 「未配置」).
    assert.equal(await f.ok("Bash", bash("devops oo --list-streams"), out("⚠️ OpenObserve 未配置")), null, "shadow never injects");
    const records = await f.logs("cli-flag-guess");
    assert.equal(records.length, 1);
    assert.equal(records[0].evidence.program, "devops");
    assert.equal(records[0].evidence.failures, 3);
    assert.equal(records[0].emitted, false);
    assert.equal(records[0].reason, "先讀完整的 `--help` 再試");
    // Not repeated on the fourth.
    await f.fail("Bash", bash("devops oo --foo"), "Error: unknown option '--foo'");
    assert.equal((await f.logs("cli-flag-guess")).length, 1);
  } finally {
    await f.cleanup();
  }
});

test("cli-flag-guess enforce injects on the failure event", async () => {
  const f = await fixture("grok-4.7", { AIRCLAUDE_EDUCATION_CLI_FLAG_GUESS: "enforce" });
  try {
    await f.fail("Bash", bash("twg search --cql x"), "Error: unknown option '--cql'");
    await f.fail("Bash", bash("twg search --query-cql x"), "Error: unknown option '--query-cql'");
    const response = await f.fail("Bash", bash("twg search --jql x"), "Error: unknown option '--jql'");
    assert.match(response.hookSpecificOutput.additionalContext, /先讀完整的 `--help` 再試/);
    assert.equal(response.hookSpecificOutput.hookEventName, "PostToolUseFailure");
  } finally {
    await f.cleanup();
  }
});

test("cli-flag-guess false positives: help read, different CLIs, other failures, a success between", async () => {
  const f = await fixture();
  try {
    // The full --help was read first.
    await f.ok("Bash", bash("glab mr create --help"), out("Usage: glab mr create [flags]"));
    for (const flag of ["--a", "--b", "--c"]) await f.fail("Bash", bash(`glab mr create ${flag}`), `Error: unknown flag: ${flag}`);
    // Three different CLIs fail once each.
    await f.fail("Bash", bash("aws s3 ls --bad"), "Unknown options: --bad");
    await f.fail("Bash", bash("kubectl get --bad"), "error: unknown flag: --bad");
    await f.fail("Bash", bash("helm list --bad"), "Error: unknown flag: --bad");
    // Network and missing-file failures are not argument errors.
    for (let index = 0; index < 3; index += 1) await f.fail("Bash", bash(`curl https://x/${index}`), "curl: (6) Could not resolve host: x");
    for (let index = 0; index < 3; index += 1) await f.fail("Bash", bash(`ls /nope${index}`), "ls: /nope: No such file or directory");
    // Two errors, a success, two errors.
    await f.fail("Bash", bash("jq --bad1 ."), "jq: Unknown option: --bad1");
    await f.fail("Bash", bash("jq --bad2 ."), "jq: Unknown option: --bad2");
    await f.ok("Bash", bash("jq . a.json"), out('{"a":1}'));
    await f.fail("Bash", bash("jq --bad3 ."), "jq: Unknown option: --bad3");
    await f.fail("Bash", bash("jq --bad4 ."), "jq: Unknown option: --bad4");
    // A file that prints a usage banner or "unknown option" is content, not an error.
    for (let index = 0; index < 3; index += 1) await f.ok("Bash", bash(`cat README${index}.md`), out("Usage: tool [options]\nunknown option handling"));
    for (let index = 0; index < 3; index += 1) await f.ok("Bash", bash(`node build.mjs ${index}`), out("Usage:\n  build.mjs builds things"));
    assert.equal((await f.logs("cli-flag-guess")).length, 0);
  } finally {
    await f.cleanup();
  }
});

test("cli-flag-guess: a truncated --help does not count as reading it", async () => {
  const f = await fixture();
  try {
    await f.ok("Bash", bash("devops --help | head -20"), out("Usage: devops"));
    for (const flag of ["--a", "--b", "--c"]) await f.fail("Bash", bash(`devops oo ${flag}`), `error: unexpected argument '${flag}' found`);
    assert.equal((await f.logs("cli-flag-guess")).length, 1);
  } finally {
    await f.cleanup();
  }
});

test("cliProgram skips cd, env and source prefixes", () => {
  assert.equal(cliProgram("cd /repo && FOO=1 devops oo --x | jq ."), "devops");
  assert.equal(cliProgram("source ~/.zshrc; aws-vault exec web -- aws s3 ls"), "aws");
  assert.equal(cliProgram("/usr/local/bin/glab mr list"), "glab");
  assert.equal(cliProgram(""), null);
});

test("blocked-retry logs an identical retry after a sandbox block, not one with the sandbox lifted", async () => {
  const f = await fixture("grok-4.7");
  try {
    const command = "kubectl --context kkbox-production auth can-i get pods";
    assert.equal(await f.pre("Bash", bash(command)), null);
    await f.fail("Bash", bash(command), "Exit code 1\nerror: open /Users/u/.kube/config: operation not permitted\nOperation not permitted");
    // Retried with the sandbox lifted: a different call.
    assert.equal(await f.pre("Bash", bash(command, { dangerouslyDisableSandbox: true })), null);
    assert.equal((await f.logs("blocked-retry")).length, 0);
    // Retried unchanged, apart from a cd prefix and a new description.
    assert.equal(await f.pre("Bash", bash(`cd /repo && ${command}`, { description: "again" })), null, "shadow never injects");
    const records = await f.logs("blocked-retry");
    assert.equal(records.length, 1);
    assert.equal(records[0].evidence.kind, "sandbox");
    assert.equal(records[0].evidence.retries, 1);
    assert.equal(records[0].reason, "同樣的指令會再被擋：改用 unsandboxed，或停下來告訴使用者");
  } finally {
    await f.cleanup();
  }
});

test("a sandbox failure is a denial, so its retry is blocked-retry's and not repeat-failure's", async () => {
  const error = "Exit code 1\ncat: /Users/u/.aws/credentials: Operation not permitted";
  assert.equal(errorHint({ tool_name: "Bash", tool_input: bash("cat ~/.aws/credentials"), error }, null).denied, "sandbox");
  const f = await fixture("kimi-k3", { AIRCLAUDE_EDUCATION_ERROR_HINTS: "shadow" });
  try {
    await f.fail("Bash", bash("cat ~/.aws/credentials"), error);
    await f.pre("Bash", bash("cat ~/.aws/credentials"));
    await f.fail("Bash", bash("cat ~/.aws/credentials"), error);
    assert.equal((await f.logs("repeat-failure")).length, 0);
    assert.equal((await f.logs("blocked-retry")).length, 1);
  } finally {
    await f.cleanup();
  }
});

test("blocked-retry: permission denials count, a transient one only on its second retry, spawns stay D4's", async () => {
  const f = await fixture("kimi-k3", { AIRCLAUDE_EDUCATION_BLOCKED_RETRY: "enforce" });
  try {
    await f.fail("Bash", bash("git push"), "Permission for this action has been denied. Reason: pushes to a shared remote");
    const response = await f.pre("Bash", bash("git push"));
    assert.equal(response.hookSpecificOutput.hookEventName, "PreToolUse");
    assert.match(response.hookSpecificOutput.additionalContext, /同樣的指令會再被擋/);
    assert.equal(response.hookSpecificOutput.permissionDecision, undefined, "a hint, never a block");

    await f.fail("Bash", bash("npm publish"), "Auto mode could not evaluate this action and is blocking it for safety. This is usually transient.");
    assert.equal(await f.pre("Bash", bash("npm publish")), null, "the classifier asked for one retry");
    await f.fail("Bash", bash("npm publish"), "Auto mode could not evaluate this action and is blocking it for safety. This is usually transient.");
    assert.ok(await f.pre("Bash", bash("npm publish")), "the second retry is the loop");

    await f.fail("Agent", { description: "scan", prompt: "scan" }, "Permission for this action has been denied.");
    assert.equal(await f.pre("Agent", { description: "scan", prompt: "scan" }), null);
    assert.deepEqual((await f.logs("blocked-retry")).map((record) => record.evidence.kind), ["final", "transient"]);
  } finally {
    await f.cleanup();
  }
});

test("blocked-retry false positives: other actors, other commands, a retry that went through, plain failures", async () => {
  const f = await fixture();
  try {
    await f.fail("Bash", bash("cat ~/.kube/config"), "cat: /Users/u/.kube/config: Operation not permitted");
    // A subagent did not see the parent's block.
    await f.pre("Bash", bash("cat ~/.kube/config"), { agent_id: "a1", agent_type: "general-purpose" });
    await f.pre("Bash", bash("ls ~/.kube"));
    // An ordinary failure is repeat-failure's business, not a block.
    await f.fail("Bash", bash("npm test"), "Exit code 1\n1 failing");
    await f.pre("Bash", bash("npm test"));
    // A blocked call that later succeeds stops counting.
    await f.fail("Read", { file_path: "/etc/x" }, "Permission for this action has been denied.");
    await f.ok("Read", { file_path: "/etc/x" }, { type: "text", file: { filePath: "/etc/x", content: "x" } });
    await f.pre("Read", { file_path: "/etc/x" });
    assert.equal((await f.logs("blocked-retry")).length, 0);
  } finally {
    await f.cleanup();
  }
});

test("off turns a loop rule off; a per-rule override wins over its group", async () => {
  const f = await fixture("kimi-k3", { AIRCLAUDE_EDUCATION_BLOCKED_RETRY: "off", AIRCLAUDE_EDUCATION_RULES: JSON.stringify({ "cli-flag-guess": "off" }) });
  try {
    await f.fail("Bash", bash("cat ~/.kube/config"), "Operation not permitted");
    await f.pre("Bash", bash("cat ~/.kube/config"));
    for (const flag of ["--a", "--b", "--c"]) await f.fail("Bash", bash(`devops ${flag}`), `error: unexpected argument '${flag}' found`);
    for (let index = 0; index < 5; index += 1) await f.ok("Bash", bash(`get ${index}`), out(SAME));
    assert.deepEqual([...new Set((await f.logs()).map((record) => record.rule))], ["same-result-poll"]);
  } finally {
    await f.cleanup();
  }
});

test("education report --rules 6 counts the loop rules", () => {
  const now = Date.parse("2026-11-12T01:30:00Z");
  const ts = new Date(now - 3_600_000).toISOString();
  const text = [
    { ts, rules: 5, session_id: "old", rule: "repeat-failure", decision: "hint", emitted: false },
    { ts, rules: 6, session_id: "s1", rule: "same-result-poll", decision: "hint", emitted: false, model: "kimi-k3" },
    { ts, rules: 6, session_id: "s1", rule: "cli-flag-guess", decision: "hint", emitted: false, model: "deepseek-v4-1-flash" },
    { ts, rules: 6, session_id: "s2", rule: "blocked-retry", decision: "hint", emitted: false, model: "grok-4.7" },
  ].map((record) => JSON.stringify(record)).join("\n");
  const summary = summarizeEducationLog(text, { now, rules: 6 });
  assert.equal(summary.records, 3);
  assert.deepEqual(summary.rules.map(({ rule }) => rule).sort(), ["blocked-retry", "cli-flag-guess", "same-result-poll"]);
  assert.ok(summary.rules.every(({ samples }) => samples.length === 1), "hints are sampled for labelling");
});

test("blocked-retry: a sandbox error on stderr of a zero exit counts, the same text on stdout does not", async () => {
  const f = await fixture();
  try {
    await f.ok("Bash", bash("grep -r 'Operation not permitted' logs/"), out("logs/a.log: Operation not permitted"));
    await f.pre("Bash", bash("grep -r 'Operation not permitted' logs/"));
    assert.equal((await f.logs("blocked-retry")).length, 0);
    await f.ok("Bash", bash("cat ~/.kube/config | head"), out("", "cat: /Users/u/.kube/config: Operation not permitted"));
    await f.pre("Bash", bash("cat ~/.kube/config | head"));
    assert.equal((await f.logs("blocked-retry")).length, 1);
  } finally {
    await f.cleanup();
  }
});

test("blocked-retry off: identical sandbox failures stay repeat-failure's, as in 0.2.64", async () => {
  const error = "Exit code 1\ncat: /Users/u/.aws/credentials: Operation not permitted";
  const input = { tool_name: "Bash", tool_input: bash("cat ~/.aws/credentials"), error };
  assert.equal(errorHint(input, null, { blockedRetry: false }).denied, undefined);
  const f = await fixture("kimi-k3", { AIRCLAUDE_EDUCATION_BLOCKED_RETRY: "off", AIRCLAUDE_EDUCATION_ERROR_HINTS: "shadow" });
  try {
    for (let index = 0; index < 3; index += 1) await f.fail("Bash", bash("cat ~/.aws/credentials"), error);
    const records = await f.logs("repeat-failure");
    assert.equal(records.length, 2, "the second and third identical failures");
    assert.ok(records.every((record) => record.emitted === false), "shadow never injects");
    assert.equal((await f.logs("blocked-retry")).length, 0);
  } finally {
    await f.cleanup();
  }
});

test("blocked-retry: a failing command whose output mentions the error is not a sandbox denial", async () => {
  const f = await fixture();
  try {
    const grep = bash("grep -r 'Operation not permitted' logs/");
    await f.fail("Bash", grep, "Exit code 1\nlogs/a.log: Operation not permitted\nlogs/b.log: EPERM");
    await f.pre("Bash", grep);
    assert.equal((await f.logs("blocked-retry")).length, 0);
    // The command's own diagnostic still counts, also behind a cd.
    const cat = bash("cd /tmp && cat ~/.kube/config");
    await f.fail("Bash", cat, "Exit code 1\ncat: /Users/u/.kube/config: Operation not permitted");
    await f.pre("Bash", cat);
    assert.equal((await f.logs("blocked-retry")).length, 1);
  } finally {
    await f.cleanup();
  }
  const denied = (command, error) => errorHint({ tool_name: "Bash", tool_input: bash(command), error }, null).denied;
  assert.equal(denied("node build.mjs", "Exit code 1\nError: EPERM: operation not permitted, open '/Users/u/x'"), "sandbox");
  // The Bash tool's own shell reports a blocked redirect as "(eval):N:".
  assert.equal(denied("echo hi > /Users/u/.x", "Exit code 1\n(eval):1: operation not permitted: /Users/u/.x"), "sandbox");
  assert.equal(denied("sh build.sh", "Exit code 1\nzsh:1: operation not permitted: /Users/u/x"), "sandbox");
  // npm writes "npm error ..." with no colon, and the denial is only "code EPERM".
  const npmError = "Exit code 1\nnpm error code EPERM\nnpm error syscall mkdir\nnpm error path /Users/u/.npm/_cacache\nnpm error errno -1\nnpm error\nnpm error Your cache folder contains root-owned files";
  assert.equal(denied("npm cache verify", npmError), "sandbox");
  assert.equal(denied("cd /repo && npm install", "Exit code 1\nnpm ERR! code EPERM\nnpm ERR! syscall mkdir"), "sandbox");
  // npx reports through npm. Captured from a sandboxed first-time npx fetch.
  const npxError = [
    "Exit code 1",
    "npm error code EPERM",
    "npm error syscall open",
    "npm error path /Users/u/.npm/_cacache/tmp/99261e85",
    "npm error errno EPERM",
    "npm error",
    "npm error Your cache folder contains root-owned files, due to a bug in",
    "npm error previous versions of npm which has since been addressed.",
  ].join("\n");
  assert.equal(denied("npx --yes -p ms@2.0.0 node -e 1", npxError), "sandbox");
  assert.equal(denied("npm exec --yes -p ms@2.0.0 -- node -e 1", npxError), "sandbox");
  // The same lines printed by another program are file content.
  assert.equal(denied("cat npm-debug.log; false", npmError), undefined);
  assert.equal(denied("cat build.log", "Exit code 1\n[12:00] copy step: Operation not permitted"), undefined);
});

test("same-result-poll compares whole results, not a shared prefix", async () => {
  const f = await fixture();
  try {
    const license = `/*\n * Copyright 2026 Example Corp.\n *\n * Licensed under the Apache License, Version 2.0 (the "License");\n * you may not use this file except in compliance with the License.\n * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0\n */\n`;
    for (const name of ["a", "b", "c", "d", "e"]) {
      const filePath = `/repo/src/${name}.mjs`;
      await f.ok("Read", { file_path: filePath }, { type: "text", file: { filePath, content: `${license}export const ${name} = "${name}";\n` } });
    }
    const commits = Array.from({ length: 40 }, (_, index) => `${(0xabc0000 + index).toString(16)} fix(education): commit number ${index} on the loop branch`);
    for (const count of [5, 10, 20, 30, 40]) {
      await f.ok("Bash", bash(`git log --oneline -${count}`), out(commits.slice(0, count).join("\n")));
    }
    assert.equal((await f.logs("same-result-poll")).length, 0);
  } finally {
    await f.cleanup();
  }
});
