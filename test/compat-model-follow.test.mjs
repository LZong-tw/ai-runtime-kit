import assert from "node:assert/strict";
import { test } from "node:test";

import { COMPLETE_PLUGIN_CONFIG, createPluginHandlers } from "./helpers/compat-fixtures.mjs";
import {
  createMainModelTracker,
  requestClass,
  requestSessionId,
} from "../src/compat/model-follow.mjs";

// The shape a /model pick of gpt-6-sol arrives in from Claude Code: CCR's
// opaque route id, provider-qualified with `anthropic/`.
const SOL_PICK = "anthropic/claude-ccr-h6169726b69742d70726f76696465722d6f6e65706f7274616c2d6c6f77636f73742d6f6e65706f7274616c2d726573706f6e7365732f6770742d362d736f6c";
const FOLLOW = Object.freeze({ enabled: true, lanes: ["sonnet"], roles: ["subagent"] });

// `null` leaves a header out.
function hint(requestClassValue, session = "session-a") {
  return {
    ...(requestClassValue === null ? {} : { "x-claude-code-request-class": requestClassValue }),
    ...(session === null ? {} : { "x-claude-code-session-id": session }),
  };
}

// `followMainModel: null` leaves the key out of the plugin config.
async function followFixture({ followMainModel = FOLLOW, routes = true, extra = {} } = {}) {
  const forwarded = [];
  const pluginConfig = {
    ...structuredClone(COMPLETE_PLUGIN_CONFIG),
    launchModel: "claude-airkit-mode",
    ...(routes
      ? {
        routes: {
          default: "demo-provider/steady-coder",
          background: "demo-provider/cheap-coder",
          sonnet: "demo-provider/flash-coder",
          opus: "demo-provider/kimi-coder",
        },
      }
      : {}),
    ...(followMainModel === null ? {} : { followMainModel }),
    ...extra,
  };
  const handlers = await createPluginHandlers({
    coreClient: {
      async forwardRaw({ body }) {
        forwarded.push(Buffer.from(body));
      },
    },
    pluginConfig,
  });
  const handler = handlers.messages.handler;
  return async (model, headers = {}, fields = {}) => {
    const raw = Buffer.from(JSON.stringify({ model, max_tokens: 8, messages: [], ...fields }), "utf8");
    await handler({ headers, method: "POST", signal: undefined }, {}, { readBody: async () => raw });
    const out = forwarded.at(-1);
    return { raw, out, body: JSON.parse(out.toString()), model: JSON.parse(out.toString()).model };
  };
}

test("a subagent's Sonnet request follows the main thread's /model pick", async () => {
  const send = await followFixture();

  assert.equal((await send(SOL_PICK, hint("main"))).model, SOL_PICK, "the main pick itself passes untouched");
  for (const model of ["claude-sonnet-5-5", "claude-sonnet-5"]) {
    const result = await send(model, hint("subagent"), { stream: true });
    assert.equal(result.model, SOL_PICK, model);
    assert.deepEqual(result.body, { ...JSON.parse(result.raw.toString()), model: SOL_PICK }, "only the model changes");
  }
});

test("before any main pick, subagents keep the mode's lanes", async () => {
  const send = await followFixture();

  assert.equal((await send("claude-sonnet-5-5", hint("subagent"))).model, "demo-provider/flash-coder");
  assert.equal((await send("claude-airkit-mode", hint("main"))).model, "demo-provider/steady-coder");
  assert.equal((await send("claude-sonnet-5-5", hint("subagent"))).model, "demo-provider/flash-coder");
});

test("traffic that is not a listed subagent role keeps the mode's lanes", async () => {
  const send = await followFixture();
  await send(SOL_PICK, hint("main"));

  assert.equal((await send("claude-haiku-4-5-20251001", hint("subagent"))).model, "demo-provider/cheap-coder");
  for (const cls of ["auxiliary", "compaction", "side_reply", "workflow", "unknown-class", null]) {
    assert.equal(
      (await send("claude-sonnet-5", hint(cls))).model,
      "demo-provider/flash-coder",
      `request class ${cls}`,
    );
  }
});

test("the auto-mode classifier never follows, even when tagged as a subagent", async () => {
  const send = await followFixture();
  await send(SOL_PICK, hint("main"));

  const classifier = {
    system: [{ type: "text", text: "You are a security monitor for autonomous AI coding agents. Decide." }],
  };
  assert.equal((await send("claude-sonnet-5", hint("auxiliary"), classifier)).model, "demo-provider/flash-coder");
  assert.equal((await send("claude-sonnet-5", hint("subagent"), classifier)).model, "demo-provider/flash-coder");
});

test("picks stay inside their session, and a request without a session id never follows", async () => {
  const send = await followFixture();
  await send(SOL_PICK, hint("main", "session-a"));

  assert.equal((await send("claude-sonnet-5", hint("subagent", "session-b"))).model, "demo-provider/flash-coder");
  assert.equal((await send("claude-sonnet-5", hint("subagent", null))).model, "demo-provider/flash-coder");
  assert.equal((await send("claude-sonnet-5", hint("subagent", "session-a"))).model, SOL_PICK);

  // Session-less clients share nothing: a main pick without an id is not stored.
  await send(SOL_PICK, hint("main", null));
  assert.equal((await send("claude-sonnet-5", hint("subagent", null))).model, "demo-provider/flash-coder");
});

test("the session id falls back to the body's metadata.user_id", async () => {
  const send = await followFixture();
  const metadata = { metadata: { user_id: JSON.stringify({ device_id: "d", session_id: "meta-session" }) } };

  await send(SOL_PICK, hint("main", null), metadata);
  assert.equal((await send("claude-sonnet-5", hint("subagent", null), metadata)).model, SOL_PICK);
  assert.equal(
    (await send("claude-sonnet-5", hint("subagent", null), { metadata: { user_id: "not json" } })).model,
    "demo-provider/flash-coder",
  );
});

test("a main thread on the launch id or a Claude family pick is not a pick, and clears an earlier one", async () => {
  const send = await followFixture();

  await send(SOL_PICK, hint("main"));
  await send("claude-opus-5", hint("main"));
  assert.equal((await send("claude-sonnet-5", hint("subagent"))).model, "demo-provider/flash-coder");

  await send(SOL_PICK, hint("main"));
  await send("claude-airkit-mode", hint("main"));
  assert.equal((await send("claude-sonnet-5", hint("subagent"))).model, "demo-provider/flash-coder");
});

test("opus subagents and workflow agents follow only when the profile lists them", async () => {
  const narrow = await followFixture();
  await narrow(SOL_PICK, hint("main"));
  assert.equal((await narrow("claude-opus-5", hint("subagent"))).model, "demo-provider/kimi-coder");
  assert.equal((await narrow("claude-sonnet-5", hint("workflow"))).model, "demo-provider/flash-coder");

  const wide = await followFixture({
    followMainModel: { enabled: true, lanes: ["sonnet", "opus"], roles: ["subagent", "workflow"] },
  });
  await wide(SOL_PICK, hint("main"));
  assert.equal((await wide("claude-opus-5", hint("subagent"))).model, SOL_PICK);
  assert.equal((await wide("claude-sonnet-5", hint("workflow"))).model, SOL_PICK);
  assert.equal((await wide("claude-haiku-4-5-20251001", hint("workflow"))).model, "demo-provider/cheap-coder");
});

test("a followed airkit alias gets the same mode routing as the main thread", async () => {
  const send = await followFixture({
    extra: { modeRoutes: { glm: { default: "demo-provider/glm-coder" } } },
  });

  assert.equal((await send("airkit/glm", hint("main"))).model, "demo-provider/glm-coder");
  assert.equal((await send("claude-sonnet-5", hint("subagent"))).model, "demo-provider/glm-coder");
});

test("without followMainModel enabled, subagent bytes are forwarded exactly as before", async () => {
  for (const followMainModel of [null, { enabled: false }]) {
    const send = await followFixture({ followMainModel, routes: false });
    await send(SOL_PICK, hint("main"));
    const result = await send("claude-sonnet-5", hint("subagent"));
    assert.deepEqual(result.out, result.raw, JSON.stringify(followMainModel));

    const routed = await followFixture({ followMainModel });
    await routed(SOL_PICK, hint("main"));
    assert.equal((await routed("claude-sonnet-5", hint("subagent"))).model, "demo-provider/flash-coder");
  }
});

test("requestClass reads only Claude Code's known classes", () => {
  assert.equal(requestClass({ "x-claude-code-request-class": "main" }), "main");
  assert.equal(requestClass({ "X-Claude-Code-Request-Class": "subagent" }), "subagent");
  assert.equal(requestClass({ "x-claude-code-request-class": ["workflow"] }), "workflow");
  assert.equal(requestClass({ "x-claude-code-request-class": "teammate" }), null);
  assert.equal(requestClass({ "x-claude-code-agent-id": "a1" }), null, "agent id alone is not a class");
  assert.equal(requestClass(undefined), null);
});

test("requestSessionId prefers the header and rejects malformed ids", () => {
  const body = { metadata: { user_id: JSON.stringify({ session_id: "from-body" }) } };
  assert.equal(requestSessionId({ "X-Claude-Code-Session-Id": "from-header" }, body), "from-header");
  assert.equal(requestSessionId({}, body), "from-body");
  assert.equal(requestSessionId({ "x-claude-code-session-id": "bad id with spaces" }, {}), null);
  assert.equal(requestSessionId({}, { metadata: { user_id: JSON.stringify({ session_id: 7 }) } }), null);
  assert.equal(requestSessionId({}, null), null);
});

test("the tracker forgets idle sessions and keeps only the most recent ones", () => {
  let clock = 0;
  const tracker = createMainModelTracker({ maxSessions: 2, ttlMs: 1_000, now: () => clock });

  tracker.observe("a", "pick-a");
  tracker.observe("b", "pick-b");
  assert.equal(tracker.pick("a"), "pick-a");
  tracker.observe("c", "pick-c");
  assert.equal(tracker.pick("b"), null, "least recently used session is evicted");
  assert.equal(tracker.pick("a"), "pick-a");
  assert.equal(tracker.pick("c"), "pick-c");

  clock = 1_001;
  assert.equal(tracker.pick("a"), null, "an idle pick expires");
  tracker.observe("c", null);
  assert.equal(tracker.pick("c"), null, "observing a non-pick clears the session");
});
