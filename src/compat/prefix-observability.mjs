import { createHash } from "node:crypto";
import { isAutoModeClassifierRequest } from "./config.mjs";
import { requestClass, requestSessionId } from "./model-follow.mjs";

// This is intentionally an observation of a cache candidate, not a provider
// cache key. The forwarded Claude request remains untouched; providers may
// apply additional boundaries or TTL rules that this local fingerprint cannot
// see.
export function describeStablePrefix(body, options = {}) {
  const wirePrefixHash = exactWirePrefixHash(options?.rawPrefixBytes);
  if (!isRecord(body) || !Array.isArray(body.messages)) {
    return {
      candidate: false,
      reason: "messages_unavailable",
      stablePrefixHash: null,
      stablePrefixBytes: null,
      stablePrefixMessages: null,
      ...(wirePrefixHash ? { wirePrefixHash } : {}),
    };
  }

  const stableMessages = body.messages.slice(0, -1);
  if (stableMessages.length === 0) {
    return {
      candidate: false,
      reason: "no_prior_messages",
      stablePrefixHash: null,
      stablePrefixBytes: null,
      stablePrefixMessages: 0,
      ...(wirePrefixHash ? { wirePrefixHash } : {}),
    };
  }
  const serialized = JSON.stringify({
    system: body.system ?? null,
    tools: body.tools ?? null,
    messages: stableMessages,
  });
  const bytes = Buffer.byteLength(serialized, "utf8");

  return {
    candidate: true,
    reason: null,
    stablePrefixHash: createHash("sha256").update(serialized).digest("hex"),
    stablePrefixBytes: bytes,
    stablePrefixMessages: stableMessages.length,
    ...(wirePrefixHash ? { wirePrefixHash } : {}),
  };
}

function exactWirePrefixHash(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" && !Buffer.isBuffer(value) && !(value instanceof Uint8Array)) {
    return null;
  }
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
  if (bytes.byteLength === 0) return null;
  return createHash("sha256").update(bytes).digest("hex");
}

// This classification is deliberately model-agnostic. It separates a request
// with no reusable prefix from a reusable-prefix hit or miss without claiming
// that the local fingerprint is the provider's cache key.
export function classifyCacheCohort(stablePrefix, promptCache) {
  const stablePrefixMessages = Number.isInteger(stablePrefix?.stablePrefixMessages)
    ? stablePrefix.stablePrefixMessages
    : null;
  if (stablePrefix?.candidate !== true) {
    return { state: "cold_start", stablePrefixMessages };
  }
  if (!isRecord(promptCache)) {
    return { state: "usage_unavailable", stablePrefixMessages };
  }
  const hit = nonNegativeCounter(promptCache.prompt_cache_hit_tokens);
  const miss = nonNegativeCounter(promptCache.prompt_cache_miss_tokens);
  if (hit === null && miss === null) {
    return { state: "usage_unavailable", stablePrefixMessages };
  }
  return {
    state: hit !== null && hit > 0 ? "reusable_prefix_hit" : "reusable_prefix_miss",
    stablePrefixMessages,
  };
}

// Provider prompt caches match on the rendered prompt: tools, then system,
// then messages. Claude Code moves its cache_control marker to the newest
// message every turn and providers ignore the marker when matching, so it is
// stripped. Everything else, key order included, must stay identical.
export function canonicalPrefixJson(value) {
  return JSON.stringify(value, (key, inner) => (key === "cache_control" ? undefined : inner));
}

// Claude Code re-sends the previous turn's trailing inline system message as a
// bare string after sending it as [{type:"text", cache_control}] (captured
// with 2.1.330). Only inbound comparisons may normalise this; outbound stays
// strict so airkit cannot hide a shape change.
export function canonicalTextShape(message) {
  if (typeof message?.content !== "string") return message;
  return { ...message, content: [{ type: "text", text: message.content }] };
}

// Runtime counterpart of the session replay test: one Claude Code thread sends
// an append-only history, so the prefix airkit forwards should only grow.
// Per thread, the tracker keeps fingerprints of the previous request as it
// arrived and as it went out, and names the first field that broke. Drift that
// was already in the inbound field is upstream (Claude Code, pxpipe);
// drift that only appears outbound was introduced by airkit. Fingerprints are
// truncated hashes held in memory only; results carry fields, indices and
// counts, never content.
export function createPrefixDriftTracker({ maxThreads = 256, ttlMs = 86_400_000, now = Date.now } = {}) {
  const threads = new Map();
  return {
    // Never throws: drift detection is diagnostics and must fail open.
    observe({ headers, inbound, outbound }) {
      try {
        return observePrefix(threads, { headers, inbound, outbound, maxThreads, ttlMs, at: now() });
      } catch {
        return null;
      }
    },
    get size() {
      return threads.size;
    },
  };
}

function observePrefix(threads, { headers, inbound, outbound, maxThreads, ttlMs, at }) {
  // Nothing went upstream (an early failure, or an injected client): no verdict.
  if (outbound === null || outbound === undefined) return null;
  const inboundBody = parseBody(inbound);
  const outboundBody = parseBody(outbound);
  if (!isRecord(inboundBody) || !isRecord(outboundBody)) return null;
  // The auto-mode classifier re-renders the transcript into its own prompt;
  // it never shares a prefix with the thread it reviews.
  if (isAutoModeClassifierRequest(inboundBody)) return null;
  const sessionId = requestSessionId(headers, inboundBody);
  if (sessionId === null || !Array.isArray(inboundBody.messages) || inboundBody.messages.length === 0) return null;
  const current = {
    inbound: fingerprint(inboundBody, canonicalTextShape),
    outbound: fingerprint(outboundBody, (message) => message),
  };
  if (current.inbound === null || current.outbound === null) return null;
  // Main thread, subagents and side requests share one session id. Their first
  // message tells them apart when Claude Code sends no request-class hint, so
  // a compaction (new first message) starts a fresh thread.
  const key = `${sessionId}\u0000${requestClass(headers) ?? ""}\u0000${current.inbound.messages[0]}`;
  const entry = threads.get(key);
  threads.delete(key);
  threads.set(key, { ...current, at });
  for (const [staleKey, stale] of threads) {
    if (threads.size <= maxThreads && at - stale.at <= ttlMs) break;
    threads.delete(staleKey);
  }
  const counts = { messages: current.outbound.messages.length, tools: current.outbound.tools.length };
  if (entry === undefined || at - entry.at > ttlMs) return { status: "baseline", ...counts };
  return { ...comparePrefix(entry, current), ...counts };
}

function comparePrefix(previous, current) {
  if (current.inbound.messages.length < previous.inbound.messages.length) {
    return { status: "reset", reason: "messages_shrunk" };
  }
  if (current.outbound.model !== previous.outbound.model) return { status: "reset", reason: "model_changed" };
  const drifts = [];
  for (const field of ["tools", "system", "messages"]) {
    const compare = field === "messages" ? prefixBreak : arrayBreak;
    const index = compare(previous.outbound[field], current.outbound[field]);
    if (index === null) continue;
    const inboundIndex = compare(previous.inbound[field], current.inbound[field]);
    const origin = inboundIndex === null ? "airkit" : "upstream";
    const reason = field === "tools" && origin === "airkit" &&
      isDeferredToolActivation(previous.outbound.toolForms, current.outbound.toolForms, current.inbound.toolForms)
      ? "deferred_tool_activation"
      : null;
    drifts.push({ field, index, origin, reason, inboundIndex });
  }
  // An airkit-introduced break outranks an upstream one in an earlier field:
  // the original regression was inbound messages appending cleanly while the
  // outbound system changed.
  const drift = drifts.find((entry) => entry.origin === "airkit" && entry.reason === null) ??
    drifts.find((entry) => entry.origin === "upstream") ??
    drifts[0];
  if (drift === undefined) return { status: "stable" };
  return {
    status: drift.reason === null ? "drift" : "allowed",
    reason: drift.reason,
    origin: drift.origin,
    field: drift.field,
    index: drift.index,
    inboundIndex: drift.inboundIndex,
  };
}

function fingerprint(body, textShape) {
  if (!Array.isArray(body.messages)) return null;
  const tools = Array.isArray(body.tools) ? body.tools : [];
  return {
    model: typeof body.model === "string" ? body.model : null,
    tools: tools.map((tool) => digest(canonicalPrefixJson(tool))),
    // Same tools hashed without defer_loading, so the one-off activation of a
    // deferred tool can be told apart from any other catalogue change.
    toolForms: tools.map((tool) => ({
      base: digest(canonicalPrefixJson(withoutDeferLoading(tool))),
      deferred: tool?.defer_loading === true,
    })),
    system: (typeof body.system === "string" ? [{ type: "text", text: body.system }] : body.system ?? [])
      .map((block) => digest(canonicalPrefixJson(block))),
    messages: body.messages.map((message) => digest(canonicalPrefixJson(textShape(message)))),
  };
}

// airkit activates a deferred tool once a tool_addition or ToolSearch result
// references it: passthrough flips its defer_loading, the compatibility
// executor adds it to its list. Anything else (a removal, a reorder, a tool
// that was never deferred appearing) is still drift.
function isDeferredToolActivation(previous, next, inbound) {
  const before = new Map(previous.map((tool) => [tool.base, tool]));
  const deferredInbound = new Set(inbound.filter((tool) => tool.deferred).map((tool) => tool.base));
  let activated = 0;
  for (const tool of next) {
    const earlier = before.get(tool.base);
    if (earlier !== undefined && earlier.deferred === tool.deferred) continue;
    const wasDeferred = earlier?.deferred ?? deferredInbound.has(tool.base);
    if (tool.deferred || !wasDeferred) return false;
    activated += 1;
  }
  const kept = next.filter((tool) => before.has(tool.base)).map((tool) => tool.base);
  return activated > 0 && kept.length === previous.length &&
    kept.every((base, index) => base === previous[index].base);
}

function withoutDeferLoading(tool) {
  if (!isRecord(tool) || !("defer_loading" in tool)) return tool;
  const { defer_loading: _deferLoading, ...rest } = tool;
  return rest;
}

function arrayBreak(previous, next) {
  const shared = Math.min(previous.length, next.length);
  for (let index = 0; index < shared; index++) if (previous[index] !== next[index]) return index;
  return previous.length === next.length ? null : shared;
}

function prefixBreak(previous, next) {
  for (let index = 0; index < previous.length; index++) {
    if (index >= next.length || previous[index] !== next[index]) return index;
  }
  return null;
}

// 48 bits of SHA-256 as a plain number: collisions are irrelevant at the size
// of one thread, and arrays of numbers stay compact.
function digest(text) {
  return createHash("sha256").update(text ?? "null").digest().readUIntBE(0, 6);
}

function parseBody(value) {
  if (typeof value === "string") return JSON.parse(value);
  if (value instanceof Uint8Array) {
    return JSON.parse(Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString("utf8"));
  }
  return isRecord(value) ? value : null;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonNegativeCounter(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}
