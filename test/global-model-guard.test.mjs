import { test } from "node:test";
import assert from "node:assert/strict";

import {
  catalogCcrOnlyModelIds,
  ccrOnlyModelReason,
  globalSettingsPath,
  inspectGlobalModel,
  neutralizeGlobalModel,
} from "../src/global-model-guard.mjs";

const ROUTE_ID = "anthropic/claude-ccr-h6169726b";

function settingsReader(settings) {
  const reads = [];
  return {
    reads,
    readText: async (path) => {
      reads.push(path);
      return JSON.stringify(settings);
    },
  };
}

function sink() {
  const chunks = [];
  return { write: (chunk) => chunks.push(chunk), value: () => chunks.join("") };
}

test("ccrOnlyModelReason flags ids only the AirKit gateway can serve", () => {
  assert.equal(ccrOnlyModelReason(ROUTE_ID), "a CCR route id");
  assert.equal(ccrOnlyModelReason("claude-ccr-h6169726b[1m]"), "a CCR route id");
  assert.equal(ccrOnlyModelReason("claude-airkit-mode[1m]"), "the AirKit launcher model id");
  assert.equal(ccrOnlyModelReason("oneportal,GLM-5.3"), "a provider-prefixed CCR route");
  assert.equal(ccrOnlyModelReason("GLM-5.3", ["glm-5.3"]), "a CCR provider model");
  for (const model of ["opus", "sonnet[1m]", "claude-sonnet-5", "claude-opus-5-5[1m]", "default"]) {
    assert.equal(ccrOnlyModelReason(model, ["glm-5.3"]), null, model);
  }
});

test("catalogCcrOnlyModelIds keeps provider ids that Anthropic does not serve", () => {
  const ids = catalogCcrOnlyModelIds({
    modelCatalog: { providers: [{ models: [{ id: "GLM-5.3" }, { id: "claude-sonnet-5" }] }] },
    profiles: [{ ccr: { Providers: [{ models: ["Kimi-K3", "claude-opus-5-5"] }] } }],
  });
  assert.deepEqual(ids.sort(), ["GLM-5.3", "Kimi-K3"]);
});

test("the global settings path follows CLAUDE_CONFIG_DIR, then HOME, and nothing else", () => {
  assert.equal(globalSettingsPath({ HOME: "/h" }), "/h/.claude/settings.json");
  assert.equal(globalSettingsPath({ HOME: "/h", CLAUDE_CONFIG_DIR: "/c" }), "/c/settings.json");
  assert.equal(globalSettingsPath({}), null);
});

test("inspectGlobalModel ignores missing files, invalid JSON and real Anthropic models", async () => {
  const env = { HOME: "/h" };
  assert.equal(await inspectGlobalModel({ env, readText: async () => { throw new Error("ENOENT"); } }), null);
  assert.equal(await inspectGlobalModel({ env, readText: async () => "{ not json" }), null);
  assert.equal(await inspectGlobalModel({ env, readText: settingsReader({ model: "opus" }).readText }), null);
  assert.deepEqual(await inspectGlobalModel({ env, readText: settingsReader({ model: ROUTE_ID }).readText }), {
    path: "/h/.claude/settings.json",
    model: ROUTE_ID,
    reason: "a CCR route id",
  });
});

test("a leaked global model is overridden for this launch only, with one warning naming the fix", async () => {
  const reader = settingsReader({ model: ROUTE_ID, permissions: {} });
  const stderr = sink();
  const result = await neutralizeGlobalModel({ args: ["--resume", "--", "x"], env: { HOME: "/h" }, readText: reader.readText, stderr });

  assert.deepEqual(result.args, ["--model", "default", "--resume", "--", "x"]);
  assert.equal(result.leak.model, ROUTE_ID);
  assert.deepEqual(reader.reads, ["/h/.claude/settings.json"]);
  const warning = stderr.value();
  assert.equal(warning.split("\n").filter(Boolean).length, 1);
  assert.match(warning, /\/h\/\.claude\/settings\.json/);
  assert.match(warning, /remove the "model" key/);
  assert.match(warning, /overrides it with --model/);
});

test("an explicit --model or ANTHROPIC_MODEL wins without reading the settings file", async () => {
  for (const [args, env] of [
    [["--model", "opus"], { HOME: "/h" }],
    [["--model=opus"], { HOME: "/h" }],
    [["-p", "hi"], { HOME: "/h", ANTHROPIC_MODEL: "claude-sonnet-5" }],
  ]) {
    const reader = settingsReader({ model: ROUTE_ID });
    const stderr = sink();
    const result = await neutralizeGlobalModel({ args, env, readText: reader.readText, stderr });
    assert.deepEqual(result.args, args);
    assert.equal(result.leak, null);
    assert.deepEqual(reader.reads, []);
    assert.equal(stderr.value(), "");
  }
});
