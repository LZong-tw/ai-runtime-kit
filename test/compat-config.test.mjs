import assert from "node:assert/strict";
import { test } from "node:test";

import {
  resolveCompatibilityPolicies,
  validateCompatibilityConfig,
} from "../src/compat/config.mjs";

const VALID_CONFIG = {
  fallback: {
    provider: "anthropic-messages",
    model: "claude-sonnet",
    maxContinuationTurns: 8,
  },
  toolSearch: { mode: "bridge" },
  webSearch: { mode: "native-first" },
  webFetch: { mode: "native-first" },
  codeExecution: { mode: "anthropic-fallback" },
  advisor: { mode: "anthropic-fallback" },
  mcpConnector: { mode: "anthropic-fallback" },
};

test("resolves all six policies and verified native web capabilities", () => {
  const resolved = resolveCompatibilityPolicies(VALID_CONFIG, {
    webSearch: true,
    webFetch: true,
  });

  assert.deepEqual(resolved, {
    fallback: VALID_CONFIG.fallback,
    policies: {
      webSearch: "native",
      webFetch: "native",
      codeExecution: "anthropic-fallback",
      advisor: "anthropic-fallback",
      toolSearch: "bridge",
      mcpConnector: "anthropic-fallback",
    },
  });
});

test("native-first falls back unless the matching capability is verified", () => {
  const resolved = resolveCompatibilityPolicies(VALID_CONFIG, {
    webSearch: true,
    webFetch: false,
  });

  assert.equal(resolved.policies.webSearch, "native");
  assert.equal(resolved.policies.webFetch, "anthropic-fallback");
  assert.equal(resolveCompatibilityPolicies(VALID_CONFIG, {}).policies.webSearch,
    "anthropic-fallback");
});

test("returns deeply frozen policy data without freezing the caller config", () => {
  const resolved = resolveCompatibilityPolicies(VALID_CONFIG, {
    webSearch: true,
    webFetch: true,
  });

  assert.equal(Object.isFrozen(resolved), true);
  assert.equal(Object.isFrozen(resolved.fallback), true);
  assert.equal(Object.isFrozen(resolved.policies), true);
  assert.equal(Object.isFrozen(VALID_CONFIG), false);
  assert.equal(Object.isFrozen(VALID_CONFIG.fallback), false);
  assert.throws(() => {
    resolved.policies.advisor = "native";
  }, TypeError);
});

test("accepts exact supported modes", () => {
  const cases = {
    webSearch: ["native-first", "anthropic-fallback", "mcp"],
    webFetch: ["native-first", "anthropic-fallback"],
    codeExecution: ["anthropic-fallback"],
    advisor: ["anthropic-fallback"],
    toolSearch: ["bridge", "anthropic-fallback"],
    mcpConnector: ["anthropic-fallback"],
  };

  for (const [family, modes] of Object.entries(cases)) {
    for (const mode of modes) {
      validateCompatibilityConfig({
        ...VALID_CONFIG,
        [family]: { mode },
      });
    }
  }
});

test("legacy MCP requires an explicit webSearch mode and keeps typed requests on fallback", () => {
  const legacy = {
    ...VALID_CONFIG,
    webSearch: { mode: "mcp" },
  };

  assert.equal(
    resolveCompatibilityPolicies(legacy, { webSearch: true }).policies.webSearch,
    "anthropic-fallback",
  );
  assert.throws(
    () => validateCompatibilityConfig({ ...VALID_CONFIG, webFetch: { mode: "mcp" } }),
    /webFetch\.mode/,
  );
});

test("rejects non-Anthropic fallback and removed Advisor bridge configuration", () => {
  assert.throws(
    () =>
      validateCompatibilityConfig({
        ...VALID_CONFIG,
        fallback: { ...VALID_CONFIG.fallback, model: "openai/gpt-5" },
      }),
    /fallback\.model must be an Anthropic-family model/,
  );
  assert.throws(
    () =>
      validateCompatibilityConfig({
        ...VALID_CONFIG,
        advisor: { mode: "bridge" },
      }),
    /advisor\.mode.*removed/i,
  );

  for (const field of ["model", "fallbackModel"]) {
    assert.throws(
      () =>
        validateCompatibilityConfig({
          ...VALID_CONFIG,
          advisor: { ...VALID_CONFIG.advisor, [field]: "anthropic/claude-opus" },
        }),
      new RegExp(`advisor\\.${field}.*removed`, "i"),
    );
  }
});

test("rejects missing fallback, unknown keys, and invalid provider or family modes", () => {
  const withoutFallback = { ...VALID_CONFIG };
  delete withoutFallback.fallback;
  assert.throws(() => validateCompatibilityConfig(withoutFallback), /fallback.*required/i);

  assert.throws(
    () => validateCompatibilityConfig({ ...VALID_CONFIG, extra: {} }),
    /unknown compatibility key.*extra/i,
  );
  assert.doesNotThrow(() =>
    validateCompatibilityConfig({
      ...VALID_CONFIG,
      fallback: { ...VALID_CONFIG.fallback, provider: "custom-anthropic" },
    }));
  for (const provider of ["", "provider/model", "../provider", "provider name"]) {
    assert.throws(
      () => validateCompatibilityConfig({
        ...VALID_CONFIG,
        fallback: { ...VALID_CONFIG.fallback, provider },
      }),
      /fallback\.provider.*identifier/,
    );
  }
  assert.throws(
    () => validateCompatibilityConfig({
      ...VALID_CONFIG,
      fallback: { ...VALID_CONFIG.fallback, model: "anthropic/claude-sonnet" },
    }),
    /provider-local Claude model identifier/,
  );

  for (const family of [
    "webSearch",
    "webFetch",
    "codeExecution",
    "advisor",
    "toolSearch",
    "mcpConnector",
  ]) {
    assert.throws(
      () => validateCompatibilityConfig({ ...VALID_CONFIG, [family]: { mode: "native" } }),
      new RegExp(`${family}\\.mode`),
    );
  }
});

test("requires every family and rejects unknown nested keys", () => {
  for (const family of [
    "webSearch",
    "webFetch",
    "codeExecution",
    "advisor",
    "toolSearch",
    "mcpConnector",
  ]) {
    const config = { ...VALID_CONFIG };
    delete config[family];
    assert.throws(() => validateCompatibilityConfig(config), new RegExp(`${family}.*required`));
  }

  assert.throws(
    () =>
      validateCompatibilityConfig({
        ...VALID_CONFIG,
        fallback: { ...VALID_CONFIG.fallback, extra: true },
      }),
    /unknown fallback key.*extra/i,
  );
  assert.throws(
    () =>
      validateCompatibilityConfig({
        ...VALID_CONFIG,
        toolSearch: { ...VALID_CONFIG.toolSearch, extra: true },
      }),
    /unknown toolSearch key.*extra/i,
  );
});

test("enforces integer continuation bounds from one through thirty-two", () => {
  for (const maxContinuationTurns of [1, 32]) {
    validateCompatibilityConfig({
      ...VALID_CONFIG,
      fallback: { ...VALID_CONFIG.fallback, maxContinuationTurns },
    });
  }

  for (const maxContinuationTurns of [0, 33, 1.5, "8", null]) {
    assert.throws(
      () =>
        validateCompatibilityConfig({
          ...VALID_CONFIG,
          fallback: { ...VALID_CONFIG.fallback, maxContinuationTurns },
        }),
      /fallback\.maxContinuationTurns.*integer.*1.*32/i,
    );
  }
});
