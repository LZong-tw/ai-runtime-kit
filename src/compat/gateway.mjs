import { readFileSync } from "node:fs";
import {
  ADVISOR_TOOL_TYPE,
  TOOL_SEARCH_TYPES,
  assertAnthropicFamilyModel,
  createAdvisorToolResult,
  createToolSearchResult,
  inspectCompatibilityRequest,
  mapToolSearchError,
  searchDeferredTools,
} from "./protocol.mjs";

const ADVISOR_BRIDGE_NAME = "airkit_advisor";
const TOOL_SEARCH_BRIDGE_NAME = "airkit_tool_search";
const MAX_EXECUTOR_ITERATIONS = 8;
const MAX_TRANSCRIPT_LENGTH = 32_768;
const MAX_HISTORY_TEXT_LENGTH = 4_096;
const FALLBACK_WARNING =
  "Compatibility fallback active for this request; native server-tool behavior is unavailable.";

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
    async requestMessage(body, headers) {
      const result = await fetchImpl(endpoint, {
        method: "POST",
        headers: coreHeaders(headers),
        body: JSON.stringify({ ...body, stream: false }),
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
}) {
  const inspection = inspectCompatibilityRequest(body);
  let normalized;
  try {
    normalized = normalizeCompatibilityHistory(body.messages);
  } catch {
    return requestCompatibilityFallback({ body, headers, config, coreClient });
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
      tools: createExecutorTools(body.tools, inspection, activeDeferredTools),
      stream: false,
    };
    const executorMessage = await requestCoreMessage(
      coreClient,
      executorBody,
      headers,
      "CCR executor request failed",
    );
    executorUsage.push(copyUsage(executorMessage.usage));

    const bridgeCalls = executorMessage.content.filter(
      (block) =>
        block?.type === "tool_use" &&
        (block.name === ADVISOR_BRIDGE_NAME || block.name === TOOL_SEARCH_BRIDGE_NAME),
    );

    if (bridgeCalls.length === 0) {
      outwardContent.push(...executorMessage.content.map((block) => structuredClone(block)));
      return finalizeMessage(executorMessage, outwardContent, executorUsage, advisorUsage);
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
      } else {
        const serverUse = {
          type: "server_tool_use",
          id: serverUseId,
          name: inspection.toolSearch?.name ?? "tool_search",
          input: structuredClone(call.input ?? {}),
        };
        outwardContent.push(serverUse);

        let result;
        try {
          const references = searchDeferredTools({
            tools: inspection.deferredTools,
            type: inspection.toolSearch?.type,
            query: call.input?.query,
          });
          for (const reference of references) activeDeferredTools.add(reference.tool_name);
          result = createToolSearchResult({ toolUseId: serverUseId, toolReferences: references });
        } catch (error) {
          if (error?.code === "tool_search_fallback_required") {
            return requestCompatibilityFallback({
              body,
              headers,
              config,
              coreClient,
              executorUsage,
              advisorUsage,
            });
          }
          result = mapToolSearchError({ toolUseId: serverUseId, error });
        }
        outwardContent.push(result);
        resumeResults.push(bridgeResumeResult(call.id, toolSearchResultText(result)));
      }
    }

    if (hasNormalToolCall) {
      return finalizeMessage(executorMessage, outwardContent, executorUsage, advisorUsage);
    }

    messages.push({ role: "assistant", content: structuredClone(executorMessage.content) });
    messages.push({ role: "user", content: resumeResults });
  }

  return requestCompatibilityFallback({
    body,
    headers,
    config,
    coreClient,
    executorUsage,
    advisorUsage,
  });
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
    if (tool?.type === ADVISOR_TOOL_TYPE || TOOL_SEARCH_TYPES.has(tool?.type)) continue;
    if (tool?.defer_loading === true) {
      if (activeDeferredTools.has(tool.name)) executorTools.push(expandDeferredTool(tool));
      continue;
    }
    executorTools.push(structuredClone(tool));
  }
  if (inspection.advisor !== null) {
    executorTools.push({
      name: ADVISOR_BRIDGE_NAME,
      description: "Consult the configured advisor for this request.",
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
        pendingUses.set(block.id, block.name);
        content.push({ type: "text", text: boundedHistoryText(`Compatibility request: ${block.name}`) });
      } else if (block?.type === "advisor_tool_result") {
        if (!pendingUses.delete(block.tool_use_id)) throw unsupportedHistory();
        content.push({ type: "text", text: boundedHistoryText(advisorHistoryText(block)) });
      } else if (block?.type === "tool_search_tool_result") {
        if (!pendingUses.delete(block.tool_use_id)) throw unsupportedHistory();
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
  return block.name === "advisor" || String(block.name ?? "").startsWith("tool_search_tool_");
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

async function requestAdvisor({
  body,
  headers,
  config,
  coreClient,
  messages,
  executorMessage,
  advisor,
}) {
  const model = assertAnthropicFamilyModel(config.advisor?.model, "advisor.model");
  const transcript = boundedTranscript([...messages, { role: "assistant", content: executorMessage.content }]);
  try {
    const result = await coreClient.requestMessage(
      {
        model,
        max_tokens: advisor?.max_tokens ?? body.max_tokens,
        messages: [
          {
            role: "user",
            content:
              "Review this quoted conversation transcript and return advisor text only.\n" +
              `<transcript>\n${transcript}\n</transcript>`,
          },
        ],
        stream: false,
      },
      headers,
    );
    assertMessageResponse(result);
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

function advisorResultText(result) {
  if (result.content.type === "advisor_result") return result.content.text;
  return `Advisor unavailable: ${result.content.error_code}`;
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

async function requestCompatibilityFallback({
  body,
  headers,
  config,
  coreClient,
  executorUsage = [],
  advisorUsage = [],
}) {
  const fallbackModel = assertAnthropicFamilyModel(
    config.advisor?.fallbackModel,
    "advisor.fallbackModel",
  );
  const fallbackBody = {
    ...body,
    model: fallbackModel,
    messages: stripCompatibilityHistory(body.messages),
    tools: expandFallbackTools(body.tools),
    stream: false,
  };
  const result = await requestCoreMessage(
    coreClient,
    fallbackBody,
    headers,
    "CCR compatibility fallback failed",
  );
  const allExecutorUsage = [...executorUsage, copyUsage(result.usage)];
  return {
    ...result,
    content: [{ type: "text", text: FALLBACK_WARNING }, ...structuredClone(result.content)],
    usage: aggregateExecutorUsage(result.usage, allExecutorUsage, advisorUsage),
  };
}

function stripCompatibilityHistory(source) {
  return (Array.isArray(source) ? source : []).map((message) => {
    if (!Array.isArray(message?.content)) return structuredClone(message);
    return {
      ...structuredClone(message),
      content: message.content
        .filter(
          (block) =>
            !(
              (block?.type === "server_tool_use" && isCompatibilityServerUse(block)) ||
              block?.type === "advisor_tool_result" ||
              block?.type === "tool_search_tool_result"
            ),
        )
        .map((block) => structuredClone(block)),
    };
  });
}

function expandFallbackTools(tools = []) {
  return (Array.isArray(tools) ? tools : [])
    .filter((tool) => tool?.type !== ADVISOR_TOOL_TYPE && !TOOL_SEARCH_TYPES.has(tool?.type))
    .map(expandDeferredTool);
}

function expandDeferredTool(tool) {
  const expanded = structuredClone(tool);
  delete expanded.defer_loading;
  return expanded;
}

function finalizeMessage(message, content, executorUsage, advisorUsage) {
  return {
    ...message,
    content,
    usage: aggregateExecutorUsage(message.usage, executorUsage, advisorUsage),
  };
}

function aggregateExecutorUsage(finalUsage, executorUsage, advisorUsage) {
  const usage = copyUsage(finalUsage);
  const numericFields = new Set(executorUsage.flatMap((entry) => Object.keys(entry ?? {})));
  for (const field of numericFields) {
    const values = executorUsage.map((entry) => entry?.[field]);
    if (values.every((value) => typeof value === "number")) {
      usage[field] = values.reduce((sum, value) => sum + value, 0);
    }
  }
  usage.iterations = {
    advisor: advisorUsage.map(copyUsage),
    executor: executorUsage.map(copyUsage),
  };
  return usage;
}

function copyUsage(usage) {
  if (usage === null || typeof usage !== "object" || Array.isArray(usage)) return {};
  const copy = structuredClone(usage);
  delete copy.iterations;
  return copy;
}

function assertMessageResponse(message) {
  if (message?.type !== "message" || !Array.isArray(message.content)) {
    throw new Error("CCR core returned an invalid Messages response");
  }
}

async function requestCoreMessage(coreClient, body, headers, publicMessage) {
  try {
    const message = await coreClient.requestMessage(body, headers);
    assertMessageResponse(message);
    return message;
  } catch {
    throw new Error(publicMessage);
  }
}

function defaultCreateId(prefix) {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

function isCompleteStartBlock(block) {
  return block.type === "advisor_tool_result" || block.type === "tool_search_tool_result";
}

function contentBlockStart(block) {
  if (block.type === "text") return { type: "text", text: "" };
  if (block.type === "tool_use" || block.type === "server_tool_use") {
    return { ...block, input: {} };
  }
  return structuredClone(block);
}

function writeContentDelta(response, index, block) {
  if (block.type === "text") {
    writeSse(response, "content_block_delta", {
      type: "content_block_delta",
      index,
      delta: { type: "text_delta", text: block.text },
    });
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
