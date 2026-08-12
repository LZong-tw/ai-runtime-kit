# Provider-specific Headroom routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Route every managed CCR provider through the correct Headroom protocol endpoint so `/model` switches cannot bypass compression or reuse a stale proxy configuration.

**Architecture:** Extend `buildCcr3ManagedConfig` with a validated provider-name-to-base-URL map while retaining the two legacy scalar overrides. Harden the local zsh proxy helper with a persisted configuration fingerprint and run two protocol-complete proxies: OnePortal on 8804 and Web LiteLLM on 8807; disable Anthropic server-side Tool Search for the private Web gateway.

**Tech Stack:** Node.js 22 ESM, Node test runner, JSON CCR 3 profiles, zsh, Headroom 0.34.

## Global Constraints

- CCR contract remains `>=3.0.4 <4`; Node.js remains `>=22`.
- Provider map keys are source provider names, never managed IDs or secret values.
- Existing scalar `AIRCLAUDE_PROVIDER_BASE_URL` and `AIRCLAUDE_ANTHROPIC_PROVIDER_BASE_URL` remain supported.
- Invalid map input must fail before CCR state is written and must not print credentials.
- Direct `airclaude`, `claude-web`, and non-Headroom wrappers remain unchanged.
- Web private gateways must not receive Anthropic server-side Tool Search unless a live contract proves support.
- Every production change gets a failing test first and the full repository checks before completion.

---

### Task 1: Add provider-map validation and managed provider application

**Files:**
- Modify: `src/airkit.mjs` around `buildCcr3ManagedConfig` provider URL selection
- Test: `test/airkit.test.mjs` near the existing per-launch Headroom tests

**Interfaces:**
- Consumes `options.providerBaseUrl` and `options.anthropicProviderBaseUrl`.
- Produces optional `options.providerBaseUrls: Record<string,string>` behavior. Matching source provider entries receive the mapped URL; a map entry overrides either scalar URL. Accepted URLs are `http:` or `https:` and must use `/v1/chat/completions` for `openai_chat_completions` or `/v1/messages` for `anthropic_messages`.

- [x] **Step 1: Write the failing tests.** Add one test that maps `oneportal` and `oneportal-anthropic` while a scalar override is also present, asserting all matching managed providers receive the mapped URLs. Add a second test that rejects malformed JSON-like input, an unknown provider, a non-HTTP URL, and a protocol-mismatched path before invoking the CCR client.

- [x] **Step 2: Run the focused tests and verify RED.**

```bash
node --test --test-name-pattern='provider-specific Headroom|provider map' test/airkit.test.mjs
```

Expected: the new map test fails because the runtime currently ignores `providerBaseUrls`; validation cases fail because no map validator exists.

- [x] **Step 3: Implement the smallest runtime change.** Parse only an object map, validate each source provider against `baseConfig.Providers`, require a URL with the protocol-specific path, and select `providerBaseUrls[provider.name] ?? scalarOverride ?? provider.api_base_url` in the existing provider loop. Do not alter route selection or credential resolution.

- [x] **Step 4: Run focused tests and verify GREEN.**

```bash
node --test --test-name-pattern='provider-specific Headroom|provider map' test/airkit.test.mjs
```

Expected: all new cases pass.

- [x] **Step 5: Commit the runtime unit.**

```bash
git add src/airkit.mjs test/airkit.test.mjs
git commit -m "feat: support provider-specific Headroom URLs"
```

### Task 2: Wire all AirClaude providers through the two Headroom proxies

**Files:**
- Modify: `/Users/untionglim/.zshrc.local` in `_hr_proxy` and `hr-airclaude`
- Modify: internal profile launch environment generation only if the runtime needs a serialized map
- Test: `test/airkit.test.mjs` only if Task 1 needs an internal launch assertion

**Interfaces:**
- `_hr_proxy(port, anthropic_target, openai_target, mode, disable_kompress, tool_search, fingerprint)` starts a proxy with explicit targets and feature posture.
- `hr-airclaude` passes a JSON-safe `AIRCLAUDE_PROVIDER_BASE_URLS` value containing the four exact source providers and starts 8804/8807 with their matching upstreams.

- [x] **Step 1: Add a shell-level failing check.** Run `zsh -n` plus a small isolated function invocation that asserts the generated map has exactly the four provider keys and that Web startup requests `HEADROOM_TOOL_SEARCH=0`.

- [x] **Step 2: Verify RED against the current wrapper.**

```bash
zsh -n /Users/untionglim/.zshrc.local
```

Expected: syntax passes, but the isolated map assertion fails because `hr-airclaude` currently sets only `AIRCLAUDE_PROVIDER_BASE_URL` and starts only 8804.

- [x] **Step 3: Implement the wrapper wiring.** Extend `_hr_proxy` with explicit tool-search and fingerprint arguments; make `hr-airclaude` start 8804 for OnePortal and 8807 for Web LiteLLM, set `HEADROOM_TOOL_SEARCH=0` on both private-gateway proxies, and export the four-provider JSON map to `airclaude`. Preserve existing `hr-claude-web` behavior and do not expose tokens.

- [x] **Step 4: Verify shell behavior.**

```bash
zsh -n /Users/untionglim/.zshrc.local
zsh -ic 'source ~/.zshrc.local; typeset -fx hr-airclaude _hr_proxy'
```

Expected: syntax and function loading pass; the map contains exactly four source provider keys.

- [x] **Step 5: Commit the wrapper unit.**

```bash
git -C /Users/untionglim/projects/web/ai-runtime-kit add gotchas.md
git -C /Users/untionglim/projects/web/ai-runtime-kit commit -m "fix: route all AirClaude providers through Headroom"
```

The home-directory wrapper is not committed; record its exact path and verification output in the handoff.

### Task 3: Add proxy fingerprint lifecycle protection

**Files:**
- Modify: `/Users/untionglim/.zshrc.local` `_hr_proxy`
- Test: `/tmp` isolated shell test script, removed after verification

**Interfaces:**
- Fingerprint file: `$HOME/.headroom/proxy-<port>.fingerprint`.
- Fingerprint contents are non-secret canonical text containing port, mode, both target URLs, `HEADROOM_DISABLE_KOMPRESS`, and `HEADROOM_TOOL_SEARCH`.

- [x] **Step 1: Write the failing lifecycle test.** Start a temporary proxy metadata fixture with a stale fingerprint and assert `_hr_proxy` refuses reuse or replaces the process instead of returning success solely from `/health`.

- [x] **Step 2: Verify RED.**

```bash
zsh /tmp/verify-headroom-fingerprint.zsh
```

Expected: the stale fingerprint case currently reports reuse.

- [x] **Step 3: Implement fingerprint comparison.** Write the fingerprint atomically after readiness; on a healthy port compare the requested fingerprint, and stop/restart only when it differs. If the fingerprint is missing, return an actionable mismatch requiring `hr-stop` rather than guessing the running proxy's configuration.

- [x] **Step 4: Verify GREEN and clean up the isolated fixture.**

```bash
zsh /tmp/verify-headroom-fingerprint.zsh
rm -f /tmp/verify-headroom-fingerprint.zsh
```

Expected: matching fingerprints reuse; stale or missing fingerprints restart or fail closed.

### Task 4: Run provider probes and repository verification

**Files:**
- No production files; inspect generated CCR config and runtime logs.

- [x] **Step 1: Regenerate the internal managed profile.**

```bash
cd /Users/untionglim/projects/web/ai-runtime-kit
node src/airkit.mjs update --profile oneportal-lowcost --write
```

- [x] **Step 2: Assert the generated map and four provider endpoints.**

```bash
jq '.Providers | map({name, type, api_base_url})' ~/.config/ai-runtime-kit/ccr/oneportal-lowcost.json
```

Expected: the managed provider URLs are the intended Headroom endpoints when launched through `hr-airclaude`.

- [ ] **Step 3: Run direct and proxied tool-bearing probes.** The local 1Password authorization request timed out before credentials could be read, so no fresh live probe was run and no token was printed. Existing evidence remains: direct Web LiteLLM and Web proxy 8807 returned HTTP 200 for the same tool-bearing Opus request after server Tool Search was disabled. The current 8804/8807 processes were intentionally not interrupted; they have no AirKit fingerprint and are rejected by the new helper until the user runs `hr-stop` once.

- [x] **Step 4: Run complete checks.**

```bash
cd /Users/untionglim/projects/web/ai-runtime-kit-oss
npm test
npm run check
cd /Users/untionglim/projects/web/ai-runtime-kit
npm test
npm run check
```

- [x] **Step 5: Review status and release state.** Confirm no secrets or generated runtime state entered git. Do not push or publish until separately requested.
