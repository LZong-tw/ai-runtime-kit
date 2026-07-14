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

- `default`: normal model route.
- `background`: small/background model route.

Router values use `provider,model`. CCR 2 `think`, `longContext`,
`longContextThreshold`, `webSearch`, and transformer fields are unsupported.
AirKit rejects legacy transformers before writing files or calling CCR.

During merge, AirKit creates a stable managed provider identity and intentionally
sets its CCR `id` and `name` to the same value. CCR 3 resolves profile selectors
through its management layer, while the generated gateway performs adapter
lookup by provider name; differing values produce `Target adapter is not
registered` failures.

## Launch fields

```json
{
  "launch": {
    "binary": "claude",
    "args": [
      "--settings",
      "{\"apiKeyHelper\":\"\"}"
    ],
    "env": {
      "CCR_PROFILE": "{{profileName}}"
    },
    "restore": {
      "model": "claude-sonnet-4-6"
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
  `{{configDir}}`, `{{launchMode}}`, `{{restoreModel}}`,
  `{{statuslineLabel}}`, and default/background route variables.
- `restore.model`: Claude-recognized model used for persisted-session repair.
- `restore.models`: optional previously stored aliases to repair.
- `defaultMode`: mode selected by plain `airclaude`.
- `modes.<name>.ccr`: partial CCR overlay for that managed mode.

`airclaude` resolves credentials, merges only AirKit-owned state through the CCR
3 management API, and launches `ccr <managed-profile> cli -- ...`. Each mode is
a separate `scope: "ccr"` profile whose model selectors reference the managed
provider identity. It does not sync a live CCR JSON file or invoke CCR 2
start/restart/activate commands.

When `restore.model` is present, AirKit may repair persisted Claude session
metadata after backing it up. Provider credentials are passed to CCR management
state and are never written to rendered profile files or command output.

## Shell fields

```json
{
  "shell": {
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
- `wrappers`: generated shell functions.
- `wrappers[].name`: shell function name.
- `wrappers[].command`, `args`, and `env`: launch inputs.

For CCR-backed profiles, generated wrappers delegate once to `airclaude`; they
do not add a daemon-control wrapper layer.

## Author checklist

- Keep shared behavior and public facts free of company identifiers.
- Require Node.js 22+, Claude Code 2.1.208+, and CCR 3.0.4 through latest 3.x.
- Declare an explicit provider `type`.
- Use only `default` and `background` in active CCR Router config.
- Define an explicit Claude launch contract.
- Keep provider API keys as environment placeholders.
- Run `npm test`, `npm run check`, and an isolated CCR 3 smoke test.
