import assert from "node:assert/strict";
import { test } from "node:test";

import { createPrefixDriftTracker } from "../src/compat/prefix-observability.mjs";

const SESSION = "00000000-0000-4000-8000-000000000001";
const headers = (sessionId = SESSION, extra = {}) => ({ "x-claude-code-session-id": sessionId, ...extra });
const text = (value, extra = {}) => ({ type: "text", text: value, ...extra });
const user = (content) => ({ role: "user", content });
const assistant = (content) => ({ role: "assistant", content });

const BASE = {
  model: "chat/model-a",
  tools: [{ name: "Read", input_schema: { type: "object" } }, { name: "WebFetch", defer_loading: true }],
  system: [text("You are a coding agent."), text("Project notes.")],
};

// Claude Code's shape: an append-only history with the cache marker on the
// newest block only.
function turn(...messages) {
  return { ...structuredClone(BASE), messages: messages.map((message, index) => index < messages.length - 1
    ? message
    : { ...message, content: message.content.map((block, at) => at === message.content.length - 1 ? { ...block, cache_control: { type: "ephemeral" } } : block) }) };
}

const first = turn(user([text("First question.")]));
const second = turn(user([text("First question.")]), assistant([text("Answer.")]), user([text("Follow-up.")]));

function observe(tracker, inbound, outbound = inbound, requestHeaders = headers()) {
  return tracker.observe({ headers: requestHeaders, inbound, outbound });
}

function pick(verdict) {
  const { status, origin, field, index, inboundIndex } = verdict;
  return { status, origin, field, index, inboundIndex };
}

test("an append-only session is a baseline and then stable, ignoring the moving cache marker", () => {
  const tracker = createPrefixDriftTracker();
  assert.deepEqual(observe(tracker, first), { status: "baseline", messages: 1, tools: 2 });
  assert.deepEqual(observe(tracker, second), { status: "stable", messages: 3, tools: 2 });
  // The marker moved off messages[0] and onto messages[2]: still stable.
  assert.equal(second.messages[0].content[0].cache_control, undefined);
});

test("raw bytes are accepted on both sides, as the handler passes them", () => {
  const tracker = createPrefixDriftTracker();
  observe(tracker, Buffer.from(JSON.stringify(first)), JSON.stringify(first));
  assert.equal(observe(tracker, Buffer.from(JSON.stringify(second)), Buffer.from(JSON.stringify(second))).status, "stable");
});

test("a system change airkit introduced is drift with origin airkit and the first diverging index", () => {
  const tracker = createPrefixDriftTracker();
  observe(tracker, first);
  // The regression 1fde474 fixed: a hook message hoisted into system.
  const hoisted = { ...second, system: [...second.system, text("Hook context.")] };
  assert.deepEqual(observe(tracker, second, hoisted), {
    status: "drift", reason: null, origin: "airkit", field: "system", index: 2, inboundIndex: null,
    messages: 3, tools: 2,
  });
});

test("an airkit break outranks an upstream break in an earlier field", () => {
  const tracker = createPrefixDriftTracker();
  observe(tracker, first);
  const inbound = { ...second, tools: [...second.tools, { name: "Grep" }] };
  const outbound = { ...inbound, system: [text("Rewritten."), second.system[1]] };
  const verdict = observe(tracker, inbound, outbound);
  assert.equal(verdict.origin, "airkit");
  assert.equal(verdict.field, "system");
  assert.equal(verdict.index, 0);
});

test("a change that was already in the inbound field is upstream drift", () => {
  const tracker = createPrefixDriftTracker();
  observe(tracker, first);
  const upstream = { ...second, system: [text("You are a coding agent."), text("Changed notes.")] };
  assert.deepEqual(observe(tracker, upstream), {
    status: "drift", reason: null, origin: "upstream", field: "system", index: 1, inboundIndex: 1,
    messages: 3, tools: 2,
  });
  const rewound = {
    ...turn(user([text("First question.")]), assistant([text("Different answer.")]), user([text("Follow-up.")])),
    system: upstream.system,
  };
  const verdict = observe(tracker, rewound, rewound);
  assert.deepEqual([verdict.origin, verdict.field, verdict.index, verdict.inboundIndex], ["upstream", "messages", 1, 1]);
  // A new first message, as after a compaction, is a new thread, not drift.
  const compacted = turn(user([text("Summary of the earlier conversation.")]), assistant([text("Answer.")]));
  assert.equal(observe(tracker, compacted).status, "baseline");
});

test("a message airkit rewrote in history is drift at that message", () => {
  const tracker = createPrefixDriftTracker();
  observe(tracker, second);
  const third = turn(...second.messages.map((message) => ({ ...message, content: message.content.map(({ cache_control, ...block }) => block) })),
    assistant([text("More.")]), user([text("Again.")]));
  const outbound = structuredClone(third);
  outbound.messages[2].content.push(text("<system-reminder>late</system-reminder>"));
  const verdict = observe(tracker, third, outbound);
  assert.deepEqual([verdict.status, verdict.origin, verdict.field, verdict.index], ["drift", "airkit", "messages", 2]);
});

test("a block message re-sent as a bare string is the same prefix on both sides", () => {
  const tracker = createPrefixDriftTracker();
  observe(tracker, turn(user([text("First question.")]), { role: "user", content: [text("Hook.")] }));
  const resent = turn(user([text("First question.")]), assistant([text("Answer.")]), user([text("Next.")]));
  resent.messages.splice(1, 0, { role: "user", content: "Hook." });
  // Inline system messages come out of airkit as blocks again.
  const outbound = structuredClone(resent);
  outbound.messages[1] = { role: "user", content: [text("Hook.")] };
  assert.equal(observe(tracker, resent, outbound).status, "stable");
  // A typed prompt is forwarded in whatever shape Claude Code sent it; the
  // flip from tail block to bare string is not a break airkit introduced.
  const typed = turn(...resent.messages.map((message) => ({ ...message, content: typeof message.content === "string"
    ? message.content
    : message.content.map(({ cache_control: _marker, ...block }) => block) })), assistant([text("Done.")]), user([text("More.")]));
  typed.messages[3] = { role: "user", content: "Next." };
  assert.equal(observe(tracker, typed).status, "stable");
});

test("an airkit break before a later upstream edit is still blamed on airkit", () => {
  const tracker = createPrefixDriftTracker();
  const history = Array.from({ length: 60 }, (_, index) => index % 2 === 0
    ? user([text(`Prompt ${index}.`)])
    : assistant([text(`Reply ${index}.`)]));
  observe(tracker, turn(...history));
  const next = turn(...structuredClone(history), assistant([text("New reply.")]), user([text("New prompt.")]));
  // Upstream: an old tool result cleared in place, as microcompact does.
  next.messages[50] = user([text("[Old tool result content cleared]")]);
  const outbound = structuredClone(next);
  outbound.messages[3] = assistant([text("Rewritten by airkit.")]);
  assert.deepEqual(pick(observe(tracker, next, outbound)), { status: "drift", origin: "airkit", field: "messages", index: 3, inboundIndex: 50 });
  // Without the airkit rewrite, the same edit is upstream.
  const again = createPrefixDriftTracker();
  observe(again, turn(...history));
  assert.deepEqual(pick(observe(again, next)), { status: "drift", origin: "upstream", field: "messages", index: 50, inboundIndex: 50 });
});

test("an upstream edit stays upstream when folded inline system messages shift the outbound indices", () => {
  const system = (value) => ({ role: "system", content: value });
  // airkit's fold: each inline system message joins the user turn before it.
  const fold = (body) => {
    const messages = [];
    for (const message of body.messages) {
      if (message.role !== "system") messages.push(structuredClone(message));
      else messages.at(-1).content.push(text(`<system-reminder>${message.content}</system-reminder>`));
    }
    return { ...body, messages };
  };
  const history = [];
  for (let index = 0; index < 20; index++) {
    history.push(user([text(`Prompt ${index}.`)]), system(`Hook ${index}.`), assistant([text(`Reply ${index}.`)]));
  }
  const tracker = createPrefixDriftTracker();
  const previous = turn(...history);
  observe(tracker, previous, fold(previous));
  const next = turn(...structuredClone(history), user([text("New prompt.")]));
  next.messages[45] = user([text("Edited upstream.")]);
  const verdict = observe(tracker, next, fold(next));
  assert.deepEqual(pick(verdict), { status: "drift", origin: "upstream", field: "messages", index: 30, inboundIndex: 45 });
});

test("cache-keyed request parameters are compared like the prefix", () => {
  const tracker = createPrefixDriftTracker();
  observe(tracker, { ...first, thinking: { type: "adaptive" } });
  const inbound = { ...second, thinking: { type: "adaptive" } };
  assert.deepEqual(pick(observe(tracker, inbound, { ...inbound, tool_choice: { type: "auto" } })),
    { status: "drift", origin: "airkit", field: "params", index: 0, inboundIndex: null });
  const upstream = createPrefixDriftTracker();
  observe(upstream, { ...first, output_config: { effort: "high" } });
  assert.deepEqual(pick(observe(upstream, { ...second, output_config: { effort: "low" } })),
    { status: "drift", origin: "upstream", field: "params", index: 0, inboundIndex: 0 });
});

test("long payloads are fingerprinted by length and samples, so a rewritten image is still drift", () => {
  const image = (data) => ({ type: "image", source: { type: "base64", media_type: "image/png", data } });
  const payload = "A".repeat(100_000);
  const withImage = (data) => turn(user([image(data), text("Look.")]), assistant([text("Seen.")]), user([text("And?")]));
  const tracker = createPrefixDriftTracker();
  observe(tracker, turn(user([image(payload), text("Look.")])));
  assert.equal(observe(tracker, withImage(payload)).status, "stable");
  const again = createPrefixDriftTracker();
  observe(again, turn(user([image(payload), text("Look.")])));
  const resized = withImage(payload);
  const outbound = withImage(payload.slice(0, 50_000));
  assert.deepEqual(pick(observe(again, resized, outbound)), { status: "drift", origin: "airkit", field: "messages", index: 0, inboundIndex: null });
});

test("compaction or a rewind that shrinks the history resets the thread", () => {
  const tracker = createPrefixDriftTracker();
  observe(tracker, second);
  assert.deepEqual(observe(tracker, first), { status: "reset", reason: "messages_shrunk", messages: 1, tools: 2 });
  assert.equal(observe(tracker, second).status, "stable");
});

test("an outbound model change resets instead of reporting drift", () => {
  const tracker = createPrefixDriftTracker();
  observe(tracker, first);
  const verdict = observe(tracker, second, { ...second, model: "messages/claude-opus-5-5", system: [text("Other.")] });
  assert.deepEqual(verdict, { status: "reset", reason: "model_changed", messages: 3, tools: 2 });
});

test("deferred tool activation is a named allowance, other tool changes are drift", () => {
  const activate = (tools) => tools.map((tool) => tool.name === "WebFetch" ? { ...tool, defer_loading: false } : tool);
  const flip = createPrefixDriftTracker();
  observe(flip, first);
  assert.deepEqual(observe(flip, second, { ...second, tools: activate(second.tools) }), {
    status: "allowed", reason: "deferred_tool_activation", origin: "airkit", field: "tools", index: 1,
    inboundIndex: null, messages: 3, tools: 2,
  });

  // The compatibility executor lists a deferred tool only once it is loaded.
  const executor = (body, tools) => ({ ...body, tools });
  const insert = createPrefixDriftTracker();
  observe(insert, first, executor(first, [first.tools[0]]));
  const inserted = observe(insert, second, executor(second, [second.tools[0], { name: "WebFetch" }]));
  assert.equal(inserted.status, "allowed");

  // A tool that was never deferred appearing is not an activation.
  const added = createPrefixDriftTracker();
  observe(added, first);
  const verdict = observe(added, second, { ...second, tools: [...second.tools, { name: "Extra" }] });
  assert.deepEqual([verdict.status, verdict.origin, verdict.field, verdict.index], ["drift", "airkit", "tools", 2]);

  // Nor is a removal or a reorder riding along with an activation.
  const reordered = createPrefixDriftTracker();
  observe(reordered, first);
  const swapped = activate(second.tools).reverse();
  assert.equal(observe(reordered, second, { ...second, tools: swapped }).status, "drift");
});

test("threads are keyed by session, request class and first message", () => {
  const tracker = createPrefixDriftTracker();
  const subagent = turn(user([text("Subagent task.")]));
  observe(tracker, first);
  assert.equal(observe(tracker, subagent).status, "baseline");
  assert.equal(observe(tracker, second).status, "stable");
  assert.equal(observe(tracker, second, second, headers("00000000-0000-4000-8000-000000000002")).status, "baseline");
  assert.equal(observe(tracker, second, second, headers(SESSION, { "x-claude-code-request-class": "compaction" })).status, "baseline");
  // Without a header, metadata.user_id carries the session id.
  const withMetadata = (body) => ({ ...body, metadata: { user_id: JSON.stringify({ session_id: "session-from-metadata" }) } });
  assert.equal(observe(tracker, withMetadata(first), withMetadata(first), {}).status, "baseline");
  assert.equal(observe(tracker, withMetadata(second), withMetadata(second), {}).status, "stable");
});

test("memory is bounded by least-recent eviction and a TTL", () => {
  let clock = 0;
  const tracker = createPrefixDriftTracker({ maxThreads: 2, ttlMs: 1_000, now: () => clock });
  const session = (n) => headers(`00000000-0000-4000-8000-00000000000${n}`);
  observe(tracker, first, first, session(1));
  observe(tracker, first, first, session(2));
  observe(tracker, second, second, session(1));
  observe(tracker, first, first, session(3));
  assert.equal(tracker.size, 2);
  assert.equal(observe(tracker, second, second, session(2)).status, "baseline", "least recent thread was evicted");
  assert.equal(observe(tracker, second, second, session(3)).status, "stable");
  clock = 5_000;
  assert.equal(observe(tracker, second, second, session(3)).status, "baseline", "expired thread starts over");
  assert.equal(tracker.size, 1, "expired threads are dropped");
});

test("malformed or untrackable requests give no verdict and never throw", () => {
  const tracker = createPrefixDriftTracker();
  const cases = [
    [first, null],
    [first, undefined],
    ["{not json", first],
    [first, Buffer.from("{not json")],
    [null, first],
    [[], first],
    [{ ...first, messages: [] }, first],
    [{ ...first, messages: "nope" }, first],
    [first, { ...first, messages: null }],
    [first, { ...first, system: 42 }],
    [first, { ...first, tools: "nope" }],
  ];
  // Called directly: the helper would default a missing outbound to inbound.
  const raw = (inbound, outbound) => tracker.observe({ headers: headers(), inbound, outbound });
  for (const [inbound, outbound] of cases) assert.doesNotThrow(() => raw(inbound, outbound));
  for (const [inbound, outbound] of cases.slice(0, 10)) assert.equal(raw(inbound, outbound), null);
  assert.equal(observe(tracker, first, first, {}), null, "no session id");
  assert.equal(observe(tracker, first, first, headers("not a valid id!")), null);
  const classifier = { ...first, system: [text("You are a security monitor for autonomous AI coding agents. ...")] };
  assert.equal(observe(tracker, classifier), null, "auto-mode classifier requests are not a thread");
});

test("verdicts carry fields, indices and counts only, never content", () => {
  const tracker = createPrefixDriftTracker();
  observe(tracker, first);
  const secret = "PROMPT-CONTENT-MARKER";
  const verdict = observe(tracker, second, { ...second, system: [text(secret)] });
  assert.equal(JSON.stringify(verdict).includes(secret), false);
  assert.deepEqual(Object.keys(verdict).sort(),
    ["field", "inboundIndex", "index", "messages", "origin", "reason", "status", "tools"]);
});
