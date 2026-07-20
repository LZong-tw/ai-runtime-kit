import { assertAnthropicFamilyModel } from "./protocol.mjs";

export const VERIFIED_NATIVE_COMPATIBILITY = Object.freeze({
  webFetch: false,
  webSearch: true,
});

const FAMILY_MODES = Object.freeze({
  webSearch: Object.freeze(["native-first", "anthropic-fallback", "mcp"]),
  webFetch: Object.freeze(["native-first", "anthropic-fallback"]),
  codeExecution: Object.freeze(["anthropic-fallback"]),
  advisor: Object.freeze(["anthropic-fallback"]),
  toolSearch: Object.freeze(["bridge", "anthropic-fallback"]),
  mcpConnector: Object.freeze(["anthropic-fallback"]),
});

const CONFIG_KEYS = new Set(["fallback", "routeLog", "routes", ...Object.keys(FAMILY_MODES)]);
const FALLBACK_KEYS = new Set(["provider", "model", "maxContinuationTurns"]);
const FAMILY_KEYS = new Set(["mode"]);
const ROUTE_KEYS = new Set(["default", "background"]);
const ROUTE_SELECTOR_PATTERN = /^[a-z0-9][a-z0-9._-]*\/\S+$/i;

export function validateCompatibilityConfig(config) {
  assertRecord(config, "compatibility config");
  rejectUnknownKeys(config, CONFIG_KEYS, "compatibility");

  assertRecord(config.fallback, "fallback", true);
  rejectUnknownKeys(config.fallback, FALLBACK_KEYS, "fallback");
  if (
    typeof config.fallback.provider !== "string" ||
    !/^[a-z0-9][a-z0-9._-]*$/i.test(config.fallback.provider)
  ) {
    throw new Error("fallback.provider must be a provider identifier");
  }
  assertAnthropicFamilyModel(config.fallback.model, "fallback.model");
  if (config.fallback.model.includes("/")) {
    throw new Error("fallback.model must be a provider-local Claude model identifier");
  }
  if (
    !Number.isInteger(config.fallback.maxContinuationTurns) ||
    config.fallback.maxContinuationTurns < 1 ||
    config.fallback.maxContinuationTurns > 32
  ) {
    throw new Error("fallback.maxContinuationTurns must be an integer from 1 through 32");
  }

  for (const [family, modes] of Object.entries(FAMILY_MODES)) {
    const definition = config[family];
    assertRecord(definition, family, true);
    if (family === "advisor") rejectRemovedAdvisorConfig(definition);
    rejectUnknownKeys(definition, FAMILY_KEYS, family);
    if (!modes.includes(definition.mode)) {
      throw new Error(`${family}.mode must be one of: ${modes.join(", ")}`);
    }
  }

  if (config.routeLog !== undefined && typeof config.routeLog !== "boolean") {
    throw new Error("routeLog must be a boolean");
  }

  if (config.routes !== undefined) {
    assertRecord(config.routes, "routes");
    rejectUnknownKeys(config.routes, ROUTE_KEYS, "routes");
    if (config.routes.default === undefined) {
      throw new Error("routes.default is required when routes is configured");
    }
    for (const key of ROUTE_KEYS) {
      const selector = config.routes[key];
      if (selector === undefined) continue;
      if (typeof selector !== "string" || !ROUTE_SELECTOR_PATTERN.test(selector)) {
        throw new Error(`routes.${key} must be a provider-qualified model selector`);
      }
    }
  }

  return config;
}

// Bare Claude model ids (plain `claude` outside a named CCR profile, including
// its constant claude-haiku background requests) have no gateway-side mapping:
// this plugin owns POST /v1/messages, so CCR Router rules never see them and
// the core rejects unlisted models. Route them here; provider-qualified
// selectors (named profiles, the whole-request fallback) pass through as-is.
export function routeBareClaudeModel(body, routes) {
  if (!isRecord(body) || typeof body.model !== "string") return null;
  if (!isRecord(routes)) return null;
  if (body.model.includes("/") || !body.model.startsWith("claude-")) return null;
  const target = body.model.startsWith("claude-haiku")
    ? routes.background ?? routes.default
    : routes.default;
  if (typeof target !== "string" || target === "" || target === body.model) return null;
  return { ...body, model: target };
}

export function resolveCompatibilityPolicies(config, nativeCapabilities = {}) {
  validateCompatibilityConfig(config);
  const fallback = Object.freeze({
    provider: config.fallback.provider,
    model: assertAnthropicFamilyModel(config.fallback.model, "fallback.model"),
    maxContinuationTurns: config.fallback.maxContinuationTurns,
  });
  const policies = Object.freeze({
    webSearch: resolveNativeFirst(config.webSearch.mode, nativeCapabilities?.webSearch),
    webFetch: resolveNativeFirst(config.webFetch.mode, nativeCapabilities?.webFetch),
    codeExecution: "anthropic-fallback",
    advisor: "anthropic-fallback",
    toolSearch: config.toolSearch.mode === "bridge" ? "bridge" : "anthropic-fallback",
    mcpConnector: "anthropic-fallback",
  });

  return Object.freeze({ fallback, policies });
}

export function compatibilityFallbackSelector(fallback) {
  return `${fallback.provider}/${fallback.model}`;
}

export function validateCompatibilityProviderBinding(config, providers) {
  const matches = (providers ?? []).filter(({ name }) => name === config.fallback.provider);
  if (matches.length !== 1) {
    throw new Error(`fallback provider must resolve exactly once: ${config.fallback.provider}`);
  }
  const [provider] = matches;
  if (provider.type !== "anthropic_messages") {
    throw new Error(`fallback provider must use anthropic_messages: ${provider.name}`);
  }
  if (!provider.models?.includes(config.fallback.model)) {
    throw new Error(`fallback model is missing from provider ${provider.name}: ${config.fallback.model}`);
  }
  return provider;
}

function resolveNativeFirst(mode, nativeCapability) {
  return mode === "native-first" && nativeCapability === true ? "native" : "anthropic-fallback";
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertRecord(value, field, required = false) {
  if (value === undefined && required) throw new Error(`${field} is required`);
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
}

function rejectUnknownKeys(value, allowed, field) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`unknown ${field} key: ${key}`);
  }
}

function rejectRemovedAdvisorConfig(advisor) {
  if (advisor.mode === "bridge") {
    throw new Error(
      'advisor.mode "bridge" was removed; use advisor.mode "anthropic-fallback"',
    );
  }
  for (const field of ["model", "fallbackModel"]) {
    if (Object.hasOwn(advisor, field)) {
      throw new Error(`advisor.${field} was removed; configure fallback.model instead`);
    }
  }
}
