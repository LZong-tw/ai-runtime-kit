# Subagent observability

AirKit's subagent observability layer is a bounded, additive view over child
task activity. It exists to make long-running child work easier to inspect
without replacing Claude Code's own transcripts, hooks, or task model.

## What it observes

When the AirKit context plugin is installed, the generated hook script listens
to `SubagentStart`, `PostToolUse`, and `SubagentStop`, then incrementally
projects child JSONL into an AirKit-owned timeline under plugin data. The
projection keeps:

- assistant prose, redacted and bounded
- tool names
- tool-result byte counts
- bounded diagnostics when a child transcript is missing, malformed, truncated,
  or oversized

Raw child JSONL remains the source of truth. The AirKit projection is a
secondary read model for quick status and audit-friendly review.

## What it does not do

- It does not rewrite the child transcript.
- It does not inject timeline text into the parent model context.
- It does not persist raw tool output in the timeline/statusline view.
- It does not invent missing child text when the transcript is ambiguous or
  unavailable.
- It does not replace the user's existing `statusLine` or ccstatusline.

For very large transcript-like child results returned through `Agent`, `Task`,
or `TaskOutput`, AirKit stores the full transcript as a local artifact and
replaces the parent-visible result with a bounded summary plus the artifact
path. Ordinary long tool output is left alone.

## Bounded-state rules

The observer is intentionally capped so one child cannot take over the session:

- reads at most one bounded transcript chunk per hook pass
- parses newline-complete JSON records only
- keeps at most 200 projected entries, 500 seen-record fingerprints, and 20
  diagnostics
- bounds persisted state reads to 1 MB
- keeps assistant text bounded before persistence and display
- stores timeline and state files with owner-only permissions

If a record is malformed or too large, the observer records a diagnostic and
continues. If a child transcript is truncated, the projection restarts from an
empty bounded state instead of guessing continuity.

## Statusline behavior

AirKit generates an additive `subagentStatusLine` command. Each row tries to
join the current task metadata to one observed child timeline and then shows:

- the task label
- a model/route label when one can be derived safely
- the latest assistant progress line
- the latest tool name, if any
- live task metadata such as status, elapsed time, and token counts

If no safe match exists yet, the row says `waiting for first event`. If more
than one child could match the same task, the row says `ambiguous child
transcript`. In both cases AirKit prefers an explicit gap over made-up prose.

The row is a compact view, not a full transcript browser. It surfaces only the
latest assistant text and tool marker, and it may show a sanitized route/model
label derived from task metadata or the active AirKit route environment.

## Reading the timeline correctly

The generated `timeline.md` is meant for bounded inspection:

- `assistant:` lines are the retained child progress text
- `tool:` lines name invoked tools
- `tool result:` lines record only byte counts
- trailing diagnostic lines explain why a child has missing or partial history

Use the timeline to answer "what did this child most recently do?" Use the raw
child JSONL when exact ordering, full text, or every tool result matters.

## Relationship to GPT delegation and completion guards

Subagent observability is separate from delegation policy. AirKit can display a
child task only after one exists; it does not create children on its own. GPT
delegation guidance remains "work directly by default" and only delegate when
parallel work is genuinely justified or explicitly requested.

The completion guard is separate again. It can remind some GPT/DeepSeek turns
to finish after tool use, but it does not force subagent creation and does not
change how child transcripts are projected.
