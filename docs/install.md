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
node src/airkit.mjs runtime check
node src/airkit.mjs --help
node src/airkit.mjs airclaude --help
node src/airkit.mjs list
command -v ccr
command -v claude
command -v zsh
```

Expected repo-owned checks:

- `runtime check` requires Node.js 22+, Claude Code 2.1.208+, and CCR 3.0.4
  through the latest 3.x release.
- `node src/airkit.mjs list` prints the available profile names.
- `command -v ccr` finds the CCR command needed by CCR-backed profiles.
- `command -v claude` finds the Claude Code command used by `airclaude`.
- `command -v zsh` finds the shell used to source-check generated snippets.

If a required runtime is missing or stale, preview the explicit package update:

```bash
node src/airkit.mjs runtime update
```

After reviewing it, `runtime update --write` backs up CCR state, installs the
pinned minimum Claude Code and CCR versions, and validates the result. It does
not own user login state or secret provisioning.

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

After it is sourced, profile wrappers are one-command entry points. The launch
path merges only the AirKit-owned providers and mode profiles through CCR 3's
management API, preserving unrelated providers, profiles, and routing rules.
It then spawns Claude Code directly, pointed at the CCR gateway; there is no CCR
2 `restart`, `activate`, or live `config.json` overwrite path, and no CCR
launcher wrapper in between. The child keeps the `CLAUDE_CONFIG_DIR` it
inherited, so its sessions live in the user's own Claude home alongside every
other launcher's.

If the CCR management service is missing, AirKit starts it with
`ccr start --no-gateway`. Its first RPC reads the live configuration; managed
updates use `saveConfig(..., { applyProfile: false })`, so saving does not apply
or reconcile a global profile. Gateway startup happens only after takeover and
runtime checks pass.

Each managed profile sets the mode's default model and small/background model.
CCR 2's automatic `think`, `longContextThreshold`, and `webSearch` categories
are outside this hard-cut contract; use an explicit AirClaude mode when a
stronger default route is required.
Legacy CCR 2 `transformers` are rejected before save because CCR 3 does not
persist that contract. Remove them or replace them with a native CCR 3 gateway
plugin before launching the profile.

For airclaude launcher wrappers, the wrapper also sets function-local exported
variables for the same launch environment the `node airkit.mjs` path applies (e.g.
`POWERLEVEL9K_INSTANT_PROMPT=off`, which keeps the user's P10k zsh snapshot from
spamming command-not-found in Claude Code's non-interactive shells), so a session
started through the wrapper does not diverge from the node path and does not leave
profile variables behind in the caller shell. Prefer starting and resuming through
the wrapper (`<wrapper> --resume`, `<wrapper> --continue`).

The launch authenticates with the profile's CCR gateway key, exported into the
child's environment at spawn time. Environment variables are inherited, so the
session's own Bash tools can read that key too — an accepted tradeoff for a key
that only opens the local gateway; upstream provider credentials, by contrast,
are cleared from the child by placeholder name. An `apiKeyHelper` outranks the
gateway key, so do not add
`--settings '{"apiKeyHelper":""}'` or any other JSON `--settings` value that
defines `apiKeyHelper`; AirKit rejects that override in profile args and in
passthrough args alike, and it also refuses to launch while the inherited
Claude home's `settings.json` defines an `apiKeyHelper` (remove it yourself;
AirKit never edits that file). Other Claude arguments remain available through
the normal passthrough after `--`.

Because every launcher now shares one Claude home, `claude --resume` can pick up
a session that started under `airclaude` and vice versa. The backend follows the
launcher, not the transcript: resuming an `airclaude` session with plain `claude`
continues it on plain Claude's own credentials and routing. The shared home is
whatever the caller's environment resolves — a shell that exports its own
`CLAUDE_CONFIG_DIR` keeps that home for `airclaude` exactly as it would for
plain `claude`; a profile, however, may not set `CLAUDE_CONFIG_DIR` or `HOME`
in `launch.env` (AirKit rejects it), because a per-profile home would split
sessions by mode again.

## Configure Server-Tool Compatibility

Compatibility is opt-in in the source profile's `ccr.plugins` array. Generated
CCR state is an output, not an editable source. The current six-family contract
is:

| Family | Profile mode | Effective behavior |
| --- | --- | --- |
| WebSearch (`webSearch`) | `native-first` | Native. The complete call/result wire cycle was verified with real Claude Code 2.1.211. |
| WebFetch (`webFetch`) | `native-first` | Anthropic fallback for now. Claude exposes the native client tool, but the zero-public-network loopback execution is blocked by Claude's domain-safety check, so AirKit does not claim the native cycle is verified. |
| Code Execution (`codeExecution`) | `anthropic-fallback` | The complete request uses the configured Anthropic route so container and continuation state stay intact. |
| Advisor (`advisor`) | `anthropic-fallback` | The complete request uses the configured Anthropic route; the removed approximation bridge is not used. |
| ToolSearch (`toolSearch`) | `bridge` | Safe bounded regex/BM25 requests use the local bridge. Unsafe, oversized, unsupported, or unknown requests fall back as a complete request. |
| MCP Connector (`mcpConnector`) | `anthropic-fallback` | Typed server-side connector requests use the configured Anthropic route; client-side MCP remains native. |

The profile must declare a dedicated Anthropic Messages provider, a single
fallback bound to its source name, and all six modes, for example:

```json
{
  "ccr": {
    "Providers": [{
      "name": "your-anthropic-provider",
      "type": "anthropic_messages",
      "api_base_url": "https://gateway.example/v1/messages",
      "api_key": "$ANTHROPIC_AUTH_TOKEN",
      "models": ["claude-sonnet"]
    }],
    "plugins": [{
      "id": "airkit-compatibility",
      "module": "@lzong/ai-runtime-kit/compatibility-plugin",
      "config": {
        "fallback": {
          "provider": "your-anthropic-provider",
          "model": "claude-sonnet",
          "maxContinuationTurns": 8
        },
        "advisor": { "mode": "anthropic-fallback" },
        "codeExecution": { "mode": "anthropic-fallback" },
        "mcpConnector": { "mode": "anthropic-fallback" },
        "toolSearch": { "mode": "bridge" },
        "webFetch": { "mode": "native-first" },
        "webSearch": { "mode": "native-first" }
      }
    }]
  }
}
```

`fallback.provider` is the source provider name, not a protocol label or a
managed CCR ID. AirKit requires that provider to use `anthropic_messages` and
to expose the bare Claude identifier in `fallback.model`. Fallback applies to
one complete request and incurs that Anthropic route's context, cache, and
billing. Safe ToolSearch bridge requests stay local and make no model call.

To migrate an older source profile, remove Advisor `model`, `fallbackModel`,
and `mode: "bridge"`; put the model in the generic `fallback` block; add every
missing family entry; and change `webSearch.mode: "mcp"` to `native-first`.
Keep `mcp` only when the user explicitly needs the legacy `web_search` MCP
migration tool. Native-first renders no duplicate MCP registration.

Preview and verify the rendered migration with these commands:

```bash
PROFILE=your-profile
node src/airkit.mjs update --profile "$PROFILE"
# After reviewing and approving the paths:
node src/airkit.mjs update --profile "$PROFILE" --write
node src/airkit.mjs doctor --profile "$PROFILE"
npm run verify:tool-contract
npm run verify:ccr3:e2e
```

Doctor reports `native` and `bridged` for verified policies,
`anthropic-fallback` for configured fallback that has not been live-probed, and
`unverified` for the legacy MCP route. It does not claim provider success or
fallback billing evidence without a real request.

The 1M context window is **not** controlled by an env var (there is no such env
var in Claude Code — `ANTHROPIC_1M_CONTEXT` is a no-op). Claude Code enables 1M
only when the resolved model string ends in the literal `[1m]` suffix, so the
masked context window is selected per launch via the profile's
`launch.claudeModel` (`claude-sonnet-4-6[1m]`). AirKit passes that value only as
Claude Code's `--model` argument; it never writes a model into Claude settings
or transcripts. Claude Code remains responsible for `/model` and its normal
model-choice persistence. The suffix is stripped back to `claude-sonnet-4-6`
for the on-wire API id, so the gateway never sees it.

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

## Repair Codex Takeover State

AirKit fails closed before launch when it finds an enabled global Codex profile
targeting Codex configuration, a CCR takeover record, or exact CCR-managed
blocks in a Codex config file. Preview the repair without starting CCR or
writing files:

```bash
node src/airkit.mjs repair codex-takeover
```

Review every affected path and action. To apply the repair:

```bash
node src/airkit.mjs repair codex-takeover --write
```

Write mode inventories live and recorded targets, creates exclusive rollback
snapshots before the first mutation-capable save, scopes hazardous Codex
profiles to `scope: "ccr"` with `showAllSessions: true`, and removes only exact
CCR-managed Codex blocks. It preserves unrelated profiles and the latest
user-owned bytes. If a concurrent writer wins a repair race, AirKit does not
overwrite it and reports the retained conflict snapshot.

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

## Removing A Profile

Deleting a profile from the catalog does not by itself remove what it wrote
into CCR. Its Router rules, providers, and CCR agent profiles are namespaced by
profile name (`airkit-<profile>-…`, `airkit-provider-<profile>-…`), and every
managed merge preserves ids outside the profile being prepared.

Leftover rules are not harmless. CCR evaluates Router rules in order and takes
the first match, so a rule left behind by an older build — for example one
matching the bare prefix `claude-` — outranks the correctly scoped
`claude-opus-` and `claude-sonnet-` rules that follow it, and the routes that
appear correct in the config never run.

The next launch removes managed state whose profile is present in neither the
loaded catalog nor `<configDir>/ccr`, and prints what it removed:

```text
airkit: removed CCR state left by profiles no longer in the catalog:
  - router rule airkit-old-profile-route-default
  - provider airkit-provider-old-profile-gateway
```

Both records are consulted because one CCR install can be driven by more than
one catalog. A profile that is still installed keeps its state even when the
catalog in use does not declare it, so removing a profile means removing its
generated `<configDir>/ccr/<profile>.json` as well. Providers, rules, and
profiles that are not AirKit-managed are never touched.

## LLM Agent Workflow

When guiding a user, keep the agent's write boundary clear:

1. Ask the user which profile to install if it is not already specified.
2. Run `runtime check`; when needed, preview `runtime update` before asking for
   approval to rerun it with `--write`.
3. Run `node src/airkit.mjs init --profile <profile>` and show the dry-run paths.
4. Ask for confirmation before adding `--write`.
5. Run `node src/airkit.mjs init --profile <profile> --write` only after
   confirmation.
6. Tell the user which `source .../<profile>.zsh` command to run, or run it only
   in the current shell when that is the requested scope.
7. Have the user launch the generated wrapper; do not ask them to manually copy
   CCR config files.
8. If launch reports Codex takeover state, preview `repair codex-takeover` and
   review its paths before considering `--write`.
9. Run `node src/airkit.mjs doctor --profile <profile>` and use its output as
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

`Codex takeover detected`

: Run `node src/airkit.mjs repair codex-takeover` first. Review the affected
  paths, then rerun with `--write` only when the repair is intended. Do not
  manually delete the takeover record or replace Codex configuration with a
  stale backup.

Secrets or login failures after the files render cleanly

: Treat them as local runtime/authentication issues. Secret values, CLI login
  state, CCR daemon state, caches, and AI client sessions are intentionally
  outside the repo.
