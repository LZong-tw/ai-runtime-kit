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
| `same-target-repeat` | PostToolUse (PostToolUseFailure counts only) | Within one turn: the identical call returns the identical result for the third time, or the same rare identifier appears in a fifth call. |

## same-target-repeat

Added in rule set 8 for a Kimi-K3 turn (2026-11-05) that queried one
ReplicaSet 78 times across 96 Bash calls without stepping back to ask where its
image was set. Neither `same-result-poll` (each output differed) nor the error
rules (nothing failed) saw it.

Two triggers, each counted per actor and per user turn:

- `same-input`: the identical call with the identical result for the third
  time. Call identity is the same as `blocked-retry`'s: tool plus input, with a
  Bash `description`, a leading `cd` and whitespace ignored. The result is part
  of the count, so a poll whose output changes (pod `AGE`, check progress) is
  not a repeat; a poll whose output stays the same is, and is logged.
- `same-identifier`: the same rare identifier in a fifth call. Identifiers are
  hex runs of 7–64 characters with both a digit and a letter (commits, digests,
  hashes), UUIDs, and Kubernetes name hashes (8–10 characters of
  `bcdfghjklmnpqrstvwxz2456789` with a digit and a letter). Skipped: words
  inside paths (two or more slashes, or a leading `/`, `./`, `../`, `~/`), URLs,
  scoped packages (`@scope/name`), `#`-prefixed hex (colours), and every `git`
  segment of a Bash command, because naming one commit across `git show`,
  `git diff` and `git log` is how a commit is reviewed. Bash is read from its
  command; other tools from their input without `description`.

Each target is logged once per turn, even across an edit; a second target logs
again. Only the read/query tools that `same-result-poll` watches count (`Bash`,
`Read`, `Grep`, `Glob`, `WebFetch`, `WebSearch`, `mcp__*`). A successful
`Edit`/`Write`/`MultiEdit`/`NotebookEdit`, or a Bash `git` command that changes
the work tree, index or refs (`add`, `commit`, `checkout`, `switch`, `reset`,
`restore`, `stash`, `merge`, `rebase`, `cherry-pick`, `revert`, `pull`,
`fetch`, `rm`, `mv`, `apply`, `am`), starts the counts over, because
re-reading after a change is progress. Only the subcommand after git's global
options (`-C <dir>`, `-c <key>=<value>`, `--git-dir=<path>`, ...) decides, so
quoted text such as `git log --grep='git add'` is still a read; `git stash`
counts as a change when bare or followed by `push`, `save`, `pop`, `apply`,
`drop`, `clear`, `store`, `branch` or an option, but not as `list`, `show` or
`create`. Waiting commands (`sleep`, `wait`,
`watch` including `--watch`, `rollout status`, and `kubectl ... -w`) are not
counted; `same-result-poll` shares this list. A failed call that ran (for
example a pipeline whose last `grep` matched nothing exits 1) counts but never
logs; the next successful call that reaches a limit does. A sandbox or
permission denial did not run and is left to `blocked-retry`, including a Bash
call that exits 0 with a sandbox denial on stderr. With `blocked-retry` off,
nobody owns sandbox denials and they count like any other call.

Each actor keeps the 200 most recently counted inputs and identifiers; an older
one drops out of the count when a newer one would be the 201st.

The log's `evidence` is `{ trigger, tool, target, count, calls }`: `target` is
the identifier, or for `same-input` the call hash; an identifier longer than 16
characters (a digest, a UUID) is logged as its hash only, while shorter hex ids
(commits, Kubernetes hashes) are logged as they are. `calls` is the actor's
counted call number in the turn, failed calls included. On the 2026-11-05 turn
the identifier fires at call 15 and the third identical call at call 32
(`test/education-loop-rules.test.mjs`).

The `enforce` hint: 「同一個目標已經反覆查了好幾次：先退一步，去找上游決定這個值的來源（設定、manifest、部署紀錄），不要再重查同一個地方」.
