import { createHash, randomBytes as nodeRandomBytes, verify as verifySignature } from "node:crypto";

export const AUDIT_AUDIT_REVEAL_UNAVAILABLE = "AIRKIT_AUDIT_REVEAL_UNAVAILABLE";
const TTL_MS = 30_000;

function unavailable(cause) {
  return Object.assign(new Error("audit payload reveal authorization unavailable", { cause }), {
    code: AUDIT_AUDIT_REVEAL_UNAVAILABLE,
  });
}

function required(value, name) {
  if (typeof value !== "string" || value.length === 0 || value.length > 512) throw unavailable(new Error(`invalid ${name}`));
  return value;
}

function bytes(value, name) {
  const result = Buffer.isBuffer(value) ? Buffer.from(value) : Buffer.from(value instanceof Uint8Array ? value : [],);
  if (result.length === 0) throw unavailable(new Error(`invalid ${name}`));
  return result;
}

export function revealAuthorizationMessage(challenge) {
  required(challenge?.requestId, "request id");
  required(challenge?.sessionId, "session id");
  required(challenge?.nonce, "nonce");
  if (!Number.isSafeInteger(challenge?.expiresAt)) throw unavailable(new Error("invalid expiry"));
  return `ai-runtime-kit.audit.reveal/v1\n${challenge.requestId}\n${challenge.sessionId}\n${challenge.nonce}\n${challenge.expiresAt}`;
}

function signatureBytes(value) {
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return Buffer.from(value);
  if (typeof value !== "string" || value.length === 0) throw unavailable(new Error("invalid signature"));
  try {
    return Buffer.from(value, "base64");
  } catch (error) {
    throw unavailable(error);
  }
}

export function createRevealAuthorizer({ runHelper, clock = () => Date.now(), randomBytes = nodeRandomBytes, env = process.env } = {}) {
  if (typeof runHelper !== "function") throw new TypeError("runHelper must be a function");
  const consumed = new Set();
  const helperCommand = env.AIRKIT_AUDIT_AUTH_HELPER || "airkit-audit-auth";

  const challenge = async ({ requestId, sessionId } = {}) => {
    const request = required(requestId, "request id");
    const session = required(sessionId, "session id");
    const nonce = Buffer.from(randomBytes(32)).toString("base64url");
    const expiresAt = clock() + TTL_MS;
    const value = { requestId: request, sessionId: session, nonce, expiresAt };
    const input = Buffer.from(revealAuthorizationMessage(value));
    try {
      const result = await runHelper({ command: helperCommand, args: ["sign", "--nonce-stdin"], input });
      if (!result || result.status !== 0) throw new Error("sign helper failed");
      const signature = result.stdout ?? result.output;
      if (signature == null) throw new Error("sign helper returned no signature");
      return { ...value, signature: Buffer.isBuffer(signature) ? signature.toString("base64") : String(signature).trim() };
    } catch (error) {
      if (error?.code === AUDIT_AUDIT_REVEAL_UNAVAILABLE) throw error;
      throw unavailable(error);
    }
  };

  const verifyAndConsume = async ({ challenge: value, requestId, sessionId, signature, publicKey } = {}) => {
    try {
      if (!value || value.requestId !== required(requestId, "request id") || value.sessionId !== required(sessionId, "session id")) throw unavailable(new Error("challenge binding mismatch"));
      const now = clock();
      if (!Number.isSafeInteger(value.expiresAt) || now > value.expiresAt || now < value.expiresAt - TTL_MS) throw unavailable(new Error("challenge expired"));
      const digest = createHash("sha256").update(revealAuthorizationMessage(value)).digest("hex");
      if (consumed.has(digest)) throw unavailable(new Error("challenge replay"));
      consumed.add(digest);
      const message = Buffer.from(revealAuthorizationMessage(value));
      const sig = signatureBytes(signature ?? value.signature);
      if (!publicKey) throw unavailable(new Error("missing public key"));
      const valid = typeof publicKey.verify === "function"
        ? await publicKey.verify(message, sig)
        : verifySignature("sha256", message, publicKey, sig);
      if (!valid) throw unavailable(new Error("invalid reveal signature"));
      return true;
    } catch (error) {
      if (error?.code === AUDIT_AUDIT_REVEAL_UNAVAILABLE) throw error;
      throw unavailable(error);
    }
  };

  return { challenge, verifyAndConsume };
}
