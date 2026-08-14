#!/usr/bin/env node

import { openAuditStore } from "./audit/store.mjs";
import { createAuditDaemon } from "./audit/daemon.mjs";
import { resolveAuditPaths } from "./audit/paths.mjs";

async function main() {
  const env = process.env;
  const capability = requireEnv(env, "AIRKIT_AUDIT_CAPABILITY");
  const masterKey = readMasterKey(env);
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

function readMasterKey(env) {
  const hex = requireEnv(env, "AIRKIT_AUDIT_MASTER_KEY_HEX");
  if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length % 2 !== 0) {
    throw new Error("AIRKIT_AUDIT_MASTER_KEY_HEX must be an even-length hex string");
  }
  const key = Buffer.from(hex, "hex");
  if (key.length < 32) {
    throw new Error("AIRKIT_AUDIT_MASTER_KEY_HEX must decode to at least 32 bytes");
  }
  return key;
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
