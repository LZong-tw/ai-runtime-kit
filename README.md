# ai-runtime-kit

AirKit turns public runtime profiles into managed Claude Code Router configuration
and an `airclaude` launcher. It previews every managed-file or runtime change,
keeps machine state outside git, and verifies the installed launch path.

## Feature map

- Installation, runtime pinning, takeover repair, and daily launcher flow:
  [`docs/install.md`](docs/install.md)
- Local audit daemon, audit UI, exports, retention, client completeness, and
  gap interpretation: [`docs/audit.md`](docs/audit.md)
- Sensitive Egress Shield provision, policy lifecycle, audit projection, and
  declared-launcher boundary: the Shield section below
- Launch-path, routing, statusline, Headroom/cache evidence, and completion
  guard lessons: [`docs/runtime-lessons.md`](docs/runtime-lessons.md)
- External-client adapter flow for Pi and OpenCode: the `Pi and OpenCode`
  section below plus [`docs/install.md`](docs/install.md)
- Bounded child-task timeline and additive `subagentStatusLine` behavior:
  [`docs/subagent-observability.md`](docs/subagent-observability.md)
- Compatibility policy and profile wiring: the `Server-tool compatibility`
  section below plus [`docs/profile-schema.md`](docs/profile-schema.md)

## Quick start

Prerequisites are Node.js 22 or newer, Claude Code 2.1.208 or newer, Claude Code
Router 3.0.18 through the latest 3.x release, and zsh. The supported public
onboarding path is a source checkout:

```bash
git clone https://github.com/LZong-tw/ai-runtime-kit.git
cd ai-runtime-kit
node src/airkit.mjs --help
npm install --global . --dry-run
# After reviewing and approving the global install:
npm install --global .
airkit --help
```

Do not claim a registry installation path unless a release has been verified as
published and visible. The commands below use the installed `airkit` binary. To
inspect the checkout without installing it, run
`node src/airkit.mjs <command>` from the repository root instead.

Inspect the runtime first:

```bash
airkit runtime check
```

If the check reports a missing or unsupported Claude Code or CCR version,
preview the pinned update, review the packages and backup paths it prints, and
only then deliberately run the write form:

```bash
airkit runtime update
# After reviewing the preview and approving the changes:
airkit runtime update --write
```

The public example expects an OpenAI-compatible provider. Its endpoint, model
IDs, and credential are placeholders, so it can validate rendering and
preflight but cannot complete a real provider request unchanged. When using a
locally customized public profile, expose the credential through an environment
variable such as:

```bash
export ANTHROPIC_AUTH_TOKEN="<provider-api-token>"
```

Never commit the real value. Preview the generated files, review every target
path, then approve the write explicitly:

```bash
airkit init --profile openai-compatible-example
# After reviewing the preview and approving the target paths:
airkit init --profile openai-compatible-example --write
source ~/.config/ai-runtime-kit/shell/openai-compatible-example.zsh
```

Verify the managed files and the actual launcher path, not only the install
command:

```bash
airkit doctor --profile openai-compatible-example
command -v airclaude
airclaude --doctor
airclaude
```

The last command is an interactive smoke test. Confirm that Claude starts, then
exit normally. If the public placeholders have not been replaced or credentials
are unavailable, report the provider session as blocked with the exact error;
do not claim onboarding is complete merely because `init --write` succeeded.
See [`docs/install.md`](docs/install.md) for updates, takeover recovery,
troubleshooting, and the complete fresh-machine workflow.

## Local audit and observability

AirKit includes an opt-in local audit daemon and metadata-first client
reconcilers. Enable and verify it with `airkit audit install --write`,
`airkit audit start`, `airkit audit status`, and `airkit audit verify`, then
inspect `airkit audit clients`, `airkit audit usage`, `airkit audit cache`, and
`airkit audit gaps`. A healthy daemon does not prove every client is captured;
check the reported completeness for the actual client/session. The complete
security boundary, supported client lanes, exports, retention, and known
coverage limits are documented in [`docs/audit.md`](docs/audit.md).

AirKit can also register a loopback-only local audit UI. Open it with
`airkit audit open`; it uses a one-time local bootstrap URL and an HttpOnly
session cookie. It shows the same metadata-only projections and service status
without turning the audit store into a payload browser. See
[`docs/audit.md`](docs/audit.md) for the UI surface, safe export path, gated
reveal flow, and gap interpretation rules.

## Sensitive Egress Shield

AirKit includes a disabled-by-default local Sensitive Egress Shield for
profiles that explicitly opt into a declared managed launcher lane. It evaluates
a signed OPA/Wasm policy with provisioned Gitleaks and Privacy worker facts,
can require a one-time local approval, and writes a
metadata-only terminal decision before forwarding. Missing or invalid policy,
assets, audit durability, identity, or approval capability blocks; there is no
allow-all fallback.

Provisioning is deliberately external and preview-first. Policy bundles,
Gitleaks, Privacy Filter worker/model assets, public keys, credentials, and
provider origins are never downloaded during a request or packaged with AirKit.
After reviewing each preview, explicitly apply only the required local writes:

```bash
airkit shield policy install --lane managed --bundle <policy-bundle> --public-key <policy-public-key>
airkit shield privacy provision --lane managed --bundle <privacy-manifest> --gitleaks <gitleaks-executable>
airkit shield install --lane managed

airkit shield policy install --lane managed --bundle <policy-bundle> --public-key <policy-public-key> --write
airkit shield privacy provision --lane managed --bundle <privacy-manifest> --gitleaks <gitleaks-executable> --write
airkit shield install --lane managed --write
airkit shield status --lane managed
airkit shield doctor --lane managed
```

Provision and install are per lane. `install` validates that the same lane
already has a valid signed policy and Privacy/Gitleaks provision; it does not
download or infer either dependency. Repeat the sequence with
`--lane subscription` only for an explicitly enabled subscription launcher.

The asset references must resolve to canonical, user-owned regular files, with
no symlink or group/world write permission. Provisioning verifies SHA-256; the
Privacy manifest pins its worker/version/protocol and runs a redaction
self-test. Runtime worker validation repeats before spawn. The policy bundle
validates signature, compiled Wasm digest/ABI, detector versions, and self-test.

Only declared AirKit-managed launchers are protected when their profile enables
Shield: `airclaude`, generated `cclaude-*`, `hr-airclaude`, and
`hr-claude-web`. Subscription `claude-sub` and `hr-claude-sub` are protected
only when their explicit subscription feature switch is enabled. Direct
`command claude`, browsers, `curl`, and undeclared wrappers are outside the
control. A profile must expose that enablement and lane in its own catalog; this
public repository does not silently enable Shield for a shell or route. Do not
manually wrap `airclaude` with `shield launch`.

For a managed launch, AirKit binds the fresh local compatibility middleware to
Shield with a one-use, short-lived destination lease and revokes it when the
child exits. The child receives only its request capability, not a destination,
control capability, or provider credential. This is an application-level
least-privilege boundary, not hostile-principal isolation: processes running as
the same operating-system user remain within that user's trust boundary.

Policy replacement is atomic: a live daemon is quiesced, a reachable old proxy
rejects the transition, and a replacement must publish matching policy/detector
identity before it is ready. Exact retry coalescing is bounded, in memory, and
cannot cross a policy/detector version, lane, destination, digest, or expiry.
Shield decisions and transitions are visible only as safe metadata in
`airkit audit open`; the UI never becomes a prompt, match, or credential
viewer. To roll back, apply a reviewed profile revision with Shield disabled,
then use `airkit shield stop` if appropriate—do not edit CCR, OAuth, Shield, or
Audit state by hand.

## Pi and OpenCode

Use the external-client adapter when Pi or OpenCode should use the same managed
CCR profile, compatibility middleware, and fallback routes as `airclaude`:

```bash
airkit connect --profile openai-compatible-example --mode auto --port 3460
```

The command stays in the foreground and prints a loopback endpoint, a local
client token, and provider fragments for both clients. Keep it running while
Pi or OpenCode is in use, export the printed `AIRKIT_CLIENT_TOKEN` in the
client shell, and stop it with Ctrl-C. The adapter token is separate from the
CCR gateway credential; never point a client directly at CCR's core port.

For one-command launches, use the client wrappers. They start and close the
same adapter around the client process, keep the CCR credential private, and
stamp the selected AirKit mode on every Messages request:

```bash
airpi --profile openai-compatible-example --mode auto
airoc --profile openai-compatible-example --mode auto
```

`airpi` uses Pi's Anthropic provider with the local adapter. `airoc` uses the
Anthropic provider and enables OpenCode's fullscreen TUI by default; pass an
explicit `--tui-mode regular` if a split/non-fullscreen TUI is desired.

Headroom savings and cost counters can also be reconciled into the same local
audit store as bounded metadata. Those rows remain observational: unlinked
Headroom events stay marked as candidates until they correlate to a specific
AirKit request. [`docs/audit.md`](docs/audit.md) covers the evidence boundary.

## Daily use

```bash
airclaude
airclaude pro
airclaude --dry-run
airclaude --doctor
airclaude -- --resume
```

For current launch-path, routing, statusline, prefix-cache, and completion-guard
behavior, see [`docs/runtime-lessons.md`](docs/runtime-lessons.md). For the
bounded child-task timeline and additive `subagentStatusLine` surface, see
[`docs/subagent-observability.md`](docs/subagent-observability.md).

## Server-tool compatibility

Compatibility is profile-scoped and native-first. These six families are the
current contract:

| Family | Profile mode | Effective behavior |
| --- | --- | --- |
| WebSearch (`webSearch`) | `native-first` | Native. The complete call/result wire cycle was verified with real Claude Code 2.1.211. |
| WebFetch (`webFetch`) | `native-first` | The client definition stays on the selected executor route; AirKit does not claim native execution is verified. Explicit `anthropic-fallback` mode uses the complete Anthropic route. |
| Code Execution (`codeExecution`) | `anthropic-fallback` | The complete request uses the configured Anthropic route so container and continuation state stay intact. |
| Advisor (`advisor`) | `bridge` or `anthropic-fallback` | Bridge mode simulates Claude's Advisor tool with a bounded transcript review through the configured Anthropic route and resumes with a canonical `advisor_tool_result`; fallback mode strips the definition by default. |
| ToolSearch (`toolSearch`) | `bridge` | Safe bounded regex/BM25 requests use the local bridge. Unsafe, oversized, unsupported, or unknown requests fall back as a complete request. |
| MCP Connector (`mcpConnector`) | `anthropic-fallback` | Typed server-side connector requests use the configured Anthropic route; client-side MCP remains native. |

Fallback is per request, not a global model switch. A fallback request consumes
context, cache, and billing on the configured Anthropic route; the local
ToolSearch bridge does not make a model call. `fallback.provider` names a
profile provider whose type must be `anthropic_messages`; `fallback.model` is
the provider-local Claude model it exposes. AirKit validates that binding and
renders CCR's canonical `<managed-provider>/<model>` selector. Keep the model
bare (for example, `claude-sonnet`), use a dedicated `/v1/messages` provider,
and verify it end to end.

For a narrowly scoped provider outage policy, use `transportFallbacks` in the
compatibility config. Each entry names provider-local `from` and `to` models,
the retryable HTTP statuses, and optionally `scope: "classifier"` plus a
`timeoutMs`. A classifier-scoped entry applies only to AirKit's auto-mode
security classifier; ordinary model traffic remains on its selected route.

When `advisor.mode` is `bridge`, AirKit sends a bounded plain-text transcript
to the configured Advisor family fallback and wraps the returned text in the
official `advisor_tool_result` shape. This is a compatibility simulation and
does not reproduce provider-encrypted Advisor payloads. Use
`advisor.mode: "anthropic-fallback"` when the upstream provider natively
supports the full Advisor protocol.

Legacy `webSearch.mode: "mcp"` is migration-only. It adds the older
`web_search` MCP tool explicitly and additively; a native-first profile does not
register a duplicate MCP tool. Migrate the source profile—not generated CCR
state—by moving Advisor `model`/`fallbackModel` fields into the single
`fallback` block, declaring all six family modes, and changing legacy
`webSearch.mode` from `mcp` to `native-first`. Then preview, write only after
review, and check the effective doctor states:

```bash
PROFILE=your-profile
airkit update --profile "$PROFILE"
airkit update --profile "$PROFILE" --write
airkit doctor --profile "$PROFILE"
npm run verify:tool-contract
npm run verify:ccr3:e2e
```

Doctor's `native` and `bridged` states describe verified routing policy;
`anthropic-fallback` means configured but not live-probed, and `unverified` is
reserved for the legacy MCP mode. A clean doctor result is not proof that a
billable fallback request succeeded.

This repository intentionally contains no private endpoints, no
credential-manager item references, and no secret values. Use
`profiles/catalog.json` as a starting point, then keep machine-specific runtime
state outside git.

`profiles/catalog.json` also includes a public model catalog seed for provider
and gateway mapping. It covers first-party providers, LiteLLM provider prefixes,
and Azure OpenAI deployment-name routing. Prices and limits are copied only from
public vendor documentation and include a `lastReviewed` date because model
catalogs change frequently.

The supported runtime is Node.js 22 or newer, Claude Code 2.1.208 or newer,
and Claude Code Router 3.0.18 through the latest 3.x release. `runtime update`
is preview-only; add `--write` to back up CCR state, install the pinned minimum
versions, and validate them.

`airclaude` is the daily entrypoint. It merges only AirKit-owned providers and
profiles into CCR 3 through its management API, preserves unrelated CCR state,
and then launches Claude Code directly. CCR is the gateway, not the launcher:
the child inherits the user's own `CLAUDE_CONFIG_DIR`, so sessions, statusline,
hooks, and `.claude.json` are shared with every other Claude launcher. What the
launch supplies is the gateway base URL, the profile's gateway key (resolved at
spawn, never through argv), and a `x-airkit-mode` header naming the routing
mode. Model variables inherited from the shell are cleared, because a stale one
would silently outrank the launch model.
AirKit starts a missing CCR service only with `ccr start --no-gateway`, or with
`launchctl kickstart` when launchd supervises the daemon as
`com.airkit.ccr-daemon` — starting one beside a supervisor leaves two
management services answering the same RPCs while only one holds the port. It
reads configuration before any mutation-capable operation, and saves managed
state with profile application disabled. If it detects an enabled global Codex
profile, a CCR takeover record, or CCR-managed blocks in Codex configuration,
launch stops and directs the user to the preview-first takeover repair flow.
`airclaude pro` applies the profile's stronger routing overlay before launch.
Managed CCR 3 profiles own the selected mode's default model and small/background
model. CCR 2's automatic `think`, `longContextThreshold`, and `webSearch` router
categories are not presented as active CCR 3 routes.
Legacy CCR 2 `transformers` are rejected instead of being silently discarded by
CCR 3 persistence; remove them or migrate the behavior to a native CCR 3 gateway
plugin.
For OpenAI-compatible coding routes, the gateway translates Claude Code's
`output_config.effort` into `reasoning_effort`. GLM 5.2 and Kimi K3 preserve
Claude Code's `low`, `medium`, `high`, `xhigh`, and `max` levels. DeepSeek V4
uses its native two-level contract: `low`, `medium`, and `high` select `high`;
`xhigh` and `max` select `max`. Other models and unknown levels remain
untouched so an unsupported request fails visibly instead of being silently
downgraded.
Do not pass a JSON `--settings` override containing `apiKeyHelper`. An
`apiKeyHelper` outranks the gateway key the launch puts in the environment, so
it would silently authenticate the session as somebody else; AirKit rejects
launch arguments that define one — profile args and passthrough args alike —
and refuses to launch while the inherited home's `settings.json` defines one.
Because the launched session reads the user's real settings, it also picks up
their statusline, hooks, and permission rules natively — AirKit forwards no
settings overlay of its own.
Claude Code permission rules still retain their native precedence: an explicit
`permissions.ask` rule overrides `--permission-mode auto`. Remove an obsolete
Ask rule with Claude Code's `/permissions` UI when auto mode should classify
that command; AirKit does not silently weaken explicit Ask or Deny policy.
Claude launches also receive reusable runtime lessons for recurring tool
mistakes, such as preserving durable lessons, recording repeatable corrections
without secrets, verifying Athena-style query context instead of assuming
defaults, and ruling out local shell wrappers before blaming remote services.

For LLM-guided installation or debugging, start with `CLAUDE.md`. The
management flow remains inspectable: dry run first, then `--write` after the
user confirms the target paths.

For current CCR 3 lifecycle, provider identity, statusline, model masking, and
route-selection guidance, see
[`docs/runtime-lessons.md`](docs/runtime-lessons.md).

## Public model catalog

The catalog is intentionally a seed, not a complete model database. Public
entries include enough metadata to drive task-mode routing:

- `providers[]` maps OpenAI, Anthropic, Google AI Studio, Mistral, DeepSeek,
  xAI, and Azure OpenAI model families.
- `gateways.litellm.providerModelPatterns` records LiteLLM provider prefixes
  such as `openai/<model>`, `anthropic/<model>`, `gemini/<model>`,
  `mistral/<model>`, `deepseek/<model>`, `xai/<model>`, and
  `azure/<deployment-name>`.
- `gateways.azure-openai` records Azure's deployment-name model routing. Keep
  real deployment names, regions, and Azure prices in a local private overlay.
- `routingPresets.coding-balanced` gives a starting point for mapping
  `default`, `background`, `think`, `longContext`, and `coding` work to model
  candidates.

## Troubleshooting

If CCR reports `Target adapter is not registered`, confirm that the provider has
an explicit CCR 3 protocol `type` and that the managed provider `id` and `name`
are identical. AirKit enforces this identity contract because CCR 3 resolves the
profile through its management layer before the generated gateway performs the
adapter lookup.

Legacy CCR 2 transformers are intentionally unsupported. Implement protocol
adaptation with CCR 3 provider types or a native gateway plugin.

If AirKit reports Codex takeover state, preview the affected paths and actions
with `airkit repair codex-takeover`. Apply only after review with
`airkit repair codex-takeover --write`; write mode creates rollback snapshots,
scopes hazardous Codex profiles to CCR, removes only exact CCR-managed Codex
blocks, and preserves unrelated CCR profiles and user-owned configuration.

If an `airclaude` launch finds the reviewed OpenAI Codex Companion version that
writes high-frequency dynamic tool progress to stderr, it stops before launch
to prevent that progress from becoming a large Claude transcript record. Preview
the narrowly scoped repair with `airkit repair codex-transcript`, then apply it
with `airkit repair codex-transcript --write`. AirKit backs up both plugin source
files, preserves the job log, and refuses to modify unrecognized plugin source.
