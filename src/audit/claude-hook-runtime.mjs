import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { createAuditEmitter } from "./emitter.mjs";
import { createMasterKeyProvider } from "./keychain.mjs";
import { resolveAuditPaths } from "./paths.mjs";
import { createAuditClient } from "./transport.mjs";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export async function createClaudeAuditHookEmitter(options = {}) {
  const env = options.env ?? process.env;
  const paths = resolveAuditPaths({
    env,
    overrides: {
      rootDir: env.AIRKIT_AUDIT_ROOT_DIR,
      socketPath: env.AIRKIT_AUDIT_SOCKET_PATH,
    },
  });
  const readFileImpl = options.readFileImpl ?? readFile;
  const capabilityPath = env.AIRKIT_AUDIT_CAPABILITY_FILE ?? join(paths.rootDir, "capability");
  const capability = (await readFileImpl(capabilityPath, "utf8")).trim();
  if (!capability) throw new Error("audit capability is empty");

  const masterKeyProvider = options.masterKeyProvider ?? createDefaultMasterKeyProvider(env);
  const masterKey = options.masterKey ?? await masterKeyProvider.get();
  const client = options.client ?? (options.createClient ?? createAuditClient)({
    socketPath: env.AIRKIT_AUDIT_SOCKET_PATH ?? paths.socketPath,
    capability,
    timeoutMs: options.timeoutMs ?? 750,
  });

  return createAuditEmitter({
    client,
    masterKey,
    source: "claude-code",
    sourceVersion: "hook-v1",
    clientName: "claude-sub",
  });
}

function createDefaultMasterKeyProvider(env) {
  const keychainHelperPath = env.AIRKIT_AUDIT_KEYCHAIN_HELPER ?? join(repoRoot, "native", "airkit-audit-keychain.swift");
  return createMasterKeyProvider({
    env,
    keychainHelperPath,
    runSecurity: (request) => runCommand(env.AIRKIT_SECURITY_PATH ?? "security", request),
    runKeychainHelper: (request) => runCommand(env.AIRKIT_SWIFT_PATH ?? "swift", request),
  });
}

async function runCommand(command, request) {
  try {
    const result = await execFileAsync(command, request?.args ?? [], {
      input: request?.input,
      timeout: 10_000,
      maxBuffer: 4 * 1024,
    });
    return { status: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return {
      status: typeof error?.code === "number" ? error.code : 1,
      stdout: error?.stdout ?? "",
      stderr: error?.stderr ?? "",
    };
  }
}
