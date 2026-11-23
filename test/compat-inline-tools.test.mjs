import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeMessageSystemRoles } from "../src/compat/gateway.mjs";

const advisor = { type: "advisor_20260301", name: "advisor", model: "fixture-advisor", defer_loading: true };
const addition = { type: "tool_addition", tool: { type: "tool_reference", name: "advisor" } };

test("inline tool references activate existing definitions without leaking into system content", () => {
  const body = { tools: [advisor], messages: [
    { role: "system", content: [addition] },
    { role: "user", content: [{ type: "text", text: "question" }] },
  ] };
  const original = structuredClone(body);
  const normalized = normalizeMessageSystemRoles(body);
  assert.deepEqual(normalized.tools, [{ ...advisor, defer_loading: false }]);
  assert.deepEqual(normalized.messages, [body.messages[1]]);
  assert.equal(normalized.system, undefined);
  assert.deepEqual(body, original);
});

test("mixed inline references preserve real messages and unrelated tool definitions", () => {
  const other = { name: "read", input_schema: { type: "object" } };
  const body = { tools: [advisor, other], system: [addition, { type: "text", text: "policy" }], messages: [
    { role: "user", content: [addition, { type: "text", text: "question" }] },
  ] };
  const result = normalizeMessageSystemRoles(body);
  assert.deepEqual(result.system, [{ type: "text", text: "policy" }]);
  assert.deepEqual(result.messages[0].content, [{ type: "text", text: "question" }]);
  assert.deepEqual(result.tools[1], other);
});

test("unknown inline references remain visible for validation and ordinary requests keep identity", () => {
  const body = { tools: [], messages: [{ role: "user", content: [addition] }] };
  assert.equal(normalizeMessageSystemRoles(body), body);
  const ordinary = { messages: [{ role: "user", content: "question" }] };
  assert.equal(normalizeMessageSystemRoles(ordinary), ordinary);
});

const hook = (text) => ({ role: "system", content: text });
const reminder = (text) => ({ type: "text", text: `<system-reminder>\n${text}\n</system-reminder>` });

test("inline system messages stay at their history position instead of joining the system prompt", () => {
  const body = { system: [{ type: "text", text: "static" }], messages: [
    { role: "user", content: "question" },
    hook("SessionStart hook"),
    { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Read", input: {} }] },
    hook("PreToolUse:Read hook"),
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "file" }] },
  ] };
  const result = normalizeMessageSystemRoles(body);
  assert.deepEqual(result.system, body.system);
  assert.deepEqual(result.messages, [
    { role: "user", content: [{ type: "text", text: "question" }, reminder("SessionStart hook")] },
    body.messages[2],
    { role: "user", content: [
      { type: "tool_result", tool_use_id: "t1", content: "file" },
      reminder("PreToolUse:Read hook"),
    ] },
  ]);
});

test("a later hook leaves the earlier prefix byte-identical", () => {
  const turn1 = [
    { role: "user", content: "question" },
    { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Read", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "file" }] },
  ];
  const turn2 = [
    ...turn1,
    hook("PreToolUse:Read hook"),
    { role: "assistant", content: [{ type: "text", text: "done" }] },
  ];
  const before = normalizeMessageSystemRoles({ system: "static", messages: turn1 });
  const after = normalizeMessageSystemRoles({ system: "static", messages: turn2 });
  assert.equal(after.system, "static");
  assert.deepEqual(after.messages.slice(0, 2), before.messages.slice(0, 2));
});

test("trailing system messages after an assistant turn become a user turn and keep cache markers", () => {
  const marked = { role: "system", content: [{ type: "text", text: "update", cache_control: { type: "ephemeral" } }] };
  const result = normalizeMessageSystemRoles({ messages: [
    { role: "user", content: "question" },
    { role: "assistant", content: "answer" },
    marked,
  ] });
  assert.deepEqual(result.messages.at(-1), { role: "user", content: [
    { ...reminder("update"), cache_control: { type: "ephemeral" } },
  ] });
  assert.equal(result.system, undefined);
});
