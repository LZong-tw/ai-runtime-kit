# Codex Config Takeover Guard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent CCR global Codex profiles from rewriting the user's real Codex configuration, and provide a preview-first, backup-backed repair command for machines already affected.

**Architecture:** A focused guard module detects CCR takeover markers and enabled global Codex profiles, produces a pure repair plan, and applies the repair transaction only after preserving the latest Codex config bytes. `airkit` blocks ordinary launches before CCR RPC when takeover evidence exists, validates live CCR profiles before saving, and exposes `airkit repair codex-takeover [--write]`; preview mode may inspect an already-running management service but must never start CCR.

**Tech Stack:** Node.js 22 ESM, CCR 3 management RPC, TOML text block surgery, `node:test`.

## Global Constraints

- Node.js remains `>=22`; Claude Code remains `>=2.1.208`; CCR remains `>=3.0.4 <4`.
- OSS contains no company names, private endpoints, credential references, or secret values.
- Never run the CCR CLI during tests or live diagnosis.
- Never persist a default Codex model or replace the user's latest config with a stale CCR backup.
- Ordinary `airclaude`, `hr-*`, and `claude-sub` usage remains unchanged after the one-time repair.
- Preview mode performs no filesystem writes and must not auto-start CCR.
- Write mode creates a byte-exact backup before any CCR RPC that can reconcile global profiles.
- The repaired Codex text preserves every non-CCR byte and removes only exact comment-delimited CCR managed profile/provider blocks.
- The repair changes enabled global Codex profiles to `scope: "ccr"` and `showAllSessions: true`; it does not delete profiles or providers.
- No task touches the paused compatibility plugin worktree or live state during implementation tests.

---

## File map

- `src/codex-takeover-guard.mjs`: pure detection, exact managed-block stripping, repair planning, backup-first transaction, atomic restore, and verification.
- `test/codex-takeover-guard.test.mjs`: byte-preservation, profile normalization, preview, transaction order, and failure recovery.
- `src/airkit.mjs`: preflight integration, non-starting preview client, repair CLI, and output.
- `test/airkit.test.mjs`: launch/RPC ordering and CLI regressions.
- `docs/superpowers/plans/2026-07-15-codex-config-takeover-guard.md`: executable hotfix plan.

### Task 1: Build the backup-first Codex takeover guard

**Files:**
- Create: `src/codex-takeover-guard.mjs`
- Create: `test/codex-takeover-guard.test.mjs`

**Interfaces:**
- Produces: `inspectCodexTakeover({ ccrConfig?, codexConfigText?, takeoverText? })`.
- Produces: `stripCcrManagedCodexBlocks(text) -> string`.
- Produces: `repairCcrCodexProfiles(config) -> object`.
- Produces: `repairCodexTakeover({ ccrClient, env, write, io?, now? }) -> Promise<object>`.

- [ ] **Step 1: Write failing pure detection and preservation tests**

Create fixtures with exact `# BEGIN CCR managed profile`, `# END CCR managed profile`, `# BEGIN CCR managed Codex provider`, and `# END CCR managed Codex provider` delimiters. Assert that stripping removes only those ranges, preserves the latest surrounding bytes exactly, is idempotent, and leaves an unmarked user-created `[model_providers.claude-code-router]` section untouched. Assert that an enabled `agent: "codex", scope: "global"` profile targeting `~/.codex/config.toml` is hazardous, while disabled or `scope: "ccr"` profiles are not.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
node --test test/codex-takeover-guard.test.mjs
```

Expected: fail with `ERR_MODULE_NOT_FOUND` for `src/codex-takeover-guard.mjs`.

- [ ] **Step 3: Implement pure detection and repair planning**

Use exact anchored comment delimiters; do not parse or reserialize unrelated TOML. Deep-clone CCR config and change only hazardous profiles to:

```js
{
  ...profile,
  scope: "ccr",
  showAllSessions: true,
}
```

Return an inspection object with booleans/counts and public-safe paths/actions, never config contents or profile secrets.

- [ ] **Step 4: Write failing transactional repair tests**

Use injected in-memory I/O and a scripted CCR client. Prove this order in write mode:

1. read latest Codex bytes;
2. write byte-exact timestamped backup;
3. call `getConfig`;
4. call `saveConfig` with repaired scopes;
5. atomically replace Codex config with the sanitized latest snapshot;
6. re-read and verify no managed markers.

Add failure cases where `getConfig` or `saveConfig` mutates the target then throws; the transaction must still restore the sanitized latest snapshot and report the backup path without exposing file contents. Preview must perform zero writes and must not call `saveConfig`.

- [ ] **Step 5: Implement the transaction and verify GREEN**

Use same-directory temporary files plus rename for atomic replacement. Preserve the original file mode when available. Run:

```bash
node --test test/codex-takeover-guard.test.mjs
node --check src/codex-takeover-guard.mjs
```

Expected: all focused tests pass.

- [ ] **Step 6: Commit Task 1**

```bash
git add src/codex-takeover-guard.mjs test/codex-takeover-guard.test.mjs
git commit -m "fix: guard Codex config from CCR takeover"
```

### Task 2: Integrate launch preflight and repair CLI

**Files:**
- Modify: `src/airkit.mjs`
- Modify: `test/airkit.test.mjs`

**Interfaces:**
- Consumes all Task 1 exports.
- Extends: `createCcr3Client({ autoStart? })`; `autoStart: false` must never invoke `ccr start`.
- Adds CLI: `airkit repair codex-takeover [--write]`.

- [ ] **Step 1: Write failing launch-preflight tests**

Assert that a managed marker or Codex entry in `global-profile-takeover.json` stops `prepareLaunch` before `createCcr3Client`, `getVersion`, `getConfig`, credential resolution, `saveConfig`, gateway start, or spawn. Assert that a running CCR config containing an enabled global Codex profile stops before `saveConfig`. Error text must name the preview/write repair command and contain no config content.

- [ ] **Step 2: Write failing client and repair CLI tests**

Assert `createCcr3Client({ autoStart: false })` rejects a missing/stale service without calling the runner. Assert preview calls the guard with a non-starting client, prints affected paths/actions, and performs no writes. Assert `--write` uses the backup-first transaction and reports backup/restored paths without values.

- [ ] **Step 3: Run targeted tests and verify RED**

Run:

```bash
node --test --test-name-pattern='Codex takeover|codex-takeover|autoStart' test/airkit.test.mjs
```

Expected: fail because the preflight, client option, and CLI command are absent.

- [ ] **Step 4: Implement the minimal integration**

Run filesystem preflight only for non-dry-run/non-doctor launches and before constructing or calling the CCR client. After `getConfig`, reject any live hazardous profile before credential resolution or `saveConfig`. Handle `repair codex-takeover` before catalog loading. Preview uses `autoStart: false`; write mode may start CCR only inside the guard transaction after the byte-exact backup exists.

- [ ] **Step 5: Verify the complete hotfix surface**

Run:

```bash
node --test test/codex-takeover-guard.test.mjs
node --test test/airkit.test.mjs
npm test
npm run check
npm_config_cache=/tmp/airkit-npm-cache npm run pack:check
git diff --check
rg -n -i "oneportal|kkcompany|op://|anthropic_auth_token" src/codex-takeover-guard.mjs test/codex-takeover-guard.test.mjs src/airkit.mjs test/airkit.test.mjs
```

Expected: all tests/checks pass; private scan has no matches.

- [ ] **Step 6: Commit Task 2**

```bash
git add src/airkit.mjs test/airkit.test.mjs
git commit -m "feat: add safe CCR Codex repair command"
```

## Live repair verification

After both tasks pass and independent review is clean:

```bash
node src/airkit.mjs repair codex-takeover
node src/airkit.mjs repair codex-takeover --write
```

The first command must be read-only and must not start CCR. The write command requires explicit sandbox approval, creates a backup, repairs global Codex profile scope, restores the latest non-CCR Codex config, and verifies markers are gone. Re-run the preview and Codex thread listing afterward. Do not delete CCR backups/catalogs until the user confirms the app behavior is restored.

## Self-review

- Spec coverage: prevents pre-RPC takeover, prevents live-config save takeover, repairs existing state, preserves latest bytes, and gives preview/write UX.
- Placeholder scan: no deferred implementation or unspecified error behavior remains.
- Type consistency: Task 2 consumes the exact Task 1 exports; repair client creation is delayed until after the snapshot/backup boundary.
- Scope: five tracked files total in this phase; documentation and internal gotcha updates are deferred to the next approved phase.
