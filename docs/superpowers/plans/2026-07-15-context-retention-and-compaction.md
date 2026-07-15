# Context Retention and Compaction Implementation Plan

> Execute task-by-task with test-driven development. Each task touches at most
> five files, ends with full verification, review, commit, and an explicit phase
> checkpoint.

**Goal:** Keep routed non-Claude Claude Code sessions effective over long
conversations without changing global model or settings ownership.

**Design:** Use profile-scoped child environment for proactive compaction, a
small managed prompt heartbeat for salience, and a bounded task capsule restored
through Claude Code lifecycle hooks.

## Global constraints

- Shared runtime behavior belongs in OSS.
- Public files contain no private endpoints, organizations, credential-manager
  references, or secret values.
- Never write global Claude/Codex settings or persist a model.
- Cache details are optional; total input usage must remain truthful and non-zero.
- Do not add a compaction fallback without a captured stable discriminator.

### Task 1: Profile-scoped proactive compaction

**Files:**

- Modify `src/airkit.mjs`
- Modify `test/airkit.test.mjs`
- Modify `docs/profile-schema.md`

- [x] Add a failing test for child-only compaction environment.
- [x] Implement `launch.context.autoCompactWindow` and
  `launch.context.autoCompactPercentage`.
- [x] Add failing invalid-policy tests and strict catalog validation.
- [ ] Run focused tests, full tests, syntax/check, and package verification.
- [ ] Review, commit, and push Task 1.

### Task 2: Bounded AirClaude heartbeat

**Files:** at most five across the context module, runtime renderer, and tests.

- [ ] Capture the exact `UserPromptSubmit` input/output contract from the
  supported Claude Code release.
- [ ] Write failing tests proving the heartbeat is AirClaude-only, bounded,
  factual, and contains no credentials or provider-private payloads.
- [ ] Render a managed hook/plugin without replacing user hooks or settings.
- [ ] Verify startup, resume, and ordinary prompt behavior in isolation.
- [ ] Review, commit, and push Task 2.

### Task 3: Task capsule and lifecycle restoration

**Files:** at most five across the context module, runtime prompt, and tests.

- [ ] Write failing tests for the task-capsule fields and size budget.
- [ ] Extend the stable compaction contract to preserve objective, constraints,
  decisions, files, verification, repository state, and next action.
- [ ] Re-inject current route plus bounded capsule on startup, resume, clear, and
  compact while leaving unrelated user hooks intact.
- [ ] Verify manual compact and resume with an isolated fake Claude session.
- [ ] Review, commit, and push Task 3.

### Task 4: Usage and context observability

**Files:** at most five across doctor/reporting, tests, and docs.

- [ ] Add fixtures for total-only usage and usage with cache details.
- [ ] Prove compaction accounting remains non-zero in both cases.
- [ ] Report context-window source and cache-detail availability without
  inventing cache hits.
- [ ] Document `/model/info` as metadata, not completion-response state.
- [ ] Review, commit, and push Task 4.

### Task 5: Compaction fallback decision

**Files:** isolated verifier and fixtures only until the discriminator is proven.

- [ ] Capture manual and automatic compaction requests from the supported Claude
  Code version.
- [ ] Compare them with ordinary long-context and tool-heavy requests.
- [ ] If a stable protocol discriminator exists, design an explicit
  Anthropic-family fallback policy and obtain approval before implementation.
- [ ] If no stable discriminator exists, record the negative result and keep
  compaction on the active route.

### Task 6: Internal opt-in and live verification

Internal-only profile data remains in the private overlay.

- [ ] Add the reviewed context policy to the internal profile and example.
- [ ] Run internal tests and checks.
- [ ] Preview profile update; obtain explicit approval before any live write.
- [ ] Verify dry-run arguments, statusline, long-session usage, manual compact,
  auto compact, resume, and unchanged saved model behavior.
- [ ] Update internal operating docs, commit, and push.
