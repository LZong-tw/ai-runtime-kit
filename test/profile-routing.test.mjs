import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { buildCcr3ManagedConfig, loadCatalog } from "../src/airkit.mjs";
import { CODEX_API_BASE_URL, CODEX_AUTH_API_KEY } from "../src/compat/codex-auth-gateway.mjs";
import { resolveCcrRoute } from "./helpers/ccr-routing.mjs";

// Two profiles installed into one CCR, shaped like the internal pair: a
// low-cost profile fronted by the compatibility plugin, and a Codex profile
// with no plugin whose launcher sends the dedicated `airkit-mode` id. Both
// claim the same bare Claude family prefixes.
function twoProfileCatalog() {
  return {
    schema: 1,
    profiles: [
      {
        name: "lowcost-example",
        visibility: "public",
        summary: "Cheap lanes behind the compatibility plugin.",
        managedFiles: [],
        launch: {
          binary: "claude",
          claudeModel: "claude-airkit-mode[1m]",
          defaultMode: "auto",
          modes: {
            auto: {},
            strong: { ccr: { Router: { default: "lowcost-strong,strong-coder" } } },
          },
        },
        ccr: {
          APIKEY: "ccr-local",
          LOG: false,
          Providers: [
            {
              name: "lowcost-cheap",
              type: "openai_chat_completions",
              api_base_url: "https://cheap.example.invalid/v1/chat/completions",
              api_key: "$CHEAP_API_KEY",
              models: ["cheap-coder"],
            },
            {
              name: "lowcost-strong",
              type: "openai_chat_completions",
              api_base_url: "https://strong.example.invalid/v1/chat/completions",
              api_key: "$STRONG_API_KEY",
              models: ["strong-coder"],
            },
            {
              name: "anthropic-messages",
              type: "anthropic_messages",
              api_base_url: "https://anthropic.example.invalid/v1/messages",
              api_key: "$ANTHROPIC_EXAMPLE_KEY",
              models: ["claude-sonnet"],
            },
          ],
          Router: {
            default: "lowcost-cheap,cheap-coder",
            background: "lowcost-cheap,cheap-coder",
            opus: "lowcost-strong,strong-coder",
            sonnet: "anthropic-messages,claude-sonnet",
          },
          plugins: [{
            id: "airkit-compatibility",
            module: "@untionglim/ai-runtime-kit/compatibility-plugin",
            config: {
              fallback: { provider: "anthropic-messages", model: "claude-sonnet", maxContinuationTurns: 8 },
              advisor: { mode: "anthropic-fallback" },
              codeExecution: { mode: "anthropic-fallback" },
              mcpConnector: { mode: "anthropic-fallback" },
              toolSearch: { mode: "bridge" },
              webFetch: { mode: "native-first" },
              webSearch: { mode: "native-first" },
            },
          }],
        },
      },
      {
        name: "codex-example",
        visibility: "public",
        summary: "Codex subscription for the main lanes.",
        managedFiles: [],
        launch: {
          binary: "claude",
          claudeModel: "claude-airkit-mode[1m]",
          defaultMode: "codex",
          modes: { codex: {} },
        },
        ccr: {
          APIKEY: "ccr-local",
          LOG: false,
          Providers: [
            {
              name: "codex",
              type: "openai_responses",
              api_base_url: CODEX_API_BASE_URL,
              api_key: CODEX_AUTH_API_KEY,
              models: ["gpt-6.1-sol"],
            },
            {
              name: "cheap",
              type: "openai_chat_completions",
              api_base_url: "https://cheap.example.invalid/v1/chat/completions",
              api_key: "$CHEAP_API_KEY",
              models: ["cheap-coder"],
            },
          ],
          Router: {
            default: "codex,gpt-6.1-sol",
            background: "cheap,cheap-coder",
            opus: "codex,gpt-6.1-sol",
            sonnet: "codex,gpt-6.1-sol",
          },
        },
      },
    ],
  };
}

const LOWCOST = "lowcost-example";
const CODEX = "codex-example";
const CODEX_SOL = "airkit-provider-codex-example-codex/gpt-6.1-sol";
const CODEX_BACKGROUND = "airkit-provider-codex-example-cheap/cheap-coder";
// What the former global rules sent each bare family id to; profile rules must
// keep these targets exactly.
const LOWCOST_FAMILY_TARGETS = {
  "claude-haiku-4-5-20251001": "airkit-provider-lowcost-example-lowcost-cheap/cheap-coder",
  "claude-haiku-5-5": "airkit-provider-lowcost-example-lowcost-cheap/cheap-coder",
  "claude-opus-5-5": "airkit-provider-lowcost-example-lowcost-strong/strong-coder",
  "claude-opus-4-7": "airkit-provider-lowcost-example-lowcost-strong/strong-coder",
  "claude-sonnet-5-5": "airkit-provider-lowcost-example-anthropic-messages/claude-sonnet",
  "claude-sonnet-5": "airkit-provider-lowcost-example-anthropic-messages/claude-sonnet",
};
const PROBE_MODELS = [...Object.keys(LOWCOST_FAMILY_TARGETS), "airkit-mode", "claude-fable-5", "gpt-6.1-sol"];

async function loadTwoProfileCatalog(t, catalog = twoProfileCatalog()) {
  const dir = await mkdtemp(join(tmpdir(), "airkit-profile-routing-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "catalog.json");
  await writeFile(path, JSON.stringify(catalog));
  return { catalog: await loadCatalog(path, { includeLocal: false }), configDir: join(dir, "airkit") };
}

function install(catalog, profileName, current, configDir) {
  return buildCcr3ManagedConfig(catalog, profileName, current, { configDir });
}

function managedProfileIds(config, profileName) {
  return config.profile.profiles.map(({ id }) => id).filter((id) => id.startsWith(`airkit-${profileName}-`));
}

function ownProviderIds(config, profileName) {
  return new Set(config.Providers.map(({ id }) => id).filter((id) => id.startsWith(`airkit-provider-${profileName}-`)));
}

// Every routed request from one profile's key must land on that profile's own
// providers; an unrouted model is left as sent, never rewritten to the other's.
function assertNoLeakage(config, label) {
  for (const [owner, other] of [[LOWCOST, CODEX], [CODEX, LOWCOST]]) {
    const own = ownProviderIds(config, owner);
    const ids = managedProfileIds(config, owner);
    assert.ok(ids.length > 0, `${label}: ${owner} is installed`);
    for (const profileId of ids) {
      for (const model of PROBE_MODELS) {
        const routed = resolveCcrRoute(config, { model, profileId });
        if (routed.ruleId === null) continue;
        const providerId = routed.model.slice(0, routed.model.indexOf("/"));
        assert.ok(
          own.has(providerId),
          `${label}: ${profileId} sent ${model} to ${routed.model}, which is not ${owner}'s (rule ${routed.ruleId}; other profile ${other})`,
        );
      }
    }
  }
}

test("installing two profiles in any order leaves no cross-profile route", async (t) => {
  const { catalog, configDir } = await loadTwoProfileCatalog(t);
  for (const order of [[LOWCOST, CODEX, LOWCOST], [CODEX, LOWCOST, CODEX], [LOWCOST, LOWCOST, CODEX, CODEX]]) {
    let config = {};
    for (const [step, profileName] of order.entries()) {
      config = install(catalog, profileName, config, configDir).config;
      const installed = order.slice(0, step + 1);
      const label = installed.join(" -> ");
      assert.deepEqual(config.Router.rules, [], `${label}: AirKit writes no global Router rules`);
      if (new Set(installed).size === 2) assertNoLeakage(config, label);
    }
  }
});

test("the codex launch id resolves to the Codex default, and only on Codex keys", async (t) => {
  const { catalog, configDir } = await loadTwoProfileCatalog(t);
  let config = install(catalog, CODEX, {}, configDir).config;
  config = install(catalog, LOWCOST, config, configDir).config;

  const codexProfile = config.profile.profiles.find(({ id }) => id === "airkit-codex-example-codex");
  assert.deepEqual(codexProfile.routing.rules[0], {
    id: "airkit-codex-example-route-launch",
    name: "AirKit launch model route",
    type: "condition",
    enabled: true,
    condition: { left: "request.body.model", operator: "==", right: "airkit-mode" },
    rewrite: { key: "request.body.model", operation: "set", value: CODEX_SOL },
    rewrites: [{ key: "request.body.model", operation: "set", value: CODEX_SOL }],
  });
  assert.equal(resolveCcrRoute(config, { model: "airkit-mode", profileId: codexProfile.id }).model, CODEX_SOL);
  assert.equal(resolveCcrRoute(config, { model: "claude-sonnet-5-5", profileId: codexProfile.id }).model, CODEX_SOL);
  assert.equal(resolveCcrRoute(config, { model: "claude-opus-5-5", profileId: codexProfile.id }).model, CODEX_SOL);
  assert.equal(
    resolveCcrRoute(config, { model: "claude-haiku-4-5-20251001", profileId: codexProfile.id }).model,
    CODEX_BACKGROUND,
  );

  // The compatibility plugin already routes the launch id for its profile, so
  // the low-cost profiles get no launch rule and their rule set is unchanged.
  for (const profileId of managedProfileIds(config, LOWCOST)) {
    const routed = resolveCcrRoute(config, { model: "airkit-mode", profileId });
    assert.equal(routed.ruleId, null, `${profileId} leaves airkit-mode to the plugin`);
  }
  // A request presenting no AirKit profile key gets no AirKit route at all.
  assert.equal(resolveCcrRoute(config, { model: "airkit-mode" }).ruleId, null);
  assert.equal(resolveCcrRoute(config, { model: "claude-sonnet-5-5" }).ruleId, null);
});

test("low-cost bare Claude routing keeps the targets the global rules had", async (t) => {
  const { catalog, configDir } = await loadTwoProfileCatalog(t);
  const config = install(catalog, LOWCOST, {}, configDir).config;
  const ids = managedProfileIds(config, LOWCOST);
  assert.deepEqual(ids.sort(), ["airkit-lowcost-example-auto", "airkit-lowcost-example-strong"]);
  for (const profileId of ids) {
    for (const [model, target] of Object.entries(LOWCOST_FAMILY_TARGETS)) {
      assert.equal(resolveCcrRoute(config, { model, profileId }).model, target, `${profileId} ${model}`);
    }
    assert.equal(resolveCcrRoute(config, { model: "claude-fable-5", profileId }).ruleId, null, "unknown Claude ids stay unrouted");
  }
  const repeated = install(catalog, LOWCOST, config, configDir).config;
  assert.deepEqual(repeated, config, "a second launch saves nothing new");
});

test("migration drops stale AirKit global rules and keeps user rules", async (t) => {
  const { catalog, configDir } = await loadTwoProfileCatalog(t);
  const legacyRule = (profileName, kind, prefix, target) => ({
    id: `airkit-${profileName}-route-${kind}`,
    name: `legacy ${kind}`,
    type: "condition",
    enabled: true,
    condition: { left: "request.body.model", operator: "starts-with", right: prefix },
    rewrite: { key: "request.body.model", operation: "set", value: target },
    rewrites: [{ key: "request.body.model", operation: "set", value: target }],
  });
  const userRule = {
    id: "my-long-context",
    name: "User rule",
    type: "condition",
    enabled: true,
    condition: { left: "request.body.model", operator: "starts-with", right: "claude-3-" },
    rewrite: { key: "request.body.model", operation: "set", value: "mine/long-context" },
    rewrites: [{ key: "request.body.model", operation: "set", value: "mine/long-context" }],
  };
  // The state a pre-fix build left behind after "codex, then lowcost": both
  // profiles' rules are global, codex's first, so codex's decided lowcost's
  // claude-sonnet- traffic. Plus a profile that has since left the catalog.
  let config = install(catalog, CODEX, {}, configDir).config;
  config = install(catalog, LOWCOST, config, configDir).config;
  for (const profile of config.profile.profiles) profile.routing = { enabled: true, enhancedRoute: false, rules: [] };
  config.Router.rules = [
    userRule,
    legacyRule(CODEX, "background", "claude-haiku-", CODEX_BACKGROUND),
    legacyRule(CODEX, "opus", "claude-opus-", CODEX_SOL),
    legacyRule(CODEX, "default", "claude-sonnet-", CODEX_SOL),
    legacyRule(LOWCOST, "background", "claude-haiku-", LOWCOST_FAMILY_TARGETS["claude-haiku-5-5"]),
    legacyRule(LOWCOST, "opus", "claude-opus-", LOWCOST_FAMILY_TARGETS["claude-opus-5-5"]),
    legacyRule(LOWCOST, "default", "claude-sonnet-", LOWCOST_FAMILY_TARGETS["claude-sonnet-5-5"]),
    legacyRule("gone-example", "default", "claude-", "airkit-provider-gone-example-x/y"),
  ];
  assert.equal(
    resolveCcrRoute(config, { model: "claude-sonnet-5-5", profileId: "airkit-lowcost-example-auto" }).model,
    CODEX_SOL,
    "precondition: the pre-fix layout routes low-cost Sonnet to Codex",
  );

  const lowcost = install(catalog, LOWCOST, config, configDir);
  assert.deepEqual(lowcost.pruned.rules, ["airkit-gone-example-route-default"], "the orphan is removed and reported");
  assert.deepEqual(
    lowcost.config.Router.rules.map(({ id }) => id),
    ["my-long-context", "airkit-codex-example-route-background", "airkit-codex-example-route-opus", "airkit-codex-example-route-default"],
    "the launching profile's own global rules go; the other installed profile's wait for its own launch",
  );
  // Codex still runs on the entries the old build installed, served by its
  // legacy global rules; low-cost's own profile rules now win for its keys.
  assertNoLeakage(lowcost.config, "after lowcost migrates");

  const codex = install(catalog, CODEX, lowcost.config, configDir);
  assert.deepEqual(codex.pruned.rules, []);
  assert.deepEqual(codex.config.Router.rules, [userRule], "only the user's rule is left, unchanged");
  assertNoLeakage(codex.config, "after both migrate");
  assert.equal(resolveCcrRoute(codex.config, { model: "claude-3-opus" }).model, "mine/long-context");
  assert.equal(
    resolveCcrRoute(codex.config, { model: "claude-3-opus", profileId: "airkit-codex-example-codex" }).model,
    "mine/long-context",
    "user rules still apply to models no profile rule claims",
  );
});
