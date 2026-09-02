#!/usr/bin/env node

import { readFile, stat } from "node:fs/promises";

import { shieldPaths, writeShieldIdentity } from "./shield/paths.mjs";
import { startShieldProxy } from "./shield/proxy.mjs";

async function main() {
  const configPath = parseConfigPath(process.argv.slice(2));
  const paths = shieldPaths({ env: process.env });
  if (configPath !== paths.configPath) throw new Error("shield daemon config path must be the canonical private configuration path");
  await assertPrivateConfig(configPath);
  const config = await readShieldConfig(configPath);
  const shield = await startShieldProxy({
    capability: config.capability,
    targetOrigin: config.targetOrigin,
    decide: async () => ({ action: "deny" }),
  });
  await writeShieldIdentity({
    paths,
    identity: { origin: shield.origin, capability: config.capability, version: 1, pid: process.pid, targetClass: "loopback" },
  });
  const stop = async () => {
    await shield.close();
    process.exitCode = 0;
  };
  process.once("SIGINT", () => { void stop(); });
  process.once("SIGTERM", () => { void stop(); });
  await new Promise(() => {});
}

function parseConfigPath(argv) {
  if (argv.length !== 2 || argv[0] !== "--config" || !argv[1]) throw new Error("usage: airkit-shieldd --config <private-config-path>");
  return argv[1];
}

async function assertPrivateConfig(path) {
  const entry = await stat(path);
  if (!entry.isFile() || (entry.mode & 0o077) !== 0) throw new Error("shield daemon configuration must be a private regular file");
  if (typeof process.getuid === "function" && entry.uid !== process.getuid()) throw new Error("shield daemon configuration has unexpected owner");
}

async function readShieldConfig(path) {
  let config;
  try {
    config = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new Error("shield daemon configuration is invalid");
  }
  if (!config || typeof config.capability !== "string" || typeof config.targetOrigin !== "string") {
    throw new Error("shield daemon configuration is incomplete");
  }
  return config;
}

main().catch(() => {
  process.stderr.write("AIRKIT_SHIELDD code=AIRKIT_SHIELDD_BOOT_FAILED\n");
  process.exitCode = 1;
});
