# Gotchas

- Completion-guard hooks must be gated by the actual provider model from the
  transcript, not only by the launch mode; a route switch can otherwise make
  Claude, Kimi, or GLM inherit GPT/DeepSeek-only stop feedback.
- A full subagent transcript may remain on disk for resume and audit, but the
  parent model context must receive only a bounded final result when an Agent,
  Task, or TaskOutput response is transcript-like.
- Missing text inside Claude Code's live subagent viewer is not evidence that
  the parent-result guard removed it. Check the child JSONL, the parent
  PostToolUse event, and whether a transcript artifact was created separately;
  the viewer can collapse earlier child text into a tool-count summary before
  the Agent has returned anything to the parent.
- A per-process Headroom base URL must apply only to the provider selected by
  that launch mode. Writing one OpenAI override onto every managed OpenAI
  provider leaks a OnePortal proxy into Web LiteLLM routes and turns valid Web
  credentials into misleading 401 responses.
- A successful qualified-route probe proves only that exact provider and model.
  Before declaring an existing multi-model session repaired, verify each failed
  `/model` route from its request log, including provider, model, tool count,
  upstream stage, and the adapter process start time.
- Claude Code statusline task identities are not the same fields as lifecycle
  hook identities. Persist the hook's agent labels and resolve statusline rows
  by a unique parent plus label; do not turn a missing direct id match into an
  ambiguous row when bounded live metadata is still available.
- A compatibility executor must preserve an upstream HTTP failure status and
  safe retry headers. Turning a provider 429 JSON error into a generic 502
  hides backoff guidance and makes Claude Code retry rapidly until tool work is
  interrupted; the adapter must not retry request bodies itself because that
  can duplicate tool side effects.
- A provider failure must be grounded in the raw upstream request record before
  proposing credential or gateway changes; inspect provider, model, status,
  duration, request shape, and fallback availability first.
- Claude Code 2.1.251 lifecycle hooks use `agent_transcript_path` on
  `SubagentStop` and may omit a transcript path on `SubagentStart`; normalize
  those fields and persist a pending identity instead of dropping the event.
- A unique native child identity must win over shared labels such as
  `Explore`; only fall back to labels when no identity matches, while keeping
  genuinely conflicting explicit identities ambiguous.
- A parent Agent launch record can be outside a small transcript tail after a
  long session. Read a bounded head plus tail (or a persisted incremental
  index), and keep `waiting for first event` as an evidence gap rather than a
  claim that no child event exists.
- Repeated model narration about empty user messages or interrupted commands
  is not emitted by the AirKit subagent statusline hook. Verify the raw Claude
  Code transcript and command lifecycle before changing the observer.
- Claude Code hook context can arrive as `role: system` inside `messages` after
  an assistant turn; OnePortal Anthropic rejects that ordering. Move those
  blocks to top-level `system` only at the compatibility boundary, while
  preserving raw passthrough bytes.
