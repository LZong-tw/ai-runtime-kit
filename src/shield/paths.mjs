import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

const SHIELD_LABEL = "com.airkit.shield";
const defaultIo = { chmod, constants, lstat, mkdir, open, readFile, rename, unlink };
const canonicalShieldPaths = new WeakSet();

export function shieldPaths({ env = process.env, homeDir = homeFromEnv(env), uid = env.AIRKIT_GUI_UID ?? env.UID ?? process.getuid?.(), rootDir, configPath, identityPath, socketPath, launchAgentPath } = {}) {
  const home = absolutePath(homeDir, "homeDir");
  const canonicalRoot = join(home, ".local", "state", "airkit-shield");
  const root = absolutePath(rootDir ?? env.AIRKIT_SHIELD_ROOT_DIR ?? canonicalRoot, "rootDir");
  if (resolve(root) !== resolve(canonicalRoot)) throw new Error("rootDir must be the canonical AirKit Shield state directory");
  const paths = {
    rootDir: root,
    configPath: childPath(configPath ?? join(root, "config.json"), root, "configPath"),
    identityPath: childPath(identityPath ?? join(root, "identity.json"), root, "identityPath"),
    socketPath: childPath(socketPath ?? join(root, "shield.sock"), root, "socketPath"),
    launchAgentPath: launchAgentPath ?? join(home, "Library", "LaunchAgents", `${SHIELD_LABEL}.plist`),
    launchdDomain: `gui/${numericUid(uid)}`,
  };
  paths.launchAgentPath = absolutePath(paths.launchAgentPath, "launchAgentPath");
  if (resolve(dirname(paths.launchAgentPath)) !== resolve(home, "Library", "LaunchAgents")) {
    throw new Error("launchAgentPath must be under homeDir/Library/LaunchAgents");
  }
  paths.launchdTarget = `${paths.launchdDomain}/${SHIELD_LABEL}`;
  Object.freeze(paths);
  canonicalShieldPaths.add(paths);
  return paths;
}

export async function readShieldIdentity({ paths, io = defaultIo } = {}) {
  if (!paths?.identityPath) throw new TypeError("shield identity paths are required");
  let contents;
  try {
    contents = await io.readFile(paths.identityPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  let identity;
  try {
    identity = JSON.parse(contents);
  } catch {
    throw new Error("shield identity is invalid JSON");
  }
  return assertShieldIdentity(identity);
}

export function assertShieldIdentity(identity) {
  let url;
  try { url = new URL(identity?.origin ?? ""); } catch { url = null; }
  if (!url || url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !Number.isInteger(Number(url.port)) || Number(url.port) < 1 || Number(url.port) > 65535) {
    throw new Error("shield identity origin must be a loopback HTTP endpoint");
  }
  if (typeof identity.capability !== "string" || identity.capability.length < 32) {
    throw new Error("shield identity capability is missing or invalid");
  }
  if (!(Number.isInteger(identity.version) || (typeof identity.version === "string" && identity.version.length > 0))) {
    throw new Error("shield identity version is missing or invalid");
  }
  if (!Number.isInteger(identity.pid) || identity.pid < 1) throw new Error("shield identity pid is missing or invalid");
  if (identity.lane !== "subscription" && identity.lane !== "managed") {
    throw new Error("shield identity lane must be subscription or managed");
  }
  if (identity.targetClass !== identity.lane) throw new Error("shield identity targetClass must match its lane");
  if (typeof identity.generation !== "string" || !/^[A-Za-z0-9._-]{1,128}$/.test(identity.generation)) {
    throw new Error("shield identity generation is missing or invalid");
  }
  return {
    origin: url.origin,
    capability: identity.capability,
    version: identity.version,
    pid: identity.pid,
    lane: identity.lane,
    generation: identity.generation,
    targetClass: identity.targetClass,
  };
}

export async function writeShieldIdentity({ paths, identity, io = defaultIo } = {}) {
  if (!paths?.rootDir || !paths.identityPath) throw new TypeError("shield identity paths are required");
  const validated = assertShieldIdentity(identity);
  await writePrivateShieldState({ paths, path: paths.identityPath, value: validated, io });
  return validated;
}

export async function writeShieldConfig({ paths, config, io = defaultIo } = {}) {
  if (!paths?.rootDir || !paths.configPath) throw new TypeError("shield configuration paths are required");
  if (!config || typeof config !== "object" || Array.isArray(config)) throw new TypeError("shield configuration must be an object");
  await writePrivateShieldState({ paths, path: paths.configPath, value: config, io });
}

async function writePrivateShieldState({ paths, path, value, io }) {
  assertWritablePaths(paths);
  const [homeDir, localDir, stateDir, rootDir] = stateComponents(paths.rootDir);
  const ownerUid = process.getuid?.();
  await ensureDirectory(homeDir, io, ownerUid, false);
  await ensureDirectory(localDir, io, ownerUid, true);
  await ensureDirectory(stateDir, io, ownerUid, true);
  await ensureDirectory(rootDir, io, ownerUid, true);
  await assertDirectory(rootDir, io, ownerUid);
  const rootHandle = await openPrivateRoot(rootDir, io, ownerUid);
  try {
    await rootHandle.chmod(0o700);
    await assertDirectory(rootDir, io, ownerUid);
    const temporaryPath = `${path}.tmp-${process.pid}-${Date.now()}`;
    try {
      const fileHandle = await openExclusiveFile(temporaryPath, io);
      try { await fileHandle.writeFile(`${JSON.stringify(value)}\n`); await fileHandle.chmod(0o600); }
      finally { await fileHandle.close(); }
      await assertDirectory(rootDir, io, ownerUid);
      await io.rename(temporaryPath, path);
    } catch (error) {
      await io.unlink(temporaryPath, { force: true }).catch(() => {});
      throw error;
    }
  } finally {
    await rootHandle.close();
  }
}

async function openPrivateRoot(rootDir, io, ownerUid) {
  const flags = io.constants?.O_RDONLY | io.constants?.O_DIRECTORY | io.constants?.O_NOFOLLOW;
  const handle = await io.open(rootDir, flags);
  const entry = await handle.stat();
  if (entry.isSymbolicLink() || !entry.isDirectory()) { await handle.close(); throw new Error("shield state root must be a real directory"); }
  if (Number.isInteger(ownerUid) && entry.uid !== ownerUid) { await handle.close(); throw new Error("shield state path has unexpected owner"); }
  return handle;
}

async function openExclusiveFile(path, io) {
  const flags = io.constants?.O_WRONLY | io.constants?.O_CREAT | io.constants?.O_EXCL | io.constants?.O_NOFOLLOW;
  return io.open(path, flags, 0o600);
}

function assertWritablePaths(paths) {
  if (!canonicalShieldPaths.has(paths)) {
    throw new Error("shield paths must be a canonical object returned by shieldPaths");
  }
  if (paths.configPath !== join(paths.rootDir, "config.json") || paths.identityPath !== join(paths.rootDir, "identity.json") || paths.socketPath !== join(paths.rootDir, "shield.sock")) {
    throw new Error("shield paths must use the canonical AirKit Shield state layout");
  }
}

async function ensureDirectory(path, io, ownerUid, privateMode) {
  try {
    await assertDirectory(path, io, ownerUid);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    await io.mkdir(path, { mode: privateMode ? 0o700 : 0o755 });
    await assertDirectory(path, io, ownerUid);
    if (privateMode) await io.chmod(path, 0o700);
  }
}

async function assertDirectory(path, io, ownerUid) {
  const entry = await io.lstat(path);
  if (entry.isSymbolicLink()) throw new Error("shield state path must not be a symlink");
  if (!entry.isDirectory()) throw new Error("shield state path must be a directory");
  if (Number.isInteger(ownerUid) && entry.uid !== ownerUid) throw new Error("shield state path has unexpected owner");
}

function stateComponents(rootDir) {
  const stateDir = dirname(rootDir);
  const localDir = dirname(stateDir);
  return [dirname(localDir), localDir, stateDir, rootDir];
}

function childPath(value, root, label) {
  const path = absolutePath(value, label);
  if (relative(root, path).startsWith("..")) throw new Error(`${label} must be under rootDir`);
  return path;
}

function absolutePath(value, label) {
  if (typeof value !== "string" || !isAbsolute(value)) throw new Error(`${label} must be an absolute path`);
  return value;
}

function numericUid(value) {
  if (!/^\d+$/.test(String(value ?? ""))) throw new Error("uid must be a numeric macOS user id");
  return String(value);
}

function homeFromEnv(env) { return typeof env?.HOME === "string" && env.HOME.length > 0 ? env.HOME : homedir(); }
