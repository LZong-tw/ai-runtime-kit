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

const CONFIG_KEYS = new Set([
  "fallback",
  "modeRoutes",
  "routeLog",
  "routes",
  ...Object.keys(FAMILY_MODES),
]);
const FALLBACK_KEYS = new Set(["provider", "model", "maxContinuationTurns"]);
const FAMILY_KEYS = new Set(["mode", "fallback"]);
const FAMILY_FALLBACK_KEYS = new Set(["provider", "model"]);
const ROUTE_KEYS = new Set(["default", "background", "opus"]);
const ROUTE_SELECTOR_PATTERN = /^[a-z0-9][a-z0-9._-]*\/\S+$/i;
const MODE_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i;

// One plugin instance serves every launch mode, and CCR discards the caller's
// API-key identity before the plugin sees the request. The launcher therefore
// labels its own mode through ANTHROPIC_CUSTOM_HEADERS, which Claude Code
// forwards verbatim on /v1/messages.
export const AIRKIT_MODE_HEADER = "x-airkit-mode";

export function validateCompatibilityConfig(config) {
  assertRecord(config, "compatibility config");
  rejectUnknownKeys(config, CONFIG_KEYS, "compatibility");

  validateFallback(config.fallback, "fallback", FALLBACK_KEYS, true);
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
    if (definition.fallback !== undefined) {
      validateFallback(definition.fallback, `${family}.fallback`, FAMILY_FALLBACK_KEYS, false);
    }
    if (!modes.includes(definition.mode)) {
      throw new Error(`${family}.mode must be one of: ${modes.join(", ")}`);
    }
  }

  if (config.routeLog !== undefined && typeof config.routeLog !== "boolean") {
    throw new Error("routeLog must be a boolean");
  }

  if (config.routes !== undefined) validateRouteTable(config.routes, "routes");

  if (config.modeRoutes !== undefined) {
    assertRecord(config.modeRoutes, "modeRoutes");
    for (const [mode, table] of Object.entries(config.modeRoutes)) {
      // requestedMode lowercases every arriving label before the lookup, so a
      // key that is not already canonical (e.g. "GLM") would validate here yet
      // never match a request. Reject it instead of letting it rot unreachable.
      if (!isAirkitModeLabel(mode)) {
        throw new Error(`modeRoutes key must be a canonical launch mode label: ${mode}`);
      }
      validateRouteTable(table, `modeRoutes.${mode}`);
    }
  }

  return config;
}

function validateRouteTable(routes, label) {
  assertRecord(routes, label);
  rejectUnknownKeys(routes, ROUTE_KEYS, label);
  if (routes.default === undefined) {
    throw new Error(`${label}.default is required when ${label} is configured`);
  }
  for (const key of ROUTE_KEYS) {
    const selector = routes[key];
    if (selector === undefined) continue;
    if (typeof selector !== "string" || !ROUTE_SELECTOR_PATTERN.test(selector)) {
      throw new Error(`${label}.${key} must be a provider-qualified model selector`);
    }
  }
}

// Bare Claude model ids (plain `claude` outside a named CCR profile, including
// its constant claude-haiku background requests) have no gateway-side mapping:
// this plugin owns POST /v1/messages, so CCR Router rules never see them and
// the core rejects unlisted models. Route them here; provider-qualified
// selectors (named profiles, the whole-request fallback) pass through as-is.
// The mode label is a routing hint from a caller that already holds a gateway
// credential, not a privilege boundary: that caller can name any configured
// model outright. Unknown or malformed labels quietly fall back to the flat
// table so an unlabelled client still routes.
export function resolveModeRoutes(config, mode) {
  if (!isRecord(config)) return null;
  const perMode = isRecord(config.modeRoutes) && typeof mode === "string"
    ? config.modeRoutes[mode]
    : null;
  return isRecord(perMode) ? perMode : (isRecord(config.routes) ? config.routes : null);
}

// One normalization shared by both ends of the header contract: the launcher
// stamps exactly this label, requestedMode reduces what arrives to the same
// form, and the rendered route tables are keyed by it. Normalizing in one
// place keeps a catalog with an uppercase mode name from missing its table.
export function airkitModeLabel(mode) {
  return String(mode).trim().toLowerCase();
}

// The single definition of a label that can round-trip through the header
// contract: already canonical and inside the mode pattern. The launcher
// checks catalog modes against this before rendering a table key, and
// requestedMode reduces arriving headers to the same predicate.
export function isAirkitModeLabel(label) {
  return typeof label === "string" && label !== ""
    && label === airkitModeLabel(label) && MODE_PATTERN.test(label);
}

export function requestedMode(headers) {
  if (!isRecord(headers)) return null;
  const raw = headers[AIRKIT_MODE_HEADER];
  const value = (Array.isArray(raw) ? raw[0] : raw);
  if (typeof value !== "string") return null;
  const mode = airkitModeLabel(value);
  return isAirkitModeLabel(mode) ? mode : null;
}

export function routeBareClaudeModel(body, routes) {
  if (!isRecord(body) || typeof body.model !== "string") return null;
  if (!isRecord(routes)) return null;
  if (body.model.includes("/") || !body.model.startsWith("claude-")) return null;
  const target = body.model.startsWith("claude-opus-")
    ? routes.opus ?? routes.default
    : body.model.startsWith("claude-haiku-")
      ? routes.background ?? routes.default
      : body.model.startsWith("claude-sonnet-")
        ? routes.default
        : null;
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
  const familyFallbacks = Object.freeze(Object.fromEntries(
    Object.keys(FAMILY_MODES).flatMap((family) => {
      const override = config[family].fallback;
      return override === undefined ? [] : [[family, Object.freeze({
        provider: override.provider,
        model: assertAnthropicFamilyModel(override.model, `${family}.fallback.model`),
        maxContinuationTurns: fallback.maxContinuationTurns,
      })]];
    }),
  ));

  return Object.freeze({ fallback, familyFallbacks, policies });
}

export function compatibilityFallbackSelector(fallback) {
  return `${fallback.provider}/${fallback.model}`;
}

export function validateCompatibilityProviderBinding(config, providers) {
  const { fallback, familyFallbacks } = resolveCompatibilityPolicies(config, {});
  for (const [label, selected] of [["fallback", fallback], ...Object.entries(familyFallbacks)]) {
    validateFallbackProvider(selected, providers, label);
  }
}

function validateFallbackProvider(fallback, providers, label) {
  const matches = (providers ?? []).filter(({ name }) => name === fallback.provider);
  if (matches.length !== 1) {
    throw new Error(`${label} provider must resolve exactly once: ${fallback.provider}`);
  }
  const [provider] = matches;
  if (provider.type !== "anthropic_messages") {
    throw new Error(`fallback provider must use anthropic_messages: ${provider.name}`);
  }
  if (!provider.models?.includes(fallback.model)) {
    throw new Error(`${label} model is missing from provider ${provider.name}: ${fallback.model}`);
  }
  return provider;
}

function validateFallback(fallback, label, allowedKeys, requireContinuationLimit) {
  assertRecord(fallback, label, true);
  rejectUnknownKeys(fallback, allowedKeys, label);
  if (typeof fallback.provider !== "string" || !/^[a-z0-9][a-z0-9._-]*$/i.test(fallback.provider)) {
    throw new Error(`${label}.provider must be a provider identifier`);
  }
  assertAnthropicFamilyModel(fallback.model, `${label}.model`);
  if (fallback.model.includes("/")) {
    throw new Error(`${label}.model must be a provider-local Claude model identifier`);
  }
  if (requireContinuationLimit === true && (!Number.isInteger(fallback.maxContinuationTurns) || fallback.maxContinuationTurns < 1 || fallback.maxContinuationTurns > 32)) {
    throw new Error("fallback.maxContinuationTurns must be an integer from 1 through 32");
  }
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
