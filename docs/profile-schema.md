# Profile Schema

Profiles live in `profiles/catalog.json`. The catalog is the source of truth for
public model metadata, rendered profile files, and the CCR 3 providers and
managed profiles created by `airclaude`.

Runtime state is never stored here. Do not commit Claude sessions, CCR SQLite
state, caches, login state, rendered files, private endpoints, or secret values.

## Catalog schema 1

```json
{
  "schema": 1,
  "modelCatalog": {},
  "profiles": [
    {
      "name": "openai-compatible-example",
      "visibility": "public",
      "summary": "Public OpenAI-compatible example.",
      "shell": {},
      "launch": {},
      "ccr": {}
    }
  ]
}
```

- `schema`: required and currently `1`.
- `modelCatalog`: optional public provider, model, gateway, and routing
  metadata.
- `profiles`: required array. Profile names must be unique.

## Model catalog

`modelCatalog` is a public seed, not a complete model database. It may contain
public source URLs, capability levels, task labels, provider/model facts,
LiteLLM patterns, Azure base-model metadata, and routing presets.

Do not commit tenant-specific deployment names, regions, quotas, negotiated
prices, or private gateway details. Task labels such as `think` and
`longContext` describe model suitability only; they are not CCR 3 Router keys.

`airkit doctor --profile <name>` labels the source of any reported context
window. Catalog values and Claude Code `/model/info` values are model metadata;
they are not the token state of a completion response. `/model/info` therefore
cannot prove how much context the current turn consumed or whether the provider
reported a cache hit.

Completion usage is accounted independently. OpenAI-compatible
`prompt_tokens` already includes cached prompt tokens, so nested
`prompt_tokens_details.cached_tokens` is reported without being added a second
time. Anthropic-style `input_tokens`, `cache_read_input_tokens`, and
`cache_creation_input_tokens` are summed for total input accounting. If a
provider returns only total prompt/completion usage, compaction accounting still
uses the non-zero input total and reports cache details as `unavailable`; AirKit
does not synthesize cache hits.

## Profile fields

- `name`: required lookup key and generated-file identifier.
- `visibility`: required; `public` or `internal`.
- `summary`: short operational description.
- `shell`: optional generated shell functions.
- `launch`: required for a CCR-backed profile unless a shell wrapper supplies
  the launch command.
- `ccr`: optional CCR 3 provider and route template.
- `managedFiles`: optional public-safe files rendered under the AirKit config
  directory.

Profiles may use environment placeholders such as `$ANTHROPIC_AUTH_TOKEN`.
Never commit credential values.

## CCR 3 fields

```json
{
  "ccr": {
    "APIKEY": "ccr-local",
    "LOG": false,
    "API_TIMEOUT_MS": 600000,
    "Providers": [
      {
        "name": "openai-compatible",
        "type": "openai_chat_completions",
        "api_base_url": "https://example.test/v1/chat/completions",
        "api_key": "$ANTHROPIC_AUTH_TOKEN",
        "models": ["fast-coder", "steady-coder"]
      }
    ],
    "Router": {
      "default": "openai-compatible,steady-coder",
      "background": "openai-compatible,fast-coder"
    }
  }
}
```

Provider fields:

- `name`: source name used by catalog Router values.
- `type`: required CCR 3 gateway protocol, for example
  `openai_chat_completions`, `openai_responses`, `anthropic_messages`, or
  `gemini_generate_content`.
- `api_base_url`: full upstream endpoint expected by the selected protocol.
- `api_key`: environment placeholder; secret-looking literal keys are rejected.
- `models`: upstream model IDs.

Active CCR Router fields are only:

- `default`: normal model route, and the route for `launch.claudeModel`.
- `background`: small/background model route (`claude-haiku-*`).
- `opus`: optional route for `claude-opus-*`; falls back to `default`.
- `sonnet`: optional route for `claude-sonnet-*`; falls back to `default`.

`opus` and `sonnet` exist so a user who picks a Claude model mid-session reaches
that model rather than the mode's own. A mode overlay inherits whichever of
these the base `ccr.Router` sets, so one key at the base covers every mode.

Router values use `provider,model`. CCR 2 `think`, `longContext`,
`longContextThreshold`, `webSearch`, and transformer fields are unsupported.
AirKit rejects legacy transformers before writing files or calling CCR.

CCR 3 itself strips `default`/`background` from its gateway Router on load, so
during the managed merge AirKit translates them three ways:

1. Into each named profile's pinned `model`/`smallFastModel`.
2. Into two managed gateway condition rules (`<prefix>route-background`:
   `request.body.model starts-with claude-haiku` → background route;
   `<prefix>route-default`: `starts-with claude-` → default route).
3. Into the AirKit loopback adapter's `routes` config, plus a `launchModel` key
   holding `launch.claudeModel` with any `[1m]` suffix stripped. The adapter
   owns the child-facing `POST /v1/messages` endpoint and performs the
   bare-Claude-model rewrite before forwarding through CCR's public gateway:
   an exact match on `launchModel` →
   default route, then `claude-haiku-*` → background, `claude-opus-*` → opus,
   `claude-sonnet-*` → sonnet, each falling back to default. The launch id is
   matched first, so a profile that still launches on a family id keeps its
   old target. Provider-qualified selectors (named profiles, the whole-request
   Anthropic fallback) pass through untouched, and without `routes` the adapter
   forwards byte-identical bytes as before.

Claude Code sends a bare model id on the wire and carries `[1m]` only as an
`anthropic-beta` header, so a profile whose `launch.claudeModel` is
`claude-sonnet-5` cannot also offer Sonnet 5 as an in-session choice — both
arrive as the same string. Giving the launcher its own id
(`claude-airkit-mode`, say) separates them and is what makes `routes.sonnet`
usable. Claude Code forwards an id it does not recognize verbatim; the only
cost is that it assumes a 32000 max output, which
`launch.context.maxOutputTokens` restores.

This is what lets bare Claude model names — plain `claude` launched outside a
named profile, including its constant claude-haiku background requests —
resolve at the gateway instead of failing model resolution with
`400 All target providers failed`. Foreign Router rules in the live config are
preserved ahead of the managed rules; stale managed rules are replaced on
every merge.

During merge, AirKit creates a stable managed provider identity and intentionally
sets its CCR `id` and `name` to the same value. CCR 3 resolves profile selectors
through its management layer, while the generated gateway performs adapter
lookup by provider name; differing values produce `Target adapter is not
registered` failures.

## Compatibility declaration opt-in

Compatibility is disabled unless a profile declares an `airkit-compatibility`
entry in `ccr.plugins`:

```json
{
  "id": "airkit-compatibility",
  "module": "@lzong/ai-runtime-kit/compatibility-plugin",
  "config": {
    "fallback": {
      "provider": "your-anthropic-provider",
      "model": "claude-sonnet",
      "maxContinuationTurns": 8
    },
    "advisor": {
      "mode": "anthropic-fallback",
      "fallback": {
        "provider": "your-advisor-anthropic-provider",
        "model": "claude-opus"
      }
    },
    "codeExecution": { "mode": "anthropic-fallback" },
    "mcpConnector": { "mode": "anthropic-fallback" },
    "toolSearch": { "mode": "bridge" },
    "webFetch": { "mode": "native-first" },
    "webSearch": { "mode": "native-first" }
  }
}
```

The provider and model strings above are schema examples, not defaults.
`fallback.provider` must be the source name of a provider in `ccr.Providers`
whose type is exactly `anthropic_messages`; `fallback.model` must be a bare
Anthropic-family model in that provider's `models`. AirKit binds the source
name to its managed CCR ID and validates the complete configuration before CCR
RPC, managed saves, or credential resolution. Any family may optionally declare
its own `fallback` with `provider` and `model`; that provider follows the same
Anthropic Messages and local-model validation, and AirKit binds it to its own
managed CCR ID. Families without an override inherit the shared fallback and
its `maxContinuationTurns`.
Removed Advisor bridge fields such as `advisor.model` and
`advisor.fallbackModel` are rejected with a migration error; their replacement
is either the shared `fallback` section or `advisor.fallback`.

The supported source modes are:

- `webSearch`: `native-first`, `anthropic-fallback`, or migration-only `mcp`.
- `webFetch`: `native-first` or `anthropic-fallback`.
- `codeExecution`, `advisor`, and `mcpConnector`: `anthropic-fallback`.
- `toolSearch`: `bridge` or `anthropic-fallback`.

AirKit resolves these declarations into six effective policies. Doctor reports
WebSearch as native verified. WebFetch resolves to Anthropic fallback because
native execution is not verified. ToolSearch remains a verified local bridge;
other Anthropic fallback families remain configured and unprobed. Doctor does
not claim that an unrun fallback request succeeded.

The catalog entry is migration input, not an instruction to expose a plugin
route in CCR. At launch, AirKit reads and validates the declaration, removes
the legacy managed `airkit-compatibility` plugin from the CCR configuration,
and starts a loopback adapter for that Claude child. The adapter owns
`POST /v1/messages` and the compatibility MCP endpoint, then forwards its
provider-qualified requests through the public CCR gateway so CCR's native
recorder and UI see them. It never reads or writes CCR SQLite state or calls a
private CCR API. Unrelated CCR plugins are preserved.

`native-first` preserves Claude Code's existing client-side WebSearch and
WebFetch definitions and does not register duplicate MCP tools. Effective
routing still follows verified capability evidence: WebSearch remains native,
while WebFetch falls back as a complete request until its native execution cycle
is verified.

`webSearch.mode: "mcp"` is retained only as an explicit migration mode for
profiles that still require the older compatibility `web_search` tool. In that
mode AirKit adds one non-strict `--mcp-config` JSON argument for the launched
Claude process and uses the configured managed-provider/model fallback route
for its Anthropic request. The entry uses
`${AIRKIT_COMPATIBILITY_MCP_URL}` and
`Bearer ${AIRKIT_COMPATIBILITY_MCP_TOKEN}` placeholders; their values are
child-only environment variables for the loopback compatibility adapter. The
token is not placed in argv, and AirKit does not use `--strict-mcp-config`,
replace Claude settings, or discard user MCP/plugin configuration. Doctor marks
this legacy MCP capability `unverified` without a live probe. To leave
migration mode, change only `webSearch.mode` from `mcp` to `native-first`; no
MCP registration is then rendered.

## Launch fields

```json
{
  "launch": {
    "binary": "claude",
    "args": [],
    "env": {
      "CCR_PROFILE": "{{profileName}}"
    },
    "claudeModel": "claude-sonnet-5",
    "context": {
      "autoCompactWindow": 300000,
      "autoCompactPercentage": "default"
    },
    "defaultMode": "auto",
    "modes": {
      "auto": {},
      "pro": {
        "ccr": {
          "Router": {
            "default": "openai-compatible,reasoning-coder"
          }
        }
      }
    }
  }
}
```

- `binary`: Claude-compatible command, normally `claude`.
- `args`: base arguments before user passthrough arguments.
- `env`: non-secret launch environment. Values may use `{{profileName}}`,
  `{{configDir}}`, `{{home}}`, `{{launchMode}}`, `{{claudeModel}}`,
  `{{statuslineLabel}}`, and default/background route variables.
- `claudeModel`: the model id passed as the launched process's `--model`
  argument, and the id the loopback compatibility adapter routes to
  `Router.default`.
  Claude Code accepts any string here. Use a dedicated id such as
  `claude-airkit-mode[1m]` when the profile also wants `Router.sonnet` to serve
  a real in-session Sonnet pick; use a Claude-recognized id when it does not.
- `context.maxOutputTokens`: optional integer from `1024` through `512000`
  passed as `CLAUDE_CODE_MAX_OUTPUT_TOKENS` to the managed AirClaude child.
  Claude Code derives max output from the launch model id and falls back to
  `32000` for an id it does not recognize, so a profile using a dedicated
  `claudeModel` sets this to the value its routed model can actually produce.
- `context.autoCompactWindow`: optional integer from `100000` through `1000000`
  passed as `CLAUDE_CODE_AUTO_COMPACT_WINDOW` to the managed AirClaude child.
  It changes when Claude Code compacts, not the model's real context window or
  the status line's full-window percentage.
- `context.autoCompactPercentage`: optional integer from `1` through `100`, or
  `"default"`. An integer sets the managed child's percentage override;
  `"default"` clears an inherited override for that child. Omitting the field
  preserves normal environment inheritance. When `context` owns either value,
  it takes precedence over the matching generic `launch.env` key.
- `defaultMode`: mode selected by plain `airclaude`.
- `modes.<name>.ccr`: partial CCR overlay for that managed mode.

For CCR-backed profiles, `args` must not contain a JSON `--settings` override
that defines `apiKeyHelper`. An `apiKeyHelper` outranks the gateway key the
launch exports, so it would authenticate the session as somebody else; AirKit
rejects the profile before writing files or calling CCR.

`airclaude` resolves credentials, merges only AirKit-owned state through the CCR
3 management API, and then spawns `launch.binary` directly against the CCR
gateway. Each mode is still a separate `scope: "ccr"` profile whose model
selectors reference the managed provider identity, and whose generated gateway
key authenticates that mode's launch — but the profile is no longer used as a
launcher, so it never redirects the child's `CLAUDE_CONFIG_DIR`. AirKit does not
sync a live CCR JSON file or invoke CCR 2 start/restart/activate commands.

Because one loopback compatibility adapter instance serves every mode, the
launch labels its requests with an `x-airkit-mode` header (through
`ANTHROPIC_CUSTOM_HEADERS`) and the adapter routes on that label. A profile
must not set that variable itself.

For Claude-backed AirClaude launches, AirKit also renders a session-scoped
plugin under `{{configDir}}/plugins/airkit-context` and passes it with
`--plugin-dir`. Its `UserPromptSubmit` hook adds at most 512 characters of
factual route and durable-task-state context beside each new prompt. The hook
does not echo the prompt, transcript path, session identifier, provider name,
endpoint, credential, or token. Plugin hooks merge with existing user and
project hooks; AirKit does not replace or rewrite Claude settings.

The same plugin records only a complete, seven-field `[AIRKIT_TASK_CAPSULE]`
from `PostCompact.compact_summary`. It bounds and redacts each field, keys the
record by a hash of the workspace path under Claude's plugin-data directory,
and re-injects it with current route metadata on `SessionStart` for `startup`,
`resume`, `clear`, and `compact`. It does not read the transcript or create
state files in the repository. Missing, partial, or malformed capsules are
ignored; route context still loads normally.

AirKit starts a missing management service only with `ccr start --no-gateway`,
reads live configuration before later operations, and saves with
`applyProfile: false`. Enabled global Codex profiles targeting Codex
configuration are rejected at launch and can be converted to `scope: "ccr"`
with `showAllSessions: true` through the preview-first
`airkit repair codex-takeover` command.

AirKit never writes `claudeModel` into Claude settings or transcripts. Claude
Code owns `/model` and its normal model-choice persistence, so a routed launch
does not replace the user's global choice. Provider credentials are passed to
CCR management state and are never written to rendered profile files or command
output.

## Shell fields

```json
{
  "shell": {
    "exports": [
      { "name": "ANTHROPIC_BASE_URL", "value": "http://127.0.0.1:3456" },
      { "name": "ANTHROPIC_API_KEY", "command": "{{home}}/bin/api-key-helper" }
    ],
    "wrappers": [
      {
        "name": "airclaude-example",
        "command": "airclaude",
        "env": {
          "CCR_PROFILE": "openai-compatible-example"
        }
      }
    ]
  }
}
```

- `ccrTokenOpRef`: optional credential-manager reference; omit private
  references from public profiles.
- `providerTokenOpRefs`: optional map of configured provider names to `op://`
  credential-manager references. Each mapped provider must use an
  uppercase environment-placeholder `api_key` such as `$EXAMPLE_API_KEY`.
  AirKit resolves each reference only while preparing the managed CCR config;
  credential values are not rendered into profile or shell files.
- `exports`: optional global exports rendered before the wrapper functions.
- `exports[].name`: environment variable name matching `^[A-Z][A-Z0-9_]*$`.
- `exports[].value` or `exports[].command`: exactly one of the two, as a
  string. A `value` renders `export NAME='value'`. A `command` renders an
  executable guard that captures the command's output, so credential values
  never appear in the rendered snippet; when the helper is missing, the export
  is skipped with a warning on stderr.
- `plainClaude`: optional boolean, valid only for a CCR-backed profile with a
  usable launch contract: a non-empty `launch.binary`, a non-empty
  `ccr.Providers` list, and a `ccr.Router.default` provider/model route that
  resolves to one of those providers. It cannot be combined with a
  `wrappers` entry named `claude`, which would shadow the generated delegate.
  When `true`, it routes only the normal `claude` command to
  `airclaude --plain --profile <name>`; it does not affect `claude-sub`, adds
  no AirClaude prompt, permission, model, or plugin arguments, and fails
  closed when the supervised CCR gateway cannot recover.
- `wrappers`: generated shell functions.
- `wrappers[].name`: shell function name.
- `wrappers[].command`, `args`, and `env`: launch inputs.

Export values and commands accept `{{profileName}}`, `{{configDir}}`,
`{{claudeModel}}`, and `{{home}}` (the current user's home directory).

For CCR-backed profiles, generated wrappers delegate once to `airclaude`; they
do not add a daemon-control wrapper layer.

## Author checklist

- Keep shared behavior and public facts free of company identifiers.
- Require Node.js 22+, Claude Code 2.1.208+, and CCR 3.0.4 through latest 3.x.
- Declare an explicit provider `type`.
- Use only `default`, `background`, `opus`, and `sonnet` in active CCR Router
  config.
- Define an explicit Claude launch contract.
- Do not override CCR's managed `apiKeyHelper` in launch arguments.
- Keep provider API keys as environment placeholders.
- Run `npm test`, `npm run check`, and an isolated CCR 3 smoke test.
