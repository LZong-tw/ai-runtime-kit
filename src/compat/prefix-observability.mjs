import { createHash } from "node:crypto";

// This is intentionally an observation of a cache candidate, not a provider
// cache key. The forwarded Claude request remains untouched; providers may
// apply additional boundaries or TTL rules that this local fingerprint cannot
// see.
export function describeStablePrefix(body) {
  if (!isRecord(body) || !Array.isArray(body.messages)) {
    return {
      candidate: false,
      reason: "messages_unavailable",
      stablePrefixHash: null,
      stablePrefixBytes: null,
      stablePrefixMessages: null,
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
  };
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

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonNegativeCounter(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}
