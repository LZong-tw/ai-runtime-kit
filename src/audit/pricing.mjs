const PRICE_FIELDS = Object.freeze([
  ["uncachedInputTokens", "uncachedInputCost", "uncachedInput"],
  ["cacheReadTokens", "cacheReadCost", "cacheRead"],
  ["cacheCreate5mTokens", "cacheCreate5mCost", "cacheCreate5m"],
  ["cacheCreate1hTokens", "cacheCreate1hCost", "cacheCreate1h"],
  ["reasoningTokens", "reasoningCost", "reasoning"],
  ["outputTokens", "outputCost", "output"],
]);

export function resolvePricingVersion({ catalog, provider, model, observedAt, billingLabel } = {}) {
  if (!isNonEmptyString(provider) || !isNonEmptyString(model) || !isDate(observedAt)) return null;
  const entries = catalog?.modelCatalog?.pricingVersions;
  if (!Array.isArray(entries)) return null;
  const entry = entries.find((candidate) => candidate?.provider === provider && candidate?.model === model);
  if (!entry || !Array.isArray(entry.versions)) return null;
  const at = Date.parse(observedAt);
  const candidates = entry.versions.filter((candidate) => {
    if (!candidate || !isNonEmptyString(candidate.version) || !isDate(candidate.effectiveFrom)) return false;
    if (Date.parse(candidate.effectiveFrom) > at) return false;
    if (candidate.effectiveTo !== undefined && (!isDate(candidate.effectiveTo) || Date.parse(candidate.effectiveTo) <= at)) return false;
    return billingLabel === undefined || candidate.billingLabel === billingLabel;
  });
  const version = candidates.sort((left, right) => Date.parse(right.effectiveFrom) - Date.parse(left.effectiveFrom))[0];
  if (!version) return null;
  return {
    provider,
    model,
    version: version.version,
    effectiveFrom: version.effectiveFrom,
    ...(version.effectiveTo !== undefined ? { effectiveTo: version.effectiveTo } : {}),
    ...(version.billingLabel !== undefined ? { billingLabel: version.billingLabel } : {}),
    pricesUsdPer1M: { ...version.pricesUsdPer1M },
  };
}

export function calculateRequestCost({ usage, pricing } = {}) {
  const values = usage?.values && typeof usage.values === "object" ? usage.values : usage;
  const prices = pricing?.pricesUsdPer1M;
  const components = {};
  for (const [usageField, costField, priceField] of PRICE_FIELDS) {
    components[costField] = tokenCost(values?.[usageField], prices?.[priceField]);
  }
  const known = Object.values(components).filter((value) => value !== null);
  return { ...components, derivedTotalCost: known.length > 0 ? roundCost(known.reduce((sum, value) => sum + value, 0)) : null };
}

function tokenCost(tokens, price) {
  return isCounter(tokens) && isPrice(price) ? roundCost(tokens * price / 1_000_000) : null;
}

function roundCost(value) {
  return Number(value.toFixed(12));
}

function isCounter(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isPrice(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isDate(value) {
  return (typeof value === "string" || value instanceof Date) && Number.isFinite(Date.parse(value));
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}
