import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

const AUDIT_ROOT_NAME = "airkit-audit";

export function resolveAuditPaths({ env = process.env, overrides = {} } = {}) {
  const runtimeHome = xdgStateHome(env);
  const rootDir = normalizeAbsolutePath(overrides.rootDir ?? join(runtimeHome, AUDIT_ROOT_NAME), "rootDir");
  const spoolDir = normalizeAbsolutePath(overrides.spoolDir ?? join(rootDir, "spool"), "spoolDir");
  const socketPath = normalizeAbsolutePath(overrides.socketPath ?? join(rootDir, "auditd.sock"), "socketPath");
  const querySocketPath = normalizeAbsolutePath(
    overrides.querySocketPath ?? join(rootDir, "auditd-query.sock"),
    "querySocketPath",
  );

  return Object.freeze({
    rootDir,
    spoolDir,
    socketPath,
    querySocketPath,
  });
}

function xdgStateHome(env) {
  if (typeof env?.XDG_STATE_HOME === "string" && env.XDG_STATE_HOME.length > 0) {
    return env.XDG_STATE_HOME;
  }
  const home = typeof env?.HOME === "string" && env.HOME.length > 0 ? env.HOME : homedir();
  return join(home, ".local", "state");
}

function normalizeAbsolutePath(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  if (!isAbsolute(value)) {
    throw new Error(`${label} must be an absolute path`);
  }
  return value;
}
