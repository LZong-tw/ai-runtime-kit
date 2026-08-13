import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
} from "node:crypto";

export const AUDIT_KEY_PURPOSES = Object.freeze([
  "spool-event/v1",
  "request-evidence/v1",
  "provider-account-hmac/v1",
  "repository-identity-hmac/v1",
]);

const AUDIT_KEY_PURPOSE_SET = new Set(AUDIT_KEY_PURPOSES);
const AUDIT_ENCRYPTION_VERSION = 1;
const AUDIT_KEY_ID = "payload-master-v1";
const AES_256_GCM_KEY_BYTES = 32;
const AES_GCM_NONCE_BYTES = 12;

export function deriveAuditKey({ masterKey, purpose, identity }) {
  const keyMaterial = normalizeMasterKey(masterKey);
  if (!AUDIT_KEY_PURPOSE_SET.has(purpose)) {
    throw new Error(`unsupported audit key purpose: ${purpose}`);
  }
  if (typeof identity !== "string" || identity.length === 0) {
    throw new Error("audit key identity must be a non-empty string");
  }

  return Buffer.from(hkdfSync(
    "sha256",
    keyMaterial,
    Buffer.from("ai-runtime-kit:audit:v1"),
    Buffer.from(`${purpose}:${identity}`),
    AES_256_GCM_KEY_BYTES,
  ));
}

export function encryptAuditValue({ masterKey, purpose, identity, aad, plaintext, nonce } = {}) {
  const key = deriveAuditKey({ masterKey, purpose, identity });
  const nonceBuffer = nonce === undefined ? randomBytes(AES_GCM_NONCE_BYTES) : normalizeBuffer(nonce, "nonce");
  if (nonceBuffer.length !== AES_GCM_NONCE_BYTES) {
    throw new Error(`nonce must be ${AES_GCM_NONCE_BYTES} bytes`);
  }

  const plaintextBuffer = normalizeBuffer(plaintext, "plaintext");
  const cipher = createCipheriv("aes-256-gcm", key, nonceBuffer);
  if (aad !== undefined && aad !== null) cipher.setAAD(normalizeBuffer(aad, "aad"));
  const ciphertext = Buffer.concat([cipher.update(plaintextBuffer), cipher.final()]);

  return {
    version: AUDIT_ENCRYPTION_VERSION,
    keyId: AUDIT_KEY_ID,
    nonce: nonceBuffer.toString("hex"),
    ciphertext: ciphertext.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
  };
}

export function decryptAuditValue({ masterKey, purpose, identity, aad, encrypted } = {}) {
  const unpacked = typeof encrypted === "string" ? unpackEncryptedValue(encrypted) : encrypted;
  assertEncryptedValue(unpacked);

  const key = deriveAuditKey({ masterKey, purpose, identity });
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(unpacked.nonce, "hex"));
  if (aad !== undefined && aad !== null) decipher.setAAD(normalizeBuffer(aad, "aad"));
  decipher.setAuthTag(Buffer.from(unpacked.authTag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(unpacked.ciphertext, "base64")),
    decipher.final(),
  ]);
}

export function packEncryptedValue(encrypted) {
  assertEncryptedValue(encrypted);
  return JSON.stringify(encrypted);
}

export function unpackEncryptedValue(packed) {
  if (typeof packed !== "string") {
    throw new TypeError("packed encrypted value must be a string");
  }
  let parsed;
  try {
    parsed = JSON.parse(packed);
  } catch {
    throw new Error("packed encrypted value must be JSON");
  }
  assertEncryptedValue(parsed);
  return parsed;
}

function assertEncryptedValue(value) {
  if (!isRecord(value)) {
    throw new TypeError("encrypted audit value must be an object");
  }
  if (value.version !== AUDIT_ENCRYPTION_VERSION) {
    throw new Error(`encrypted audit value version must be ${AUDIT_ENCRYPTION_VERSION}`);
  }
  if (value.keyId !== AUDIT_KEY_ID) {
    throw new Error(`encrypted audit value keyId must be ${AUDIT_KEY_ID}`);
  }
  for (const field of ["nonce", "ciphertext", "authTag"]) {
    if (typeof value[field] !== "string" || value[field].length === 0) {
      throw new Error(`encrypted audit value ${field} must be a non-empty string`);
    }
  }
  if (Buffer.from(value.nonce, "hex").length !== AES_GCM_NONCE_BYTES) {
    throw new Error(`encrypted audit value nonce must be ${AES_GCM_NONCE_BYTES} bytes`);
  }
}

function normalizeMasterKey(value) {
  const key = normalizeBuffer(value, "masterKey");
  if (key.length < AES_256_GCM_KEY_BYTES) {
    throw new Error(`masterKey must be at least ${AES_256_GCM_KEY_BYTES} bytes`);
  }
  return key;
}

function normalizeBuffer(value, label) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (typeof value === "string") return Buffer.from(value, "utf8");
  throw new TypeError(`${label} must be a Buffer, Uint8Array, or string`);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
