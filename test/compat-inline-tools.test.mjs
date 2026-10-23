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
