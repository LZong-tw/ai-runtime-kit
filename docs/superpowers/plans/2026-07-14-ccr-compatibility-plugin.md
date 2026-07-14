# CCR Compatibility Plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a profile-scoped CCR 3 plugin that bridges Advisor and ToolSearch requests, preserves ordinary Messages traffic, and hosts an authenticated Streamable HTTP MCP WebSearch tool.

**Architecture:** A small gateway module owns CCR core discovery, raw forwarding, compatibility orchestration, and buffered Anthropic SSE serialization. A separate plugin module registers exactly two CCR routes: `/v1/messages` and `/airkit/compatibility/mcp`. CCR 3.0.4 has no safe `forwardToCore` helper, so the adapter reads the generated core token and connects directly to the configured core host/port; tests lock this temporary version-specific seam for later CCR upstreaming.

**Tech Stack:** Node.js 22 ESM, CCR 3.0.4 plugin API, Anthropic Messages JSON/SSE, MCP Streamable HTTP JSON-RPC, `node:test`.

## Global Constraints

- Node.js must remain `>=22`.
- Claude Code must remain `>=2.1.208`.
- Claude Code Router must remain `>=3.0.4 <4`.
- Shared implementation and fake-provider tests belong in OSS; no company names, private endpoints, credentials, or private model catalogs.
- Do not execute CCR CLI probes, mutate live CCR state, or write global Claude settings.
- Do not log authorization headers, transcripts, tool results, generated core tokens, or MCP arguments.
- Ordinary `/v1/messages` request bytes must reach core unchanged.
- Compatibility fallback models must pass `assertAnthropicFamilyModel`.
- The plugin may buffer compatibility responses, but ordinary responses must be streamed through without body rewriting.
- Phase 2 touches exactly four files and does not modify `src/airkit.mjs` or profile catalogs.

---

## File map

- `src/compat/gateway.mjs`: CCR core adapter, Advisor/ToolSearch orchestration, history normalization, fallback isolation, usage aggregation, and Anthropic SSE serialization.
- `src/compat/plugin.mjs`: CCR plugin registration and the authenticated MCP WebSearch JSON-RPC handler.
- `test/compat-plugin.test.mjs`: Fake CCR core, fake plugin context, protocol tests, streaming tests, and MCP tests.
- `docs/superpowers/plans/2026-07-14-ccr-compatibility-plugin.md`: This executable Phase 2 plan.

### Task 1: Lock the CCR core adapter and raw passthrough

**Files:**
- Create: `src/compat/gateway.mjs`
- Create: `test/compat-plugin.test.mjs`

**Interfaces:**
- Produces: `createCoreClient({ config, fetchImpl?, readFile? })`.
- Produces: `coreClient.requestMessage(body, headers?) -> Promise<object>`.
- Produces: `coreClient.forwardRaw({ body, headers, method, response, signal? }) -> Promise<void>`.
- Consumes: `config.gateway.coreHost`, `config.gateway.corePort`, and `config.gateway.generatedConfigFile`.

- [ ] **Step 1: Write failing adapter tests**

Create a fake generated core config and a loopback HTTP core. The tests must prove:

```js
test("core client uses generated x-ccr-core-auth without forwarding client secrets", async () => {
  const client = createCoreClient(fixture.options);
  const result = await client.requestMessage({ model: "claude-sonnet", messages: [] }, {
    authorization: "Bearer outer-secret",
    "x-api-key": "outer-key",
    "anthropic-beta": "tool-search-tool-2025-11-19",
  });

  assert.equal(result.type, "message");
  assert.equal(fixture.seen.headers["x-ccr-core-auth"], fixture.coreToken);
  assert.equal(fixture.seen.headers.authorization, undefined);
  assert.equal(fixture.seen.headers["x-api-key"], undefined);
  assert.equal(fixture.seen.headers["anthropic-beta"], "tool-search-tool-2025-11-19");
});

test("raw passthrough preserves ordinary request and response bytes", async () => {
  const requestBody = Buffer.from('{"model":"executor","messages":[]}');
  await client.forwardRaw({ body: requestBody, headers: {}, method: "POST", response });
  assert.deepEqual(fixture.seen.body, requestBody);
  assert.deepEqual(response.body, fixture.rawResponseBody);
});
```

Also cover wildcard core hosts, malformed/missing generated auth, upstream non-2xx JSON, and abort propagation.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
node --test test/compat-plugin.test.mjs
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/compat/gateway.mjs`.

- [ ] **Step 3: Implement the minimal core adapter**

Implement these exact boundaries:

```js
export function createCoreClient({ config, fetchImpl = fetch, readFile = readFileSync }) {
  const endpoint = coreMessagesEndpoint(config.gateway);
  const coreHeaders = (headers = {}) => ({
    ...copySafeAnthropicHeaders(headers),
    "content-type": "application/json",
    "x-ccr-core-auth": readGeneratedCoreToken(config.gateway.generatedConfigFile, readFile),
  });

  return {
    async requestMessage(body, headers) {
      const result = await fetchImpl(endpoint, {
        method: "POST",
        headers: coreHeaders(headers),
        body: JSON.stringify({ ...body, stream: false }),
      });
      return parseCoreMessageResponse(result);
    },
    async forwardRaw({ body, headers, method = "POST", response, signal }) {
      const result = await fetchImpl(endpoint, { method, headers: coreHeaders(headers), body, signal });
      await pipeCoreResponse(result, response);
    },
  };
}
```

`copySafeAnthropicHeaders` may preserve only content negotiation, Anthropic version/beta, user-agent, request IDs, and tracing headers; it must drop authorization, API keys, cookies, hop-by-hop headers, and every incoming `x-ccr-*` header. `readGeneratedCoreToken` must accept a string or `{ key }` entry in `auth.staticApiKeys.keys` and never include the file contents in an error.

- [ ] **Step 4: Run focused and repository tests**

Run:

```bash
node --test test/compat-plugin.test.mjs
npm test
node --check src/compat/gateway.mjs
```

Expected: adapter tests and the complete repository suite pass.

- [ ] **Step 5: Commit the adapter**

```bash
git add src/compat/gateway.mjs test/compat-plugin.test.mjs
git commit -m "feat: add CCR compatibility core adapter"
```

### Task 2: Bridge Advisor and ToolSearch with isolated fallback

**Files:**
- Modify: `src/compat/gateway.mjs`
- Modify: `test/compat-plugin.test.mjs`

**Interfaces:**
- Consumes: `createCoreClient`, `inspectCompatibilityRequest`, `searchDeferredTools`, and canonical result constructors.
- Produces: `handleCompatibilityMessage({ body, headers, config, coreClient, createId? }) -> Promise<object>`.
- Produces: `writeAnthropicMessage(response, message, stream) -> void`.

- [ ] **Step 1: Write failing bridge tests**

Use a scripted fake core and assert these complete sequences:

```js
test("advisor bridge consults the configured Anthropic model and resumes the executor", async () => {
  const message = await handleCompatibilityMessage(fixture.input);
  assert.deepEqual(message.content.map((block) => block.type), [
    "text", "server_tool_use", "advisor_tool_result", "text",
  ]);
  assert.equal(fixture.calls[0].body.model, "executor-model");
  assert.equal(fixture.calls[1].body.model, "anthropic/claude-opus-4-8");
  assert.equal(fixture.calls[1].body.tools, undefined);
  assert.equal(fixture.calls[2].body.model, "executor-model");
});

test("ToolSearch bridge keeps deferred tools out until a local match", async () => {
  const message = await handleCompatibilityMessage(fixture.input);
  assert.equal(fixture.calls[0].body.tools.some((tool) => tool.name === "get_weather"), false);
  assert.equal(fixture.calls[1].body.tools.some((tool) => tool.name === "get_weather"), true);
  assert.deepEqual(message.content.map((block) => block.type), [
    "server_tool_use", "tool_search_tool_result", "tool_use",
  ]);
});
```

Add cases for prior native result blocks, mixed normal and compatibility tool calls, max advisor uses, invalid ToolSearch input, unsupported history fallback, Anthropic-only fallback rejection, loop cap fallback, visible fallback warning, executor/advisor `usage.iterations`, and non-stream/stream parity.

For SSE, parse emitted frames and assert that `advisor_tool_result` and `tool_search_tool_result` each appear complete in one `content_block_start`, after their matching `server_tool_use` has stopped.

- [ ] **Step 2: Run the bridge tests and verify RED**

Run:

```bash
node --test test/compat-plugin.test.mjs
```

Expected: FAIL because `handleCompatibilityMessage` and `writeAnthropicMessage` are not exported.

- [ ] **Step 3: Implement the bounded bridge loop**

Use these exact synthetic client tools:

```js
const ADVISOR_BRIDGE_NAME = "airkit_advisor";
const TOOL_SEARCH_BRIDGE_NAME = "airkit_tool_search";
```

The bridge must:

1. Remove Advisor, ToolSearch, and deferred definitions from the first executor call.
2. Convert prior Advisor/ToolSearch result blocks into bounded executor-readable text and reactivate previously referenced tools.
3. Convert executor bridge `tool_use` calls into canonical `server_tool_use` plus result blocks.
4. Call the configured Advisor model with a quoted, bounded full transcript and no tools; pass only its text back to the executor.
5. Search deferred tools locally and add only referenced definitions to the next executor call.
6. Stop and return any normal client tool call to Claude Code instead of trying to execute it.
7. Run at most eight executor iterations and honor Advisor `max_uses`.
8. On unsupported protocol, remove compatibility server tools, expand deferred tools, switch only this request to the configured Anthropic-family fallback, and prepend a visible warning text block.
9. Preserve the final model/message fields and aggregate executor/advisor usage into `usage.iterations` without adding Advisor tokens to top-level executor totals.

`writeAnthropicMessage` must return JSON for non-stream requests. For streams it must emit standard `message_start`, ordered block events, `message_delta`, and `message_stop`; server-tool result blocks are complete start events with no deltas.

- [ ] **Step 4: Run focused and full verification**

Run:

```bash
node --test test/compat-plugin.test.mjs
npm test
node --check src/compat/gateway.mjs
git diff --check
```

Expected: all bridge, streaming, and repository tests pass.

- [ ] **Step 5: Commit the bridge**

```bash
git add src/compat/gateway.mjs test/compat-plugin.test.mjs
git commit -m "feat: bridge Claude server tools through CCR"
```

### Task 3: Register the CCR routes and host WebSearch MCP

**Files:**
- Create: `src/compat/plugin.mjs`
- Modify: `test/compat-plugin.test.mjs`

**Interfaces:**
- Default export: `{ setup(ctx) }`, compatible with CCR 3.0.4 plugin loading.
- Registers: authenticated `POST /v1/messages`.
- Registers: authenticated `POST /airkit/compatibility/mcp`.
- Produces MCP tool: `web_search({ query, allowed_domains?, blocked_domains? })`.

- [ ] **Step 1: Write failing plugin and MCP tests**

The fake plugin context must capture route registration and prove:

```js
test("plugin registers only authenticated Messages and MCP routes", async () => {
  await plugin.setup(ctx);
  assert.deepEqual(ctx.routes.map(({ path, methods, auth }) => ({ path, methods, auth })), [
    { path: "/v1/messages", methods: ["POST"], auth: "gateway" },
    { path: "/airkit/compatibility/mcp", methods: ["POST"], auth: "gateway" },
  ]);
});

test("MCP web_search forces the configured Anthropic WebSearch model", async () => {
  const result = await callMcp("tools/call", {
    name: "web_search",
    arguments: { query: "current protocol release", allowed_domains: ["example.com"] },
  });
  assert.equal(coreCall.model, "anthropic/claude-sonnet-4-6");
  assert.equal(coreCall.tools[0].type, "web_search_20250305");
  assert.deepEqual(coreCall.tools[0].allowed_domains, ["example.com"]);
  assert.deepEqual(result.result.structuredContent.results, [
    { title: "Protocol release", url: "https://example.com/release", pageAge: "today" },
  ]);
});
```

Also test `initialize`, `notifications/initialized`, `tools/list`, unknown methods/tools, empty queries, mutually exclusive domain filters, provider errors as MCP `isError`, result sanitization, no encrypted payload leakage, and ordinary Messages requests taking the raw passthrough path.

- [ ] **Step 2: Run plugin tests and verify RED**

Run:

```bash
node --test test/compat-plugin.test.mjs
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/compat/plugin.mjs`.

- [ ] **Step 3: Implement CCR registration and stateless MCP JSON-RPC**

`setup(ctx)` must validate every configured Advisor, ToolSearch, and WebSearch model before registering routes. The Messages handler reads the raw body once, parses only for capability inspection, forwards malformed or ordinary bodies unchanged, and uses the bridge only when configured features are present.

The MCP handler supports:

```js
const MCP_PROTOCOL_VERSION = "2025-03-26";
const WEB_SEARCH_TOOL = {
  name: "web_search",
  description: "Search the current web through the configured Anthropic WebSearch model.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string" },
      allowed_domains: { type: "array", items: { type: "string" } },
      blocked_domains: { type: "array", items: { type: "string" } },
    },
    required: ["query"],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true },
};
```

For `tools/call`, send one non-stream Messages request with the configured Anthropic-family model, a forced `web_search_20250305` tool, `max_uses`, and the caller's domain filter. Return only public title, URL, optional page age, and final summary text; never return `encrypted_content`.

- [ ] **Step 4: Verify the whole Phase 2 surface**

Run:

```bash
node --test test/compat-plugin.test.mjs
npm test
npm run check
node --check src/compat/gateway.mjs
node --check src/compat/plugin.mjs
npm_config_cache=/tmp/airkit-npm-cache npm run pack:check
git diff --check
```

Expected: all tests/checks pass and the package contains both compatibility modules.

- [ ] **Step 5: Scan the public boundary and commit**

Run:

```bash
git diff --name-only d8dfa29..HEAD
git grep -n -i -f "$AIRKIT_PRIVATE_IDENTIFIER_FILE" -- src/compat test/compat-plugin.test.mjs docs/superpowers
```

Expected: only approved OSS files are present and a local unpublished identifier list finds no private data.

```bash
git add src/compat/plugin.mjs test/compat-plugin.test.mjs
git commit -m "feat: host Claude WebSearch compatibility in CCR"
```

## Self-review

- Spec coverage: Advisor, ToolSearch, WebSearch MCP, per-request Anthropic-only fallback, ordinary raw passthrough, SSE ordering, error isolation, and public/private separation all have an owning task.
- Placeholder scan: the plan contains no deferred implementation or unspecified error handling.
- Type consistency: Task 2 consumes Task 1's `coreClient`; Task 3 consumes both Task 1 and Task 2 exports. CCR route handlers use Node request/response objects and CCR's documented helper context.
- Deliberate deferral: AirKit profile rendering, MCP launch registration, capability doctor output, and isolated real-CCR/provider E2E belong to Phase 3.
