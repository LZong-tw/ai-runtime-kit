import { randomBytes as nodeRandomBytes } from "node:crypto";

export const AUDIT_KEYCHAIN_SERVICE = "ai-runtime-kit.audit";
export const AUDIT_KEYCHAIN_ACCOUNT = "payload-master-v1";
export const AUDIT_KEYCHAIN_NEXT_ACCOUNT = "payload-master-v2";

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
export function createMasterKeyProvider({ runSecurity, runKeychainHelper = null, keychainHelperPath = null, env = process.env, randomBytes = nodeRandomBytes } = {}) {
  if (typeof runSecurity !== "function") throw new TypeError("runSecurity must be a function");
  const command = env.AIRKIT_SECURITY_PATH || "security";
  const identityFor = (account) => ["-s", AUDIT_KEYCHAIN_SERVICE, "-a", account];

  const readAccount = async (account) => {
    const identity = identityFor(account);
    const result = account === AUDIT_KEYCHAIN_NEXT_ACCOUNT && typeof runKeychainHelper === "function"
      ? await invoke(runKeychainHelper, { command: "swift", args: [keychainHelperPath, "read", account] })
      : await invoke(runSecurity, { command, args: ["find-generic-password", ...identity, "-w"] });
    const key = outputBytes(result);
    if (key.length !== 32) throw failure("audit master key has invalid length");
    return key;
  };

  const inspect = async () => {
    try {
      await readAccount(AUDIT_KEYCHAIN_NEXT_ACCOUNT);
      return true;
    } catch (error) {
      if (error?.code !== "AIRKIT_AUDIT_KEYCHAIN_UNAVAILABLE") throw error;
      try {
        await readAccount(AUDIT_KEYCHAIN_ACCOUNT);
        return true;
      } catch (legacyError) {
        if (legacyError?.code === "AIRKIT_AUDIT_KEYCHAIN_UNAVAILABLE") return false;
        throw legacyError;
      }
    }
  };

  const create = async () => {
    const key = Buffer.from(randomBytes(32));
    if (key.length !== 32) throw failure("audit master key has invalid length");
    try {
      const identity = identityFor(AUDIT_KEYCHAIN_NEXT_ACCOUNT);
      const request = { command, args: ["add-generic-password", "-U", ...identity, "-w"], input: key };
      if (typeof runKeychainHelper === "function") {
        if (typeof keychainHelperPath !== "string" || keychainHelperPath.length === 0) throw failure("audit Keychain helper path unavailable");
        await invoke(runKeychainHelper, { command: "swift", args: [keychainHelperPath, "store", AUDIT_KEYCHAIN_NEXT_ACCOUNT], input: key });
      } else {
        await invoke(runSecurity, request);
      }
      return key;
    } catch (error) {
      throw error?.code === "AIRKIT_AUDIT_KEYCHAIN_UNAVAILABLE" ? error : failure("audit Keychain create failed", error);
    }
  };

  const get = async () => {
    try {
      try {
        return await readAccount(AUDIT_KEYCHAIN_NEXT_ACCOUNT);
      } catch (error) {
        if (error?.code !== "AIRKIT_AUDIT_KEYCHAIN_UNAVAILABLE") throw error;
        return await readAccount(AUDIT_KEYCHAIN_ACCOUNT);
      }
    } catch (error) {
      throw error?.code === "AIRKIT_AUDIT_KEYCHAIN_UNAVAILABLE" ? error : failure("audit Keychain read failed", error);
    }
  };

  return { inspect, create, get };
}
