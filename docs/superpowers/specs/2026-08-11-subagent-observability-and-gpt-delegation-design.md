# Subagent observability and GPT delegation design

## Problem

Claude Code's live agent panel can collapse a running child's earlier prose
into a summary such as `Ran 3 shell commands`. The underlying child JSONL can
still contain that prose and tool activity, so this is a visibility failure,
not proof that AirKit removed the response. The collapsed panel makes a long
running child look idle and makes it difficult to distinguish useful work from
token burn.

GPT-backed routes also tend to delegate eagerly. Delegation is valuable for
genuinely independent work, but it should not be the default for linear work,
single queries, retries, or permission recovery.

## Goals

1. Make current child progress visible in the supported Claude Code agent
   panel without replacing the user's main `statusLine` / ccstatusline.
2. Preserve a complete, readable child timeline on disk for debugging and
   audit, while keeping raw JSONL as the source of truth.
3. Keep the parent model context unchanged: no child timeline, transcript, or
   tool result is injected back into the conversation.
4. Apply a conservative delegation policy to every GPT-backed AirClaude mode;
   leave Claude, DeepSeek, Kimi, GLM, and other families unchanged.

## Non-goals

- Patch, suppress, or otherwise alter Claude Code's native child-viewer
  compaction.
- Rewrite child JSONL, reorder history, change provider requests, or retain
  full tool outputs in a second model-visible context.
- Prevent an explicit user request, an active skill, or a project rule from
  creating a needed child agent.
- Treat a failed child as evidence that the parent should automatically create
  a duplicate replacement.

## Design

### Child timeline observer

The AirKit context plugin will install `SubagentStart`, `PostToolUse`, and
`SubagentStop` observers. They identify a child transcript from its
`transcript_path`, incrementally read only newly appended JSONL records, and
write an AirKit-owned timeline beside per-child observer state.

The timeline records, in timestamp order:

- assistant prose;
- tool name and lifecycle timestamp;
- a compact result marker for each tool; and
- the raw child JSONL path and byte offset needed for full forensic review.

Tool output bodies, secrets, and raw JSON objects are never copied into the
timeline. Oversized output is represented only by its byte size and source
path. Writes use a temporary file followed by rename, permissions are `0600`,
and state is keyed by parent session plus child identity. Parsing errors or an
unavailable transcript leave the original hook event untouched and are logged
as observer diagnostics rather than injected as model context.

`SubagentStop` flushes the final delta and records the final assistant message
when available. Re-reading from the persisted byte offset makes retries and
restarts idempotent; record identifiers and offsets prevent duplicate timeline
lines.

### Agent panel row

AirKit will generate a plugin `subagentStatusLine` command using a fixed,
generated absolute script path. This is a distinct Claude Code setting from
the user's `statusLine`, so ccstatusline remains their main status renderer.

For each active task, the command resolves the child transcript/timeline and
emits a short row containing:

- elapsed time and token count supplied by Claude Code;
- current or most recent tool;
- the latest assistant prose, safely single-lined and length bounded; and
- a stable fallback (`waiting for first event`) when no child record exists.

If task-to-transcript matching is ambiguous, the row must prefer no text over
the wrong child's text and include a diagnostic marker. The timeline remains
available even when Claude Code does not refresh a row.

### GPT delegation policy

Every catalog mode whose provider model is GPT receives the same concise
system addition:

- work directly by default;
- create a subagent only when the user explicitly asks, an active skill or
  project rule requires it, or at least three independent work streams gain
  from parallel execution;
- do not delegate linear work, a single lookup, a retry, or a permission
  failure; and
- do not create a duplicate/replacement agent while equivalent work is still
  active.

This is behavioral guidance, not a hard block: it preserves user-directed
delegation and existing required skills. It applies to all GPT-backed
AirClaude catalog modes, including OnePortal and Web LiteLLM variants.

## Verification

Automated coverage will use child-JSONL fixtures containing prose, tool calls,
large tool results, restarts, and duplicate records. It will verify that:

1. observer timelines retain all prose and tool metadata, omit raw tool
   bodies, are idempotent, and have restrictive permissions;
2. statusline rows show the latest tool/prose and never replace the user's
   main statusline configuration;
3. generated plugin files use an absolute command path and preserve existing
   hook behavior; and
4. every GPT catalog mode gets the policy while non-GPT modes do not.

Before release, run the OSS test and check commands, the internal overlay test
and check commands, then start a fresh AirClaude GPT session with a child.
Confirm the panel row updates, the timeline is readable on disk, and the
parent conversation receives no observer text.

## Rollback

The generated plugin files are additive. Removing the AirKit
`subagentStatusLine` and observer hooks returns Claude Code to its native
agent panel without changing session JSONL or provider routing. The GPT prompt
addition can be removed independently from the catalog.
