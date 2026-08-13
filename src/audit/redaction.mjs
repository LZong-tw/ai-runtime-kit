const REDACTED = "[redacted]";

const USAGE_FIELDS = Object.freeze([
  "cache_creation_input_tokens",
  "cache_read_input_tokens",
  "input_tokens",
  "output_tokens",
  "total_tokens",
]);

const CREDENTIAL_KEY_PATTERNS = Object.freeze([
  [/^authorization$/i, "authorization"],
  [/^proxy-authorization$/i, "authorization"],
  [/^cookie$/i, "cookie"],
  [/^set-cookie$/i, "cookie"],
  [/(^|[-_])api[-_]?key$/i, "api_key"],
  [/^(api[-_]?key|apikey)$/i, "api_key"],
  [/^access[-_]?token$/i, "access_token"],
  [/^refresh[-_]?token$/i, "refresh_token"],
  [/^id[-_]?token$/i, "id_token"],
  [/^token$/i, "token"],
  [/^password$/i, "password"],
  [/secret/i, "secret"],
  [/credential/i, "credential"],
  [/private[-_]?key/i, "private_key"],
]);

const CREDENTIAL_VALUE_PATTERNS = Object.freeze([
  [/\bBasic\s+[A-Za-z0-9+/]+={0,2}\b/i, "authorization"],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+\b/i, "authorization"],
  [/\bsk-[A-Za-z0-9][A-Za-z0-9_-]{8,}\b/, "api_key"],
  [new RegExp(`\\b${"AK"}${"IA"}[0-9A-Z]{16}\\b`), "aws_access_key"],
  [/\bgh[pousr]_[A-Za-z0-9_]{20,}\b/, "github_token"],
]);

export function redactEvidence(value, options = {}) {
  if (!isRecord(options)) {
    throw new TypeError("redaction options must be an object");
  }

  const credentialKinds = new Set();
  const { value: redacted, redactionCount } = redactValue(value, null, credentialKinds);
  return {
    state: "complete",
    value: redacted,
    redactionCount,
    credentialKinds: [...credentialKinds].sort(),
    reason: null,
  };
}

export function allowlistedUsage(usage) {
  if (!isRecord(usage)) return null;

  const allowed = {};
  for (const field of USAGE_FIELDS) {
    const value = usage[field];
    if (Number.isFinite(value)) allowed[field] = value;
  }
  return Object.freeze(allowed);
}

export function canonicalizeEvidence(value) {
  return JSON.stringify(sortObjectKeys(value));
}

function redactValue(value, key, credentialKinds) {
  const keyKind = credentialKindForKey(key);
  if (keyKind !== null) {
    credentialKinds.add(keyKind);
    return { value: REDACTED, redactionCount: 1 };
  }

  if (typeof value === "string") {
    const valueKind = credentialKindForValue(value);
    if (valueKind !== null) {
      credentialKinds.add(valueKind);
      return { value: REDACTED, redactionCount: 1 };
    }
    return { value, redactionCount: 0 };
  }

  if (Array.isArray(value)) {
    let redactionCount = 0;
    const redacted = value.map((entry) => {
      const result = redactValue(entry, null, credentialKinds);
      redactionCount += result.redactionCount;
      return result.value;
    });
    return { value: redacted, redactionCount };
  }

  if (isRecord(value)) {
    let redactionCount = 0;
    const redacted = {};
    for (const [entryKey, entryValue] of Object.entries(value)) {
      const result = redactValue(entryValue, entryKey, credentialKinds);
      redactionCount += result.redactionCount;
      redacted[entryKey] = result.value;
    }
    return { value: redacted, redactionCount };
  }

  return { value, redactionCount: 0 };
}

function credentialKindForKey(key) {
  if (typeof key !== "string") return null;
  for (const [pattern, kind] of CREDENTIAL_KEY_PATTERNS) {
    if (pattern.test(key)) return kind;
  }
  return null;
}

function credentialKindForValue(value) {
  for (const [pattern, kind] of CREDENTIAL_VALUE_PATTERNS) {
    if (pattern.test(value)) return kind;
  }
  return null;
}

function sortObjectKeys(value) {
  if (Array.isArray(value)) return value.map(sortObjectKeys);
  if (!isRecord(value)) return value;

  const sorted = {};
  for (const key of Object.keys(value).sort()) {
    const entry = value[key];
    if (entry !== undefined) sorted[key] = sortObjectKeys(entry);
  }
  return sorted;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
