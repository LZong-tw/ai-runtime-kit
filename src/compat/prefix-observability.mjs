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

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
