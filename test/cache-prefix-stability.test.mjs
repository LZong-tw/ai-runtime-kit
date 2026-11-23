import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { NON_CLAUDE_ADVISOR_PROMPT } from "../src/compat/advisor-policy.mjs";
import {
  allow,
  createOutboundPipeline,
  formatDivergence,
  prefixDivergence,
} from "./helpers/prefix-stability.mjs";

// Every request in a session must keep the previous request's tools, system
// and messages as its prefix after airkit has transformed it, or the provider
// prompt cache misses for the whole conversation. 1fde474 fixed one such
// regression (inline hook messages hoisted into `system`); this file runs
// whole sessions through the real outbound pipeline so the next one fails here.
// The captures carry no thinking blocks (their stub never streamed any), so
// the thinking-history guard (reasoning-history, the Responses thinking
// rewrite) rests on the synthetic session below.

const providers = [
  { name: "messages", type: "anthropic_messages", models: ["claude-opus-5-5"] },
  { name: "chat", type: "openai_chat_completions", models: ["model-a"] },
  { name: "responses", type: "openai_responses", models: ["model-b"] },
];

const config = {
  fallback: { provider: "messages", model: "claude-opus-5-5", maxContinuationTurns: 8 },
  toolSearch: { mode: "bridge" },
  webSearch: { mode: "native-first" },
  webFetch: { mode: "native-first" },
  codeExecution: { mode: "anthropic-fallback" },
  advisor: { mode: "bridge" },
  mcpConnector: { mode: "anthropic-fallback" },
  modelPrompts: [{ match: "^model-", prompt: NON_CLAUDE_ADVISOR_PROMPT }],
};

const ROUTES = [
  { model: "messages/claude-opus-5-5", claude: true, hoistsImages: false },
  { model: "chat/model-a", claude: false, hoistsImages: true },
  { model: "responses/model-b", claude: false, hoistsImages: true, rewritesThinking: true },
];

// A server tool sends the request down the compatibility executor instead of
// the raw passthrough; the Advisor bridge keeps the turn on the routed model.
const ADVISOR_TOOL = { type: "advisor_20260301", name: "advisor" };
const PATHS = [
  { path: "passthrough", tools: (tools) => tools },
  { path: "compat", tools: (tools) => [...tools, ADVISOR_TOOL] },
];

const IMAGE_MARKER = "from this tool result is attached separately";

const fixtureDir = join(import.meta.dirname, "fixtures", "cache-prefix");
const fixture = (name) => JSON.parse(readFileSync(join(fixtureDir, name), "utf8"));

let sessionCounter = 0;

// Each replay gets its own session id: subagent model-following keeps
// per-session state, and the fixtures share placeholder ids.
function withSession(body, headers, sessionId) {
  const userId = JSON.parse(body.metadata?.user_id ?? "{}");
  return {
    body: { ...body, metadata: { ...body.metadata, user_id: JSON.stringify({ ...userId, session_id: sessionId }) } },
    headers: { ...headers, "x-claude-code-session-id": sessionId },
  };
}

async function runSession({ requests, route, path }) {
  const pipeline = createOutboundPipeline({ config, providers });
  const sessionId = `00000000-0000-4000-8000-${String(++sessionCounter).padStart(12, "0")}`;
  const sent = [];
  const verdicts = [];
  for (const [index, request] of requests.entries()) {
    const body = { ...request.body, model: route.model, tools: path.tools(request.body.tools) };
    const scoped = withSession(body, request.headers ?? {}, sessionId);
    const result = await pipeline.send(scoped.body, scoped.headers);
    const where = `${route.model} ${path.path} request ${index + 1}`;
    assert.equal(result.status, 200, where);
    // With an end_turn reply there is exactly one upstream call per request;
    // Advisor consults and executor continuations would be separate lanes.
    assert.equal(result.attempts.length, 1, `${where}: upstream calls`);
    assert.equal(result.attempts[0].path, path.path, `${where}: took the wrong path`);
    // A silent whole-request fallback would compare a different lane.
    assert.equal(result.attempts[0].body.model, route.model, `${where}: outbound model`);
    sent.push(result.attempts[0].body);
    verdicts.push(prefixVerdict(result.row));
  }
  return { sent, verdicts };
}

// The runtime tracker's view of the same replay, as stored per request.
function prefixVerdict(row) {
  return Object.fromEntries(["status", "reason", "origin", "field", "index"]
    .map((key) => [key, row?.[`prefix_${key}`] ?? null])
    .filter(([key, value]) => key === "status" || value !== null));
}

// Whatever the replay asserts about the bytes, the runtime detector watching
// the same session must agree: no request may be flagged as airkit drift.
function assertNoAirkitDrift(verdicts, label) {
  assert.deepEqual(verdicts[0], { status: "baseline" }, `${label}: first request`);
  for (const [index, verdict] of verdicts.entries()) {
    assert.ok(verdict.status !== "drift" || verdict.origin !== "airkit",
      `${label}: request ${index + 1} flagged as airkit drift ${JSON.stringify(verdict)}`);
  }
}

// The same checks with the comparator stripped down would pass vacuously on a
// misbound selector, so each session also proves the transforms it claims ran.
function assertTransformsRan(sent, route, { image = false, thinking = false } = {}) {
  for (const body of sent) {
    assert.ok(body.messages.every((message) => message.role !== "system"), "inline system role left in messages");
    const lastSystem = body.system.at(-1)?.text;
    if (route.claude) assert.notEqual(lastSystem, NON_CLAUDE_ADVISOR_PROMPT);
    else assert.equal(lastSystem, NON_CLAUDE_ADVISOR_PROMPT, `${route.model}: model prompt is not the last system block`);
  }
  const last = JSON.stringify(sent.at(-1).messages);
  if (image) assert.equal(last.includes(IMAGE_MARKER), route.hoistsImages, `${route.model}: image hoisting`);
  if (thinking) {
    const kept = sent.at(-1).messages.some((message) => message.role === "assistant" &&
      Array.isArray(message.content) && message.content.some((block) => block.type === "thinking"));
    assert.equal(kept, !route.rewritesThinking, `${route.model}: unsigned thinking rewrite`);
  }
}

function assertPrefixStable(sent, inbound, allowancesFor, label) {
  for (let index = 1; index < sent.length; index++) {
    // The captured history must itself be append-only, or a failure below
    // would blame airkit for what Claude Code sent.
    const upstream = prefixDivergence(inbound[index - 1], inbound[index], {
      allowances: allowancesFor(index).inbound ?? [],
    });
    assert.equal(upstream, null, `${label}: inbound ${index}→${index + 1} ${formatDivergence(upstream)}`);
    const divergence = prefixDivergence(sent[index - 1], sent[index], {
      allowances: allowancesFor(index).outbound ?? [],
    });
    assert.equal(divergence, null, `${label}: request ${index}→${index + 1} ${formatDivergence(divergence)}`);
  }
}

for (const route of ROUTES) {
  for (const path of PATHS) {
    test(`captured Claude Code session with hooks, an image and --resume keeps its prefix on ${route.model} (${path.path})`, async () => {
      const { requests } = fixture("claude-code-2.1.330-hooks-image-resume.json");
      const { sent, verdicts } = await runSession({ requests, route, path });
      assertPrefixStable(sent, requests.map((request) => request.body), () => ({}), `${route.model} ${path.path}`);
      assertTransformsRan(sent, route, { image: true });
      assertNoAirkitDrift(verdicts, `${route.model} ${path.path}`);
      assert.deepEqual(verdicts.slice(1), verdicts.slice(1).map(() => ({ status: "stable" })));
    });

    test(`captured ToolSearch activation keeps its prefix on ${route.model} (${path.path})`, async () => {
      const { requests } = fixture("claude-code-2.1.330-toolsearch-activation.json");
      const { sent, verdicts } = await runSession({ requests, route, path });
      // Claude Code inserts the loaded tool's definition itself. Passthrough
      // forwards that insertion unchanged; the executor lists the tool once
      // history shows it loaded, which is the activation allowance.
      const outbound = path.path === "passthrough"
        ? allow("claude_code_deferred_tool_insertion", ["WebFetch"])
        : allow("deferred_tool_activation", ["WebFetch"]);
      assertPrefixStable(sent, requests.map((request) => request.body), (index) => index === 1 ? {
        inbound: [allow("claude_code_deferred_tool_insertion", ["WebFetch"])],
        outbound: [outbound],
      } : {}, `${route.model} ${path.path}`);
      assertTransformsRan(sent, route);
      // The tracker sees the insertion arrive in the inbound tools too.
      assertNoAirkitDrift(verdicts, `${route.model} ${path.path}`);
      const { index: _index, ...insertion } = verdicts[1];
      assert.deepEqual(insertion, { status: "drift", origin: "upstream", field: "tools" });
      assert.deepEqual(verdicts[2], { status: "stable" });
    });
  }
}

// Synthetic session in Claude Code's wire shape, covering positions the
// captures did not: hooks between assistant turns and between a tool_use and
// its tool_result, an environment update, an inline tool_addition, unsigned
// thinking, non-ASCII text, and a typed prompt with no hook after it, which is
// the tail as a block and re-sent as a bare string. A second deferred tool
// that is never loaded pins the activation to the named tool only. Requests
// are cut only where Claude Code sends one: after a user turn and the system
// messages that arrive with it.
const text = (value) => ({ type: "text", text: value });
const user = (content) => ({ role: "user", content });
const assistant = (content) => ({ role: "assistant", content });
const system = (content) => ({ role: "system", content });
const toolUse = (id, name, input = {}) => ({ type: "tool_use", id, name, input });
const toolResult = (id, content) => ({ type: "tool_result", tool_use_id: id, content });
const png = { type: "image", source: { type: "base64", data: "iVBORw0KGgoAAAANSUhEUg==", media_type: "image/png" } };
const schema = { type: "object", properties: { path: { type: "string" } }, required: ["path"] };

const SYNTHETIC_TURNS = [
  [
    user([text("<system-reminder>\nattribution note\n</system-reminder>"), text("Résumé the café menu — 測試 ✓ \"quoted\" \\ path")]),
    system("SessionStart hook additional context: synthetic session context.\n\n# Environment\nPlatform: synthetic"),
  ],
  [
    assistant([{ type: "thinking", thinking: "Plan: read the image.", signature: "" }, text("Reading."), toolUse("toolu_1", "Read", { path: "a.png" })]),
    system("PreToolUse:Read hook additional context: before the result."),
    user([toolResult("toolu_1", [png])]),
    system("PostToolUse:Read hook additional context: after the result."),
  ],
  [
    assistant([text("Half done.")]),
    system("# Environment update\nThe working directory changed. (Reconstructed: no capture has this message yet.)"),
    assistant([toolUse("toolu_2", "ToolSearch", { query: "select:WebFetch" })]),
    user([toolResult("toolu_2", "Tool loaded.")]),
    system([{ type: "tool_addition", tool: { type: "tool_reference", name: "WebFetch" } }]),
    system("PostToolUse:ToolSearch hook additional context: tool loaded."),
  ],
  [
    assistant([toolUse("toolu_3", "WebFetch", { path: "https://example.com/" })]),
    user([toolResult("toolu_3", "fetched")]),
  ],
  [
    assistant([text("DONE")]),
    user("Next question."),
    system("UserPromptSubmit hook additional context: second prompt."),
  ],
  [
    assistant([text("Second answer.")]),
    user("A typed prompt with no hook output."),
  ],
  [
    assistant([text("DONE")]),
    user("Last prompt."),
  ],
];

const SYNTHETIC_BASE = {
  model: "claude-opus-5-5",
  system: [
    text("x-anthropic-billing-header: cc_version=0.0.0.abc; cc_entrypoint=sdk-cli;"),
    { ...text("Agent identity line."), cache_control: { type: "ephemeral" } },
    { ...text("Main system prompt."), cache_control: { type: "ephemeral" } },
  ],
  tools: [
    { name: "Read", description: "Read a file.", input_schema: schema },
    { name: "ToolSearch", description: "Load deferred tools.", input_schema: schema },
    { name: "WebFetch", description: "Fetch a URL.", input_schema: schema, defer_loading: true },
    { name: "Write", description: "Write a file.", input_schema: schema },
    { name: "NotebookEdit", description: "Edit a notebook.", input_schema: schema, defer_loading: true },
  ],
  metadata: { user_id: JSON.stringify({ device_id: "1".repeat(64), account_uuid: "", session_id: "placeholder" }) },
  max_tokens: 32000,
  thinking: { type: "adaptive" },
  stream: true,
};

// Claude Code marks only the newest message's last block, and sends that
// message as a block array even when it re-sends it later as a bare string.
function asSent(history) {
  return history.map((message, index) => {
    if (index < history.length - 1) return message;
    const blocks = typeof message.content === "string" ? [text(message.content)] : message.content;
    return {
      ...message,
      content: blocks.map((block, at) => at === blocks.length - 1 ? { ...block, cache_control: { type: "ephemeral" } } : block),
    };
  });
}

function syntheticRequests(turns = SYNTHETIC_TURNS) {
  const history = [];
  return turns.map((turn) => {
    history.push(...turn);
    return { body: { ...structuredClone(SYNTHETIC_BASE), messages: asSent(structuredClone(history)) } };
  });
}

for (const route of ROUTES) {
  for (const path of PATHS) {
    test(`synthetic session with hooks at every position keeps its prefix on ${route.model} (${path.path})`, async () => {
      const requests = syntheticRequests();
      const { sent, verdicts } = await runSession({ requests, route, path });
      // The tool_addition in turn 3 is the one point where tools may change.
      assertPrefixStable(sent, requests.map((request) => request.body), (index) => index === 2 ? {
        outbound: [allow("deferred_tool_activation", ["WebFetch"])],
      } : {}, `${route.model} ${path.path}`);
      assertTransformsRan(sent, route, { image: true, thinking: true });
      assertNoAirkitDrift(verdicts, `${route.model} ${path.path}`);
      assert.deepEqual(verdicts.slice(1), verdicts.slice(1).map((_, at) => at + 1 === 2
        ? { status: "allowed", reason: "deferred_tool_activation", origin: "airkit", field: "tools", index: 2 }
        : { status: "stable" }));
    });
  }
}

// Pinned gap, not tolerated: a system message appended after a user turn that
// was already the tail of request N is folded into that turn, so N's last
// message grows. Claude Code 2.1.330 always sends hook output in the same
// request as its user turn, so no capture shows this; if one ever does, this
// is where the cache breaks. A fix changes this expectation on purpose.
test("known gap: a system message arriving after an already-sent user turn extends that turn", async () => {
  const route = ROUTES[1];
  const turns = [
    [user([text("First question.")])],
    [system("Late hook context."), assistant([text("Answer.")]), user("Follow-up.")],
  ];
  const requests = syntheticRequests(turns);
  const { sent, verdicts } = await runSession({ requests, route, path: PATHS[0] });
  const divergence = prefixDivergence(sent[0], sent[1]);
  assert.equal(divergence?.field, "messages");
  assert.equal(divergence.index, sent[0].messages.length - 1);
  const strip = (blocks) => JSON.parse(JSON.stringify(blocks, (key, value) => key === "cache_control" ? undefined : value));
  const before = strip(sent[0].messages.at(-1).content);
  const after = strip(sent[1].messages[divergence.index].content);
  assert.deepEqual(after.slice(0, before.length), before);
  assert.ok(after.length > before.length);
  // The runtime tracker reports the same break, and blames airkit: the
  // inbound history was append-only.
  assert.deepEqual(verdicts[1], {
    status: "drift", origin: "airkit", field: "messages", index: sent[0].messages.length - 1,
  });
});

test("a throwing drift tracker costs the request neither its response nor its row", async () => {
  const [route] = ROUTES;
  const pipeline = createOutboundPipeline({
    config, providers, prefixDriftTracker: { observe() { throw new Error("tracker bug"); } },
  });
  const [request] = fixture("claude-code-2.1.330-hooks-image-resume.json").requests;
  const scoped = withSession({ ...request.body, model: route.model }, request.headers, "00000000-0000-4000-8000-0000000000ff");
  const result = await pipeline.send(scoped.body, scoped.headers);
  assert.equal(result.status, 200);
  assert.equal(result.attempts.length, 1);
  assert.equal(result.row.kind, "success");
  assert.equal(result.row.prefix_status, null);
});

// observe() runs on the event loop every other stream shares, so the handler
// gives it the bodies it already parsed: re-parsing a 30 MB image-heavy
// history twice per request cost 100+ ms there.
test("the drift tracker gets parsed bodies, not bytes to parse again, on the passthrough", async () => {
  const [route] = ROUTES;
  const seen = [];
  const pipeline = createOutboundPipeline({
    config, providers, prefixDriftTracker: { observe(args) { seen.push(args); return null; } },
  });
  const [request] = fixture("claude-code-2.1.330-hooks-image-resume.json").requests;
  const scoped = withSession({ ...request.body, model: route.model }, request.headers, "00000000-0000-4000-8000-0000000000fe");
  await pipeline.send(scoped.body, scoped.headers);
  assert.equal(seen.length, 1);
  for (const side of ["inbound", "outbound"]) {
    assert.ok(!Buffer.isBuffer(seen[0][side]) && typeof seen[0][side] === "object", `${side} is parsed`);
    assert.ok(Array.isArray(seen[0][side].messages), `${side} is the request body`);
  }
  // The inbound side is the body as Claude Code sent it, before any transform.
  assert.ok(seen[0].inbound.messages.some((message) => message.role === "system"));
  assert.ok(seen[0].outbound.messages.every((message) => message.role !== "system"));
});

test("the comparator names the first diverging field, index and block", () => {
  const base = {
    model: "m",
    tools: [{ name: "a" }, { name: "b" }],
    system: [text("s0"), text("s1")],
    messages: [user([text("u0")]), assistant([text("a0")])],
  };
  const changed = (patch) => ({ ...structuredClone(base), ...patch });
  assert.equal(prefixDivergence(base, changed({ messages: [...base.messages, user("next")] })), null);
  assert.equal(
    prefixDivergence(base, changed({ messages: [{ ...user([{ ...text("u0"), cache_control: { type: "ephemeral" } }]) }, base.messages[1]] })),
    null,
    "cache_control alone is not a divergence",
  );
  assert.deepEqual(prefixDivergence(base, changed({ tools: [{ name: "a" }, { name: "c" }] })),
    { field: "tools", index: 1, detail: "tools[1] b became c" });
  assert.deepEqual(prefixDivergence(base, changed({ system: [text("s0"), text("s1"), text("hook")] })),
    { field: "system", index: 2, detail: "system length 2 became 3" });
  assert.deepEqual(prefixDivergence(base, changed({ messages: [user([text("u0"), text("x")]), base.messages[1]] })),
    { field: "messages", index: 0, block: 1, detail: "messages[0].content length 1 became 2" });
  assert.equal(prefixDivergence(base, changed({ messages: [user("u0"), base.messages[1]] })), null,
    "string and one-block content are the same prefix");
  assert.deepEqual(prefixDivergence(base, changed({ tool_choice: { type: "auto" } })),
    { field: "params", detail: 'tool_choice absent became {"type":"auto"}' });
  assert.deepEqual(prefixDivergence({ ...base, thinking: { type: "adaptive" } }, base),
    { field: "params", detail: 'thinking {"type":"adaptive"} became absent' });
  assert.deepEqual(prefixDivergence(base, base, { allowances: [allow("deferred_tool_activation", ["a"])] }),
    { field: "allowance", detail: "unused allowance deferred_tool_activation" });
  assert.throws(() => allow("anything_goes", []), /unknown allowance/);
});
