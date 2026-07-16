# Complete Server-Tool Compatibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every current Anthropic Messages API server-tool family an explicit native, local-bridge, Anthropic-fallback, or unavailable policy while preserving Claude Code's working client tools.

**Architecture:** A centralized inventory classifies tool definitions and pending history before the existing CCR plugin chooses raw passthrough, the proven ToolSearch bridge, or whole-request Anthropic fallback. Stateful server turns remain opaque and pinned to the fallback model; AirKit renders and reports policy but never writes global Claude or Codex state.

**Tech Stack:** Node.js 22 ESM, native `node:test`, CCR 3 plugin hooks, Anthropic Messages JSON/SSE, isolated loopback fake providers.

## Global Constraints

- Node.js remains `>=22`.
- Claude Code remains `>=2.1.208`; release verification exercises the installed supported version.
- Claude Code Router remains `>=3.0.4 <4`.
- Shared behavior, schemas, fake providers, and tests belong in OSS.
- Public files contain no private endpoints, company names, credential-manager references, or secret values.
- Every fallback model is an explicit Anthropic-family LiteLLM identifier.
- Ordinary non-compatibility requests remain byte-preserving passthrough.
- Do not patch Claude Code, persist a model, change permission policy, copy full user settings, or mutate Codex.
- Each task touches at most five files and ends with tests, review, and a commit.
- Run each red command before its implementation; a test that starts green does not prove the intended regression.

---

### Task 1: Central server-tool inventory and classifier

**Files:**
- Create: `src/compat/server-tools.mjs`
- Create: `test/compat-server-tools.test.mjs`
- Modify: `src/compat/protocol.mjs`
- Modify: `test/compat-protocol.test.mjs`

**Interfaces:**
- Produces `SERVER_TOOL_TYPES`, `classifyToolDefinition(tool)`, `inspectServerToolRequest(body)`, and `isFutureServerToolType(type)`.
- `inspectServerToolRequest` returns `{ clientTools, serverTools, families, futureTypes, requiresFallback }` without mutating `body`.
- Existing `inspectCompatibilityRequest` consumes the classifier and retains its Advisor/ToolSearch fields until their callers migrate.

- [ ] **Step 1: Write failing inventory tests**

```js
import {
  classifyToolDefinition,
  inspectServerToolRequest,
} from "../src/compat/server-tools.mjs";

test("classifies every current server-tool type and ToolSearch alias", () => {
  const cases = new Map([
    ["web_search_20260318", "webSearch"],
    ["web_fetch_20260318", "webFetch"],
    ["code_execution_20260521", "codeExecution"],
    ["advisor_20260301", "advisor"],
    ["tool_search_tool_regex", "toolSearch"],
    ["tool_search_tool_bm25_20251119", "toolSearch"],
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

test("identifies Claude Code web client families without treating them as server tools", () => {
  const inspection = inspectServerToolRequest({
    tools: [{ name: "WebFetch", input_schema: {} }, { name: "WebSearch", input_schema: {} }],
  });
  assert.deepEqual(inspection.clientTools.map((tool) => tool.name), ["WebFetch", "WebSearch"]);
  assert.deepEqual([...inspection.clientFamilies], ["webFetch", "webSearch"]);
  assert.deepEqual(inspection.serverTools, []);
  assert.deepEqual([...inspection.families], []);
  assert.equal(inspection.requiresFallback, false);
});

test("fails closed on future server-tool-shaped versions", () => {
  const inspection = inspectServerToolRequest({ tools: [{ type: "web_fetch_20990101" }] });
  assert.deepEqual(inspection.futureTypes, ["web_fetch_20990101"]);
  assert.equal(inspection.requiresFallback, true);
});
```

- [ ] **Step 2: Run the focused tests and confirm red**

Run: `node --test test/compat-server-tools.test.mjs test/compat-protocol.test.mjs`

Expected: FAIL because `src/compat/server-tools.mjs` does not exist and undated ToolSearch aliases are not recognized.

- [ ] **Step 3: Implement the immutable inventory**

```js
export const SERVER_TOOL_TYPES = Object.freeze({
  webSearch: Object.freeze(["web_search_20250305", "web_search_20260209", "web_search_20260318"]),
  webFetch: Object.freeze(["web_fetch_20250910", "web_fetch_20260209", "web_fetch_20260309", "web_fetch_20260318"]),
  codeExecution: Object.freeze(["code_execution_20250825", "code_execution_20260120", "code_execution_20260521"]),
  advisor: Object.freeze(["advisor_20260301"]),
  toolSearch: Object.freeze([
    "tool_search_tool_regex_20251119",
    "tool_search_tool_bm25_20251119",
    "tool_search_tool_regex",
    "tool_search_tool_bm25",
  ]),
  mcpConnector: Object.freeze(["mcp_toolset"]),
});

const FUTURE_SERVER_TOOL = /^(?:web_search|web_fetch|code_execution|advisor|tool_search_tool_(?:regex|bm25))_[0-9]{8}$/;

export function classifyToolDefinition(tool = {}) {
  for (const [family, types] of Object.entries(SERVER_TOOL_TYPES)) {
    if (types.includes(tool.type)) return { kind: "server", family, type: tool.type, known: true };
  }
  if (isFutureServerToolType(tool.type)) {
    return { kind: "server", family: null, type: tool.type, known: false };
  }
  return { kind: "client", family: null, type: tool.type ?? null, known: false };
}
```

Complete `inspectServerToolRequest` with new arrays and sets on every call; never attach metadata to `body.tools`. Update `inspectCompatibilityRequest` to use classified Advisor and ToolSearch definitions.

- [ ] **Step 4: Run focused and full protocol tests**

Run: `node --test test/compat-server-tools.test.mjs test/compat-protocol.test.mjs`

Expected: all tests pass; direct mutation assertions confirm the request is byte-equivalent after inspection.

- [ ] **Step 5: Review and commit Task 1**

Run: `git diff --check && npm run check`

Commit: `git commit -m "feat: classify complete server tool inventory"`

---

### Task 2: Compatibility configuration and effective policies

**Files:**
- Create: `src/compat/config.mjs`
- Create: `test/compat-config.test.mjs`
- Modify: `src/compat/protocol.mjs`
- Modify: `test/compat-protocol.test.mjs`

**Interfaces:**
- Produces `validateCompatibilityConfig(config)` and `resolveCompatibilityPolicies(config, nativeCapabilities)`.
- Returns a frozen `{ fallback, policies }`; policies contain all six family keys.
- Reuses `assertAnthropicFamilyModel`; no provider request occurs during validation.

- [ ] **Step 1: Write failing configuration tests**

```js
const config = {
  fallback: {
    provider: "anthropic-messages",
    model: "claude-sonnet",
    maxContinuationTurns: 8,
  },
  toolSearch: { mode: "bridge" },
  webSearch: { mode: "native-first" },
  webFetch: { mode: "native-first" },
  codeExecution: { mode: "anthropic-fallback" },
  advisor: { mode: "anthropic-fallback" },
  mcpConnector: { mode: "anthropic-fallback" },
};

test("resolves verified WebSearch and unverified WebFetch capabilities", () => {
  const resolved = resolveCompatibilityPolicies(config, { webSearch: true, webFetch: false });
  assert.deepEqual(resolved.policies, {
    webSearch: "native",
    webFetch: "anthropic-fallback",
    codeExecution: "anthropic-fallback",
    advisor: "anthropic-fallback",
    toolSearch: "bridge",
    mcpConnector: "anthropic-fallback",
  });
});

test("rejects non-Anthropic fallback and removed advisor bridge keys", () => {
  assert.throws(() => validateCompatibilityConfig({
    ...config,
    fallback: { ...config.fallback, model: "openai/gpt-5" },
  }), /fallback\.model must be an Anthropic-family model/);
  assert.throws(() => validateCompatibilityConfig({
    ...config,
    advisor: { mode: "bridge", model: "claude-opus" },
  }), /advisor\.mode.*removed/);
});
```

- [ ] **Step 2: Run the focused test and confirm red**

Run: `node --test test/compat-config.test.mjs`

Expected: FAIL because the configuration module does not exist.

- [ ] **Step 3: Implement strict configuration validation**

Implement exact mode sets, integer continuation bounds `1..32`, all-six-family output, frozen return values, and migration errors for `advisor.mode: "bridge"` plus compatibility `advisor.model`/`advisor.fallbackModel`. Native-first without verified native capability resolves to `anthropic-fallback`, never `native`.

- [ ] **Step 4: Run configuration and protocol suites**

Run: `node --test test/compat-config.test.mjs test/compat-protocol.test.mjs`

Expected: all tests pass, including missing fallback, unknown key, invalid mode, and continuation-bound cases.

- [ ] **Step 5: Review and commit Task 2**

Run: `git diff --check && npm run check`

Commit: `git commit -m "feat: define server tool compatibility policies"`

---

### Task 3: Pending history and whole-request fallback

**Files:**
- Create: `src/compat/server-history.mjs`
- Create: `src/compat/fallback.mjs`
- Create: `test/compat-fallback.test.mjs`
- Modify: `src/compat/gateway.mjs`
- Modify: `test/compat-plugin.test.mjs`

**Interfaces:**
- `inspectPendingServerHistory(body)` returns pending call IDs, result IDs, families, container ID, and continuation kind.
- `createFallbackRouter({ coreClient, config })` returns `route({ body, headers, signal })`.
- `route` overrides only `body.model`, forwards allowed headers/body fields, and returns the core response unchanged.

- [ ] **Step 1: Write failing fallback tests**

```js
test("routes typed Advisor and Code Execution requests to the configured model", async () => {
  const calls = [];
  const route = createFallbackRouter({
    config: VALID_CONFIG,
    coreClient: async (request) => {
      calls.push(request);
      return fakeJsonResponse({ stop_reason: "pause_turn", container: { id: "ctr_1" } });
    },
  });
  const body = {
    model: "non-anthropic,main-model",
    tools: [{ type: "code_execution_20260120", name: "code_execution" }],
    messages: [{ role: "user", content: "run" }],
  };
  await route({ body, headers: { "anthropic-beta": "code-execution-2025-08-25" } });
  assert.equal(calls[0].body.model, "claude-sonnet");
  assert.deepEqual(calls[0].body.tools, body.tools);
  assert.equal(calls[0].headers["anthropic-beta"], "code-execution-2025-08-25");
});

test("pairs pending calls by id and preserves mixed client continuation", () => {
  const state = inspectPendingServerHistory(MIXED_SERVER_CLIENT_BODY);
  assert.deepEqual(state.pendingServerCallIds, ["srvtoolu_1"]);
  assert.deepEqual(state.pendingClientCallIds, ["toolu_1"]);
  assert.equal(state.continuation, "mixed-client-results");
});
```

Add cases for Web Search/Web Fetch citations, Advisor encrypted result, `mcp_servers`, MCP bearer redaction, top-level container, `pause_turn`, abort, timeout, unknown blocks, 4xx/5xx passthrough, and the `maxContinuationTurns` cap.

- [ ] **Step 2: Run focused tests and confirm red**

Run: `node --test test/compat-fallback.test.mjs test/compat-plugin.test.mjs`

Expected: FAIL because the fallback/history modules do not exist and gateway still runs the Advisor approximation.

- [ ] **Step 3: Implement fallback routing and remove Advisor approximation**

Use structural copies only where `model` changes. Preserve tool definitions, `messages`, `mcp_servers`, `container`, unknown fields, and response bytes. Replace Advisor bridge selection with policy selection; delete its prompt conversion only after reference searches cover direct calls, strings, exports, tests, and mocks.

- [ ] **Step 4: Verify JSON, SSE, lifecycle, and existing passthrough**

Run: `node --test test/compat-fallback.test.mjs test/compat-plugin.test.mjs`

Expected: all fallback tests and existing raw-stream/backpressure/abort tests pass; ordinary requests still compare byte-for-byte.

- [ ] **Step 5: Review and commit Task 3**

Run: `rg -n 'requestAdvisor|advisor\.fallbackModel|advisor\.model' src test && git diff --check && npm run check`

Expected search result: only intentional migration validation/docs fixtures remain.

Commit: `git commit -m "feat: preserve server tool requests through fallback"`

---

### Task 4: ToolSearch hard cut and bridge boundary

**Files:**
- Create: `src/compat/tool-search.mjs`
- Create: `test/compat-tool-search.test.mjs`
- Modify: `src/compat/protocol.mjs`
- Modify: `src/compat/gateway.mjs`
- Modify: `test/compat-protocol.test.mjs`

**Interfaces:**
- Moves `searchDeferredTools`, result builders, bounds, and safe-regex helpers into `tool-search.mjs`.
- Produces `bridgeToolSearch({ body, definition, query })` with `{ kind: "result", block }` or `{ kind: "fallback", reason }`.
- `protocol.mjs` re-exports existing public functions during this task so package consumers do not break.

- [ ] **Step 1: Write failing alias and fallback-boundary tests**

```js
for (const type of ["tool_search_tool_regex", "tool_search_tool_bm25"]) {
  test(`bridges ${type}`, () => {
    const result = bridgeToolSearch({ body: TOOL_CATALOG, definition: { type }, query: "Read" });
    assert.equal(result.kind, "result");
    assert.equal(result.block.content.type, "tool_search_tool_search_result");
  });
}

test("requests Anthropic fallback for unsupported future ToolSearch", () => {
  assert.deepEqual(
    bridgeToolSearch({ body: TOOL_CATALOG, definition: { type: "tool_search_tool_regex_20990101" }, query: "Read" }),
    { kind: "fallback", reason: "unsupported_tool_search_version" },
  );
});
```

- [ ] **Step 2: Run ToolSearch tests and confirm red**

Run: `node --test test/compat-tool-search.test.mjs test/compat-protocol.test.mjs`

Expected: FAIL because the focused module does not exist.

- [ ] **Step 3: Move, simplify, and connect the bridge**

Move code without changing established bounds or deterministic ordering. Add aliases, explicit fallback results for unsafe Python regex, oversized catalogs, unsupported history, mixed cross-kind IDs, and unknown versions. Gateway consumes the new discriminated result instead of catching operational errors by message text.

- [ ] **Step 4: Run ToolSearch and gateway suites**

Run: `node --test test/compat-tool-search.test.mjs test/compat-protocol.test.mjs test/compat-plugin.test.mjs`

Expected: all existing search ranking/error tests and new alias/fallback tests pass.

- [ ] **Step 5: Review and commit Task 4**

Run: `git diff --check && npm run check`

Commit: `git commit -m "refactor: isolate tool search compatibility"`

---

### Task 5: AirKit rendering, migration, and doctor

**Files:**
- Modify: `src/airkit.mjs`
- Modify: `test/airkit.test.mjs`
- Modify: `src/compat/config.mjs`
- Modify: `test/compat-config.test.mjs`
- Modify: `docs/profile-schema.md`

**Interfaces:**
- AirKit consumes `validateCompatibilityConfig` before CCR save or credential resolution.
- Doctor reports all six family keys with configured vs verified state.
- Native-first profiles do not register compatibility MCP; explicit legacy `webSearch.mode: "mcp"` remains migration-only.

- [ ] **Step 1: Write failing render and doctor tests**

```js
test("native-first compatibility renders no duplicate MCP and reports six policies", async () => {
  const plan = buildLaunchPlan(CATALOG_WITH_COMPLETE_COMPATIBILITY, "example");
  assert.equal(plan.compatibilityMcp, undefined);
  assert.deepEqual(plan.compatibility.policies, {
    webSearch: "native",
    webFetch: "anthropic-fallback",
    codeExecution: "anthropic-fallback",
    advisor: "anthropic-fallback",
    toolSearch: "bridge",
    mcpConnector: "anthropic-fallback",
  });
  const report = await doctorProfile(CATALOG_WITH_COMPLETE_COMPATIBILITY, "example", DOCTOR_OPTIONS);
  assert.deepEqual(Object.keys(report.runtime.compatibility.capabilities).sort(),
    ["advisor", "codeExecution", "mcpConnector", "toolSearch", "webFetch", "webSearch"]);
});
```

Add a failing test proving removed Advisor bridge keys are rejected before CCR RPC and legacy MCP stays additive only when explicitly selected.

- [ ] **Step 2: Run AirKit/config tests and confirm red**

Run: `node --test test/compat-config.test.mjs test/airkit.test.mjs`

Expected: FAIL because rendering and doctor only know three capabilities.

- [ ] **Step 3: Replace scattered validation with the config module**

Delete the duplicated three-capability loops from `airkit.mjs`; define verified
native capabilities once in the config module and make both Doctor and the
runtime plugin resolve policy from that source. Keep all unrelated providers,
profiles, plugins, MCP servers, and user statusline handling unchanged. Document
the generic public schema and the legacy MCP migration behavior.

- [ ] **Step 4: Run AirKit/config tests**

Run: `node --test test/compat-config.test.mjs test/airkit.test.mjs`

Expected: all tests pass and second prepare remains idempotent.

- [ ] **Step 5: Review and commit Task 5**

Run: `git diff --check && npm run check`

Commit: `git commit -m "feat: render complete server tool policy"`

---

### Task 6: Real Claude wire contract and isolated fallback E2E

**Files:**
- Create: `scripts/capture-claude-tool-contract.mjs`
- Create: `test/claude-tool-contract.test.mjs`
- Modify: `scripts/verify-ccr3-e2e.mjs`
- Modify: `test/ccr3-e2e.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Capture script runs real Claude Code with isolated `HOME`, `CLAUDE_CONFIG_DIR`, fake API key, and loopback endpoint.
- It emits a sanitized JSON contract: Claude version, client tool names, server types, continuation result, and `realHomeReferenced`.
- E2E fake core records fallback model, body hashes, continuation count, container, and redacted headers.

- [ ] **Step 1: Write failing contract and repository tests**

```js
test("wire capture proves native WebSearch through a fake provider", async () => {
  const result = await runCapture({ claudePath: process.env.CLAUDE_PATH, tool: "WebSearch" });
  assert.equal(result.realHomeReferenced, false);
  assert.equal(result.initialTools.includes("WebSearch"), true);
  assert.equal(result.continuation.toolResultId, result.toolUseId);
});

test("isolated CCR verifier exercises every fallback family", async () => {
  const source = await readFile(VERIFIER, "utf8");
  for (const family of ["advisor", "webSearch", "webFetch", "codeExecution", "mcpConnector"]) {
    assert.match(source, new RegExp(`fallback.*${family}`, "i"));
  }
});
```

- [ ] **Step 2: Run contract tests and confirm red**

Run: `node --test test/claude-tool-contract.test.mjs test/ccr3-e2e.test.mjs`

Expected: FAIL because the capture script and fallback scenarios do not exist.

- [ ] **Step 3: Implement isolated captures and fake fallback scenarios**

Use OS-assigned loopback ports, temporary homes, bounded child-process timeouts,
and retained artifacts only on failure. Attempt WebFetch against a loopback
fixture, not the public internet, and record Claude's domain-safety rejection
without claiming native execution. Never inherit real Claude/CCR config paths
or credential variables. Add `verify:tool-contract` to `package.json` without
changing lockfiles.

- [ ] **Step 4: Run isolated verification**

Run: `node --test test/claude-tool-contract.test.mjs test/ccr3-e2e.test.mjs`

Then run: `node scripts/verify-ccr3-e2e.mjs`

Expected: tests pass; verifier reports six compatibility policies, Anthropic fallback model, idempotent managed save count `1`, and no real-home reference.

- [ ] **Step 5: Review and commit Task 6**

Run: `git diff --check && npm run check`

Commit: `git commit -m "test: verify complete server tool routing"`

---

### Task 7: OSS hard cut, documentation, and release verification

**Files:**
- Modify: `README.md`
- Modify: `CLAUDE.md`
- Modify: `docs/install.md`
- Modify: `docs/superpowers/specs/2026-07-14-claude-gateway-compatibility.md`
- Modify: `test/airkit.test.mjs`

**Interfaces:**
- Old spec is visibly superseded and cannot be mistaken for current operating guidance.
- Human and LLM docs share the same six-family policy table and migration commands.

- [ ] **Step 1: Add a failing stale-guidance test to the existing package export path**

Extend `"OSS package allowlist excludes tests and migration artifacts"` with
the exact assertions below:

```js
for (const document of ["README.md", "CLAUDE.md"]) {
  const text = await readFile(resolve(import.meta.dirname, "..", document), "utf8");
  for (const term of ["codeExecution", "mcpConnector", "native-first"]) {
    assert.match(text, new RegExp(term), `${document} must document ${term}`);
  }
  assert.doesNotMatch(
    text,
    /Advisor, ToolSearch, and WebSearch are all compatibility capabilities/,
  );
}
```

- [ ] **Step 2: Run the selected export test and confirm red**

Run: `node --test test/airkit.test.mjs --test-name-pattern="OSS package allowlist"`

Expected: FAIL on missing complete-policy guidance.

- [ ] **Step 3: Remove stale default MCP behavior and update operating docs**

Keep the authenticated MCP route only for explicit legacy mode. Document source/profile migration, doctor interpretation, fallback cost boundary, native tool ownership, and exact recovery commands. Mark the 2026-07-14 spec superseded at its top.

- [ ] **Step 4: Run complete OSS release gates**

Run: `npm test`

Run: `npm run check`

Run: `npm_config_cache=/tmp/airkit-npm-cache npm run pack:check`

Run: `node scripts/verify-ccr3-e2e.mjs`

Run the real known-company identifier scan from private release automation. The
pattern is supplied out of band so OSS documentation does not reproduce those
identifiers:

```bash
test -n "$AIRKIT_PRIVATE_IDENTIFIER_PATTERN"
rg -n -i "$AIRKIT_PRIVATE_IDENTIFIER_PATTERN" README.md CLAUDE.md docs src test scripts profiles
```

Review generic credential-scheme and redaction-fixture matches separately:

```bash
rg -n -i 'op://|private-token' README.md CLAUDE.md docs src test scripts profiles
```

`op://` is a generic credential-manager scheme. Synthetic `private-token`
values are expected in redaction fixtures and source validation tests. Keep
those security cases; inspect their surrounding lines to prove they contain no
real account, tenant, endpoint, or secret value. Expected: all suites and E2E
pass; the company-identifier scan has no matches; generic matches have only the
documented synthetic disposition; `git diff --check` is clean.

- [ ] **Step 5: Independent review and commit Task 7**

Require one spec-compliance review and one code-quality/security review. Resolve every finding or record a concrete disposition before commit.

Commit: `git commit -m "docs: hard cut complete server tool compatibility"`

---

### Task 8: Private overlay opt-in and user-facing verification

**Files:**
- Modify: `../private-runtime-overlay/profiles/catalog.json`
- Modify: `../private-runtime-overlay/docs/examples/private-profile.profile.json`
- Modify: `../private-runtime-overlay/docs/profile-schema.md`
- Modify: `../private-runtime-overlay/test/airkit.test.mjs`
- Modify: `../private-runtime-overlay/README.md`

**Interfaces:**
- Private profile consumes the OSS schema without duplicating runtime logic.
- All fallback models use the approved Anthropic-family LiteLLM identifiers in the private catalog.
- Existing `airclaude` (and any overlay-specific launcher variants), modes, aliases, statusline, and passthrough arguments remain unchanged.

- [ ] **Step 1: Write failing private-profile tests**

```js
test("private profile configures all six server-tool policies", () => {
  const profile = catalog.profiles.find(({ name }) => name === "private-profile");
  const compatibility = profile.ccr.plugins.find(
    ({ id }) => id === "airkit-compatibility",
  )?.config;
  assert.ok(compatibility);
  assert.deepEqual(compatibility.toolSearch, { mode: "bridge" });
  assert.equal(compatibility.webSearch.mode, "native-first");
  assert.equal(compatibility.webFetch.mode, "native-first");
  for (const key of ["advisor", "codeExecution", "mcpConnector"]) {
    assert.equal(compatibility[key].mode, "anthropic-fallback");
  }
  assert.equal(compatibility.fallback.model, "claude-sonnet");
});
```

Add assertions that source/example remain equal and wrapper output still delegates once with `"$@"`.

- [ ] **Step 2: Run private-overlay tests and confirm red**

Run from the private-overlay root: `npm test`

Expected: FAIL because the profile currently has no compatibility section.

- [ ] **Step 3: Add private policy and update overlay docs**

Add the approved provider-local Anthropic-family fallback ID once to the profile
source, mirror it in the documented example, describe the six states, and
preserve every existing provider route and wrapper command. Do not copy the
actual identifier into this OSS plan and do not add secret values.

- [ ] **Step 4: Verify private-overlay rendering and real dry-run**

Run: `npm test && npm run check`

Run: `node src/airkit.mjs doctor --profile private-profile`

Run: `node src/airkit.mjs airclaude glm --dry-run -r`

Expected: doctor reports six configured policies without false live claims; dry-run shows `mode: glm`, unchanged GLM/default routes, and final `-r`.

- [ ] **Step 5: Commit Task 8 and stop before live write**

Commit: `git commit -m "feat: enable complete server tool compatibility"`

Report previewed paths and request explicit approval before `update --write` or any live smoke test.

---

### Task 9: User-approved live cutover and final push

**Files:**
- No source edits unless verification exposes a reproducible defect; any defect starts a new red-green task with at most five files.

**Interfaces:**
- Consumes committed OSS and private-overlay changes plus explicit user approval.
- Produces verified live managed state without modifying global model, permission, Codex, or session history.

- [ ] **Step 1: Preview the live update**

Run from the private-overlay root: `node src/airkit.mjs update --profile private-profile`

Expected: preview lists only AirKit-managed CCR/plugin/shell paths and no global Claude/Codex settings.

- [ ] **Step 2: Obtain explicit approval and apply once**

Run only after approval: `node src/airkit.mjs update --profile private-profile --write`

Expected: backup paths are printed and managed save count remains idempotent on a second preview.

- [ ] **Step 3: Verify normal entrypoints**

Run: `airclaude glm -r --help`

Run: `airclaude --doctor`

Expected: no takeover/login error; mode remains `glm`; final Claude arguments include `-r`; statusline setting is inherited without copying other user settings.

- [ ] **Step 4: Run final release gates and inspect repository state**

OSS: `npm test && npm run check && npm_config_cache=/tmp/airkit-npm-cache npm run pack:check && node scripts/verify-ccr3-e2e.mjs`

Private overlay: `npm test && npm run check`

Both: `git status --short --branch && git diff --check`

Expected: all gates pass, both worktrees are clean, and no uncommitted changes remain.

- [ ] **Step 5: Push both main branches and report exact state**

Run: `git push origin main` in OSS, then the private overlay.

Report commit IDs, test counts, E2E summary, backup paths, and any capability still marked unverified. Do not say a capability is native or working unless its exact E2E ran.
