import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
export const AUDIT_SERVICE_LABEL = "com.airkit.auditd";

const defaultIo = { mkdir, readFile, rename, unlink, chmod, writeFile };

export function planAuditService({ paths, nodePath, daemonPath, authHelperPath, env = process.env } = {}) {
  assertPaths(paths);
  for (const [name, value] of Object.entries({ nodePath, daemonPath, authHelperPath })) {
    if (typeof value !== "string" || !value.startsWith("/")) throw new Error(`${name} must be an absolute path`);
  }
  const uid = paths.launchdDomain?.slice("gui/".length);
  if (!/^\d+$/.test(uid ?? "")) throw new Error("paths.launchdDomain must be gui/<uid>");
  const capabilityFile = paths.capabilityFile ?? `${paths.rootDir}/capability`;
  const plist = {
    Label: AUDIT_SERVICE_LABEL,
    ProgramArguments: [nodePath, daemonPath, "--auth-helper", authHelperPath],
    EnvironmentVariables: {
      AIRKIT_AUDIT_CAPABILITY_FILE: capabilityFile,
      AIRKIT_AUDIT_ROOT_DIR: paths.rootDir,
      AIRKIT_AUDIT_SOCKET_PATH: paths.socketPath,
      AIRKIT_AUDIT_QUERY_SOCKET_PATH: paths.querySocketPath,
      ...(env.AIRKIT_AUDIT_DATABASE_PATH ? { AIRKIT_AUDIT_DATABASE_PATH: env.AIRKIT_AUDIT_DATABASE_PATH } : {}),
    },
    RunAtLoad: true,
    KeepAlive: true,
    ProcessType: "Background",
  };
  const plistXml = renderPlist(plist);
  const target = paths.launchdTarget ?? `${paths.launchdDomain}/${AUDIT_SERVICE_LABEL}`;
  return {
    label: AUDIT_SERVICE_LABEL,
    plistPath: paths.launchAgentPath,
    domain: paths.launchdDomain,
    target,
    plist,
    plistXml,
    operations: [
      { op: "mkdir", path: dirname(paths.launchAgentPath), mode: 0o700 },
      { op: "writeFileAtomic", path: paths.launchAgentPath, mode: 0o600, content: plistXml },
      { op: "bootstrap", domain: paths.launchdDomain, path: paths.launchAgentPath },
      { op: "kickstart", target, kill: true },
    ],
  };
}

export async function installAuditService({ write = false, io = defaultIo, runLaunchctl = defaultLaunchctl, ...options } = {}) {
  const plan = planAuditService(options);
  if (!write) return plan;
  await io.mkdir(dirname(plan.plistPath), { recursive: true, mode: 0o700 });
  const tempPath = `${plan.plistPath}.tmp-${process.pid}`;
  await io.writeFile(tempPath, plan.plistXml, { mode: 0o600 });
  await io.chmod(tempPath, 0o600);
  await io.rename(tempPath, plan.plistPath);
  await launch(runLaunchctl, ["bootstrap", plan.domain, plan.plistPath], true);
  await launch(runLaunchctl, ["kickstart", "-k", plan.target], false);
  return { ...plan, written: true };
}

export async function startAuditService(options = {}) {
  const { runLaunchctl = defaultLaunchctl, io = defaultIo, ...rest } = options;
  const plan = planAuditService(rest);
  let missing = false;
  try { await io.readFile(plan.plistPath, "utf8"); } catch (error) {
    if (error?.code === "ENOENT") missing = true;
    else throw error;
  }
  if (missing) await installAuditService({ ...rest, io, runLaunchctl, write: true });
  else await ensurePathDrift(plan, io);
  if (missing) return { ...plan, started: true };
  await launch(runLaunchctl, ["bootstrap", plan.domain, plan.plistPath], true);
  await launch(runLaunchctl, ["kickstart", "-k", plan.target], false);
  return { ...plan, started: true };
}

export async function stopAuditService({ paths, runLaunchctl = defaultLaunchctl } = {}) {
  assertPaths(paths);
  await launch(runLaunchctl, ["bootout", paths.launchdTarget], true);
  return { label: AUDIT_SERVICE_LABEL, stopped: true, target: paths.launchdTarget };
}

export async function inspectAuditService({ paths, io = defaultIo, runLaunchctl = defaultLaunchctl } = {}) {
  assertPaths(paths);
  const exists = await io.readFile(paths.launchAgentPath, "utf8").then(() => true, () => false);
  const result = await launch(runLaunchctl, ["print", paths.launchdTarget], true);
  return { label: AUDIT_SERVICE_LABEL, plistPath: paths.launchAgentPath, installed: exists, loaded: result.ok, stale: exists && !result.ok };
}

export async function uninstallAuditService({ write = false, confirm = false, paths, io = defaultIo, runLaunchctl = defaultLaunchctl } = {}) {
  assertPaths(paths);
  const plan = { label: AUDIT_SERVICE_LABEL, plistPath: paths.launchAgentPath, target: paths.launchdTarget, operations: [{ op: "bootout", target: paths.launchdTarget }, { op: "unlink", path: paths.launchAgentPath }] };
  if (!write || confirm !== true) return plan;
  await launch(runLaunchctl, ["bootout", paths.launchdTarget], true);
  await io.unlink(paths.launchAgentPath, { force: true });
  return { ...plan, removed: true };
}

async function ensurePathDrift(plan, io) {
  try {
    const existing = await io.readFile(plan.plistPath, "utf8");
    if (existing !== plan.plistXml) throw new Error(`auditd launch plist path drift detected: ${plan.plistPath}`);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
}

async function launch(runLaunchctl, args, tolerateFailure) {
  const result = await runLaunchctl(args);
  if (result?.ok === false && !(tolerateFailure && /already (loaded|bootstrapped)|could not find service|no such process/i.test(result.stderr ?? ""))) {
    throw new Error(`launchctl ${args[0]} failed: ${result.stderr ?? "unknown error"}`);
  }
  return { ok: result?.ok !== false, ...result };
}

async function defaultLaunchctl(args) {
  try { await execFileAsync("launchctl", args); return { ok: true, status: 0 }; }
  catch (error) { return { ok: false, status: error.code, stderr: error.stderr ?? error.message }; }
}

function assertPaths(paths) {
  if (!paths?.rootDir || !paths.launchAgentPath || !paths.launchdDomain || !paths.launchdTarget) {
    throw new TypeError("audit service paths are required");
  }
  if (!/^gui\/\d+$/.test(paths.launchdDomain)) throw new Error("paths.launchdDomain must be gui/<uid>");
  const expectedTarget = `${paths.launchdDomain}/${AUDIT_SERVICE_LABEL}`;
  if (paths.launchdTarget !== expectedTarget) throw new Error("paths.launchdTarget must target com.airkit.auditd");
  if (!isAbsolute(paths.launchAgentPath) || basename(paths.launchAgentPath) !== `${AUDIT_SERVICE_LABEL}.plist`) {
    throw new Error("paths.launchAgentPath must be the absolute auditd plist path");
  }
  if (paths.homeDir) {
    const expectedDir = resolve(paths.homeDir, "Library", "LaunchAgents");
    if (resolve(dirname(paths.launchAgentPath)) !== expectedDir) {
      throw new Error("paths.launchAgentPath must be under homeDir/Library/LaunchAgents");
    }
  }
}

function renderPlist(value) {
  const body = Object.entries(value).map(([key, item]) => `${indent(1)}<key>${escapeXml(key)}</key>\n${renderValue(item, 1)}`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict>\n${body}\n</dict>\n</plist>\n`;
}
function renderValue(value, level) {
  if (Array.isArray(value)) return `<array>\n${value.map((v) => `${indent(level + 1)}${renderValue(v, level + 1)}`).join("\n")}\n${indent(level)}</array>`;
  if (value && typeof value === "object") return `<dict>\n${Object.entries(value).map(([k, v]) => `${indent(level + 1)}<key>${escapeXml(k)}</key>\n${indent(level + 1)}${renderValue(v, level + 1)}`).join("\n")}\n${indent(level)}</dict>`;
  if (typeof value === "boolean") return value ? "<true/>" : "<false/>";
  return `<string>${escapeXml(String(value))}</string>`;
}
const indent = (level) => "  ".repeat(level);
const escapeXml = (text) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
