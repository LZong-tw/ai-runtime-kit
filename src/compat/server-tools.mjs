export const SERVER_TOOL_TYPES = Object.freeze({
  webSearch: Object.freeze([
    "web_search_20250305",
    "web_search_20260209",
    "web_search_20260318",
  ]),
  webFetch: Object.freeze([
    "web_fetch_20250910",
    "web_fetch_20260209",
    "web_fetch_20260309",
    "web_fetch_20260318",
  ]),
  codeExecution: Object.freeze([
    "code_execution_20250825",
    "code_execution_20260120",
    "code_execution_20260521",
  ]),
  advisor: Object.freeze(["advisor_20260301"]),
  toolSearch: Object.freeze([
    "tool_search_tool_regex_20251119",
    "tool_search_tool_bm25_20251119",
    "tool_search_tool_regex",
    "tool_search_tool_bm25",
  ]),
  mcpConnector: Object.freeze(["mcp_toolset"]),
});

const FUTURE_SERVER_TOOL =
  /^(?:web_search|web_fetch|code_execution|advisor|tool_search_tool_(?:regex|bm25))_[0-9]{8}$/;
const CLIENT_TOOL_FAMILIES = Object.freeze({
  WebFetch: "webFetch",
  WebSearch: "webSearch",
});
const CLIENT_TOOL_NAMES = Object.freeze(Object.fromEntries(
  Object.entries(CLIENT_TOOL_FAMILIES).map(([name, family]) => [family, name]),
));

export function isFutureServerToolType(type) {
  return (
    typeof type === "string" &&
    FUTURE_SERVER_TOOL.test(type) &&
    !Object.values(SERVER_TOOL_TYPES).some((types) => types.includes(type))
  );
}

export function classifyToolDefinition(tool = {}) {
  const type = tool?.type;
  for (const [family, types] of Object.entries(SERVER_TOOL_TYPES)) {
    if (types.includes(type)) return { kind: "server", family, type, known: true };
  }
  if (isFutureServerToolType(type)) {
    return { kind: "server", family: null, type, known: false };
  }
  return { kind: "client", family: null, type: type ?? null, known: false };
}

// Removing a family's tool definitions is the only way to stop it from
// diverting a request it was never used in: `families` below is built from the
// presence of a definition, and requiresWholeRequestFallback sends the whole
// request to the fallback route on the strength of that alone. Returns the same
// object when nothing matched so callers can keep replaying the original bytes.
export function stripServerToolFamily(body, family) {
  const types = SERVER_TOOL_TYPES[family];
  if (types === undefined || !Array.isArray(body?.tools)) return body;
  const tools = body.tools.filter((tool) => !types.includes(tool?.type));
  return tools.length === body.tools.length ? body : { ...body, tools };
}

export function stripClientToolFamily(body, family) {
  const name = CLIENT_TOOL_NAMES[family];
  if (name === undefined || !Array.isArray(body?.tools)) return body;
  const tools = body.tools.filter((tool) => tool?.name !== name);
  return tools.length === body.tools.length ? body : { ...body, tools };
}

export function inspectServerToolRequest(body = {}) {
  const tools = Array.isArray(body?.tools) ? body.tools : [];
  const clientFamilies = new Set();
  const clientTools = [];
  const serverTools = [];
  const families = new Set();
  const futureTypes = [];

  for (const tool of tools) {
    const classification = classifyToolDefinition(tool);
    if (classification.kind === "client") {
      clientTools.push(tool);
      const clientFamily = CLIENT_TOOL_FAMILIES[tool?.name];
      if (clientFamily !== undefined) clientFamilies.add(clientFamily);
      continue;
    }

    serverTools.push(tool);
    if (classification.known) families.add(classification.family);
    else futureTypes.push(classification.type);
  }

  return {
    clientFamilies,
    clientTools,
    serverTools,
    families,
    futureTypes,
    requiresFallback: futureTypes.length > 0,
  };
}
