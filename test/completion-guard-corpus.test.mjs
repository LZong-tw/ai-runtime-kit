// Replays the labelled early-final corpus (test/fixtures/completion-guard,
// plan §3.4) through the classifier and reports precision and recall. The
// floors pin today's numbers so a regex change that loses ground fails here;
// must_allow finals (the old guard's unauthorized-action cases) may never
// be sent back.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { classifyEarlyFinal } from "../src/early-final.mjs";

const rows = readFileSync(new URL("./fixtures/completion-guard/corpus.jsonl", import.meta.url), "utf8")
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line));

function replay(policy) {
  const counts = { tp: 0, fp: 0, fn: 0, tn: 0 };
  const falsePositives = [];
  const mustAllowBlocked = [];
  for (const row of rows) {
    const expected = policy === "gate" && row.next_step_touches_production ? "allow" : row.expected;
    const { decision } = classifyEarlyFinal(row.final_tail, { backgroundRunning: row.background_running, production: policy });
    if (decision === "continue" && expected === "continue") counts.tp += 1;
    else if (decision === "continue") {
      counts.fp += 1;
      falsePositives.push(row.id);
      if (row.must_allow) mustAllowBlocked.push(row.id);
    } else if (expected === "continue") counts.fn += 1;
    else counts.tn += 1;
  }
  const precision = counts.tp / Math.max(1, counts.tp + counts.fp);
  const recall = counts.tp / Math.max(1, counts.tp + counts.fn);
  return { ...counts, precision, recall, falsePositives, mustAllowBlocked };
}

test("the corpus is well formed", () => {
  assert.ok(rows.length >= 100, String(rows.length));
  for (const row of rows) {
    assert.ok(["continue", "allow"].includes(row.expected), row.id);
    assert.equal(typeof row.final_tail, "string", row.id);
    if (row.must_allow) assert.equal(row.expected, "allow", `${row.id}: must_allow rows are allow`);
  }
});

test("replay under the shipped production gate (policy B)", (t) => {
  const result = replay("gate");
  t.diagnostic(`gate: ${JSON.stringify(result)}`);
  assert.deepEqual(result.mustAllowBlocked, [], "no unauthorized-action final is ever pushed");
  assert.ok(result.precision >= 0.88, `precision ${result.precision}`);
  assert.ok(result.recall >= 0.57, `recall ${result.recall}`);
});

test("replay with production treated like any step (policy A, comparison only)", (t) => {
  const result = replay("allow");
  t.diagnostic(`allow: ${JSON.stringify(result)}`);
  assert.deepEqual(result.mustAllowBlocked, []);
  assert.ok(result.precision >= 0.95, `precision ${result.precision}`);
  assert.ok(result.recall >= 0.6, `recall ${result.recall}`);
});
