import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize } from "node:path";

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
  if (typeof profile?.configFile === "string" && profile.configFile.trim()) return profile.configFile;
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

const defaultIo = { chmod, mkdir, readFile, realpath, rename, stat, unlink, writeFile };

function resolveCodexConfigPath(env) {
  const codexHome = env?.CODEX_HOME || (env?.HOME ? join(env.HOME, ".codex") : null);
  if (!codexHome) throw new Error("HOME or CODEX_HOME is required to locate Codex config");
  return join(codexHome, "config.toml");
}

export function codexSafetyPaths(env = process.env) {
  const home = env?.CCR_INTERNAL_HOME_DIR || env?.HOME;
  if (!home) throw new Error("HOME is required to locate CCR state");
  const appData = env?.CCR_INTERNAL_APP_DATA_DIR || env?.XDG_CONFIG_HOME || join(home, ".config");
  const stateDir = process.platform === "win32" ? join(appData, "claude-code-router") : join(home, ".claude-code-router");
  return {
    receiptPath: join(stateDir, "airkit-codex-safety-receipt.json"),
    takeoverPath: join(stateDir, "global-profile-takeover.json"),
  };
}

function expandTargetPath(path, env) {
  const trimmed = path.trim();
  if (trimmed === "~") return env?.HOME ?? trimmed;
  if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
    return env?.HOME ? join(env.HOME, trimmed.slice(2)) : trimmed;
  }
  return isAbsolute(trimmed) ? normalize(trimmed) : normalize(trimmed);
}

async function canonicalTargetPath(path, env, io) {
  const expanded = expandTargetPath(path, env);
  try {
    return await io.realpath(expanded);
  } catch (error) {
    if (error?.code === "ENOENT") return expanded;
    throw error;
  }
}

function pathKey(path) {
  const normalized = path.replaceAll("\\", "/");
  return process.platform === "win32" || /^[a-zA-Z]:\//.test(normalized)
    ? normalized.toLowerCase()
    : normalized;
}

async function readOptionalBytes(io, path) {
  try {
    return Buffer.from(await io.readFile(path));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function parsedTakeover(text) {
  if (!text) return null;
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

function withoutCodexTakeoverEntries(text) {
  const value = parsedTakeover(text);
  if (!value || !Array.isArray(value.profiles)) return text;
  value.profiles = value.profiles.filter((profile) => profile?.agent !== "codex");
  return `${JSON.stringify(value, null, 2)}\n`;
}

function takeoverTargets(text) {
  return takeoverRecords(text).map(codexConfigPath);
}

function liveTargets(config) {
  return ccrProfiles(config).filter(isHazardousCodexProfile).map(codexConfigPath);
}

function receiptDocument(paths, now) {
  return Buffer.from(`${JSON.stringify({
    schema: 1,
    version: 1,
    verifiedAt: now().toISOString(),
    codexConfigPaths: [...paths].sort(),
  }, null, 2)}\n`);
}

export async function readCodexSafetyReceipt(path, io = defaultIo, expectedPaths = null) {
  const bytes = await readOptionalBytes(io, path);
  if (!bytes) return false;
  const value = parsedTakeover(bytes.toString("utf8"));
  const structurallyValid = value?.schema === 1
    && value?.version === 1
    && typeof value?.verifiedAt === "string"
    && Number.isFinite(Date.parse(value.verifiedAt))
    && Array.isArray(value?.codexConfigPaths)
    && value.codexConfigPaths.every((entry) => typeof entry === "string");
  if (!structurallyValid) return false;
  if (!expectedPaths) return true;
  const recorded = value.codexConfigPaths.map(pathKey).sort();
  const expected = expectedPaths.map(pathKey).sort();
  return recorded.length === expected.length && recorded.every((entry, index) => entry === expected[index]);
}

export async function writeCodexSafetyReceipt({
  codexConfigPaths = [],
  io = defaultIo,
  nonce = randomUUID,
  now = () => new Date(),
  path,
} = {}) {
  if (!path) throw new TypeError("receipt path is required");
  await io.mkdir(dirname(path), { recursive: true });
  await atomicReplace(io, path, receiptDocument(codexConfigPaths, now), 0o600, repairTimestamp(now), nonce);
  if (!await readCodexSafetyReceipt(path, io)) throw new Error("Codex safety receipt verification failed");
  return path;
}

function repairTimestamp(now) {
  const value = now();
  if (!(value instanceof Date) || Number.isNaN(value.valueOf())) throw new TypeError("now must return a valid Date");
  return value.toISOString().replace(/[:.]/g, "-");
}

function repairNonce(nonce) {
  const value = nonce();
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]+$/.test(value)) {
    throw new TypeError("nonce must return a non-empty filesystem-safe string");
  }
  return value;
}

async function cleanupExclusiveFile(io, path) {
  try {
    await io.unlink(path);
  } catch {
    // Cleanup is best-effort; the primary failure remains sanitized below.
  }
}

function transactionError(code, message, backupPaths, restoredPaths) {
  const error = new Error(message);
  error.code = code;
  error.backupPath = backupPaths[0] ?? null;
  error.backupPaths = backupPaths;
  error.restoredPath = restoredPaths[0] ?? null;
  error.restoredPaths = restoredPaths;
  return error;
}

async function exclusiveSnapshot(io, path, bytes, mode, suffix) {
  const backupPath = `${path}.backup-${suffix}`;
  await io.writeFile(backupPath, bytes, { flag: "wx", mode });
  await io.chmod(backupPath, mode);
  return backupPath;
}

async function atomicReplace(io, path, bytes, mode, suffix, nonce) {
  const temporaryPath = `${path}.airkit-repair-${suffix}-${repairNonce(nonce)}.tmp`;
  let created = false;
  try {
    try {
      await io.writeFile(temporaryPath, bytes, { flag: "wx", mode });
      created = true;
    } catch (error) {
      created = error?.code !== "EEXIST";
      throw error;
    }
    await io.chmod(temporaryPath, mode);
    await io.rename(temporaryPath, path);
    created = false;
    await io.chmod(path, mode);
  } catch (error) {
    if (created) await cleanupExclusiveFile(io, temporaryPath);
    throw error;
  }
}

export async function repairCodexTakeover({
  ccrClient,
  env = process.env,
  write = false,
  io = defaultIo,
  nonce = randomUUID,
  now = () => new Date(),
  receiptPath: requestedReceiptPath,
  takeoverPath: requestedTakeoverPath,
} = {}) {
  if (!ccrClient || typeof ccrClient.getConfig !== "function") {
    throw new TypeError("ccrClient.getConfig is required");
  }
  const safetyPaths = codexSafetyPaths(env);
  const takeoverPath = requestedTakeoverPath ?? safetyPaths.takeoverPath;
  const receiptPath = requestedReceiptPath ?? safetyPaths.receiptPath;
  const takeoverBytes = await readOptionalBytes(io, takeoverPath);
  const takeoverText = takeoverBytes?.toString("utf8");
  if (takeoverText?.trim() && !parsedTakeover(takeoverText)) {
    throw transactionError(
      "CODEX_TAKEOVER_INVALID",
      "Codex takeover state could not be verified safely",
      [],
      [],
    );
  }
  const targetCandidates = [resolveCodexConfigPath(env), ...takeoverTargets(takeoverText)];
  const targets = [];
  const seenTargets = new Set();
  for (const candidate of targetCandidates) {
    const path = await canonicalTargetPath(candidate, env, io);
    if (seenTargets.has(pathKey(path))) continue;
    seenTargets.add(pathKey(path));
    targets.push(path);
  }
  const snapshots = [];
  for (const path of targets) {
    const bytes = await readOptionalBytes(io, path);
    if (!bytes) continue;
    snapshots.push({ bytes, mode: (await io.stat(path)).mode & 0o777, path });
  }
  const combinedText = snapshots.map(({ bytes }) => bytes.toString("utf8")).join("\n");

  if (!write) {
    const ccrConfig = await ccrClient.getConfig();
    return {
      backupPath: null,
      backupPaths: [],
      codexConfigPath: targets[0],
      codexConfigPaths: targets,
      inspection: inspectCodexTakeover({ ccrConfig, codexConfigText: combinedText, takeoverText }),
      receiptPath,
      restoredPath: null,
      restoredPaths: [],
      takeoverPath,
      write: false,
    };
  }
  if (typeof ccrClient.saveConfig !== "function") throw new TypeError("ccrClient.saveConfig is required in write mode");

  const timestamp = repairTimestamp(now);
  const backupPaths = [];
  const restoredPaths = [];
  let attemptedBackupPath = null;
  let takeoverMode = null;
  try {
    for (const snapshot of snapshots) {
      attemptedBackupPath = `${snapshot.path}.backup-${timestamp}`;
      backupPaths.push(await exclusiveSnapshot(io, snapshot.path, snapshot.bytes, snapshot.mode, timestamp));
    }
    if (takeoverBytes) {
      takeoverMode = (await io.stat(takeoverPath)).mode & 0o777;
      attemptedBackupPath = `${takeoverPath}.backup-${timestamp}`;
      backupPaths.push(await exclusiveSnapshot(io, takeoverPath, takeoverBytes, takeoverMode, timestamp));
    }
  } catch {
    const error = transactionError(
      "CODEX_TAKEOVER_BACKUP_FAILED",
      "Codex takeover backups could not be created exclusively",
      backupPaths,
      restoredPaths,
    );
    error.backupPath = attemptedBackupPath;
    throw error;
  }

  let ccrConfig;
  let rpcFailed = false;
  try {
    ccrConfig = await ccrClient.getConfig();
    for (const candidate of liveTargets(ccrConfig)) {
      const path = await canonicalTargetPath(candidate, env, io);
      if (!seenTargets.has(pathKey(path))) {
        throw new Error("unbacked Codex target");
      }
    }
    await ccrClient.saveConfig(repairCcrCodexProfiles(ccrConfig));
  } catch {
    rpcFailed = true;
  }

  try {
    for (const snapshot of snapshots) {
      const source = rpcFailed ? snapshot.bytes : (await readOptionalBytes(io, snapshot.path) ?? snapshot.bytes);
      const sanitized = Buffer.from(stripCcrManagedCodexBlocks(source.toString("utf8")));
      await atomicReplace(io, snapshot.path, sanitized, snapshot.mode, timestamp, nonce);
      const verified = await io.readFile(snapshot.path);
      if (!Buffer.from(verified).equals(sanitized) || countManagedBlocks(Buffer.from(verified).toString("utf8")) !== 0) {
        throw new Error("Codex config verification failed");
      }
      restoredPaths.push(snapshot.path);
    }
    if (takeoverBytes) {
      const currentTakeoverBytes = rpcFailed
        ? takeoverBytes
        : (await readOptionalBytes(io, takeoverPath) ?? takeoverBytes);
      const repairedText = rpcFailed
        ? currentTakeoverBytes.toString("utf8")
        : withoutCodexTakeoverEntries(currentTakeoverBytes.toString("utf8"));
      await atomicReplace(io, takeoverPath, Buffer.from(repairedText), takeoverMode, timestamp, nonce);
      restoredPaths.push(takeoverPath);
      const verifiedRecord = await readOptionalBytes(io, takeoverPath);
      if (!rpcFailed && takeoverRecords(verifiedRecord?.toString("utf8")).length !== 0) {
        throw new Error("takeover record verification failed");
      }
    }
  } catch {
    throw transactionError(
      "CODEX_TAKEOVER_RESTORE_FAILED",
      "Codex takeover restore failed after byte-exact backups were created",
      backupPaths,
      restoredPaths,
    );
  }

  if (rpcFailed) {
    throw transactionError(
      "CODEX_TAKEOVER_REPAIR_FAILED",
      "CCR configuration repair failed; sanitized Codex snapshots were restored",
      backupPaths,
      restoredPaths,
    );
  }

  try {
    const verifiedConfig = await ccrClient.getConfig();
    const verifiedTexts = await Promise.all(targets.map(async (path) => (await readOptionalBytes(io, path))?.toString("utf8") ?? ""));
    const verifiedTakeover = (await readOptionalBytes(io, takeoverPath))?.toString("utf8");
    const verification = inspectCodexTakeover({
      ccrConfig: verifiedConfig,
      codexConfigText: verifiedTexts.join("\n"),
      takeoverText: verifiedTakeover,
    });
    if (verification.hazardous) throw new Error("hazard remains");
    await writeCodexSafetyReceipt({ codexConfigPaths: targets, io, nonce, now, path: receiptPath });
  } catch {
    throw transactionError(
      "CODEX_TAKEOVER_VERIFY_FAILED",
      "Codex takeover repair could not be verified",
      backupPaths,
      restoredPaths,
    );
  }

  return {
    backupPath: backupPaths[0] ?? null,
    backupPaths,
    codexConfigPath: targets[0],
    codexConfigPaths: targets,
    inspection: inspectCodexTakeover({ ccrConfig, codexConfigText: combinedText, takeoverText }),
    receiptPath,
    restoredPath: restoredPaths[0] ?? null,
    restoredPaths,
    takeoverPath,
    write: true,
  };
}
