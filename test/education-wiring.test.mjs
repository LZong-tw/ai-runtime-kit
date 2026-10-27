import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadCatalog, planInstall, runCli } from "../src/airkit.mjs";
import { renderHeartbeatManagedFiles } from "../src/context-heartbeat.mjs";
import { renderEducationSummary, summarizeEducationLog } from "../src/education.mjs";

function catalog(launchExtra = {}, modes = { auto: {}, gpt: {} }) {
  return {
    schema: 1,
    profiles: [{
      name: "edu",
      visibility: "public",
      summary: "Education wiring profile.",
      managedFiles: [],
      launch: { binary: "claude", args: [], defaultMode: "auto", modes, ...launchExtra },
      ccr: {
        APIKEY: "ccr-local",
        LOG: false,
        Providers: [{ name: "demo", type: "openai_chat_completions", api_base_url: "https://example.invalid/v1/chat/completions", api_key: "$DEMO_API_KEY", models: ["m"] }],
        Router: { default: "demo,m", background: "demo,m" },
      },
    }],
  };
}

async function withCatalog(value, fn) {
  const dir = await mkdtemp(join(tmpdir(), "edu-wiring-"));
  try {
    const path = join(dir, "catalog.json");
    await writeFile(path, JSON.stringify(value));
    return await fn(await loadCatalog(path), dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const educationFiles = (plan) => plan.files.managedFiles.filter((file) => file.path.includes("/education/"));

test("a profile without education config renders no education hook", async () => {
  await withCatalog(catalog(), async (loaded, dir) => {
    assert.deepEqual(educationFiles(planInstall(loaded, "edu", { configDir: dir })), []);
  });
});

test("launch.education renders the hook; per-mode flags override the profile-wide ones", async () => {
  const value = catalog({ education: { spawnGuard: "shadow" } }, { auto: {}, gpt: { education: { errorHints: true } } });
  await withCatalog(value, async (loaded, dir) => {
    assert.equal(educationFiles(planInstall(loaded, "edu", { configDir: dir })).length, 1);
  });
  const files = renderHeartbeatManagedFiles("/cfg", undefined, { education: { base: { subagentNudge: "off" }, modes: { gpt: { errorHints: true } } } });
  const script = files.find((file) => file.relativePath.endsWith("education/hook.mjs")).content;
  const byMode = JSON.parse(script.match(/const byMode = (.*);/)[1]);
  assert.equal(byMode.gpt.AIRCLAUDE_EDUCATION_ERROR_HINTS, "true");
  assert.equal(byMode.gpt.AIRCLAUDE_EDUCATION_SUBAGENT_NUDGE, "off", "mode inherits the profile-wide flags");
  assert.equal(byMode.auto, undefined);
  assert.match(script, /"AIRCLAUDE_EDUCATION_SUBAGENT_NUDGE":"off"/, "fallback is the profile-wide set");
});

test("a per-mode block alone is enough to opt the profile in", async () => {
  await withCatalog(catalog({}, { auto: {}, gpt: { education: true } }), async (loaded, dir) => {
    assert.equal(educationFiles(planInstall(loaded, "edu", { configDir: dir })).length, 1);
  });
});

test("invalid education flags fail catalog validation", async () => {
  await assert.rejects(withCatalog(catalog({ education: { spawnGuard: "on" } }), async () => {}), /launch\.education\.spawnGuard must be off, shadow or enforce/);
  await assert.rejects(withCatalog(catalog({}, { gpt: { education: { errorHints: "yes" } } }), async () => {}), /launch\.modes\.gpt\.education\.errorHints must be a boolean/);
  await assert.rejects(withCatalog(catalog({ education: { guard: "shadow" } }), async () => {}), /launch\.education\.guard is not an education flag/);
});

test("the generated hook script picks flags by AIRCLAUDE_MODE at run time", async () => {
  const dir = await mkdtemp(join(tmpdir(), "edu-script-"));
  try {
    const runtime = new URL("../src/context-heartbeat.mjs", import.meta.url).href;
    const files = renderHeartbeatManagedFiles(dir, runtime, { education: { base: {}, modes: { gpt: { spawnGuard: "off", subagentReport: "off", subagentNudge: "off" } } } });
    const script = files.find((file) => file.relativePath.endsWith("education/hook.mjs"));
    const path = join(dir, "hook.mjs");
    await writeFile(path, script.content);
    const run = (mode) => new Promise((resolve, reject) => {
      const child = execFile(process.execPath, [path], { env: { HOME: dir, AIRCLAUDE_MODE: mode } }, (error, stdout) => (error ? reject(error) : resolve(stdout)));
      child.stdin.end(JSON.stringify({ hook_event_name: "PostToolUseFailure", session_id: "s1", tool_name: "Read", tool_input: { file_path: "/x" }, error: "File does not exist." }));
    });
    const log = join(dir, ".claude-code-router", "logs", "airkit-education.jsonl");
    await run("gpt");
    await assert.rejects(readFile(log, "utf8"), /ENOENT/, "an all-off mode logs nothing");
    await run("auto");
    const records = (await readFile(log, "utf8")).trim().split("\n").map((entry) => JSON.parse(entry));
    assert.deepEqual(records.map((record) => record.rule), ["read-missing"]);
    assert.equal(records[0].emitted, false, "shadow profile-wide flags never emit");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

const day = 86_400_000;
const now = Date.parse("2026-10-27T00:00:00Z");
const line = (offsetDays, record) => JSON.stringify({ ts: new Date(now - offsetDays * day).toISOString(), ...record });

test("the summary counts each rule inside the window and samples only actionable decisions", () => {
  const text = [
    line(8, { rule: "D3", decision: "deny", model: "gpt-5.6-sol", session_id: "old" }),
    line(6, { rule: "D3", decision: "deny", model: "gpt-5.6-sol", session_id: "a", emitted: false, reason: "Investigate directly first" }),
    line(5, { rule: "D3", decision: "deny", model: "claude-sonnet-5-5", session_id: "b" }),
    line(1, { rule: "spawn-allow", decision: "allow", model: "GLM-5.3", session_id: "a" }),
    line(1, { rule: "edit-mismatch", decision: "hint", model: "GLM-5.3", session_id: "a", emitted: true }),
    "not json",
    "",
  ].join("\n");
  const summary = summarizeEducationLog(text, { now, days: 7, samples: 5 });
  assert.equal(summary.records, 4);
  assert.equal(summary.malformed, 1);
  assert.equal(summary.sessions, 2);
  assert.equal(summary.coverageDays, 6);
  const d3 = summary.rules.find((entry) => entry.rule === "D3");
  assert.equal(d3.total, 2);
  assert.deepEqual(d3.models, { gpt: 1, claude: 1 });
  assert.equal(d3.samples.length, 2);
  assert.equal(summary.rules.find((entry) => entry.rule === "edit-mismatch").emitted, 1);
  const text2 = renderEducationSummary(summary);
  assert.match(text2, /less than 7 days of data/);
  assert.match(text2, /## D3 — 2 sample/);
  assert.doesNotMatch(text2, /## spawn-allow/);
});

test("sampling is capped, deterministic, and spread across the window", () => {
  const text = Array.from({ length: 200 }, (_, index) => line(6.9 - index * 0.03, { rule: "D3", decision: "deny", session_id: `s${index}` })).join("\n");
  const first = summarizeEducationLog(text, { now, samples: 20 });
  const again = summarizeEducationLog(text, { now, samples: 20 });
  const [d3] = first.rules;
  assert.equal(d3.samples.length, 20);
  assert.deepEqual(d3.samples, again.rules[0].samples);
  assert.ok(d3.samples.some((sample) => Date.parse(sample.ts) > now - 3 * day), "not only the earliest records");
});

test("airkit education report reads the log and handles a missing one", async () => {
  const dir = await mkdtemp(join(tmpdir(), "edu-report-"));
  try {
    let out = "";
    const stdout = { write: (chunk) => { out += chunk; } };
    assert.equal(await runCli(["education", "report", "--log", join(dir, "none.jsonl")], { stdout }), 0);
    assert.match(out, /no education log/);
    const path = join(dir, "edu.jsonl");
    await writeFile(path, `${line(1, { rule: "D1", decision: "deny", session_id: "x" })}\n`);
    out = "";
    assert.equal(await runCli(["education", "report", "--log", path, "--json"], { stdout, now }), 0);
    assert.equal(JSON.parse(out).rules[0].rule, "D1");
    await assert.rejects(runCli(["education", "report", "--days", "0", "--log", path], { stdout }), /--days/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
