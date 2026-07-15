import assert from "node:assert/strict";
import { test } from "node:test";

import { bridgeToolSearch } from "../src/compat/tool-search.mjs";
import { MAX_DEFERRED_TOOL_COUNT } from "../src/compat/protocol.mjs";

const TOOL_CATALOG = {
  tools: [
    { type: "tool_search_tool_regex", name: "tool_search_tool_regex" },
    {
      name: "Read",
      description: "Read a file",
      defer_loading: true,
      input_schema: { type: "object", properties: { path: { type: "string" } } },
    },
    {
      name: "Search",
      description: "Search the workspace",
      defer_loading: true,
      input_schema: { type: "object", properties: { query: { type: "string" } } },
    },
  ],
};

for (const type of ["tool_search_tool_regex", "tool_search_tool_bm25"]) {
  test(`bridges ${type}`, () => {
    const result = bridgeToolSearch({ body: TOOL_CATALOG, definition: { type }, query: "Read" });

    assert.equal(result.kind, "result");
    assert.equal(result.block.content.type, "tool_search_tool_search_result");
    assert.deepEqual(result.block.content.tool_references, [
      { type: "tool_reference", tool_name: "Read" },
    ]);
  });
}

test("requests Anthropic fallback for unsupported future ToolSearch", () => {
  assert.deepEqual(
    bridgeToolSearch({
      body: TOOL_CATALOG,
      definition: { type: "tool_search_tool_regex_20990101" },
      query: "Read",
    }),
    { kind: "fallback", reason: "unsupported_tool_search_version" },
  );
});

test("returns explicit fallback reasons for unsafe regex and oversized catalogs", () => {
  assert.deepEqual(
    bridgeToolSearch({
      body: TOOL_CATALOG,
      definition: { type: "tool_search_tool_regex" },
      query: "Read.*",
    }),
    { kind: "fallback", reason: "unsupported_python_regex" },
  );

  const oversized = {
    tools: Array.from({ length: MAX_DEFERRED_TOOL_COUNT + 1 }, (_, index) => ({
      name: `tool_${index}`,
      defer_loading: true,
    })),
  };
  assert.deepEqual(
    bridgeToolSearch({
      body: oversized,
      definition: { type: "tool_search_tool_bm25" },
      query: "tool",
    }),
    { kind: "fallback", reason: "oversized_tool_catalog" },
  );
});

test("catalog bound counts deferred tools without charging the ToolSearch definition", () => {
  const body = {
    tools: [
      { type: "tool_search_tool_regex", name: "tool_search_tool_regex" },
      ...Array.from({ length: MAX_DEFERRED_TOOL_COUNT }, (_, index) => ({
        name: `tool_${index}`,
        defer_loading: true,
      })),
    ],
  };

  assert.equal(
    bridgeToolSearch({
      body,
      definition: body.tools[0],
      query: "no-match",
    }).kind,
    "result",
  );
});

test("requests fallback for unsupported and mixed cross-kind history", () => {
  const unsupported = {
    ...TOOL_CATALOG,
    messages: [{
      role: "user",
      content: [{ type: "future_tool_result", tool_use_id: "srvtoolu_future", content: {} }],
    }],
  };
  assert.deepEqual(
    bridgeToolSearch({
      body: unsupported,
      definition: { type: "tool_search_tool_regex" },
      query: "Read",
    }),
    { kind: "fallback", reason: "unsupported_tool_search_history" },
  );

  const mixed = {
    ...TOOL_CATALOG,
    messages: [
      {
        role: "assistant",
        content: [{ type: "server_tool_use", id: "shared_id", name: "tool_search_tool_regex" }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "shared_id", content: "wrong kind" }],
      },
    ],
  };
  assert.deepEqual(
    bridgeToolSearch({
      body: mixed,
      definition: { type: "tool_search_tool_regex" },
      query: "Read",
    }),
    { kind: "fallback", reason: "unsupported_tool_search_history" },
  );
});
