# ai-runtime-kit

Public-safe runtime profile templates for Claude Code Router and other AI client wrappers.

This repository intentionally contains no private endpoints, no credential-manager item references, and no secret values. Use `profiles/catalog.json` as a starting point, then keep machine-specific runtime state outside git.

`profiles/catalog.json` also includes a public model catalog seed for provider
and gateway mapping. It covers first-party providers, LiteLLM provider prefixes,
and Azure OpenAI deployment-name routing. Prices and limits are copied only from
public vendor documentation and include a `lastReviewed` date because model
catalogs change frequently.

```bash
airkit list
airkit init --profile openai-compatible-example
airkit init --profile openai-compatible-example --write
airkit render ccr --profile openai-compatible-example
airkit render shell --profile openai-compatible-example
```

For LLM-guided installation, start with `CLAUDE.md`. The normal flow is a dry
run first, then `--write` after the user confirms the target paths.

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
