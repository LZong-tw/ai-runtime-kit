# ai-runtime-kit

Public-safe runtime profile templates for Claude Code Router and other AI client wrappers.

This repository intentionally contains no private endpoints, no credential-manager item references, and no secret values. Use `profiles/catalog.json` as a starting point, then keep machine-specific runtime state outside git.

```bash
airkit list
airkit init --profile openai-compatible-example
airkit init --profile openai-compatible-example --write
airkit render ccr --profile openai-compatible-example
airkit render shell --profile openai-compatible-example
```

For LLM-guided installation, start with `CLAUDE.md`. The normal flow is a dry
run first, then `--write` after the user confirms the target paths.
