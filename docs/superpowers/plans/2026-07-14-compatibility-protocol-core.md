# Compatibility Protocol Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a dependency-free, public-safe protocol core that identifies Claude server tools, validates Anthropic-only fallbacks, searches deferred tools, and constructs canonical advisor and ToolSearch result blocks.

**Architecture:** Keep protocol parsing and result construction in a new pure ESM module so later CCR gateway and MCP adapters can share it without importing the 1,839-line CLI runtime. Phase 1 has no sockets, provider calls, credentials, daemon state, or profile writes.

**Tech Stack:** Node.js 22 ESM, `node:test`, `node:assert/strict`.

## Global Constraints

- Node.js must remain `>=22`.
- Claude Code must remain `>=2.1.208`.
- Claude Code Router must remain `>=3.0.4 <4`.
- Shared behavior and tests belong in OSS; no private endpoints, company names, credential references, or private model catalogs.
- No production code is written before its focused test is observed failing.
- Phase 1 touches no more than four files and does not modify `src/airkit.mjs`.
- Fallback model validation accepts only `claude-*` or `anthropic/claude-*` model identifiers.

---

## File map

- `src/compat/protocol.mjs`: Pure request inspection, fallback validation, deferred-tool search, and Anthropic result-block constructors.
- `test/compat-protocol.test.mjs`: Focused protocol tests with no network or process state.
- `docs/superpowers/specs/2026-07-14-claude-gateway-compatibility.md`: Approved cross-phase design, already committed.
- `docs/superpowers/plans/2026-07-14-compatibility-protocol-core.md`: This executable Phase 1 plan.

### Task 1: Lock request inspection and fallback policy

**Files:**
- Create: `test/compat-protocol.test.mjs`
- Create: `src/compat/protocol.mjs`

**Interfaces:**
- Produces: `inspectCompatibilityRequest(body) -> { advisor, deferredTools, toolSearch }`.
- Produces: `assertAnthropicFamilyModel(model, fieldName?) -> string`.
- Consumes: Anthropic Messages request objects with a `tools` array.

- [ ] **Step 1: Write the failing inspection and fallback tests**

Create `test/compat-protocol.test.mjs` with these initial tests:

```js
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  assertAnthropicFamilyModel,
  inspectCompatibilityRequest,
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
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
node --test test/compat-protocol.test.mjs
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/compat/protocol.mjs`.

- [ ] **Step 3: Implement the minimal inspection and validation API**

Create `src/compat/protocol.mjs` with:

```js
export const ADVISOR_TOOL_TYPE = "advisor_20260301";
export const TOOL_SEARCH_TYPES = new Set([
  "tool_search_tool_regex_20251119",
  "tool_search_tool_bm25_20251119",
]);

export class CompatibilityProtocolError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "CompatibilityProtocolError";
    this.code = code;
  }
}

export function inspectCompatibilityRequest(body = {}) {
  const tools = Array.isArray(body.tools) ? body.tools : [];
  return {
    advisor: tools.find((tool) => tool?.type === ADVISOR_TOOL_TYPE) ?? null,
    deferredTools: tools.filter((tool) => tool?.defer_loading === true),
    toolSearch: tools.find((tool) => TOOL_SEARCH_TYPES.has(tool?.type)) ?? null,
  };
}

export function assertAnthropicFamilyModel(model, fieldName = "model") {
  const value = typeof model === "string" ? model.trim() : "";
  if (!/^(?:anthropic\/)?claude-[a-z0-9][a-z0-9._-]*$/i.test(value)) {
    throw new CompatibilityProtocolError(
      "non_anthropic_fallback",
      `${fieldName} must be an Anthropic-family model`,
    );
  }
  return value;
}
```

- [ ] **Step 4: Run the focused test and verify GREEN**

Run:

```bash
node --test test/compat-protocol.test.mjs
```

Expected: 3 tests pass, 0 fail.

- [ ] **Step 5: Commit the request-inspection contract**

```bash
git add src/compat/protocol.mjs test/compat-protocol.test.mjs
git commit -m "feat: add compatibility protocol inspection"
```

### Task 2: Add deterministic deferred-tool search

**Files:**
- Modify: `test/compat-protocol.test.mjs`
- Modify: `src/compat/protocol.mjs`

**Interfaces:**
- Consumes: `{ tools, type, query, limit? }`.
- Produces: `searchDeferredTools(options) -> [{ type: "tool_reference", tool_name }]`.
- Uses: `CompatibilityProtocolError` from Task 1 for bounded typed failures.

- [ ] **Step 1: Append failing regex and BM25 tests**

Update the import list to include `searchDeferredTools`, then append:

```js
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
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
node --test test/compat-protocol.test.mjs
```

Expected: FAIL because `searchDeferredTools` is not exported.

- [ ] **Step 3: Implement bounded regex and BM25 search**

Implement `searchDeferredTools` with the following hard contract:

- Accept only an array of at most 512 tools and validate every deferred tool's
  name, description, and schema shape before searching.
- Cap the searchable text assembled from each tool at 4,096 characters and
  traverse at most 1,024 schema nodes. Reject cycles and malformed definitions.
- Treat the regex query as Python `re.search()` syntax, but execute only a safe
  local subset: literal text, escaped literal punctuation, alternation, and
  start/end anchors at alternative boundaries. Never execute caller input with
  JavaScript `RegExp` or another backtracking regex engine.
- Return `tool_search_fallback_required` for valid Python regex features outside
  the safe subset. Return `invalid_tool_search_query` only for syntax that is
  genuinely invalid in Python. This distinction is what lets the gateway reroute
  only the affected request to the Anthropic-family fallback.
- Enforce the protocol's exact 200-character regex and 500-character BM25 limits.
- Search bounded tool names, descriptions, schema property names, and schema
  descriptions. Return no more than five `tool_reference` blocks.
- Rank BM25 matches locally and use code-unit comparison for ties in both search
  modes so results do not vary with the host's ICU locale.

Add focused cases for schema-only matches, escaped punctuation, unsupported
Python features, malformed definitions, cyclic and oversized schemas, exact
query boundaries, five-result truncation, competing BM25 scores, and
locale-independent tie ordering.

- [ ] **Step 4: Run the focused tests and verify GREEN**

Run:

```bash
node --test test/compat-protocol.test.mjs
```

Expected: all focused search tests pass, including the safety and boundary cases.

- [ ] **Step 5: Commit deferred-tool search**

```bash
git add src/compat/protocol.mjs test/compat-protocol.test.mjs
git commit -m "feat: search deferred Claude tools locally"
```

### Task 3: Construct canonical server-tool result blocks

**Files:**
- Modify: `test/compat-protocol.test.mjs`
- Modify: `src/compat/protocol.mjs`

**Interfaces:**
- Produces: `createAdvisorToolResult({ toolUseId, text?, encryptedContent?, stopReason?, errorCode? })`.
- Produces: `createToolSearchResult({ toolUseId, toolReferences })`.
- Produces: `createToolSearchErrorResult({ toolUseId, errorCode, errorMessage? })`.
- Produces: `mapToolSearchError({ toolUseId, error })`.
- Consumes: already-validated bridge outputs; does not perform provider calls.

- [ ] **Step 1: Append failing content-block tests**

Update the import list to include `createAdvisorToolResult`,
`createToolSearchResult`, `createToolSearchErrorResult`, and
`mapToolSearchError`, then append the canonical content-block cases.

```js
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
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
node --test test/compat-protocol.test.mjs
```

Expected: FAIL because the new result helpers are not exported.

- [ ] **Step 3: Implement canonical result constructors**

Implement the complete result unions rather than only the plaintext success
path:

- `createAdvisorToolResult` must construct plaintext `advisor_result`, opaque
  `advisor_redacted_result` with `encrypted_content`, and every documented
  `advisor_tool_result_error`. Plaintext and encrypted content are mutually
  exclusive, and opaque content is preserved verbatim.
- `createToolSearchResult` must nest cloned `tool_reference` values under
  `tool_search_tool_search_result`.
- `createToolSearchErrorResult` must support exactly `invalid_tool_input`,
  `unavailable`, `too_many_requests`, and `execution_time_exceeded` inside an
  HTTP-200 `tool_search_tool_result_error` block.
- `mapToolSearchError` must rethrow `tool_search_fallback_required`, map safe
  local input failures to `invalid_tool_input`, and sanitize all operational or
  unknown error messages so paths, endpoints, and provider details cannot leak.
- Every constructor must reject a missing `toolUseId`.

Add focused cases for plaintext and redacted advisor results, all official
ToolSearch error codes, typed local-error mapping, fallback preservation, raw
operational-message sanitization, and invalid IDs or error variants.

- [ ] **Step 4: Run focused and full verification**

Run:

```bash
node --test test/compat-protocol.test.mjs
npm test
npm run check
npm run pack:check
```

Expected: 22 focused tests pass; all repository tests, syntax checks, and package
allowlist checks pass with no warnings.

- [ ] **Step 5: Scan the Phase 1 diff for private identifiers**

Run:

```bash
git diff --check
git diff --name-only main...HEAD
git grep -n -i -f "$AIRKIT_PRIVATE_IDENTIFIER_FILE" -- src/compat test/compat-protocol.test.mjs docs/superpowers
```

Expected: `git diff --check` is silent; changed files are limited to the four
Phase 1 files; with a local, unpublished identifier list supplied through
`AIRKIT_PRIVATE_IDENTIFIER_FILE`, the private-identifier scan returns no matches.

- [ ] **Step 6: Commit the result-block contract**

```bash
git add src/compat/protocol.mjs test/compat-protocol.test.mjs
git commit -m "feat: construct Claude server-tool results"
```

## Self-review

- Spec coverage: Phase 1 covers pure inspection, fallback-family validation,
  local ToolSearch, and result-block construction. Provider orchestration, SSE,
  the CCR plugin entrypoint, MCP transport, profile rendering, and doctor probes
  are intentionally separate follow-up plans.
- Placeholder scan: no implementation step contains a placeholder or deferred
  error-handling instruction.
- Type consistency: all later tasks consume the exported names and object shapes
  introduced in Task 1.
