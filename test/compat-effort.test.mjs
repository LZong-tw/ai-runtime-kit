import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ensureGptMinimumOutputTokens,
  rewriteClaudeEffortForOpenAI,
} from "../src/compat/effort.mjs";

test("maps Claude Code effort only for providers that accept reasoning_effort", () => {
  const cases = [
    ["oneportal/GLM-5.2", "low", "low"],
    ["oneportal/GLM-5.2", "xhigh", "xhigh"],
    ["web_litellm/Kimi-K3", "medium", "medium"],
    ["web_litellm/Kimi-K3", "max", "max"],
  ];

  for (const [model, input, expected] of cases) {
    assert.deepEqual(
      rewriteClaudeEffortForOpenAI({
        model,
        output_config: { effort: input },
        messages: [{ role: "user", content: "hi" }],
      }),
      {
        model,
        reasoning_effort: expected,
        messages: [{ role: "user", content: "hi" }],
      },
    );
  }
});

test("removes Claude effort for DeepSeek while preserving structured output", () => {
  assert.deepEqual(
    rewriteClaudeEffortForOpenAI({
      model: "oneportal/deepseek-v4-flash",
      output_config: { effort: "xhigh", format: { type: "json_schema" } },
      messages: [{ role: "user", content: "hi" }],
    }),
    {
      model: "oneportal/deepseek-v4-flash",
      output_config: { format: { type: "json_schema" } },
      messages: [{ role: "user", content: "hi" }],
    },
  );
});

test("preserves unrelated output config and does not rewrite unsupported models or levels", () => {
  assert.deepEqual(
    rewriteClaudeEffortForOpenAI({
      model: "web_litellm/Kimi-K3",
      output_config: { effort: "high", format: { type: "json_schema" } },
    }),
    {
      model: "web_litellm/Kimi-K3",
      output_config: { format: { type: "json_schema" } },
      reasoning_effort: "high",
    },
  );

  for (const body of [
    { model: "anthropic/claude-sonnet-5", output_config: { effort: "xhigh" } },
    { model: "oneportal/GLM-5.2", output_config: { effort: 3 } },
  ]) {
    assert.equal(rewriteClaudeEffortForOpenAI(body), body);
  }
});

test("raises GPT short output budgets so reasoning cannot consume the entire completion", () => {
  assert.deepEqual(
    ensureGptMinimumOutputTokens({
      model: "oneportal/gpt-5.6-terra",
      max_tokens: 64,
      messages: [{ role: "user", content: "summarize this context" }],
    }),
    {
      model: "oneportal/gpt-5.6-terra",
      max_tokens: 1024,
      messages: [{ role: "user", content: "summarize this context" }],
    },
  );

  for (const body of [
    { model: "oneportal/gpt-5.6-terra", max_tokens: 1024 },
    { model: "oneportal/deepseek-v4-flash", max_tokens: 64 },
    { model: "oneportal/gpt-5.6-terra", max_tokens: "64" },
  ]) {
    assert.equal(ensureGptMinimumOutputTokens(body), body);
  }
});
