# Runtime Lessons

Hard-won operational lessons for the `ai-runtime-kit` low-cost launcher
(`airclaude`) and its Claude Code Router (CCR) integration. These are
**runtime/behavioral** lessons that apply to any provider, not profile data.

- Profile/route specifics (which provider, which model, prices, endpoints) live
  in your private profile catalog, never here.
- Claude Code's own internal mechanisms (1M-context gating, auto-compaction
  math, model resolution) are documented separately as reverse-engineering notes
  and are linked inline as "Claude Code internals" where relevant.

Throughout, `<provider,model>` is a placeholder for a CCR route target; the
"routed model" is whatever low-cost model your profile points a route at.

## Launcher design & harness discipline

- **One entrypoint, not a pile of chores.** Don't expose routing, wrappers, and
  model mapping as separate user steps. The primary path is a single CLI that
  installs, configures, verifies, and launches the runtime.
- **Preserve the user's normal MCP/plugin config by default.** Do not pass an
  empty `--strict-mcp-config` (or `--mcp-config`) as a shortcut — that silently
  strips the user's tools. Only isolate when explicitly asked.
- **Don't disable built-in slash commands.** `/btw` and other mid-turn control
  commands are built-ins; do not add `--bare`, `--safe-mode`,
  `--disable-slash-commands`, or equivalent disabling env vars as shortcuts.
- **Permission auto-mode is a launch flag, not a UI toggle.** "Allow all edits
  in this session" is not a reliable boundary; launch with `--permission-mode
  auto` so the auto-mode classifier can release safe read/edit/test/build actions
  from the start. (Note: a session still honors the user's `autoMode` allow/deny
  rules — prompts for those are the classifier working, not a failure.)
- **Routing mode ≠ permission mode.** A launcher's own "auto" routing mode (which
  provider route to pick) is unrelated to Claude Code's `--permission-mode auto`
  (which reduces permission prompts). Never let the two names blur.
- **Bake harness discipline into the launch prompt.** Append a system prompt that
  tells the model to: use native file tools with literal absolute paths (never
  `sed`/`$f` shell-variable edits); never prefix shell commands with `!`; and
  when sandbox/network/permission boundaries block work, request
  permission/escalation or pick a safe in-sandbox alternative instead of trying
  to bypass. Record durable lessons in `Symptom/Cause/Rule/Action/Verify` form,
  and never put secrets, private endpoints, or company identifiers in shared
  notes.

## Two model identities (masking)

A low-cost launcher needs **two** model identities and must never let one stand
in for the other:

1. **Restore/display metadata** — a Claude-compatible model id Claude Code's
   internals accept (context window, restore, statusline rendering).
2. **Route metadata** — the actual provider route, surfaced separately in the
   statusline label, compact summaries, hooks, and user-facing explanations.

- **Repair persisted session state, not just future responses.** If Claude Code
  has already written invalid model metadata into a session transcript (JSONL),
  fixing only future proxy responses leaves resumed sessions broken — repair the
  persisted `message.model` too.
- **Restore-repair migrations must cover every previously shipped bad string,**
  including bad aliases introduced by your own earlier fix, not just provider
  model ids. (See Claude Code internals → model resolution / restore.)
- The `[1m]` context-window marker is a **Claude-Code-local** suffix on the model
  string; it is normalized off for the on-wire API id, so the gateway never sees
  it. How 1M is gated (and why it is the suffix, not an env var) is a Claude Code
  internal — see the internals notes. The launcher's job is only to put the
  marker on the restore/display model so resumed sessions get the right window.

## CCR routing

- **`longContextThreshold` compares estimated input tokens, not input +
  `max_tokens`.** Keep it below the default route model's window minus large
  output budgets, or compact/post-compact requests can overflow the default
  route.
- **Choose the `longContext` route by WINDOW SIZE first, then strength.** This
  route catches every request over the threshold — including compaction, which on
  a 1M-masked session can carry hundreds of thousands of tokens. A model that is
  stronger/cheaper but has a *smaller* window is **not** eligible: it overflows on
  large compactions. Pick a model whose window comfortably exceeds the largest
  request the route will see.
- **A Workflow's `opts.model` cannot redirect a CCR route.** CCR's `longContext`
  routing overrides the model by estimated input-token count regardless of what
  model Claude Code requested. The only lever is the CCR Router target itself.
- **Compact requests can carry every enabled tool.** A real compaction request
  has been observed bundling 140+ MCP/plugin tools. Don't route
  `longContext`/compact to a provider/model with a low tool cap (e.g. a 128-tool
  limit), or the compaction request is rejected.

## CCR daemon operations

CCR is a **persistent daemon** that loads transformers and config into memory at
startup. This causes three recurring traps:

- **`ccr start` is a no-op when already running** → a redeployed transformer or
  config is silently ignored until a real reload. Exiting/reopening Claude does
  not reload it. Only `ccr restart` / `ccr stop`+start reloads. Fix: have the
  launcher hash the live config + bundled transformers against a marker and
  `ccr stop` **only when they changed**, so updates auto-reload without
  disrupting an unchanged healthy daemon.
- **Orphaned port squatter.** A crash can leave a daemon process holding the port
  with no pid file, so `ccr status` says "not running" yet every `ccr start` dies
  with `EADDRINUSE` — and the launcher then silently falls through to the real
  upstream API. Symptom: the startup banner shows real first-party billing.
  (The statusline label is **not** proof of routing; verify with a real request
  through CCR.) Fix: a reaper that kills a port listener **only when** its
  `/health` check fails, preserving a genuinely healthy daemon.
- **Never bare `ccr start`/`ccr restart` just to "check the port".** If the
  provider `api_key` in the config is an env placeholder (e.g.
  `$SOME_AUTH_TOKEN`) and you start without that env resolved, the daemon sends
  the literal placeholder string upstream → a 401 from the gateway. Worse, a
  `/health` 200 on such a broken daemon makes the launcher reuse it (skipping its
  own authenticated start), so every turn 401-retries. Only the launcher's
  authenticated start path can bring up a working daemon.

## Provider transformer

For an OpenAI-compatible gateway, a CCR provider transformer often has to fix
three things. Keep transformer source as a single bundled file shipped by the
runtime (registered via the provider's `transformer.use` + a `ccr.transformers`
entry); do not re-embed transformer content in profile data.

- **Tool-metadata rejection.** OpenAI-compatible providers can reject MCP/plugin
  tool metadata before the model runs. Keep provider-facing tool aliases within
  64 chars and valid function-name characters, preserve the original Claude Code
  tool name in the description, and restore the original name before Claude Code
  executes the tool.
- **Missing usage counts.** Many OpenAI-compatible gateways emit zero/missing
  `usage`, which blanks the statusline's token widgets. A provider transformer's
  `transformResponseOut` runs on the **raw provider** response **before** CCR's
  OpenAI→Anthropic conversion, so for a `/v1/chat/completions` provider it sees
  **OpenAI** streaming shape (`chat.completion.chunk`, `choices[].delta.content`),
  not Anthropic events. Synthesize usage in OpenAI shape: count output from the
  deltas, estimate input from the request body, and inject
  `usage:{prompt_tokens,completion_tokens}` onto the `finish_reason` chunk **only
  when the gateway reported none**. To make a gateway emit real counts, set
  `stream_options:{include_usage:true}` inside the transformer's
  `transformRequestIn` (it receives the OpenAI body) — do **not** add CCR's
  built-in `streamoptions` transformer to `transformer.use`, which can break
  provider registration entirely. Never write the real provider model into the
  session model field (breaks resume); usage is safe to fill.
- **Reasoning leakage → "Content block is not a text block".** This mid-turn
  error on a reasoning model is thrown by Claude Code's own SDK stream
  accumulator when a `text_delta` lands on a block started as `thinking`/
  `tool_use`. Cause: stripping `reasoning_content` only in the JSON/Anthropic-SSE
  branches but **not** the live OpenAI-SSE branch. The surviving
  `delta.reasoning_content` reaches CCR's `transformResponseIn`, which makes it a
  `thinking` block and increments the choice index, desyncing block indices. Fix:
  strip `reasoning_content`/`reasoning` from **every** stream chunk's
  delta/message in the OpenAI-SSE path too. (The provider `transformer.use` runs
  `transformResponseOut` before CCR's format `transformResponseIn`, so stripping
  there preempts CCR.) After editing the bundled transformer, redeploy **and**
  reload the daemon (see CCR daemon operations).

## Statusline integration

- **`/context` and auto-compaction use Claude Code's own local tokenization, not
  the API `usage` field.** So a gateway returning `usage=0` blanks the
  statusline's usage/cost widgets but does **not** break auto-compaction —
  context is counted locally. Do not conflate "statusline shows nothing" with
  "compaction is broken"; verify with `/context`.
- **Prompt-cache widgets need a cache signal the gateway may never send.** If the
  gateway reports `cache_read_input_tokens=0` even for an identical prompt sent
  twice, cache-hit/ROI widgets are permanently 0 — a gateway limitation, not a
  bug. (The transformer should still map `prompt_tokens_details.cached_tokens` →
  `cache_read` for gateways that do provide it.)
- **Turn/cache glyph widgets look broken with no cache signal.** A per-turn
  widget that draws cache hit/miss dots will render all-empty when there is no
  cache data. Fall back to input-volume glyphs **only** when read+creation
  cache == 0, so real first-party sessions stay byte-identical; bump the widget's
  cache version to invalidate stale per-turn caches.

## Launch environment

- **Quiet git-aware zsh prompts in non-interactive shells.** Claude Code sources
  the user's zsh snapshot in its non-interactive command shells; a Powerlevel10k
  (or similar) instant prompt then re-evals its git/dir segments and spams
  `command not found: git/head/awk/...`. Export `POWERLEVEL9K_INSTANT_PROMPT=off`
  in the launch env for the launched process only — never edit the user's theme
  or `.zshrc`. If noise remains, it's the regular precmd segment, not instant
  prompt.

## Single source of truth for routes

- **Do not hand-write route/statusline env into a wrapper's `env`.** The launch
  env (`AIRCLAUDE_ROUTE_*`, `AIRCLAUDE_STATUSLINE_*`, the restore model, the
  statusline cache dir) is **derived** from the CCR Router (+ mode overlay +
  pricing) by `airclaudeLaunchEnv`, and `buildShellSnippet` applies the computed
  env only as defaults (`if (key in wrapperEnv) continue`). So any hand-written
  copy **wins and silently goes stale** on the next route change — actual routing
  and the statusline display then disagree. Keep only true per-wrapper knobs in
  `shell.wrappers[].env` (the mode selector and the CCR profile name). With that,
  the Router is the single source of truth, and bridging to a new/stronger model
  is a three-place edit: add the id to the provider's `models`, point a route (or
  a mode overlay) at it, and add its statusline price. Both the node and shell
  launch paths then render the display from the Router automatically.

## Test isolation

- **`op://` resolution errors in launch tests are usually shell leakage, not a
  missing `op`.** The default `env` is `process.env`, so a dev shell that
  exported the launcher's token op-ref leaks it into the test; combined with a
  `commandExists` mock returning false, you hit a misleading "op not found"
  branch. Pass an explicit `env: {}` to isolate launch tests from the runner's
  shell.

## See also (Claude Code internals)

These are reverse-engineering notes on Claude Code's own behavior, not part of
this runtime:

- **1M context window gating** — the `[1m]` model-name suffix, why
  `ANTHROPIC_1M_CONTEXT` is a no-op, and the auto-1M model set.
- **Auto-compaction math** — when compaction fires; `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`
  is a percentage that scales with the window.
- **The 1M rate-limit latch** — a per-session flag that hard-caps the window to
  200K after the server signals the 1M long-context allowance is exhausted;
  resets only on a fresh session.
