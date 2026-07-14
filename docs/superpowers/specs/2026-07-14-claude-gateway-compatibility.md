# Claude Gateway Compatibility Design

**Status:** Approved for implementation on 2026-07-14.

## Goal

Preserve Claude Code's native tool behavior when its Messages API traffic is
routed through CCR 3 to providers that do not implement Anthropic server-tool
content blocks. The user keeps the existing Claude Code and AirClaude entrypoints;
compatibility is selected by the active AirKit profile.

## Constraints

- Node.js must remain `>=22`.
- Claude Code must remain `>=2.1.208`.
- Claude Code Router must remain `>=3.0.4 <4`.
- Shared behavior, schemas, fake providers, and tests belong in OSS.
- Private endpoints, company names, credential references, and private model
  catalogs must not enter OSS.
- Do not patch the Claude Code binary, spoof a first-party deployment, or write
  a model selection into global Claude settings.
- Do not mutate unrelated CCR providers, profiles, plugins, MCP servers, aliases,
  or sessions.
- A compatibility fallback may use only an explicitly configured
  Anthropic-family LiteLLM model.

## Architecture

One profile-scoped CCR 3 plugin owns the compatibility boundary. It is not a
second router: ordinary requests pass to CCR core unchanged. The plugin activates
only for configured protocol features.

The plugin has two surfaces:

1. A gateway interceptor for Anthropic Messages content blocks that already
   appear in Claude Code requests, such as advisor and deferred tool search.
2. A local MCP endpoint for tools that Claude Code omits entirely in custom
   gateway mode, beginning with WebSearch.

AirKit renders the plugin configuration and MCP registration into its isolated
profile state. It does not add global Claude settings.

## Public configuration

Profiles may opt in with a generic configuration shaped like this:

```json
{
  "plugins": [
    {
      "id": "airkit-compatibility",
      "module": "{{configDir}}/plugins/airkit-compatibility.cjs",
      "config": {
        "advisor": {
          "mode": "bridge",
          "provider": "anthropic-messages",
          "model": "anthropic/claude-opus",
          "fallbackModel": "anthropic/claude-opus"
        },
        "toolSearch": {
          "mode": "bridge"
        },
        "webSearch": {
          "mode": "mcp",
          "provider": "anthropic-messages",
          "model": "anthropic/claude-sonnet"
        }
      }
    }
  ]
}
```

The example model IDs are placeholders. A real public or private profile owns
the provider and model mapping. The runtime validates that advisor and server
tool fallback models are declared as Anthropic-family models instead of silently
falling back to another family.

## Advisor bridge

Claude Code sends an `advisor_20260301` server-tool definition. For a provider
that supports the native tool, the plugin passes the request through unchanged.
For bridge mode:

1. Preserve the original transcript, advisor model, `max_uses`, `max_tokens`,
   caching fields, and beta header semantics.
2. Present an equivalent no-argument advisor tool to the executor.
3. When invoked, call the configured Anthropic Messages advisor model with the
   full transcript and no client tools.
4. Return standard `server_tool_use` and `advisor_tool_result` blocks and resume
   the executor in the same outward request.
5. Preserve SSE ordering: the advisor result is emitted as one complete block,
   not token deltas.
6. Report advisor usage separately when the upstream exposes it.

If the bridge encounters an unsupported content sequence, the whole current
request may be rerouted to the configured Anthropic-family fallback model. It
must emit a visible compatibility warning and must not select a non-Anthropic
fallback.

## Deferred tool-search bridge

When Claude Code explicitly enables tool search through a custom gateway, it
sends deferred tool definitions and a regex or BM25 server-tool definition.
Bridge mode keeps the full catalog outside the executor prompt, searches tool
names, descriptions, property names, and property descriptions locally, and
returns at most five `tool_reference` entries by default.

Regex searches are case-insensitive and bounded by the official 200-character
query limit. BM25 searches are case-insensitive, bounded by the official
500-character query limit, and use deterministic token scoring. The bridge does
not execute a model call for catalog search.

Invalid queries produce a typed tool-search error. Unsupported protocol shapes
may reroute only the current request to the configured Anthropic-family fallback
model.

Profiles enable Claude Code threshold mode only in the launched process, for
example `ENABLE_TOOL_SEARCH=auto:5`; AirKit does not persist the value globally.

## WebSearch compatibility tool

Claude Code disables its built-in WebSearch tool for a custom gateway. The
plugin therefore exposes a profile-scoped MCP tool named `web_search`. Claude
Code remains responsible for MCP discovery, permissions, hooks, rendering, and
tool-result history.

The MCP handler makes a forced Anthropic WebSearch request through the configured
Anthropic Messages provider and returns titles and URLs. It preserves `query`,
`allowed_domains`, and `blocked_domains`. It does not silently switch to another
search vendor or a non-Anthropic model.

The MCP endpoint is hosted by the existing CCR plugin process. AirKit must not
spawn a permanent second daemon solely for compatibility tools.

## Failure isolation

- Plugin startup failure must not mutate the live profile or unrelated CCR state.
- Ordinary requests must remain usable when an optional compatibility capability
  is unavailable.
- Advisor and tool-search fallbacks are per request, never global model changes.
- WebSearch backend failure returns an MCP tool error.
- Logs redact authorization headers, API keys, transcripts, and tool results by
  default.
- `doctor` reports each capability separately as native, bridged, unavailable,
  or unverified.

## Upstream boundary

Changes suitable for CCR upstream are:

- a documented middleware hook for `/v1/messages` before provider conversion;
- an explicit and safe way for a plugin to forward an unhandled request to CCR
  core without recursive gateway calls;
- helpers for Anthropic SSE and content-block passthrough;
- tests that prevent unknown server-tool blocks from being stripped;
- a generic mechanism for plugin-hosted MCP endpoints.

AirKit-specific policy, profile rendering, fallback model selection, and any
private provider configuration remain outside CCR.

## Acceptance criteria

- Existing AirClaude commands and shell functions keep their arguments and names.
- No global Claude model or tool setting is written.
- Existing non-compatibility requests are byte-equivalent at the plugin boundary.
- Advisor, ToolSearch, and WebSearch each have protocol-level unit tests.
- Fake-provider end-to-end tests cover streaming, errors, and fallback isolation.
- OSS scans contain no private identifiers.
- The full OSS verify command and the private overlay's tests/checks pass before
  either repository is pushed.
