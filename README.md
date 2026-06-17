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
airkit init --profile openai-compatible-example
airkit init --profile openai-compatible-example --write
airkit render ccr --profile openai-compatible-example
airkit render shell --profile openai-compatible-example
```

`airclaude` is the daily entrypoint. It automatically renders managed files,
syncs the CCR live config, starts CCR when needed, and launches Claude Code.
`airclaude pro` applies the profile's stronger routing overlay before launch.
Claude launches also receive reusable runtime lessons for recurring tool
mistakes, such as preserving durable lessons, recording repeatable corrections
without secrets, verifying Athena-style query context instead of assuming
defaults, and ruling out local shell wrappers before blaming remote services.

For LLM-guided installation or debugging, start with `CLAUDE.md`. The
management flow remains inspectable: dry run first, then `--write` after the
user confirms the target paths.

For hard-won operational lessons — CCR daemon reload/orphan handling, the
provider transformer (usage synthesis, reasoning stripping), statusline
integration, model masking, and route selection — see
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

### `API Error: Content block is not a text block` on a reasoning model

This is thrown by Claude Code's own response accumulator, not by the gateway: a
`text_delta` arrived for a content block that was opened as a non-text type
(`thinking` or `tool_use`). It shows up when you route Claude Code to an
OpenAI-format reasoning model (anything that streams `reasoning_content` /
`reasoning` on the delta) through CCR. CCR turns that reasoning into an Anthropic
`thinking` block and advances the content-block index, so a later text delta can
land on the thinking block and trip the accumulator.

The bundled `drop-reasoning` transformer prevents this by stripping
`reasoning_content` / `reasoning` from every response shape — JSON, Anthropic
SSE, and OpenAI SSE — before CCR converts the stream. If you write your own
transformer, strip reasoning on the streaming path too, not only the JSON path.

CCR loads transformers into memory at startup, so after updating a transformer
relaunch through `airclaude` (it reloads CCR when the rendered config or bundled
transformers change) rather than reusing the running daemon.

For more runtime traps and their fixes, see
[`docs/runtime-lessons.md`](docs/runtime-lessons.md).
