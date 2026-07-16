import { readFileSync } from "node:fs";
import {
  TOOL_SEARCH_TYPES,
  inspectCompatibilityRequest,
} from "./protocol.mjs";
import { createFallbackRouter } from "./fallback.mjs";
import {
  VERIFIED_NATIVE_COMPATIBILITY,
  resolveCompatibilityPolicies,
} from "./config.mjs";
import { inspectPendingServerHistory } from "./server-history.mjs";
import { inspectServerToolRequest } from "./server-tools.mjs";
import { bridgeToolSearch } from "./tool-search.mjs";

const TOOL_SEARCH_BRIDGE_NAME = "airkit_tool_search";
const MAX_EXECUTOR_ITERATIONS = 8;
const MAX_HISTORY_TEXT_LENGTH = 4_096;

const SAFE_HEADER_NAMES = new Set([
  "accept",
  "anthropic-beta",
  "anthropic-version",
  "b3",
  "baggage",
  "request-id",
  "traceparent",
  "tracestate",
  "user-agent",
  "x-amzn-trace-id",
  "x-b3-flags",
  "x-b3-parentspanid",
  "x-b3-sampled",
  "x-b3-spanid",
  "x-b3-traceid",
  "x-cloud-trace-context",
  "x-datadog-origin",
  "x-datadog-parent-id",
  "x-datadog-sampling-priority",
  "x-datadog-tags",
  "x-datadog-trace-id",
  "x-request-id",
]);

export function createCoreClient({ config, fetchImpl = fetch, readFile = readFileSync }) {
  const endpoint = coreMessagesEndpoint(config.gateway);
  const coreHeaders = (headers = {}) => ({
    ...copySafeAnthropicHeaders(headers),
    "content-type": "application/json",
    "x-ccr-core-auth": readGeneratedCoreToken(config.gateway.generatedConfigFile, readFile),
  });

  return {
    async requestFallback(body, headers, signal) {
      return fetchImpl(endpoint, {
        method: "POST",
        headers: coreHeaders(headers),
        body: JSON.stringify(body),
        signal,
      });
    },
    async requestMessage(body, headers, signal) {
      const result = await fetchImpl(endpoint, {
        method: "POST",
        headers: coreHeaders(headers),
        body: JSON.stringify({ ...body, stream: false }),
        signal,
      });
      return parseCoreMessageResponse(result);
    },
    async forwardRaw({ body, headers, method = "POST", response, signal }) {
      const result = await fetchImpl(endpoint, {
        method,
        headers: coreHeaders(headers),
        body,
        signal,
      });
      await pipeCoreResponse(result, response, signal);
    },
  };
}

export async function handleCompatibilityMessage({
  body,
  headers,
  config,
  coreClient,
  createId = defaultCreateId,
  response,
  signal,
}) {
  const serverTools = inspectServerToolRequest(body);
  const serverHistory = inspectPendingServerHistory(body);
  if (requiresWholeRequestFallback({ body, config, serverHistory, serverTools })) {
    return routeWholeRequestFallback({ body, headers, config, coreClient, response, signal });
  }

  const inspection = inspectCompatibilityRequest(body);
  let normalized;
  try {
    normalized = normalizeCompatibilityHistory(body.messages);
  } catch {
    return routeWholeRequestFallback({ body, headers, config, coreClient, response, signal });
  }

  const activeDeferredTools = new Set(normalized.referencedTools);
  const executorUsage = [];
  const outwardContent = [];
  const messages = normalized.messages;

  for (let iteration = 0; iteration < MAX_EXECUTOR_ITERATIONS; iteration += 1) {
    const executorBody = {
      ...body,
      messages,
      tools: createExecutorTools(body.tools, inspection, activeDeferredTools),
      stream: false,
    };
    const executorMessage = await requestCoreMessage(
      coreClient,
      executorBody,
      headers,
      "CCR executor request failed",
      signal,
    );
    executorUsage.push(copyUsage(executorMessage.usage));

    const bridgeCalls = executorMessage.content.filter(
      (block) => block?.type === "tool_use" && block.name === TOOL_SEARCH_BRIDGE_NAME,
    );

    if (bridgeCalls.length === 0) {
      outwardContent.push(...executorMessage.content.map((block) => structuredClone(block)));
      return finalizeMessage(executorMessage, outwardContent, executorUsage);
    }

    const resumeResults = [];
    let hasNormalToolCall = false;
    for (const call of executorMessage.content) {
      if (
        call?.type !== "tool_use" ||
        call.name !== TOOL_SEARCH_BRIDGE_NAME
      ) {
        outwardContent.push(structuredClone(call));
        if (call?.type === "tool_use") hasNormalToolCall = true;
        continue;
      }
      const serverUseId = createId("srvtoolu");
      const serverUse = {
        type: "server_tool_use",
        id: serverUseId,
        name: inspection.toolSearch?.name ?? "tool_search",
        input: structuredClone(call.input ?? {}),
      };
      outwardContent.push(serverUse);

      const bridged = bridgeToolSearch({
        body,
        definition: inspection.toolSearch,
        query: call.input?.query,
        toolUseId: serverUseId,
      });
      if (bridged.kind === "fallback") {
        return routeWholeRequestFallback({ body, headers, config, coreClient, response, signal });
      }
      const result = bridged.block;
      for (const reference of result.content.tool_references ?? []) {
        activeDeferredTools.add(reference.tool_name);
      }
      outwardContent.push(result);
      resumeResults.push(bridgeResumeResult(call.id, toolSearchResultText(result)));
    }

    if (hasNormalToolCall) {
      return finalizeMessage(executorMessage, outwardContent, executorUsage);
    }

    messages.push({ role: "assistant", content: structuredClone(executorMessage.content) });
    messages.push({ role: "user", content: resumeResults });
  }

  return routeWholeRequestFallback({ body, headers, config, coreClient, response, signal });
}

export function writeAnthropicMessage(response, message, stream) {
  if (!stream) {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(message));
    return;
  }

  response.writeHead(200, {
    "cache-control": "no-cache",
    connection: "keep-alive",
    "content-type": "text/event-stream",
  });
  writeSse(response, "message_start", {
    type: "message_start",
    message: {
      ...message,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: messageStartUsage(message.usage),
    },
  });

  for (const [index, block] of message.content.entries()) {
    const completeStart = isCompleteStartBlock(block);
    writeSse(response, "content_block_start", {
      type: "content_block_start",
      index,
      content_block: completeStart ? block : contentBlockStart(block),
    });
    if (!completeStart) writeContentDelta(response, index, block);
    writeSse(response, "content_block_stop", { type: "content_block_stop", index });
  }

  writeSse(response, "message_delta", {
    type: "message_delta",
    delta: { stop_reason: message.stop_reason, stop_sequence: message.stop_sequence },
    usage: messageDeltaUsage(message.usage),
  });
  writeSse(response, "message_stop", { type: "message_stop" });
  response.end();
}

function createExecutorTools(tools = [], inspection, activeDeferredTools) {
  const executorTools = [];
  for (const tool of Array.isArray(tools) ? tools : []) {
    if (TOOL_SEARCH_TYPES.has(tool?.type)) continue;
    if (tool?.defer_loading === true) {
      if (activeDeferredTools.has(tool.name)) executorTools.push(expandDeferredTool(tool));
      continue;
    }
    executorTools.push(structuredClone(tool));
  }
  if (inspection.toolSearch !== null) {
    executorTools.push({
      name: TOOL_SEARCH_BRIDGE_NAME,
      description: "Search the deferred client-tool catalog.",
      input_schema: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
        additionalProperties: false,
      },
    });
  }
  return executorTools;
}

function normalizeCompatibilityHistory(source) {
  const messages = [];
  const pendingUses = new Map();
  const referencedTools = new Set();
  for (const message of Array.isArray(source) ? source : []) {
    if (!Array.isArray(message?.content)) {
      messages.push(structuredClone(message));
      continue;
    }
    const content = [];
    for (const block of message.content) {
      if (block?.type === "server_tool_use") {
        if (!isCompatibilityServerUse(block)) {
          content.push(structuredClone(block));
          continue;
        }
        if (typeof block.id !== "string" || pendingUses.has(block.id)) throw unsupportedHistory();
        pendingUses.set(block.id, compatibilityServerUseKind(block));
        content.push({ type: "text", text: boundedHistoryText(`Compatibility request: ${block.name}`) });
      } else if (block?.type === "tool_search_tool_result") {
        consumePendingUse(pendingUses, block.tool_use_id, "tool_search");
        const references = block.content?.tool_references;
        if (Array.isArray(references)) {
          for (const reference of references) {
            if (typeof reference?.tool_name === "string") referencedTools.add(reference.tool_name);
          }
        }
        content.push({ type: "text", text: boundedHistoryText(toolSearchHistoryText(block)) });
      } else {
        content.push(structuredClone(block));
      }
    }
    messages.push({ ...structuredClone(message), content });
  }
  if (pendingUses.size > 0) throw unsupportedHistory();
  return { messages, referencedTools };
}

function isCompatibilityServerUse(block) {
  return compatibilityServerUseKind(block) !== null;
}

function compatibilityServerUseKind(block) {
  if (String(block.name ?? "").startsWith("tool_search_tool_")) return "tool_search";
  return null;
}

function consumePendingUse(pendingUses, toolUseId, expectedKind) {
  if (pendingUses.get(toolUseId) !== expectedKind) throw unsupportedHistory();
  pendingUses.delete(toolUseId);
}

function toolSearchHistoryText(block) {
  if (block.content?.type === "tool_search_tool_result_error") {
    return `ToolSearch result error: ${String(block.content.error_code ?? "unavailable")}`;
  }
  if (block.content?.type !== "tool_search_tool_search_result") throw unsupportedHistory();
  const names = Array.isArray(block.content.tool_references)
    ? block.content.tool_references
        .map((reference) => reference?.tool_name)
        .filter((name) => typeof name === "string")
    : [];
  return `ToolSearch result: ${names.join(", ") || "no matches"}`;
}

function boundedHistoryText(value) {
  return String(value).slice(0, MAX_HISTORY_TEXT_LENGTH);
}

function unsupportedHistory() {
  return new Error("Unsupported compatibility history");
}

function toolSearchResultText(result) {
  if (result.content.type === "tool_search_tool_search_result") {
    const names = result.content.tool_references.map((reference) => reference.tool_name);
    return `Activated deferred tools: ${names.join(", ") || "none"}`;
  }
  return `ToolSearch error: ${result.content.error_code}`;
}

function bridgeResumeResult(toolUseId, text) {
  return {
    type: "tool_result",
    tool_use_id: toolUseId,
    content: boundedHistoryText(text),
  };
}

function expandDeferredTool(tool) {
  const expanded = structuredClone(tool);
  delete expanded.defer_loading;
  return expanded;
}

function finalizeMessage(message, content, executorUsage) {
  return {
    ...message,
    content,
    usage: aggregateExecutorUsage(message.usage, executorUsage),
  };
}

function aggregateExecutorUsage(finalUsage, executorUsage) {
  const usage = copyUsage(finalUsage);
  aggregateNumericUsageFields(usage, executorUsage);
  usage.iterations = {
    executor: executorUsage.map(copyUsage),
  };
  return usage;
}

function aggregateNumericUsageFields(target, entries) {
  const fields = new Set(entries.flatMap((entry) => Object.keys(entry ?? {})));
  for (const field of fields) {
    const values = entries.map((entry) => entry?.[field]);
    if (values.some((value) => typeof value === "number")) {
      target[field] = values.reduce(
        (sum, value) => sum + (typeof value === "number" ? value : 0),
        0,
      );
      continue;
    }
    const objects = values.filter(isPlainUsageObject);
    if (objects.length === 0) continue;
    const nestedTarget = isPlainUsageObject(target[field]) ? target[field] : {};
    aggregateNumericUsageFields(nestedTarget, objects);
    if (Object.keys(nestedTarget).length > 0) target[field] = nestedTarget;
  }
}

function copyUsage(usage) {
  if (usage === null || typeof usage !== "object" || Array.isArray(usage)) return {};
  const copy = structuredClone(usage);
  delete copy.iterations;
  sanitizeUsageCounters(copy);
  return copy;
}

function sanitizeUsageCounters(usage) {
  for (const [field, value] of Object.entries(usage)) {
    if (isNumericUsageCounter(field) && !isValidUsageCounter(value)) {
      delete usage[field];
    } else if (isPlainUsageObject(value)) {
      sanitizeUsageCounters(value);
      if (Object.keys(value).length === 0) delete usage[field];
    }
  }
}

function isPlainUsageObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNumericUsageCounter(field) {
  return field.endsWith("_tokens") || field.endsWith("_requests");
}

function isValidUsageCounter(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function assertMessageResponse(message) {
  if (message?.type !== "message" || !Array.isArray(message.content)) {
    throw new Error("CCR core returned an invalid Messages response");
  }
}

async function requestCoreMessage(coreClient, body, headers, publicMessage, signal) {
  try {
    const message = await coreClient.requestMessage(body, headers, signal);
    assertMessageResponse(message);
    return message;
  } catch {
    throw new Error(publicMessage);
  }
}

function requiresWholeRequestFallback({ body, config, serverHistory, serverTools }) {
  if (serverTools.requiresFallback || serverHistory.continuation === "unsupported") return true;
  if (serverHistory.containerId !== null || serverHistory.pendingServerCallIds.length > 0) return true;
  if (Array.isArray(body?.mcp_servers) && body.mcp_servers.length > 0) return true;

  const { policies } = resolveCompatibilityPolicies(config, VERIFIED_NATIVE_COMPATIBILITY);
  for (const family of serverTools.clientFamilies) {
    if (policies[family] !== "native") return true;
  }

  const families = new Set([...serverTools.families, ...serverHistory.families]);
  for (const family of families) {
    if (family === "toolSearch" && config.toolSearch?.mode === "bridge") continue;
    return true;
  }
  return false;
}

async function routeWholeRequestFallback({ body, headers, config, coreClient, response, signal }) {
  const requestFallback = coreClient.requestFallback?.bind(coreClient) ??
    coreClient.requestMessage.bind(coreClient);
  const route = createFallbackRouter({
    config,
    coreClient: ({ body: fallbackBody, headers: fallbackHeaders, signal: fallbackSignal }) =>
      requestFallback(fallbackBody, fallbackHeaders, fallbackSignal),
  });
  const result = await route({ body, headers, signal });
  if (response === undefined) return result;
  await pipeCoreResponse(result, response, signal);
}

function defaultCreateId(prefix) {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

function isCompleteStartBlock(block) {
  return !["text", "thinking", "tool_use", "server_tool_use"].includes(block.type);
}

function contentBlockStart(block) {
  if (block.type === "text") {
    return Array.isArray(block.citations)
      ? { type: "text", text: "", citations: [] }
      : { type: "text", text: "" };
  }
  if (block.type === "thinking") return { type: "thinking", thinking: "", signature: "" };
  if (block.type === "tool_use" || block.type === "server_tool_use") {
    return { ...block, input: {} };
  }
  return structuredClone(block);
}

function writeContentDelta(response, index, block) {
  if (block.type === "text") {
    if (typeof block.text === "string" && block.text.length > 0) {
      writeSse(response, "content_block_delta", {
        type: "content_block_delta",
        index,
        delta: { type: "text_delta", text: block.text },
      });
    }
    for (const citation of Array.isArray(block.citations) ? block.citations : []) {
      writeSse(response, "content_block_delta", {
        type: "content_block_delta",
        index,
        delta: { type: "citations_delta", citation },
      });
    }
  } else if (block.type === "thinking") {
    if (typeof block.thinking === "string" && block.thinking.length > 0) {
      writeSse(response, "content_block_delta", {
        type: "content_block_delta",
        index,
        delta: { type: "thinking_delta", thinking: block.thinking },
      });
    }
    if (typeof block.signature === "string") {
      writeSse(response, "content_block_delta", {
        type: "content_block_delta",
        index,
        delta: { type: "signature_delta", signature: block.signature },
      });
    }
  } else if (block.type === "tool_use" || block.type === "server_tool_use") {
    writeSse(response, "content_block_delta", {
      type: "content_block_delta",
      index,
      delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input ?? {}) },
    });
  }
}

function messageStartUsage(usage) {
  const start = copyUsage(usage);
  start.output_tokens = 0;
  delete start.iterations;
  return start;
}

function messageDeltaUsage(usage) {
  const delta = { output_tokens: usage?.output_tokens ?? 0 };
  if (usage?.iterations !== undefined) delta.iterations = structuredClone(usage.iterations);
  return delta;
}

function writeSse(response, event, data) {
  response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function coreMessagesEndpoint({ coreHost, corePort }) {
  let host = coreHost;
  if (host === "0.0.0.0") host = "127.0.0.1";
  if (host === "::") host = "::1";
  if (host.includes(":")) host = `[${host}]`;
  return `http://${host}:${corePort}/v1/messages`;
}

function copySafeAnthropicHeaders(headers) {
  const safeHeaders = {};
  for (const [rawName, value] of new Headers(headers)) {
    const name = rawName.toLowerCase();
    if (name.startsWith("x-ccr-")) continue;
    if (SAFE_HEADER_NAMES.has(name)) {
      safeHeaders[name] = value;
    }
  }
  return safeHeaders;
}

function readGeneratedCoreToken(path, readFile) {
  let config;
  try {
    config = JSON.parse(readFile(path, "utf8").toString());
  } catch {
    throw new Error("Unable to read generated CCR core authentication");
  }

  const keys = config?.auth?.staticApiKeys?.keys;
  const entry = Array.isArray(keys)
    ? keys.find(
        (key) =>
          (typeof key === "string" && key.trim().length > 0) ||
          (typeof key?.key === "string" && key.key.trim().length > 0),
      )
    : undefined;
  const token = typeof entry === "string" ? entry : entry?.key;
  if (typeof token !== "string" || token.trim().length === 0) {
    throw new Error("Generated CCR core authentication is missing or invalid");
  }
  return token;
}

async function parseCoreMessageResponse(response) {
  return response.json();
}

async function pipeCoreResponse(result, response, signal) {
  const headers = Object.fromEntries(result.headers);
  response.writeHead(result.status, headers);
  if (result.body === null) {
    await endResponse(response, signal);
    return;
  }

  const reader = result.body.getReader();
  try {
    while (true) {
      const { done, value } = await waitForPassthrough(reader.read(), response, signal);
      if (done) break;
      if (!response.write(Buffer.from(value))) {
        await waitForResponseEvent(response, "drain", signal);
      }
    }
    await endResponse(response, signal);
  } catch (error) {
    await reader.cancel(error).catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}

async function endResponse(response, signal) {
  const finished = waitForResponseEvent(response, "finish", signal);
  response.end();
  await finished;
}

function waitForResponseEvent(response, eventName, signal) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      response.off(eventName, onEvent);
      response.off("close", onClose);
      response.off("error", onError);
      signal?.removeEventListener("abort", onAbort);
    };
    const settle = (callback, value) => {
      cleanup();
      callback(value);
    };
    const onEvent = () => settle(resolve);
    const onClose = () => settle(reject, downstreamClosedError());
    const onError = () => settle(reject, downstreamFailedError());
    const onAbort = () => settle(reject, passthroughAbortError());

    response.once(eventName, onEvent);
    response.once("close", onClose);
    response.once("error", onError);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (response.destroyed === true) onClose();
    else if (signal?.aborted) onAbort();
  });
}

function waitForPassthrough(operation, response, signal) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      response.off("close", onClose);
      response.off("error", onError);
      signal?.removeEventListener("abort", onAbort);
    };
    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };
    const onClose = () => settle(reject, downstreamClosedError());
    const onError = () => settle(reject, downstreamFailedError());
    const onAbort = () => settle(reject, passthroughAbortError());

    response.once("close", onClose);
    response.once("error", onError);
    signal?.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(operation).then(
      (value) => settle(resolve, value),
      (error) => settle(reject, error),
    );
    if (response.destroyed === true) onClose();
    else if (signal?.aborted) onAbort();
  });
}

function downstreamClosedError() {
  return Object.assign(new Error("CCR passthrough downstream closed"), {
    code: "ERR_STREAM_PREMATURE_CLOSE",
  });
}

function downstreamFailedError() {
  return Object.assign(new Error("CCR passthrough downstream failed"), {
    code: "ERR_STREAM_DESTROYED",
  });
}

function passthroughAbortError() {
  return new DOMException("This operation was aborted", "AbortError");
}
