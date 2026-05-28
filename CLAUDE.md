# CLAUDE.md - ai-runtime-kit

## Agent Start Here

This repo is the public OSS for AI runtime profiles. The goal is a guided,
OpenCode-style install flow: inspect first, write only when the user passes
`--write`.

Run these from the repo root:

```bash
node src/airkit.mjs list
node src/airkit.mjs init --profile openai-compatible-example
node src/airkit.mjs init --profile openai-compatible-example --write
node src/airkit.mjs doctor
```

The dry run prints every file path it would create. Do not edit runtime files
directly unless the user explicitly asks for a manual repair.

## Product Boundary

- Keep runtime state out of git: Claude sessions, CCR daemon state, caches,
  login state, and secret values.
- Profiles may contain placeholders such as `$ANTHROPIC_AUTH_TOKEN`.
- Public output must not contain private endpoints, company names,
  credential-manager item references, or personal/company tokens.

## Release Rules

For public changes:

```bash
npm run check
git push
```

Do not add private endpoints, company names, credential-manager item references, or
personal/company tokens to this repository.
