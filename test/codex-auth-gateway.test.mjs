import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  CODEX_AUTH_API_KEY,
  CODEX_UPSTREAM_PREFIX,
  createCodexAuthHook,
  createGatewayPlugin,
  defaultCodexAuthFile,
  describeCodexAuth,
  isCodexAuthProvider,
} from "../src/compat/codex-auth-gateway.mjs";

const NOW = Date.UTC(2026, 10, 26, 12, 0, 0);
const CODEX_URL = `${CODEX_UPSTREAM_PREFIX}responses`;
const PROVIDER = "airkit-provider-codex-codex";

function jwt(payload) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode(payload)}.c2ln`;
}

const LIVE_TOKEN = jwt({ exp: Math.floor(NOW / 1000) + 3600, sentinel: "live-token-fixture" });
const EXPIRED_TOKEN = jwt({ exp: Math.floor(NOW / 1000) - 10, sentinel: "expired-token-fixture" });

function chatgptAuth({ token = LIVE_TOKEN, accountId = "acct-fixture" } = {}) {
  return {
    auth_mode: "chatgpt",
    tokens: { access_token: token, refresh_token: "refresh-fixture-never-used", id_token: "id-fixture", account_id: accountId },
    last_refresh: "2026-11-26T00:00:00Z",
  };
}

// A temporary HOME with ~/.codex/auth.json, mirroring the Codex CLI layout.
function fakeCodexHome(t, auth = chatgptAuth()) {
  const home = mkdtempSync(join(tmpdir(), "airkit-codex-auth-"));
  const codexDir = join(home, ".codex");
  mkdirSync(codexDir);
  t.after(() => {
    chmodSync(codexDir, 0o700);
    rmSync(home, { recursive: true, force: true });
  });
  const authFile = join(codexDir, "auth.json");
  if (auth !== null) writeFileSync(authFile, typeof auth === "string" ? auth : JSON.stringify(auth));
  return { codexDir, authFile };
}

function upstream(overrides = {}) {
  return {
    method: "POST",
    url: CODEX_URL,
    headers: {
      Authorization: `Bearer ${CODEX_AUTH_API_KEY}`,
      "x-api-key": "should-be-removed",
      "content-type": "application/json",
    },
    body: { model: "gpt-6.1-sol", input: [], max_output_tokens: 4096 },
    bodyEncoding: "json",
    ...overrides,
  };
}

function hookFor(authFile, options = {}) {
  return createCodexAuthHook({ authFile, providers: [PROVIDER], now: () => NOW, ...options });
}

function call(hook, ctx = {}) {
  return hook.transformRequest({ upstreamRequest: upstream(), targetProviderConfig: { name: PROVIDER }, ...ctx });
}

function assertNoSecrets(result) {
  const text = JSON.stringify(result);
  for (const secret of [LIVE_TOKEN, EXPIRED_TOKEN, "refresh-fixture-never-used", "live-token-fixture", "expired-token-fixture"]) {
    assert.equal(text.includes(secret), false, `result leaks ${secret.slice(0, 12)}…`);
  }
}

test("codex auth hook passes non-codex requests through untouched", (t) => {
  const { authFile } = fakeCodexHome(t);
  const hook = hookFor(authFile);
  const request = upstream({ url: "https://llm-gateway.example.test/v1/chat/completions" });
  const result = hook.transformRequest({ upstreamRequest: request, targetProviderConfig: { name: "airkit-provider-x-oneportal" } });
  assert.equal(result.ok, true);
  assert.equal(result.value, request);
});

test("codex auth hook passes non-codex requests even when auth.json is missing", (t) => {
  const { authFile } = fakeCodexHome(t, null);
  const request = upstream({ url: "https://api.example.test/v1/responses" });
  const result = hookFor(authFile).transformRequest({ upstreamRequest: request, targetProviderConfig: { name: "other" } });
  assert.deepEqual(result, { ok: true, value: request });
});

test("codex auth hook refuses a codex provider request aimed at another host", (t) => {
  const { authFile } = fakeCodexHome(t);
  for (const name of [PROVIDER, `${PROVIDER}-runtime-variant`]) {
    const result = hookFor(authFile).transformRequest({
      upstreamRequest: upstream({ url: "https://chatgpt.com.attacker.test/backend-api/codex/responses" }),
      targetProviderConfig: { name },
    });
    assert.equal(result.ok, false);
    assert.match(result.error, /does not target the ChatGPT Codex backend/);
  }
});

test("codex auth hook injects ChatGPT headers and normalizes the body", (t) => {
  const { authFile } = fakeCodexHome(t);
  const result = call(hookFor(authFile));
  assert.equal(result.ok, true);
  const { headers, body, url } = result.value;
  assert.equal(url, CODEX_URL);
  assert.equal(headers.authorization, `Bearer ${LIVE_TOKEN}`);
  assert.equal(headers["chatgpt-account-id"], "acct-fixture");
  assert.equal(headers.originator, "codex_cli_rs");
  assert.equal(headers["openai-beta"], "responses=experimental");
  assert.equal(headers.accept, "text/event-stream");
  assert.equal(headers["content-type"], "application/json");
  assert.equal("Authorization" in headers, false);
  assert.equal("x-api-key" in headers, false);
  assert.equal(body.store, false);
  assert.equal(body.stream, true);
  assert.equal(body.instructions, "You are a helpful assistant.");
  assert.deepEqual(body.include, ["reasoning.encrypted_content"]);
  assert.equal(body.max_output_tokens, 4096);
});

test("codex auth hook keeps caller instructions and existing include entries", (t) => {
  const { authFile } = fakeCodexHome(t);
  const result = call(hookFor(authFile), {
    upstreamRequest: upstream({ body: { instructions: "system prompt", include: ["file_search_call.results"], store: true, stream: false } }),
  });
  assert.equal(result.value.body.instructions, "system prompt");
  assert.deepEqual(result.value.body.include, ["file_search_call.results", "reasoning.encrypted_content"]);
  assert.equal(result.value.body.store, false);
  assert.equal(result.value.body.stream, true);
});

test("codex auth hook fails with the run-codex hint when auth.json is missing", (t) => {
  const { authFile } = fakeCodexHome(t, null);
  const result = call(hookFor(authFile));
  assert.equal(result.ok, false);
  assert.match(result.error, /Codex ChatGPT login not found/);
  assert.match(result.error, /run `codex` once/);
  assert.match(result.error, /never refreshes/);
});

test("codex auth hook fails without leaking tokens when the login expired", (t) => {
  const { authFile } = fakeCodexHome(t, chatgptAuth({ token: EXPIRED_TOKEN }));
  const result = call(hookFor(authFile));
  assert.equal(result.ok, false);
  assert.match(result.error, /expired: run `codex` once/);
  assertNoSecrets(result);
});

test("codex auth hook treats tokens within a minute of expiry as expired", (t) => {
  const { authFile } = fakeCodexHome(t, chatgptAuth({ token: jwt({ exp: Math.floor(NOW / 1000) + 30 }) }));
  assert.equal(call(hookFor(authFile)).ok, false);
});

test("codex auth hook rejects API-key logins, missing tokens and broken files", (t) => {
  const cases = [
    [{ ...chatgptAuth(), auth_mode: "apikey" }, /not logged in with a ChatGPT account/],
    [{ auth_mode: "chatgpt", tokens: { account_id: "acct" } }, /no access token/],
    [chatgptAuth({ accountId: "" }), /no ChatGPT account id/],
    ["{not json", /unreadable/],
  ];
  for (const [auth, pattern] of cases) {
    const { authFile } = fakeCodexHome(t, auth);
    const result = call(hookFor(authFile));
    assert.equal(result.ok, false);
    assert.match(result.error, pattern);
    assert.match(result.error, /run `codex` once/);
    assertNoSecrets(result);
  }
});

test("codex auth hook accepts an opaque token whose expiry cannot be read", (t) => {
  const { authFile } = fakeCodexHome(t, chatgptAuth({ token: "opaque-token" }));
  const result = call(hookFor(authFile));
  assert.equal(result.ok, true);
  assert.equal(result.value.headers.authorization, "Bearer opaque-token");
});

test("codex auth hook caches by file identity and reloads after codex rewrites auth.json", (t) => {
  const { authFile } = fakeCodexHome(t);
  let reads = 0;
  const fs = {
    statSync,
    readFileSync: (path, encoding) => { reads += 1; return readFileSync(path, encoding); },
  };
  const hook = hookFor(authFile, { fs });
  assert.equal(call(hook).ok, true);
  assert.equal(call(hook).ok, true);
  assert.equal(reads, 1);

  const next = jwt({ exp: Math.floor(NOW / 1000) + 7200, sentinel: "rotated" });
  writeFileSync(authFile, JSON.stringify(chatgptAuth({ token: next, accountId: "acct-rotated" })));
  utimesSync(authFile, new Date(NOW + 5000), new Date(NOW + 5000));
  const result = call(hook);
  assert.equal(reads, 2);
  assert.equal(result.value.headers.authorization, `Bearer ${next}`);
  assert.equal(result.value.headers["chatgpt-account-id"], "acct-rotated");
});

test("codex auth hook declines the gateway's forced-refresh retry when auth.json is unchanged", (t) => {
  const { authFile } = fakeCodexHome(t);
  const hook = hookFor(authFile);
  assert.equal(call(hook).ok, true);
  const retry = call(hook, { forceCodexOauthRefreshOnce: true });
  assert.equal(retry.ok, false);
  assert.match(retry.error, /ChatGPT rejected the Codex login: run `codex` once/);

  const next = jwt({ exp: Math.floor(NOW / 1000) + 7200 });
  writeFileSync(authFile, JSON.stringify(chatgptAuth({ token: next })));
  utimesSync(authFile, new Date(NOW + 9000), new Date(NOW + 9000));
  const refreshed = call(hook, { forceCodexOauthRefreshOnce: true });
  assert.equal(refreshed.ok, true);
  assert.equal(refreshed.value.headers.authorization, `Bearer ${next}`);
});

test("codex auth hook never writes, locks or refreshes auth.json", (t) => {
  const { codexDir, authFile } = fakeCodexHome(t);
  chmodSync(authFile, 0o400);
  chmodSync(codexDir, 0o500);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error("the codex auth hook must not call the network"); };
  t.after(() => { globalThis.fetch = originalFetch; });
  const hook = hookFor(authFile);
  assert.equal(call(hook).ok, true);
  assert.equal(call(hook, { forceCodexOauthRefreshOnce: true }).ok, false);
  assert.deepEqual(readdirSync(codexDir), ["auth.json"]);
});

test("codex auth hook rejects non-JSON bodies for codex requests", (t) => {
  const { authFile } = fakeCodexHome(t);
  const result = call(hookFor(authFile), { upstreamRequest: upstream({ body: new Uint8Array([1, 2]) }) });
  assert.equal(result.ok, false);
});

test("codex gateway plugin reads its settings from the plugin entry", (t) => {
  const { authFile } = fakeCodexHome(t);
  const plugin = createGatewayPlugin({ plugin: { key: "airkit-codex-auth", config: { authFile, providers: [PROVIDER] } } });
  assert.equal(plugin.providerHooks.length, 1);
  assert.equal(plugin.providerHooks[0].key, "airkit-codex-auth");
  assert.equal(createGatewayPlugin({ plugin: { config: {} } }).providerHooks.length, 1);
});

test("codex auth file follows CODEX_HOME like the Codex CLI", () => {
  assert.equal(defaultCodexAuthFile({ CODEX_HOME: "/tmp/codex-home" }), "/tmp/codex-home/auth.json");
  assert.match(defaultCodexAuthFile({}), /\/\.codex\/auth\.json$/);
});

test("describeCodexAuth reports state without credentials", (t) => {
  const { authFile } = fakeCodexHome(t);
  const state = describeCodexAuth(authFile, { now: NOW });
  assert.equal(state.ok, true);
  assert.equal(state.expiresAt, (Math.floor(NOW / 1000) + 3600) * 1000);
  assertNoSecrets(state);
  assert.equal(describeCodexAuth(join(authFile, "..", "absent.json")).reason, "missing");
});

test("isCodexAuthProvider recognizes catalog and managed codex providers", () => {
  assert.equal(isCodexAuthProvider({ auth: { kind: "codex-chatgpt" } }), true);
  assert.equal(isCodexAuthProvider({ api_key: CODEX_AUTH_API_KEY }), true);
  assert.equal(isCodexAuthProvider({ api_key: "ccr-local-agent-login" }), false);
  assert.equal(isCodexAuthProvider({}), false);
});
