import assert from "node:assert/strict";
import { test } from "node:test";

import { isAdvisorAllowed, isClaudeExecutor } from "../src/compat/advisor-policy.mjs";
import { resolveModelPrompt, resolveToolSearchMaxTools } from "../src/compat/config.mjs";

// A /model pick of a non-Claude route reaches the plugin as CCR's opaque id. Its
// `claude-` prefix is packaging, not the executor: every model-keyed decision
// must look at the route it encodes.
const encode = (route) => `anthropic/claude-ccr-h${Buffer.from(route).toString("hex")}`;
const SOL = encode("airkit-provider-oneportal-lowcost-oneportal-responses/gpt-6.1-sol");
const CLAUDE_ROUTE = encode("web_litellm_anthropic/claude-sonnet-5-5");

test("a CCR route id is classified by the model it encodes", () => {
  assert.equal(isClaudeExecutor(SOL), false);
  assert.equal(isClaudeExecutor(`${SOL}[1m]`), false);
  assert.equal(isClaudeExecutor(CLAUDE_ROUTE), true);
  assert.equal(isClaudeExecutor("anthropic/claude-ccr-hzz"), true);
});

test("Advisor gating applies to a non-Claude CCR route id", () => {
  assert.equal(isAdvisorAllowed({ model: SOL, messages: [] }), false);
  assert.equal(isAdvisorAllowed({ model: CLAUDE_ROUTE, messages: [] }), true);
});

test("model prompts and tool budgets resolve through a CCR route id", () => {
  const config = {
    modelPrompts: [{ match: "^gpt-", prompt: "gpt rules" }],
    toolSearch: { maxToolsByModel: { "gpt-6*": 40 } },
  };
  assert.equal(resolveModelPrompt(config, SOL), "gpt rules");
  assert.equal(resolveModelPrompt(config, CLAUDE_ROUTE), null);
  assert.equal(resolveToolSearchMaxTools(config, SOL), 40);
  assert.equal(resolveToolSearchMaxTools(config, CLAUDE_ROUTE), null);
});
