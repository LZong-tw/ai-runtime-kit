# Gotchas

- Completion-guard hooks must be gated by the actual provider model from the
  transcript, not only by the launch mode; a route switch can otherwise make
  Claude, Kimi, or GLM inherit GPT/DeepSeek-only stop feedback.
- A full subagent transcript may remain on disk for resume and audit, but the
  parent model context must receive only a bounded final result when an Agent,
  Task, or TaskOutput response is transcript-like.
