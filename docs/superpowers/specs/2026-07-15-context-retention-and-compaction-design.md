# Context Retention and Compaction Design

## Problem

Claude Code keeps its system prompt across requests and compaction, but a long
conversation can still lose task salience on routed non-Claude models. Static
tool instructions remain present while the active objective, accepted
decisions, verification state, and next action become distant or are omitted
from a compaction summary.

OpenAI-compatible gateways also vary in usage detail. Some return only total
prompt and completion tokens, while others additionally expose cache-read and
cache-creation counters. Cache detail must improve observability without being
required for compaction safety.

## Goals

- Keep global Claude settings and the user's saved model choice untouched.
- Let a profile select an earlier, child-only auto-compaction window without
  disabling the model's larger real context window.
- Keep stable instructions cache-friendly while placing a bounded reminder
  close to new user prompts on routed non-Claude sessions.
- Preserve a compact task capsule: objective, constraints, decisions, changed
  files, verification state, repository state, and next action.
- Restore current route and task state after startup, resume, clear, and
  compaction without exposing credentials.
- Treat cache counters as optional; a truthful non-zero total input count is the
  compaction requirement.

## Profile Contract

Profiles may define:

```json
{
  "launch": {
    "context": {
      "autoCompactWindow": 300000,
      "autoCompactPercentage": "default"
    }
  }
}
```

`autoCompactWindow` maps to `CLAUDE_CODE_AUTO_COMPACT_WINDOW` in the managed
AirClaude child only. It does not change the model, the model's real context
window, or the status line's full-window percentage.

`autoCompactPercentage` accepts an integer from 1 through 100, or `"default"`.
The latter places an empty `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` in the child
environment so an unrelated inherited override cannot defeat the profile's
window policy. An absent field preserves normal inheritance. Context-policy
values are applied after generic `launch.env` values so the validated policy is
authoritative for its two managed keys.

## Retention Layers

1. **Stable system contract.** Keep invariant tool and routing rules in the
   existing appended system prompt. It remains stable for prompt caching.
2. **Bounded heartbeat.** A managed `UserPromptSubmit` hook may add a short
   factual reminder only when an AirClaude profile is active. It contains no
   transcript history and no secrets.
3. **Compaction contract.** The stable prompt tells the summarizer to preserve
   the task capsule. A managed `SessionStart` hook for startup, resume, clear,
   and compact re-injects current route metadata and any bounded durable task
   capsule available in the workspace.

The heartbeat must not repeat the full onboarding prompt. The task capsule is
bounded, sourced from explicit workspace state or the current compaction
summary, and never reconstructed from provider-private data.

## Compaction Routing

CCR 3 exposes only default and background managed routes. AirKit must not
restore removed CCR 2 `longContext` routing fields or guess that an ordinary
request is compaction from broad text patterns.

Before adding an Anthropic-family compaction fallback, the isolated verifier
must capture a current Claude Code compaction request and prove a stable,
protocol-level discriminator. If none exists, compaction stays on the active
route and relies on the explicit task-capsule contract plus the earlier window.

## Safety

- No global Claude settings writes.
- No persisted model override.
- No Codex configuration or session mutation.
- No credentials in argv, hook output, transcripts, or public profiles.
- Profile validation fails closed on unknown context fields and invalid bounds.
