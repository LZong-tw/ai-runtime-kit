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
