# Early-final corpus

`corpus.jsonl` holds 161 labelled GPT final answers for the early-final rule
(plan: `docs/superpowers/plans/2026-11-09-completion-guard-v2.md`).

Sources:

- `hist-*`: the 94 finals the legacy Stop guard blocked between 2026-08-04 and
  2026-08-31, before `c161546` removed its Stop hook.
- `miss-*`: two early finals from 2026-08-25 the legacy guard let through
  because its one-block budget was spent.
- `post-*`: GPT finals from 2026-08-31 to 2026-11-07, when only the prompt
  rule was left. Every final matching the promise, question or user-nudge
  regexes is included, plus the known misses and 30 random others (seed
  20261109). Duplicates of the same final are dropped.

Records only carry the last 400 characters of the final, after redaction.
URLs, hosts, paths, file names, ticket and MR numbers, account IDs, hashes and
internal service names are replaced with placeholders (`[url]`, `[path]`,
`[ticket]`, `![mr]`, `[hex]`, `[name]`, `[service]`, ...). The user's prompt
is not stored; `prompt_kind` says whether the turn began with a normal prompt,
a compaction continuation or a teammate message. `source_ref` is a truncated
SHA-256 of the transcript reference. The unredacted master stays on the owner's machine, outside every repository, so it can be looked
up locally without the reference itself being published.

## Fields

| Field | Meaning |
|---|---|
| `turn_tools` | tool calls in the turn before this final |
| `compact_in_turn` | a compaction happened between the user prompt and this final |
| `background_running` | background agents, workflows, teammates or shells launched and not yet reported finished when the final was written. Derived from the transcript (launch results vs. task notifications); approximate |
| `prior_blocks_in_turn` | legacy Stop blocks already spent in this turn |
| `legacy_label` | outcome of the legacy guard's continuation, from the 2026-11-08 review |
| `truth` | `premature`, `legitimate` or `unclear`: was the final actually too early |
| `expected` | what the v2 rule should decide: `continue` or `allow` |
| `reason` | why: the pattern behind `continue`, or the stop condition behind `allow` |
| `reason_source` | `manual`, or `heuristic` for unreviewed `allow` reasons |
| `difficulty` | `easy`, `medium` or `hard`. `hard` means no textual cue a rule can use |
| `must_allow` | finals where the legacy guard's continuation did harm or a user gate must hold. A v2 block on any of these fails the test |
| `next_step_touches_production` | the stated next step is a read-only production query. Four `continue` records carry it; whether they stay `continue` is an open policy decision (plan §6 item 7) |

`truth` and `expected` differ on purpose for a few records. A premature final
with background work still running is `expected: allow` (design rule 2), as is
a compaction capsule emitted as the final (rule 1). These show what the design
gives up.

Labels come from one reviewer (the 2026-11-08 review plus a second pass on
2026-11-09). Treat the corpus as a regression set, not ground truth for
precision estimates. The shadow window is what measures the rule.

Before this branch is pushed anywhere public, the owner must review the
redacted tails.
