import { test } from "node:test";
import assert from "node:assert/strict";

import { calculateRequestCost, resolvePricingVersion } from "../src/audit/pricing.mjs";

const catalog = { modelCatalog: { pricingVersions: [{ provider: "web_litellm", model: "gpt-5.6-terra", versions: [{ version: "terra-2026-08-01", effectiveFrom: "2026-08-01T00:00:00Z", effectiveTo: "2026-09-01T00:00:00Z", billingLabel: "gpt-5.6-terra", pricesUsdPer1M: { uncachedInput: 2, cacheRead: 0.2, cacheCreate5m: 2.5, cacheCreate1h: 3, reasoning: 12, output: 12 } }] }] } };

test("resolves exact provider/model pricing by effective date", () => {
  assert.deepEqual(resolvePricingVersion({ catalog, provider: "web_litellm", model: "gpt-5.6-terra", observedAt: "2026-08-14T12:00:00Z" }), {
    provider: "web_litellm", model: "gpt-5.6-terra", version: "terra-2026-08-01", effectiveFrom: "2026-08-01T00:00:00Z", effectiveTo: "2026-09-01T00:00:00Z", billingLabel: "gpt-5.6-terra", pricesUsdPer1M: { uncachedInput: 2, cacheRead: 0.2, cacheCreate5m: 2.5, cacheCreate1h: 3, reasoning: 12, output: 12 },
  });
});

test("selects the newest effective version when catalog entries are append-only", () => {
  const appendOnlyCatalog = {
    modelCatalog: {
      pricingVersions: [{
        provider: "web_litellm",
        model: "gpt-5.6-terra",
        versions: [
          { version: "terra-2026-08-01", effectiveFrom: "2026-08-01T00:00:00Z", pricesUsdPer1M: { uncachedInput: 2 } },
          { version: "terra-2026-09-01", effectiveFrom: "2026-09-01T00:00:00Z", pricesUsdPer1M: { uncachedInput: 2.2 } },
        ],
      }],
    },
  };

  assert.equal(resolvePricingVersion({
    catalog: appendOnlyCatalog,
    provider: "web_litellm",
    model: "gpt-5.6-terra",
    observedAt: "2026-09-15T00:00:00Z",
  }).version, "terra-2026-09-01");
});

test("does not guess an unlisted provider or billing label", () => {
  assert.equal(resolvePricingVersion({ catalog, provider: "oneportal", model: "gpt-5.6-terra", observedAt: "2026-08-14T12:00:00Z" }), null);
  assert.equal(resolvePricingVersion({ catalog, provider: "web_litellm", model: "gpt-5.6-terra", billingLabel: "gpt-5.6-sol", observedAt: "2026-08-14T12:00:00Z" }), null);
});

test("calculates nullable usage components without model-name inference", () => {
  const pricing = resolvePricingVersion({ catalog, provider: "web_litellm", model: "gpt-5.6-terra", observedAt: "2026-08-14T12:00:00Z" });
  assert.deepEqual(calculateRequestCost({ usage: { uncachedInputTokens: 1_000_000, cacheReadTokens: 2_000_000, cacheCreate5mTokens: null, cacheCreate1hTokens: 10, reasoningTokens: 3, outputTokens: 4 }, pricing }), {
    uncachedInputCost: 2, cacheReadCost: 0.4, cacheCreate5mCost: null, cacheCreate1hCost: 0.00003, reasoningCost: 0.000036, outputCost: 0.000048, derivedTotalCost: 2.400114,
  });
});
