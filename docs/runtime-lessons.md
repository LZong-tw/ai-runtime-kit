# Runtime Lessons

Current operational guidance for `airclaude`, Claude Code, and Claude Code
Router 3. Shared lessons stay provider-neutral; private endpoints, credentials,
prices, and company identifiers belong in a private overlay.

## One launch path

- Use `airclaude` as the daily entrypoint. It resolves credentials, merges
  AirKit-owned state through the CCR 3 management API, and launches
  `ccr <managed-profile> cli -- ...`.
- Generated CCR-backed shell functions delegate once to `airclaude`. Do not
  add start/restart/activate wrappers or live JSON synchronization.
- Preserve the user's normal Claude MCP and plugin configuration. Do not add an
  empty strict MCP config merely to simplify routing.
- Routing mode and Claude permission mode are unrelated. `airclaude pro`
  selects a model route; `--permission-mode auto` controls permission prompts.

## Isolate development state

CCR 3 can write an API helper and localhost gateway URLs into Claude settings
when a profile takes over the global scope. A development run against shared
`~/.claude` or `~/.claude-code-router` can therefore break unrelated aliases.

Tests and runtime probes must set all of these to a temporary root:

```text
HOME
CCR_INTERNAL_HOME_DIR
CCR_INTERNAL_APP_DATA_DIR
CCR_INTERNAL_USER_DATA_DIR
AIRKIT_CONFIG_DIR
```

Before an intentional global cutover, back up shared settings, apply the
change, smoke-test the user's normal Claude path and routed path, and retain the
backup until both pass.

## Provider identity and protocol

Every provider needs an explicit CCR 3 protocol `type`. For an OpenAI-compatible
chat endpoint use `openai_chat_completions`; do not depend on protocol guessing.

AirKit-managed providers deliberately use the same stable string for `id` and
`name`. CCR 3 resolves a profile model through its management layer, then sends
the provider name to the generated gateway. The gateway registers its adapter
under the managed provider identity. If those values differ, a request can fail
with:

```text
Target adapter is not registered for provider: <name>
```

Verify this path with a real request, not only service health:

1. Inspect the managed provider and profile without printing credentials.
2. Confirm the profile model begins with the managed provider identity.
3. Confirm generated gateway config uses the same provider name and protocol.
4. Send one minimal `/v1/messages` request through the isolated gateway.
5. Confirm the upstream receives the expected model and the response converts
   back to Anthropic message shape.

## CCR 3 routing contract

Active managed routing uses two model selectors:

- `default`: normal traffic.
- `background`: small/background traffic.

Each launch mode becomes a separate `scope: "ccr"` managed profile with its own
default and small model. CCR 2 automatic categories such as `think`,
`longContext`, `longContextThreshold`, and `webSearch` are not active Router
fields. Generic model-catalog task labels with similar names remain descriptive
metadata only.

Legacy CCR 2 transformers are rejected before files or CCR state are written.
Use a native CCR 3 provider type or gateway plugin when protocol adaptation is
actually required.

## Claude launch model is not route identity

Claude Code needs a Claude-recognized model ID at launch, while the actual
request may be routed to a different provider model. Keep these separate:

- `launch.claudeModel` is passed only as the launched Claude Code process's
  `--model` argument.
- `AIRCLAUDE_ROUTE_*` and the managed profile selectors describe the real
  provider route.

AirKit never writes `launch.claudeModel` into Claude settings or transcripts.
Claude Code owns `/model` and its normal model-choice persistence; a routed
launch must not replace the user's global choice. Do not infer the active
provider from Claude Code's displayed launch model.

The `[1m]` suffix is Claude Code-local launch/display metadata. It is not an
upstream provider model ID and is not enabled by `ANTHROPIC_1M_CONTEXT`.

## Statusline and launch environment

Route and statusline variables are derived from the selected Router and mode.
Do not duplicate `AIRCLAUDE_ROUTE_*` or `AIRCLAUDE_STATUSLINE_*` values in a
wrapper; duplicated values drift when routing changes.

Claude Code may source cached zsh state in non-interactive command shells.
Setting `POWERLEVEL9K_INSTANT_PROMPT=off` for the launched process prevents
git-aware prompt fragments from polluting tool output without changing the
user's interactive shell.

## Verification contract

Before release:

1. Run `npm test` and `npm run check` in OSS and the private overlay.
2. Run the runtime version gate for Node.js, Claude Code, and CCR.
3. Build a fresh isolated CCR state from the committed profile.
4. Perform a mock-provider end-to-end request.
5. For a private overlay, perform one minimal real-provider request without
   printing credentials or request logs.
6. Confirm shared Claude settings and aliases are unchanged.

`ccr start`, management RPC success, generated files, and `/health` are useful
component checks, but none alone proves routed inference works.
