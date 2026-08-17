#!/usr/bin/env node

import { openAuditStore } from "./audit/store.mjs";
import { createAuditDaemon } from "./audit/daemon.mjs";
import { resolveAuditPaths } from "./audit/paths.mjs";
import { createMasterKeyProvider } from "./audit/keychain.mjs";
import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function main() {
  const env = process.env;
  const capability = (await readFile(requireEnv(env, "AIRKIT_AUDIT_CAPABILITY_FILE"), "utf8")).trim();
  if (!capability) throw new Error("AIRKIT_AUDIT_CAPABILITY_FILE is empty");
  const masterKey = await createMasterKeyProvider({
    env,
    runSecurity: (request) => runSecurityCommand(request, env),
  }).get();
  const paths = resolveAuditPaths({
    env,
    overrides: {
      rootDir: env.AIRKIT_AUDIT_ROOT_DIR,
      socketPath: env.AIRKIT_AUDIT_SOCKET_PATH,
      querySocketPath: env.AIRKIT_AUDIT_QUERY_SOCKET_PATH,
      spoolDir: env.AIRKIT_AUDIT_SPOOL_DIR,
    },
  });

  const daemon = createAuditDaemon({
    paths,
    capability,
    keyProvider: {
      async getMasterKey() {
        return masterKey;
      },
    },
    storeFactory: () => openAuditStore({
      databasePath: env.AIRKIT_AUDIT_DATABASE_PATH ?? `${paths.rootDir}/audit.sqlite`,
      backupDir: env.AIRKIT_AUDIT_BACKUP_DIR ?? `${paths.rootDir}/backups`,
      masterKey,
    }),
  });

  let stopping = false;
  const stop = async (signal) => {
    if (stopping) return;
    stopping = true;
    try {
      await daemon.stop();
      process.exitCode = 0;
    } catch (error) {
      process.stderr.write(`AIRKIT_AUDITD code=AIRKIT_AUDITD_STOP_FAILED signal=${signal}\n`);
      process.exitCode = 1;
    }
  };

  process.once("SIGINT", () => {
    void stop("SIGINT");
  });
  process.once("SIGTERM", () => {
    void stop("SIGTERM");
  });

  await daemon.start();
  await new Promise(() => {});
}

async function runSecurityCommand(request, env) {
  const args = Array.isArray(request?.args) ? request.args : [];
  try {
    const result = await execFileAsync(env.AIRKIT_SECURITY_PATH || "security", args, {
      input: request?.input,
      timeout: 10_000,
      maxBuffer: 4 * 1024,
    });
    return { status: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return { status: typeof error?.code === "number" ? error.code : 1, stdout: error?.stdout ?? "", stderr: error?.stderr ?? "" };
  }
}

function requireEnv(env, name) {
  const value = env[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} is required`);
  }
  return value;
}

main().catch((error) => {
  process.stderr.write(`AIRKIT_AUDITD code=AIRKIT_AUDITD_BOOT_FAILED\n`);
  process.exitCode = 1;
});
