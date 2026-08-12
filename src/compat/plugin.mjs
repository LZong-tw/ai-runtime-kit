import { createHash, randomUUID } from "node:crypto";

import {
  handleCompatibilityMessage,
  writeAnthropicMessage,
} from "./gateway.mjs";
import {
  DEFAULT_ADVISOR_UNSUPPORTED,
  VERIFIED_NATIVE_COMPATIBILITY,
  compatibilityFallbackSelector,
  requestedMode,
  resolveCompatibilityPolicies,
  resolveModeEffort,
  resolveModeRoutes,
  resolveTransportFallback,
  resolveToolSearchMaxTools,
  requiresClientToolFallback,
  routeBareClaudeModel,
  shouldStripClientTool,
  validateCompatibilityConfig,
  validateCompatibilityProviderBinding,
} from "./config.mjs";
import {
  ensureGptMinimumOutputTokens,
  rewriteClaudeEffortForOpenAI,
} from "./effort.mjs";
import { inspectPendingServerHistory } from "./server-history.mjs";
import {
  inspectServerToolRequest,
  stripClientToolFamily,
  stripServerToolFamily,
} from "./server-tools.mjs";
import { applyToolSearchBudget } from "./tool-search.mjs";
import { classifyCacheCohort, describeStablePrefix } from "./prefix-observability.mjs";

const MCP_PROTOCOL_VERSION = "2025-03-26";
const MAX_QUERY_LENGTH = 1_000;
const MAX_DOMAIN_COUNT = 20;
const MAX_DOMAIN_LENGTH = 253;
const MAX_RESULT_COUNT = 20;
const MAX_TITLE_LENGTH = 512;
const MAX_URL_LENGTH = 2_048;
const MAX_PAGE_AGE_LENGTH = 128;
const MAX_SUMMARY_LENGTH = 4_096;
const WEB_SEARCH_TOOL = {
  name: "web_search",
  description: "Search the current web through the configured Anthropic WebSearch model.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string" },
      allowed_domains: { type: "array", items: { type: "string" } },
      blocked_domains: { type: "array", items: { type: "string" } },
    },
    required: ["query"],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true },
};

export default {
  async setup(ctx) {
    const pluginConfig = isRecord(ctx.pluginConfig) ? ctx.pluginConfig : {};
    validateCompatibilityConfig(pluginConfig);
    validateCompatibilityProviderBinding(pluginConfig, ctx.config?.Providers);
  },
};

// The loopback middleware reuses these handlers, while CCR itself retains
// ownership of public gateway routes and its native request recorder.
function requestLifecycleSignal(request, response) {
  const controller = new AbortController();
  const abort = () => {
    if (!controller.signal.aborted) controller.abort(new Error("client disconnected"));
  };
  if (typeof response?.once === "function") {
    response.once("close", () => {
      if (response.writableFinished !== true) abort();
    });
  }
  if (typeof request?.once === "function") {
    request.once("aborted", abort);
    request.once("error", abort);
  }
  const upstreamSignal = request?.signal;
  if (typeof upstreamSignal?.addEventListener === "function") {
    if (upstreamSignal.aborted) abort();
    else upstreamSignal.addEventListener("abort", abort, { once: true });
  }
  return controller.signal;
}

function containHandlerFailure(response, error) {
  if (response?.headersSent !== true && typeof response?.writeHead === "function") {
    response.writeHead(502, { "content-type": "application/json" });
    response.end(JSON.stringify({
      error: { message: "compatibility forwarding failed", type: "api_error" },
    }));
    return "forwarding_failed";
  }
  response?.destroy?.(error instanceof Error ? error : new Error(String(error)));
  return "response_destroyed";
}

export function createMessagesHandler({ config, coreClient, policies }) {
  return async (request, response, helpers) => {
    const signal = requestLifecycleSignal(request, response);
    const telemetry = beginRequestTelemetry(config.routeLog, request, response);
    let outcome = "completed";
    try {
      const rawBody = await helpers.readBody(request);
      const body = parseJsonCopy(rawBody);
      // Route bare Claude model ids before any forwarding decision: this
      // plugin owns POST /v1/messages, so CCR Router rules never see these
      // requests and the core rejects unlisted model names. A single rewrite
      // here covers the raw passthrough and the executor path; the
      // whole-request fallback sets its own provider-qualified selector and
      // is unaffected. Each launch mode wants a different target model, so the
      // caller's own mode label picks the table.
      const mode = requestedMode(request?.headers);
      const routed = routeBareClaudeModel(body, resolveModeRoutes(config, mode), config.launchModel ?? null);
      const routedBody = routed ?? body;
      // Before the compatibility decision, apply the configured Advisor policy.
      // Fallback mode strips an unresolved definition before it can divert an
      // otherwise ordinary request; bridge mode keeps it so the gateway can
      // expose the synthetic Advisor tool and resume the turn.
      const advisorBridgeEnabled = policies?.advisor === "bridge";
      const scopedBody = !advisorBridgeEnabled &&
        (config.advisor?.unsupported ?? DEFAULT_ADVISOR_UNSUPPORTED) === "strip"
        ? stripServerToolFamily(routedBody, "advisor")
        : routedBody;
      const clientToolScopedBody = stripExcludedClientTools(scopedBody, config, policies);
      const modeEffort = typeof body?.model === "string" && body.model.startsWith("claude-sonnet-")
        ? resolveModeEffort(config, mode)
        : null;
      const effortAdjustedBody = rewriteClaudeEffortForOpenAI(clientToolScopedBody, modeEffort);
      const outputBudgetAdjustedBody = ensureGptMinimumOutputTokens(effortAdjustedBody);
      const outboundBody = applyToolSearchBudget(
        outputBudgetAdjustedBody,
        resolveToolSearchMaxTools(config, outputBudgetAdjustedBody?.model),
      );
      const outboundRaw = outboundBody === body
        ? rawBody
        : Buffer.from(JSON.stringify(outboundBody), "utf8");
      const compat = isRecord(outboundBody) && isConfiguredCompatibilityRequest(outboundBody, policies, config);
      const stablePrefix = describeStablePrefix(outboundBody);
      telemetry.stablePrefix = stablePrefix;
      telemetry.decision = describeRouteDecision({
        body,
        mode,
        outboundBody,
        path: compat ? "compat" : "passthrough",
        stablePrefix,
      });
      logRouteDecision({
        enabled: config.routeLog,
        decision: telemetry.decision,
        request,
        requestId: telemetry.requestId,
      });
      if (!compat) {
        const fallbackSelector = isRecord(outboundBody)
          ? resolveTransportFallback(config, outboundBody.model, 401)
          : null;
        const fallback = fallbackSelector === null ? undefined : {
          body: Buffer.from(JSON.stringify({ ...outboundBody, model: fallbackSelector }), "utf8"),
          statuses: [401],
        };
        await coreClient.forwardRaw({
          body: outboundRaw,
          fallback,
          headers: request.headers,
          method: request.method,
          response,
          signal,
          onResponse: ({ headers }) => {
            telemetry.promptCache = summarizeGatewayResponseHeaders(headers);
          },
        });
        return;
      }

      const message = await handleCompatibilityMessage({
        body: outboundBody,
        config,
        coreClient,
        headers: request.headers,
        response,
        signal,
      });
      if (message !== undefined) {
        telemetry.promptCache = summarizePromptCacheUsage(message.usage, message.model);
        writeAnthropicMessage(response, message, outboundBody.stream === true);
      }
    } catch (error) {
      outcome = signal.aborted
        ? "client_aborted"
        : containHandlerFailure(response, error);
    } finally {
      if (outcome === "completed" && signal.aborted) outcome = "client_aborted";
      const terminalEvent = await waitForResponseTerminal(telemetry, outcome);
      if (outcome === "completed" && terminalEvent === "close") outcome = "client_aborted";
      if (outcome === "completed" && terminalEvent === "error") outcome = "response_destroyed";
      logRequestTerminal({ outcome, response, telemetry });
    }
  };
}

function stripExcludedClientTools(body, config, policies) {
  let scoped = body;
  const tools = inspectServerToolRequest(body);
  for (const family of tools.clientFamilies) {
    if (shouldStripClientTool(config, policies, family, scoped?.model)) {
      scoped = stripClientToolFamily(scoped, family);
    }
  }
  return scoped;
}

function beginRequestTelemetry(enabled, request, response) {
  if (enabled !== true) {
    return {
      decision: null,
      enabled: false,
      finished: false,
      requestId: null,
      promptCache: null,
      responseTerminal: null,
      startedAt: null,
      stablePrefix: null,
    };
  }
  return {
    decision: null,
    enabled: true,
    finished: false,
    requestId: safeRequestId(request?.headers),
    promptCache: null,
    responseTerminal: observeResponseTerminal(response),
    startedAt: process.hrtime.bigint(),
  };
}

function observeResponseTerminal(response) {
  if (typeof response?.once !== "function") return null;
  let resolveCompletion;
  let settled = false;
  const completion = new Promise((resolve) => {
    resolveCompletion = resolve;
  });
  const cleanup = () => {
    response.off?.("finish", onFinish);
    response.off?.("close", onClose);
    response.off?.("error", onError);
  };
  const settle = (event) => {
    if (settled) return;
    settled = true;
    cleanup();
    resolveCompletion(event);
  };
  const onFinish = () => settle("finish");
  const onClose = () => settle("close");
  const onError = () => settle("error");

  response.once("finish", onFinish);
  response.once("close", onClose);
  response.once("error", onError);
  if (response.writableFinished === true) settle("finish");
  else if (response.destroyed === true) settle("close");

  return { cancel: () => settle(null), completion };
}

async function waitForResponseTerminal(telemetry, outcome) {
  const observer = telemetry.responseTerminal;
  if (observer === null) return null;
  if (outcome !== "completed" && outcome !== "forwarding_failed") {
    observer.cancel();
    return null;
  }
  return observer.completion;
}

function safeRequestId(headers) {
  const candidate = isRecord(headers) && typeof headers["x-request-id"] === "string"
    ? headers["x-request-id"]
    : "";
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(candidate) ? candidate : randomUUID();
}

function describeRouteDecision({ body, mode, outboundBody, path, stablePrefix }) {
  const inModel = isRecord(body) && typeof body.model === "string" ? body.model : null;
  const outModel = isRecord(outboundBody) && typeof outboundBody.model === "string"
    ? outboundBody.model
    : null;
  return {
    inModel,
    mode: mode ?? null,
    outModel,
    path,
    rewritten: inModel !== outModel,
    stream: isRecord(body) && body.stream === true,
    ...(stablePrefix?.candidate === true ? { stablePrefix } : {}),
  };
}

// The loopback middleware owns compatibility decisions. Its terminal record
// supplements CCR's native outer-gateway entry without exposing credentials.
function logRouteDecision({ enabled, decision, request, requestId }) {
  if (enabled !== true) return;
  try {
    process.stderr.write(`[airkit-route] ${JSON.stringify({
      at: new Date().toISOString(),
      authId: presentedCredentialId(request?.headers),
      ...decision,
      requestId,
    })}\n`);
  } catch {
    // never let logging interfere with the request
  }
}

function logRequestTerminal({ outcome, response, telemetry }) {
  if (telemetry.enabled !== true || telemetry.finished) return;
  telemetry.finished = true;
  try {
    const decision = telemetry.decision ?? {
      inModel: null,
      mode: null,
      outModel: null,
      path: null,
      stream: false,
    };
    const elapsed = Number(process.hrtime.bigint() - telemetry.startedAt) / 1_000_000;
    process.stderr.write(`[airkit-request] ${JSON.stringify({
      at: new Date().toISOString(),
      requestId: telemetry.requestId,
      path: decision.path,
      mode: decision.mode,
      inModel: decision.inModel,
      outModel: decision.outModel,
      provider: selectorProvider(decision.outModel),
      stream: decision.stream,
      status: outcome === "client_aborted"
        ? committedResponseStatus(response)
        : responseStatus(response),
      durationMs: Math.max(0, elapsed),
      outcome,
      ...(decision.stablePrefix ? { stablePrefix: decision.stablePrefix } : {}),
      cacheCohort: classifyCacheCohort(telemetry.stablePrefix, telemetry.promptCache),
      ...(telemetry.promptCache ? { promptCache: telemetry.promptCache } : {}),
    })}\n`);
  } catch {
    // never let logging interfere with the request
  }
}

function summarizePromptCacheUsage(usage, model = null) {
  if (!isRecord(usage)) return null;
  const metadata = isRecord(usage.usageMetadata) ? usage.usageMetadata : {};
  const hit = nonNegativeCounter(usage.prompt_tokens_details?.cached_tokens)
    ?? nonNegativeCounter(usage.input_tokens_details?.cached_tokens)
    ?? nonNegativeCounter(usage.prompt_cache_hit_tokens)
    ?? nonNegativeCounter(usage.cache_read_input_tokens)
    ?? nonNegativeCounter(usage.cache_read_tokens)
    ?? nonNegativeCounter(metadata.cachedContentTokenCount);
  const explicitMiss = nonNegativeCounter(usage.prompt_cache_miss_tokens)
    ?? nonNegativeCounter(usage.cache_miss_input_tokens)
    ?? nonNegativeCounter(usage.cache_miss_tokens);
  const promptTokens = nonNegativeCounter(usage.prompt_tokens)
    ?? nonNegativeCounter(metadata.promptTokenCount);
  const inputTokens = nonNegativeCounter(usage.input_tokens);
  const creation = nonNegativeCounter(usage.cache_creation_input_tokens)
    ?? nonNegativeCounter(usage.cache_write_input_tokens)
    ?? nonNegativeCounter(usage.cache_write_tokens);
  const gptLike = isGptModel(model);
  const miss = explicitMiss
    ?? (nonNegativeCounter(metadata.promptTokenCount) !== null && hit !== null
      ? Math.max(0, metadata.promptTokenCount - hit)
      : null)
    ?? (promptTokens !== null && hit !== null && promptTokens >= hit
      ? promptTokens - hit
      : gptLike && hit !== null && inputTokens !== null && inputTokens >= hit
        ? inputTokens - hit
        : hit !== null && inputTokens !== null ? inputTokens : null);
  if (hit === null && miss === null && creation === null) return null;
  const total = promptTokens !== null || (gptLike && inputTokens !== null)
    ? promptTokens ?? inputTokens
    : hit !== null || miss !== null || creation !== null
      ? sumKnown(hit, miss, creation)
      : inputTokens;
  return {
    prompt_cache_hit_tokens: hit,
    prompt_cache_miss_tokens: miss,
    cache_read_input_tokens: hit,
    cache_creation_input_tokens: creation,
    cache_miss_input_tokens: miss,
    hit_rate: hit !== null && total !== null && total > 0 ? hit / total : null,
  };
}

function isGptModel(model) {
  return typeof model === "string" && /(?:^|[/:-])gpt-/i.test(model);
}

function summarizeGatewayResponseHeaders(headers) {
  const hit = headerCounter(headers, "x-gateway-billing-cache-read-tokens");
  const creation = headerCounter(headers, "x-gateway-billing-cache-write-tokens");
  const input = headerCounter(headers, "x-gateway-billing-input-tokens");
  if (hit === null && creation === null && input === null) return null;
  const miss = input !== null && hit !== null ? Math.max(0, input - hit) : null;
  const total = input ?? sumKnown(hit, miss, creation);
  return {
    prompt_cache_hit_tokens: hit,
    prompt_cache_miss_tokens: miss,
    cache_read_input_tokens: hit,
    cache_creation_input_tokens: creation,
    cache_miss_input_tokens: miss,
    hit_rate: hit !== null && total !== null && total > 0 && (input !== null || miss !== null)
      ? hit / total
      : null,
    source: "gateway-response-header",
  };
}

function headerCounter(headers, name) {
  const raw = typeof headers?.get === "function"
    ? headers.get(name)
    : isRecord(headers)
      ? Object.entries(headers).find(([key]) => key.toLowerCase() === name)?.[1]
      : null;
  if (raw === null || raw === undefined || raw === "") return null;
  const value = typeof raw === "number" ? raw : Number(raw);
  return nonNegativeCounter(value);
}

function sumKnown(...values) {
  const known = values.filter((value) => value !== null);
  return known.length > 0 ? known.reduce((total, value) => total + value, 0) : null;
}

function nonNegativeCounter(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function selectorProvider(selector) {
  if (typeof selector !== "string") return null;
  const separator = selector.indexOf("/");
  return separator > 0 ? selector.slice(0, separator) : null;
}

function responseStatus(response) {
  const status = response?.statusCode;
  return Number.isInteger(status) && status >= 100 && status <= 999 ? status : null;
}

function committedResponseStatus(response) {
  return response?.headersSent === true ? responseStatus(response) : null;
}

function presentedCredentialId(headers) {
  if (!isRecord(headers)) return null;
  const bearer = typeof headers.authorization === "string"
    ? headers.authorization.replace(/^Bearer\s+/i, "").trim()
    : "";
  const credential = bearer !== ""
    ? bearer
    : typeof headers["x-api-key"] === "string" ? headers["x-api-key"].trim() : "";
  if (credential === "") return null;
  return createHash("sha256").update(credential).digest("hex").slice(0, 8);
}

function isConfiguredCompatibilityRequest(body, policies, config) {
  const tools = inspectServerToolRequest(body);
  const history = inspectPendingServerHistory(body);
  return (
    tools.serverTools.length > 0 ||
    [...tools.clientFamilies].some((family) =>
      requiresClientToolFallback(config, policies, family, body.model)) ||
    history.requiresFallback ||
    history.containerId !== null ||
    (Array.isArray(body.mcp_servers) && body.mcp_servers.length > 0)
  );
}

export function createMcpHandler({ config, coreClient }) {
  return async (request, response, helpers) => {
    const signal = requestLifecycleSignal(request, response);
    try {
      await handleMcpRequest({ config, coreClient, helpers, request, response, signal });
    } catch (error) {
      if (signal.aborted || response?.destroyed === true) return;
      containHandlerFailure(response, error);
    }
  };
}

export async function handleMcpRequest({ config, coreClient, helpers, request, response, signal }) {
    const rawBody = await helpers.readBody(request);
    let requestBody;
    try {
      requestBody = JSON.parse(Buffer.from(rawBody).toString("utf8"));
    } catch {
      sendJsonRpcError(response, null, -32700, "Parse error");
      return;
    }

    if (!isJsonRpcRequest(requestBody)) {
      sendJsonRpcError(response, null, -32600, "Invalid Request");
      return;
    }
    if (requestBody.method === "notifications/initialized" && !Object.hasOwn(requestBody, "id")) {
      response.writeHead(202, {});
      response.end();
      return;
    }
    if (requestBody.method === "initialize") {
      sendJsonRpcResult(response, requestBody.id, {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: "airkit-compatibility", version: "1.0.0" },
      });
      return;
    }
    if (requestBody.method === "tools/list") {
      sendJsonRpcResult(response, requestBody.id, { tools: [structuredClone(WEB_SEARCH_TOOL)] });
      return;
    }
    if (requestBody.method !== "tools/call") {
      sendJsonRpcError(response, requestBody.id, -32601, "Method not found");
      return;
    }
    if (!isRecord(requestBody.params) || requestBody.params.name !== WEB_SEARCH_TOOL.name) {
      sendJsonRpcError(response, requestBody.id, -32602, "Unknown tool");
      return;
    }

    let input;
    try {
      input = validateWebSearchInput(requestBody.params.arguments);
    } catch {
      sendJsonRpcResult(response, requestBody.id, toolError("Invalid web search request."));
      return;
    }

    try {
      const result = await callWebSearch({
        config,
        coreClient,
        headers: request.headers,
        input,
        signal,
      });
      sendJsonRpcResult(response, requestBody.id, result);
    } catch {
      if (signal?.aborted || response?.destroyed === true) return;
      sendJsonRpcResult(response, requestBody.id, toolError("Web search is unavailable."));
    }
}

async function callWebSearch({ config, coreClient, headers, input, signal }) {
  const tool = {
    type: "web_search_20250305",
    name: "web_search",
    max_uses: boundedMaxUses(config.webSearch?.maxUses),
  };
  if (input.allowed_domains !== undefined) tool.allowed_domains = input.allowed_domains;
  if (input.blocked_domains !== undefined) tool.blocked_domains = input.blocked_domains;

  const message = await coreClient.requestMessage(
    {
      model: compatibilityFallbackSelector(config.fallback),
      max_tokens: 1_024,
      messages: [{ role: "user", content: input.query }],
      stream: false,
      tools: [tool],
      tool_choice: { type: "tool", name: "web_search" },
    },
    headers,
    signal,
  );
  if (message?.type !== "message" || !Array.isArray(message.content)) {
    throw new Error("Invalid WebSearch response");
  }
  if (message.content.some((block) =>
    block?.type === "web_search_tool_result" &&
    isRecord(block.content) &&
    block.content.type === "web_search_tool_result_error")) {
    throw new Error("WebSearch provider error");
  }

  const results = sanitizeSearchResults(message.content);
  const summary = message.content
    .filter((block) => block?.type === "text")
    .map((block) => String(block.text ?? ""))
    .join("")
    .slice(0, MAX_SUMMARY_LENGTH);
  return {
    content: [{ type: "text", text: summary }],
    structuredContent: { results, summary },
  };
}

function validateWebSearchInput(value) {
  if (!isRecord(value)) throw new Error("Invalid input");
  const allowedKeys = new Set(["query", "allowed_domains", "blocked_domains"]);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) throw new Error("Invalid input");
  if (typeof value.query !== "string") throw new Error("Invalid query");
  const query = value.query.trim();
  if (query.length === 0 || query.length > MAX_QUERY_LENGTH) throw new Error("Invalid query");
  const allowedDomains = validateDomains(value.allowed_domains);
  const blockedDomains = validateDomains(value.blocked_domains);
  if (allowedDomains !== undefined && blockedDomains !== undefined) {
    throw new Error("Conflicting domain filters");
  }
  return {
    query,
    ...(allowedDomains === undefined ? {} : { allowed_domains: allowedDomains }),
    ...(blockedDomains === undefined ? {} : { blocked_domains: blockedDomains }),
  };
}

function validateDomains(value) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_DOMAIN_COUNT) {
    throw new Error("Invalid domain filter");
  }
  return value.map((entry) => {
    if (typeof entry !== "string") throw new Error("Invalid domain");
    const domain = entry.trim().toLowerCase();
    if (
      domain.length === 0 ||
      domain.length > MAX_DOMAIN_LENGTH ||
      !/^(?:\*\.)?(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(domain)
    ) {
      throw new Error("Invalid domain");
    }
    return domain;
  });
}

function sanitizeSearchResults(content) {
  const results = [];
  for (const block of content) {
    if (block?.type !== "web_search_tool_result" || !Array.isArray(block.content)) continue;
    for (const item of block.content) {
      if (item?.type !== "web_search_result" || results.length >= MAX_RESULT_COUNT) continue;
      const url = sanitizePublicUrl(item.url);
      if (url === null) continue;
      const result = {
        title: String(item.title ?? "").slice(0, MAX_TITLE_LENGTH),
        url,
      };
      if (typeof item.page_age === "string" && item.page_age.length > 0) {
        result.pageAge = item.page_age.slice(0, MAX_PAGE_AGE_LENGTH);
      }
      results.push(result);
    }
  }
  return results;
}

function sanitizePublicUrl(value) {
  if (typeof value !== "string" || value.length > MAX_URL_LENGTH) return null;
  try {
    const url = new URL(value);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username.length > 0 ||
      url.password.length > 0
    ) {
      return null;
    }
    return url.href;
  } catch {
    return null;
  }
}

function parseJsonCopy(rawBody) {
  try {
    return JSON.parse(Buffer.from(rawBody).toString("utf8"));
  } catch {
    return null;
  }
}

function isJsonRpcRequest(value) {
  if (!isRecord(value) || value.jsonrpc !== "2.0" || typeof value.method !== "string") {
    return false;
  }
  if (!Object.hasOwn(value, "id")) return true;
  return value.id === null || typeof value.id === "string" || Number.isFinite(value.id);
}

function boundedMaxUses(value) {
  return Number.isInteger(value) ? Math.max(1, Math.min(value, 10)) : 5;
}

function toolError(text) {
  return { content: [{ type: "text", text }], isError: true };
}

function sendJsonRpcResult(response, id, result) {
  sendJson(response, 200, { jsonrpc: "2.0", id: id ?? null, result });
}

function sendJsonRpcError(response, id, code, message) {
  sendJson(response, 200, { jsonrpc: "2.0", id: id ?? null, error: { code, message } });
}

function sendJson(response, statusCode, body) {
  response.writeHead(statusCode, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
