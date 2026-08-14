const TOKEN_FIELDS = Object.freeze([
  "uncachedInputTokens",
  "cacheReadTokens",
  "cacheCreate5mTokens",
  "cacheCreate1hTokens",
  "cacheMissTokens",
  "reasoningTokens",
  "outputTokens",
  "providerTotalTokens",
  "effectiveContextTokens",
]);

export function normalizeUsageObservation(input = {}) {
  const usage = isRecord(input.usage) ? input.usage : {};
  const metadata = isRecord(usage.usageMetadata) ? usage.usageMetadata : {};
  const values = Object.fromEntries(TOKEN_FIELDS.map((field) => [field, null]));
  values.inputBytes = null;
  values.outputBytes = null;
  const provenance = {};
  const conflicts = [];

  const candidates = new Map();
  const add = (field, value, path, kind = "reported", formula = null) => {
    const number = counter(value);
    if (number === null) return;
    const candidate = { value: number, path, kind, formula };
    const existing = candidates.get(field) ?? [];
    existing.push(candidate);
    candidates.set(field, existing);
  };

  add("uncachedInputTokens", usage.input_tokens, "usage.input_tokens");
  add("uncachedInputTokens", usage.prompt_tokens, "usage.prompt_tokens");
  add("uncachedInputTokens", metadata.promptTokenCount, "usage.usageMetadata.promptTokenCount");
  add("cacheReadTokens", usage.prompt_tokens_details?.cached_tokens, "usage.prompt_tokens_details.cached_tokens");
  add("cacheReadTokens", usage.input_tokens_details?.cached_tokens, "usage.input_tokens_details.cached_tokens");
  add("cacheReadTokens", usage.prompt_cache_hit_tokens, "usage.prompt_cache_hit_tokens");
  add("cacheReadTokens", usage.cache_read_input_tokens, "usage.cache_read_input_tokens");
  add("cacheReadTokens", usage.cache_read_tokens, "usage.cache_read_tokens");
  add("cacheReadTokens", metadata.cachedContentTokenCount, "usage.usageMetadata.cachedContentTokenCount");
  add("cacheCreate5mTokens", usage.cache_creation?.ephemeral_5m_input_tokens, "usage.cache_creation.ephemeral_5m_input_tokens");
  add("cacheCreate1hTokens", usage.cache_creation?.ephemeral_1h_input_tokens, "usage.cache_creation.ephemeral_1h_input_tokens");
  add("cacheCreate5mTokens", usage.cache_creation_5m_input_tokens, "usage.cache_creation_5m_input_tokens");
  add("cacheCreate1hTokens", usage.cache_creation_1h_input_tokens, "usage.cache_creation_1h_input_tokens");
  const creation = firstCounter(usage.cache_creation_input_tokens, usage.cache_write_input_tokens, usage.cache_write_tokens);
  if (creation !== null) add("cacheCreate5mTokens", creation, "usage.cache_creation_input_tokens");
  add("cacheMissTokens", usage.prompt_cache_miss_tokens, "usage.prompt_cache_miss_tokens");
  add("cacheMissTokens", usage.cache_miss_input_tokens, "usage.cache_miss_input_tokens");
  add("cacheMissTokens", usage.cache_miss_tokens, "usage.cache_miss_tokens");
  add("reasoningTokens", usage.completion_tokens_details?.reasoning_tokens, "usage.completion_tokens_details.reasoning_tokens");
  add("reasoningTokens", usage.output_tokens_details?.reasoning_tokens, "usage.output_tokens_details.reasoning_tokens");
  add("reasoningTokens", usage.reasoning_tokens, "usage.reasoning_tokens");
  add("outputTokens", usage.completion_tokens, "usage.completion_tokens");
  add("outputTokens", usage.output_tokens, "usage.output_tokens");
  add("outputTokens", metadata.candidatesTokenCount, "usage.usageMetadata.candidatesTokenCount");
  add("providerTotalTokens", usage.total_tokens, "usage.total_tokens");
  add("providerTotalTokens", metadata.totalTokenCount, "usage.usageMetadata.totalTokenCount");
  add("inputBytes", usage.input_bytes, "usage.input_bytes", "estimated", "bytes / 4");
  add("outputBytes", usage.output_bytes, "usage.output_bytes", "estimated", "bytes / 4");

  for (const field of TOKEN_FIELDS) {
    const entries = candidates.get(field) ?? [];
    if (entries.length === 0) continue;
    const selected = entries[0];
    values[field] = selected.value;
    provenance[field] = {
      kind: selected.kind,
      source: selected.path,
      ...(selected.formula ? { formula: selected.formula } : {}),
    };
    for (const candidate of entries.slice(1)) {
      if (candidate.value !== selected.value) {
        conflicts.push({ field, values: entries.map((entry) => entry.value), sources: entries.map((entry) => entry.path) });
        break;
      }
    }
  }

  if (values.inputBytes === null && counter(usage.input_bytes) !== null) {
    values.inputBytes = counter(usage.input_bytes);
    provenance.inputBytes = { kind: "estimated", source: "usage.input_bytes", formula: "bytes / 4" };
  }
  if (values.outputBytes === null && counter(usage.output_bytes) !== null) {
    values.outputBytes = counter(usage.output_bytes);
    provenance.outputBytes = { kind: "estimated", source: "usage.output_bytes", formula: "bytes / 4" };
  }

  const headers = normalizeHeaders(input.responseHeaders);
  addHeaderByteCandidate(values, provenance, "inputBytes", headers, ["x-input-bytes", "x-prompt-bytes"]);
  addHeaderByteCandidate(values, provenance, "outputBytes", headers, ["x-output-bytes", "x-completion-bytes"]);
  const uncachedInput = values.uncachedInputTokens;
  const cacheRead = values.cacheReadTokens;
  let cacheMiss = values.cacheMissTokens;
  const creates = sumKnown(values.cacheCreate5mTokens, values.cacheCreate1hTokens);
  if (cacheMiss === null && counter(metadata.promptTokenCount) !== null && values.cacheReadTokens !== null) {
    values.cacheMissTokens = Math.max(0, metadata.promptTokenCount - values.cacheReadTokens);
    cacheMiss = values.cacheMissTokens;
    provenance.cacheMissTokens = {
      kind: "derived",
      source: "usage.usageMetadata.promptTokenCount - usage.usageMetadata.cachedContentTokenCount",
      formula: "promptTokenCount - cachedContentTokenCount",
    };
  }
  values.effectiveContextTokens = uncachedInput === null
    ? null
    : uncachedInput + (isAnthropic(uncachedInput, usage) ? (sumKnown(cacheRead, creates) ?? 0) : 0);
  provenance.effectiveContextTokens = uncachedInput === null ? undefined : {
    kind: isAnthropic(uncachedInput, usage) && (cacheRead !== null || creates !== null) ? "derived" : "reported",
    source: isAnthropic(uncachedInput, usage) && (cacheRead !== null || creates !== null) ? "usage accounting" : provenance.uncachedInputTokens?.source,
    ...(isAnthropic(uncachedInput, usage) && (cacheRead !== null || creates !== null) ? { formula: "uncachedInputTokens + cacheReadTokens + cacheCreate5mTokens + cacheCreate1hTokens" } : {}),
  };
  if (cacheMiss !== null && cacheRead !== null && uncachedInput !== null && cacheRead + cacheMiss > uncachedInput) {
    conflicts.push({ field: "cacheReadTokens", reason: "cache counters exceed reported input", values: [cacheRead, cacheMiss, uncachedInput] });
  }
  const reported = Object.values(provenance).filter((entry) => entry?.kind === "reported").length;
  const confidence = reported > 0 ? (conflicts.length > 0 ? 0.5 : 1) : (values.inputBytes !== null || values.outputBytes !== null ? 0.25 : 0);
  return { values, provenance, confidence, conflicts };
}

export function normalizeMeterObservation(input = {}) {
  return normalizeNonRequestObservation(input, "counters", "meter");
}

export function normalizeQuotaObservation(input = {}) {
  return normalizeNonRequestObservation(input, "quota", "quota");
}

export function normalizeHeadroomObservation(input = {}) {
  return normalizeNonRequestObservation(input, "headroom", "headroom");
}

function normalizeNonRequestObservation(input, key, kind) {
  const values = isRecord(input[key]) ? { ...input[key] } : {};
  const provenance = Object.fromEntries(Object.keys(values).map((field) => [field, { kind: "reported", source: `${key}.${field}` }]));
  return { values, provenance, confidence: Object.keys(values).length > 0 ? 1 : 0, conflicts: [], kind };
}

function addHeaderByteCandidate(values, provenance, field, headers, names) {
  if (values[field] !== null) return;
  for (const name of names) {
    const value = counter(headers[name]);
    if (value !== null) {
      values[field] = value;
      provenance[field] = { kind: "estimated", source: `responseHeaders.${name}`, formula: "bytes / 4" };
      return;
    }
  }
}

function normalizeHeaders(headers) {
  if (!isRecord(headers)) return {};
  return Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
}

function isAnthropic(_input, usage) {
  return usage.input_tokens !== undefined && (usage.cache_creation !== undefined || usage.cache_read_input_tokens !== undefined);
}

function firstCounter(...values) {
  for (const value of values) {
    const number = counter(value);
    if (number !== null) return number;
  }
  return null;
}

function sumKnown(...values) {
  const known = values.filter((value) => value !== null);
  return known.length > 0 ? known.reduce((total, value) => total + value, 0) : null;
}

function counter(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
