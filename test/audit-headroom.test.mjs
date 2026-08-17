import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { mapHeadroomRow, tailHeadroomSavings } from "../src/audit/reconcile/headroom.mjs";

test("Headroom savings stay aggregate unless an exact audit id is echoed", () => {
  const candidate = mapHeadroomRow({
    v: 1,
    ts: "2026-08-17T00:00:00.000Z",
    before: 100,
    after: 60,
    saved: 40,
    model: "gpt-5.6-terra",
    pid: 42,
  });
  assert.equal(candidate.event_kind, "headroom_reported");
  assert.equal(candidate.payload.request_id, null);
  assert.equal(candidate.payload.correlation, "bounded_time_candidate");
  assert.equal(candidate.payload.metric_family, "headroom_savings");
  assert.equal(candidate.payload.before, 100);
  assert.equal(candidate.payload.after, 60);

  const exact = mapHeadroomRow({ before: 10, after: 5, saved: 5, audit_event_id: "req-123" });
  assert.equal(exact.logical_request_id, "req-123");
  assert.equal(exact.payload.request_id, "req-123");
  assert.equal(exact.payload.correlation, "exact");
});

test("Headroom tailing is bounded, incremental, and produces stable event ids", async () => {
  const root = await mkdtemp(join(tmpdir(), "airkit-headroom-"));
  try {
    const filePath = join(root, "savings.jsonl");
    await writeFile(filePath, [
      JSON.stringify({ ts: "2026-08-17T00:00:00.000Z", before: 10, after: 4, saved: 6, source: "hr-claude" }),
      JSON.stringify({ ts: "2026-08-17T00:00:01.000Z", before: 5, after: 3, saved: 2, audit_event_id: "req-1" }),
      "not json",
    ].join("\n") + "\n");
    const first = [];
    const result = await tailHeadroomSavings({ filePath, emit: async (event) => first.push(event) });
    assert.equal(result.events, 2);
    assert.equal(result.skipped, 1);
    assert.equal(first[0].payload.request_id, null);
    assert.equal(first[1].payload.request_id, "req-1");
    const second = [];
    const replay = await tailHeadroomSavings({ filePath, cursor: { offset: 0 }, emit: async (event) => second.push(event) });
    assert.equal(replay.events, 2);
    assert.deepEqual(second.map((event) => event.event_id), first.map((event) => event.event_id));
    const tail = [];
    const empty = await tailHeadroomSavings({ filePath, cursor: result.cursor, emit: async (event) => tail.push(event) });
    assert.equal(empty.events, 0);
    assert.equal(tail.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
