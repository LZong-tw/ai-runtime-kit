# Claude Gateway Compatibility Design (Superseded)

> **Superseded on 2026-07-15. Do not use this document as operating or
> implementation guidance.** The approved replacement is
> [`2026-07-15-complete-server-tool-compatibility-design.md`](2026-07-15-complete-server-tool-compatibility-design.md).
> Current profile syntax is defined in [`../../profile-schema.md`](../../profile-schema.md),
> and the supported install/migration commands are in
> [`../../install.md`](../../install.md).

## Why it was superseded

The 2026-07-14 design assumed that Advisor could be approximated by a bridge and
that WebSearch should default to a compatibility MCP tool. Contract capture and
implementation review invalidated both assumptions. Whole-request Anthropic
fallback is required for server-owned state and result semantics, while the
legacy WebSearch MCP route must be explicit and migration-only.

This file is retained only as a decision record. Its former schema and behavior
must not be copied into a profile.

## Current six-family boundary

| Family | Profile mode | Effective behavior |
| --- | --- | --- |
| WebSearch (`webSearch`) | `native-first` | Native. The complete call/result wire cycle was verified with real Claude Code 2.1.211. |
| WebFetch (`webFetch`) | `native-first` | Anthropic fallback for now. Claude exposes the native client tool, but the zero-public-network loopback execution is blocked by Claude's domain-safety check, so AirKit does not claim the native cycle is verified. |
| Code Execution (`codeExecution`) | `anthropic-fallback` | The complete request uses the configured Anthropic route so container and continuation state stay intact. |
| Advisor (`advisor`) | `anthropic-fallback` | The complete request uses the configured Anthropic route; the removed approximation bridge is not used. |
| ToolSearch (`toolSearch`) | `bridge` | Safe bounded regex/BM25 requests use the local bridge. Unsafe, oversized, unsupported, or unknown requests fall back as a complete request. |
| MCP Connector (`mcpConnector`) | `anthropic-fallback` | Typed server-side connector requests use the configured Anthropic route; client-side MCP remains native. |

Fallback is scoped to one request and uses the configured Anthropic route's
context, cache, and billing. A fallback model must be both Anthropic-family and
CCR/provider-routable. A slash-bearing `anthropic/claude-*` identifier may be
ambiguous in CCR, so its prefix alone is not routing proof; use a proven route
such as `claude-sonnet` and verify it end to end.

Only explicit `webSearch.mode: "mcp"` retains the legacy additive `web_search`
MCP migration route. Native-first profiles register no duplicate MCP tool.

## Recovery and verification

Edit the source profile, not generated CCR state. Move removed Advisor model
fields into the generic `fallback` section, declare all six family modes, and
then run:

```bash
PROFILE=your-profile
node src/airkit.mjs update --profile "$PROFILE"
node src/airkit.mjs update --profile "$PROFILE" --write
node src/airkit.mjs doctor --profile "$PROFILE"
npm run verify:tool-contract
npm run verify:ccr3:e2e
```

Doctor reports policy state, not proof of a successful paid fallback request:
`native` and `bridged` are verified routing policies,
`anthropic-fallback` is configured but unprobed, and `unverified` identifies
the explicit legacy MCP route.
