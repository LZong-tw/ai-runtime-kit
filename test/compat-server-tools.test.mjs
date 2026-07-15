import assert from "node:assert/strict";
import { test } from "node:test";

import {
  SERVER_TOOL_TYPES,
  classifyToolDefinition,
  inspectServerToolRequest,
  isFutureServerToolType,
} from "../src/compat/server-tools.mjs";

test("classifies every current server-tool type and ToolSearch alias", () => {
  const cases = new Map([
    ["web_search_20250305", "webSearch"],
    ["web_search_20260209", "webSearch"],
    ["web_search_20260318", "webSearch"],
    ["web_fetch_20250910", "webFetch"],
    ["web_fetch_20260209", "webFetch"],
    ["web_fetch_20260309", "webFetch"],
    ["web_fetch_20260318", "webFetch"],
    ["code_execution_20250825", "codeExecution"],
    ["code_execution_20260120", "codeExecution"],
    ["code_execution_20260521", "codeExecution"],
    ["advisor_20260301", "advisor"],
    ["tool_search_tool_regex_20251119", "toolSearch"],
    ["tool_search_tool_bm25_20251119", "toolSearch"],
    ["tool_search_tool_regex", "toolSearch"],
    ["tool_search_tool_bm25", "toolSearch"],
    ["mcp_toolset", "mcpConnector"],
  ]);

  for (const [type, family] of cases) {
    assert.deepEqual(classifyToolDefinition({ type }), {
      kind: "server",
      family,
      type,
      known: true,
    });
  }
});

test("exports an immutable server-tool inventory", () => {
  assert.equal(Object.isFrozen(SERVER_TOOL_TYPES), true);
  for (const types of Object.values(SERVER_TOOL_TYPES)) {
    assert.equal(Object.isFrozen(types), true);
  }
  assert.throws(() => SERVER_TOOL_TYPES.webSearch.push("web_search_20990101"), TypeError);
});

test("keeps Claude Code WebFetch and WebSearch client tools native", () => {
  const inspection = inspectServerToolRequest({
    tools: [{ name: "WebFetch", input_schema: {} }, { name: "WebSearch", input_schema: {} }],
  });

  assert.deepEqual(inspection.clientTools.map((tool) => tool.name), ["WebFetch", "WebSearch"]);
  assert.deepEqual(inspection.serverTools, []);
  assert.deepEqual([...inspection.families], []);
  assert.deepEqual(inspection.futureTypes, []);
  assert.equal(inspection.requiresFallback, false);
});

test("inspects mixed tools without mutating the request", () => {
  const body = {
    tools: [
      { name: "Bash", input_schema: { type: "object" } },
      { type: "web_search_20260318", allowed_domains: ["example.com"] },
      { type: "tool_search_tool_regex" },
      { type: "web_fetch_20990101", max_uses: 2 },
    ],
  };
  const before = JSON.stringify(body);

  const inspection = inspectServerToolRequest(body);

  assert.deepEqual(inspection.clientTools, [body.tools[0]]);
  assert.deepEqual(inspection.serverTools, body.tools.slice(1));
  assert.deepEqual([...inspection.families], ["webSearch", "toolSearch"]);
  assert.deepEqual(inspection.futureTypes, ["web_fetch_20990101"]);
  assert.equal(inspection.requiresFallback, true);
  assert.equal(JSON.stringify(body), before);
});

test("returns fresh collections for every inspection", () => {
  const body = { tools: [{ type: "advisor_20260301" }] };
  const first = inspectServerToolRequest(body);
  const second = inspectServerToolRequest(body);

  assert.notEqual(first.clientTools, second.clientTools);
  assert.notEqual(first.serverTools, second.serverTools);
  assert.notEqual(first.families, second.families);
  assert.notEqual(first.futureTypes, second.futureTypes);
});

test("fails closed on future server-tool-shaped versions", () => {
  const inspection = inspectServerToolRequest({ tools: [{ type: "web_fetch_20990101" }] });

  assert.deepEqual(inspection.futureTypes, ["web_fetch_20990101"]);
  assert.equal(inspection.requiresFallback, true);
  assert.deepEqual(classifyToolDefinition({ type: "web_fetch_20990101" }), {
    kind: "server",
    family: null,
    type: "web_fetch_20990101",
    known: false,
  });
  assert.equal(isFutureServerToolType("web_fetch_20990101"), true);
  assert.equal(isFutureServerToolType("web_fetch_20260318"), false);
  assert.equal(isFutureServerToolType("custom_tool_20990101"), false);
});

test("classifies ordinary and malformed definitions as client tools", () => {
  for (const tool of [{ name: "Memory" }, {}, null]) {
    assert.deepEqual(classifyToolDefinition(tool), {
      kind: "client",
      family: null,
      type: null,
      known: false,
    });
  }
});
