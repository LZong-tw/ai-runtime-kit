import assert from "node:assert/strict";
import { test } from "node:test";

import { handleCompatibilityMessage } from "../src/compat/gateway.mjs";
import {
  resolveCompatibilityPolicies,
  validateCompatibilityConfig,
  validateCompatibilityProviderBinding,
} from "../src/compat/config.mjs";
import {
  ADVISOR_BLOCKED_TEXT,
  ADVISOR_CONFIG_KEYS,
  DEFAULT_ADVISOR_GATE,
  NON_CLAUDE_ADVISOR_PROMPT,
  isAdvisorAllowed,
} from "../src/compat/advisor-policy.mjs";

const CONFIG = {
  fallback: { provider: "anthropic", model: "claude-sonnet", maxContinuationTurns: 8 },
  advisor: { mode: "bridge" },
  toolSearch: { mode: "bridge" },
  webSearch: { mode: "native-first" },
  webFetch: { mode: "native-first" },
  codeExecution: { mode: "anthropic-fallback" },
  mcpConnector: { mode: "anthropic-fallback" },
};

function advisorCall(id = "toolu_advisor") {
  return { type: "tool_use", name: "airkit_advisor", id, input: {} };
}

function priorAdvisor(index) {
  const id = `srvtoolu_${index}`;
  return [
    { role: "assistant", content: [{ type: "server_tool_use", name: "advisor", id, input: {} }] },
    { role: "assistant", content: [{
      type: "advisor_tool_result", tool_use_id: id, content: { type: "advisor_result", text: "Prior advice" },
    }] },
  ];
}

function toolHistory(count = 20, errors = 2) {
  return Array.from({ length: count }, (_, i) => [
    { role: "assistant", content: [{ type: "tool_use", id: `toolu_${i}`, name: "Bash", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: `toolu_${i}`, is_error: i < errors, content: "output" }] },
  ]).flat();
}

async function runBridge(t, {
  model = "executor/gpt-test",
  requested,
  messages = [{ role: "user", content: "Fix the problem" }],
  advisor = {},
  turns = [[advisorCall()]],
  maxUses = 10,
  unavailable = false,
} = {}) {
  const calls = [];
  const logs = [];
  const mock = t.mock.method(process.stderr, "write", (line) => { logs.push(line); return true; });
  let turn = 0;
  const result = await handleCompatibilityMessage({
    body: {
      model,
      max_tokens: 512,
      messages,
      tools: [{ type: "advisor_20260301", name: "advisor", max_uses: maxUses,
        ...(requested === undefined ? {} : { model: requested }) }],
    },
    headers: {},
    config: { ...CONFIG, advisor: { ...CONFIG.advisor, ...advisor } },
    coreClient: {
      async requestMessage(body) {
        calls.push(structuredClone(body));
        const isAdvisor = body.tools === undefined;
        if (isAdvisor && unavailable) throw new Error("private upstream failure");
        const content = isAdvisor ? [{ type: "text", text: "Independent advice" }]
          : turns[turn++] ?? [{ type: "text", text: "Done" }];
        return {
          id: `msg_${calls.length}`, type: "message", role: "assistant", model: body.model,
          content: structuredClone(content), stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        };
      },
    },
  });
  mock.mock.restore();
  const advisorRequests = calls.filter((body) => body.tools === undefined);
  const diagnostics = logs.map((line) => {
    assert.match(line, /^\[airkit-advisor\] \{[^\n]*\}\n$/);
    return JSON.parse(line.slice("[airkit-advisor] ".length));
  });
  assert.equal(diagnostics.length, turns.flat().filter((block) => block.name === "airkit_advisor").length);
  return { result, calls, advisorRequests, diagnostics };
}

test("Advisor aliases and full Claude IDs select a frozen mapped provider/model", async (t) => {
  const advisor = { models: { Fable: "review/claude-opus-5-5", opus: "review/claude-opus-5" } };
  const resolved = resolveCompatibilityPolicies({ ...CONFIG, advisor: { ...CONFIG.advisor, ...advisor } });
  assert.deepEqual(resolved.advisorModels.fable, { provider: "review", model: "claude-opus-5-5" });
  assert.ok(Object.isFrozen(resolved.advisorModels));
  assert.ok(Object.isFrozen(resolved.advisorModels.fable));
  assert.equal(Object.isFrozen(advisor.models), false);
  for (const [requested, expected] of [
    ["FABLE", "review/claude-opus-5-5"],
    ["CLAUDE-OPUS-5-5", "review/claude-opus-5"],
  ]) {
    const { advisorRequests, diagnostics } = await runBridge(t, {
      advisor, requested, messages: [{ role: "user", content: "Ask Advisor" }],
    });
    assert.equal(advisorRequests[0].model, expected);
    assert.deepEqual(diagnostics, [{
      requested, provider: "review", model: expected.split("/")[1], outcome: "called",
    }]);
  }
});

test("unmapped Advisor alias selects family fallback before shared fallback", async (t) => {
  const { advisorRequests } = await runBridge(t, {
    model: "claude-sonnet", requested: "unknown",
    advisor: { models: { opus: "review/claude-opus" }, fallback: { provider: "family", model: "claude-haiku" } },
  });
  assert.equal(advisorRequests[0].model, "family/claude-haiku");
  const shared = await runBridge(t, { model: "claude-sonnet", requested: "unknown" });
  assert.equal(shared.advisorRequests[0].model, "anthropic/claude-sonnet");
});

test("non-Claude executor without a trigger gets normal blocked results and keeps the tool", async (t) => {
  const { result, calls, advisorRequests, diagnostics } = await runBridge(t);
  assert.equal(advisorRequests.length, 0);
  assert.deepEqual(result.content.map((block) => block.type), ["server_tool_use", "advisor_tool_result", "text"]);
  assert.equal(result.content[1].content.type, "advisor_result");
  assert.equal(result.content[1].content.text, ADVISOR_BLOCKED_TEXT);
  assert.equal(calls[1].messages.at(-1).content[0].content, ADVISOR_BLOCKED_TEXT);
  assert.ok(calls.every((body) => body.tools.some((tool) => tool.name === "airkit_advisor")));
  assert.ok(calls[0].tools.find((tool) => tool.name === "airkit_advisor").description.includes(NON_CLAUDE_ADVISOR_PROMPT));
  assert.deepEqual(diagnostics, [{ requested: null, provider: "anthropic", model: "claude-sonnet", outcome: "blocked" }]);
});

test("latest real user asking 顧問 allows Advisor even after tool-only user messages", async (t) => {
  const { advisorRequests } = await runBridge(t, {
    messages: [{ role: "user", content: [{ type: "text", text: "請顧問幫忙" }] }, ...toolHistory(1, 0)],
  });
  assert.equal(advisorRequests.length, 1);
});

test("two failed results and twenty tool calls allow Advisor, but either alone does not", async (t) => {
  for (const [count, errors, allowed] of [[20, 2, true], [19, 2, false], [20, 1, false]]) {
    const { advisorRequests } = await runBridge(t, { messages: toolHistory(count, errors) });
    assert.equal(advisorRequests.length, allowed ? 1 : 0);
  }
});

test("assistant approach changes allow Advisor only with enough tool calls", async (t) => {
  for (const phrase of ["A DIFFERENT APPROACH", "Switching approach", "Try another approach", "New approach", "換個方法", "換方法"]) {
    const { advisorRequests } = await runBridge(t, {
      messages: toolHistory(20, 0),
      turns: [[{ type: "text", text: phrase }, advisorCall()]],
    });
    assert.equal(advisorRequests.length, 1);
    assert.equal(isAdvisorAllowed({ model: "gpt", messages: [
      ...toolHistory(19, 0), { role: "assistant", content: phrase },
    ] }), false);
  }
});

test("three prior Advisor calls block even an explicit user request", async (t) => {
  const { advisorRequests, diagnostics } = await runBridge(t, {
    messages: [...[1, 2, 3].flatMap(priorAdvisor), { role: "user", content: "Ask Advisor" }],
  });
  assert.equal(advisorRequests.length, 0);
  assert.equal(diagnostics[0].outcome, "blocked");
  const belowCap = await runBridge(t, {
    messages: [...[1, 2].flatMap(priorAdvisor), { role: "user", content: "Ask Advisor" }],
  });
  assert.equal(belowCap.advisorRequests.length, 1, "use/result pairs count once");
});

test("conversation cap counts airkit_advisor history and calls within one request", async (t) => {
  const { advisorRequests, diagnostics } = await runBridge(t, {
    messages: [
      { role: "assistant", content: [advisorCall("prior_1"), advisorCall("prior_2")] },
      { role: "user", content: "Advisor please" },
    ],
    turns: [[advisorCall("new_1"), advisorCall("new_2")]],
  });
  assert.equal(advisorRequests.length, 1);
  assert.deepEqual(diagnostics.map(({ outcome }) => outcome), ["called", "blocked"]);
});

test("gate window resets at the previous Advisor and ignores tool-result text triggers", async (t) => {
  const { advisorRequests } = await runBridge(t, {
    messages: [
      { role: "user", content: "Ask Advisor" },
      ...toolHistory(), ...priorAdvisor(1),
      { role: "user", content: "Now fix the problem" },
      { role: "assistant", content: [{ type: "tool_use", id: "last", name: "Bash", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "last", content: "Advisor 顧問" }] },
    ],
  });
  assert.equal(advisorRequests.length, 0);
});

test("Claude executors are never gated, including past the conversation cap", async (t) => {
  for (const model of ["claude-sonnet", "provider/CLAUDE-opus", "provider/custom-claude-model"]) {
    const { advisorRequests, calls } = await runBridge(t, {
      model, messages: [1, 2, 3].flatMap(priorAdvisor),
    });
    assert.equal(advisorRequests.length, 1);
    assert.ok(!calls[0].tools[0].description.includes(NON_CLAUDE_ADVISOR_PROMPT));
  }
  const { advisorRequests } = await runBridge(t, { model: "claude-provider/gpt-test" });
  assert.equal(advisorRequests.length, 0, "provider name must not bypass gating");
});

test("disabled gate bypasses triggers and conversation cap", async (t) => {
  const { advisorRequests } = await runBridge(t, {
    advisor: { gate: { enabled: false, maxCallsPerConversation: 0 } },
  });
  assert.equal(advisorRequests.length, 1);
});

test("per-request max_uses remains enforced and unavailable calls log once", async (t) => {
  const limited = await runBridge(t, {
    model: "claude-opus", maxUses: 1, turns: [[advisorCall("one")], [advisorCall("two")]],
  });
  assert.equal(limited.advisorRequests.length, 1);
  assert.deepEqual(limited.diagnostics.map(({ outcome }) => outcome), ["called", "max_uses"]);
  assert.equal(limited.result.content[3].content.error_code, "max_uses_exceeded");
  const failed = await runBridge(t, { model: "claude-opus", unavailable: true });
  assert.equal(failed.result.content[1].content.error_code, "unavailable");
  assert.equal(failed.diagnostics[0].outcome, "unavailable");
});

test("Advisor config validates models, gate values, and unknown gate keys", () => {
  assert.deepEqual(ADVISOR_CONFIG_KEYS, ["models", "gate"]);
  assert.deepEqual(DEFAULT_ADVISOR_GATE, { failedToolResults: 2, minToolCalls: 20, maxCallsPerConversation: 3, enabled: true });
  const validate = (advisor) => validateCompatibilityConfig({ ...CONFIG, advisor: { mode: "bridge", ...advisor } });
  for (const models of [null, [], "opus", { "bad alias": "review/claude-opus" },
    { opus: 1 }, { opus: "claude-opus" }, { opus: "bad provider/claude-opus" },
    { opus: "review/gpt-test" }, { opus: "review/anthropic/claude-opus" },
    { fable: "review/azure_ai/gpt-test" }, { fable: "review/a/b/claude-fable" }]) {
    assert.throws(() => validate({ models }), /advisor.models/);
  }
  assert.doesNotThrow(() => validate({ models: { fable: "review/azure_ai/claude-fable-5-1" } }));
  for (const gate of [null, [], "on", { unknown: 1 }, { enabled: 1 },
    { failedToolResults: -1 }, { minToolCalls: 1.5 }, { maxCallsPerConversation: "3" }]) {
    assert.throws(() => validate({ gate }), /advisor.gate/);
  }
  assert.doesNotThrow(() => validate({ gate: { failedToolResults: 0, minToolCalls: 0, maxCallsPerConversation: 0, enabled: false } }));
  assert.doesNotThrow(() => validate({ models: { "Opus-5.5": "review/claude-opus-5-5" } }));
});

test("mapped Advisor routes must bind to Anthropic providers exposing the model", () => {
  const config = { ...CONFIG, advisor: { mode: "bridge", models: { opus: "review/claude-opus" } } };
  const providers = [{ name: "anthropic", type: "anthropic_messages", models: ["claude-sonnet"] }];
  assert.throws(() => validateCompatibilityProviderBinding(config, providers), /advisor.models.opus provider/);
  assert.doesNotThrow(() => validateCompatibilityProviderBinding(config, [
    ...providers, { name: "review", type: "anthropic_messages", models: ["claude-opus"] },
  ]));
});

function blockedAdvisor(index) {
  const id = `srvtoolu_blocked_${index}`;
  return [
    { role: "assistant", content: [{ type: "server_tool_use", id, name: "advisor", input: {} }] },
    { role: "user", content: [{ type: "advisor_tool_result", tool_use_id: id,
      content: { type: "advisor_result", text: ADVISOR_BLOCKED_TEXT } }] },
  ];
}

test("blocked or failed Advisor attempts do not consume the conversation cap", async (t) => {
  const failed = (index) => [
    { role: "assistant", content: [{ type: "server_tool_use", id: `srv_err_${index}`, name: "advisor", input: {} }] },
    { role: "user", content: [{ type: "advisor_tool_result", tool_use_id: `srv_err_${index}`,
      content: { type: "advisor_tool_result_error", error_code: "unavailable" } }] },
  ];
  const { advisorRequests } = await runBridge(t, {
    messages: [...[1, 2, 3].flatMap(blockedAdvisor), ...failed(4), { role: "user", content: "Ask Advisor" }],
  });
  assert.equal(advisorRequests.length, 1);
});

test("blocked Advisor attempts do not reset the stuck window", () => {
  assert.equal(isAdvisorAllowed({ model: "gpt", messages: [
    ...toolHistory(20, 2), ...blockedAdvisor(1),
  ] }), true);
});

test("blocked calls within one request do not count toward the cap", async (t) => {
  const { advisorRequests, diagnostics } = await runBridge(t, {
    advisor: { gate: { maxCallsPerConversation: 1 } },
    turns: [[advisorCall("a")], [{ type: "text", text: "Advisor please" }]],
    messages: [{ role: "user", content: "fix it" }],
  });
  assert.equal(advisorRequests.length, 0);
  assert.deepEqual(diagnostics.map(({ outcome }) => outcome), ["blocked"]);
  assert.equal(isAdvisorAllowed({ model: "gpt", gate: { maxCallsPerConversation: 1 }, messages: [
    { role: "user", content: "Ask advisor" }, ...blockedAdvisor(1),
  ] }), true);
});

test("system reminders in user messages do not count as asking for Advisor", () => {
  assert.equal(isAdvisorAllowed({ model: "gpt", messages: [
    { role: "user", content: "fix the build" },
    { role: "assistant", content: [{ type: "tool_use", id: "t", name: "Bash", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "ok" },
      { type: "text", text: "<system-reminder>You have an advisor tool.</system-reminder>" }] },
  ] }), false);
});

test("comma-routed selectors classify by model, not provider", () => {
  const history = [1, 2, 3].flatMap((index) => [
    { role: "assistant", content: [{ type: "server_tool_use", id: `s${index}`, name: "advisor", input: {} }] },
    { role: "user", content: [{ type: "advisor_tool_result", tool_use_id: `s${index}`,
      content: { type: "advisor_result", text: "advice" } }] },
  ]);
  assert.equal(isAdvisorAllowed({ model: "claude-proxy,gpt-5.6-sol", messages: history }), false);
  assert.equal(isAdvisorAllowed({ model: "web_litellm_anthropic,claude-sonnet-5-5", messages: history }), true);
});
