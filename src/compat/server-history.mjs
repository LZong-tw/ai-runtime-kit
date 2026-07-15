const SERVER_RESULT_FAMILIES = Object.freeze({
  advisor_tool_result: "advisor",
  code_execution_tool_result: "codeExecution",
  web_fetch_tool_result: "webFetch",
  web_search_tool_result: "webSearch",
  tool_search_tool_result: "toolSearch",
  mcp_tool_result: "mcpConnector",
});

export function inspectPendingServerHistory(body = {}) {
  const serverCalls = new Map();
  const clientCalls = new Set();
  const serverResults = new Map();
  const clientResults = new Set();
  const families = new Set();
  let lifecycleServerCallTurns = 0;
  let unsupported = false;

  for (const message of Array.isArray(body?.messages) ? body.messages : []) {
    if (startsLogicalTurn(message)) lifecycleServerCallTurns = 0;
    if (!Array.isArray(message?.content)) continue;
    let containsServerCall = false;
    for (const block of message.content) {
      const serverFamily = serverCallFamily(block);
      if (serverFamily !== undefined) {
        containsServerCall = true;
        if (!recordCall(serverCalls, block?.id, serverFamily)) unsupported = true;
        if (serverFamily === null) unsupported = true;
        else families.add(serverFamily);
        continue;
      }
      if (block?.type === "tool_use") {
        if (!recordClientCall(clientCalls, block.id)) unsupported = true;
        continue;
      }

      const resultFamily = serverResultFamily(block);
      if (resultFamily !== undefined) {
        if (!recordResult(serverResults, block?.tool_use_id, resultFamily)) unsupported = true;
        if (resultFamily === null) unsupported = true;
        else families.add(resultFamily);
        continue;
      }
      if (block?.type === "tool_result") {
        if (!recordClientResult(clientResults, block.tool_use_id)) unsupported = true;
      }
    }
    if (containsServerCall) lifecycleServerCallTurns += 1;
  }

  for (const [id, resultFamily] of serverResults) {
    const callFamily = serverCalls.get(id);
    if (callFamily === undefined || callFamily !== resultFamily || clientCalls.has(id)) {
      unsupported = true;
    }
  }
  for (const id of clientResults) {
    if (!clientCalls.has(id) || serverCalls.has(id)) unsupported = true;
  }

  const serverCallIds = [...serverCalls.keys()];
  const clientCallIds = [...clientCalls];
  const serverResultIds = [...serverResults.keys()];
  const clientResultIds = [...clientResults];
  const pendingServerCallIds = serverCallIds.filter((id) => !serverResults.has(id));
  const pendingClientCallIds = clientCallIds.filter((id) => !clientResults.has(id));
  const containerId = typeof body?.container?.id === "string" ? body.container.id : null;

  return {
    serverCallIds,
    clientCallIds,
    serverResultIds,
    clientResultIds,
    pendingServerCallIds,
    pendingClientCallIds,
    families,
    containerId,
    continuation: continuationKind({
      clientCallIds,
      clientResultIds,
      containerId,
      pendingClientCallIds,
      pendingServerCallIds,
      serverCallIds,
      serverResultIds,
      unsupported,
    }),
    continuationTurns: lifecycleServerCallTurns,
    requiresFallback: unsupported || serverCallIds.length > 0 || serverResultIds.length > 0,
  };
}

function startsLogicalTurn(message) {
  if (message?.role !== "user") return false;
  if (typeof message.content === "string") return true;
  if (!Array.isArray(message.content)) return false;
  return message.content.some((block) => !isResultBlock(block));
}

function isResultBlock(block) {
  return block?.type === "tool_result" || serverResultFamily(block) !== undefined;
}

function serverCallFamily(block) {
  if (block?.type === "mcp_tool_use") return "mcpConnector";
  if (block?.type !== "server_tool_use") return undefined;
  const name = String(block.name ?? "");
  if (name === "advisor") return "advisor";
  if (name === "web_search") return "webSearch";
  if (name === "web_fetch") return "webFetch";
  if (name === "code_execution" || name.endsWith("_code_execution")) return "codeExecution";
  if (name.startsWith("tool_search_tool_")) return "toolSearch";
  return null;
}

function serverResultFamily(block) {
  const type = block?.type;
  if (typeof type !== "string" || type === "tool_result") return undefined;
  if (Object.hasOwn(SERVER_RESULT_FAMILIES, type)) return SERVER_RESULT_FAMILIES[type];
  if (type.endsWith("_code_execution_tool_result")) return "codeExecution";
  if (type.endsWith("_tool_result")) return null;
  if (Object.hasOwn(block, "tool_use_id")) return null;
  return undefined;
}

function recordCall(calls, id, family) {
  if (typeof id !== "string" || id.length === 0 || calls.has(id)) return false;
  calls.set(id, family);
  return true;
}

function recordClientCall(calls, id) {
  if (typeof id !== "string" || id.length === 0 || calls.has(id)) return false;
  calls.add(id);
  return true;
}

function recordResult(results, id, family) {
  if (typeof id !== "string" || id.length === 0 || results.has(id)) return false;
  results.set(id, family);
  return true;
}

function recordClientResult(results, id) {
  if (typeof id !== "string" || id.length === 0 || results.has(id)) return false;
  results.add(id);
  return true;
}

function continuationKind({
  clientCallIds,
  clientResultIds,
  containerId,
  pendingClientCallIds,
  pendingServerCallIds,
  serverCallIds,
  serverResultIds,
  unsupported,
}) {
  if (unsupported) return "unsupported";
  if (pendingServerCallIds.length > 0 && clientResultIds.length > 0) {
    return "mixed-client-results";
  }
  if (pendingServerCallIds.length > 0 && pendingClientCallIds.length > 0) {
    return "mixed-pending";
  }
  if (pendingServerCallIds.length > 0) return "server-pending";
  if (pendingClientCallIds.length > 0) return "client-pending";
  if (serverCallIds.length > 0 || serverResultIds.length > 0 || containerId !== null) {
    return "server-continuation";
  }
  if (clientCallIds.length > 0 || clientResultIds.length > 0) return "client-continuation";
  return "initial";
}
