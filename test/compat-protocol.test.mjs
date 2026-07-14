import assert from "node:assert/strict";
import { test } from "node:test";

import {
  assertAnthropicFamilyModel,
  createAdvisorToolResult,
  createToolSearchResult,
  inspectCompatibilityRequest,
  searchDeferredTools,
} from "../src/compat/protocol.mjs";

test("inspection finds advisor, ToolSearch, and deferred tools without mutation", () => {
  const body = {
    tools: [
      {
        type: "advisor_20260301",
        name: "advisor",
        model: "claude-opus-4-8",
        max_uses: 3,
      },
      {
        type: "tool_search_tool_regex_20251119",
        name: "tool_search_tool_regex",
      },
      {
        name: "get_weather",
        description: "Get current weather",
        defer_loading: true,
        input_schema: { type: "object", properties: {} },
      },
    ],
  };
  const before = structuredClone(body);

  const inspection = inspectCompatibilityRequest(body);

  assert.equal(inspection.advisor, body.tools[0]);
  assert.equal(inspection.toolSearch, body.tools[1]);
  assert.deepEqual(inspection.deferredTools, [body.tools[2]]);
  assert.deepEqual(body, before);
});

test("inspection returns empty capability slots for ordinary requests", () => {
  assert.deepEqual(inspectCompatibilityRequest({ tools: [] }), {
    advisor: null,
    deferredTools: [],
    toolSearch: null,
  });
});

test("fallback validation accepts only Anthropic-family model identifiers", () => {
  assert.equal(assertAnthropicFamilyModel("claude-opus-4-8"), "claude-opus-4-8");
  assert.equal(
    assertAnthropicFamilyModel("anthropic/claude-sonnet-4-6"),
    "anthropic/claude-sonnet-4-6",
  );
  assert.throws(
    () => assertAnthropicFamilyModel("openai/gpt-5.4", "advisor.fallbackModel"),
    /advisor\.fallbackModel must be an Anthropic-family model/,
  );
  assert.throws(
    () => assertAnthropicFamilyModel("", "advisor.model"),
    /advisor\.model must be an Anthropic-family model/,
  );
});

const deferredTools = [
  {
    name: "get_weather",
    description: "Get current weather for a city",
    defer_loading: true,
    input_schema: {
      type: "object",
      properties: { location: { type: "string", description: "City name" } },
    },
  },
  {
    name: "search_files",
    description: "Search workspace source files",
    defer_loading: true,
    input_schema: {
      type: "object",
      properties: { query: { type: "string", description: "Text to find" } },
    },
  },
  {
    name: "always_loaded",
    description: "Not deferred",
    input_schema: { type: "object", properties: {} },
  },
];

test("regex ToolSearch searches names, descriptions, and schema text", () => {
  assert.deepEqual(
    searchDeferredTools({
      tools: deferredTools,
      type: "tool_search_tool_regex_20251119",
      query: "weather|location",
    }),
    [{ type: "tool_reference", tool_name: "get_weather" }],
  );
});

test("BM25 ToolSearch ranks matching deferred tools deterministically", () => {
  assert.deepEqual(
    searchDeferredTools({
      tools: deferredTools,
      type: "tool_search_tool_bm25_20251119",
      query: "workspace file search query",
    }),
    [{ type: "tool_reference", tool_name: "search_files" }],
  );
});

test("ToolSearch rejects invalid types, patterns, and query lengths", () => {
  assert.throws(
    () => searchDeferredTools({ tools: deferredTools, type: "unknown", query: "file" }),
    /unsupported ToolSearch type/,
  );
  assert.throws(
    () => searchDeferredTools({
      tools: deferredTools,
      type: "tool_search_tool_regex_20251119",
      query: "[",
    }),
    /invalid ToolSearch regex/,
  );
  assert.throws(
    () => searchDeferredTools({
      tools: deferredTools,
      type: "tool_search_tool_regex_20251119",
      query: "x".repeat(201),
    }),
    /ToolSearch regex exceeds 200 characters/,
  );
  assert.throws(
    () => searchDeferredTools({
      tools: deferredTools,
      type: "tool_search_tool_bm25_20251119",
      query: "x".repeat(501),
    }),
    /ToolSearch BM25 query exceeds 500 characters/,
  );
});

test("advisor result construction preserves success and typed error variants", () => {
  assert.deepEqual(
    createAdvisorToolResult({
      toolUseId: "srvtoolu_advisor",
      text: "Inspect the failure boundary first.",
      stopReason: "end_turn",
    }),
    {
      type: "advisor_tool_result",
      tool_use_id: "srvtoolu_advisor",
      content: {
        type: "advisor_result",
        text: "Inspect the failure boundary first.",
        stop_reason: "end_turn",
      },
    },
  );
  assert.deepEqual(
    createAdvisorToolResult({ toolUseId: "srvtoolu_advisor", errorCode: "overloaded" }),
    {
      type: "advisor_tool_result",
      tool_use_id: "srvtoolu_advisor",
      content: { type: "advisor_tool_result_error", error_code: "overloaded" },
    },
  );
});

test("ToolSearch result construction nests canonical tool references", () => {
  assert.deepEqual(
    createToolSearchResult({
      toolUseId: "srvtoolu_search",
      toolReferences: [{ type: "tool_reference", tool_name: "search_files" }],
    }),
    {
      type: "tool_search_tool_result",
      tool_use_id: "srvtoolu_search",
      content: {
        type: "tool_search_tool_search_result",
        tool_references: [{ type: "tool_reference", tool_name: "search_files" }],
      },
    },
  );
});

test("result construction rejects missing IDs and unsupported advisor errors", () => {
  assert.throws(() => createAdvisorToolResult({ text: "missing id" }), /toolUseId is required/);
  assert.throws(
    () => createAdvisorToolResult({ toolUseId: "srvtoolu", errorCode: "unknown" }),
    /unsupported advisor error code/,
  );
  assert.throws(
    () => createToolSearchResult({ toolUseId: "", toolReferences: [] }),
    /toolUseId is required/,
  );
});
