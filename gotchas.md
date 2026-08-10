# Gotchas

- Completion-guard hooks must be gated by the actual provider model from the
  transcript, not only by the launch mode; a route switch can otherwise make
  Claude, Kimi, or GLM inherit GPT/DeepSeek-only stop feedback.
