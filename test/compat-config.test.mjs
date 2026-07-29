import assert from "node:assert/strict";
import { test } from "node:test";

import {
  AIRKIT_MODE_HEADER,
  airkitModeLabel,
  isAirkitModeLabel,
  requestedMode,
  resolveCompatibilityPolicies,
  resolveModeRoutes,
  routeBareClaudeModel,
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
    familyFallbacks: {},
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

test("accepts an Advisor-specific Anthropic fallback override", () => {
  const config = {
    ...VALID_CONFIG,
    advisor: {
      mode: "anthropic-fallback",
      fallback: { provider: "web-litellm-anthropic", model: "claude-opus-5" },
    },
  };

  assert.doesNotThrow(() => validateCompatibilityConfig(config));
  assert.deepEqual(resolveCompatibilityPolicies(config, {}).familyFallbacks.advisor, {
    provider: "web-litellm-anthropic",
    model: "claude-opus-5",
    maxContinuationTurns: 8,
  });
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

test("routes accepts provider-qualified selectors and rejects malformed shapes", () => {
  validateCompatibilityConfig({
    ...VALID_CONFIG,
    routes: { default: "demo/steady-coder", background: "demo/cheap-coder" },
  });
  validateCompatibilityConfig({ ...VALID_CONFIG, routes: { default: "demo/steady-coder" } });

  assert.throws(
    () => validateCompatibilityConfig({ ...VALID_CONFIG, routes: {} }),
    /routes\.default is required/,
  );
  assert.throws(
    () => validateCompatibilityConfig({ ...VALID_CONFIG, routes: { default: "bare-model" } }),
    /routes\.default must be a provider-qualified model selector/,
  );
  assert.throws(
    () =>
      validateCompatibilityConfig({
        ...VALID_CONFIG,
        routes: { default: "demo/steady-coder", small: "demo/cheap-coder" },
      }),
    /routes/,
  );
});

test("routeLog accepts booleans and rejects everything else", () => {
  validateCompatibilityConfig({ ...VALID_CONFIG, routeLog: true });
  validateCompatibilityConfig({ ...VALID_CONFIG, routeLog: false });
  validateCompatibilityConfig({ ...VALID_CONFIG });

  assert.throws(
    () => validateCompatibilityConfig({ ...VALID_CONFIG, routeLog: "yes" }),
    /routeLog must be a boolean/,
  );
  assert.throws(
    () => validateCompatibilityConfig({ ...VALID_CONFIG, routeLog: 1 }),
    /routeLog must be a boolean/,
  );
});

test("modeRoutes validates per mode and rejects malformed tables", () => {
  const withModes = (modeRoutes) => ({ ...VALID_CONFIG, modeRoutes });

  validateCompatibilityConfig(withModes({
    glm: { default: "demo/glm", background: "demo/glm" },
    auto: { default: "demo/flash" },
  }));
  validateCompatibilityConfig({ ...VALID_CONFIG });

  assert.throws(
    () => validateCompatibilityConfig(withModes({ glm: { background: "demo/glm" } })),
    /modeRoutes\.glm\.default is required/,
  );
  assert.throws(
    () => validateCompatibilityConfig(withModes({ glm: { default: "bare-model" } })),
    /modeRoutes\.glm\.default must be a provider-qualified model selector/,
  );
  assert.throws(
    () => validateCompatibilityConfig(withModes({ glm: { default: "demo/glm", small: "demo/x" } })),
    /unknown modeRoutes\.glm key.*small/i,
  );
  assert.throws(
    () => validateCompatibilityConfig(withModes({ "../evil": { default: "demo/glm" } })),
    /modeRoutes key must be a canonical launch mode label/,
  );
  assert.throws(
    () => validateCompatibilityConfig(withModes({ GLM: { default: "demo/glm" } })),
    /modeRoutes key must be a canonical launch mode label/,
    "requestedMode lowercases every label, so an uppercase key could never match",
  );
  assert.throws(() => validateCompatibilityConfig(withModes("glm")), /modeRoutes/);
});

test("isAirkitModeLabel accepts only labels that round-trip through the header", () => {
  for (const label of ["glm", "auto", "pro-2", "a.b"]) {
    assert.equal(isAirkitModeLabel(label), true, label);
  }
  for (const label of ["GLM", " glm", "", "__proto__", "../evil", null, 7]) {
    assert.equal(isAirkitModeLabel(label), false, String(label));
  }
});

test("mode label selects its route table and falls back to the flat table", () => {
  const config = {
    routes: { default: "demo/flash", background: "demo/flash" },
    modeRoutes: { glm: { default: "demo/glm", background: "demo/glm-mini" } },
  };

  assert.deepEqual(resolveModeRoutes(config, "glm"), config.modeRoutes.glm);
  assert.deepEqual(resolveModeRoutes(config, "kimi"), config.routes, "unknown mode uses flat routes");
  assert.deepEqual(resolveModeRoutes(config, null), config.routes, "unlabelled caller uses flat routes");
  assert.deepEqual(resolveModeRoutes({ routes: config.routes }, "glm"), config.routes);
  assert.equal(resolveModeRoutes({}, "glm"), null);
  assert.equal(resolveModeRoutes(null, "glm"), null);
  assert.deepEqual(
    resolveModeRoutes({ ...config, modeRoutes: { constructor: { default: "demo/x" } } }, "toString"),
    config.routes,
    "inherited object properties are never treated as modes",
  );
});

test("mode header is normalized and malformed labels are ignored", () => {
  assert.equal(AIRKIT_MODE_HEADER, "x-airkit-mode");
  assert.equal(airkitModeLabel(" GLM "), "glm", "sender and receiver share one normalization");
  assert.equal(requestedMode({ [AIRKIT_MODE_HEADER]: "glm" }), "glm");
  assert.equal(requestedMode({ [AIRKIT_MODE_HEADER]: "  GLM  " }), "glm");
  assert.equal(requestedMode({ [AIRKIT_MODE_HEADER]: ["kimi", "pro"] }), "kimi");
  assert.equal(requestedMode({ [AIRKIT_MODE_HEADER]: "glm\n" }), "glm", "surrounding whitespace is trimmed");
  assert.equal(requestedMode({}), null);
  assert.equal(requestedMode(null), null);
  for (const value of ["", "  ", "../evil", "a b", "glm\nx", 7, {}]) {
    assert.equal(requestedMode({ [AIRKIT_MODE_HEADER]: value }), null, `rejects ${JSON.stringify(value)}`);
  }
});

test("bare Claude models route to background or default; qualified and foreign models do not", () => {
  const routes = { default: "demo/steady-coder", background: "demo/cheap-coder" };
  const body = (model) => ({ model, max_tokens: 8, messages: [] });

  assert.equal(
    routeBareClaudeModel(body("claude-haiku-4-5-20251001"), routes).model,
    "demo/cheap-coder",
  );
  assert.equal(routeBareClaudeModel(body("claude-fable-5"), routes).model, "demo/steady-coder");
  assert.equal(routeBareClaudeModel(body("claude-sonnet-4-6"), routes).model, "demo/steady-coder");
  assert.equal(
    routeBareClaudeModel(body("claude-haiku-4-5"), { default: "demo/steady-coder" }).model,
    "demo/steady-coder",
    "background falls back to default",
  );
  assert.equal(routeBareClaudeModel(body("provider/claude-sonnet"), routes), null);
  assert.equal(routeBareClaudeModel(body("deepseek-v4-flash"), routes), null);
  assert.equal(routeBareClaudeModel(body("claude-fable-5"), undefined), null);
  assert.equal(routeBareClaudeModel({ max_tokens: 8 }, routes), null);
  const original = body("claude-fable-5");
  const rewritten = routeBareClaudeModel(original, routes);
  assert.equal(original.model, "claude-fable-5", "input body is not mutated");
  assert.notEqual(rewritten, original);
});
