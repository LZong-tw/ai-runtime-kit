# AirKit observability adapter implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Route every AirClaude model request through CCR's normal proxy path so CCR UI records real provider, model, status and duration.

**Architecture:** An AirKit-owned loopback middleware replaces the compatibility plugin's public gateway routes. It applies the existing compatibility transformations, then forwards provider-qualified Anthropic Messages requests to the public CCR gateway using its generated gateway key. CCR's normal proxy owns native request recording. The adapter also owns the compatibility MCP route so tool-triggered model requests have the same observability.

**Tech Stack:** Node.js 22 ESM, native `node:http`, CCR 3.0.4, Node test runner.

## Global Constraints

- Do not write CCR's private SQLite database or call an undocumented CCR internal API.
- Do not leave `airkit-compatibility` registered for `POST /v1/messages` in managed CCR configuration.
- Adapter listens only on `127.0.0.1` with a random port and authenticates with the generated CCR gateway key using a constant-time comparison.
- The generated gateway key must travel through child IPC/environment only, never argv, source files, stderr logs or persisted config.
- Preserve Anthropic JSON/SSE status, headers, bytes, backpressure and client-abort propagation.
- Preserve `/v1/models`, `/v1/messages/count_tokens`, existing AirClaude mode routing, ToolSearch, fallback and MCP behavior.
- Enable `observability.requestLogs: true` for adapter-managed CCR configuration.
- Prove native UI observability through CCR's `getRequestLogs` RPC in the isolated CCR 3 E2E; do not inspect SQLite directly.

---

### Task 1: Extract compatibility handling behind a public-gateway client

**Files:**
- Create: `src/compat/middleware.mjs`
- Modify: `src/compat/gateway.mjs`
- Modify: `src/compat/plugin.mjs`
- Test: `test/compat-middleware.test.mjs`

**Interfaces:**
- `startCompatibilityMiddleware({ compatibility, gatewayOrigin, gatewayToken })` returns `{ close(), origin }`.
- The middleware serves `POST /v1/messages` and `POST /airkit/compatibility/mcp`; every other path proxies to `gatewayOrigin`.
- `createGatewayClient({ origin, token })` forwards only safe Anthropic headers plus `x-api-key: token` to the public CCR gateway.

- [ ] Write failing tests for authenticated JSON forwarding, byte-preserving SSE forwarding, upstream 429, abort propagation, `/v1/models` passthrough and MCP WebSearch.
- [ ] Run `node --test test/compat-middleware.test.mjs` and confirm the missing middleware failure.
- [ ] Implement the loopback server and public-gateway client without registering a CCR gateway route.
- [ ] Re-run the focused middleware suite and confirm it passes.

### Task 2: Launch and managed-config migration

**Files:**
- Modify: `src/airkit.mjs`
- Modify: `test/airkit.test.mjs`
- Modify: `test/compat-plugin.test.mjs`

**Interfaces:**
- `prepareLaunch` starts the adapter only for a compatibility-enabled AirClaude launch, replaces all final Claude gateway base URLs with the adapter origin, and closes it after Claude exits.
- Managed CCR config derives compatibility data from the catalog but excludes the legacy public plugin and enables `observability.requestLogs`.

- [ ] Write failing launch/config tests for no legacy messages route, adapter URL override, child-only key transport, lifecycle shutdown and preserved MCP configuration.
- [ ] Run the focused tests and confirm the migration expectations fail.
- [ ] Implement config extraction/filtering and adapter lifecycle around the direct Claude spawn.
- [ ] Re-run focused tests and confirm they pass.

### Task 3: Native CCR UI E2E proof

**Files:**
- Modify: `scripts/verify-ccr3-e2e.mjs`
- Modify: `test/ccr3-e2e.test.mjs`

**Interfaces:**
- `awaitNativeRequestLog({ rpc, marker, expected })` polls `getRequestLogs` and asserts exactly one row for a unique request marker.

- [ ] Write static verifier-contract assertions and a failing isolated E2E expectation for a normal JSON adapter request.
- [ ] Run the focused verifier test and observe the missing native log proof.
- [ ] Add JSON, SSE and abort adapter scenarios; assert CCR RPC rows carry the marker, provider, model, status, duration and stream state.
- [ ] Run `npm run verify:ccr3:e2e`, `npm test`, `npm run check`, and `npm run pack:check`.
