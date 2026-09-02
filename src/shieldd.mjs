#!/usr/bin/env node

import { stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { shieldPaths, writeShieldIdentity, writeShieldPolicyState } from "./shield/paths.mjs";
import { classifyShieldRequest } from "./shield/classify.mjs";
import { createGitleaksScanner } from "./shield/gitleaks.mjs";
import { readShieldPolicyProvision } from "./shield/policy-bundle.mjs";
import { loadShieldPolicy } from "./shield/policy.mjs";
import { startShieldProxy } from "./shield/proxy.mjs";
import { defaultShieldLauncherContext, readShieldConfig } from "./shield/service.mjs";

async function main() {
  const configPath = parseConfigPath(process.argv.slice(2));
  const paths = shieldPaths({ env: process.env });
  if (configPath !== paths.configPath) throw new Error("shield daemon config path must be the canonical private configuration path");
  await assertPrivateConfig(configPath);
  const config = await readShieldConfig({ paths });
  const { shield } = await startShieldDaemon({ config, paths });
  const stop = async () => {
    await shield.close();
    process.exitCode = 0;
  };
  process.once("SIGINT", () => { void stop(); });
  process.once("SIGTERM", () => { void stop(); });
  await new Promise(() => {});
}

export async function startShieldDaemon({
  config,
  paths,
  pid = process.pid,
  readPolicyBundle = readShieldPolicyProvision,
  loadPolicy = loadShieldPolicy,
  createScanner = createGitleaksScanner,
  writePolicyState = writeShieldPolicyState,
  startProxy = startShieldProxy,
  writeIdentity = writeShieldIdentity,
} = {}) {
  if (!config || !paths) throw new TypeError("shield daemon configuration and paths are required");
  const provision = await readPolicyBundle({ paths });
  const policy = await loadPolicy({ bundle: provision.bundle, publicKey: provision.publicKey });
  if (!config.gitleaks) throw new Error("shield gitleaks provision is missing");
  const scanner = await createScanner(config.gitleaks);
  if (scanner?.version !== policy.detectorVersions.gitleaks) throw new Error("shield gitleaks version does not match policy metadata");
  const decide = async ({ body }) => {
    const facts = classifyShieldRequest({ body, launcherContext: config.launcherContext ?? defaultShieldLauncherContext(config.lane) });
    const secretScan = await scanner.scan(body);
    return policy.evaluate({
      lane: config.lane,
      destinationClass: facts.destinationClass,
      interactive: facts.interactive,
      repositoryClass: facts.repositoryClass,
      pathClasses: facts.pathClasses,
      secretFindings: secretScan.findings,
      piiFindings: [],
    });
  };
  await writePolicyState({ paths, state: { version: policy.version, detectorVersions: policy.detectorVersions } });

  let shield;
  try {
    shield = await startProxy({
      capability: config.capability,
      targetOrigin: config.targetOrigin,
      decide,
    });
    await writeIdentity({
      paths,
      identity: {
        origin: shield.origin,
        capability: config.capability,
        version: 1,
        pid,
        lane: config.lane,
        generation: config.generation,
        targetClass: config.targetClass,
        policyVersion: policy.version,
        detectorVersions: policy.detectorVersions,
      },
    });
  } catch (error) {
    await shield?.close();
    throw error;
  }
  return Object.freeze({ shield, policy, scanner });
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

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch(() => {
    process.stderr.write("AIRKIT_SHIELDD code=AIRKIT_SHIELDD_BOOT_FAILED\n");
    process.exitCode = 1;
  });
}
