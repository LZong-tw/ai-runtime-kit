import { createHmac } from "node:crypto";

const REPOSITORY_PURPOSE = "repository-identity-hmac/v1";
const ACCOUNT_PURPOSE = "provider-account-hmac/v1";

export function resolveRepositoryIdentity(input = {}, masterKey) {
  const root = normalizeRoot(input.root ?? input.path);
  const remote = sanitizeRemote(input.remote ?? input.url);
  if (!root && !remote) throw new TypeError("repository root or remote is required");
  const canonical = JSON.stringify({ root, remote });
  const identityHash = hmac(masterKey, REPOSITORY_PURPOSE, canonical);
  return {
    repositoryId: `repo-${identityHash.slice(0, 32)}`,
    identityHash,
    canonicalRemote: remote,
    source: "derived",
    confidence: 1,
  };
}

export function resolveProviderAccountIdentity(input = {}, masterKey) {
  const provider = safeText(input.provider);
  if (!provider) throw new TypeError("provider is required");
  const endpoint = sanitizeRemote(input.endpoint ?? input.baseUrl);
  const account = safeText(input.account ?? input.accountRef ?? input.credentialRef);
  const canonical = JSON.stringify({
    provider,
    endpoint,
    account,
    credentialKind: safeText(input.credentialKind),
  });
  const accountHmac = hmac(masterKey, ACCOUNT_PURPOSE, canonical);
  return {
    providerAccountId: `acct-${accountHmac.slice(0, 32)}`,
    accountHmac,
    provider,
    endpoint,
    logicalGroup: safeText(input.logicalGroup),
    credentialKind: safeText(input.credentialKind),
    source: "derived",
    confidence: 1,
  };
}

export function sanitizeRemote(value) {
  if (typeof value !== "string" || value.length === 0) return null;
  try {
    const parsed = new URL(value.includes("://") ? value : `https://${value}`);
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return value
      .replace(/\/\/[^/@\s]+@/g, "//")
      .replace(/[?].*$/, "")
      .replace(/[#].*$/, "")
      .slice(0, 512);
  }
}

function normalizeRoot(value) {
  if (typeof value !== "string" || value.length === 0) return null;
  return value.replaceAll("\\", "/").replace(/\/+$/, "").slice(0, 1024);
}

function hmac(masterKey, purpose, value) {
  if (typeof masterKey !== "string" && !Buffer.isBuffer(masterKey) && !(masterKey instanceof Uint8Array)) {
    throw new TypeError("masterKey is required");
  }
  return createHmac("sha256", masterKey).update(`${purpose}\n${value}`, "utf8").digest("hex");
}

function safeText(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 512 ? value : null;
}
