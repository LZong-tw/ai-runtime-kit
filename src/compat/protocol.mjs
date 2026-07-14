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

export function searchDeferredTools({ tools = [], type, query, limit = 5 }) {
  const deferred = tools.filter((tool) => tool?.defer_loading === true && tool?.name);
  const boundedLimit = Number.isInteger(limit) ? Math.max(0, Math.min(limit, 5)) : 5;
  const value = typeof query === "string" ? query : "";
  let matches;

  if (type === "tool_search_tool_regex_20251119") {
    if (value.length > 200) {
      throw new CompatibilityProtocolError(
        "tool_search_query_too_long",
        "ToolSearch regex exceeds 200 characters",
      );
    }
    let pattern;
    try {
      pattern = new RegExp(value, "i");
    } catch {
      throw new CompatibilityProtocolError("invalid_tool_search_query", "invalid ToolSearch regex");
    }
    matches = deferred
      .filter((tool) => pattern.test(searchableToolText(tool)))
      .sort((left, right) => left.name.localeCompare(right.name));
  } else if (type === "tool_search_tool_bm25_20251119") {
    if (value.length > 500) {
      throw new CompatibilityProtocolError(
        "tool_search_query_too_long",
        "ToolSearch BM25 query exceeds 500 characters",
      );
    }
    matches = rankToolsByBm25(deferred, value);
  } else {
    throw new CompatibilityProtocolError("unsupported_tool_search", "unsupported ToolSearch type");
  }

  return matches.slice(0, boundedLimit).map((tool) => ({
    type: "tool_reference",
    tool_name: tool.name,
  }));
}

function searchableToolText(tool) {
  return [tool.name, tool.description, JSON.stringify(tool.input_schema ?? {})]
    .filter(Boolean)
    .join("\n");
}

function rankToolsByBm25(tools, query) {
  const queryTerms = tokenize(query);
  if (queryTerms.length === 0 || tools.length === 0) return [];
  const documents = tools.map((tool) => tokenize(searchableToolText(tool)));
  const averageLength = documents.reduce((sum, terms) => sum + terms.length, 0) / documents.length;
  const documentFrequency = new Map();
  for (const terms of documents) {
    for (const term of new Set(terms)) {
      documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
    }
  }

  return tools
    .map((tool, index) => ({
      score: bm25Score(
        documents[index],
        queryTerms,
        documentFrequency,
        documents.length,
        averageLength,
      ),
      tool,
    }))
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score || left.tool.name.localeCompare(right.tool.name))
    .map(({ tool }) => tool);
}

function bm25Score(terms, queryTerms, documentFrequency, documentCount, averageLength) {
  const counts = new Map();
  for (const term of terms) counts.set(term, (counts.get(term) ?? 0) + 1);
  let score = 0;
  for (const term of new Set(queryTerms)) {
    const frequency = counts.get(term) ?? 0;
    if (frequency === 0) continue;
    const documentsWithTerm = documentFrequency.get(term) ?? 0;
    const inverseFrequency = Math.log(
      1 + (documentCount - documentsWithTerm + 0.5) / (documentsWithTerm + 0.5),
    );
    const lengthRatio = averageLength === 0 ? 1 : terms.length / averageLength;
    score += inverseFrequency * ((frequency * 2.2) / (frequency + 1.2 * (0.25 + 0.75 * lengthRatio)));
  }
  return score;
}

function tokenize(value) {
  return String(value).toLowerCase().match(/[a-z0-9_]+/g) ?? [];
}

const ADVISOR_ERROR_CODES = new Set([
  "max_uses_exceeded",
  "too_many_requests",
  "overloaded",
  "prompt_too_long",
  "execution_time_exceeded",
  "unavailable",
]);

export function createAdvisorToolResult({ toolUseId, text, stopReason, errorCode } = {}) {
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
  const content = { type: "advisor_result", text: String(text ?? "") };
  if (stopReason !== undefined) content.stop_reason = stopReason;
  return { type: "advisor_tool_result", tool_use_id: toolUseId, content };
}

export function createToolSearchResult({ toolUseId, toolReferences = [] } = {}) {
  assertToolUseId(toolUseId);
  return {
    type: "tool_search_tool_result",
    tool_use_id: toolUseId,
    content: {
      type: "tool_search_tool_search_result",
      tool_references: structuredClone(toolReferences),
    },
  };
}

function assertToolUseId(toolUseId) {
  if (typeof toolUseId !== "string" || toolUseId.length === 0) {
    throw new CompatibilityProtocolError("missing_tool_use_id", "toolUseId is required");
  }
}
