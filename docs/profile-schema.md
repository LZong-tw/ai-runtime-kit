# Profile Schema

Profiles live in `profiles/catalog.json`. The catalog is the source of truth for
rendered CCR config, shell helpers, and public model/provider metadata.

Runtime state is not stored in this repo. Do not add Claude sessions, CCR daemon
state, caches, login state, rendered files, or secret values to the catalog.

## Catalog Schema 1

```json
{
  "schema": 1,
  "modelCatalog": {},
  "profiles": [
    {
      "name": "openai-compatible-example",
      "visibility": "public",
      "summary": "Public example for an OpenAI-compatible chat completions gateway.",
      "shell": {},
      "ccr": {}
    }
  ]
}
```

Fields:

- `schema`: required. Must be `1`.
- `modelCatalog`: optional public provider, model, gateway, and routing metadata.
- `profiles`: required. Array of profile objects.

Profile names must be unique across the catalog. `airkit` rejects missing or
duplicate names before rendering anything.

## Model Catalog

`modelCatalog` is a public seed for task-mode routing and provider mapping. It
is not meant to be a complete model database.

Fields currently used:

- `schema`: required inside `modelCatalog`. Must be `1`.
- `lastReviewed`: date when public provider facts were last checked.
- `sources`: map of source IDs to public documentation URLs.
- `capabilityLevels`: allowed broad capability bands such as `economy`,
  `balanced`, `frontier`, and `specialist`.
- `taskModes`: task labels such as `default`, `background`, `think`,
  `longContext`, `webSearch`, and `coding`.
- `gateways`: gateway-specific routing metadata, including LiteLLM and Azure
  OpenAI.
- `providers`: provider entries and model facts.
- `routingPresets`: optional named model-candidate presets for common workflows.

Provider model entries may include:

- `id`: provider model ID or public base-model family.
- `litellm`: LiteLLM model string or pattern.
- `baseModel` / `baseModelFamily`: base model used when a gateway routes by
  deployment name.
- `level`: one of the catalog capability levels.
- `taskFit`: task modes where the model is a reasonable candidate.
- `contextWindow`: public context window when available.
- `maxOutputTokens`: public maximum output tokens when available.
- `pricingUsdPer1M`: public USD per 1M token prices when stable enough to seed.
- `pricingNotes`: caveats for provider-, region-, or tier-dependent pricing.
- `capabilities`: short public capability tags.
- `sourceRefs`: keys from `modelCatalog.sources` supporting the entry.

Azure entries should describe public base-model families and LiteLLM routing
shape only. Do not commit tenant-specific deployment names, regions, quotas, or
negotiated pricing.

## Profile Fields

- `name`: required string. Used for lookup, output file names, and generated
  shell comments.
- `visibility`: required. Must be `public` or `internal`.
- `summary`: operational description. Included in install output and generated
  shell comments.
- `shell`: optional object for generated shell snippets.
- `launch`: optional object for `airclaude` one-command setup and launch.
- `ccr`: optional object. When present, it is rendered as the CCR JSON config
  for the profile.

Profiles may contain public endpoints and environment placeholders. Secret
values must not be committed. Use placeholders such as `$ANTHROPIC_AUTH_TOKEN`.

## Shell Fields

`shell` controls generated shell snippets only. The snippet is written by
`airkit init --profile <name> --write` and can also be rendered with
`airkit render shell --profile <name>`.

```json
{
  "shell": {
    "ccrStartFunction": "airkit-ccr-start-openai-compatible-example",
    "wrappers": [
      {
        "name": "cclaude-example",
        "command": "cclaude",
        "env": {
          "CCR_PROFILE": "openai-compatible-example"
        }
      }
    ]
  }
}
```

Fields:

- `ccrTokenOpRef`: optional credential-manager reference. Public profiles should
  avoid committing provider-specific private references.
- `ccrStartFunction`: optional shell function name. The generated function syncs
  the rendered CCR config into CCR's live config before invoking `ccr-start`.
- `wrappers`: optional array of shell wrapper functions.
- `wrappers[].name`: generated shell function name.
- `wrappers[].command`: command invoked by the wrapper.
- `wrappers[].env`: environment variables exported before the command runs.

The catalog stores snippet inputs, not generated shell. Do not hand-write
runtime shell files into the repo.

## Launch Fields

`launch` controls the `airclaude` daily entrypoint. Unlike shell wrappers,
`airclaude` automatically writes managed files, syncs the selected CCR config to
CCR's live config path, starts CCR when needed, and then launches the configured
Claude Code command.

```json
{
  "launch": {
    "binary": "claude",
    "args": [
      "--strict-mcp-config",
      "--mcp-config",
      "{{configDir}}/claude/empty-mcp.json"
    ],
    "env": {
      "CCR_PROFILE": "{{profileName}}"
    },
    "defaultMode": "auto",
    "modes": {
      "auto": {},
      "pro": {
        "ccr": {
          "Router": {
            "default": "openai-compatible,reasoning-coder",
            "think": "openai-compatible,reasoning-coder",
            "longContext": "openai-compatible,long-context-coder"
          }
        }
      }
    }
  }
}
```

Fields:

- `binary`: command to execute after CCR setup, usually `claude`.
- `args`: arguments passed before user-provided Claude Code arguments.
- `env`: additional environment variables for the launched command. Values may
  use `{{profileName}}` and `{{configDir}}`.
- `defaultMode`: mode used by plain `airclaude`; defaults to `auto`.
- `modes`: map of mode names. `auto` is the normal mode. `pro` is the
  convention for stronger routing.
- `modes.<name>.ccr`: partial CCR config overlay applied only to the live CCR
  config for that launch. It does not create a separate profile.

`airclaude` also applies CCR's own activation environment internally. Do not put
real provider API keys in `launch.env`.

When a profile defines `shell.ccrTokenOpRef`, `airclaude` resolves that
reference with `op read` during launch and passes the token only to `ccr
restart`. The token is not written to managed files, the live CCR config, or
normal command output.

## CCR Fields

`ccr` is rendered directly as JSON. Keep it compatible with CCR config shape.
Current profiles use these fields:

- `APIKEY`: local CCR API key placeholder.
- `LOG`: boolean CCR logging switch.
- `API_TIMEOUT_MS`: request timeout in milliseconds.
- `Providers`: provider definitions.
- `Router`: route selection for model categories.

Provider fields currently used:

- `name`: provider identifier used by router entries.
- `api_base_url`: provider chat completions endpoint.
- `api_key`: environment placeholder or non-secret reference. Do not embed real
  API keys. Values starting with `sk-` are rejected by catalog validation.
- `models`: model names exposed by the provider.
- `transformer.use`: CCR transformer list.

Router fields currently used:

- `default`: provider and model for normal requests.
- `background`: provider and model for background work.
- `think`: provider and model for thinking-heavy requests.
- `longContext`: provider and model for long-context requests.
- `longContextThreshold`: token threshold for long-context routing.
- `webSearch`: provider and model for web-search work.

Router values use `provider,model` format and should reference a provider
`name` plus one model listed on that provider.

## Author Checklist

- Keep `schema` at `1`.
- Keep `modelCatalog.lastReviewed` current when model facts change.
- Use public documentation for public provider facts.
- Add one profile with a unique `name`.
- Use environment placeholders for credentials.
- Never commit real token values or secret-looking provider `api_key` values.
- Keep generated shell snippets and rendered CCR configs out of the catalog.
- Run `node src/airkit.mjs doctor --profile <name>` after rendering locally.
