import { randomBytes as nodeRandomBytes } from "node:crypto";

export const AUDIT_KEYCHAIN_SERVICE = "ai-runtime-kit.audit";
export const AUDIT_KEYCHAIN_ACCOUNT = "payload-master-v1";

function failure(message, cause) {
  return Object.assign(new Error(message, { cause }), { code: "AIRKIT_AUDIT_KEYCHAIN_UNAVAILABLE" });
}

function outputBytes(result) {
  const value = result?.stdout ?? result?.output ?? "";
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  const text = String(value).trim();
  if (/^[0-9a-f]{64}$/i.test(text)) return Buffer.from(text, "hex");
  return Buffer.from(text, "base64");
}

async function invoke(runSecurity, request) {
  const result = await runSecurity(request);
  if (!result || result.status !== 0) throw failure("audit Keychain operation unavailable");
  return result;
}

/**
 * The runner is injected so callers can enforce a pipe-only subprocess policy.
 * It receives `{ command, args, input }`; secret material is only ever `input`
 * or the returned stdout bytes, and is never part of `args`.
 */
export function createMasterKeyProvider({ runSecurity, env = process.env, randomBytes = nodeRandomBytes } = {}) {
  if (typeof runSecurity !== "function") throw new TypeError("runSecurity must be a function");
  const command = env.AIRKIT_SECURITY_PATH || "security";
  const identity = ["-s", AUDIT_KEYCHAIN_SERVICE, "-a", AUDIT_KEYCHAIN_ACCOUNT];

  const inspect = async () => {
    try {
      await invoke(runSecurity, { command, args: ["find-generic-password", ...identity] });
      return true;
    } catch (error) {
      if (error?.code === "AIRKIT_AUDIT_KEYCHAIN_UNAVAILABLE") return false;
      throw error;
    }
  };

  const create = async () => {
    const key = Buffer.from(randomBytes(32));
    if (key.length !== 32) throw failure("audit master key has invalid length");
    try {
      await invoke(runSecurity, {
        command,
        args: ["add-generic-password", "-U", ...identity, "-w"],
        // `security -w` reads a textual password. Store a stable hex
        // representation so the daemon can retrieve the exact 32 bytes.
        input: Buffer.from(`${key.toString("hex")}\n`, "utf8"),
      });
      return key;
    } catch (error) {
      throw error?.code === "AIRKIT_AUDIT_KEYCHAIN_UNAVAILABLE" ? error : failure("audit Keychain create failed", error);
    }
  };

  const get = async () => {
    try {
      const result = await invoke(runSecurity, { command, args: ["find-generic-password", ...identity, "-w"] });
      const key = outputBytes(result);
      if (key.length !== 32) throw failure("audit master key has invalid length");
      return key;
    } catch (error) {
      throw error?.code === "AIRKIT_AUDIT_KEYCHAIN_UNAVAILABLE" ? error : failure("audit Keychain read failed", error);
    }
  };

  return { inspect, create, get };
}
