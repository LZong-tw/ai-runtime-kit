# CCR 3 Hard-Cut Migration Plan

> **Execution rule:** complete and verify one phase at a time. Each phase touches no more than five files and stops for review before the next phase.

**Goal:** Require Claude Code 2.1.208 or newer, Claude Code Router 3.0.4 or newer, and Node.js 22 or newer while replacing the CCR 2 JSON/restart/activate lifecycle with CCR 3 managed profiles.

**Public boundary:** The OSS repository contains only generic provider examples, version policy, lifecycle code, and tests. Private endpoints, company names, credential references, model catalogs, and tokens stay in the internal overlay.

## Architecture

`airclaude` remains the user entrypoint, but it stops launching Claude Code directly. The OSS runtime will:

1. Validate Node.js, Claude Code, and CCR versions.
2. Resolve profile credentials without printing them.
3. Start the CCR 3 management service without forcing a gateway restart.
4. Read the current CCR configuration through its authenticated localhost management RPC.
5. Merge only AirKit-owned providers, routing rules, plugins, and `scope: "ccr"` agent profiles while preserving unrelated CCR data.
6. Save only when the merged configuration changed.
7. Launch `ccr <managed-profile-id> cli -- <claude args>`.

The management endpoint and token are discovered from CCR's `service.json`. AirKit must read the configured gateway host and port instead of assuming either 3456 or 8080.

## Version contract

- Node.js: `>=22`
- Claude Code: `>=2.1.208`
- Claude Code Router: `>=3.0.4 <4`

CCR 2 is unsupported. Errors must show the detected version, required range, and the non-destructive update command.

## Friendly update flow

Add `airkit runtime check` and `airkit runtime update`:

- `check` is read-only and reports installed and required versions.
- `update` defaults to a preview. It prints the npm commands and state paths it would touch.
- `update --write` backs up CCR 2 JSON and CCR 3 SQLite files, updates Claude Code and CCR with explicit package versions, and runs the same version and isolated launch checks afterward.
- A failed install or validation leaves the backup path in the error output and never deletes existing state.
- Tests use isolated `HOME`, `CCR_INTERNAL_HOME_DIR`, `CCR_INTERNAL_APP_DATA_DIR`, and `CCR_INTERNAL_USER_DATA_DIR` values so a migration probe cannot read real user or private configuration.

## Phase 1: Lock the public contract with failing tests

**Files:**

- Modify `test/airkit.test.mjs`.
- Add this plan.

Add tests for:

- package/runtime version requirements;
- CCR-only managed profiles for every AirClaude mode;
- preservation of unrelated CCR providers and profiles;
- no CCR 2 `restart`, `activate`, or live `config.json` sync in the launch path;
- explicit isolation of both `HOME` and CCR internal state paths.

Run `npm test` and confirm the new tests fail for missing CCR 3 behavior, not syntax or fixture errors.

## Phase 2: Implement the OSS runtime

**Files (maximum five):**

- Modify `src/airkit.mjs`.
- Modify `package.json`.
- Modify `test/airkit.test.mjs` only as needed to complete already-approved cases.
- Modify `docs/install.md`.
- Modify `README.md`.

Implement version parsing, CCR service discovery/RPC, ownership-aware configuration merge, managed profile launch, and the preview-first runtime update command. Delete obsolete v2 shell config-sync/restart/reaper code after the v3 path passes.

Verify with `npm run verify`, then inspect `npm pack --dry-run` output and scan the packed file list and contents for private identifiers.

## Phase 3: Port the internal overlay

The internal repository imports the OSS runtime and supplies private profile data only. Add matching version requirements and friendly command aliases without duplicating lifecycle behavior. Convert internal profile data to the OSS CCR 3 schema and preserve secrets as runtime-only values.

Verify with `npm test` and `npm run check`. Do not modify the user's existing unrelated catalog changes.

## Phase 4: Isolated end-to-end verification

Install CCR 3.0.4 and the migrated AirKit into `/tmp` with a fully isolated home and state directories. Validate:

- clean SQLite initialization;
- generic profile merge and idempotent second run;
- named profile resolution by the CCR CLI;
- gateway health on the configured port;
- Claude Code launch through CCR with a fake provider fixture;
- no reads or writes under the real home directory.

Only after the isolated checks pass should a global upgrade be proposed. A global install is not part of this plan unless separately approved.
