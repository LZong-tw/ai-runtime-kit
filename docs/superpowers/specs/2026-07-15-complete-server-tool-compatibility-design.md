# Complete Server-Tool Compatibility Design

**Status:** Approved in conversation on 2026-07-15; written for final review.

**Supersedes:** `2026-07-14-claude-gateway-compatibility.md` where the earlier
document describes Advisor, ToolSearch, and WebSearch as if they were the full
compatibility surface.

## Goal

Preserve Claude Code tool behavior when its Messages API traffic is routed
through CCR 3 to a provider that does not implement Anthropic server tools.
Prefer Claude Code's working native client tools, bridge only behavior that can
be reproduced faithfully, and route an entire affected request to an explicitly
configured Anthropic-family model when server-owned semantics cannot be safely
emulated.

"Complete" means every current Anthropic Messages API server-tool family has an
explicit, tested policy. It does not mean reimplementing Anthropic infrastructure
inside AirKit.

## Constraints

- Node.js remains `>=22`.
- Claude Code remains `>=2.1.208`; the isolated wire contract is also exercised
  against the installed supported version during release verification.
- Claude Code Router remains `>=3.0.4 <4`.
- Shared classification, routing, lifecycle, schema, and tests belong in OSS.
- Private endpoints, credential references, company identifiers, and private
  model catalogs remain outside OSS.
- AirKit never patches Claude Code, spoofs a first-party deployment, writes a
  global Claude model, changes permission policy, or copies the user's complete
  settings file.
- Fallback models must be explicitly configured Anthropic-family LiteLLM model
  identifiers. The runtime rejects other families before making a request.
- Ordinary non-compatibility requests remain byte-preserving passthrough at the
  plugin boundary.
- Each implementation phase touches no more than five files and ends with its
  own tests, review, and commit.

## Current inventory

The supported server-tool inventory is:

| Family | Current request types | Default compatibility policy |
| --- | --- | --- |
| Web Search | `web_search_20250305`, `web_search_20260209`, `web_search_20260318` | native client tool when Claude Code supplies one; otherwise Anthropic request fallback |
| Web Fetch | `web_fetch_20250910`, `web_fetch_20260209`, `web_fetch_20260309`, `web_fetch_20260318` | native client tool when Claude Code supplies one; otherwise Anthropic request fallback |
| Code Execution | `code_execution_20250825`, `code_execution_20260120`, `code_execution_20260521` | Anthropic request fallback |
| Advisor | `advisor_20260301` | Anthropic request fallback |
| Tool Search | `tool_search_tool_regex_20251119`, `tool_search_tool_bm25_20251119`, `tool_search_tool_regex`, `tool_search_tool_bm25` | local bridge, then Anthropic request fallback when unsupported |
| MCP Connector | `mcp_toolset` with the current supported beta contract | Anthropic request fallback only when this server-side connector is present |

Anthropic-schema client tools such as Memory, Bash, Text Editor, and Computer
Use are not server tools. Claude Code client-side MCP tools are also not the
Messages API MCP Connector and remain untouched.

The inventory is centralized data, not scattered string checks. Known versions
are exact matches. A future server-tool-shaped type that is not yet known must
not be passed blindly to a non-Anthropic provider: it is routed through the
configured fallback when policy permits, otherwise the request fails closed
with a bounded compatibility error.

## Native-first decision

AirKit classifies the request before transforming it:

1. If Claude Code supplies a client tool such as `WebFetch` or `WebSearch`, the
   tool remains native to Claude Code. AirKit does not register a duplicate MCP
   tool by default.
2. If the request contains no server-tool definitions or pending server-tool
   history, the request passes through unchanged.
3. If every detected server tool has a proven local bridge, AirKit uses that
   bridge without changing the main model.
4. If any detected server tool requires server-owned state or semantics, AirKit
   routes the complete request to the configured Anthropic-family fallback.
5. A request never mixes an emulated half-turn with an unrelated fallback model.

The release E2E captures the actual supported Claude Code custom-gateway request
shape. A client tool is marked `native` only after the fake-provider scenario
shows that Claude Code accepts its `tool_use`, produces the expected result or
continuation, and returns control to the main conversation. Presence in the
initial `tools` array alone is not sufficient.

## Compatibility policy model

Each family reports exactly one effective policy:

- `native`: Claude Code owns definition, execution, permission prompts, hooks,
  result history, and rendering.
- `bridge`: AirKit performs a protocol-equivalent local operation and returns
  the documented result shape.
- `anthropic-fallback`: AirKit forwards the entire request and its continuations
  to the configured Anthropic-family backend.
- `unavailable`: configuration or runtime capability is missing; the request
  fails with a bounded actionable error.

The profile has one generic fallback section rather than hiding whole-request
fallback under Advisor:

```json
{
  "fallback": {
    "provider": "anthropic-messages",
    "model": "anthropic/claude-sonnet",
    "maxContinuationTurns": 8
  },
  "toolSearch": {
    "mode": "bridge"
  },
  "webSearch": {
    "mode": "native-first"
  },
  "webFetch": {
    "mode": "native-first"
  },
  "codeExecution": {
    "mode": "anthropic-fallback"
  },
  "advisor": {
    "mode": "anthropic-fallback"
  },
  "mcpConnector": {
    "mode": "anthropic-fallback"
  }
}
```

The public identifiers above are placeholders. A private overlay owns its real
provider and model selection. Removed legacy keys are rejected with a migration
message instead of silently changing semantics.

## Whole-request fallback lifecycle

Fallback is a routing decision for one logical server-tool turn, not a global
model change. It preserves the incoming request body and allowed Anthropic
headers except for the explicit fallback model mapping.

The fallback lifecycle must preserve:

- all request tool definitions, including unknown optional properties;
- all response content blocks byte-for-byte at the JSON value level;
- call/result pairing by `tool_use_id`, never by adjacency;
- `pause_turn` continuation by resending the paused assistant content unchanged
  with the same tool definitions;
- mixed server/client turns by returning only the pending client
  `tool_result` blocks while keeping unresolved server calls and tool definitions;
- top-level `container.id` and subsequent container reuse for Code Execution;
- `mcp_servers`, `mcp_toolset`, connector beta headers, and opaque connector
  result content;
- citations, encrypted fields, caller metadata, redacted Advisor results,
  document/PDF blocks, Files API references, and future unknown result blocks;
- abort, timeout, backpressure, and downstream-close propagation.

Backend affinity is maintained for the entire pending server-tool lifecycle.
Continuation detection uses request content and container identity, not mutable
global session state. The continuation cap prevents infinite `pause_turn` or
programmatic-tool loops and produces a bounded visible error.

## Per-family behavior

### Web Search and Web Fetch

Claude Code client tools named `WebSearch` and `WebFetch` remain native when the
isolated E2E proves their complete call/result cycle. They are not evidence that
typed Messages API server tools will work through a non-Anthropic provider.

When typed server-tool definitions appear, the complete request falls back so
Anthropic retains domain filtering, localization, citations, URL provenance,
PDF/document results, cache controls, dynamic filtering, response inclusion,
code-execution callers, and `pause_turn` behavior. AirKit must not down-convert
these tools into a titles-and-URLs-only MCP response.

The existing compatibility MCP `web_search` is retained only as an explicit
legacy opt-in during migration. It is not registered for a native-first profile
and is removed after the supported Claude Code matrix proves native behavior.

### Code Execution

Code Execution always uses whole-request fallback. AirKit does not emulate the
container, REPL, filesystem, generated files, Files API, nested programmatic
tool calls, or 90-second cell behavior as a local MCP tool. The fallback keeps
container affinity and every continuation until the logical server-tool turn
finishes or reaches its configured cap.

### Advisor

Advisor uses whole-request fallback. The previous bridge converted the
transcript into a bounded text prompt and could not preserve the official
encrypted/redacted result and usage semantics. That approximation is removed,
not presented as parity. The request keeps the Advisor definition, beta header,
model contract, transcript, caching fields, `max_uses`, `max_tokens`, and result
blocks on the Anthropic path.

### Tool Search

Tool Search remains a local bridge because deterministic regex/BM25 catalog
search can be reproduced without a model call. It supports dated and undated
official types, searches the bounded deferred catalog, preserves deterministic
ordering, and returns official tool references through the established bridge
contract.

Inputs outside the proven safe regex/BM25 subset, oversized catalogs, unknown
versions, unsupported history, or mixed shapes trigger whole-request fallback.
They are never silently treated as an ordinary request.

### MCP Connector

`mcp_toolset` and top-level `mcp_servers` are server-side connector semantics.
They fall back only when present in the Messages API request. AirKit does not
copy them into its own MCP registry, does not persist bearer tokens, and does
not proxy OAuth. Logs redact connector authorization and server definitions.

Claude Code's existing client-side MCP servers remain native and additive.

## Components

The compatibility runtime is split into focused units instead of extending the
existing large gateway and plugin files:

- server-tool inventory and request classification;
- configuration validation and effective-policy resolution;
- whole-request fallback and backend-affinity lifecycle;
- pending server-tool history and continuation classification;
- ToolSearch local bridge;
- optional legacy MCP tool registry;
- web/content sanitizers and bounded public errors;
- AirKit rendering and doctor reporting.

The CCR plugin remains the single gateway boundary. No permanent second daemon
is introduced.

## Doctor and observability

`doctor` reports all six families and the effective state for the selected
profile. It distinguishes configuration from live verification:

```text
native compatibility webSearch (verified with Claude Code 2.1.210)
native compatibility webFetch (verified with Claude Code 2.1.210)
anthropic-fallback compatibility codeExecution (configured, unprobed)
anthropic-fallback compatibility advisor (configured, unprobed)
bridged compatibility toolSearch (verified)
anthropic-fallback compatibility mcpConnector (configured, unprobed)
```

Logs include only capability, policy, request correlation ID, continuation
count, and bounded status. They exclude prompts, transcripts, connector config,
credentials, encrypted blocks, tool inputs/results, and provider payloads.

## Failure behavior

- Missing or non-Anthropic fallback configuration fails before provider traffic.
- A native client-tool failure is reported as native failure; AirKit does not
  silently retry a side-effecting client tool through another implementation.
- Unsupported known server-tool shapes use whole-request fallback.
- Unknown future server-tool types use fallback when configured and otherwise
  fail closed.
- Provider 4xx/5xx responses remain provider errors and are not rewritten as a
  successful tool result.
- Fallback failure does not change the user's default route or persisted model.
- Optional compatibility failure does not mutate CCR configuration, Claude
  settings, Codex settings, sessions, or unrelated MCP registrations.

## Testing and release gates

Protocol unit tests cover all current exact types, ToolSearch aliases, unknown
future types, client/server distinction, policy selection, result pairing,
`pause_turn`, mixed calls, containers, opaque blocks, aborts, timeouts, and
redaction.

The isolated fake-provider E2E covers:

1. current Claude Code custom-gateway request capture;
2. native `WebSearch` call/result continuation;
3. native `WebFetch` call/result continuation without external network access;
4. ToolSearch local bridge and fallback boundary;
5. Advisor whole-request fallback;
6. Web Search and Web Fetch typed server-tool fallback;
7. Code Execution container continuation;
8. MCP Connector request preservation with fake credentials;
9. JSON and SSE paths, typed errors, and retry/abort behavior;
10. CCR restart persistence, idempotent saves, and zero access to the real home.

OSS verification includes the complete test suite, syntax check, package dry
run, public-identifier scan, and isolated CCR 3 E2E. The private overlay then
enables the policy with Anthropic-family model identifiers, runs its tests and
doctor, checks the real dry-run command, and performs a user-approved live smoke
test without changing the normal command names or passthrough arguments.

## Acceptance criteria

- Every current official server-tool family has one explicit effective policy.
- Claude Code native client tools are not duplicated.
- No request containing an unsupported server tool is blindly routed to a
  non-Anthropic provider.
- Stateful fallbacks preserve continuation and backend affinity.
- ToolSearch remains local for its proven subset.
- Advisor no longer claims parity through transcript approximation.
- Doctor reports all six families without claiming unrun live verification.
- Existing AirClaude and `hr-*` commands keep their names and arguments.
- No global Claude, CCR-unrelated, Codex, credential, or session state is
  overwritten.
- OSS contains no private identifiers.
- Both repositories pass their complete release gates before push.

## CCR upstream boundary

Suitable CCR contributions remain generic: documented Messages middleware,
safe raw forwarding to core, opaque content-block passthrough, continuation and
backend-affinity hooks, authenticated plugin-hosted MCP endpoints, and tests that
prevent unknown server-tool blocks from being stripped.

AirKit retains profile policy, Anthropic-family model validation, doctor labels,
legacy migration, and private overlay configuration.
