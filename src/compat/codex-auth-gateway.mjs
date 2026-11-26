// ai-gateway module plugin that authenticates requests to the ChatGPT Codex
// backend with the credentials the Codex CLI keeps in ~/.codex/auth.json.
//
// The file belongs to the Codex CLI. This hook only ever reads it: no refresh,
// no write, no auth.json.lock. CCR's built-in Codex login path is avoided on
// purpose because ai-gateway's codexOauth plugin refreshes the token (on
// expiry, on missing scopes and after any upstream 401) and that would race
// the Codex CLI's own refresh-token rotation. When the token is missing or
// expired, the request fails with a message telling the user to run `codex`.
//
// Every value read from auth.json stays inside this module. Error strings are
// logged by the gateway, so they never interpolate file contents.
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const CODEX_AUTH_PLUGIN_ID = "airkit-codex-auth";
// CCR needs a non-empty api_key. This marker is not a credential: the hook
// replaces the bearer it produces. It must never equal CCR's
// "ccr-local-agent-login", which opts the provider into the refreshing path.
export const CODEX_AUTH_API_KEY = "airkit-codex-auth-json";
export const CODEX_API_BASE_URL = "https://chatgpt.com/backend-api/codex/responses";
export const CODEX_UPSTREAM_PREFIX = "https://chatgpt.com/backend-api/codex/";
export const CODEX_LOGIN_HINT = "run `codex` once so the Codex CLI refreshes ~/.codex/auth.json "
  + "(AirKit only reads that file and never refreshes or writes it)";

const DEFAULT_INSTRUCTIONS = "You are a helpful assistant.";
const EXPIRY_SKEW_MS = 60_000;
const REPLACED_HEADERS = new Set([
  "authorization", "x-api-key", "api-key", "chatgpt-account-id", "originator", "openai-beta", "accept",
]);

// Same lookup as the Codex CLI: $CODEX_HOME, else ~/.codex.
export function defaultCodexAuthFile(env = process.env) {
  return join(env.CODEX_HOME || join(homedir(), ".codex"), "auth.json");
}

// The marker is the only identity. Anything weaker (a separate flag next to
// some other api_key) could pair with CCR's "ccr-local-agent-login" and
// re-enable the refreshing path this module exists to avoid.
export function isCodexAuthProvider(provider) {
  return provider?.api_key === CODEX_AUTH_API_KEY;
}

// Any base URL on the Codex backend, matched the way CCR's own Codex check
// does (same origin, path prefix). Used to refuse providers that would reach
// chatgpt.com without going through the marker.
export function isCodexBackendUrl(value) {
  try {
    const url = new URL(value);
    const base = new URL(CODEX_UPSTREAM_PREFIX);
    return url.origin === base.origin
      && url.pathname.toLowerCase().startsWith(base.pathname.toLowerCase().replace(/\/$/, ""));
  } catch {
    return false;
  }
}

// Reads and checks auth.json. The result carries the token only under
// `credentials`; callers that report state (doctor) use describeCodexAuth.
export function readCodexAuth(authFile, { now = Date.now(), fs = { readFileSync } } = {}) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(authFile, "utf8"));
  } catch (error) {
    return { ok: false, reason: error?.code === "ENOENT" ? "missing" : "unreadable" };
  }
  if (parsed?.auth_mode !== "chatgpt") return { ok: false, reason: "not-chatgpt-login" };
  const accessToken = parsed.tokens?.access_token;
  const accountId = parsed.tokens?.account_id;
  if (typeof accessToken !== "string" || accessToken === "") return { ok: false, reason: "no-access-token" };
  if (typeof accountId !== "string" || accountId === "") return { ok: false, reason: "no-account-id" };
  const expiresAt = jwtExpiry(accessToken);
  // An opaque token has no readable expiry. Treat that as unknown and let the
  // upstream decide, rather than refusing every request.
  if (expiresAt !== null && expiresAt - EXPIRY_SKEW_MS <= now) {
    return { ok: false, reason: "expired", expiresAt };
  }
  return { ok: true, expiresAt, credentials: { accessToken, accountId } };
}

export function describeCodexAuth(authFile, options) {
  const { credentials: _credentials, ...state } = readCodexAuth(authFile, options);
  return state;
}

export function codexAuthFailureMessage(reason) {
  const problem = {
    missing: "Codex ChatGPT login not found",
    unreadable: "Codex auth.json is unreadable",
    "not-chatgpt-login": "Codex is not logged in with a ChatGPT account",
    "no-access-token": "Codex auth.json has no access token",
    "no-account-id": "Codex auth.json has no ChatGPT account id",
    expired: "Codex ChatGPT login expired",
    rejected: "ChatGPT rejected the Codex login",
  }[reason] ?? "Codex ChatGPT login unavailable";
  return `${problem}: ${CODEX_LOGIN_HINT}`;
}

function jwtExpiry(token) {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const exp = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"))?.exp;
    return Number.isFinite(exp) ? exp * 1000 : null;
  } catch {
    return null;
  }
}

function fileIdentity(stat) {
  return `${stat.ino}:${stat.size}:${stat.mtimeMs}`;
}

function isCodexUrl(url, upstreamPrefix) {
  return typeof url === "string" && url.startsWith(upstreamPrefix);
}

function hasProviderName(providers, name) {
  if (typeof name !== "string" || name === "") return false;
  // CCR may register runtime variants of a provider under a derived name.
  return providers.some((provider) => name === provider || name.startsWith(`${provider}-runtime-`));
}

function normalizedHeaders(headers, credentials) {
  const result = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (!REPLACED_HEADERS.has(name.toLowerCase())) result[name] = value;
  }
  result.authorization = `Bearer ${credentials.accessToken}`;
  result["chatgpt-account-id"] = credentials.accountId;
  result.originator = "codex_cli_rs";
  result["openai-beta"] = "responses=experimental";
  result.accept = "text/event-stream";
  return result;
}

function normalizedBody(body) {
  const include = Array.isArray(body.include) ? body.include : [];
  return {
    ...body,
    store: false,
    stream: true,
    instructions: typeof body.instructions === "string" && body.instructions.trim() !== ""
      ? body.instructions
      : DEFAULT_INSTRUCTIONS,
    include: include.includes("reasoning.encrypted_content")
      ? include
      : [...include, "reasoning.encrypted_content"],
  };
}

export function createCodexAuthHook({
  authFile,
  upstreamPrefix = CODEX_UPSTREAM_PREFIX,
  providers = [],
  now = Date.now,
  fs = { readFileSync, statSync },
} = {}) {
  if (typeof authFile !== "string" || authFile === "") throw new Error("codex auth hook requires authFile");
  if (typeof upstreamPrefix !== "string" || !/^https?:\/\/[^/]+\/.+\/$/.test(upstreamPrefix)) {
    throw new Error("codex auth hook upstreamPrefix must be an absolute URL prefix ending in /");
  }
  let cached = null;

  const fail = (reason) => ({ ok: false, error: codexAuthFailureMessage(reason) });

  return {
    key: CODEX_AUTH_PLUGIN_ID,
    transformRequest(ctx) {
      const upstreamRequest = ctx?.upstreamRequest;
      const url = upstreamRequest?.url;
      if (!isCodexUrl(url, upstreamPrefix)) {
        // The ChatGPT bearer goes to the Codex backend only. A codex provider
        // whose request points anywhere else is refused, not forwarded bare.
        if (hasProviderName(providers, ctx?.targetProviderConfig?.name ?? ctx?.targetProviderName)) {
          return { ok: false, error: "Codex provider request does not target the ChatGPT Codex backend; refusing to send it" };
        }
        return { ok: true, value: upstreamRequest };
      }
      if (upstreamRequest.body === null || typeof upstreamRequest.body !== "object"
        || Array.isArray(upstreamRequest.body) || upstreamRequest.body instanceof Uint8Array) {
        return { ok: false, error: "Codex provider request body must be JSON" };
      }

      let identity;
      try {
        identity = fileIdentity(fs.statSync(authFile));
      } catch (error) {
        cached = null;
        return fail(error?.code === "ENOENT" ? "missing" : "unreadable");
      }
      const unchanged = cached?.identity === identity;
      // ai-gateway retries a 401 once with this flag set, expecting a refresh.
      // Nothing changed on disk, so a second call would fail the same way;
      // declining makes the gateway return the original 401.
      if (ctx.forceCodexOauthRefreshOnce === true && unchanged) return fail("rejected");
      if (!unchanged) cached = { identity, auth: readCodexAuth(authFile, { now: now(), fs }) };
      let auth = cached.auth;
      if (auth.ok && auth.expiresAt !== null && auth.expiresAt - EXPIRY_SKEW_MS <= now()) {
        auth = { ok: false, reason: "expired" };
      }
      if (!auth.ok) return fail(auth.reason);

      return {
        ok: true,
        value: {
          ...upstreamRequest,
          headers: normalizedHeaders(upstreamRequest.headers, auth.credentials),
          body: normalizedBody(upstreamRequest.body),
        },
      };
    },
  };
}

// The persisted CCR config is editable by anything that can write it, so it
// only supplies the provider names. Where the bearer may go and which file it
// comes from stay fixed in code; createCodexAuthHook keeps them as test seams.
export function createGatewayPlugin({ plugin } = {}) {
  const config = plugin?.config ?? {};
  return {
    providerHooks: [createCodexAuthHook({
      authFile: defaultCodexAuthFile(),
      upstreamPrefix: CODEX_UPSTREAM_PREFIX,
      providers: Array.isArray(config.providers) ? config.providers : [],
    })],
  };
}

export default createGatewayPlugin;
