import { readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

const managedBlocks = [
  ["# BEGIN CCR managed profile", "# END CCR managed profile"],
  ["# BEGIN CCR managed Codex provider", "# END CCR managed Codex provider"],
];

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function managedBlockPattern(begin, end) {
  return new RegExp(
    `^${escapeRegExp(begin)}\\r?\\n[\\s\\S]*?^${escapeRegExp(end)}(?:\\r?\\n|$)`,
    "gm",
  );
}

function codexConfigPath(profile) {
  if (typeof profile?.configFile === "string" && /(?:^|[\\/])\.codex[\\/]config\.toml$/.test(profile.configFile)) {
    return profile.configFile;
  }
  if (typeof profile?.codexHome !== "string" || profile.codexHome.length === 0) return null;
  const separator = profile.codexHome.includes("\\") && !profile.codexHome.includes("/") ? "\\" : "/";
  return `${profile.codexHome.replace(/[\\/]+$/, "")}${separator}config.toml`;
}

function isHazardousCodexProfile(profile) {
  return profile?.agent === "codex"
    && profile.enabled === true
    && profile.scope === "global"
    && codexConfigPath(profile) !== null;
}

function ccrProfiles(config) {
  return Array.isArray(config?.profile?.profiles) ? config.profile.profiles : [];
}

function countManagedBlocks(text) {
  if (typeof text !== "string") return 0;
  return managedBlocks.reduce((count, [begin, end]) => {
    return count + [...text.matchAll(managedBlockPattern(begin, end))].length;
  }, 0);
}

function takeoverRecords(takeoverText) {
  if (typeof takeoverText !== "string" || takeoverText.trim() === "") return [];
  let parsed;
  try {
    parsed = JSON.parse(takeoverText);
  } catch {
    return [];
  }

  if (!Array.isArray(parsed?.profiles)) return [];
  return parsed.profiles.filter((profile) => profile?.agent === "codex" && codexConfigPath(profile));
}

export function stripCcrManagedCodexBlocks(text) {
  if (typeof text !== "string") throw new TypeError("Codex config text must be a string");
  return managedBlocks.reduce(
    (current, [begin, end]) => current.replace(managedBlockPattern(begin, end), ""),
    text,
  );
}

export function inspectCodexTakeover({ ccrConfig, codexConfigText, takeoverText } = {}) {
  const hazardousProfiles = ccrProfiles(ccrConfig).filter(isHazardousCodexProfile);
  const managedCodexBlockCount = countManagedBlocks(codexConfigText);
  const takeover = takeoverRecords(takeoverText);
  const affectedPaths = [...new Set([
    ...hazardousProfiles.map(codexConfigPath),
    ...takeover.map(codexConfigPath),
  ])];
  const actions = [];
  if (managedCodexBlockCount > 0 || takeover.length > 0) actions.push("remove-managed-codex-blocks");
  if (hazardousProfiles.length > 0) actions.push("scope-codex-profiles-to-ccr");

  return {
    affectedPaths,
    actions,
    hasHazardousProfiles: hazardousProfiles.length > 0,
    hasManagedCodexBlocks: managedCodexBlockCount > 0,
    hasTakeoverRecord: takeover.length > 0,
    hazardous: hazardousProfiles.length > 0 || managedCodexBlockCount > 0 || takeover.length > 0,
    hazardousProfileCount: hazardousProfiles.length,
    managedCodexBlockCount,
    takeoverRecordCount: takeover.length,
  };
}

export function repairCcrCodexProfiles(config) {
  const repaired = structuredClone(config ?? {});
  if (!Array.isArray(repaired.profile?.profiles)) return repaired;
  repaired.profile.profiles = repaired.profile.profiles.map((profile) => {
    if (!isHazardousCodexProfile(profile)) return profile;
    return { ...profile, scope: "ccr", showAllSessions: true };
  });
  return repaired;
}

const defaultIo = { readFile, rename, stat, writeFile };

function resolveCodexConfigPath(env) {
  const codexHome = env?.CODEX_HOME || (env?.HOME ? join(env.HOME, ".codex") : null);
  if (!codexHome) throw new Error("HOME or CODEX_HOME is required to locate Codex config");
  return join(codexHome, "config.toml");
}

function repairTimestamp(now) {
  const value = now();
  if (!(value instanceof Date) || Number.isNaN(value.valueOf())) throw new TypeError("now must return a valid Date");
  return value.toISOString().replace(/[:.]/g, "-");
}

async function atomicReplace(io, path, bytes, mode, timestamp) {
  const temporaryPath = `${path}.airkit-repair-${timestamp}.tmp`;
  await io.writeFile(temporaryPath, bytes, { mode });
  await io.rename(temporaryPath, path);
}

function sanitizedRepairError(backupPath, restoredPath) {
  const error = new Error("CCR configuration repair failed; the sanitized Codex snapshot was restored");
  error.code = "CODEX_TAKEOVER_REPAIR_FAILED";
  error.backupPath = backupPath;
  error.restoredPath = restoredPath;
  return error;
}

export async function repairCodexTakeover({
  ccrClient,
  env = process.env,
  write = false,
  io = defaultIo,
  now = () => new Date(),
} = {}) {
  if (!ccrClient || typeof ccrClient.getConfig !== "function") {
    throw new TypeError("ccrClient.getConfig is required");
  }
  const codexPath = resolveCodexConfigPath(env);
  const latestBytes = await io.readFile(codexPath);
  const latestText = Buffer.from(latestBytes).toString("utf8");
  const sanitizedBytes = Buffer.from(stripCcrManagedCodexBlocks(latestText));

  if (!write) {
    const ccrConfig = await ccrClient.getConfig();
    return {
      backupPath: null,
      codexConfigPath: codexPath,
      inspection: inspectCodexTakeover({ ccrConfig, codexConfigText: latestText }),
      restoredPath: null,
      write: false,
    };
  }
  if (typeof ccrClient.saveConfig !== "function") throw new TypeError("ccrClient.saveConfig is required in write mode");

  const fileMode = (await io.stat(codexPath)).mode & 0o777;
  const timestamp = repairTimestamp(now);
  const backupPath = `${codexPath}.backup-${timestamp}`;
  await io.writeFile(backupPath, latestBytes, { mode: fileMode });

  let ccrConfig;
  let rpcFailed = false;
  try {
    ccrConfig = await ccrClient.getConfig();
    await ccrClient.saveConfig(repairCcrCodexProfiles(ccrConfig));
  } catch {
    rpcFailed = true;
  }

  let restoredPath = null;
  try {
    await atomicReplace(io, codexPath, sanitizedBytes, fileMode, timestamp);
    restoredPath = codexPath;
    const verifiedBytes = await io.readFile(codexPath);
    const verifiedText = Buffer.from(verifiedBytes).toString("utf8");
    if (!Buffer.from(verifiedBytes).equals(sanitizedBytes) || countManagedBlocks(verifiedText) !== 0) {
      throw new Error("Codex config verification failed");
    }
  } catch {
    const error = new Error("Codex config restore failed after a byte-exact backup was created");
    error.code = "CODEX_TAKEOVER_RESTORE_FAILED";
    error.backupPath = backupPath;
    error.restoredPath = restoredPath;
    throw error;
  }

  if (rpcFailed) throw sanitizedRepairError(backupPath, restoredPath);

  return {
    backupPath,
    codexConfigPath: codexPath,
    inspection: inspectCodexTakeover({ ccrConfig, codexConfigText: latestText }),
    restoredPath,
    write: true,
  };
}
