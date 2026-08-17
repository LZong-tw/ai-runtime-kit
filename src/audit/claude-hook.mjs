export async function processAuditHook(input, dependencies = {}) {
  const emit = typeof dependencies?.emit === "function"
    ? dependencies.emit.bind(dependencies)
    : typeof dependencies?.auditEmitter?.emit === "function"
      ? dependencies.auditEmitter.emit.bind(dependencies.auditEmitter)
      : null;
  if (!emit) return null;
  const sessionId = safeId(input?.session_id);
  const logicalRequestId = safeId(input?.logical_request_id ?? input?.request_id) ??
    (sessionId ? `claude:${sessionId}` : null);
  const base = {
    event_version: 1,
    source: "claude-code",
    source_version: "hook-v1",
    source_event_id: safeId(input?.uuid),
    observed_at: safeTimestamp(input?.timestamp),
    logical_request_id: logicalRequestId,
    session_id: sessionId,
    client: "claude-code",
  };
  const events = [];
  if (["SessionStart", "SessionEnd"].includes(input?.hook_event_name)) {
    events.push({ ...base, event_kind: "session_context", payload: {
      lifecycle: input.hook_event_name,
      source: safeId(input.source),
    } });
  }
  if (input?.hook_event_name === "UserPromptSubmit") {
    if (events.length === 0) events.push({ ...base, event_kind: "session_context", payload: { lifecycle: "active" } });
    events.push({ ...base, event_kind: "request_started", payload: {
      prompt_bytes: typeof input.prompt === "string" ? Math.min(Buffer.byteLength(input.prompt), 65_536) : 0,
    } });
  }
  for (const event of events) {
    try {
      await emit(event);
    } catch {
      // Audit is additive and must never block the host hook chain.
    }
  }
  return null;
}

function safeId(value) {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value) ? value : null;
}

function safeTimestamp(value) {
  return typeof value === "string" && !Number.isNaN(Date.parse(value)) ? value : new Date().toISOString();
}
