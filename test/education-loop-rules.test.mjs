import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { EDUCATION_DEFAULTS, EDUCATION_RULES, EDUCATION_RULES_VERSION, cliProgram, errorHint, processEducationHook, summarizeEducationLog, targetIdentifiers } from "../src/education.mjs";

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
  assert.equal(EDUCATION_RULES_VERSION, 8);
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
    assert.equal(records[0].rules, 8);
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
    const command = "kubectl --context example-production auth can-i get pods";
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

// Rule set 8: same-target-repeat (kimi-loop report 2026-11-09, option 1).
const TARGET_HINT = "同一個目標已經反覆查了好幾次：先退一步，去找上游決定這個值的來源（設定、manifest、部署紀錄），不要再重查同一個地方";
const quiet = { AIRCLAUDE_EDUCATION_SAME_RESULT_POLL: "off", AIRCLAUDE_EDUCATION_CLI_FLAG_GUESS: "off", AIRCLAUDE_EDUCATION_BLOCKED_RETRY: "off" };

test("rule set 8 registers same-target-repeat, shadow by default", () => {
  assert.equal(EDUCATION_RULES["same-target-repeat"], "sameTargetRepeat");
  assert.equal(EDUCATION_DEFAULTS.sameTargetRepeat, "shadow");
});

test("targetIdentifiers keeps hex ids, UUIDs and Kubernetes hashes, not words, paths or git", () => {
  assert.deepEqual(targetIdentifiers("Bash", bash("kubectl get rs web-6b899df954 -n apps -o json | python3 -c 'import sys'")), ["6b899df954"]);
  assert.deepEqual(targetIdentifiers("Bash", bash("kubectl get pod web-7d5fcb8n9x-abcde")), ["7d5fcb8n9x"]);
  assert.deepEqual(targetIdentifiers("Bash", bash("git show 9e6a7e2 && cat /tmp/9e6a7e2f/out.txt")), [], "git names commits on purpose");
  assert.deepEqual(targetIdentifiers("Bash", bash("cd /repo && git diff 9e6a7e2 -- src | grep 6b899df954")), ["6b899df954"], "only the git segment is skipped");
  assert.deepEqual(targetIdentifiers("Bash", bash("cat session 944a4b23-e0e7-494d-819c-142efb0fd0c5")), ["944a4b23-e0e7-494d-819c-142efb0fd0c5"], "a UUID is one id");
  assert.deepEqual(targetIdentifiers("Bash", bash("rg 'color: #ff0000ff' packages/ui")), [], "a colour");
  assert.deepEqual(targetIdentifiers("Bash", bash("pnpm --filter @scope/pkg-b2c4d6f8 test")), [], "a scoped package");
  assert.deepEqual(targetIdentifiers("Bash", bash("deadbeef cafebabe 12345678 kubectl describe deployment")), [], "all-letter or all-digit runs are not ids");
  assert.deepEqual(targetIdentifiers("Bash", bash("curl https://example.com/blob/6b899df954")), [], "inside a URL");
  assert.deepEqual(targetIdentifiers("Grep", { pattern: "6b899df954", path: "/repo/src", description: "6b899df955" }), ["6b899df954"]);
});

test("same-target-repeat logs the third identical call once", async () => {
  const f = await fixture("kimi-k3", quiet);
  try {
    await f.ok("Bash", bash("kubectl get deploy web -o yaml"), out(SAME));
    await f.ok("Bash", bash("cd /repo && kubectl  get deploy web -o yaml", { description: "again" }), out(SAME));
    assert.equal((await f.logs("same-target-repeat")).length, 0, "two is fine");
    assert.equal(await f.ok("Bash", bash("kubectl get deploy web -o yaml"), out(SAME)), null, "shadow never injects");
    await f.ok("Bash", bash("kubectl get deploy web -o yaml"), out(SAME));
    const records = await f.logs("same-target-repeat");
    assert.equal(records.length, 1, "fires once per target per turn");
    assert.equal(records[0].emitted, false);
    assert.equal(records[0].rules, 8);
    assert.equal(records[0].reason, TARGET_HINT);
    assert.equal(records[0].evidence.trigger, "same-input");
    assert.equal(records[0].evidence.count, 3);
    assert.equal(records[0].evidence.calls, 3);
    for (let index = 0; index < 3; index += 1) await f.ok("Read", { file_path: "/repo/a.js" }, { type: "text", file: { content: "x" } });
    assert.equal((await f.logs("same-target-repeat")).length, 2, "another target fires on its own");
  } finally {
    await f.cleanup();
  }
});

test("same-target-repeat logs the fifth call naming the same identifier", async () => {
  const f = await fixture("kimi-k3", quiet);
  try {
    const commands = ["get rs", "describe rs", "get rs -o yaml", "get rs -o json", "get pods -l pod-template-hash=", "get events --field-selector involvedObject.name="];
    for (const [index, verb] of commands.entries()) {
      await f.ok("Bash", bash(`kubectl ${verb}${verb.endsWith("=") ? "" : " "}web-6b899df954`), out(`r${index}`));
      if (index === 3) assert.equal((await f.logs("same-target-repeat")).length, 0, "four calls are under the threshold");
    }
    const records = await f.logs("same-target-repeat");
    assert.equal(records.length, 1);
    assert.deepEqual(records[0].evidence, { trigger: "same-identifier", tool: "Bash", target: "6b899df954", count: 5, calls: 5 });
  } finally {
    await f.cleanup();
  }
});

test("same-target-repeat logs only a hash of a long hex identifier", async () => {
  const f = await fixture("kimi-k3", quiet);
  try {
    const digest = "3f2a9c1e8b7d6f5a4c3b2a1908f7e6d5c4b3a291";
    for (let index = 0; index < 5; index += 1) await f.ok("Bash", bash(`crane manifest img@sha256:${digest} | jq .${index}`), out("m"));
    const [record] = await f.logs("same-target-repeat");
    assert.equal(record.evidence.trigger, "same-identifier");
    assert.match(record.evidence.target, /^[0-9a-f]{16}$/);
    assert.notEqual(record.evidence.target, digest.slice(0, 16));
    assert.equal(JSON.stringify(await f.logs()).includes(digest), false);
  } finally {
    await f.cleanup();
  }
});

test("same-target-repeat starts over on a new turn, after an edit, and per actor", async () => {
  const f = await fixture("kimi-k3", quiet);
  try {
    const run = (extra = {}) => f.ok("Bash", bash("kubectl get deploy web -o yaml"), out("a"), extra);
    await run();
    await run();
    await f.send({ hook_event_name: "UserPromptSubmit", prompt: "try again" });
    await run();
    await run();
    await f.ok("Edit", { file_path: "/repo/values.yaml", old_string: "a", new_string: "b" }, { filePath: "/repo/values.yaml" });
    await run();
    await run({ agent_id: "sub1", agent_type: "Explore" });
    await run({ agent_id: "sub1", agent_type: "Explore" });
    await run();
    assert.equal((await f.logs("same-target-repeat")).length, 0, "a subagent's calls do not count for the parent");
    await run();
    assert.equal((await f.logs("same-target-repeat")).length, 1);
  } finally {
    await f.cleanup();
  }
});

test("same-target-repeat ignores waiting commands", async () => {
  const f = await fixture("kimi-k3", quiet);
  try {
    for (let index = 0; index < 6; index += 1) await f.ok("Bash", bash("kubectl rollout status deploy/web-6b899df954"), out("waiting"));
    assert.equal((await f.logs("same-target-repeat")).length, 0);
  } finally {
    await f.cleanup();
  }
});

test("same-target-repeat injects the hint on enforce for non-Claude models only", async () => {
  for (const [model, injected] of [["kimi-k3", true], ["claude-sonnet-5-5", false]]) {
    const f = await fixture(model, { ...quiet, AIRCLAUDE_EDUCATION_SAME_TARGET_REPEAT: "enforce" });
    try {
      await f.ok("Bash", bash("kubectl get deploy web"), out("a"));
      assert.equal(await f.ok("Bash", bash("kubectl get deploy web"), out("a")), null);
      const response = await f.ok("Bash", bash("kubectl get deploy web"), out("a"));
      if (injected) assert.equal(response.hookSpecificOutput.additionalContext, TARGET_HINT);
      else assert.equal(response, null);
      assert.equal((await f.logs("same-target-repeat"))[0].emitted, injected);
    } finally {
      await f.cleanup();
    }
  }
});

test("same-target-repeat on the 2026-11-05 Kimi turn: identifier at call 15, identical input at call 32", async () => {
  const { commands } = JSON.parse(await readFile(new URL("./fixtures/education/kimi-same-target-2026-11-05.json", import.meta.url), "utf8"));
  assert.equal(commands.length, 96);
  const f = await fixture("kimi-k3", quiet);
  try {
    // The fixture keeps no outputs. An identical query of an immutable
    // ReplicaSet returns identical text, so each command gets its own.
    for (const command of commands) await f.ok("Bash", { command, dangerouslyDisableSandbox: true }, out(`output of ${command}`));
    const records = await f.logs("same-target-repeat");
    const first = (trigger) => records.find((record) => record.evidence.trigger === trigger)?.evidence;
    assert.deepEqual(first("same-identifier"), { trigger: "same-identifier", tool: "Bash", target: "6b899df954", count: 5, calls: 15 });
    assert.equal(first("same-input").calls, 32);
    assert.equal(first("same-input").count, 3);
    assert.equal(records.filter((record) => record.evidence.trigger === "same-identifier").length, 1, "the identifier fires once in the turn");
  } finally {
    await f.cleanup();
  }
});

test("same-target-repeat does not count a poll whose output changes", async () => {
  const f = await fixture("kimi-k3", quiet);
  try {
    for (const age of ["5s", "35s", "65s", "95s"]) await f.ok("Bash", bash("kubectl get pods -n apps -l app=web"), out(`web-7d5fcb8n9x-abcde 0/1 ContainerCreating 0 ${age}`));
    for (const elapsed of ["1m2s", "1m40s", "2m15s"]) await f.ok("Bash", bash("gh pr checks 123"), out(`build pending ${elapsed}`));
    for (let index = 0; index < 4; index += 1) await f.ok("Bash", bash("kubectl get pods -w -n apps --request-timeout=5s"), out("web-7d5fcb8n9x-abcde 1/1 Running"));
    assert.equal((await f.logs("same-target-repeat")).length, 0);
    for (let index = 0; index < 3; index += 1) await f.ok("Bash", bash("grep -w replicas values.yaml"), out(SAME));
    assert.equal((await f.logs("same-target-repeat")).length, 1, "grep -w is not a watch");
  } finally {
    await f.cleanup();
  }
});

test("same-target-repeat leaves a git review and status around commits alone", async () => {
  const f = await fixture("kimi-k3", quiet);
  try {
    for (const path of ["--stat", "-- src/a.mjs", "-- test/a.test.mjs", "-- docs/x.md", "-- package.json"]) await f.ok("Bash", bash(`git show 979d6c0 ${path}`), out(`diff ${path}`));
    await f.ok("Bash", bash("git status --short"), out(" M src/a.mjs"));
    await f.ok("Bash", bash("git add -A && git commit -m a"), out("[main 1a2b3c4] a"));
    await f.ok("Bash", bash("git status --short"), out(" M src/a.mjs"));
    await f.ok("Bash", bash("cd /repo && git -C /repo commit --amend --no-edit"), out("[main 5d6e7f8] a"));
    await f.ok("Bash", bash("git status --short"), out(" M src/a.mjs"));
    assert.equal((await f.logs("same-target-repeat")).length, 0);
    await f.ok("Bash", bash("git status --short"), out(" M src/a.mjs"));
    await f.ok("Bash", bash("git status --short"), out(" M src/a.mjs"));
    assert.equal((await f.logs("same-target-repeat")).length, 1, "three in a row with nothing between still count");
  } finally {
    await f.cleanup();
  }
});

test("same-target-repeat reads only git's subcommand, not quoted text", async () => {
  const f = await fixture("kimi-k3", quiet);
  try {
    const status = () => f.ok("Bash", bash("git status --short"), out(" M src/a.mjs"));
    await status();
    await f.ok("Bash", bash("git log --grep='git add' -1"), out("commit 1a2b3c4"));
    await f.ok("Bash", bash(`git log --grep="fix; git commit" --oneline`), out("1a2b3c4 fix"));
    await f.ok("Bash", bash("git stash list"), out("stash@{0}: WIP"));
    await f.ok("Bash", bash("git stash show -p"), out("diff"));
    await status();
    assert.equal((await f.logs("same-target-repeat")).length, 0);
    await status();
    assert.equal((await f.logs("same-target-repeat")).length, 1, "none of the reads in between started the counts over");
  } finally {
    await f.cleanup();
  }
});

test("same-target-repeat starts over after a git change behind global options", async () => {
  const f = await fixture("kimi-k3", quiet);
  try {
    const status = () => f.ok("Bash", bash("git status --short"), out(" M src/a.mjs"));
    for (const change of [
      "git -C /repo commit -m a",
      "git -c user.name=a commit --amend --no-edit",
      "git --git-dir=/repo/.git add .",
      "git --work-tree /repo checkout -- src/a.mjs",
      "git --no-pager -C /repo reset --hard",
      "GIT_EDITOR=true git rebase --continue",
      "git stash",
      "git stash -u",
      "git stash pop",
    ]) {
      await status();
      await status();
      await f.ok("Bash", bash(change), out(""));
    }
    assert.equal((await f.logs("same-target-repeat")).length, 0);
  } finally {
    await f.cleanup();
  }
});

test("same-target-repeat leaves a sandbox denial that exits 0 to blocked-retry", async () => {
  const f = await fixture("kimi-k3", { ...quiet, AIRCLAUDE_EDUCATION_BLOCKED_RETRY: "shadow" });
  try {
    const denied = out("", "cat: /repo/.env: Operation not permitted");
    for (let index = 0; index < 3; index += 1) await f.ok("Bash", bash("cat /repo/.env"), denied);
    assert.equal((await f.logs("same-target-repeat")).length, 0, "denied calls are not counted");
    const status = () => f.ok("Bash", bash("git status --short"), out(" M src/a.mjs"));
    await status();
    await status();
    await f.ok("Bash", bash("git commit -m a"), out("", "fatal: Unable to create '/repo/.git/index.lock': Operation not permitted"));
    await status();
    const records = await f.logs("same-target-repeat");
    assert.equal(records.length, 1, "a denied commit changed nothing");
    assert.equal(records[0].evidence.calls, 3);
  } finally {
    await f.cleanup();
  }
  const off = await fixture("kimi-k3", quiet);
  try {
    for (let index = 0; index < 3; index += 1) await off.ok("Bash", bash("cat /repo/.env"), out("", "cat: /repo/.env: Operation not permitted"));
    assert.equal((await off.logs("same-target-repeat")).length, 1, "with blocked-retry off nobody owns it, so it counts");
  } finally {
    await off.cleanup();
  }
});

test("same-target-repeat logs a target once per turn even across an edit", async () => {
  const f = await fixture("kimi-k3", quiet);
  try {
    const run = () => f.ok("Bash", bash("kubectl get deploy web"), out(SAME));
    for (let index = 0; index < 3; index += 1) await run();
    await f.ok("Edit", { file_path: "/repo/values.yaml", old_string: "a", new_string: "b" }, { filePath: "/repo/values.yaml" });
    for (let index = 0; index < 3; index += 1) await run();
    const records = await f.logs("same-target-repeat");
    assert.equal(records.length, 1);
    assert.equal(records[0].evidence.calls, 3);
    await f.ok("Read", { file_path: "/repo/a.js" }, { type: "text", file: { content: "x" } });
    await f.ok("Read", { file_path: "/repo/a.js" }, { type: "text", file: { content: "x" } });
    await f.ok("Read", { file_path: "/repo/a.js" }, { type: "text", file: { content: "x" } });
    assert.equal((await f.logs("same-target-repeat"))[1].evidence.calls, 9, "calls counts the whole turn, not since the edit");
  } finally {
    await f.cleanup();
  }
});

test("same-target-repeat still fires after more than 200 other targets", async () => {
  const f = await fixture("kimi-k3", quiet);
  try {
    for (let index = 0; index < 250; index += 1) await f.ok("Bash", bash(`ls dir${index}`), out(`file${index}`));
    for (let index = 0; index < 3; index += 1) await f.ok("Bash", bash("kubectl get deploy web -o yaml"), out(SAME));
    const [record] = await f.logs("same-target-repeat");
    assert.equal(record.evidence.calls, 253);
  } finally {
    await f.cleanup();
  }
});

test("same-target-repeat counts failed calls but logs only on success, and skips denied ones", async () => {
  const f = await fixture("kimi-k3", quiet);
  try {
    const command = bash("kubectl get rs web-6b899df954 -o yaml | grep -c nothing");
    const exit1 = "Error: Exit code 1\n0";
    const denied = "Permission to use Bash with command kubectl get rs web-6b899df954 has been denied.";
    await f.fail("Bash", command, denied);
    await f.fail("Bash", command, exit1);
    await f.fail("Bash", command, exit1);
    await f.fail("Bash", command, exit1);
    assert.equal((await f.logs("same-target-repeat")).length, 0, "the failure path never logs");
    await f.ok("Bash", bash("kubectl describe rs web-6b899df954"), out("describe"));
    assert.equal((await f.logs("same-target-repeat")).length, 0, "the denied call did not run, so this is the fourth");
    await f.ok("Bash", bash("kubectl get rs web-6b899df954 -o json"), out("json"));
    const records = await f.logs("same-target-repeat");
    assert.equal(records.length, 1);
    assert.deepEqual(records[0].evidence, { trigger: "same-identifier", tool: "Bash", target: "6b899df954", count: 5, calls: 5 });
  } finally {
    await f.cleanup();
  }
});
