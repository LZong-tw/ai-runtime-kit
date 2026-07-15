# CLAUDE.md - ai-runtime-kit

## Agent Start Here

This repo is the public OSS for AI runtime profiles. The goal is a guided,
OpenCode-style install flow: inspect first, write only when the user passes
`--write`.

Run these from the repo root:

```bash
node src/airkit.mjs --help
node src/airkit.mjs airclaude --help
node src/airkit.mjs airclaude --dry-run
node src/airkit.mjs airclaude pro --dry-run
node src/airkit.mjs list
node src/airkit.mjs runtime check
node src/airkit.mjs runtime update
node src/airkit.mjs repair codex-takeover
node src/airkit.mjs init --profile openai-compatible-example
node src/airkit.mjs init --profile openai-compatible-example --write
node src/airkit.mjs doctor
```

The dry run prints every file path it would create. Do not edit runtime files
directly unless the user explicitly asks for a manual repair.

CCR-backed launch is a CCR 3-only path (`>=3.0.4 <4`). AirKit may start the
management service with `ccr start --no-gateway`, but it reads live
configuration before later RPCs or filesystem writes and persists managed
configuration with profile application disabled. Never add CCR 2
`restart`/`activate` synchronization or a live `config.json` overwrite path.

If preflight reports Codex takeover state, run the read-only
`repair codex-takeover` preview first. Use `--write` only after reviewing the
affected paths; do not bypass the guard or manually clear the user's Codex
configuration. CCR-backed launch arguments must not override the CCR-managed
`apiKeyHelper` through Claude's JSON `--settings` argument.

## Public Model Catalog

- Public provider/model facts live in `profiles/catalog.json` under
  `modelCatalog`.
- Use only vendor documentation or gateway documentation that can be publicly
  verified.
- Keep `modelCatalog.lastReviewed` current whenever provider prices, context
  windows, model IDs, LiteLLM prefixes, or Azure routing metadata change.
- Azure entries should describe public base-model families and LiteLLM routing
  shape only. Do not commit tenant-specific deployment names, regions, quotas,
  or negotiated pricing.

## Product Boundary

- Keep runtime state out of git: Claude sessions, CCR daemon state, caches,
  login state, and secret values.
- Profiles may contain placeholders such as `$ANTHROPIC_AUTH_TOKEN`.
- Public output must not contain private endpoints, company names,
  credential-manager item references, or personal/company tokens.

## Release Rules

For public changes:

```bash
npm run verify
git push
```

Do not add private endpoints, company names, credential-manager item references, or
personal/company tokens to this repository.
