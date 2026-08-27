import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  ADVISOR_TOOL_TYPE,
  TOOL_SEARCH_TYPES,
  createAdvisorToolResult,
  inspectCompatibilityRequest,
} from "./protocol.mjs";
import { createFallbackRouter } from "./fallback.mjs";
import {
  VERIFIED_NATIVE_COMPATIBILITY,
  compatibilityFallbackSelector,
  requiresClientToolFallback,
  resolveCompatibilityPolicies,
  resolveToolSearchMaxTools,
} from "./config.mjs";
import { inspectPendingServerHistory } from "./server-history.mjs";
import { inspectServerToolRequest } from "./server-tools.mjs";
import { bridgeToolSearch, canApplyToolSearchBudget } from "./tool-search.mjs";
import { allowlistedUsage } from "../audit/redaction.mjs";
import { describeStablePrefix } from "./prefix-observability.mjs";

const TOOL_SEARCH_BRIDGE_NAME = "airkit_tool_search";
const ADVISOR_BRIDGE_NAME = "airkit_advisor";
const MAX_EXECUTOR_ITERATIONS = 8;
const MAX_TRANSCRIPT_LENGTH = 32_768;
const MAX_HISTORY_TEXT_LENGTH = 4_096;
const CORE_RESPONSE_METADATA = Symbol("airkitCoreResponseMetadata");

const SAFE_HEADER_NAMES = new Set([
  "accept",
  "anthropic-beta",
  "anthropic-version",
  "b3",
  "baggage",
  "content-type",
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
      try {
        return attachCoreResponseMetadata(await parseCoreMessageResponse(result), result);
      } catch (error) {
        throw Object.assign(new Error("CCR core returned an invalid Messages response"), {
          status: result.status,
          headers: result.headers,
          cause: error,
        });
      }
    },
    async forwardRaw({ body, fallback, headers, method = "POST", response, signal, onResponse, onAttempt }) {
      await onAttempt?.({ phase: "start", body });
      let result = await fetchImpl(endpoint, {
        method,
        headers: coreHeaders(headers),
        body,
        signal,
      });
      const fallbackUsed = shouldRetryRawFallback(result, fallback);
      await onAttempt?.({ phase: "response", body, status: result.status, headers: result.headers });
      if (fallbackUsed) {
        await result.body?.cancel().catch(() => {});
        await onAttempt?.({ phase: "start", body: fallback.body });
        result = await fetchImpl(endpoint, {
          method,
          headers: coreHeaders(headers),
          body: fallback.body,
          signal,
        });
        await onAttempt?.({ phase: "response", body: fallback.body, status: result.status, headers: result.headers });
      }
      onResponse?.({ fallbackUsed, headers: result.headers, status: result.status });
      await pipeCoreResponse(result, response, signal);
    },
  };
}

// Compatibility handling must use the public CCR gateway so its normal proxy
// owns routing and request recording. This client deliberately has no access
// to CCR's core credential or generated configuration file.
export function createGatewayClient({ origin, token, fetchImpl = fetch, responseTransformFactory = null }) {
  const gatewayOrigin = normalizeGatewayOrigin(origin);
  if (typeof token !== "string" || token.length === 0) {
    throw new Error("CCR gateway authentication is missing or invalid");
  }
  const gatewayHeaders = (headers = {}) => ({
    ...copySafeAnthropicHeaders(headers),
    "x-api-key": token,
  });
  const request = async ({ body, headers, method = "POST", path, signal }) => {
    const options = {
      method,
      headers: gatewayHeaders(headers),
      signal,
    };
    if (body !== undefined && method !== "GET" && method !== "HEAD") {
      options.body = body;
      if (isReadableBody(body)) options.duplex = "half";
    }
    return fetchImpl(new URL(path, gatewayOrigin), options);
  };

  return {
    async requestFallback(body, headers, signal) {
      return request({
        body: JSON.stringify(body),
        headers: { ...headers, "content-type": "application/json" },
        path: "/v1/messages",
        signal,
      });
    },
    async requestMessage(body, headers, signal) {
      const result = await request({
        body: JSON.stringify({ ...body, stream: false }),
        headers: { ...headers, "content-type": "application/json" },
        path: "/v1/messages",
        signal,
      });
      return parseCoreMessageResponse(result);
    },
    async forwardRaw({ body, fallback, headers, method = "POST", response, signal, onResponse, onAttempt }) {
      await onAttempt?.({ phase: "start", body });
      let result = await request({ body, headers, method, path: "/v1/messages", signal });
      const fallbackUsed = shouldRetryRawFallback(result, fallback);
      await onAttempt?.({ phase: "response", body, status: result.status, headers: result.headers });
      if (fallbackUsed) {
        await result.body?.cancel().catch(() => {});
        await onAttempt?.({ phase: "start", body: fallback.body });
        result = await request({
          body: fallback.body,
          headers,
          method,
          path: "/v1/messages",
          signal,
        });
        await onAttempt?.({ phase: "response", body: fallback.body, status: result.status, headers: result.headers });
      }
      onResponse?.({ fallbackUsed, headers: result.headers, status: result.status });
      await pipeCoreResponse(result, response, signal, responseTransformFactory?.({ body }));
    },
    async forward({ body, headers, method = "GET", path, response, signal }) {
      const result = await request({ body, headers, method, path, signal });
      await pipeCoreResponse(result, response, signal);
    },
  };
}

function shouldRetryRawFallback(result, fallback) {
  return fallback?.body !== undefined &&
    Array.isArray(fallback.statuses) &&
    fallback.statuses.includes(result.status);
}

export async function handleCompatibilityMessage({
  body,
  headers,
  config,
  coreClient,
  createId = defaultCreateId,
  response,
  signal,
  auditEmitter = null,
  auditContext = null,
}) {
  const audit = createAttemptAudit({ auditEmitter, auditContext, body });
  const serverTools = inspectServerToolRequest(body);
  const serverHistory = inspectPendingServerHistory(body);
  if (requiresWholeRequestFallback({ body, config, serverHistory, serverTools })) {
    return routeWholeRequestFallback({ body, headers, config, coreClient, response, signal, audit });
  }

  const inspection = inspectCompatibilityRequest(body);
  let normalized;
  try {
    normalized = normalizeCompatibilityHistory(body.messages);
  } catch {
    return routeWholeRequestFallback({ body, headers, config, coreClient, response, signal, audit });
  }

  const activeDeferredTools = new Set(normalized.referencedTools);
  const executorUsage = [];
  const advisorUsage = [];
  const outwardContent = [];
  const messages = normalized.messages;
  let advisorUses = 0;

  for (let iteration = 0; iteration < MAX_EXECUTOR_ITERATIONS; iteration += 1) {
    const executorBody = {
      ...body,
      messages,
      tools: createExecutorTools(
        body.tools,
        inspection,
        activeDeferredTools,
        resolveToolSearchMaxTools(config, body.model),
      ),
      stream: false,
    };
    const executorMessage = await requestCoreMessage(
      coreClient,
      executorBody,
      headers,
      "CCR executor request failed",
      signal,
      audit,
    );
    executorUsage.push(copyUsage(executorMessage.usage));

    const bridgeCalls = executorMessage.content.filter(
      (block) =>
        block?.type === "tool_use" &&
        (block.name === ADVISOR_BRIDGE_NAME || block.name === TOOL_SEARCH_BRIDGE_NAME),
    );

    if (bridgeCalls.length === 0) {
      outwardContent.push(...executorMessage.content.map((block) => structuredClone(block)));
      return finalizeMessage(executorMessage, outwardContent, executorUsage, body, advisorUsage);
    }

    const resumeResults = [];
    let hasNormalToolCall = false;
    for (const call of executorMessage.content) {
      if (
        call?.type !== "tool_use" ||
        (call.name !== ADVISOR_BRIDGE_NAME && call.name !== TOOL_SEARCH_BRIDGE_NAME)
      ) {
        outwardContent.push(structuredClone(call));
        if (call?.type === "tool_use") hasNormalToolCall = true;
        continue;
      }
      const serverUseId = createId("srvtoolu");
      if (call.name === ADVISOR_BRIDGE_NAME) {
        const serverUse = {
          type: "server_tool_use",
          id: serverUseId,
          name: inspection.advisor?.name ?? "advisor",
          input: structuredClone(call.input ?? {}),
        };
        outwardContent.push(serverUse);

        let result;
        if (advisorUses >= advisorMaxUses(inspection.advisor)) {
          result = createAdvisorToolResult({
            toolUseId: serverUseId,
            errorCode: "max_uses_exceeded",
          });
        } else {
          advisorUses += 1;
          const advisorMessage = await requestAdvisor({
            body,
            headers,
            config,
            coreClient,
            messages,
            executorMessage,
            advisor: inspection.advisor,
            signal,
            audit,
          });
          if (advisorMessage === null) {
            result = createAdvisorToolResult({ toolUseId: serverUseId, errorCode: "unavailable" });
          } else {
            advisorUsage.push(copyUsage(advisorMessage.usage));
            result = createAdvisorToolResult({
              toolUseId: serverUseId,
              text: extractMessageText(advisorMessage),
              stopReason: advisorMessage.stop_reason,
            });
          }
        }
        outwardContent.push(result);
        resumeResults.push(bridgeResumeResult(call.id, advisorResultText(result)));
        continue;
      }

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
        return routeWholeRequestFallback({ body, headers, config, coreClient, response, signal, audit });
      }
      const result = bridged.block;
      for (const reference of result.content.tool_references ?? []) {
        activeDeferredTools.add(reference.tool_name);
      }
      outwardContent.push(result);
      resumeResults.push(bridgeResumeResult(call.id, toolSearchResultText(result)));
    }

    if (hasNormalToolCall) {
      return finalizeMessage(executorMessage, outwardContent, executorUsage, body, advisorUsage);
    }

    messages.push({ role: "assistant", content: structuredClone(executorMessage.content) });
    messages.push({ role: "user", content: resumeResults });
  }

  return routeWholeRequestFallback({ body, headers, config, coreClient, response, signal, audit });
}

export function writeAnthropicMessage(response, message, stream) {
  const outwardMessage = {
    ...message,
    usage: copyUsage(message.usage),
  };
  if (!stream) {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(outwardMessage));
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
      ...outwardMessage,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: messageStartUsage(outwardMessage.usage),
    },
  });

  for (const [index, block] of outwardMessage.content.entries()) {
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
    delta: {
      stop_reason: outwardMessage.stop_reason,
      stop_sequence: outwardMessage.stop_sequence,
    },
    usage: messageDeltaUsage(outwardMessage.usage),
  });
  writeSse(response, "message_stop", { type: "message_stop" });
  response.end();
}

function createExecutorTools(tools = [], inspection, activeDeferredTools, maxTools = null) {
  const ordinaryTools = [];
  const selectedDeferredTools = [];
  for (const tool of Array.isArray(tools) ? tools : []) {
    if (tool?.type === ADVISOR_TOOL_TYPE || TOOL_SEARCH_TYPES.has(tool?.type)) continue;
    if (tool?.defer_loading === true) {
      if (activeDeferredTools.has(tool.name)) selectedDeferredTools.push(expandDeferredTool(tool));
      continue;
    }
    ordinaryTools.push(structuredClone(tool));
  }
  const bridgeSlots = (inspection.advisor !== null ? 1 : 0) +
    (inspection.toolSearch !== null ? 1 : 0);
  const capacity = maxTools === null ? Infinity : Math.max(0, maxTools - bridgeSlots);
  const selected = selectedDeferredTools.slice(0, capacity);
  const executorTools = [
    ...ordinaryTools.slice(0, Math.max(0, capacity - selected.length)),
    ...selected,
  ];
  if (inspection.advisor !== null) {
    executorTools.push({
      name: ADVISOR_BRIDGE_NAME,
      description: "Get an independent second opinion from the configured Advisor. "
        + "Use this when the user asks to find, ask, consult, or discuss with Advisor "
        + "(for example, \"找 Advisor\"). Wait for advisor_tool_result before continuing, "
        + "and never claim Advisor was consulted without a returned result.",
      input_schema: { type: "object", properties: {}, additionalProperties: false },
    });
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
      } else if (block?.type === "advisor_tool_result") {
        consumePendingUse(pendingUses, block.tool_use_id, "advisor");
        content.push({ type: "text", text: boundedHistoryText(advisorHistoryText(block)) });
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
  if (block.name === "advisor") return "advisor";
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

function advisorHistoryText(block) {
  const content = block.content;
  if (content?.type === "advisor_result") return `Advisor result: ${String(content.text ?? "")}`;
  if (content?.type === "advisor_tool_result_error") {
    return `Advisor result error: ${String(content.error_code ?? "unavailable")}`;
  }
  if (content?.type === "advisor_redacted_result") return "Advisor result: [redacted]";
  throw unsupportedHistory();
}

function boundedHistoryText(value) {
  return String(value).slice(0, MAX_HISTORY_TEXT_LENGTH);
}

function unsupportedHistory() {
  return new Error("Unsupported compatibility history");
}

async function requestAdvisor({
  body,
  headers,
  config,
  coreClient,
  messages,
  executorMessage,
  advisor,
  signal,
  audit,
}) {
  const { fallback, familyFallbacks } = resolveCompatibilityPolicies(config, {});
  const selected = familyFallbacks.advisor ?? fallback;
  const transcript = boundedTranscript([
    ...messages,
    { role: "assistant", content: executorMessage.content },
  ]);
  try {
    const result = await requestCoreMessage(
      coreClient,
      {
        model: compatibilityFallbackSelector(selected),
        max_tokens: advisor?.max_tokens ?? body.max_tokens,
        messages: [{
          role: "user",
          content:
            "Review this quoted conversation transcript and return advisor text only.\n" +
            `<transcript>\n${transcript}\n</transcript>`,
        }],
        stream: false,
      },
      headers,
      "CCR advisor request failed",
      signal,
      audit,
    );
    return result;
  } catch {
    return null;
  }
}

function boundedTranscript(messages) {
  let serialized;
  try {
    serialized = JSON.stringify(messages);
  } catch {
    serialized = "[unavailable transcript]";
  }
  return serialized.slice(0, MAX_TRANSCRIPT_LENGTH);
}

function extractMessageText(message) {
  return message.content
    .filter((block) => block?.type === "text")
    .map((block) => String(block.text ?? ""))
    .join("");
}

function advisorMaxUses(advisor) {
  return Number.isInteger(advisor?.max_uses) ? Math.max(0, advisor.max_uses) : 1;
}

function toolSearchResultText(result) {
  if (result.content.type === "tool_search_tool_search_result") {
    const names = result.content.tool_references.map((reference) => reference.tool_name);
    return `Activated deferred tools: ${names.join(", ") || "none"}`;
  }
  return `ToolSearch error: ${result.content.error_code}`;
}

function advisorResultText(result) {
  if (result.content.type === "advisor_result") return result.content.text;
  return `Advisor unavailable: ${result.content.error_code}`;
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

function finalizeMessage(message, content, executorUsage, requestBody, advisorUsage = []) {
  const usage = aggregateExecutorUsage(message.usage, executorUsage, advisorUsage);
  fillMissingUsage(usage, requestBody, content);
  return {
    ...message,
    content,
    usage,
  };
}

function fillMissingUsage(usage, requestBody, content) {
  const metadata = usage.usageMetadata;
  const hasPromptUsage = [
    usage.input_tokens,
    usage.cache_read_input_tokens,
    usage.cache_creation_input_tokens,
    usage.prompt_tokens,
    usage.prompt_tokens_details?.cached_tokens,
    usage.input_tokens_details?.cached_tokens,
    usage.prompt_cache_hit_tokens,
    usage.prompt_cache_miss_tokens,
    usage.cache_read_tokens,
    usage.cache_write_tokens,
    usage.cache_miss_tokens,
    metadata?.promptTokenCount,
    metadata?.cachedContentTokenCount,
  ].some((value) => typeof value === "number" && value > 0);
  if (!hasPromptUsage) usage.input_tokens = estimateSerializedTokens(requestBody);
  if (!(typeof usage.output_tokens === "number" && usage.output_tokens > 0)) {
    usage.output_tokens = estimateSerializedTokens(content);
  }
}

function estimateSerializedTokens(value) {
  const bytes = Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");
  return Math.max(1, Math.min(1_000_000, Math.ceil(bytes / 4)));
}

function aggregateExecutorUsage(finalUsage, executorUsage, advisorUsage = []) {
  const usage = copyUsage(finalUsage);
  aggregateNumericUsageFields(usage, executorUsage);
  usage.iterations = { executor: executorUsage.map(copyUsage) };
  if (advisorUsage.length > 0) usage.iterations.advisor = advisorUsage.map(copyUsage);
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
  const metadata = message?.[CORE_RESPONSE_METADATA];
  if (message?.type === "error" && Number(metadata?.status) >= 400) {
    throw Object.assign(new Error("CCR core returned an upstream error"), metadata);
  }
  if (message?.type !== "message" || !Array.isArray(message.content)) {
    throw Object.assign(new Error("CCR core returned an invalid Messages response"), metadata ?? {});
  }
}

async function requestCoreMessage(coreClient, body, headers, publicMessage, signal, audit = null) {
  const attempt = await audit?.start(body);
  try {
    const message = await coreClient.requestMessage(body, headers, signal);
    assertMessageResponse(message);
    await audit?.response(attempt, {
      status: 200,
      actual: actualFromMessage(message),
      usage: message.usage,
    });
    return message;
  } catch (error) {
    await audit?.response(attempt, {
      status: responseErrorStatus(error),
      actual: actualFromMessage(error),
      usage: null,
    });
    const wrapped = new Error(publicMessage);
    const status = responseErrorStatus(error);
    if (status !== null) wrapped.status = status;
    if (error?.headers !== undefined) wrapped.headers = error.headers;
    throw wrapped;
  }
}

function attachCoreResponseMetadata(value, response) {
  if (!isRecord(value)) return value;
  Object.defineProperty(value, CORE_RESPONSE_METADATA, {
    value: { status: response.status, headers: response.headers },
    enumerable: false,
  });
  return value;
}

function responseErrorStatus(error) {
  const status = Number(error?.status ?? error?.statusCode);
  return Number.isInteger(status) && status >= 100 && status <= 999 ? status : null;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function responseStatusFromResult(result) {
  const status = Number(result?.status ?? result?.statusCode);
  return Number.isInteger(status) && status >= 100 && status <= 999 ? status : null;
}

function actualFromMessage(message) {
  if (!isRecord(message)) return { provider: null, account: null, model: null };
  return actualIdentity(message.provider ?? message.provider_name, message.model);
}

function actualFromResult(result) {
  return actualIdentity(
    headerValue(result?.headers, "x-provider") ?? headerValue(result?.headers, "x-provider-name"),
    headerValue(result?.headers, "x-model"),
  );
}

function actualIdentity(provider, model) {
  return {
    provider: typeof provider === "string" && provider.trim() !== "" ? provider : null,
    account: null,
    model: typeof model === "string" && model.trim() !== "" ? model : null,
  };
}

function headerValue(headers, name) {
  if (typeof headers?.get === "function") return headers.get(name);
  if (!isRecord(headers)) return null;
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === name);
  return entry?.[1] ?? null;
}

export function createAttemptAudit({ auditEmitter, auditContext, body }) {
  const enabled = typeof auditEmitter?.emit === "function";
  const logicalRequestId = auditContext?.logicalRequestId ?? auditContext?.logical_request_id ?? randomUUID();
  const sessionId = auditContext?.sessionId ?? auditContext?.session_id ?? null;
  const stablePrefix = describeStablePrefix(body, { rawPrefixBytes: auditContext?.rawPrefixBytes });
  const selectedRoute = auditContext?.selectedRoute ?? auditContext?.selected_route ?? null;

  const start = async (attemptBody) => {
    if (!enabled) return null;
    const attemptId = randomUUID();
    const selected = selectedIdentity(attemptBody?.model, selectedRoute, auditContext);
    await safeAuditEmit(auditEmitter, "provider_request", {
      logical_request_id: logicalRequestId,
      attempt_id: attemptId,
      session_id: sessionId,
      payload: {
        selected,
        actual: { provider: null, account: null, model: null },
        ...(stablePrefix?.wirePrefixHash ? { wirePrefixHash: stablePrefix.wirePrefixHash } : {}),
      },
    });
    return { attemptId, selected };
  };

  const response = async (attempt, observation) => {
    if (!enabled || !attempt) return;
    const usage = allowlistedUsage(observation.usage);
    const payload = {
      selected: attempt.selected,
      actual: observation.actual ?? { provider: null, account: null, model: null },
      status: observation.status ?? null,
      ...(usage && Object.keys(usage).length > 0 ? { usage } : {}),
      ...(stablePrefix?.wirePrefixHash ? { wirePrefixHash: stablePrefix.wirePrefixHash } : {}),
    };
    await safeAuditEmit(auditEmitter, "provider_response", {
      logical_request_id: logicalRequestId,
      attempt_id: attempt.attemptId,
      session_id: sessionId,
      payload,
    });
    const headers = observation.headers;
    for (const [kind, prefix] of [["meter_reported", "x-provider-meter-"], ["quota_reported", "x-provider-quota-"]]) {
      const counters = allowlistedHeaderCounters(headers, prefix);
      if (Object.keys(counters).length === 0) continue;
      await safeAuditEmit(auditEmitter, kind, {
        logical_request_id: logicalRequestId,
        attempt_id: attempt.attemptId,
        session_id: sessionId,
        payload: { counters },
      });
    }
  };

  return { start, response };
}

function selectedIdentity(model, route, context) {
  const selectedModel = typeof model === "string" && model.length > 0 ? model : null;
  const selectedRoute = typeof route === "string" && route.length > 0 ? route : selectedModel;
  const routeParts = splitSelector(selectedRoute);
  const modelParts = splitSelector(selectedModel);
  return {
    route: selectedRoute,
    provider: routeParts.provider ?? modelParts.provider,
    account: context?.selectedAccountHmac ?? context?.selected_account_hmac ?? null,
    model: modelParts.model ?? routeParts.model,
  };
}

function splitSelector(value) {
  if (typeof value !== "string" || value.length === 0) return { provider: null, model: null };
  const slash = value.indexOf("/");
  const comma = value.indexOf(",");
  const separator = slash >= 0 && (comma < 0 || slash < comma) ? slash : comma;
  if (separator <= 0 || separator === value.length - 1) {
    return { provider: null, model: value };
  }
  return { provider: value.slice(0, separator), model: value.slice(separator + 1) };
}

function allowlistedHeaderCounters(headers, prefix) {
  const counters = {};
  if (!headers) return counters;
  const entries = typeof headers.entries === "function" ? [...headers.entries()] : Object.entries(headers);
  for (const [name, raw] of entries) {
    const key = String(name).toLowerCase();
    if (!key.startsWith(prefix)) continue;
    const value = Number(raw);
    if (Number.isFinite(value) && value >= 0) counters[key.slice(prefix.length)] = value;
  }
  return counters;
}

async function safeAuditEmit(emitter, kind, fields) {
  try {
    await emitter.emit(kind, fields);
  } catch {
    // Audit is advisory; forwarding must remain authoritative.
  }
}

function requiresWholeRequestFallback({ body, config, serverHistory, serverTools }) {
  if (serverTools.requiresFallback || serverHistory.continuation === "unsupported") return true;
  if (serverHistory.containerId !== null || serverHistory.pendingServerCallIds.length > 0) return true;
  if (Array.isArray(body?.mcp_servers) && body.mcp_servers.length > 0) return true;

  const toolLimit = resolveToolSearchMaxTools(config, body?.model);
  if (
    toolLimit !== null &&
    Array.isArray(body?.tools) &&
    body.tools.length > toolLimit &&
    !canApplyToolSearchBudget(body, toolLimit)
  ) return true;
  const toolSearchOwnsOverflow =
    config.toolSearch?.mode === "bridge" &&
    serverTools.families.has("toolSearch") &&
    toolLimit !== null &&
    Array.isArray(body?.tools) &&
    body.tools.length > toolLimit;
  const { policies } = resolveCompatibilityPolicies(config, VERIFIED_NATIVE_COMPATIBILITY);
  for (const family of serverTools.clientFamilies) {
    if (requiresClientToolFallback(config, policies, family, body?.model) && !toolSearchOwnsOverflow) return true;
  }

  const families = new Set([...serverTools.families, ...serverHistory.families]);
  for (const family of families) {
    if (family === "toolSearch" && config.toolSearch?.mode === "bridge") continue;
    if (family === "advisor" && policies.advisor === "bridge") continue;
    // A native-first server-tool definition is only a catalog entry. It does
    // not prove this turn used the tool. DeepSeek and GPT routes are the
    // cache-sensitive providers where preserving the stable prefix is a
    // deliberate policy; other models retain the established fallback.
    if (
      isCacheSensitiveModel(body?.model) &&
      serverTools.families.has(family) &&
      !serverToolDefinitionRequiresFallback(config, policies, family)
    ) continue;
    return true;
  }
  return false;
}

function isCacheSensitiveModel(model) {
  return typeof model === "string" && /(?:^|[\/,])(?:deepseek|gpt)(?:[-\/]|$)/i.test(model);
}

function serverToolDefinitionRequiresFallback(config, policies, family) {
  if (policies?.[family] === "anthropic-fallback") return true;
  const mode = config?.[family]?.mode;
  return mode === "anthropic-fallback" || mode === "mcp";
}

async function routeWholeRequestFallback({ body, headers, config, coreClient, response, signal, audit = null }) {
  const requestFallback = coreClient.requestFallback?.bind(coreClient) ??
    coreClient.requestMessage.bind(coreClient);
  const route = createFallbackRouter({
    config,
    coreClient: async ({ body: fallbackBody, headers: fallbackHeaders, signal: fallbackSignal }) => {
      const attempt = await audit?.start(fallbackBody);
      try {
        const result = await requestFallback(fallbackBody, fallbackHeaders, fallbackSignal);
        await audit?.response(attempt, {
          status: responseStatusFromResult(result),
          actual: actualFromResult(result),
          usage: null,
          headers: result?.headers,
        });
        return result;
      } catch (error) {
        await audit?.response(attempt, {
          status: responseErrorStatus(error),
          actual: actualFromMessage(error),
          usage: null,
        });
        throw error;
      }
    },
  });
  const result = await route({ body, headers, signal });
  const families = fallbackFamilies(body);
  reportFallbackRejection(config, families, result);
  const annotated = await annotateAdvisorRejection(families, result);
  if (response === undefined) return annotated;
  await pipeCoreResponse(annotated, response, signal);
}

function fallbackFamilies(body) {
  try {
    return [...new Set([
      ...inspectPendingServerHistory(body).families,
      ...inspectServerToolRequest(body).families,
    ])];
  } catch {
    return [];
  }
}

// Every fallback response is relayed byte-for-byte except one case, below. The
// log line is worth writing because the upstream error can name a model the
// caller never sent, which reads like a routing bug here: an Anthropic server
// tool carries its own `model` inside the tool definition, and the gateway
// resolves that one with a separate request that does not inherit the
// deployment's credentials or api_base. Observed against a LiteLLM gateway, one
// missing piece of upstream configuration produced three different errors
// depending on how that inner model was written — a bare name failed provider
// lookup, an `anthropic/` prefix asked for an Anthropic key, and an `azure_ai/`
// prefix asked for an Azure api_base. None of them is fixable from this side, so
// the only useful thing to do is say where to look.
//
// The advisor hint is deliberately not written for the other families. Their
// rejections have their own causes — a workspace that does not carry the
// entitlement, most commonly — and printing the sub-call explanation for every
// server tool would just be a new confident guess in place of the old one.
function reportFallbackRejection(config, families, result) {
  if (config?.routeLog !== true) return;
  if (typeof result?.status !== "number" || result.status < 400) return;
  try {
    const hint = families.includes("advisor")
      ? "fallback routed the outer request to the configured Anthropic route, but the advisor tool definition carries its own model that the upstream gateway resolves in a separate call — that call needs its own api_base and credentials upstream, and no AirKit setting can supply them"
      : families.length > 0
      ? "fallback routed this request to the configured Anthropic route and the upstream rejected it, so the server tool has to be supported there"
      : null;
    process.stderr.write(`[airkit-fallback] ${JSON.stringify({
      at: new Date().toISOString(),
      families,
      status: result.status,
      ...(hint ? { hint } : {}),
    })}\n`);
  } catch {
    // never let logging interfere with the request
  }
}

const ADVISOR_REJECTION_NOTE = " [AirKit] This error came from the upstream " +
  "Anthropic fallback route, not from AirKit's routing. The advisor tool " +
  "definition carries its own model, which the upstream gateway resolves in a " +
  "separate call that inherits neither that route's api_base nor its " +
  "credentials, so the model named above may not be the one this request " +
  "asked for. It has to be configured on the gateway; no AirKit setting can " +
  "supply it.";

// The one deliberate exception to byte-for-byte relaying. A log line only helps
// someone who already knows to go read the log, and the raw upstream error is
// actively misleading here — it names a model the caller never sent, so the
// obvious reading is that AirKit misrouted the request. The upstream message is
// kept verbatim and the explanation is appended to it, so nothing is hidden and
// the error's type, status, and other headers are untouched.
//
// Narrow on purpose. Anything that is not a JSON Anthropic error object with a
// string message is relayed unchanged: an encoded body cannot be edited without
// re-encoding it, a streamed error has already committed to its framing, and
// another family's rejection has a different cause. The bytes are read once and
// replayed either way, so a body that turns out not to qualify is still
// delivered whole.
async function annotateAdvisorRejection(families, result) {
  if (!families.includes("advisor")) return result;
  if (typeof result?.status !== "number" || result.status < 400) return result;
  if (!result.body) return result;
  const contentType = readHeader(result, "content-type");
  if (!contentType.includes("application/json")) return result;
  if (readHeader(result, "content-encoding")) return result;

  let raw;
  try {
    raw = await collectStream(result.body);
  } catch {
    return result;
  }
  return replayResult(result, annotateErrorBytes(raw));
}

function annotateErrorBytes(raw) {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(raw));
    if (typeof parsed?.error?.message !== "string") return raw;
    parsed.error.message += ADVISOR_REJECTION_NOTE;
    return Buffer.from(JSON.stringify(parsed));
  } catch {
    return raw;
  }
}

function readHeader(result, name) {
  const value = typeof result.headers?.get === "function"
    ? result.headers.get(name)
    : Object.fromEntries(result.headers ?? [])[name];
  return typeof value === "string" ? value.toLowerCase() : "";
}

async function collectStream(body) {
  const reader = body.getReader();
  const chunks = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}

function replayResult(result, bytes) {
  const headers = new Headers(result.headers);
  headers.set("content-length", String(bytes.byteLength));
  return {
    status: result.status,
    headers,
    body: new Blob([bytes]).stream(),
  };
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
  return { output_tokens: usage?.output_tokens ?? 0 };
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

export function copySafeAnthropicHeaders(headers) {
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

function normalizeGatewayOrigin(origin) {
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    throw new Error("CCR gateway origin is invalid");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("CCR gateway origin must use HTTP");
  }
  parsed.pathname = "/";
  parsed.search = "";
  parsed.hash = "";
  return parsed;
}

function isReadableBody(body) {
  return body !== null && typeof body === "object" && typeof body.pipe === "function";
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

async function pipeCoreResponse(result, response, signal, transform = null) {
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
      const transformed = transform?.push(value) ?? value;
      if (transformed.byteLength > 0 && !response.write(Buffer.from(transformed))) {
        await waitForResponseEvent(response, "drain", signal);
      }
    }
    const tail = transform?.finish();
    if (tail?.byteLength > 0 && !response.write(Buffer.from(tail))) {
      await waitForResponseEvent(response, "drain", signal);
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
