import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildContextObservability,
  summarizeCompletionUsage,
} from "../src/context-observability.mjs";

test("total-only OpenAI usage remains non-zero without inventing cache detail", () => {
  assert.deepEqual(
    summarizeCompletionUsage({
      prompt_tokens: 120,
      completion_tokens: 5,
      total_tokens: 125,
    }),
    {
      inputTokens: 120,
      outputTokens: 5,
      totalTokens: 125,
      cacheDetails: "unavailable",
      cacheReadInputTokens: null,
      cacheCreationInputTokens: null,
      cacheMissInputTokens: null,
      cacheHitRate: null,
    },
  );
});

test("OpenAI cached prompt detail is reported without double-counting input", () => {
  assert.deepEqual(
    summarizeCompletionUsage({
      prompt_tokens: 120,
      completion_tokens: 5,
      total_tokens: 125,
      prompt_tokens_details: { cached_tokens: 80 },
    }),
    {
      inputTokens: 120,
      outputTokens: 5,
      totalTokens: 125,
      cacheDetails: "available",
      cacheReadInputTokens: 80,
      cacheCreationInputTokens: null,
      cacheMissInputTokens: null,
      cacheHitRate: 80 / 120,
    },
  );
});

test("OpenAI Responses input cache detail is recognized", () => {
  assert.deepEqual(
    summarizeCompletionUsage({
      input_tokens: 200,
      output_tokens: 5,
      input_tokens_details: { cached_tokens: 80 },
    }),
    {
      inputTokens: 200,
      outputTokens: 5,
      totalTokens: 205,
      cacheDetails: "available",
      cacheReadInputTokens: 80,
      cacheCreationInputTokens: null,
      cacheMissInputTokens: null,
      cacheHitRate: 80 / 200,
    },
  );
});

test("DeepSeek cache hit and miss usage exposes a truthful hit rate", () => {
  assert.deepEqual(
    summarizeCompletionUsage({
      prompt_tokens: 120,
      completion_tokens: 5,
      total_tokens: 125,
      prompt_cache_hit_tokens: 80,
      prompt_cache_miss_tokens: 40,
    }),
    {
      inputTokens: 120,
      outputTokens: 5,
      totalTokens: 125,
      cacheDetails: "available",
      cacheReadInputTokens: 80,
      cacheCreationInputTokens: null,
      cacheMissInputTokens: 40,
      cacheHitRate: 80 / 120,
    },
  );
});

test("generic cache read/write/miss aliases remain observable", () => {
  assert.deepEqual(
    summarizeCompletionUsage({
      prompt_tokens: 120,
      completion_tokens: 5,
      cache_read_tokens: 80,
      cache_write_tokens: 10,
      cache_miss_tokens: 40,
    }),
    {
      inputTokens: 120,
      outputTokens: 5,
      totalTokens: 125,
      cacheDetails: "available",
      cacheReadInputTokens: 80,
      cacheCreationInputTokens: 10,
      cacheMissInputTokens: 40,
      cacheHitRate: 80 / 120,
    },
  );
});

test("Gemini usageMetadata cache counters remain truthful", () => {
  assert.deepEqual(
    summarizeCompletionUsage({
      usageMetadata: {
        promptTokenCount: 120,
        cachedContentTokenCount: 80,
        candidatesTokenCount: 5,
        totalTokenCount: 125,
      },
    }),
    {
      inputTokens: 120,
      outputTokens: 5,
      totalTokens: 125,
      cacheDetails: "available",
      cacheReadInputTokens: 80,
      cacheCreationInputTokens: null,
      cacheMissInputTokens: 40,
      cacheHitRate: 80 / 120,
    },
  );
});

test("Anthropic cache counters contribute to truthful total input accounting", () => {
  assert.deepEqual(
    summarizeCompletionUsage({
      input_tokens: 10,
      output_tokens: 5,
      cache_read_input_tokens: 80,
      cache_creation_input_tokens: 30,
    }),
    {
      inputTokens: 120,
      outputTokens: 5,
      totalTokens: 125,
      cacheDetails: "available",
      cacheReadInputTokens: 80,
      cacheCreationInputTokens: 30,
      cacheMissInputTokens: null,
      cacheHitRate: 80 / 120,
    },
  );
});

test("missing usage is explicitly unavailable instead of synthesizing counters", () => {
  assert.deepEqual(summarizeCompletionUsage(), {
    inputTokens: null,
    outputTokens: null,
    totalTokens: null,
    cacheDetails: "unavailable",
    cacheReadInputTokens: null,
    cacheCreationInputTokens: null,
    cacheMissInputTokens: null,
    cacheHitRate: null,
  });
});

test("context window reports its catalog source and profile compaction policy separately", () => {
  const result = buildContextObservability({
    autoCompactWindow: 180_000,
    modelCatalog: {
      providers: [{ id: "demo", models: [{ id: "coder", contextWindow: 256_000 }] }],
    },
    route: "demo,coder",
    usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 },
  });

  assert.deepEqual(result.contextWindow, {
    tokens: 256_000,
    source: "catalog:modelCatalog",
    metadataOnly: true,
  });
  assert.deepEqual(result.autoCompactWindow, {
    tokens: 180_000,
    source: "profile:launch.context.autoCompactWindow",
  });
  assert.equal(result.usage.inputTokens, 12);
});

test("model info can supply metadata but is never presented as completion-response state", () => {
  const result = buildContextObservability({
    modelCatalog: { providers: [] },
    modelInfo: { contextWindow: 200_000 },
    route: "demo,unknown",
  });

  assert.deepEqual(result.contextWindow, {
    tokens: 200_000,
    source: "claude-code:/model/info",
    metadataOnly: true,
  });
  assert.equal(result.usage.totalTokens, null);
  assert.equal(result.usage.cacheDetails, "unavailable");
});

test("context lookup does not borrow a same-named model from another provider", () => {
  const result = buildContextObservability({
    modelCatalog: {
      providers: [{ id: "provider-a", models: [{ id: "coder", contextWindow: 256_000 }] }],
    },
    route: "provider-b,coder",
  });

  assert.equal(result.contextWindow.tokens, null);
  assert.equal(result.contextWindow.source, "unavailable");
});
