# ai-runtime-kit

AirKit turns public runtime profiles into managed Claude Code Router configuration
and an `airclaude` launcher. It previews every managed-file or runtime change,
keeps machine state outside git, and verifies the installed launch path.

## Quick start

Prerequisites are Node.js 22 or newer, Claude Code 2.1.208 or newer, Claude Code
Router 3.0.4 through the latest 3.x release, and zsh. The supported public
onboarding path is a source checkout:

```bash
git clone https://github.com/LZong-tw/ai-runtime-kit.git
cd ai-runtime-kit
node src/airkit.mjs --help
npm install --global . --dry-run
# After reviewing and approving the global install:
npm install --global .
airkit --help
```

Do not claim a registry installation path unless a release has been verified as
published and visible. The commands below use the installed `airkit` binary. To
inspect the checkout without installing it, run
`node src/airkit.mjs <command>` from the repository root instead.

Inspect the runtime first:

```bash
airkit runtime check
```

If the check reports a missing or unsupported Claude Code or CCR version,
preview the pinned update, review the packages and backup paths it prints, and
only then deliberately run the write form:

```bash
airkit runtime update
# After reviewing the preview and approving the changes:
airkit runtime update --write
```

The public example expects an OpenAI-compatible provider. Its endpoint, model
IDs, and credential are placeholders, so it can validate rendering and
preflight but cannot complete a real provider request unchanged. When using a
locally customized public profile, expose the credential through an environment
variable such as:

```bash
export ANTHROPIC_AUTH_TOKEN="<provider-api-token>"
```

Never commit the real value. Preview the generated files, review every target
path, then approve the write explicitly:

```bash
airkit init --profile openai-compatible-example
# After reviewing the preview and approving the target paths:
airkit init --profile openai-compatible-example --write
source ~/.config/ai-runtime-kit/shell/openai-compatible-example.zsh
```

Verify the managed files and the actual launcher path, not only the install
command:

```bash
airkit doctor --profile openai-compatible-example
command -v airclaude
airclaude --doctor
airclaude
```

The last command is an interactive smoke test. Confirm that Claude starts, then
exit normally. If the public placeholders have not been replaced or credentials
are unavailable, report the provider session as blocked with the exact error;
do not claim onboarding is complete merely because `init --write` succeeded.
See [`docs/install.md`](docs/install.md) for updates, takeover recovery,
troubleshooting, and the complete fresh-machine workflow.

## Daily use

```bash
airclaude
airclaude pro
airclaude --dry-run
airclaude --doctor
airclaude -- --resume
```

## Server-tool compatibility

Compatibility is profile-scoped and native-first. These six families are the
current contract:

| Family | Profile mode | Effective behavior |
| --- | --- | --- |
| WebSearch (`webSearch`) | `native-first` | Native. The complete call/result wire cycle was verified with real Claude Code 2.1.211. |
| WebFetch (`webFetch`) | `native-first` | Anthropic fallback for now. Claude exposes the native client tool, but the zero-public-network loopback execution is blocked by Claude's domain-safety check, so AirKit does not claim the native cycle is verified. |
| Code Execution (`codeExecution`) | `anthropic-fallback` | The complete request uses the configured Anthropic route so container and continuation state stay intact. |
| Advisor (`advisor`) | `anthropic-fallback` | The complete request uses the configured Anthropic route; the removed approximation bridge is not used. |
| ToolSearch (`toolSearch`) | `bridge` | Safe bounded regex/BM25 requests use the local bridge. Unsafe, oversized, unsupported, or unknown requests fall back as a complete request. |
| MCP Connector (`mcpConnector`) | `anthropic-fallback` | Typed server-side connector requests use the configured Anthropic route; client-side MCP remains native. |

Fallback is per request, not a global model switch. A fallback request consumes
context, cache, and billing on the configured Anthropic route; the local
ToolSearch bridge does not make a model call. `fallback.provider` names a
profile provider whose type must be `anthropic_messages`; `fallback.model` is
the provider-local Claude model it exposes. AirKit validates that binding and
renders CCR's canonical `<managed-provider>/<model>` selector. Keep the model
bare (for example, `claude-sonnet`), use a dedicated `/v1/messages` provider,
and verify it end to end.

Legacy `webSearch.mode: "mcp"` is migration-only. It adds the older
`web_search` MCP tool explicitly and additively; a native-first profile does not
register a duplicate MCP tool. Migrate the source profile—not generated CCR
state—by moving Advisor `model`/`fallbackModel` fields into the single
`fallback` block, declaring all six family modes, and changing legacy
`webSearch.mode` from `mcp` to `native-first`. Then preview, write only after
review, and check the effective doctor states:

```bash
PROFILE=your-profile
airkit update --profile "$PROFILE"
airkit update --profile "$PROFILE" --write
airkit doctor --profile "$PROFILE"
npm run verify:tool-contract
npm run verify:ccr3:e2e
```

Doctor's `native` and `bridged` states describe verified routing policy;
`anthropic-fallback` means configured but not live-probed, and `unverified` is
reserved for the legacy MCP mode. A clean doctor result is not proof that a
billable fallback request succeeded.

This repository intentionally contains no private endpoints, no
credential-manager item references, and no secret values. Use
`profiles/catalog.json` as a starting point, then keep machine-specific runtime
state outside git.

`profiles/catalog.json` also includes a public model catalog seed for provider
and gateway mapping. It covers first-party providers, LiteLLM provider prefixes,
and Azure OpenAI deployment-name routing. Prices and limits are copied only from
public vendor documentation and include a `lastReviewed` date because model
catalogs change frequently.

The supported runtime is Node.js 22 or newer, Claude Code 2.1.208 or newer,
and Claude Code Router 3.0.4 through the latest 3.x release. `runtime update`
is preview-only; add `--write` to back up CCR state, install the pinned minimum
versions, and validate them.

`airclaude` is the daily entrypoint. It merges only AirKit-owned providers and
profiles into CCR 3 through its management API, preserves unrelated CCR state,
and then launches Claude Code directly. CCR is the gateway, not the launcher:
the child inherits the user's own `CLAUDE_CONFIG_DIR`, so sessions, statusline,
hooks, and `.claude.json` are shared with every other Claude launcher. What the
launch supplies is the gateway base URL, the profile's gateway key (resolved at
spawn, never through argv), and a `x-airkit-mode` header naming the routing
mode. Model variables inherited from the shell are cleared, because a stale one
would silently outrank the launch model.
AirKit starts a missing CCR service only with `ccr start --no-gateway`, reads
configuration before any mutation-capable operation, and saves managed state
with profile application disabled. If it detects an enabled global Codex
profile, a CCR takeover record, or CCR-managed blocks in Codex configuration,
launch stops and directs the user to the preview-first takeover repair flow.
`airclaude pro` applies the profile's stronger routing overlay before launch.
Managed CCR 3 profiles own the selected mode's default model and small/background
model. CCR 2's automatic `think`, `longContextThreshold`, and `webSearch` router
categories are not presented as active CCR 3 routes.
Legacy CCR 2 `transformers` are rejected instead of being silently discarded by
CCR 3 persistence; remove them or migrate the behavior to a native CCR 3 gateway
plugin.
Do not pass a JSON `--settings` override containing `apiKeyHelper`. An
`apiKeyHelper` outranks the gateway key the launch puts in the environment, so
it would silently authenticate the session as somebody else; AirKit rejects
launch arguments that define one.
Because the launched session reads the user's real settings, it also picks up
their statusline, hooks, and permission rules natively — AirKit forwards no
settings overlay of its own.
Claude Code permission rules still retain their native precedence: an explicit
`permissions.ask` rule overrides `--permission-mode auto`. Remove an obsolete
Ask rule with Claude Code's `/permissions` UI when auto mode should classify
that command; AirKit does not silently weaken explicit Ask or Deny policy.
Claude launches also receive reusable runtime lessons for recurring tool
mistakes, such as preserving durable lessons, recording repeatable corrections
without secrets, verifying Athena-style query context instead of assuming
defaults, and ruling out local shell wrappers before blaming remote services.

For LLM-guided installation or debugging, start with `CLAUDE.md`. The
management flow remains inspectable: dry run first, then `--write` after the
user confirms the target paths.

For current CCR 3 lifecycle, provider identity, statusline, model masking, and
route-selection guidance, see
[`docs/runtime-lessons.md`](docs/runtime-lessons.md).

## Public model catalog

The catalog is intentionally a seed, not a complete model database. Public
entries include enough metadata to drive task-mode routing:

- `providers[]` maps OpenAI, Anthropic, Google AI Studio, Mistral, DeepSeek,
  xAI, and Azure OpenAI model families.
- `gateways.litellm.providerModelPatterns` records LiteLLM provider prefixes
  such as `openai/<model>`, `anthropic/<model>`, `gemini/<model>`,
  `mistral/<model>`, `deepseek/<model>`, `xai/<model>`, and
  `azure/<deployment-name>`.
- `gateways.azure-openai` records Azure's deployment-name model routing. Keep
  real deployment names, regions, and Azure prices in a local private overlay.
- `routingPresets.coding-balanced` gives a starting point for mapping
  `default`, `background`, `think`, `longContext`, and `coding` work to model
  candidates.

## Troubleshooting

If CCR reports `Target adapter is not registered`, confirm that the provider has
an explicit CCR 3 protocol `type` and that the managed provider `id` and `name`
are identical. AirKit enforces this identity contract because CCR 3 resolves the
profile through its management layer before the generated gateway performs the
adapter lookup.

Legacy CCR 2 transformers are intentionally unsupported. Implement protocol
adaptation with CCR 3 provider types or a native gateway plugin.

If AirKit reports Codex takeover state, preview the affected paths and actions
with `airkit repair codex-takeover`. Apply only after review with
`airkit repair codex-takeover --write`; write mode creates rollback snapshots,
scopes hazardous Codex profiles to CCR, removes only exact CCR-managed Codex
blocks, and preserves unrelated CCR profiles and user-owned configuration.
