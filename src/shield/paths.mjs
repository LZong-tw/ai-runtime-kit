import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

const SHIELD_LABEL = "com.airkit.shield";
const defaultIo = { chmod, mkdir, readFile, rename, unlink, writeFile };

export function shieldPaths({ env = process.env, homeDir = homeFromEnv(env), uid = env.AIRKIT_GUI_UID ?? env.UID ?? process.getuid?.(), rootDir, configPath, identityPath, socketPath, launchAgentPath } = {}) {
  const home = absolutePath(homeDir, "homeDir");
  const root = absolutePath(rootDir ?? env.AIRKIT_SHIELD_ROOT_DIR ?? join(home, ".local", "state", "airkit-shield"), "rootDir");
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
  return Object.freeze(paths);
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
  if (!Number.isInteger(identity.pid) || identity.pid < 0) throw new Error("shield identity pid is missing or invalid");
  if (identity.targetClass !== "loopback") throw new Error("shield identity targetClass must be loopback");
  return {
    origin: url.origin,
    capability: identity.capability,
    version: identity.version,
    pid: identity.pid,
    targetClass: identity.targetClass,
  };
}

export async function writeShieldIdentity({ paths, identity, io = defaultIo } = {}) {
  if (!paths?.rootDir || !paths.identityPath) throw new TypeError("shield identity paths are required");
  const validated = assertShieldIdentity(identity);
  await io.mkdir(paths.rootDir, { recursive: true, mode: 0o700 });
  await io.chmod(paths.rootDir, 0o700);
  const temporaryPath = `${paths.identityPath}.tmp-${process.pid}-${Date.now()}`;
  try {
    await io.writeFile(temporaryPath, `${JSON.stringify(validated)}\n`, { flag: "wx", mode: 0o600 });
    await io.chmod(temporaryPath, 0o600);
    await io.rename(temporaryPath, paths.identityPath);
  } catch (error) {
    await io.unlink(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
  return validated;
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
