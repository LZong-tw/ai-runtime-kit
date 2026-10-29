import { claudeFamilyLane, isAutoModeClassifierRequest } from "./config.mjs";

// Subagents ask for a Claude family (`model: "sonnet"` arrives as a bare
// `claude-sonnet-*` id), so bare-Claude routing sends them to the launch mode's
// Sonnet lane even after the user has switched the main thread with /model.
// With `followMainModel` enabled, the middleware remembers the main thread's
// latest explicit pick per Claude Code session and hands that exact model string
// to the session's subagents instead.
//
// Telling main from subagent traffic relies on Claude Code's gateway hint
// headers (`CLAUDE_CODE_GATEWAY_HINT_HEADERS=1`, set by the launcher). Without
// them nothing is learned and nothing follows: the mode's lanes apply as before.

const REQUEST_CLASS_HEADER = "x-claude-code-request-class";
const SESSION_HEADER = "x-claude-code-session-id";
const REQUEST_CLASSES = new Set(["main", "subagent", "workflow", "compaction", "auxiliary", "side_reply"]);
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export function requestClass(headers) {
  const value = headerValue(headers, REQUEST_CLASS_HEADER);
  return REQUEST_CLASSES.has(value) ? value : null;
}

export function requestSessionId(headers, body) {
  const fromHeader = headerValue(headers, SESSION_HEADER);
  if (fromHeader !== null) return SESSION_ID_PATTERN.test(fromHeader) ? fromHeader : null;
  const userId = body?.metadata?.user_id;
  if (typeof userId !== "string") return null;
  try {
    const sessionId = JSON.parse(userId)?.session_id;
    return typeof sessionId === "string" && SESSION_ID_PATTERN.test(sessionId) ? sessionId : null;
  } catch {
    return null;
  }
}

// One tracker per middleware process. Bounded so a long-lived launcher serving
// many resumed sessions cannot grow without limit.
export function createMainModelTracker({ maxSessions = 256, ttlMs = 86_400_000, now = Date.now } = {}) {
  const picks = new Map();
  return {
    observe(sessionId, model) {
      picks.delete(sessionId);
      if (typeof model !== "string") return;
      picks.set(sessionId, { model, at: now() });
      while (picks.size > maxSessions) picks.delete(picks.keys().next().value);
    },
    pick(sessionId) {
      const entry = picks.get(sessionId);
      if (entry === undefined) return null;
      picks.delete(sessionId);
      if (now() - entry.at > ttlMs) return null;
      picks.set(sessionId, entry);
      return entry.model;
    },
  };
}

// Returns a function that takes a parsed request body and its headers and
// returns the followed body, or null when the request keeps its own model.
// Main-thread requests are observed on the way through and never rewritten.
export function createMainModelFollower(config, tracker = createMainModelTracker()) {
  const settings = config?.followMainModel;
  if (settings?.enabled !== true) return () => null;
  const launchModel = config.launchModel ?? null;
  return (body, headers) => {
    if (body === null || typeof body !== "object" || typeof body.model !== "string") return null;
    const cls = requestClass(headers);
    if (cls === null) return null;
    const sessionId = requestSessionId(headers, body);
    if (sessionId === null) return null;
    if (cls === "main") {
      tracker.observe(sessionId, isExplicitPick(body.model, launchModel) ? body.model : null);
      return null;
    }
    if (!settings.roles.includes(cls)) return null;
    if (!settings.lanes.includes(claudeFamilyLane(body.model))) return null;
    // The auto-mode classifier sends a Sonnet id; it must stay on the cheap
    // lane whatever header it carries.
    if (isAutoModeClassifierRequest(body)) return null;
    const pick = tracker.pick(sessionId);
    return pick === null || pick === body.model ? null : { ...body, model: pick };
  };
}

// The launch id and a /model pick of a Claude family (Sonnet, Opus, Haiku) are
// not picks to follow: the family pick already has its own lane, and following
// it would move every Sonnet subagent onto, say, the mode's Opus lane. Anything
// else — CCR route ids, provider-qualified selectors, airkit aliases — is.
function isExplicitPick(model, launchModel) {
  return model !== "" && model !== launchModel && claudeFamilyLane(model) === null;
}

function headerValue(headers, name) {
  if (headers === null || typeof headers !== "object") return null;
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === name);
  const raw = Array.isArray(entry?.[1]) ? entry[1][0] : entry?.[1];
  return typeof raw === "string" && raw.trim() !== "" ? raw.trim() : null;
}
