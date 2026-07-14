# ai-runtime-kit

Public-safe runtime profile templates for Claude Code Router and other AI client wrappers.

This repository intentionally contains no private endpoints, no credential-manager item references, and no secret values. Use `profiles/catalog.json` as a starting point, then keep machine-specific runtime state outside git.

`profiles/catalog.json` also includes a public model catalog seed for provider
and gateway mapping. It covers first-party providers, LiteLLM provider prefixes,
and Azure OpenAI deployment-name routing. Prices and limits are copied only from
public vendor documentation and include a `lastReviewed` date because model
catalogs change frequently.

```bash
airclaude
airclaude pro
airclaude --dry-run
airclaude --doctor
airclaude --help
airkit list
airkit --help
airkit runtime check
airkit runtime update
airkit runtime update --write
airkit init --profile openai-compatible-example
airkit init --profile openai-compatible-example --write
airkit render ccr --profile openai-compatible-example
airkit render shell --profile openai-compatible-example
```

The supported runtime is Node.js 22 or newer, Claude Code 2.1.208 or newer,
and Claude Code Router 3.0.4 through the latest 3.x release. `runtime update`
is preview-only; add `--write` to back up CCR state, install the pinned minimum
versions, and validate them.

`airclaude` is the daily entrypoint. It merges only AirKit-owned providers and
profiles into CCR 3 through its management API, preserves unrelated CCR state,
and launches `ccr <managed-profile> cli -- ...`.
`airclaude pro` applies the profile's stronger routing overlay before launch.
Managed CCR 3 profiles own the selected mode's default model and small/background
model. CCR 2's automatic `think`, `longContextThreshold`, and `webSearch` router
categories are not presented as active CCR 3 routes.
Legacy CCR 2 `transformers` are rejected instead of being silently discarded by
CCR 3 persistence; remove them or migrate the behavior to a native CCR 3 gateway
plugin.
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
