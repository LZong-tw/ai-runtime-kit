# Education hooks: loop rules

The education hooks (enabled per profile, see
[profile-schema.md](profile-schema.md#education-hooks)) log every decision to
`~/.claude-code-router/logs/airkit-education.jsonl`. In `shadow` a record has
`emitted: false` and Claude Code sees nothing; in `enforce` a hint is added as
`additionalContext` when the acting model is not Claude. Every record carries
`rules`, the rule set version (currently 8), so
`airkit education report --rules 8` reads one rule set only.

The loop rules look at one actor at a time: the main thread, or one subagent
(`agent_id`).

| Rule | Event | Fires when |
| --- | --- | --- |
| `same-result-poll` | PostToolUse | Five different queries in a row return the same non-empty result, within one turn and ten minutes, with no edit between them. |
| `cli-flag-guess` | PostToolUse, PostToolUseFailure | One Bash program fails on its arguments or config three times in a row and its full `--help` has not been read in the session. |
| `blocked-retry` | PreToolUse | The same call is retried after a sandbox or permission denial (a transient classifier denial on its second retry). |
| `same-target-repeat` | PostToolUse | Within one turn: the identical call runs for the third time, or the same rare identifier appears in a fifth call. |

## same-target-repeat

Added in rule set 8 for a Kimi-K3 turn (2026-11-05) that queried one
ReplicaSet 78 times across 96 Bash calls without stepping back to ask where its
image was set. Neither `same-result-poll` (each output differed) nor the error
rules (nothing failed) saw it.

Two triggers, each counted per actor and per user turn:

- `same-input`: the identical call for the third time. Identity is the same as
  `blocked-retry`'s: tool plus input, with a Bash `description`, a leading `cd`
  and whitespace ignored.
- `same-identifier`: the same rare identifier in a fifth call. Identifiers are
  hex runs of 7–64 characters with both a digit and a letter (commits, digests,
  hashes) and Kubernetes name hashes (8–10 characters of
  `bcdfghjklmnpqrstvwxz2456789` with a digit and a letter). Words inside paths
  (two or more slashes, or a leading `/`, `./`, `../`, `~/`) and URLs are skipped. Bash
  is read from its command; other tools from their input without
  `description`.

Each target is logged once per turn; a second target logs again. Only the
read/query tools that `same-result-poll` watches count (`Bash`, `Read`, `Grep`,
`Glob`, `WebFetch`, `WebSearch`, `mcp__*`). An `Edit`/`Write`/`MultiEdit`/
`NotebookEdit` starts the counts over, because re-reading after a change is
progress, and waiting commands (`sleep`, `wait`, `watch`, `rollout status`)
are not counted. Failed calls are left to `blocked-retry` and the error rules.

The log's `evidence` is `{ trigger, tool, target, count, calls }`: `target` is
the identifier, or for `same-input` the call hash; an identifier longer than 16
characters is logged as its hash only. `calls` is the actor's counted call
number in the turn. On the 2026-11-05 turn the identifier fires at call 15 and
the third identical call at call 32 (`test/education-loop-rules.test.mjs`).

The `enforce` hint: 「同一個目標已經反覆查了好幾次：先退一步，去找上游決定這個值的來源（設定、manifest、部署紀錄），不要再重查同一個地方」.
