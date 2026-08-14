import { normalizeUsageObservation } from "./audit/usage.mjs";

export function summarizeCompletionUsage(usage) {
  const normalized = normalizeUsageObservation({ source: "provider", usage });
  const values = normalized.values;
  const input = values.effectiveContextTokens;
  const output = values.outputTokens;
  const total = values.providerTotalTokens ?? sumKnown(input, output);
  const cacheRead = values.cacheReadTokens;
  const cacheCreation = sumKnown(values.cacheCreate5mTokens, values.cacheCreate1hTokens);
  const cacheMiss = values.cacheMissTokens;
  const cacheHitRate = cacheRead === null || input === null || input === 0
    ? null
    : cacheRead / input;

  return {
    inputTokens: input,
    outputTokens: output,
    totalTokens: total,
    cacheDetails: cacheRead !== null || cacheCreation !== null || cacheMiss !== null
      ? "available"
      : "unavailable",
    cacheReadInputTokens: cacheRead,
    cacheCreationInputTokens: cacheCreation,
    cacheMissInputTokens: cacheMiss,
    cacheHitRate,
  };
}

export function buildContextObservability({
  autoCompactWindow,
  modelCatalog,
  modelInfo,
  route,
  usage,
} = {}) {
  const catalogWindow = contextWindowFromCatalog(modelCatalog, route);
  const modelInfoWindow = positiveInteger(modelInfo?.contextWindow);
  const contextWindow = catalogWindow !== null
    ? { tokens: catalogWindow, source: "catalog:modelCatalog", metadataOnly: true }
    : modelInfoWindow !== null
      ? { tokens: modelInfoWindow, source: "claude-code:/model/info", metadataOnly: true }
      : { tokens: null, source: "unavailable", metadataOnly: true };
  const compactWindow = positiveInteger(autoCompactWindow);

  return {
    route: typeof route === "string" && route.length > 0 ? route : null,
    contextWindow,
    autoCompactWindow: compactWindow === null
      ? { tokens: null, source: "claude-code:default" }
      : { tokens: compactWindow, source: "profile:launch.context.autoCompactWindow" },
    usage: summarizeCompletionUsage(usage),
  };
}

function sumKnown(...values) {
  const known = values.filter((value) => value !== null);
  return known.length > 0 ? known.reduce((total, value) => total + value, 0) : null;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function contextWindowFromCatalog(modelCatalog, route) {
  if (!isRecord(modelCatalog) || !Array.isArray(modelCatalog.providers) || typeof route !== "string") {
    return null;
  }
  const separator = route.indexOf(",");
  const provider = separator === -1 ? "" : route.slice(0, separator);
  const model = separator === -1 ? route : route.slice(separator + 1);

  for (const providerEntry of modelCatalog.providers) {
    for (const modelEntry of providerEntry.models ?? []) {
      const modelCandidates = new Set([
        modelEntry.id,
        modelEntry.litellm,
        ...(Array.isArray(modelEntry.aliases) ? modelEntry.aliases : []),
      ].filter(Boolean));
      const providerCandidates = new Set([
        providerEntry.id,
        providerEntry.name,
        providerEntry.litellmProvider,
      ].filter(Boolean));
      const providerMatches = !provider
        || providerCandidates.has(provider)
        || modelCandidates.has(`${provider}/${model}`)
        || modelCandidates.has(`${provider},${model}`);
      if (providerMatches && modelCandidates.has(model)) return positiveInteger(modelEntry.contextWindow);
    }
  }
  return null;
}

function positiveInteger(value) {
  return Number.isInteger(value) && value > 0 ? value : null;
}
