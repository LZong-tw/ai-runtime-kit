import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { test } from "node:test";

import { buildCcr3ManagedConfig, doctorProfile, installProfile, loadCatalog } from "../src/airkit.mjs";
import { createGatewayClient } from "../src/compat/gateway.mjs";
import { CODEX_API_BASE_URL, CODEX_AUTH_API_KEY } from "../src/compat/codex-auth-gateway.mjs";

const CODEX_ID = "airkit-provider-codex-example-codex";

function codexCatalog() {
  return {
    schema: 1,
    profiles: [{
      name: "codex-example",
      visibility: "public",
      summary: "Codex subscription for the main lanes, a cheap provider for background.",
      managedFiles: [],
      launch: {
        binary: "claude",
        claudeModel: "claude-sonnet-5",
        defaultMode: "auto",
        modes: { auto: {} },
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
            api_base_url: "https://example.invalid/v1/chat/completions",
            api_key: "$CHEAP_API_KEY",
            models: ["cheap-coder"],
          },
        ],
        Router: {
          default: "codex,gpt-6.1-sol",
          opus: "codex,gpt-6.1-sol",
          sonnet: "codex,gpt-6.1-sol",
          background: "cheap,cheap-coder",
        },
      },
    }],
  };
}

async function loadFrom(t, catalog) {
  const dir = await mkdtemp(join(tmpdir(), "airkit-codex-catalog-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "catalog.json");
  await writeFile(path, JSON.stringify(catalog));
  return loadCatalog(path, { includeLocal: false });
}

test("codex profile installs the read-only auth hook into CCR's core gateway", async (t) => {
  const catalog = await loadFrom(t, codexCatalog());
  const { config } = buildCcr3ManagedConfig(catalog, "codex-example", {}, { configDir: "/tmp/airkit-codex-profile" });

  const codex = config.Providers.find((provider) => provider.id === CODEX_ID);
  assert.equal(codex.api_base_url, CODEX_API_BASE_URL);
  // The sentinel is not a credential, and it is not CCR's own refreshing
  // "ccr-local-agent-login" marker either.
  assert.equal(codex.api_key, CODEX_AUTH_API_KEY);

  const wrapper = config.plugins.find((plugin) => plugin.id === "airkit-codex-auth");
  assert.deepEqual(wrapper.permissions, ["core-gateway-config"]);
  assert.equal(wrapper.module, undefined);
  const [gatewayPlugin] = wrapper.coreGateway.config.plugins;
  assert.equal(gatewayPlugin.key, "airkit-codex-auth");
  assert.match(gatewayPlugin.modulePath, /src\/compat\/codex-auth-gateway\.mjs$/);
  assert.deepEqual(gatewayPlugin.config, { providers: [CODEX_ID] });
  assert.equal(JSON.stringify(config).includes("refresh"), false);
});

test("profiles without a codex provider get no codex wrapper", async (t) => {
  const catalog = codexCatalog();
  const profile = catalog.profiles[0];
  profile.ccr.Providers = profile.ccr.Providers.filter((provider) => provider.name !== "codex");
  profile.ccr.Router = { default: "cheap,cheap-coder", background: "cheap,cheap-coder" };
  const { config } = buildCcr3ManagedConfig(await loadFrom(t, catalog), "codex-example", {}, {
    configDir: "/tmp/airkit-codex-profile",
  });
  assert.equal(config.plugins.some((plugin) => plugin.id === "airkit-codex-auth"), false);
});

test("codex provider must point at the ChatGPT Codex responses endpoint", async (t) => {
  for (const change of [
    { api_base_url: "https://example.invalid/v1/responses" },
    { api_base_url: "https://chatgpt.com/backend-api/codex/v1/responses" },
    { type: "openai_chat_completions" },
  ]) {
    const catalog = codexCatalog();
    Object.assign(catalog.profiles[0].ccr.Providers[0], change);
    await assert.rejects(loadFrom(t, catalog), /Codex ChatGPT login.*https:\/\/chatgpt\.com\/backend-api\/codex\/responses/);
  }
});

test("base URL overrides never redirect the ChatGPT login", async (t) => {
  const catalog = await loadFrom(t, codexCatalog());
  assert.throws(
    () => buildCcr3ManagedConfig(catalog, "codex-example", {}, {
      configDir: "/tmp/airkit-codex-profile",
      env: { AIRCLAUDE_PROVIDER_BASE_URLS: JSON.stringify({ codex: "https://evil.invalid/v1/responses" }) },
    }),
    /cannot be overridden/,
  );
  // The scalar override targets the active Responses provider; codex is
  // exempt, so the managed URL stays on chatgpt.com.
  const { config } = buildCcr3ManagedConfig(catalog, "codex-example", {}, {
    configDir: "/tmp/airkit-codex-profile",
    env: { AIRCLAUDE_RESPONSES_PROVIDER_BASE_URL: "https://evil.invalid/v1/responses" },
  });
  assert.equal(config.Providers.find((provider) => provider.id === CODEX_ID).api_base_url, CODEX_API_BASE_URL);
});

test("only the marker may reach the Codex backend", async (t) => {
  // CCR's own refreshing login, a real-looking key, or a flag next to some
  // other key: none of them may point a provider at chatgpt.com/backend-api/codex.
  for (const api_key of ["ccr-local-agent-login", "$OPENAI_API_KEY", "opaque-token"]) {
    const catalog = codexCatalog();
    Object.assign(catalog.profiles[0].ccr.Providers[0], { api_key });
    await assert.rejects(loadFrom(t, catalog), /targets the Codex backend.*airkit-codex-auth-json/);
  }
  const catalog = codexCatalog();
  catalog.profiles[0].ccr.Providers[1].api_base_url = "https://chatgpt.com/backend-api/codex/responses/compact";
  await assert.rejects(loadFrom(t, catalog), /"cheap" targets the Codex backend/);
});

test("a resolved API key never replaces the Codex marker", async (t) => {
  const catalog = await loadFrom(t, codexCatalog());
  const { config } = buildCcr3ManagedConfig(catalog, "codex-example", {}, {
    configDir: "/tmp/airkit-codex-profile",
    apiKeys: { codex: "resolved-secret-fixture", cheap: "cheap-secret-fixture" },
  });
  assert.equal(config.Providers.find((provider) => provider.id === CODEX_ID).api_key, CODEX_AUTH_API_KEY);
  assert.equal(config.Providers.find((provider) => provider.id === "airkit-provider-codex-example-cheap").api_key, "cheap-secret-fixture");
  assert.ok(config.plugins.some((plugin) => plugin.id === "airkit-codex-auth"));
});

test("transport fallbacks cannot start from a Codex provider", async (t) => {
  const catalog = codexCatalog();
  catalog.profiles[0].ccr.Providers.push({
    name: "anthropic",
    type: "anthropic_messages",
    api_base_url: "https://example.invalid/v1/messages",
    api_key: "$ANTHROPIC_API_KEY",
    models: ["claude-sonnet-5"],
  });
  catalog.profiles[0].ccr.plugins = [{
    id: "airkit-compatibility",
    enabled: true,
    config: {
      fallback: { provider: "anthropic", model: "claude-sonnet-5" },
      transportFallbacks: [{
        from: { provider: "codex", model: "gpt-6.1-sol" },
        to: { provider: "anthropic", model: "claude-sonnet-5" },
        statuses: [401, 429],
      }],
    },
  }];
  await assert.rejects(loadFrom(t, catalog), /transportFallbacks cannot start from Codex provider "codex"/);
});

function rejection(providerName) {
  return JSON.stringify({
    error: {
      message: "All target providers failed.",
      target_provider_names: [providerName],
      attempts: [{ provider_name: providerName, status: 401, details: { error: { message: "token revoked" } } }],
    },
  });
}

function clientReturning(body, { status = 401, contentType = "application/json" } = {}) {
  return createGatewayClient({
    origin: "http://127.0.0.1:3456",
    token: "synthetic-token",
    providers: [
      { name: CODEX_ID, type: "openai_responses", api_key: CODEX_AUTH_API_KEY, models: ["gpt-6.1-sol"] },
      { name: "other", type: "openai_chat_completions", api_key: "$OTHER", models: ["m"] },
    ],
    fetchImpl: async () => new Response(body, { status, headers: { "content-type": contentType } }),
  });
}

test("a ChatGPT 401 tells the user to run codex, upstream text first", async () => {
  const result = await clientReturning(rejection(CODEX_ID)).requestFallback({ model: `${CODEX_ID}/gpt-6.1-sol` }, {});
  assert.equal(result.status, 401);
  const { error } = await result.json();
  assert.match(error.message, /^All target providers failed\. \[AirKit\] ChatGPT rejected the Codex login: run `codex` once/);
  assert.equal(error.attempts[0].details.error.message, "token revoked");
});

test("other 401s and non-JSON bodies pass through unchanged", async () => {
  const other = rejection("other");
  assert.equal(await (await clientReturning(other).requestFallback({}, {})).text(), other);
  assert.equal(await (await clientReturning("plain", { contentType: "text/plain" }).requestFallback({}, {})).text(), "plain");
  const ok = rejection(CODEX_ID);
  assert.equal(await (await clientReturning(ok, { status: 200 }).requestFallback({}, {})).text(), ok);
});

test("the raw passthrough path names the codex fix too", async () => {
  const chunks = [];
  let status;
  const response = new Writable({ write(chunk, _encoding, callback) { chunks.push(chunk); callback(); } });
  response.writeHead = (code) => { status = code; };
  let error;
  await clientReturning(rejection(CODEX_ID)).forwardRaw({
    body: Buffer.from(JSON.stringify({ model: `${CODEX_ID}/gpt-6.1-sol`, messages: [] })),
    headers: {},
    response,
    onResponse(event) { error = event.error; },
  });
  assert.equal(status, 401);
  assert.equal(error.status, 401);
  assert.match(JSON.parse(Buffer.concat(chunks)).error.message, /\[AirKit\] ChatGPT rejected the Codex login: run `codex` once/);
});

test("doctor reports the Codex login state without the token", async (t) => {
  const catalog = await loadFrom(t, codexCatalog());
  const dir = await mkdtemp(join(tmpdir(), "airkit-codex-doctor-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const configDir = join(dir, "config");
  await installProfile(catalog, "codex-example", { configDir, write: true });

  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const token = `${encode({ alg: "none" })}.${encode({ exp: Math.floor(Date.now() / 1000) - 60 })}.doctor-secret`;
  const authFile = join(dir, "auth.json");
  await writeFile(authFile, JSON.stringify({
    auth_mode: "chatgpt",
    tokens: { access_token: token, refresh_token: "doctor-refresh-secret", account_id: "acct" },
  }));

  const doctor = (codexAuthFile) => doctorProfile(catalog, "codex-example", {
    ccrClient: { getConfig: async () => ({}) },
    codexAuthFile,
    commandExists: async () => true,
    configDir,
    sourceShellSnippet: async () => ({ ok: true }),
  });

  const expired = await doctor(authFile);
  assert.equal(expired.runtime.codexAuth.ok, false);
  assert.equal(expired.runtime.codexAuth.path, authFile);
  assert.match(expired.runtime.codexAuth.reason, /run `codex` once/);
  assert.ok(expired.failures.includes(expired.runtime.codexAuth.reason));
  assert.doesNotMatch(JSON.stringify(expired), /doctor-secret|doctor-refresh-secret/);

  const missing = await doctor(join(dir, "absent.json"));
  assert.equal(missing.runtime.codexAuth.ok, false);
  assert.match(missing.runtime.codexAuth.reason, /not found/);
});

test("shipped catalog has a public codex profile that routes every lane to the Codex subscription", async () => {
  const catalog = await loadCatalog(undefined, { includeLocal: false });
  const codex = catalog.profiles.find(({ name }) => name === "codex");
  assert.equal(codex.visibility, "public");
  assert.deepEqual(codex.shell, { wrappers: [{ name: "cx", command: "airclaude" }] });
  assert.deepEqual(codex.ccr.Providers.map(({ name }) => name), ["codex"]);
  assert.equal(codex.ccr.Providers[0].api_base_url, CODEX_API_BASE_URL);
  assert.equal(codex.ccr.Providers[0].api_key, CODEX_AUTH_API_KEY);
  const router = {
    default: "codex,gpt-6.2-sol",
    background: "codex,gpt-6-luna",
    opus: "codex,gpt-6.2-sol",
    sonnet: "codex,gpt-6.1-terra",
    fable: "codex,gpt-6.2-astra",
  };
  assert.deepEqual(codex.ccr.Router, router);
  assert.deepEqual(codex.launch.modes[codex.launch.defaultMode].ccr.Router, router);
  assert.doesNotMatch(JSON.stringify(codex), /op:\/\/|oneportal|kkcompany|kkinternal/i);
});
