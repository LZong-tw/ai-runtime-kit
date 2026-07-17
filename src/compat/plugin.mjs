import {
  createCoreClient,
  handleCompatibilityMessage,
  writeAnthropicMessage,
} from "./gateway.mjs";
import {
  VERIFIED_NATIVE_COMPATIBILITY,
  compatibilityFallbackSelector,
  resolveCompatibilityPolicies,
  routeBareClaudeModel,
  validateCompatibilityConfig,
  validateCompatibilityProviderBinding,
} from "./config.mjs";
import { inspectPendingServerHistory } from "./server-history.mjs";
import { inspectServerToolRequest } from "./server-tools.mjs";

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
    const { policies } = resolveCompatibilityPolicies(
      pluginConfig,
      VERIFIED_NATIVE_COMPATIBILITY,
    );
    const runtimeConfig = {
      ...(isRecord(ctx.config) ? ctx.config : {}),
      ...pluginConfig,
      gateway: isRecord(ctx.config?.gateway) ? ctx.config.gateway : pluginConfig.gateway,
    };
    const coreClient = ctx.coreClient ?? createCoreClient({ config: runtimeConfig });

    ctx.registerGatewayRoute({
      auth: "gateway",
      handler: createMessagesHandler({ config: pluginConfig, coreClient, policies }),
      id: "airkit-compatibility-messages",
      method: "POST",
      path: "/v1/messages",
    });
    ctx.registerGatewayRoute({
      auth: "gateway",
      handler: createMcpHandler({ config: pluginConfig, coreClient }),
      id: "airkit-compatibility-mcp",
      method: "POST",
      path: "/airkit/compatibility/mcp",
    });
  },
};

function createMessagesHandler({ config, coreClient, policies }) {
  return async (request, response, helpers) => {
    const rawBody = await helpers.readBody(request);
    const body = parseJsonCopy(rawBody);
    // Route bare Claude model ids before any forwarding decision: this plugin
    // owns POST /v1/messages, so CCR Router rules never see these requests
    // and the core rejects unlisted model names. A single rewrite here covers
    // the raw passthrough and the executor path; the whole-request fallback
    // sets its own provider-qualified selector and is unaffected.
    const routed = routeBareClaudeModel(body, config.routes);
    const outboundBody = routed ?? body;
    const outboundRaw = routed ? Buffer.from(JSON.stringify(routed), "utf8") : rawBody;
    if (!isRecord(outboundBody) || !isConfiguredCompatibilityRequest(outboundBody, policies)) {
      await coreClient.forwardRaw({
        body: outboundRaw,
        headers: request.headers,
        method: request.method,
        response,
        signal: request.signal,
      });
      return;
    }

    const message = await handleCompatibilityMessage({
      body: outboundBody,
      config,
      coreClient,
      headers: request.headers,
      response,
      signal: request.signal,
    });
    if (message !== undefined) {
      writeAnthropicMessage(response, message, outboundBody.stream === true);
    }
  };
}

function isConfiguredCompatibilityRequest(body, policies) {
  const tools = inspectServerToolRequest(body);
  const history = inspectPendingServerHistory(body);
  return (
    tools.serverTools.length > 0 ||
    [...tools.clientFamilies].some((family) => policies[family] !== "native") ||
    history.requiresFallback ||
    history.containerId !== null ||
    (Array.isArray(body.mcp_servers) && body.mcp_servers.length > 0)
  );
}

function createMcpHandler({ config, coreClient }) {
  return async (request, response, helpers) => {
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
      const result = await callWebSearch({ config, coreClient, headers: request.headers, input });
      sendJsonRpcResult(response, requestBody.id, result);
    } catch {
      sendJsonRpcResult(response, requestBody.id, toolError("Web search is unavailable."));
    }
  };
}

async function callWebSearch({ config, coreClient, headers, input }) {
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
