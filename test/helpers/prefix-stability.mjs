import { createMessagesHandler } from "../../src/compat/plugin.mjs";
import { createGatewayClient } from "../../src/compat/gateway.mjs";
import { resolveCompatibilityPolicies, VERIFIED_NATIVE_COMPATIBILITY } from "../../src/compat/config.mjs";
import { canonicalPrefixJson, canonicalTextShape } from "../../src/compat/prefix-observability.mjs";
import { createPluginRequest, createRecordingResponse } from "./compat-fixtures.mjs";

// The runtime drift tracker and this replay test must agree on what counts as
// the same prefix, so both use the same canonical form. Comparison is on
// parsed JSON, so escape-only byte differences (`é` vs `é`) do not count;
// providers parse before tokenizing. A message sent as a bare string and as
// one text block is the same prefix too: Claude Code flips between the two
// every turn (see canonicalTextShape).
export const canonical = canonicalPrefixJson;

// Named, structural allowances for the one-off tool catalogue changes a
// session legitimately goes through. Each describes exactly which diff it
// permits, so anything beyond that still fails.
export const ALLOWANCES = {
  // airkit's tool_addition handling flips defer_loading on activated tools;
  // the compatibility executor instead adds them to its tool list.
  deferred_tool_activation(previous, next, names) {
    const loaded = (tool) => tool !== undefined && tool.defer_loading !== true;
    return sameExcept(previous, next, names) &&
      names.every((name) => loaded(byName(next, name)) && !loaded(byName(previous, name)));
  },
  // Claude Code inserts a tool's full definition, still deferred, once
  // ToolSearch loads it. The insertion happens upstream of airkit.
  claude_code_deferred_tool_insertion(previous, next, names) {
    return sameExcept(previous, next, names) &&
      names.every((name) => byName(previous, name) === undefined && byName(next, name)?.defer_loading === true);
  },
};

function byName(tools, name) {
  return (tools ?? []).find((tool) => tool?.name === name);
}

function sameExcept(previous, next, names) {
  const rest = (tools) => canonical((tools ?? []).filter((tool) => !names.includes(tool?.name)));
  return rest(previous) === rest(next);
}

export function allow(name, tools) {
  if (!(name in ALLOWANCES)) throw new Error(`unknown allowance ${name}`);
  return { name, tools };
}

// Returns null when `next` keeps `previous` as its cacheable prefix, otherwise
// the first diverging field and position. Fields are checked in the order a
// provider renders them, so the report names the earliest cache break.
// Each allowance must be consumed: an allowance that matched nothing means the
// scenario no longer exercises what it claims to.
export function prefixDivergence(previous, next, { allowances = [] } = {}) {
  if (previous.model !== next.model) {
    return { field: "model", detail: `model changed from ${previous.model} to ${next.model}` };
  }
  const unused = new Set(allowances);
  if (canonical(previous.tools) !== canonical(next.tools)) {
    const used = allowances.find((entry) => ALLOWANCES[entry.name](previous.tools, next.tools, entry.tools));
    if (used === undefined) return describeArray("tools", previous.tools, next.tools, toolLabel);
    unused.delete(used);
  }
  if (canonical(previous.system) !== canonical(next.system)) {
    return describeArray("system", asBlocks(previous.system), asBlocks(next.system), blockLabel);
  }
  const before = previous.messages ?? [];
  const after = next.messages ?? [];
  for (let index = 0; index < before.length; index++) {
    if (index >= after.length) {
      return { field: "messages", index, detail: `messages: N has ${before.length}, N+1 only ${after.length}` };
    }
    const a = canonicalTextShape(before[index]);
    const b = canonicalTextShape(after[index]);
    if (canonical(a) === canonical(b)) continue;
    const blocks = describeArray(`messages[${index}].content`, asBlocks(a.content), asBlocks(b.content), blockLabel);
    return {
      field: "messages",
      index,
      block: blocks.index,
      detail: a.role === b.role ? blocks.detail : `messages[${index}] role ${a.role} became ${b.role}`,
    };
  }
  // Request parameters the provider keys its messages cache on (thinking,
  // tool_choice, effort, speed) must not change between requests either.
  const params = describeParams(previous, next);
  if (params !== null) return params;
  if (unused.size > 0) {
    return { field: "allowance", detail: `unused allowance ${[...unused].map((entry) => entry.name).join(", ")}` };
  }
  return null;
}

export function formatDivergence(divergence) {
  return divergence === null ? "prefix stable" : `${divergence.field}: ${divergence.detail}`;
}

export const CACHE_PARAMS = {
  thinking: (body) => body.thinking,
  tool_choice: (body) => body.tool_choice,
  effort: (body) => body.output_config?.effort,
  speed: (body) => body.speed,
};

function describeParams(previous, next) {
  for (const [name, read] of Object.entries(CACHE_PARAMS)) {
    const before = JSON.stringify(read(previous)) ?? "absent";
    const after = JSON.stringify(read(next)) ?? "absent";
    if (before !== after) return { field: "params", detail: `${name} ${before} became ${after}` };
  }
  return null;
}

function asBlocks(value) {
  if (value === undefined) return [];
  return typeof value === "string" ? [{ type: "text", text: value }] : value;
}

function toolLabel(tool) {
  return tool?.name ?? tool?.type ?? "?";
}

function blockLabel(block) {
  const text = typeof block?.text === "string" ? ` ${JSON.stringify(block.text.slice(0, 60))}` : "";
  return `${block?.type ?? "?"}${text}`;
}

function describeArray(field, previous = [], next = [], label) {
  const shared = Math.min(previous.length, next.length);
  let index = 0;
  while (index < shared && canonical(previous[index]) === canonical(next[index])) index++;
  if (index === shared) {
    return { field: field.split("[")[0], index, detail: `${field} length ${previous.length} became ${next.length}` };
  }
  const before = label(previous[index]);
  const after = label(next[index]);
  return {
    field: field.split("[")[0],
    index,
    detail: `${field}[${index}] ${before} became ${after}` +
      (before === after ? `, first differing at ${firstDifference(previous[index], next[index])}` : ""),
  };
}

// Same-typed blocks need the spot inside them that changed to be actionable.
function firstDifference(previous, next) {
  const a = canonical(previous);
  const b = canonical(next);
  let at = 0;
  while (at < a.length && a[at] === b[at]) at++;
  const excerpt = (value) => JSON.stringify(value.slice(Math.max(0, at - 20), at + 40));
  return `char ${at}: ${excerpt(a)} vs ${excerpt(b)}`;
}

const CANNED_MESSAGE = {
  id: "msg_prefix", type: "message", role: "assistant", model: "fixture-model",
  content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", stop_sequence: null,
  usage: { input_tokens: 1, output_tokens: 1 },
};

// Drives the same composition the launcher's middleware builds
// (createGatewayClient + createMessagesHandler), so the outbound normalizers in
// the gateway client run too. Only fetch is replaced: it records the exact
// bytes that would leave for CCR. forwardRaw hands fetch a Buffer, the
// compatibility executor a string, which tells the two paths apart. The
// request store keeps each row, so a replay also shows the runtime prefix
// drift verdict the launcher would record.
export function createOutboundPipeline({ config, providers, prefixDriftTracker }) {
  const attempts = [];
  const rows = [];
  const requestStore = { record(row) { rows.push(row); }, prune() {}, close() {} };
  const coreClient = createGatewayClient({
    origin: "http://127.0.0.1:3456",
    token: "synthetic-token",
    providers,
    restrictedThinkingProviders: config.restrictedThinkingProviders ?? [],
    async fetchImpl(_url, options) {
      attempts.push({
        path: Buffer.isBuffer(options.body) ? "passthrough" : "compat",
        body: JSON.parse(Buffer.from(options.body).toString("utf8")),
      });
      return new Response(JSON.stringify(CANNED_MESSAGE), { headers: { "content-type": "application/json" } });
    },
  });
  const { policies } = resolveCompatibilityPolicies(config, VERIFIED_NATIVE_COMPATIBILITY);
  const handler = createMessagesHandler({
    config, coreClient, policies, requestStore,
    ...(prefixDriftTracker === undefined ? {} : { prefixDriftTracker }),
  });
  return {
    async send(body, headers = {}) {
      const start = attempts.length;
      const response = createRecordingResponse();
      await handler(createPluginRequest(Buffer.from(JSON.stringify(body)), { headers }), response, {
        readBody: async (request) => request.body,
      });
      return { status: response.statusCode, attempts: attempts.slice(start), row: rows.at(-1) };
    },
  };
}
