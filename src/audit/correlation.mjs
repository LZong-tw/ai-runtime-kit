const DEFAULT_WINDOW_MS = 120_000;

export function correlateObservations(observations = [], { windowMs = DEFAULT_WINDOW_MS } = {}) {
  if (!Array.isArray(observations)) throw new TypeError("observations must be an array");
  if (!Number.isFinite(windowMs) || windowMs < 0) throw new RangeError("windowMs must be non-negative");
  const exactByBody = new Map();
  for (const observation of observations) {
    if (observation?.body_hash) {
      const list = exactByBody.get(observation.body_hash) ?? [];
      list.push(observation);
      exactByBody.set(observation.body_hash, list);
    }
  }
  return observations.map((observation, index) => {
    const exactRequestId = safeId(observation?.request_id ?? observation?.audit_request_id);
    const bodyMatches = exactByBody.get(observation?.body_hash) ?? [];
    const bodyRequestIds = [...new Set(bodyMatches.map((entry) => safeId(entry?.request_id ?? entry?.audit_request_id)).filter(Boolean))];
    const conflict = bodyRequestIds.length > 1;
    if (conflict) {
      return result(observation, { correlation: "conflict", requestId: null, confidence: 0, conflicts: bodyRequestIds });
    }
    if (exactRequestId) {
      return result(observation, { correlation: "exact", requestId: exactRequestId, confidence: 1, conflicts: [] });
    }
    if (bodyRequestIds.length === 1) {
      return result(observation, { correlation: "body_hash", requestId: bodyRequestIds[0], confidence: 0.98, conflicts: [] });
    }
    const candidate = observations.find((other, otherIndex) => {
      if (otherIndex === index || !sameRoute(observation, other)) return false;
      const left = Date.parse(observation?.observed_at ?? "");
      const right = Date.parse(other?.observed_at ?? "");
      return !Number.isNaN(left) && !Number.isNaN(right) && Math.abs(left - right) <= windowMs;
    });
    if (candidate) {
      return result(observation, { correlation: "bounded_time_candidate", requestId: null, confidence: 0.35, conflicts: [] });
    }
    return result(observation, { correlation: "unmatched", requestId: null, confidence: 0, conflicts: [] });
  });
}

export function buildCacheCohorts(observations = []) {
  if (!Array.isArray(observations)) throw new TypeError("observations must be an array");
  const seen = new Set();
  return observations.map((observation) => {
    const provider = safeText(observation?.actual_provider ?? observation?.provider) ?? "unknown-provider";
    const model = safeText(observation?.actual_model ?? observation?.model) ?? "unknown-model";
    const account = safeText(observation?.provider_account_id ?? observation?.account_id) ?? "unknown-account";
    const key = `${provider}\u0000${account}\u0000${model}`;
    const cohort = seen.has(key) ? "warm" : "cold";
    seen.add(key);
    return { ...observation, cohort, cohort_key: key };
  });
}

function result(observation, { correlation, requestId, confidence, conflicts }) {
  return {
    ...observation,
    request_id: requestId,
    correlation,
    confidence,
    conflicts,
  };
}

function sameRoute(left, right) {
  return (left?.actual_provider ?? left?.provider) === (right?.actual_provider ?? right?.provider)
    && (left?.actual_model ?? left?.model) === (right?.actual_model ?? right?.model);
}

function safeId(value) {
  return safeText(value)?.match(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/)?.[0] ?? null;
}

function safeText(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 512 ? value : null;
}
