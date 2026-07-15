# CLAUDE.md - ai-runtime-kit

## Agent Start Here

This repo is the public OSS for AI runtime profiles. Guide onboarding as an
inspect, preview, approve, write, and verify sequence. A successful package
install or `init --write` is not completion; completion is a usable launcher or
an exact blocked-state report.

For a package install use the `airkit` binary. For a source checkout run
`node src/airkit.mjs` from the repo root. The commands below use the source form
so the code being inspected is the code being executed.

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
node src/airkit.mjs doctor --profile openai-compatible-example
```

## Installation Contract

1. Inspect `node --version`, `command -v claude`, `command -v ccr`,
   `command -v zsh`, `runtime check`, `list`, and the relevant CLI help before
   proposing changes. If using the package entrypoint, verify `command -v
   airkit` too.
2. If a package install or checkout is needed, state exactly what path or global
   package will change and obtain approval before running it.
3. When runtime requirements fail, run `runtime update` without `--write`.
   Show the user the packages, versions, and CCR backup paths in the preview;
   obtain explicit approval before `runtime update --write`.
4. Run `init --profile openai-compatible-example` without `--write`. Show every
   generated target path, then obtain explicit approval before
   `init --profile openai-compatible-example --write`.
5. Source the generated snippet only in the verification shell. Tell the user
   which source line they can add for persistence, but do not edit a shell
   startup file for them.
6. Run `doctor --profile openai-compatible-example`, `command -v airclaude`,
   and `airclaude --doctor`. Where interactive execution is available, run
   `airclaude` and confirm that Claude reaches an interactive session.
7. Report the outcome under four explicit states: previewed, written, verified,
   and blocked. Include the exact failed command and error for every blocker.

The public example contains placeholder provider endpoint, model, and
credential values. Keep credentials in generic environment variables such as
`$ANTHROPIC_AUTH_TOKEN`, never in repository or generated files. If a real
provider configuration is unavailable, installation may be verified through
preflight, but the interactive provider session remains blocked and must be
reported that way.

Every state-changing command requires a separate approval after its preview.
This includes `runtime update --write`, `repair codex-takeover --write`, profile
`init --write`, profile `update --write`, package installation, shell
persistence, and removal. Approval for one operation does not authorize the
next.

Never directly edit user shell files, credentials, Claude or Codex settings,
CCR SQLite state, generated AirKit files, permission policy, or model defaults.
Never bypass a failed takeover guard or clear or replace `apiKeyHelper`.

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

Use [`docs/install.md`](docs/install.md) for the full prerequisite, update,
takeover-recovery, shell-loading, troubleshooting, and removal guidance. When a
step fails, follow that recovery path and preserve the exact command output;
do not improvise direct user-state edits.

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
