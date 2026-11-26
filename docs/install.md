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

- `runtime check` requires Node.js 22+, Claude Code 2.1.208+, and CCR 3.0.18
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
`ccr start --no-gateway` — unless launchd already supervises the daemon under
`com.airkit.ccr-daemon`, in which case it starts that job with
`launchctl kickstart` instead. Starting CCR beside a supervisor leaves two
management services running: both answer the same RPCs, only one holds the
port, and a launch can then write configuration to one and route through the
other. For the same reason `--restart-stale` restarts a supervised daemon with
`launchctl kickstart -k` rather than `ccr stop && ccr start`, and `doctor`
warns when it finds more than one service, naming which pid the supervisor
owns. Its first RPC reads the live configuration; managed
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

Compatibility is opt-in in the source profile's `ccr.plugins` array. That
declaration is migration input: it describes the six-family policy AirKit owns
at launch, not a public CCR gateway route to retain. Generated CCR state is an
output, not an editable source. The current six-family contract is:

| Family | Profile mode | Effective behavior |
| --- | --- | --- |
| WebSearch (`webSearch`) | `native-first` | Native. The complete call/result wire cycle was verified with real Claude Code 2.1.211. |
| WebFetch (`webFetch`) | `native-first` | The client definition stays on the selected executor route; AirKit does not claim native execution is verified. Explicit `anthropic-fallback` mode uses the complete Anthropic route. |
| Code Execution (`codeExecution`) | `anthropic-fallback` | The complete request uses the configured Anthropic route so container and continuation state stay intact. |
| Advisor (`advisor`) | `bridge` or `anthropic-fallback` | Bridge mode simulates Claude's Advisor tool with a bounded transcript review through the configured Anthropic route and resumes with a canonical `advisor_tool_result`; fallback mode strips the definition by default. |
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
      "module": "@untionglim/ai-runtime-kit/compatibility-plugin",
      "config": {
        "fallback": {
          "provider": "your-anthropic-provider",
          "model": "claude-sonnet",
          "maxContinuationTurns": 8
        },
        "advisor": { "mode": "bridge" },
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

For a compatible launch, AirKit removes the legacy public
`airkit-compatibility` CCR plugin route and starts a child-only loopback
adapter. The adapter owns `POST /v1/messages` and the compatibility MCP
endpoint, applies the declared policy, then sends provider-qualified requests
through CCR's public gateway. CCR therefore records the request through its
normal request recorder and its native UI can show it. ToolSearch executors and
fallback attempts are distinct upstream requests, so one Claude turn can
legitimately appear as more than one UI row. AirKit does not read or write CCR
SQLite state and does not use private CCR APIs for this observability.

### Compatibility request evidence

The adapter returns `x-airkit-request-id` on Messages responses and
`error.request_id` on contained forwarding failures. Local diagnostic rows live
in `${XDG_STATE_HOME:-$HOME/.local/state}/airkit/compat-requests.sqlite`
(directory mode 0700, database mode 0600). Errors, including whole-request
fallback rejections, are retained for 30 days; successes for 7 days. Pruning
runs at open and at most hourly while recording. Storage failures never block
forwarding. Error evidence includes bounded (64 KiB), credential-redacted
upstream bodies and filtered headers; treat the database as private diagnostics.
The `[airkit-fallback]` line in `~/.claude-code-router/logs/airkit-compat.log`
includes the same request ID when route logging is on.

```bash
DB="${XDG_STATE_HOME:-$HOME/.local/state}/airkit/compat-requests.sqlite"
sqlite3 "$DB" "SELECT request_id, client_status, upstream_status, error_json
  FROM compat_requests WHERE kind IN ('error', 'fallback_error')
  ORDER BY at DESC LIMIT 20;"
# Lower median (p50-ish), milliseconds, per outbound model:
sqlite3 "$DB" "WITH ranked AS (
  SELECT out_model, total_ms,
    row_number() OVER (PARTITION BY out_model ORDER BY total_ms) AS n,
    count(*) OVER (PARTITION BY out_model) AS cnt
  FROM compat_requests WHERE total_ms IS NOT NULL
) SELECT out_model, total_ms AS p50_ms FROM ranked WHERE n = (cnt + 1) / 2;"
```

Timings are milliseconds from handler entry to upstream dispatch, upstream
headers, and downstream termination. `transform_ms` covers parsing and rewrites
before dispatch, excluding the body read. Bridge requests can make multiple
upstream calls; first-byte timing refers to the first response headers.

### Prompt-cache prefix drift

Provider prompt caches only reuse a request's tools, system prompt and earlier
messages when the next request repeats them exactly. Claude Code sends an
append-only history, so anything AirKit rewrites inconsistently between turns
(for example, moving hook output into the system prompt) silently costs a
cache miss on every later turn. The adapter checks this on every request.

For each conversation thread (session id, request class when Claude Code sends
it, and first message), the adapter remembers fingerprints of the previous
request as it arrived and as it was sent upstream, with `cache_control` ignored
and a message sent as a bare string treated the same as one text block (Claude
Code flips between the two every turn). It compares tools, then system, then
messages, in the order providers render them, then the request parameters the
provider keys its message cache on (`thinking`, `tool_choice`, effort,
`speed`), and stores the verdict on the request's `compat_requests` row:

| Column | Meaning |
| --- | --- |
| `prefix_status` | `baseline` (first request of a thread), `stable`, `drift`, `allowed`, or `reset`. NULL when there is no verdict: no session id, nothing sent upstream, or an auto-mode classifier request. |
| `prefix_origin` | `airkit` when only the outbound request changed: a regression in AirKit. `upstream` when the inbound request already changed in that field (Claude Code, or pxpipe in front of the adapter). In messages, a break earlier than any outbound position the inbound change could map to is still `airkit`. |
| `prefix_field`, `prefix_index` | First diverging field (`tools`, `system`, `messages`, `params`) and the index inside it, in the outbound request. `prefix_inbound_index` is the inbound index of the inbound break, if any. |
| `prefix_reason` | `deferred_tool_activation` for `allowed`: a deferred tool loaded once, which changes the tool list by design. `messages_shrunk` or `model_changed` for `reset`. |
| `prefix_messages` | Outbound message count. |
| `cache_read_tokens`, `cache_creation_tokens`, `cache_miss_tokens` | Prompt-cache counters from the response, when the provider reports them. |

Compaction starts a new thread (its first message changes), so it shows up as
a `baseline`, not drift. Only the first upstream call of a turn is compared;
the transport fallback, executor continuations and Advisor consults are
different prompts by design. Threads that share a session, request class and
first message (parallel subagents given the same prompt, forked subagents)
share one slot, so their interleaving counts as upstream drift; it never counts
as AirKit drift. Fingerprints are truncated hashes held in memory by the
gateway plugin (at most 256 threads, 24 hours each; a CCR restart starts every
thread again as `baseline`). Image and document payloads are fingerprinted by
length and sampled bytes to keep the check cheap. The database holds field
names, indices and counts only, never prompt content. The check runs after
the response finishes and never fails a request. CCR and the provider's
Anthropic-to-OpenAI conversion run after the adapter and are not covered.

```bash
DB="${XDG_STATE_HOME:-$HOME/.local/state}/airkit/compat-requests.sqlite"
# Per model: AirKit-introduced drift (should be 0), upstream drift, and cache hit rate.
sqlite3 -header -column "$DB" "SELECT out_model, count(*) AS requests,
    sum(prefix_status = 'drift' AND prefix_origin = 'airkit') AS airkit_drift,
    sum(prefix_status = 'drift' AND prefix_origin = 'upstream') AS upstream_drift,
    sum(prefix_status = 'allowed') AS allowed, sum(prefix_status = 'reset') AS resets,
    round(1.0 * sum(cache_read_tokens) / nullif(sum(cache_read_tokens
      + coalesce(cache_miss_tokens, 0) + coalesce(cache_creation_tokens, 0)), 0), 3) AS hit_rate
  FROM compat_requests WHERE at > (strftime('%s', 'now') - 7 * 86400) * 1000
  GROUP BY out_model ORDER BY airkit_drift DESC, requests DESC;"
# Where AirKit broke the prefix:
sqlite3 "$DB" "SELECT datetime(at / 1000, 'unixepoch'), out_model, path,
    prefix_field, prefix_index, prefix_messages
  FROM compat_requests WHERE prefix_status = 'drift' AND prefix_origin = 'airkit'
  ORDER BY at DESC LIMIT 20;"
```

With route logging on, the `[airkit-request]` line carries the same verdict
as `prefixDrift`.

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

The 1M context capability is **not** controlled by `ANTHROPIC_1M_CONTEXT` (that
variable is a no-op). Claude Code enables its 1M mode when the resolved model
string ends in `[1m]`; AirKit adds that marker only when the selected route's
catalog context is at least 1M. For any other positive context size, AirKit
passes the exact catalog value through `CLAUDE_CODE_MAX_CONTEXT_TOKENS`, so a
500K or 750K provider is neither treated as 200K nor allowed to grow to 1M.
These routes use a dedicated non-`claude-*` launch id (`airkit-mode`) because
Claude Code only honors that explicit ceiling for unrecognized ids that do not
start with `claude-`.
`AIRCLAUDE_STATUSLINE_CONTEXT_WINDOW` and each
`AIRCLAUDE_ROUTE_*_CONTEXT_WINDOW` carry the same metadata for statusline and
diagnostics. The launch model remains a Claude-Code-local id; its `[1m]`
marker is stripped from the on-wire API id.

The launch ceiling is computed from the selected mode's default route. By
default AirKit starts Claude Code with `--autocompact auto`, so Claude Code
resolves its native compaction threshold from the active model and refreshes it
when `/model` changes. AirKit clears inherited static compaction overrides so a
stale 250K shell setting cannot freeze a new route. Set
`launch.context.autoCompactWindow` or `autoCompactPercentage` only when a
profile intentionally wants a fixed override; that explicit setting takes
precedence over native adaptive mode.

## Run Doctor

After writing and sourcing, run:

```bash
node src/airkit.mjs doctor --profile openai-compatible-example
```

`doctor --profile` checks that:

- the rendered CCR config exists and matches the catalog
- the rendered shell snippet exists and matches the catalog
- only one CCR management service is running
- `ccr` is available on `PATH`
- the shell snippet can be sourced by `zsh`

If `doctor` reports stale or missing rendered files, rerun the dry run, confirm
the paths, and use the update flow below. If it reports missing tools or shell
source failures, fix the local runtime environment and rerun `doctor --profile`.

## Use A ChatGPT Subscription Through Codex

A profile with a Codex provider (see `docs/profile-schema.md`, "Codex ChatGPT
subscription provider") routes requests to `chatgpt.com` with the ChatGPT
credentials the Codex CLI stores. Those are your personal subscription
credentials; usage counts against that subscription's Codex quota.

1. Log in once with the Codex CLI: `codex login` (choose ChatGPT). Confirm
   `~/.codex/auth.json` (or `$CODEX_HOME/auth.json`) exists.
2. Write the profile as usual (`init --profile <name> --write`, or `update`
   for an installed one), then run `doctor --profile <name>` and check that
   the `codexAuth` entry is `ok`.
3. Launch with the profile's launcher.

AirKit never refreshes that login. When the access token is missing or
expired, the request fails with an error that says "run `codex` once so
the Codex CLI refreshes ~/.codex/auth.json". When ChatGPT itself rejects the
token with a 401, that hint is appended only if the profile runs the
compatibility middleware; otherwise you see the upstream 401 as is, and the
fix is the same. Start `codex` once and quit so it
refreshes the login, then retry. Nothing in AirKit needs restarting: the hook
rereads the file when its mtime changes. Quota exhaustion is reported as the upstream
error; AirKit does not fall back to another provider.

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

## Repair Codex Companion Transcript Progress

Some Codex Companion versions write every dynamic tool start/completion event to
stderr. Claude Code can retain that foreground progress in its JSONL transcript,
which makes long sessions expensive to resume. `airclaude` blocks only the
reviewed, known-vulnerable implementation and tells you to preview the repair:

```bash
node src/airkit.mjs repair codex-transcript
```

Apply it only after reviewing the affected paths:

```bash
node src/airkit.mjs repair codex-transcript --write
```

The repair accepts only the installed `codex@openai-codex` cache layout and the
exact reviewed source signatures. It creates exclusive backups under Claude's
plugin recovery directory, atomically suppresses dynamic tool progress from
foreground stderr, and leaves the full progress stream in each Codex job log.
Unknown or updated plugin source is reported but never rewritten.

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
into CCR. Its CCR agent profiles, which carry its routing rules, and any
global Router rules left by an older build are namespaced by profile name
(`airkit-<profile>-…`). Providers default to
`airkit-provider-<profile>-<provider>`, but may declare an endpoint-owned
`managedId` when the same provider identity must be shared across profiles.
Every managed merge preserves ids outside the profile being prepared.

Leftover global rules are not harmless. CCR evaluates the global Router rules
in order and takes the first match, so a rule left behind by an older build —
for example one matching the bare prefix `claude-` — catches every request
whose own profile rules do not claim the model, including requests from
other profiles.

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

For the audit daemon and client-evidence workflow, see
[`audit.md`](audit.md). It covers installation, status/doctor/verify,
metadata-only queries, encrypted payload export, retention, and the distinction
between a healthy daemon and complete client capture.

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
