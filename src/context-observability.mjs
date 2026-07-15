export function summarizeCompletionUsage(usage) {
  const source = isRecord(usage) ? usage : {};
  const openAiInput = counter(source.prompt_tokens);
  const anthropicInput = counter(source.input_tokens);
  const output = counter(source.completion_tokens) ?? counter(source.output_tokens);
  const cacheRead = counter(source.prompt_tokens_details?.cached_tokens)
    ?? counter(source.cache_read_input_tokens);
  const cacheCreation = counter(source.cache_creation_input_tokens);
  const input = openAiInput ?? sumKnown(anthropicInput, cacheRead, cacheCreation);
  const total = counter(source.total_tokens) ?? sumKnown(input, output);

  return {
    inputTokens: input,
    outputTokens: output,
    totalTokens: total,
    cacheDetails: cacheRead !== null || cacheCreation !== null ? "available" : "unavailable",
    cacheReadInputTokens: cacheRead,
    cacheCreationInputTokens: cacheCreation,
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

function counter(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
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
