import { SERVER_TOOL_TYPES, classifyToolDefinition } from "./server-tools.mjs";
import { CompatibilityProtocolError } from "./tool-search.mjs";

export {
  CompatibilityProtocolError,
  MAX_DEFERRED_TOOL_COUNT,
  MAX_SEARCHABLE_TOOL_TEXT_LENGTH,
  TOOL_SEARCH_TYPES,
  bridgeToolSearch,
  createToolSearchErrorResult,
  createToolSearchResult,
  mapToolSearchError,
  searchDeferredTools,
} from "./tool-search.mjs";

export const ADVISOR_TOOL_TYPE = SERVER_TOOL_TYPES.advisor[0];

export function inspectCompatibilityRequest(body = {}) {
  const tools = Array.isArray(body?.tools) ? body.tools : [];
  const classifiedTools = tools.map((tool) => ({
    classification: classifyToolDefinition(tool),
    tool,
  }));
  return {
    advisor:
      classifiedTools.find(({ classification }) => classification.family === "advisor")?.tool ??
      null,
    deferredTools: tools.filter((tool) => tool?.defer_loading === true),
    toolSearch:
      classifiedTools.find(({ classification }) => classification.family === "toolSearch")
        ?.tool ?? null,
  };
}

export function assertAnthropicFamilyModel(model, fieldName = "model") {
  const value = typeof model === "string" ? model.trim() : "";
  if (!/^(?:anthropic\/)?claude-[a-z0-9][a-z0-9._-]*$/i.test(value)) {
    throw new CompatibilityProtocolError(
      "non_anthropic_fallback",
      `${fieldName} must be an Anthropic-family model`,
    );
  }
  return value;
}

const ADVISOR_ERROR_CODES = new Set([
  "max_uses_exceeded",
  "too_many_requests",
  "overloaded",
  "prompt_too_long",
  "execution_time_exceeded",
  "unavailable",
]);

export function createAdvisorToolResult({
  toolUseId,
  text,
  encryptedContent,
  stopReason,
  errorCode,
} = {}) {
  assertToolUseId(toolUseId);
  if (errorCode !== undefined) {
    if (!ADVISOR_ERROR_CODES.has(errorCode)) {
      throw new CompatibilityProtocolError("invalid_advisor_error", "unsupported advisor error code");
    }
    return {
      type: "advisor_tool_result",
      tool_use_id: toolUseId,
      content: { type: "advisor_tool_result_error", error_code: errorCode },
    };
  }
  if (text !== undefined && encryptedContent !== undefined) {
    throw new CompatibilityProtocolError(
      "invalid_advisor_result",
      "advisor result cannot contain plaintext and encrypted content",
    );
  }
  if (encryptedContent !== undefined && typeof encryptedContent !== "string") {
    throw new CompatibilityProtocolError(
      "invalid_advisor_result",
      "advisor encrypted content must be a string",
    );
  }
  const content =
    encryptedContent === undefined
      ? { type: "advisor_result", text: String(text ?? "") }
      : { type: "advisor_redacted_result", encrypted_content: encryptedContent };
  if (stopReason !== undefined) content.stop_reason = stopReason;
  return { type: "advisor_tool_result", tool_use_id: toolUseId, content };
}

function assertToolUseId(toolUseId) {
  if (typeof toolUseId !== "string" || toolUseId.length === 0) {
    throw new CompatibilityProtocolError("missing_tool_use_id", "toolUseId is required");
  }
}
