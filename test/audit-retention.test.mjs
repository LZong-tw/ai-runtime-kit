import assert from "node:assert/strict";
import test from "node:test";

import { pruneExpiredPayloads } from "../src/audit/retention.mjs";

test("prunes payload ciphertext at the exact retention boundary", async () => {
  const calls = [];
  const store = {
    async prunePayloadBatch(options) {
      calls.push(options);
      return { pruned: 2, preserved: 0, done: true };
    },
  };
  const result = await pruneExpiredPayloads(store, {
    now: "2026-08-14T00:00:00.000Z",
    write: true,
    retentionDays: 90,
    batchSize: 10,
  });
  assert.deepEqual(result, { pruned: 2, preserved: 0, done: true });
  assert.deepEqual(calls, [{
    cutoff: "2026-05-16T00:00:00.000Z",
    batchSize: 10,
    preserve: false,
  }]);
});

test("preserve mode never calls the writer", async () => {
  const store = { prunePayloadBatch: () => assert.fail("must not write") };
  assert.deepEqual(await pruneExpiredPayloads(store, { preserve: true }), {
    pruned: 0,
    preserved: true,
  });
});

test("rejects invalid retention inputs", async () => {
  await assert.rejects(() => pruneExpiredPayloads({}, { retentionDays: -1 }), /retentionDays/);
  await assert.rejects(() => pruneExpiredPayloads({}, { batchSize: 0 }), /batchSize/);
});
