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

// Claude Code sends its newest message as [{type:"text", cache_control}] and
// re-sends the same message as a bare string once it is no longer last
// (captured with 2.1.330). It does this every turn by design, so the two
// shapes count as one prefix on both sides of airkit; otherwise every typed
// prompt would read as a break airkit forwarded.
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
// counts, never content. Threads that share a session, request class and
// first message (parallel subagents with one prompt, forks) share a slot, so
// their interleaving shows up as upstream drift.
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
  // Passthrough shares most message objects (and every image string) between
  // the inbound and outbound bodies; hashing each once keeps an image-heavy
  // request in the low milliseconds on the shared event loop.
  const memo = new WeakMap();
  const current = {
    inbound: fingerprint(inboundBody, memo),
    outbound: fingerprint(outboundBody, memo),
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
  for (const field of ["tools", "system", "messages", "params"]) {
    const compare = field === "messages" ? prefixBreak : arrayBreak;
    const index = compare(previous.outbound[field], current.outbound[field]);
    if (index === null) continue;
    const inboundIndex = compare(previous.inbound[field], current.inbound[field]);
    // An upstream edit late in the history (microcompact, a rewind) must not
    // hide an airkit break earlier in it.
    const origin = inboundIndex === null ||
      (field === "messages" && index < earliestOutboundIndex(current, inboundIndex))
      ? "airkit"
      : "upstream";
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

// Inbound and outbound message indices differ: airkit folds each inline system
// message into a user turn, and the compatibility path may merge others. The
// outbound position of inbound message `index` is at least `index` minus
// every message airkit dropped (all assumed to sit before it), minus one for
// a system message folded into the turn before it. Below that bound the break
// cannot come from the inbound change.
function earliestOutboundIndex(current, index) {
  const { inlineSystem, messages } = current.inbound;
  const foldedBefore = inlineSystem.filter((at) => at < index).length;
  const otherDropped = Math.max(0, messages.length - inlineSystem.length - current.outbound.messages.length);
  return index - foldedBefore - otherDropped - 1;
}

// Request parameters the provider keys its messages cache on besides the
// prefix: changing tool_choice, thinking, effort or speed misses the cached
// messages even when every byte of tools, system and messages is unchanged.
function cacheParams(body) {
  return {
    thinking: body.thinking,
    tool_choice: body.tool_choice,
    effort: body.output_config?.effort,
    speed: body.speed,
  };
}

function fingerprint(body, memo) {
  if (!Array.isArray(body.messages)) return null;
  const tools = Array.isArray(body.tools) ? body.tools : [];
  const hash = (value) => memoDigest(value, memo);
  const toolDigests = tools.map(hash);
  return {
    model: typeof body.model === "string" ? body.model : null,
    tools: toolDigests,
    // Same tools hashed without defer_loading, so the one-off activation of a
    // deferred tool can be told apart from any other catalogue change.
    toolForms: tools.map((tool, index) => ({
      base: isRecord(tool) && "defer_loading" in tool ? hash(withoutDeferLoading(tool)) : toolDigests[index],
      deferred: tool?.defer_loading === true,
    })),
    system: (typeof body.system === "string" ? [{ type: "text", text: body.system }] : body.system ?? []).map(hash),
    messages: body.messages.map((message) => hash(canonicalTextShape(message))),
    params: [hash(cacheParams(body))],
    inlineSystem: body.messages.flatMap((message, index) => message?.role === "system" ? [index] : []),
  };
}

// Strings this long are image or document payloads. They are fingerprinted
// by length and sampled slices instead of in full: anything that reads every
// byte (a full SHA-256, even a Map lookup, which hashes the whole string) of
// a 30 MB image-heavy history costs tens of milliseconds on the shared event
// loop every request. A transform that rewrites a payload (re-encoding,
// resizing, truncation) still changes its length or its sampled bytes.
const LONG_STRING = 16_384;
const SAMPLE_SLICES = 32;
const SLICE = 64;

function sampledDigest(value) {
  const hash = createHash("sha256").update(String(value.length));
  hash.update(value.slice(0, 1024)).update(value.slice(-1024));
  const step = Math.floor(value.length / SAMPLE_SLICES);
  for (let at = 0; at < SAMPLE_SLICES; at++) hash.update(value.slice(at * step, at * step + SLICE));
  return hash.digest("base64");
}

function memoDigest(value, memo) {
  const cacheable = value !== null && typeof value === "object";
  if (cacheable && memo.has(value)) return memo.get(value);
  const text = JSON.stringify(value, (key, inner) => {
    if (key === "cache_control") return undefined;
    return typeof inner === "string" && inner.length >= LONG_STRING ? `\u0000sampled:${sampledDigest(inner)}` : inner;
  });
  const result = digest(text);
  if (cacheable) memo.set(value, result);
  return result;
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
