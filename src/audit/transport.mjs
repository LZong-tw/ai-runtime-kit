import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { createConnection } from "node:net";

import { packEncryptedValue } from "./crypto.mjs";

const DEFAULT_MAX_FRAME_BYTES = 256 * 1024;
const DEFAULT_READ_TIMEOUT_MS = 5_000;

export function encodeAuditFrame(value) {
  const payload = Buffer.from(JSON.stringify(value), "utf8");
  const frame = Buffer.allocUnsafe(4 + payload.length);
  frame.writeUInt32BE(payload.length, 0);
  payload.copy(frame, 4);
  return frame;
}

export function createAuditFrameDecoder(options = {}) {
  const maxFrameBytes = options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
  const readTimeoutMs = options.readTimeoutMs ?? DEFAULT_READ_TIMEOUT_MS;
  if (!Number.isInteger(maxFrameBytes) || maxFrameBytes < 1) {
    throw new TypeError("maxFrameBytes must be a positive integer");
  }
  if (!Number.isFinite(readTimeoutMs) || readTimeoutMs <= 0) {
    throw new TypeError("readTimeoutMs must be positive");
  }

  let expectedBytes = null;
  let buffered = Buffer.alloc(0);
  let complete = false;

  return {
    maxFrameBytes,
    readTimeoutMs,
    push(chunk) {
      if (!Buffer.isBuffer(chunk) && !(chunk instanceof Uint8Array)) {
        throw new TypeError("frame chunk must be a Buffer or Uint8Array");
      }
      if (complete) {
        if (chunk.length === 0) return null;
        throw new Error("transport allows only one frame per connection");
      }

      buffered = Buffer.concat([buffered, Buffer.from(chunk)]);
      if (expectedBytes === null && buffered.length >= 4) {
        expectedBytes = buffered.readUInt32BE(0);
        if (expectedBytes < 2) throw new Error("frame payload must be a JSON object");
        if (expectedBytes > maxFrameBytes) throw new Error(`frame exceeds ${maxFrameBytes} bytes`);
      }
      if (expectedBytes === null) return null;

      const totalBytes = 4 + expectedBytes;
      if (buffered.length < totalBytes) return null;
      if (buffered.length > totalBytes) {
        throw new Error("transport allows only one frame per connection");
      }

      const payload = buffered.subarray(4, totalBytes).toString("utf8");
      let parsed;
      try {
        parsed = JSON.parse(payload);
      } catch {
        throw new Error("frame payload must be valid JSON");
      }
      if (!isRecord(parsed)) throw new Error("frame payload must be a JSON object");

      complete = true;
      return parsed;
    },
  };
}

export function createAuditClient(options = {}) {
  const socketPath = options.socketPath;
  const capability = normalizeCapability(options.capability);
  const timeoutMs = options.timeoutMs ?? DEFAULT_READ_TIMEOUT_MS;
  const maxFrameBytes = options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;

  if (typeof socketPath !== "string" || socketPath.length === 0) {
    throw new TypeError("socketPath is required");
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError("timeoutMs must be positive");
  }

  return {
    send(envelope) {
      const authenticated = authenticateEnvelope(envelope, capability);
      const ackDecoder = createAuditFrameDecoder({ maxFrameBytes, readTimeoutMs: timeoutMs });

      return new Promise((resolve, reject) => {
        const socket = createConnection(socketPath);
        let settled = false;
        let ack = null;

        const finish = (error, value) => {
          if (settled) return;
          settled = true;
          if (error) reject(error);
          else resolve(value);
        };

        socket.setTimeout(timeoutMs);
        socket.once("connect", () => {
          socket.end(encodeAuditFrame(authenticated));
        });
        socket.on("data", (chunk) => {
          try {
            ack = ackDecoder.push(chunk);
            if (ack === null) return;
            if (ack.event_id !== authenticated.event_id) {
              throw new Error("ACK event_id mismatch");
            }
            if (ack.status !== "committed" && ack.status !== "duplicate") {
              throw new Error(`unexpected ACK status: ${ack.status}`);
            }
            finish(null, ack);
          } catch (error) {
            socket.destroy();
            finish(error);
          }
        });
        socket.once("timeout", () => {
          socket.destroy();
          finish(new Error("audit transport timeout"));
        });
        socket.once("error", (error) => finish(error));
        socket.once("close", () => {
          if (!settled && ack === null) {
            finish(new Error("authorization or transport failure before ACK"));
          }
        });
      });
    },
  };
}

export function authenticateEnvelope(envelope, capability) {
  if (!isRecord(envelope)) throw new TypeError("envelope must be an object");
  if (typeof envelope.event_id !== "string" || envelope.event_id.length === 0) {
    throw new TypeError("envelope.event_id is required");
  }
  if (!isRecord(envelope.encrypted)) {
    throw new TypeError("envelope.encrypted is required");
  }

  const ciphertextHash = hashCiphertext(envelope.encrypted);
  return Object.freeze({
    event_id: envelope.event_id,
    encrypted: envelope.encrypted,
    ciphertext_hash: ciphertextHash,
    capability_hmac: signCapability({
      capability,
      eventId: envelope.event_id,
      ciphertextHash,
    }),
  });
}

export function verifyEnvelopeAuthorization(frame, capability) {
  if (!isRecord(frame)) return false;
  if (typeof frame.event_id !== "string" || frame.event_id.length === 0) return false;
  if (!isRecord(frame.encrypted)) return false;
  if (typeof frame.ciphertext_hash !== "string" || frame.ciphertext_hash.length === 0) return false;
  if (typeof frame.capability_hmac !== "string" || frame.capability_hmac.length === 0) return false;

  const expectedHash = hashCiphertext(frame.encrypted);
  if (!safeEqual(frame.ciphertext_hash, expectedHash)) return false;

  const expectedHmac = signCapability({
    capability,
    eventId: frame.event_id,
    ciphertextHash: expectedHash,
  });
  return safeEqual(frame.capability_hmac, expectedHmac);
}

export function hashCiphertext(encrypted) {
  return createHash("sha256").update(packEncryptedValue(encrypted), "utf8").digest("hex");
}

function signCapability({ capability, eventId, ciphertextHash }) {
  return createHmac("sha256", capability)
    .update(`${eventId}.${ciphertextHash}`, "utf8")
    .digest("hex");
}

function safeEqual(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  if (leftBytes.length !== rightBytes.length) return false;
  return timingSafeEqual(leftBytes, rightBytes);
}

function normalizeCapability(value) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError("capability must be a non-empty string");
  }
  return value;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
