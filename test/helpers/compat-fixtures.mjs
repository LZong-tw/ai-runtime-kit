import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import plugin, { createMcpHandler, createMessagesHandler } from "../../src/compat/plugin.mjs";
import { resolveCompatibilityPolicies, VERIFIED_NATIVE_COMPATIBILITY } from "../../src/compat/config.mjs";

export const CORE_TOKEN = "generated-core-token";
export const RAW_RESPONSE_BODY = Buffer.from([0, 1, 2, 255, 10]);
export const COMPLETE_PLUGIN_CONFIG = {
  fallback: { provider: "anthropic-messages", model: "claude-sonnet", maxContinuationTurns: 8 },
  toolSearch: { mode: "bridge" },
  webSearch: { mode: "native-first" },
  webFetch: { mode: "native-first" },
  codeExecution: { mode: "anthropic-fallback" },
  advisor: { mode: "anthropic-fallback" },
  mcpConnector: { mode: "anthropic-fallback" },
};
export const PLUGIN_RUNTIME_CONFIG = {
  Providers: [{ name: "anthropic-messages", type: "anthropic_messages", models: ["claude-sonnet"] }],
};

export async function createPluginFixture(options = {}) {
  const coreCalls = [];
  let readCount = 0;
  const helpers = {
    async readBody(request) {
      readCount += 1;
      return request.body;
    },
  };
  const coreClient = options.coreClient ?? createPluginCoreClient({
    async requestMessage(body, headers) {
      coreCalls.push({ body: structuredClone(body), headers: structuredClone(headers ?? {}) });
      return webSearchMessage();
    },
  });
  const handlers = await createPluginHandlers({
    coreClient,
    requestStore: options.requestStore,
    sseKeepalive: options.sseKeepalive,
    pluginConfig: { ...structuredClone(COMPLETE_PLUGIN_CONFIG), ...options.pluginConfig },
  });
  const { mcp } = handlers;
  return {
    coreCalls,
    helpers,
    messages: handlers.messages,
    mcp,
    get readCount() { return readCount; },
    async callMcp(method, params, { notification = false } = {}) {
      return this.callRawMcp(Buffer.from(JSON.stringify({
        jsonrpc: "2.0",
        ...(notification ? {} : { id: 17 }),
        method,
        ...(params === undefined ? {} : { params }),
      })));
    },
    async callRawMcp(body) {
      const response = createRecordingResponse();
      await mcp.handler(createPluginRequest(body), response, helpers);
      return {
        body: response.body,
        json: response.body.length === 0 ? undefined : JSON.parse(response.body.toString("utf8")),
        statusCode: response.statusCode,
      };
    },
  };
}

export async function createPluginHandlers({
  config = structuredClone(PLUGIN_RUNTIME_CONFIG), coreClient, pluginConfig, requestStore = null, sseKeepalive,
}) {
  await plugin.setup({ config, coreClient, pluginConfig });
  const { policies } = resolveCompatibilityPolicies(pluginConfig, VERIFIED_NATIVE_COMPATIBILITY);
  return {
    mcp: { handler: createMcpHandler({ config: pluginConfig, coreClient, requestStore }) },
    messages: { handler: createMessagesHandler({ config: pluginConfig, coreClient, policies, requestStore, sseKeepalive }) },
  };
}

export function createPluginCoreClient(overrides = {}) {
  return {
    async forwardRaw() { throw new Error("unexpected raw passthrough"); },
    async requestMessage() { throw new Error("unexpected core request"); },
    async requestFallback() { throw new Error("unexpected fallback request"); },
    ...overrides,
  };
}

export function createPluginRequest(body, { headers, signal } = {}) {
  return Object.assign(new EventEmitter(), {
    body,
    headers: { "content-type": "application/json", "x-request-id": "fixture-request", ...headers },
    method: "POST",
    signal,
  });
}

export function message(overrides = {}) {
  return {
    id: "msg_fixture", type: "message", role: "assistant", model: "executor-model", content: [],
    stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 },
    ...overrides,
  };
}

export function webSearchMessage(overrides = {}) {
  return message({
    content: [
      { type: "server_tool_use", id: "srvtoolu_web", name: "web_search", input: { query: "current protocol release" } },
      {
        type: "web_search_tool_result", tool_use_id: "srvtoolu_web",
        content: [{ type: "web_search_result", title: "Protocol release", url: "https://example.com/release", page_age: "today", encrypted_content: "opaque-provider-value" }],
      },
      { type: "text", text: "Current release summary." },
    ],
    ...overrides,
  });
}

export async function createCoreFixture(t, { coreHost = "127.0.0.1", tokenEntry = CORE_TOKEN } = {}) {
  let notifyRequestStarted;
  const requestStarted = new Promise((resolve) => { notifyRequestStarted = resolve; });
  const seen = {};
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    seen.body = Buffer.concat(chunks);
    seen.headers = request.headers;
    seen.host = request.headers.host;
    notifyRequestStarted();
    const body = JSON.parse(seen.body.toString("utf8"));
    if (body.model === "wait-for-abort") return;
    if (body.model === "executor") {
      response.writeHead(202, { "content-type": "application/octet-stream" });
      response.end(RAW_RESPONSE_BODY);
      return;
    }
    if (body.model === "rate-limited" || body.model === "oneportal/gpt-5.6-terra") {
      response.writeHead(429, { "content-type": "application/json", "retry-after": "4", "x-request-id": "upstream-rate-limit" });
      response.end(JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "try later" } }));
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ type: "message", content: [] }));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();
  return {
    coreToken: CORE_TOKEN,
    options: {
      config: { gateway: { coreHost, corePort: port, generatedConfigFile: "/fixture/generated.json" } },
      readFile: () => generatedConfig(tokenEntry),
    },
    port, rawResponseBody: RAW_RESPONSE_BODY, requestStarted, seen,
  };
}

export function generatedConfig(tokenEntry) {
  return JSON.stringify({ auth: { staticApiKeys: { keys: [tokenEntry] } } });
}

export function createRecordingResponse({ backpressure = false, endEvent = "finish" } = {}) {
  const chunks = [];
  let notifyFirstWrite;
  const firstWrite = new Promise((resolve) => { notifyFirstWrite = resolve; });
  const response = Object.assign(new EventEmitter(), {
    ended: false, firstWrite, headers: {}, headersSent: false, statusCode: 200,
    writableEnded: false, writableFinished: false,
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    getHeader(name) { return this.headers[name.toLowerCase()]; },
    writeHead(statusCode, headers) {
      // Node throws ERR_HTTP_HEADERS_SENT here; a silent overwrite would hide a double write.
      if (this.headersSent) throw Object.assign(new Error("headers already sent"), { code: "ERR_HTTP_HEADERS_SENT" });
      this.statusCode = statusCode;
      this.headersSent = true;
      this.headers = { ...this.headers, ...Object.fromEntries(
        Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]),
      ) };
    },
    write(chunk) {
      chunks.push(Buffer.from(chunk));
      notifyFirstWrite();
      return !backpressure;
    },
    end(chunk) {
      if (chunk !== undefined) chunks.push(Buffer.from(chunk));
      this.ended = true;
      this.writableEnded = true;
      if (endEvent !== null) {
        if (endEvent === "finish") this.writableFinished = true;
        this.emit(endEvent);
      }
    },
    releaseDrain() { backpressure = false; this.emit("drain"); },
  });
  Object.defineProperty(response, "body", { get: () => Buffer.concat(chunks) });
  return response;
}
