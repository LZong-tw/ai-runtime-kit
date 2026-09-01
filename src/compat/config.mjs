import { assertAnthropicFamilyModel } from "./protocol.mjs";

export const VERIFIED_NATIVE_COMPATIBILITY = Object.freeze({
  webFetch: false,
  webSearch: true,
});

const FAMILY_MODES = Object.freeze({
  webSearch: Object.freeze(["native-first", "anthropic-fallback", "mcp"]),
  webFetch: Object.freeze(["native-first", "anthropic-fallback"]),
  codeExecution: Object.freeze(["anthropic-fallback"]),
  advisor: Object.freeze(["bridge", "anthropic-fallback"]),
  toolSearch: Object.freeze(["bridge", "anthropic-fallback"]),
  mcpConnector: Object.freeze(["anthropic-fallback"]),
});

const CONFIG_KEYS = new Set([
  "fallback",
  "launchModel",
  "modeEffort",
  "modeRoutes",
  "routeLog",
  "routes",
  "transportFallbacks",
  ...Object.keys(FAMILY_MODES),
]);
const FALLBACK_KEYS = new Set(["provider", "model", "maxContinuationTurns"]);
const FAMILY_KEYS = new Set([
  "mode",
  "fallback",
  "nativeProviderExclusions",
  "clientToolExclusions",
]);
const TOOL_SEARCH_KEYS = new Set(["mode", "fallback", "maxToolsByModel"]);
// Advisor alone gets this key. A server tool the upstream route cannot resolve
// does not fail quietly in its own lane: its mere presence in `tools` diverts
// the entire request to the fallback route, so an unusable advisor takes down
// turns that never asked for it. "strip" removes the definition and leaves the
// request on its normal route; "passthrough" restores the old behavior for
// re-testing once the gateway can resolve the advisor sub-call.
const ADVISOR_KEYS = new Set([...FAMILY_KEYS, "unsupported"]);
const ADVISOR_UNSUPPORTED = Object.freeze(["strip", "passthrough"]);
export const DEFAULT_ADVISOR_UNSUPPORTED = "strip";
const FAMILY_FALLBACK_KEYS = new Set(["provider", "model"]);
const ROUTE_KEYS = new Set(["default", "background", "opus", "sonnet"]);
const ROUTE_SELECTOR_PATTERN = /^[a-z0-9][a-z0-9._-]*\/\S+$/i;
const TRANSPORT_FALLBACK_KEYS = new Set(["from", "to", "statuses", "scope", "timeoutMs"]);
const TRANSPORT_FALLBACK_TARGET_KEYS = new Set(["provider", "model"]);
const TRANSPORT_FALLBACK_SCOPES = new Set(["all", "classifier"]);
const TRANSPORT_FALLBACK_STATUSES = new Set([401, 408, 429, 499, 500, 502, 503, 504]);
const MODE_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i;
const BARE_CLAUDE_MODEL_PATTERN = /^claude-[a-z0-9][a-z0-9._-]*$/i;
const DEDICATED_LAUNCH_MODEL_PATTERN = /^airkit-[a-z0-9][a-z0-9._-]*$/i;
const EFFORT_LEVELS = new Set(["low", "medium", "high", "xhigh", "max"]);

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
    rejectUnknownKeys(
      definition,
      family === "advisor" ? ADVISOR_KEYS : family === "toolSearch" ? TOOL_SEARCH_KEYS : FAMILY_KEYS,
      family,
    );
    if (
      family === "advisor" &&
      definition.unsupported !== undefined &&
      !ADVISOR_UNSUPPORTED.includes(definition.unsupported)
    ) {
      throw new Error(`advisor.unsupported must be one of: ${ADVISOR_UNSUPPORTED.join(", ")}`);
    }
    if (definition.fallback !== undefined) {
      validateFallback(definition.fallback, `${family}.fallback`, FAMILY_FALLBACK_KEYS, false);
    }
    for (const key of ["nativeProviderExclusions", "clientToolExclusions"]) {
      if (definition[key] !== undefined && (!Array.isArray(definition[key]) || definition[key].some(
        (provider) => typeof provider !== "string" || !/^[a-z0-9][a-z0-9._-]*$/i.test(provider),
      ))) {
        throw new Error(`${family}.${key} must be provider identifiers`);
      }
    }
    if (family === "toolSearch" && definition.maxToolsByModel !== undefined) {
      validateToolSearchLimits(definition.maxToolsByModel);
    }
    if (!modes.includes(definition.mode)) {
      throw new Error(`${family}.mode must be one of: ${modes.join(", ")}`);
    }
  }

  if (config.routeLog !== undefined && typeof config.routeLog !== "boolean") {
    throw new Error("routeLog must be a boolean");
  }

  if (config.launchModel !== undefined && !isSupportedLaunchModelId(config.launchModel)) {
    throw new Error("launchModel must be a bare claude-* model id or a dedicated airkit-* id");
  }

  if (config.modeEffort !== undefined) {
    assertRecord(config.modeEffort, "modeEffort");
    for (const [mode, effort] of Object.entries(config.modeEffort)) {
      if (!isAirkitModeLabel(mode)) {
        throw new Error(`modeEffort key must be a canonical launch mode label: ${mode}`);
      }
      if (typeof effort !== "string" || !EFFORT_LEVELS.has(effort.trim().toLowerCase())) {
        throw new Error(`modeEffort.${mode} must be one of: ${[...EFFORT_LEVELS].join(", ")}`);
      }
    }
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

  if (config.transportFallbacks !== undefined) {
    if (!Array.isArray(config.transportFallbacks)) {
      throw new Error("transportFallbacks must be an array");
    }
    for (const [index, fallback] of config.transportFallbacks.entries()) {
      validateTransportFallback(fallback, `transportFallbacks[${index}]`);
    }
  }

  return config;
}

export function resolveTransportFallback(config, model, status, body = null) {
  validateCompatibilityConfig(config);
  if (typeof model !== "string" || !Number.isInteger(status)) return null;
  const fallback = config.transportFallbacks?.find((entry) =>
    `${entry.from.provider}/${entry.from.model}` === model &&
    entry.statuses.includes(status) &&
    (entry.scope !== "classifier" || isAutoModeClassifierRequest(body)));
  return fallback === undefined ? null : `${fallback.to.provider}/${fallback.to.model}`;
}

export function resolveTransportFallbackPolicy(config, model, body = null) {
  validateCompatibilityConfig(config);
  if (typeof model !== "string") return null;
  const fallback = config.transportFallbacks?.find((entry) =>
    `${entry.from.provider}/${entry.from.model}` === model &&
    (entry.scope !== "classifier" || isAutoModeClassifierRequest(body))
  );
  if (fallback === undefined) return null;
  return {
    selector: `${fallback.to.provider}/${fallback.to.model}`,
    statuses: [...fallback.statuses],
    ...(fallback.timeoutMs === undefined ? {} : { timeoutMs: fallback.timeoutMs }),
  };
}

export function isAutoModeClassifierRequest(body) {
  if (!isRecord(body) || !Array.isArray(body.system)) return false;
  return body.system.some((block) =>
    isRecord(block) && typeof block.text === "string" &&
    block.text.startsWith("You are a security monitor for autonomous AI coding agents."));
}

export function requiresClientToolFallback(config, policies, family, model) {
  if (config?.[family]?.mode === "anthropic-fallback" && policies?.[family] !== "native") return true;
  if (policies?.[family] !== "native" || typeof model !== "string") return false;
  const separator = model.indexOf("/");
  if (separator <= 0) return false;
  return config?.[family]?.nativeProviderExclusions?.includes(model.slice(0, separator)) === true;
}

export function shouldStripClientTool(config, policies, family, model) {
  if (policies?.[family] !== "native" || typeof model !== "string") return false;
  const separator = model.indexOf("/");
  if (separator <= 0) return false;
  return config?.[family]?.clientToolExclusions?.includes(model.slice(0, separator)) === true;
}

export function resolveModeEffort(config, mode) {
  const effort = isRecord(config?.modeEffort) && typeof mode === "string"
    ? config.modeEffort[mode]
    : null;
  return typeof effort === "string" ? effort.trim().toLowerCase() : null;
}

export function resolveToolSearchMaxTools(config, model) {
  const limits = config?.toolSearch?.maxToolsByModel;
  if (!isRecord(limits) || typeof model !== "string") return null;
  const bareModel = model.includes("/") ? model.slice(model.lastIndexOf("/") + 1) : model;
  const exact = limits[model] ?? limits[bareModel];
  if (exact !== undefined) return exact;

  let bestMatch = null;
  let bestPrefixLength = -1;
  for (const [pattern, limit] of Object.entries(limits)) {
    if (!pattern.endsWith("*")) continue;
    const prefix = pattern.slice(0, -1);
    if (bareModel.startsWith(prefix) && prefix.length > bestPrefixLength) {
      bestMatch = limit;
      bestPrefixLength = prefix.length;
    }
  }
  return bestMatch;
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

function validateTransportFallback(fallback, label) {
  assertRecord(fallback, label);
  rejectUnknownKeys(fallback, TRANSPORT_FALLBACK_KEYS, label);
  for (const field of ["from", "to"]) {
    const target = fallback[field];
    assertRecord(target, `${label}.${field}`);
    rejectUnknownKeys(target, TRANSPORT_FALLBACK_TARGET_KEYS, `${label}.${field}`);
    for (const key of ["provider", "model"]) {
      if (typeof target[key] !== "string" || target[key].trim() === "" || target[key].includes("/")) {
        throw new Error(`${label}.${field}.${key} must be a provider-local identifier`);
      }
    }
  }
  if (!Array.isArray(fallback.statuses) || fallback.statuses.length === 0 ||
    fallback.statuses.some((status) => !TRANSPORT_FALLBACK_STATUSES.has(status))) {
    throw new Error(`${label}.statuses must contain supported transport statuses`);
  }
  if (fallback.scope !== undefined && !TRANSPORT_FALLBACK_SCOPES.has(fallback.scope)) {
    throw new Error(`${label}.scope must be one of: ${[...TRANSPORT_FALLBACK_SCOPES].join(", ")}`);
  }
  if (fallback.timeoutMs !== undefined &&
    (!Number.isInteger(fallback.timeoutMs) || fallback.timeoutMs < 1_000 || fallback.timeoutMs > 120_000)) {
    throw new Error(`${label}.timeoutMs must be an integer from 1000 through 120000`);
  }
}

function validateToolSearchLimits(limits) {
  assertRecord(limits, "toolSearch.maxToolsByModel");
  for (const [model, limit] of Object.entries(limits)) {
    if (model.trim() === "") {
      throw new Error("toolSearch.maxToolsByModel keys must be model identifiers");
    }
    if (!Number.isInteger(limit) || limit < 6 || limit > 512) {
      throw new Error("toolSearch.maxToolsByModel values must be integers from 6 through 512");
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

// `launchModel` is the id the launcher itself starts Claude Code with, and it is
// matched before the family prefixes. Without it the launch id and a user's
// in-session pick of the same family are the same string on the wire — Claude
// Code sends a bare id and carries `[1m]` only as an `anthropic-beta` header —
// so a mode whose launch id is `claude-sonnet-5` cannot offer real Sonnet 5 as a
// choice: every request looks like the launcher's. Giving the launcher its own
// id (either a bare `claude-*` id or a dedicated `airkit-*` id) separates the
// two, which is what frees `routes.sonnet`. Profiles that keep a family id as
// their launch model still work: the exact match wins first and
// `routes.sonnet ?? routes.default` preserves the old target. Exact-match launch
// routing stays limited to those two validated launch-id families so arbitrary
// provider models are never promoted into launcher ids.
export function routeBareClaudeModel(body, routes, launchModel = null) {
  if (!isRecord(body) || typeof body.model !== "string") return null;
  if (!isRecord(routes)) return null;
  if (body.model.includes("/")) return null;
  const target = body.model === launchModel && isSupportedLaunchModelId(launchModel)
    ? routes.default
    : !body.model.startsWith("claude-")
      ? null
    : body.model.startsWith("claude-opus-")
      ? routes.opus ?? routes.default
      : body.model.startsWith("claude-haiku-")
        ? routes.background ?? routes.default
        : body.model.startsWith("claude-sonnet-")
          ? routes.sonnet ?? routes.default
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
    advisor: config.advisor.mode === "bridge" ? "bridge" : "anthropic-fallback",
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

  const advisorUnsupported = config.advisor.unsupported ?? DEFAULT_ADVISOR_UNSUPPORTED;

  return Object.freeze({ fallback, familyFallbacks, policies, advisorUnsupported });
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

function isSupportedLaunchModelId(model) {
  return typeof model === "string"
    && (BARE_CLAUDE_MODEL_PATTERN.test(model) || DEDICATED_LAUNCH_MODEL_PATTERN.test(model));
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
  for (const field of ["model", "fallbackModel"]) {
    if (Object.hasOwn(advisor, field)) {
      throw new Error(`advisor.${field} was removed; configure fallback.model instead`);
    }
  }
}
