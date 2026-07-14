export const ADVISOR_TOOL_TYPE = "advisor_20260301";
export const TOOL_SEARCH_TYPES = new Set([
  "tool_search_tool_regex_20251119",
  "tool_search_tool_bm25_20251119",
]);

export class CompatibilityProtocolError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "CompatibilityProtocolError";
    this.code = code;
  }
}

export function inspectCompatibilityRequest(body = {}) {
  const tools = Array.isArray(body.tools) ? body.tools : [];
  return {
    advisor: tools.find((tool) => tool?.type === ADVISOR_TOOL_TYPE) ?? null,
    deferredTools: tools.filter((tool) => tool?.defer_loading === true),
    toolSearch: tools.find((tool) => TOOL_SEARCH_TYPES.has(tool?.type)) ?? null,
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
