# Provider-specific Headroom routing design

## Problem

`hr-airclaude` currently overrides only the active mode's OpenAI-compatible
provider through `AIRCLAUDE_PROVIDER_BASE_URL`. A later `/model` switch to a
different provider therefore bypasses Headroom. Reusing one override for every
provider is unsafe because OnePortal and Web LiteLLM have different upstreams,
and their OpenAI and Anthropic endpoints use different wire protocols.

The existing proxy reuse check verifies only the Headroom mode. A healthy port
can consequently be reused with a stale upstream or feature posture. This was
observed when Web LiteLLM accepted the ordinary Claude tool catalog directly
but rejected the Anthropic server-side Tool Search injected by Headroom's
default coding profile.

## Decision

AirKit will accept a provider-specific base URL map in addition to its two
legacy active-provider overrides. The map is keyed by the profile's source
provider name and is applied to every matching managed CCR provider. This keeps
the provider identity and protocol explicit across `/model` switches.

The local Headroom helpers will use two protocol-complete proxies:

- Port 8804 targets both OnePortal endpoints in cache mode.
- Port 8807 targets both Web LiteLLM endpoints in token mode.

`hr-airclaude` starts or reuses both proxies and passes this map:

| Provider | Headroom endpoint |
| --- | --- |
| `oneportal` | `http://127.0.0.1:8804/v1/chat/completions` |
| `oneportal-anthropic` | `http://127.0.0.1:8804/v1/messages` |
| `web_litellm` | `http://127.0.0.1:8807/v1/chat/completions` |
| `web_litellm_anthropic` | `http://127.0.0.1:8807/v1/messages` |

The old scalar overrides remain supported for other wrappers and installations.
A provider-specific entry has precedence over a scalar active-provider
override. Invalid JSON, unknown providers, non-HTTP(S) URLs, or an endpoint
whose path does not match the provider protocol fail before CCR state changes.

## Proxy safety

Each helper-owned port records a configuration fingerprint covering mode,
Anthropic target, OpenAI target, Kompress posture, and Tool Search posture.
Before reuse, `_hr_proxy` compares the requested fingerprint with the running
one. A mismatch restarts only that helper-owned port and waits for readiness;
it never reuses a merely healthy but incorrectly configured proxy.

Server-side Anthropic Tool Search is disabled for both private gateways unless
a live provider contract proves support. This does not remove Claude Code's
ordinary client tools; it only prevents Headroom from replacing them with an
unsupported server tool. The first-party Anthropic subscription proxy keeps its
existing behavior.

## Failure behavior

- No provider silently falls back to another upstream because Headroom failed.
- A proxy that cannot become ready blocks the launch and points to its log.
- Provider map validation errors name the provider and URL field, never a token.
- Existing sessions retain their generated provider URLs; a new `hr-airclaude`
  launch is required to adopt the map.
- Direct `airclaude`, `claude-web`, and other non-`hr-*` commands remain
  unchanged.

## Verification

Automated OSS tests must prove that the provider map:

1. overrides multiple OpenAI and Anthropic providers in one managed config;
2. survives a mode whose default provider differs from later `/model` choices;
3. takes precedence over legacy scalar overrides;
4. rejects malformed, unknown, and protocol-mismatched entries before save.

Shell verification must prove stale proxy fingerprints are rejected or
restarted and that the generated JSON map contains all four exact providers.
Live probes must send a tool-bearing request directly and through Headroom to
both Web LiteLLM protocols. The Anthropic probe must return its requested Claude
model without a `router:tool_search_deferral` transform. OnePortal probes must
likewise verify both protocols when the configured credentials are available.

Completion requires the full OSS and internal test/check suites, regeneration
of the managed profile, and inspection of the resulting four provider URLs.
