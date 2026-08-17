import assert from "node:assert/strict";
import { test } from "node:test";

import { scanOpenCode } from "../src/audit/reconcile/opencode.mjs";

function fakeDb(messages, sessions) {
  return {
    prepare(sql) {
      return {
        all() {
          if (sql.includes("FROM session")) return sessions;
          if (sql.includes("FROM message")) return messages;
          return [];
        },
      };
    },
    close() {},
  };
}

test("OpenCode emits one usage observation per message and one session meter", async () => {
  const events = [];
  const result = await scanOpenCode({
    dbPath: "/private/opencode.db",
    cursor: { timeCreated: 0, id: "" },
    openReadOnly: async () => fakeDb([
      { id: "msg-0", session_id: "session-1", time_created: 5, data: JSON.stringify({ role: "user", content: "not usage" }) },
      { id: "msg-1", session_id: "session-1", time_created: 10, data: JSON.stringify({ role: "assistant", modelID: "gpt", providerID: "oneportal", tokens: { input: 10, output: 2, reasoning: 1, cache: { read: 7, write: 3 } } }) },
      { id: "msg-2", session_id: "session-1", time_created: 20, data: JSON.stringify({ role: "assistant", modelID: "gpt", providerID: "oneportal", tokens: { input: 8, output: 1, reasoning: 0, cache: { read: 4, write: 0 } } }) },
    ], [{ id: "session-1", time_updated: 30, tokens_input: 18, tokens_output: 3, tokens_reasoning: 1, tokens_cache_read: 11, tokens_cache_write: 3 }]),
    emit: async (event) => events.push(event),
  });
  assert.equal(result.events, 3);
  assert.equal(events.filter(({ event_kind: kind }) => kind === "usage_reported").length, 2);
  assert.equal(events.filter(({ event_kind: kind }) => kind === "meter_reported").length, 1);
  assert.equal(events.at(-1).payload.total.input_tokens, 18);
  assert.equal(events[0].payload.usage.cache_read_input_tokens, 7);
  assert.equal(result.cursor.id, "msg-2");
});

test("unknown OpenCode schemas fail closed without migration or writes", async () => {
  const events = [];
  const db = { prepare() { throw new Error("no such column: data"); }, close() {} };
  const result = await scanOpenCode({ dbPath: "/private/opencode.db", openReadOnly: async () => db, emit: async (event) => events.push(event) });
  assert.equal(result.completeness, "metadata_only");
  assert.equal(events[0].event_kind, "collector_gap");
  assert.equal(events[0].payload.reason, "unsupported_schema");
});
