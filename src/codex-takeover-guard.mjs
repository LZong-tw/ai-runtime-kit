import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, normalize } from "node:path";

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

const defaultIo = { chmod, mkdtemp, readFile, realpath, rename, stat, writeFile };

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
  return { takeoverPath: join(stateDir, "global-profile-takeover.json") };
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
    return value
      && typeof value === "object"
      && !Array.isArray(value)
      && value.version === 1
      && Array.isArray(value.profiles)
      ? value
      : null;
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

function restoreOriginalCodexEntries(originalText, latestText) {
  const original = parsedTakeover(originalText);
  const latest = parsedTakeover(latestText);
  if (!original || !latest) return null;
  latest.profiles = [
    ...latest.profiles.filter((profile) => profile?.agent !== "codex"),
    ...original.profiles.filter((profile) => profile?.agent === "codex"),
  ];
  return `${JSON.stringify(latest, null, 2)}\n`;
}

function takeoverTargets(text) {
  return takeoverRecords(text).map(codexConfigPath);
}

function liveTargets(config) {
  return ccrProfiles(config).filter(isHazardousCodexProfile).map(codexConfigPath);
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

function transactionError(code, message, backupPaths, restoredPaths, failedPaths = [], conflictPaths = []) {
  const error = new Error(message);
  error.code = code;
  error.backupPath = backupPaths[0] ?? null;
  error.backupPaths = backupPaths;
  error.restoredPath = restoredPaths[0] ?? null;
  error.restoredPaths = restoredPaths;
  error.failedPaths = failedPaths;
  error.conflictPaths = conflictPaths;
  return error;
}

async function exclusiveSnapshot(io, path, bytes, mode, suffix) {
  const backupPath = `${path}.backup-${suffix}`;
  await io.writeFile(backupPath, bytes, { flag: "wx", mode });
  await io.chmod(backupPath, mode);
  return backupPath;
}

async function restoreCapturedPath(io, path, capturedPath, capturedBytes, mode) {
  try {
    await io.writeFile(path, capturedBytes, { flag: "wx", mode });
    await io.chmod(path, mode);
  } catch {
    // A concurrent writer owns the active path. Never overwrite it.
  }
  return capturedPath;
}

async function captureIfUnchanged(io, path, expected, fallbackMode, suffix, nonce) {
  const swapDir = await io.mkdtemp(`${path}.airkit-swap-${suffix}-${repairNonce(nonce)}-`);
  await io.chmod(swapDir, 0o700);
  const capturedPath = join(swapDir, "captured");
  await io.rename(path, capturedPath);
  let capturedMode = fallbackMode;
  let capturedBytes;
  try {
    capturedMode = (await io.stat(capturedPath)).mode & 0o777;
    capturedBytes = Buffer.from(await io.readFile(capturedPath));
  } catch {
    await restoreCapturedPath(io, path, capturedPath, expected, capturedMode);
    throw Object.assign(new Error("captured target inspection failed"), {
      code: "AIRKIT_REPAIR_CAPTURE_FAILED",
      conflictPath: capturedPath,
    });
  }
  if (!capturedBytes.equals(expected)) {
    await restoreCapturedPath(io, path, capturedPath, capturedBytes, capturedMode);
    throw Object.assign(new Error("concurrent target change"), {
      code: "AIRKIT_REPAIR_CONFLICT",
      conflictPath: capturedPath,
    });
  }
  return { capturedBytes, capturedMode, capturedPath };
}

async function replaceIfUnchanged(io, path, expected, bytes, mode, suffix, nonce) {
  let capturedPath = path;
  let capturedBytes = null;
  let replacementMode = mode;

  if (expected !== null) {
    ({ capturedBytes, capturedMode: replacementMode, capturedPath } = await captureIfUnchanged(
      io,
      path,
      expected,
      mode,
      suffix,
      nonce,
    ));
  } else if (await readOptionalBytes(io, path)) {
    throw Object.assign(new Error("concurrent target creation"), {
      code: "AIRKIT_REPAIR_CONFLICT",
      conflictPath: path,
    });
  }

  try {
    await io.writeFile(path, bytes, { flag: "wx", mode: replacementMode });
    await io.chmod(path, replacementMode);
  } catch (error) {
    if (capturedBytes) await restoreCapturedPath(io, path, capturedPath, capturedBytes, replacementMode);
    throw Object.assign(new Error("exclusive target replacement failed"), {
      code: error?.code === "EEXIST" ? "AIRKIT_REPAIR_CONFLICT" : "AIRKIT_REPAIR_REPLACE_FAILED",
      conflictPath: capturedPath,
    });
  }
  return capturedPath;
}

async function quarantineIfUnchanged(io, path, expected, mode, suffix, nonce) {
  return (await captureIfUnchanged(io, path, expected, mode, suffix, nonce)).capturedPath;
}

export async function repairCodexTakeover({
  ccrClient,
  env = process.env,
  write = false,
  io = defaultIo,
  nonce = randomUUID,
  now = () => new Date(),
  takeoverPath: requestedTakeoverPath,
} = {}) {
  if (!ccrClient || typeof ccrClient.getConfig !== "function") {
    throw new TypeError("ccrClient.getConfig is required");
  }
  let ccrConfig;
  try {
    ccrConfig = await ccrClient.getConfig();
  } catch {
    throw transactionError(
      "CODEX_TAKEOVER_INSPECTION_FAILED",
      "CCR configuration could not be inspected safely",
      [],
      [],
    );
  }
  const takeoverPath = await canonicalTargetPath(
    requestedTakeoverPath ?? codexSafetyPaths(env).takeoverPath,
    env,
    io,
  );
  const takeoverBytes = await readOptionalBytes(io, takeoverPath);
  const takeoverText = takeoverBytes?.toString("utf8");
  if (takeoverBytes !== null && !parsedTakeover(takeoverText)) {
    throw transactionError(
      "CODEX_TAKEOVER_INVALID",
      "Codex takeover state could not be verified safely",
      [],
      [],
    );
  }
  const targetCandidates = [resolveCodexConfigPath(env), ...takeoverTargets(takeoverText), ...liveTargets(ccrConfig)];
  const targets = [];
  const seenTargets = new Set();
  for (const candidate of targetCandidates) {
    const path = await canonicalTargetPath(candidate, env, io);
    if (seenTargets.has(pathKey(path))) continue;
    seenTargets.add(pathKey(path));
    targets.push(path);
  }
  const targetsWithState = [];
  for (const path of targets) {
    const bytes = await readOptionalBytes(io, path);
    const mode = bytes ? (await io.stat(path)).mode & 0o777 : 0o600;
    targetsWithState.push({ bytes, mode, path });
  }
  const combinedText = targetsWithState.filter(({ bytes }) => bytes).map(({ bytes }) => bytes.toString("utf8")).join("\n");

  if (!write) {
    return {
      backupPath: null,
      backupPaths: [],
      codexConfigPath: targets[0],
      codexConfigPaths: targets,
      inspection: inspectCodexTakeover({ ccrConfig, codexConfigText: combinedText, takeoverText }),
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
    for (const snapshot of targetsWithState.filter(({ bytes }) => bytes)) {
      const backupSuffix = `${timestamp}-${repairNonce(nonce)}`;
      attemptedBackupPath = `${snapshot.path}.backup-${backupSuffix}`;
      backupPaths.push(await exclusiveSnapshot(io, snapshot.path, snapshot.bytes, snapshot.mode, backupSuffix));
    }
    if (takeoverBytes) {
      takeoverMode = (await io.stat(takeoverPath)).mode & 0o777;
      const backupSuffix = `${timestamp}-${repairNonce(nonce)}`;
      attemptedBackupPath = `${takeoverPath}.backup-${backupSuffix}`;
      backupPaths.push(await exclusiveSnapshot(io, takeoverPath, takeoverBytes, takeoverMode, backupSuffix));
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

  let rpcFailed = false;
  try {
    await ccrClient.saveConfig(repairCcrCodexProfiles(ccrConfig), { applyProfile: false });
  } catch {
    rpcFailed = true;
  }

  const failedPaths = [];
  const conflictPaths = [];
  for (const target of targetsWithState) {
    try {
      const latest = await readOptionalBytes(io, target.path);
      if (!latest) continue;
      const sanitized = Buffer.from(stripCcrManagedCodexBlocks(latest.toString("utf8")));
      if (!latest.equals(sanitized)) {
        await replaceIfUnchanged(io, target.path, latest, sanitized, target.mode, timestamp, nonce);
      }
      const verified = await readOptionalBytes(io, target.path);
      if (!verified?.equals(sanitized) || countManagedBlocks(verified.toString("utf8")) !== 0) {
        throw new Error("target verification failed");
      }
      restoredPaths.push(target.path);
    } catch (error) {
      failedPaths.push(target.path);
      if (error?.conflictPath) conflictPaths.push(error.conflictPath);
    }
  }

  try {
    const latest = await readOptionalBytes(io, takeoverPath);
    if (rpcFailed) {
      if (takeoverBytes) {
        if (!latest || !latest.equals(takeoverBytes)) {
          let restored = takeoverBytes;
          if (latest) {
            const merged = restoreOriginalCodexEntries(takeoverText, latest.toString("utf8"));
            if (merged) {
              restored = Buffer.from(merged);
            } else {
              const captured = await replaceIfUnchanged(
                io,
                takeoverPath,
                latest,
                takeoverBytes,
                takeoverMode,
                timestamp,
                nonce,
              );
              conflictPaths.push(captured);
              restored = null;
            }
          }
          if (restored) await replaceIfUnchanged(io, takeoverPath, latest, restored, takeoverMode, timestamp, nonce);
        }
      } else if (latest) {
        const parsed = parsedTakeover(latest.toString("utf8"));
        if (!parsed) {
          conflictPaths.push(await quarantineIfUnchanged(
            io,
            takeoverPath,
            latest,
            (await io.stat(takeoverPath)).mode & 0o777,
            timestamp,
            nonce,
          ));
        } else {
          const pruned = Buffer.from(withoutCodexTakeoverEntries(latest.toString("utf8")));
          await replaceIfUnchanged(io, takeoverPath, latest, pruned, (await io.stat(takeoverPath)).mode & 0o777, timestamp, nonce);
        }
      }
    } else if (latest) {
      if (!parsedTakeover(latest.toString("utf8"))) {
        if (takeoverBytes) {
          conflictPaths.push(await replaceIfUnchanged(
            io,
            takeoverPath,
            latest,
            takeoverBytes,
            takeoverMode,
            timestamp,
            nonce,
          ));
        } else {
          conflictPaths.push(await quarantineIfUnchanged(
            io,
            takeoverPath,
            latest,
            (await io.stat(takeoverPath)).mode & 0o777,
            timestamp,
            nonce,
          ));
        }
        failedPaths.push(takeoverPath);
      } else {
        const pruned = Buffer.from(withoutCodexTakeoverEntries(latest.toString("utf8")));
        if (!latest.equals(pruned)) {
          await replaceIfUnchanged(io, takeoverPath, latest, pruned, (await io.stat(takeoverPath)).mode & 0o777, timestamp, nonce);
        }
        restoredPaths.push(takeoverPath);
      }
    }
  } catch (error) {
    failedPaths.push(takeoverPath);
    if (error?.conflictPath) conflictPaths.push(error.conflictPath);
  }

  if (failedPaths.length > 0) {
    throw transactionError(
      "CODEX_TAKEOVER_RESTORE_FAILED",
      "Codex takeover cleanup failed; backups and conflict snapshots were retained",
      backupPaths,
      restoredPaths,
      [...new Set(failedPaths)],
      [...new Set(conflictPaths)],
    );
  }

  if (rpcFailed) {
    throw transactionError(
      "CODEX_TAKEOVER_REPAIR_FAILED",
      "CCR configuration repair failed; sanitized Codex snapshots were restored",
      backupPaths,
      restoredPaths,
      [],
      [...new Set(conflictPaths)],
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
    restoredPath: restoredPaths[0] ?? null,
    restoredPaths,
    takeoverPath,
    write: true,
  };
}
