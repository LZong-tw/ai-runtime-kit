# Fresh-Machine Install

This page is for a human or LLM agent wiring up `ai-runtime-kit` on a fresh
machine. The repo is the source of truth for public profile templates and
install planning only. Runtime state, caches, sessions, daemon state, login
state, and secret values live outside this repo and must not be copied into git.

## Ground Rules

- Inspect first. The install command is a dry run unless `--write` is present.
- Let `airkit` render managed files. Do not hand-write runtime files unless the
  user explicitly asks for a manual repair.
- Keep secret values out of the repo and out of documentation. Environment
  placeholders are acceptable; real token values are not.
- Verify tools with command checks instead of assuming how they were installed.
- Run `doctor --profile` after writing files and after any manual repair.

## Prerequisites To Verify

Run these from the repo root:

```bash
node --version
npm --version
node src/airkit.mjs --help
node src/airkit.mjs airclaude --help
node src/airkit.mjs list
command -v ccr
command -v claude
command -v zsh
```

Expected repo-owned checks:

- `node src/airkit.mjs list` prints the available profile names.
- `command -v ccr` finds the CCR command needed by CCR-backed profiles.
- `command -v claude` finds the Claude Code command used by `airclaude`.
- `command -v zsh` finds the shell used to source-check generated snippets.

If a command is missing, install or authenticate that tool through the user's
normal process, then rerun the verification command. This repo does not own
system package installation, user login state, or secret provisioning.

## Dry Run First

Pick the profile the user wants to wire up. For the default public profile:

```bash
node src/airkit.mjs init --profile openai-compatible-example
```

Without `--write`, this prints the files that would be created and the next
steps. It should not create or modify runtime files.

Use the dry-run output to explain the plan:

- the CCR config path under the user's config directory
- the shell snippet path under the user's config directory
- the exact command to source the shell snippet
- that rerunning with `--write` is the only normal write step

## Write Managed Runtime Files

Only write after the user confirms the dry-run plan:

```bash
node src/airkit.mjs init --profile openai-compatible-example --write
```

By default, generated files are written under:

```text
~/.config/ai-runtime-kit/ccr/<profile>.json
~/.config/ai-runtime-kit/shell/<profile>.zsh
```

If the target files already exist, the command fails instead of overwriting.
Use `--force` only when the user has confirmed that replacing the existing
managed files is intended.

## Source The Shell Snippet

Source the generated snippet once in the active shell:

```bash
source ~/.config/ai-runtime-kit/shell/openai-compatible-example.zsh
```

For a persistent setup, add the same source line to the user's normal shell
startup file. The generated snippet contains environment placeholders, not
secret values.

After it is sourced, profile wrappers are one-command entry points. The wrapper
first syncs the rendered CCR config into CCR's live `config.json`, then
delegates to the configured client command.

For airclaude launcher wrappers, the wrapper also exports the same launch
environment the `node airkit.mjs` launch path applies (e.g.
`POWERLEVEL9K_INSTANT_PROMPT=off`, which keeps the user's P10k zsh snapshot from
spamming command-not-found in Claude Code's non-interactive shells), so a session
started through the wrapper does not diverge from the node path. Prefer starting
and resuming through the wrapper (`<wrapper> --resume`, `<wrapper> --continue`).

The 1M context window is **not** controlled by an env var (there is no such env
var in Claude Code — `ANTHROPIC_1M_CONTEXT` is a no-op). Claude Code enables 1M
only when the resolved model string ends in the literal `[1m]` suffix, so the
masked context window is set via the profile's `launch.restore.model`
(`claude-sonnet-4-6[1m]`); the suffix is stripped back to `claude-sonnet-4-6` for
the on-wire API id, so the gateway never sees it.

## Run Doctor

After writing and sourcing, run:

```bash
node src/airkit.mjs doctor --profile openai-compatible-example
```

`doctor --profile` checks that:

- the rendered CCR config exists and matches the catalog
- the rendered shell snippet exists and matches the catalog
- `ccr` is available on `PATH`
- the shell snippet can be sourced by `zsh`

If `doctor` reports stale or missing rendered files, rerun the dry run, confirm
the paths, and use the update flow below. If it reports missing tools or shell
source failures, fix the local runtime environment and rerun `doctor --profile`.

## Update Managed Runtime Files

Use `update` when managed files already exist and may be stale:

```bash
node src/airkit.mjs update --profile openai-compatible-example
```

The dry run writes preview files to a temporary directory, reports the target
paths, and labels each target as `missing`, `current`, or `stale`. It does not
modify the installed files.

After reviewing the preview output, write the current rendered files:

```bash
node src/airkit.mjs update --profile openai-compatible-example --write
node src/airkit.mjs doctor --profile openai-compatible-example
```

## LLM Agent Workflow

When guiding a user, keep the agent's write boundary clear:

1. Ask the user which profile to install if it is not already specified.
2. Run prerequisite verification commands and report missing tools without
   guessing install commands.
3. Run `node src/airkit.mjs init --profile <profile>` and show the dry-run paths.
4. Ask for confirmation before adding `--write`.
5. Run `node src/airkit.mjs init --profile <profile> --write` only after
   confirmation.
6. Tell the user which `source .../<profile>.zsh` command to run, or run it only
   in the current shell when that is the requested scope.
7. Have the user launch the generated wrapper; do not ask them to manually copy
   CCR config files.
8. Run `node src/airkit.mjs doctor --profile <profile>` and use its output as
   the final health check.

Do not write runtime files directly from the LLM agent as a shortcut around
`airkit init --write`. Do not ask the user to paste real token values into the
repo, chat, or docs.

## Troubleshooting

`missing command: ccr`

: Verify with `command -v ccr`. Install or expose CCR on `PATH` through the
  user's normal process, then rerun `node src/airkit.mjs doctor --profile
  <profile>`.

`missing CCR config` or `missing shell snippet`

: The managed files have not been written at the expected paths. Rerun the dry
  run, confirm the paths, then rerun `init --profile <profile> --write`.

`stale CCR config` or `stale shell snippet`

: The managed files differ from the current catalog. Run `update --profile
  <profile>` first, inspect the preview output, then rerun with `--write` only
  after the user confirms replacement is intended.

`shell snippet is not sourceable`

: Run `command -v zsh`, inspect the generated snippet path reported by
  `doctor`, and source it in a clean shell. After fixing the local shell
  environment, rerun `doctor --profile`.

Secrets or login failures after the files render cleanly

: Treat them as local runtime/authentication issues. Secret values, CLI login
  state, CCR daemon state, caches, and AI client sessions are intentionally
  outside the repo.
