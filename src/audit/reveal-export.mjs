import { createHash, createPublicKey } from "node:crypto";
import { createInterface } from "node:readline/promises";

import { decryptAuditValue } from "./crypto.mjs";

const P256_SPKI_PREFIX = Buffer.from("3059301306072a8648ce3d020106082a8648ce3d030107034200", "hex");

export function createRevealExportCoordinator({
  authorizer,
  masterKeyProvider,
  runHelper,
  publicKey,
  confirm,
  helperCommand = "airkit-audit-auth",
  env = process.env,
} = {}) {
  if (!authorizer || typeof authorizer.challenge !== "function" || typeof authorizer.verifyAndConsume !== "function") {
    throw new TypeError("reveal authorizer is required");
  }
  if (!masterKeyProvider || typeof masterKeyProvider.get !== "function") {
    throw new TypeError("master key provider is required");
  }
  if (typeof confirm !== "function") throw new TypeError("reveal confirmation is required");
  let authorizedManifest;
  let resolvedPublicKey = publicKey;

  return {
    async authorizeExport({ rows, outputPath, format } = {}) {
      const manifest = exportManifest(rows, { outputPath, format });
      if (!(await confirm({ manifest: manifest.id, rows: manifest.rows.size, outputPath }))) return false;
      const challenge = await authorizer.challenge({ requestId: manifest.id, sessionId: "audit-export" });
      resolvedPublicKey ??= await loadPublicKey({ runHelper, helperCommand, env });
      await authorizer.verifyAndConsume({
        challenge,
        requestId: manifest.id,
        sessionId: "audit-export",
        publicKey: resolvedPublicKey,
      });
      authorizedManifest = manifest;
      return true;
    },

    async decryptRow(row) {
      if (!authorizedManifest || !authorizedManifest.rows.has(rowIdentity(row))) {
        throw codedError("AIRKIT_AUDIT_REVEAL_UNAVAILABLE", "payload is outside the authorized export");
      }
      if (!row?.ciphertext || !row.nonce || !row.auth_tag || !row.key_id) {
        throw codedError("AIRKIT_AUDIT_REVEAL_UNAVAILABLE", "payload has no encrypted evidence");
      }
      const identity = row.attempt_id || row.payload_event_id;
      if (!identity) throw codedError("AIRKIT_AUDIT_REVEAL_UNAVAILABLE", "payload has no evidence identity");
      const plaintext = decryptAuditValue({
        masterKey: await masterKeyProvider.get(),
        purpose: "request-evidence/v1",
        identity,
        aad: row.payload_event_id,
        encrypted: {
          version: 1,
          keyId: row.key_id,
          nonce: row.nonce,
          ciphertext: row.ciphertext,
          authTag: row.auth_tag,
        },
      });
      try {
        return JSON.parse(plaintext.toString("utf8"));
      } catch (error) {
        throw codedError("AIRKIT_AUDIT_REVEAL_UNAVAILABLE", "decrypted payload is not JSON", error);
      }
    },
  };
}

export function createInteractiveRevealConfirmation({ input = process.stdin, output = process.stderr } = {}) {
  return async () => {
    if (!input?.isTTY || !output?.isTTY) return false;
    const readline = createInterface({ input, output });
    try {
      const answer = await readline.question("Reveal encrypted audit payloads to the requested file? [y/N] ");
      return /^y(?:es)?$/i.test(answer.trim());
    } finally {
      readline.close();
    }
  };
}

export function exportManifest(rows, { outputPath, format } = {}) {
  const entries = rows.map((row) => rowIdentity(row));
  const material = JSON.stringify({ entries, outputPath: outputPath ?? null, format: format ?? "jsonl" });
  const id = `audit-export-${createHash("sha256").update(material).digest("hex")}`;
  return { id, rows: new Set(entries) };
}

function rowIdentity(row) {
  const request = requireIdentity(row?.request_id, "request id");
  const payload = row?.payload_event_id ?? "none";
  const attempt = row?.attempt_id ?? "none";
  return `${request}\u0000${payload}\u0000${attempt}`;
}

async function loadPublicKey({ runHelper, helperCommand, env }) {
  if (typeof runHelper !== "function") throw codedError("AIRKIT_AUDIT_REVEAL_UNAVAILABLE", "reveal helper is unavailable");
  const result = await runHelper({ command: env.AIRKIT_AUDIT_AUTH_HELPER || helperCommand, args: ["public-key"] });
  if (!result || result.status !== 0) throw codedError("AIRKIT_AUDIT_REVEAL_UNAVAILABLE", "reveal public key is unavailable");
  const value = Buffer.from(String(result.stdout ?? result.output ?? "").trim(), "base64");
  if (value.length !== 65 || value[0] !== 0x04) throw codedError("AIRKIT_AUDIT_REVEAL_UNAVAILABLE", "reveal public key is invalid");
  try {
    return createPublicKey({ key: Buffer.concat([P256_SPKI_PREFIX, value]), format: "der", type: "spki" });
  } catch (error) {
    throw codedError("AIRKIT_AUDIT_REVEAL_UNAVAILABLE", "reveal public key could not be loaded", error);
  }
}

function requireIdentity(value, label) {
  if (typeof value !== "string" || value.length === 0 || value.length > 512) {
    throw codedError("AIRKIT_AUDIT_REVEAL_UNAVAILABLE", `${label} is unavailable`);
  }
  return value;
}

function codedError(code, message, cause) {
  return Object.assign(new Error(message, { cause }), { code });
}
