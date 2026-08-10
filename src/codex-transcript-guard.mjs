import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";

const CODEX_PLUGIN_ID = "codex@openai-codex";
const OPENAI_CODEX_CACHE = ["plugins", "cache", "openai-codex", "codex"];
const PLUGIN_SOURCE = ["scripts", "lib"];
const TRACKED_JOBS_FILE = "tracked-jobs.mjs";
const CODEX_FILE = "codex.mjs";

const LEGACY_STDERR_CONDITION = "if (stderr && stderrMessage) {";
const PROTECTED_STDERR_CONDITION = "if (stderr && !event.hideFromStderr && stderrMessage) {";
const LEGACY_DYNAMIC_START = "return { message: `Running tool: ${item.tool}.`, phase: \"investigating\" };";
const PROTECTED_DYNAMIC_START = "return { message: `Running tool: ${item.tool}.`, phase: \"investigating\", hideFromStderr: true };";
const LEGACY_DYNAMIC_COMPLETE = "return { message: `Tool ${item.tool} ${item.status}.`, phase: \"investigating\" };";
const PROTECTED_DYNAMIC_COMPLETE = "return { message: `Tool ${item.tool} ${item.status}.`, phase: \"investigating\", hideFromStderr: true };";

const defaultIo = { chmod, mkdir, readFile, rename, stat, writeFile };

function claudeConfigDir(env) {
  if (typeof env?.CLAUDE_CONFIG_DIR === "string" && env.CLAUDE_CONFIG_DIR.trim()) {
    return resolve(env.CLAUDE_CONFIG_DIR);
  }
  if (typeof env?.HOME === "string" && env.HOME.trim()) return join(env.HOME, ".claude");
  throw new Error("HOME or CLAUDE_CONFIG_DIR is required to locate Claude plugins");
}

function isDescendant(path, parent) {
  const nested = relative(parent, path);
  return nested.length > 0 && !nested.startsWith("..") && !nested.includes("..\\");
}

function isTrustedCodexInstall(installPath, configDir) {
  if (typeof installPath !== "string" || !installPath.trim()) return false;
  const cacheRoot = join(configDir, ...OPENAI_CODEX_CACHE);
  return isDescendant(resolve(installPath), resolve(cacheRoot));
}

function inspectSource(trackedJobs, codex) {
  const protectedSource = trackedJobs.includes(PROTECTED_STDERR_CONDITION)
    && codex.includes(PROTECTED_DYNAMIC_START)
    && codex.includes(PROTECTED_DYNAMIC_COMPLETE);
  if (protectedSource) return "protected";

  const repairableSource = trackedJobs.includes(LEGACY_STDERR_CONDITION)
    && codex.includes(LEGACY_DYNAMIC_START)
    && codex.includes(LEGACY_DYNAMIC_COMPLETE);
  return repairableSource ? "repairable" : "unsupported";
}

function result(state, options = {}) {
  return {
    state,
    write: options.write === true,
    actions: state === "repairable" ? ["suppress-dynamic-tool-progress-from-stderr"] : [],
    affectedPaths: options.affectedPaths ?? [],
    backupPaths: options.backupPaths ?? [],
    ...(options.reason ? { reason: options.reason } : {}),
    ...(options.claudeDir ? { claudeDir: options.claudeDir } : {}),
    ...(options.targets ? { targets: options.targets } : {}),
  };
}

async function readRegistry(io, registryPath) {
  try {
    return JSON.parse(await io.readFile(registryPath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    if (error instanceof SyntaxError) {
      throw new Error(`Cannot safely parse Claude plugin registry: ${registryPath}`);
    }
    throw error;
  }
}

async function findCodexSources(options = {}) {
  const io = options.io ?? defaultIo;
  const env = options.env ?? process.env;
  const configDir = claudeConfigDir(env);
  const registryPath = join(configDir, "plugins", "installed_plugins.json");
  const registry = await readRegistry(io, registryPath);
  if (!registry) return { configDir, registryPath, sources: [], invalidInstall: false };

  const entries = Array.isArray(registry?.plugins?.[CODEX_PLUGIN_ID])
    ? registry.plugins[CODEX_PLUGIN_ID]
    : [];
  const sources = [];
  let invalidInstall = false;
  for (const entry of entries) {
    if (!isTrustedCodexInstall(entry?.installPath, configDir)) {
      invalidInstall = true;
      continue;
    }
    const installPath = resolve(entry.installPath);
    const sourceDir = join(installPath, ...PLUGIN_SOURCE);
    const trackedJobsPath = join(sourceDir, TRACKED_JOBS_FILE);
    const codexPath = join(sourceDir, CODEX_FILE);
    try {
      const [trackedJobs, codex] = await Promise.all([
        io.readFile(trackedJobsPath, "utf8"),
        io.readFile(codexPath, "utf8"),
      ]);
      sources.push({
        codex: String(codex),
        codexPath,
        installPath,
        state: inspectSource(String(trackedJobs), String(codex)),
        trackedJobs: String(trackedJobs),
        trackedJobsPath,
      });
    } catch (error) {
      if (error?.code === "ENOENT") {
        invalidInstall = true;
        continue;
      }
      throw error;
    }
  }
  return { configDir, registryPath, sources, invalidInstall };
}

function stateForSources(sources, invalidInstall) {
  if (sources.length === 0) return invalidInstall ? "unsupported" : "absent";
  if (invalidInstall || sources.some((source) => source.state === "unsupported")) return "unsupported";
  if (sources.every((source) => source.state === "protected")) return "protected";
  if (sources.every((source) => source.state === "repairable")) return "repairable";
  return "unsupported";
}

function patchSource(source) {
  if (source.state !== "repairable") throw new Error("Only a known repairable Codex plugin source can be patched");
  return [
    {
      path: source.trackedJobsPath,
      previous: Buffer.from(source.trackedJobs),
      next: Buffer.from(source.trackedJobs.replace(LEGACY_STDERR_CONDITION, PROTECTED_STDERR_CONDITION)),
    },
    {
      path: source.codexPath,
      previous: Buffer.from(source.codex),
      next: Buffer.from(
        source.codex
          .replace(LEGACY_DYNAMIC_START, PROTECTED_DYNAMIC_START)
          .replace(LEGACY_DYNAMIC_COMPLETE, PROTECTED_DYNAMIC_COMPLETE),
      ),
    },
  ];
}

function repairStamp(now) {
  const date = now();
  if (!(date instanceof Date) || Number.isNaN(date.valueOf())) throw new TypeError("now must return a valid Date");
  return date.toISOString().replace(/[:.]/g, "-");
}

async function writeBackup(io, directory, path, bytes, stamp) {
  await io.mkdir(directory, { recursive: true, mode: 0o700 });
  const base = `${basename(path)}.${stamp}`;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const backupPath = join(directory, `${base}${attempt === 0 ? "" : `-${randomUUID()}`}.bak`);
    try {
      await io.writeFile(backupPath, bytes, { flag: "wx", mode: 0o600 });
      await io.chmod(backupPath, 0o600);
      return backupPath;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
  }
  throw new Error(`Could not create an exclusive backup for ${path}`);
}

async function replaceIfUnchanged(io, patch) {
  const current = Buffer.from(await io.readFile(patch.path));
  if (!current.equals(patch.previous)) {
    throw Object.assign(new Error(`Refusing to overwrite concurrently changed file: ${patch.path}`), {
      code: "AIRKIT_CODEX_TRANSCRIPT_CONFLICT",
      path: patch.path,
    });
  }
  const mode = (await io.stat(patch.path)).mode & 0o777;
  const temporary = join(dirname(patch.path), `.${basename(patch.path)}.airkit-${randomUUID()}.tmp`);
  await io.writeFile(temporary, patch.next, { flag: "wx", mode });
  await io.rename(temporary, patch.path);
}

async function restorePatchIfStillApplied(io, patch) {
  try {
    const current = Buffer.from(await io.readFile(patch.path));
    if (!current.equals(patch.next)) return;
    const mode = (await io.stat(patch.path)).mode & 0o777;
    const temporary = join(dirname(patch.path), `.${basename(patch.path)}.airkit-restore-${randomUUID()}.tmp`);
    await io.writeFile(temporary, patch.previous, { flag: "wx", mode });
    await io.rename(temporary, patch.path);
  } catch {
    // Preserve a concurrently changed plugin file rather than attempting another overwrite.
  }
}

export async function inspectCodexTranscriptGuard(options = {}) {
  const located = await findCodexSources(options);
  const state = stateForSources(located.sources, located.invalidInstall);
  const targets = located.sources.map((source) => ({
    installPath: source.installPath,
    state: source.state,
    paths: [source.trackedJobsPath, source.codexPath],
  }));
  const affectedPaths = state === "repairable"
    ? targets.flatMap((target) => target.paths)
    : [];
  return result(state, {
    affectedPaths,
    claudeDir: located.configDir,
    reason: state === "unsupported"
      ? "Codex plugin source is missing, mixed, or no longer matches the reviewed implementation"
      : undefined,
    targets,
  });
}

export async function repairCodexTranscriptGuard(options = {}) {
  const inspection = await inspectCodexTranscriptGuard(options);
  if (options.write !== true || inspection.state !== "repairable") return inspection;

  const io = options.io ?? defaultIo;
  const located = await findCodexSources(options);
  if (stateForSources(located.sources, located.invalidInstall) !== "repairable") {
    throw new Error("Codex plugin changed while transcript guard was being prepared");
  }
  const patches = located.sources.flatMap(patchSource);
  const backupDir = options.backupDir ?? join(located.configDir, "plugins", "airkit-recovery", "codex-transcript");
  const stamp = repairStamp(options.now ?? (() => new Date()));
  const backupPaths = [];
  const applied = [];
  try {
    for (const patch of patches) backupPaths.push(await writeBackup(io, backupDir, patch.path, patch.previous, stamp));
    for (const patch of patches) {
      await replaceIfUnchanged(io, patch);
      applied.push(patch);
    }
  } catch (error) {
    await Promise.all(applied.reverse().map((patch) => restorePatchIfStillApplied(io, patch)));
    error.backupPaths = backupPaths;
    throw error;
  }

  return result("protected", {
    affectedPaths: patches.map((patch) => patch.path),
    backupPaths,
    claudeDir: located.configDir,
    targets: located.sources.map((source) => ({
      installPath: source.installPath,
      state: "protected",
      paths: [source.trackedJobsPath, source.codexPath],
    })),
    write: true,
  });
}
