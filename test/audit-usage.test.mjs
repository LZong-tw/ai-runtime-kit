import assert from "node:assert/strict";
import { test } from "node:test";

import {
  normalizeUsageObservation,
  normalizeMeterObservation,
  normalizeQuotaObservation,
  normalizeHeadroomObservation,
} from "../src/audit/usage.mjs";

test("missing GPT cache fields remain unavailable", () => {
  const result = normalizeUsageObservation({
    source: "provider",
    provider: "openai",
    usage: { input_tokens: 20, output_tokens: 3 },
  });
  assert.equal(result.values.cacheReadTokens, null);
  assert.equal(result.values.uncachedInputTokens, 20);
  assert.equal(result.provenance.uncachedInputTokens.kind, "reported");
});

test("OpenAI Chat usage preserves cache, reasoning, and provider totals", () => {
  const result = normalizeUsageObservation({
    source: "provider",
    provider: "openai",
    usage: {
      prompt_tokens: 120,
      completion_tokens: 7,
      total_tokens: 127,
      prompt_tokens_details: { cached_tokens: 80 },
      completion_tokens_details: { reasoning_tokens: 2 },
    },
  });
  assert.deepEqual(result.values, {
    uncachedInputTokens: 120,
    cacheReadTokens: 80,
    cacheCreate5mTokens: null,
    cacheCreate1hTokens: null,
    cacheMissTokens: null,
    reasoningTokens: 2,
    outputTokens: 7,
    providerTotalTokens: 127,
    effectiveContextTokens: 120,
    inputBytes: null,
    outputBytes: null,
  });
});

test("Anthropic separates 5m and 1h cache creation", () => {
  const result = normalizeUsageObservation({
    source: "provider",
    provider: "anthropic",
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      cache_read_input_tokens: 20,
      cache_creation: { ephemeral_5m_input_tokens: 30, ephemeral_1h_input_tokens: 40 },
    },
  });
  assert.equal(result.values.uncachedInputTokens, 10);
  assert.equal(result.values.cacheReadTokens, 20);
  assert.equal(result.values.cacheCreate5mTokens, 30);
  assert.equal(result.values.cacheCreate1hTokens, 40);
  assert.equal(result.values.effectiveContextTokens, 100);
});

test("DeepSeek hit and miss counters are reported independently", () => {
  const result = normalizeUsageObservation({
    source: "provider",
    provider: "deepseek",
    usage: { prompt_tokens: 120, completion_tokens: 5, prompt_cache_hit_tokens: 80, prompt_cache_miss_tokens: 40 },
  });
  assert.equal(result.values.cacheReadTokens, 80);
  assert.equal(result.values.cacheMissTokens, 40);
  assert.equal(result.values.uncachedInputTokens, 120);
});

test("Gemini usage metadata recognizes cached content and zero values", () => {
  const result = normalizeUsageObservation({
    source: "provider",
    provider: "gemini",
    usage: { usageMetadata: { promptTokenCount: 0, cachedContentTokenCount: 0, candidatesTokenCount: 0, totalTokenCount: 0 } },
  });
  assert.deepEqual(result.values, {
    uncachedInputTokens: 0,
    cacheReadTokens: 0,
    cacheCreate5mTokens: null,
    cacheCreate1hTokens: null,
    cacheMissTokens: 0,
    reasoningTokens: null,
    outputTokens: 0,
    providerTotalTokens: 0,
    effectiveContextTokens: 0,
    inputBytes: null,
    outputBytes: null,
  });
});

test("disagreement retains both evidence sources as a conflict", () => {
  const result = normalizeUsageObservation({
    source: "provider",
    provider: "openai",
    usage: { input_tokens: 20, prompt_tokens: 22, output_tokens: 3 },
  });
  assert.equal(result.values.uncachedInputTokens, 20);
  assert.ok(result.conflicts.some((conflict) => conflict.field === "uncachedInputTokens"));
});

test("byte observations stay byte-valued and never become request tokens", () => {
  const result = normalizeUsageObservation({
    source: "provider",
    provider: "openai",
    usage: { input_bytes: 400, output_bytes: 40 },
    responseHeaders: { "content-length": "440" },
  });
  assert.equal(result.values.uncachedInputTokens, null);
  assert.equal(result.values.outputTokens, null);
  assert.equal(result.provenance.inputBytes.kind, "reported");
  assert.equal(result.provenance.inputBytes.unit, "bytes");
});

test("cache miss stays unavailable when the exact Gemini pair is incomplete", () => {
  const result = normalizeUsageObservation({
    provider: "openai",
    usage: { usageMetadata: { promptTokenCount: 100 }, cache_read_tokens: 20 },
  });
  assert.equal(result.values.cacheMissTokens, null);
  assert.equal(result.provenance.cacheMissTokens, undefined);
});

test("numeric-string byte headers remain raw byte observations", () => {
  const result = normalizeUsageObservation({
    provider: "openai",
    usage: {},
    responseHeaders: { "X-Input-Bytes": "400", "X-Output-Bytes": "40" },
  });
  assert.equal(result.values.inputBytes, 400);
  assert.equal(result.values.outputBytes, 40);
  assert.equal(result.provenance.inputBytes.unit, "bytes");
});

test("meter, quota, and headroom observations stay outside request usage", () => {
  assert.deepEqual(normalizeMeterObservation({ provider: "x", counters: { requests: 2, tokens: 10 } }).values, { requests: 2, tokens: 10 });
  assert.deepEqual(normalizeQuotaObservation({ provider: "x", quota: { limit: 100, remaining: 25 } }).values, { limit: 100, remaining: 25 });
  assert.deepEqual(normalizeHeadroomObservation({ provider: "x", headroom: { tokens: 50, resetAt: "tomorrow" } }).values, { tokens: 50, resetAt: "tomorrow" });
});
