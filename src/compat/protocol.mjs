import { SERVER_TOOL_TYPES, classifyToolDefinition } from "./server-tools.mjs";

export const ADVISOR_TOOL_TYPE = SERVER_TOOL_TYPES.advisor[0];
export const TOOL_SEARCH_TYPES = new Set(SERVER_TOOL_TYPES.toolSearch);
export const MAX_DEFERRED_TOOL_COUNT = 512;
export const MAX_SEARCHABLE_TOOL_TEXT_LENGTH = 4096;

const MAX_SCHEMA_NODES = 1024;
const TOOL_SEARCH_ERROR_CODES = new Set([
  "invalid_tool_input",
  "unavailable",
  "too_many_requests",
  "execution_time_exceeded",
]);
const TOOL_SEARCH_INPUT_ERROR_CODES = new Set([
  "invalid_tool_search_query",
  "tool_search_query_too_long",
  "invalid_tool_definition",
]);
const TOOL_SEARCH_PUBLIC_ERROR_MESSAGES = {
  unavailable: "ToolSearch is unavailable",
  too_many_requests: "ToolSearch rate limit exceeded",
  execution_time_exceeded: "ToolSearch execution timed out",
};

export class CompatibilityProtocolError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "CompatibilityProtocolError";
    this.code = code;
  }
}

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

export function searchDeferredTools({ tools = [], type, query, limit = 5 }) {
  if (!Array.isArray(tools)) {
    throw new CompatibilityProtocolError(
      "invalid_tool_definition",
      "ToolSearch tools must be an array",
    );
  }
  if (tools.length > MAX_DEFERRED_TOOL_COUNT) {
    throw toolSearchFallback("ToolSearch catalog exceeds the local search limit");
  }
  const deferred = tools
    .filter((tool) => tool?.defer_loading === true)
    .map(validateDeferredTool);
  const boundedLimit = Number.isInteger(limit) ? Math.max(0, Math.min(limit, 5)) : 5;
  if (typeof query !== "string") throw invalidToolSearchQuery();
  const value = query;
  let matches;

  if (type === "tool_search_tool_regex_20251119") {
    if (value.length > 200) {
      throw new CompatibilityProtocolError(
        "tool_search_query_too_long",
        "ToolSearch regex exceeds 200 characters",
      );
    }
    if (value.length === 0) return [];
    const pattern = compileSafePythonRegex(value);
    matches = deferred
      .filter((tool) => safePythonRegexMatches(pattern, searchableToolText(tool)))
      .sort((left, right) => compareCodeUnits(left.name, right.name));
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

function validateDeferredTool(tool) {
  if (tool === null || typeof tool !== "object" || Array.isArray(tool)) {
    throw invalidToolDefinition();
  }
  if (
    typeof tool.name !== "string" ||
    tool.name.length === 0 ||
    tool.name.length > MAX_SEARCHABLE_TOOL_TEXT_LENGTH
  ) {
    throw invalidToolDefinition();
  }
  if (tool.description !== undefined && typeof tool.description !== "string") {
    throw invalidToolDefinition();
  }
  if (
    tool.input_schema !== undefined &&
    (tool.input_schema === null || typeof tool.input_schema !== "object")
  ) {
    throw invalidToolDefinition();
  }
  return tool;
}

function invalidToolDefinition() {
  return new CompatibilityProtocolError(
    "invalid_tool_definition",
    "invalid deferred tool definition",
  );
}

function searchableToolText(tool) {
  let text = "";
  const append = (value) => {
    if (text.length >= MAX_SEARCHABLE_TOOL_TEXT_LENGTH || value === undefined) return;
    const separator = text.length === 0 ? "" : "\n";
    const remaining = MAX_SEARCHABLE_TOOL_TEXT_LENGTH - text.length;
    text += `${separator}${String(value)}`.slice(0, remaining);
  };
  append(tool.name);
  append(tool.description);
  appendSchemaSearchText(
    tool.input_schema ?? {},
    append,
    () => text.length < MAX_SEARCHABLE_TOOL_TEXT_LENGTH,
  );
  return text;
}

function appendSchemaSearchText(schema, append, hasCapacity) {
  const pending = [schema];
  const seen = new WeakSet();
  let visited = 0;
  while (pending.length > 0) {
    if (!hasCapacity()) return;
    const value = pending.pop();
    if (value === null || typeof value !== "object") {
      append(value);
      continue;
    }
    if (seen.has(value)) throw invalidToolDefinition();
    seen.add(value);
    visited += 1;
    if (visited > MAX_SCHEMA_NODES) {
      throw toolSearchFallback("ToolSearch schema exceeds the local search limit");
    }
    for (const key in value) {
      if (!Object.hasOwn(value, key)) continue;
      visited += 1;
      if (visited > MAX_SCHEMA_NODES) {
        throw toolSearchFallback("ToolSearch schema exceeds the local search limit");
      }
      append(key);
      if (!hasCapacity()) return;
      const entryValue = value[key];
      if (entryValue !== null && typeof entryValue === "object") {
        pending.push(entryValue);
      } else {
        append(entryValue);
      }
    }
  }
}

// Safe Python-compatible subset: literal text, escaped literals, alternation,
// and ^/$ at alternative edges. Other valid Python regex features fall back
// per request; no caller-controlled pattern is executed by a regex engine.
function compileSafePythonRegex(query) {
  assertSupportedPythonRegex(query);
  return splitSafeRegexAlternatives(query).map((source) => {
    const anchoredStart = source.startsWith("^");
    const anchoredEnd = source.endsWith("$") && !isEscaped(source, source.length - 1);
    const body = source.slice(anchoredStart ? 1 : 0, anchoredEnd ? -1 : undefined);
    return {
      anchoredEnd,
      anchoredStart,
      literal: unescapeRegexLiteral(body).toLowerCase(),
    };
  });
}

function splitSafeRegexAlternatives(query) {
  const alternatives = [];
  let source = "";
  for (let index = 0; index < query.length; index += 1) {
    const character = query[index];
    if (character === "\\") {
      source += `${character}${query[index + 1]}`;
      index += 1;
    } else if (character === "|") {
      alternatives.push(source);
      source = "";
    } else {
      source += character;
    }
  }
  alternatives.push(source);
  return alternatives;
}

function isEscaped(source, index) {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && source[cursor] === "\\"; cursor -= 1) {
    backslashes += 1;
  }
  return backslashes % 2 === 1;
}

function assertSupportedPythonRegex(query) {
  const unsupportedEscapes = new Set("dDsSwWAZbBAbfnrtvaxuUN");
  let atAlternativeStart = true;
  for (let index = 0; index < query.length; index += 1) {
    const character = query[index];
    if (character === "\\") {
      const escaped = query[index + 1];
      if (escaped === undefined) throw invalidToolSearchQuery();
      if (unsupportedEscapes.has(escaped) || /[0-9]/.test(escaped)) {
        throw toolSearchFallback("Python regex feature requires provider ToolSearch");
      }
      if (/[A-Za-z]/.test(escaped)) throw invalidToolSearchQuery();
      atAlternativeStart = false;
      index += 1;
      continue;
    }
    if (character === "|") {
      atAlternativeStart = true;
      continue;
    }
    if (character === "[") {
      if (!hasClosingToken(query, index + 1, "]")) throw invalidToolSearchQuery();
      throw toolSearchFallback("Python regex feature requires provider ToolSearch");
    }
    if (character === "(") {
      if (!hasClosingToken(query, index + 1, ")")) throw invalidToolSearchQuery();
      throw toolSearchFallback("Python regex feature requires provider ToolSearch");
    }
    if (character === "]" || character === ")") throw invalidToolSearchQuery();
    if (character === "." || character === "{" || character === "}") {
      throw toolSearchFallback("Python regex feature requires provider ToolSearch");
    }
    if (character === "*" || character === "+" || character === "?") {
      if (index === 0 || "|^(*+?".includes(query[index - 1])) {
        throw invalidToolSearchQuery();
      }
      throw toolSearchFallback("Python regex feature requires provider ToolSearch");
    }
    if (character === "^") {
      if (!atAlternativeStart) {
        throw toolSearchFallback("Python regex anchor requires provider ToolSearch");
      }
      atAlternativeStart = false;
      continue;
    }
    if (character === "$") {
      if (index < query.length - 1 && query[index + 1] !== "|") {
        throw toolSearchFallback("Python regex anchor requires provider ToolSearch");
      }
      atAlternativeStart = false;
      continue;
    }
    atAlternativeStart = false;
  }
}

function hasClosingToken(query, start, closingToken) {
  for (let index = start; index < query.length; index += 1) {
    if (query[index] === "\\") index += 1;
    else if (query[index] === closingToken) return true;
  }
  return false;
}

function unescapeRegexLiteral(source) {
  let literal = "";
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === "\\") index += 1;
    literal += source[index];
  }
  return literal;
}

function safePythonRegexMatches(pattern, text) {
  const value = text.toLowerCase();
  return pattern.some(({ anchoredEnd, anchoredStart, literal }) => {
    if (anchoredStart && anchoredEnd) return value === literal;
    if (anchoredStart) return value.startsWith(literal);
    if (anchoredEnd) return value.endsWith(literal);
    return value.includes(literal);
  });
}

function invalidToolSearchQuery() {
  return new CompatibilityProtocolError("invalid_tool_search_query", "invalid ToolSearch regex");
}

function toolSearchFallback(message) {
  return new CompatibilityProtocolError("tool_search_fallback_required", message);
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
    .sort(
      (left, right) =>
        right.score - left.score || compareCodeUnits(left.tool.name, right.tool.name),
    )
    .map(({ tool }) => tool);
}

function compareCodeUnits(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
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

export function createToolSearchErrorResult({
  toolUseId,
  errorCode,
  errorMessage,
} = {}) {
  assertToolUseId(toolUseId);
  if (!TOOL_SEARCH_ERROR_CODES.has(errorCode)) {
    throw new CompatibilityProtocolError(
      "invalid_tool_search_error",
      "unsupported ToolSearch error code",
    );
  }
  const content = { type: "tool_search_tool_result_error", error_code: errorCode };
  if (errorMessage !== undefined) content.error_message = String(errorMessage);
  return { type: "tool_search_tool_result", tool_use_id: toolUseId, content };
}

export function mapToolSearchError({ toolUseId, error } = {}) {
  if (error?.code === "tool_search_fallback_required") throw error;
  const isSafeInputError = TOOL_SEARCH_INPUT_ERROR_CODES.has(error?.code);
  const errorCode = isSafeInputError
    ? "invalid_tool_input"
    : TOOL_SEARCH_ERROR_CODES.has(error?.code)
      ? error.code
      : "unavailable";
  return createToolSearchErrorResult({
    toolUseId,
    errorCode,
    errorMessage: isSafeInputError
      ? error?.message
      : TOOL_SEARCH_PUBLIC_ERROR_MESSAGES[errorCode] ?? "ToolSearch request failed",
  });
}

function assertToolUseId(toolUseId) {
  if (typeof toolUseId !== "string" || toolUseId.length === 0) {
    throw new CompatibilityProtocolError("missing_tool_use_id", "toolUseId is required");
  }
}
