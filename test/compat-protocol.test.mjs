import assert from "node:assert/strict";
import { test } from "node:test";

import {
  MAX_DEFERRED_TOOL_COUNT,
  MAX_SEARCHABLE_TOOL_TEXT_LENGTH,
  assertAnthropicFamilyModel,
  createAdvisorToolResult,
  createToolSearchErrorResult,
  createToolSearchResult,
  inspectCompatibilityRequest,
  mapToolSearchError,
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

test("regex ToolSearch searches schema property names and descriptions", () => {
  const tools = [
    {
      name: "lookup_profile",
      description: "Load a profile",
      defer_loading: true,
      input_schema: {
        type: "object",
        properties: {
          song_id: { type: "string", description: "Catalog identifier" },
        },
      },
    },
  ];

  assert.deepEqual(
    searchDeferredTools({
      tools,
      type: "tool_search_tool_regex_20251119",
      query: "song_id|catalog identifier",
    }),
    [{ type: "tool_reference", tool_name: "lookup_profile" }],
  );
});

test("safe regex subset preserves escaped literal metacharacters", () => {
  assert.deepEqual(
    searchDeferredTools({
      tools: [
        {
          name: "pipe_tool",
          description: "weather|location",
          defer_loading: true,
          input_schema: {},
        },
        {
          name: "location_only",
          description: "location",
          defer_loading: true,
          input_schema: {},
        },
      ],
      type: "tool_search_tool_regex_20251119",
      query: "weather\\|location",
    }),
    [{ type: "tool_reference", tool_name: "pipe_tool" }],
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

test("BM25 ToolSearch ranks competing scores and breaks ties by tool name", () => {
  const tools = [
    {
      name: "zeta_search",
      description: "workspace search",
      defer_loading: true,
      input_schema: {},
    },
    {
      name: "alpha_search",
      description: "workspace search",
      defer_loading: true,
      input_schema: {},
    },
    {
      name: "focused_search",
      description: "workspace search search search",
      defer_loading: true,
      input_schema: {},
    },
  ];

  assert.deepEqual(
    searchDeferredTools({
      tools,
      type: "tool_search_tool_bm25_20251119",
      query: "workspace search",
    }),
    [
      { type: "tool_reference", tool_name: "focused_search" },
      { type: "tool_reference", tool_name: "alpha_search" },
      { type: "tool_reference", tool_name: "zeta_search" },
    ],
  );
});

test("ToolSearch returns at most five results and handles empty queries", () => {
  const tools = Array.from({ length: 7 }, (_, index) => ({
    name: `search_${index}`,
    description: "shared search term",
    defer_loading: true,
    input_schema: {},
  }));

  assert.equal(
    searchDeferredTools({
      tools,
      type: "tool_search_tool_regex_20251119",
      query: "search",
      limit: 99,
    }).length,
    5,
  );
  assert.deepEqual(
    searchDeferredTools({
      tools,
      type: "tool_search_tool_regex_20251119",
      query: "",
    }),
    [],
  );
  assert.deepEqual(
    searchDeferredTools({
      tools,
      type: "tool_search_tool_bm25_20251119",
      query: "",
    }),
    [],
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

test("ToolSearch accepts exact query boundaries and reports typed input errors", () => {
  assert.doesNotThrow(() =>
    searchDeferredTools({
      tools: deferredTools,
      type: "tool_search_tool_regex_20251119",
      query: "x".repeat(200),
    }),
  );
  assert.doesNotThrow(() =>
    searchDeferredTools({
      tools: deferredTools,
      type: "tool_search_tool_bm25_20251119",
      query: "x".repeat(500),
    }),
  );
  assert.throws(
    () =>
      searchDeferredTools({
        tools: deferredTools,
        type: "tool_search_tool_regex_20251119",
        query: "[",
      }),
    (error) => error.code === "invalid_tool_search_query",
  );
  assert.throws(
    () =>
      searchDeferredTools({
        tools: deferredTools,
        type: "tool_search_tool_regex_20251119",
        query: "x".repeat(201),
      }),
    (error) => error.code === "tool_search_query_too_long",
  );
  assert.throws(
    () =>
      searchDeferredTools({
        tools: deferredTools,
        type: "tool_search_tool_regex_20251119",
        query: { pattern: "weather" },
      }),
    (error) => error.code === "invalid_tool_search_query",
  );
});

test("valid Python regex outside the safe subset requires per-request fallback", () => {
  for (const query of [
    "weather.*city",
    "(?P<term>weather)",
    "\\d+",
    "weather\\ncity",
    "alpha\\|^beta",
  ]) {
    assert.throws(
      () =>
        searchDeferredTools({
          tools: deferredTools,
          type: "tool_search_tool_regex_20251119",
          query,
        }),
      (error) => error.code === "tool_search_fallback_required",
    );
  }
});

test("ToolSearch bounds catalogs and searchable text and rejects malformed definitions", () => {
  const oversizedCatalog = Array.from({ length: MAX_DEFERRED_TOOL_COUNT + 1 }, (_, index) => ({
    name: `tool_${index}`,
    defer_loading: true,
  }));
  assert.throws(
    () =>
      searchDeferredTools({
        tools: oversizedCatalog,
        type: "tool_search_tool_regex_20251119",
        query: "tool",
      }),
    (error) => error.code === "tool_search_fallback_required",
  );

  const cappedTextTool = {
    name: "bounded_tool",
    description: `visible ${"x".repeat(MAX_SEARCHABLE_TOOL_TEXT_LENGTH)} hidden_suffix`,
    defer_loading: true,
    input_schema: {},
  };
  assert.deepEqual(
    searchDeferredTools({
      tools: [cappedTextTool],
      type: "tool_search_tool_regex_20251119",
      query: "visible",
    }),
    [{ type: "tool_reference", tool_name: "bounded_tool" }],
  );
  assert.deepEqual(
    searchDeferredTools({
      tools: [cappedTextTool],
      type: "tool_search_tool_regex_20251119",
      query: "hidden_suffix",
    }),
    [],
  );

  for (const malformed of [
    { defer_loading: true, description: "missing name" },
    { name: "bad_description", defer_loading: true, description: 42 },
    { name: "x".repeat(MAX_SEARCHABLE_TOOL_TEXT_LENGTH + 1), defer_loading: true },
  ]) {
    assert.throws(
      () =>
        searchDeferredTools({
          tools: [malformed],
          type: "tool_search_tool_regex_20251119",
          query: "bad",
        }),
      (error) => error.code === "invalid_tool_definition",
    );
  }

  const cyclicSchema = {};
  cyclicSchema.self = cyclicSchema;
  assert.throws(
    () =>
      searchDeferredTools({
        tools: [{ name: "cyclic", defer_loading: true, input_schema: cyclicSchema }],
        type: "tool_search_tool_regex_20251119",
        query: "self",
      }),
    (error) => error.code === "invalid_tool_definition",
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

test("advisor result construction preserves redacted encrypted content", () => {
  assert.deepEqual(
    createAdvisorToolResult({
      toolUseId: "srvtoolu_advisor",
      encryptedContent: "opaque-advisor-payload",
      stopReason: "max_tokens",
    }),
    {
      type: "advisor_tool_result",
      tool_use_id: "srvtoolu_advisor",
      content: {
        type: "advisor_redacted_result",
        encrypted_content: "opaque-advisor-payload",
        stop_reason: "max_tokens",
      },
    },
  );
  assert.throws(
    () =>
      createAdvisorToolResult({
        toolUseId: "srvtoolu_advisor",
        text: "plaintext",
        encryptedContent: "opaque",
      }),
    (error) => error.code === "invalid_advisor_result",
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

test("ToolSearch error construction supports every official HTTP-200 error code", () => {
  for (const errorCode of [
    "invalid_tool_input",
    "unavailable",
    "too_many_requests",
    "execution_time_exceeded",
  ]) {
    const result = createToolSearchErrorResult({
      toolUseId: "srvtoolu_search",
      errorCode,
      errorMessage: errorCode === "invalid_tool_input" ? "Malformed pattern" : undefined,
    });
    assert.equal(result.type, "tool_search_tool_result");
    assert.equal(result.tool_use_id, "srvtoolu_search");
    assert.equal(result.content.type, "tool_search_tool_result_error");
    assert.equal(result.content.error_code, errorCode);
  }
  assert.deepEqual(
    createToolSearchErrorResult({
      toolUseId: "srvtoolu_search",
      errorCode: "invalid_tool_input",
      errorMessage: "Malformed pattern",
    }),
    {
      type: "tool_search_tool_result",
      tool_use_id: "srvtoolu_search",
      content: {
        type: "tool_search_tool_result_error",
        error_code: "invalid_tool_input",
        error_message: "Malformed pattern",
      },
    },
  );
  assert.throws(
    () =>
      createToolSearchErrorResult({
        toolUseId: "srvtoolu_search",
        errorCode: "invalid_pattern",
      }),
    (error) => error.code === "invalid_tool_search_error",
  );
});

test("ToolSearch error mapping converts local input failures and preserves fallback", () => {
  for (const code of [
    "invalid_tool_search_query",
    "tool_search_query_too_long",
    "invalid_tool_definition",
  ]) {
    const error = Object.assign(new Error("bad tool search input"), { code });
    assert.equal(
      mapToolSearchError({ toolUseId: "srvtoolu_search", error }).content.error_code,
      "invalid_tool_input",
    );
  }

  const fallback = Object.assign(new Error("use provider fallback"), {
    code: "tool_search_fallback_required",
  });
  assert.throws(
    () => mapToolSearchError({ toolUseId: "srvtoolu_search", error: fallback }),
    (error) => error === fallback,
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
