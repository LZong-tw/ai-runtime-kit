# Claude Code request captures

Successive `POST /v1/messages` bodies from Claude Code 2.1.330 (`claude -p`),
used by `test/cache-prefix-stability.test.mjs` to replay real sessions through
the compatibility pipeline.

Capture setup: an isolated `HOME` and `CLAUDE_CONFIG_DIR`, a scratch project
directory, a dummy API key, and `ANTHROPIC_BASE_URL` pointed at a loopback
stub that answers with canned SSE (a `tool_use` per turn, then `DONE`). The
settings registered SessionStart, UserPromptSubmit, PreToolUse(Read) and
PostToolUse(Read) hooks that return a fixed `additionalContext` line. No
provider was called.

- `claude-code-2.1.330-hooks-image-resume.json`: three Read turns (the second
  returns a synthetic PNG), then a `--resume` turn. Requests 1-4 are one run;
  request 5 is the resumed run.
- `claude-code-2.1.330-toolsearch-activation.json`: ToolSearch
  `select:WebFetch`, a Read, then `DONE`. Claude Code inserts the WebFetch
  definition (still `defer_loading: true`) into `tools` from request 2 on.

Each file is `{description, capturedWith, sanitization, requests}` with
`requests[].{method, url, headers, body}`. Only `anthropic-beta`,
`anthropic-version`, `x-app`, `user-agent` and `x-claude-code-session-id`
headers are kept.

Sanitization is deterministic, so the same original text maps to the same
output in every request and cannot create drift of its own:

- paths become `/workspace/project`; the device id and session UUIDs become
  fixed placeholders;
- the main system prompt, tool descriptions over 80 characters and long
  Claude Code boilerplate paragraphs become
  `[elided <what>: N chars, sha256:<12 hex>]`.

Roles, block types, string versus array content, ordering, `cache_control`
placement, tool order, `input_schema`, `defer_loading` and the system block
layout are untouched.

What these captures show about the wire format:

- Hook output and the `# Environment` block arrive as inline `role: "system"`
  messages, always right after the user turn they belong to and in the same
  request.
- While an inline system message is the newest message it is sent as
  `[{type: "text", text, cache_control}]`; the next request sends the same
  message as a bare string.
- `cache_control` sits on the newest message's last block and on system
  blocks 1 and 2 only.
- No `# Environment update` message appeared; the test's synthetic session
  reconstructs one.

What they do not cover, so the synthetic session in the test does:

- No thinking blocks or signatures: the stub never streamed any, so the
  thinking-history guards (reasoning history, the Responses thinking rewrite,
  restricted thinking) are checked only against the synthetic shapes.
- No `tool_addition` block, so the deferred-tool activation allowance runs
  only on the synthetic turns, which also keep a second deferred tool that is
  never activated.
- No typed prompt that is later re-sent as a bare string.
