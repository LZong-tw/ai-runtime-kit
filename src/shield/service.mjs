import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { promisify } from "node:util";

import { readShieldIdentity, shieldPaths, writeShieldConfig } from "./paths.mjs";

const execFileAsync = promisify(execFile);
export const SHIELD_SERVICE_LABEL = "com.airkit.shield";
const SUBSCRIPTION_TARGET_ORIGIN = "https://api.anthropic.com";

const defaultIo = { chmod, constants, lstat, mkdir, open, readFile, rename, unlink, writeFile };

export function planShieldService({ paths, nodePath, daemonPath } = {}) {
  assertShieldPaths(paths);
  for (const [name, value] of Object.entries({ nodePath, daemonPath })) {
    if (typeof value !== "string" || !isAbsolute(value)) throw new Error(`${name} must be an absolute path`);
  }
  const plist = {
    Label: SHIELD_SERVICE_LABEL,
    ProgramArguments: [nodePath, daemonPath, "--config", paths.configPath],
    EnvironmentVariables: {},
    RunAtLoad: true,
    KeepAlive: true,
    ProcessType: "Background",
  };
  const plistXml = renderPlist(plist);
  return {
    label: SHIELD_SERVICE_LABEL,
    plistPath: paths.launchAgentPath,
    domain: paths.launchdDomain,
    target: paths.launchdTarget,
    plist,
    plistXml,
    operations: [
      { op: "mkdir", path: dirname(paths.launchAgentPath), mode: 0o700 },
      { op: "writeFileAtomic", path: paths.launchAgentPath, mode: 0o600, content: plistXml },
      { op: "bootstrap", domain: paths.launchdDomain, path: paths.launchAgentPath },
      { op: "kickstart", target: paths.launchdTarget, kill: true },
    ],
  };
}

export async function installShieldService({ write = false, io = defaultIo, runLaunchctl = defaultLaunchctl, ...options } = {}) {
  const plan = planShieldService(options);
  if (!write) return plan;
  const config = createShieldConfig(options.config);
  await writeShieldConfig({ paths: options.paths, config, io });
  await io.mkdir(dirname(plan.plistPath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${plan.plistPath}.tmp-${process.pid}`;
  await io.writeFile(temporaryPath, plan.plistXml, { mode: 0o600 });
  await io.chmod(temporaryPath, 0o600);
  await io.rename(temporaryPath, plan.plistPath);
  await launch(runLaunchctl, ["bootstrap", plan.domain, plan.plistPath], true);
  await launch(runLaunchctl, ["kickstart", "-k", plan.target], false);
  return { ...plan, written: true };
}

export function createShieldConfig(config = {}) {
  const lane = config.lane ?? "subscription";
  assertLane(lane);
  const targetOrigin = config.targetOrigin ?? (lane === "subscription" ? SUBSCRIPTION_TARGET_ORIGIN : undefined);
  const validated = {
    capability: config.capability ?? randomUUID().replaceAll("-", ""),
    targetOrigin: normalizeShieldTargetOrigin(targetOrigin, "shield configuration target"),
    lane,
    generation: config.generation ?? randomUUID(),
    targetClass: config.targetClass ?? lane,
  };
  if (validated.targetClass !== lane) throw new Error("shield configuration targetClass must match its lane");
  if (lane === "subscription" && validated.targetOrigin !== SUBSCRIPTION_TARGET_ORIGIN) {
    throw new Error("shield subscription configuration must target api.anthropic.com");
  }
  if (typeof validated.capability !== "string" || validated.capability.length < 32) throw new Error("shield configuration capability is missing or invalid");
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(validated.generation)) throw new Error("shield configuration generation is missing or invalid");
  return validated;
}

export async function startShieldService(options = {}) {
  const { io = defaultIo, runLaunchctl = defaultLaunchctl, ...rest } = options;
  const plan = planShieldService(rest);
  let missing = false;
  try {
    await io.readFile(plan.plistPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") missing = true;
    else throw error;
  }
  if (missing) {
    throw new Error("shield service is not installed; run 'airkit shield install --write' before start");
  }
  await ensurePathDrift(plan, io);
  await launch(runLaunchctl, ["bootstrap", plan.domain, plan.plistPath], true);
  await launch(runLaunchctl, ["kickstart", "-k", plan.target], false);
  return { ...plan, started: true };
}

export async function stopShieldService({ paths, runLaunchctl = defaultLaunchctl } = {}) {
  assertShieldPaths(paths);
  await launch(runLaunchctl, ["bootout", paths.launchdTarget], true);
  return { label: SHIELD_SERVICE_LABEL, stopped: true };
}

export async function inspectShieldService({ paths, io = defaultIo, runLaunchctl = defaultLaunchctl } = {}) {
  assertShieldPaths(paths);
  const installed = await io.readFile(paths.launchAgentPath, "utf8").then(() => true, () => false);
  const printed = await launch(runLaunchctl, ["print", paths.launchdTarget], true);
  const state = /^\s*state = (\S+)\s*$/m.exec(printed.stdout ?? "")?.[1] ?? null;
  const pidValue = /^\s*pid = (\d+)\s*$/m.exec(printed.stdout ?? "")?.[1];
  const pid = pidValue === undefined ? null : Number(pidValue);
  const active = printed.ok && state === "running" && Number.isInteger(pid) && pid > 0;
  return { label: SHIELD_SERVICE_LABEL, installed, loaded: printed.ok, active, pid, state, stale: installed && !active };
}

export async function readShieldConfig({ paths, io = defaultIo } = {}) {
  assertShieldPaths(paths);
  let config;
  try {
    config = JSON.parse(await io.readFile(paths.configPath, "utf8"));
  } catch {
    throw new Error("shield configuration is missing or invalid");
  }
  assertLane(config?.lane);
  if (typeof config.capability !== "string" || config.capability.length < 32) throw new Error("shield configuration capability is missing or invalid");
  const targetOrigin = normalizeShieldTargetOrigin(config.targetOrigin, "shield configuration target");
  if (typeof config.generation !== "string" || !/^[A-Za-z0-9._-]{1,128}$/.test(config.generation)) {
    throw new Error("shield configuration generation is missing or invalid");
  }
  if (config.targetClass !== undefined && config.targetClass !== config.lane) {
    throw new Error("shield configuration targetClass must match its lane");
  }
  return {
    capability: config.capability,
    targetOrigin,
    lane: config.lane,
    generation: config.generation,
    targetClass: config.lane,
  };
}

export async function ensureShieldReady({ lane, expectedTargetOrigin, env = process.env, paths = shieldPaths({ env }), io = defaultIo, inspectService = inspectShieldService, isProcessAlive = defaultIsProcessAlive, probeShield = defaultProbeShield } = {}) {
  assertLane(lane);
  const identity = await readShieldIdentity({ paths, io });
  if (!identity || !(await isProcessAlive(identity.pid))) {
    throw new Error("shield identity is stale; start the shield service and try again");
  }
  const service = await inspectService({ paths, io });
  if (!service.loaded || !service.active) throw new Error("shield identity is stale; shield service is not actively running");
  if (service.pid !== identity.pid) throw new Error("shield service PID mismatch; restart the shield service and try again");
  const config = await readShieldConfig({ paths, io });
  if (config.lane !== lane || identity.lane !== lane || identity.targetClass !== lane) {
    throw new Error("shield lane mismatch; start the service configured for the requested lane");
  }
  const expectedOrigin = lane === "subscription"
    ? SUBSCRIPTION_TARGET_ORIGIN
    : normalizeShieldTargetOrigin(expectedTargetOrigin, "shield managed expected target");
  if (config.targetOrigin !== expectedOrigin) {
    throw new Error("shield target origin mismatch; restart the service with the expected fixed target");
  }
  if (config.generation !== identity.generation) throw new Error("shield configuration generation mismatch; restart the shield service");
  if (config.capability !== identity.capability) throw new Error("shield capability generation mismatch; restart the shield service");
  if (!(await probeShield(identity.origin, identity.capability))) {
    throw new Error("shield listener readiness probe failed; restart the shield service");
  }
  return { origin: identity.origin, capability: identity.capability, targetClass: identity.targetClass };
}

export async function launchShieldChild({ command, args = [], ready, env = process.env, spawnChild = spawn } = {}) {
  if (typeof command !== "string" || command.length === 0 || command.includes("\0")) throw new Error("shield launch command is required");
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string" || arg.includes("\0"))) throw new Error("shield launch arguments must be strings");
  const child = spawnChild(command, args, {
    env: buildShieldChildEnv(ready, env),
    shell: false,
    stdio: "inherit",
  });
  return await new Promise((resolvePromise, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolvePromise({ code, signal }));
  });
}

export function buildShieldChildEnv(ready, env = process.env) {
  if (!ready?.origin || !ready?.capability || ready.targetClass !== ready.lane || (ready.lane !== "subscription" && ready.lane !== "managed")) {
    throw new Error("shield launch requires a fresh lane-bound loopback identity");
  }
  if (/[\r\n]/.test(ready.capability)) {
    throw new Error("shield capability cannot be represented as an HTTP header");
  }
  const keptHeaders = String(env.ANTHROPIC_CUSTOM_HEADERS ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.toLowerCase().startsWith("x-airkit-shield:"));
  return {
    ...env,
    ANTHROPIC_API_BASE_URL: ready.origin,
    ANTHROPIC_BASE_URL: ready.origin,
    ANTHROPIC_CUSTOM_HEADERS: [...keptHeaders, `x-airkit-shield: ${ready.capability}`].join("\n"),
  };
}

function assertLane(lane) {
  if (lane !== "subscription" && lane !== "managed") throw new Error("shield lane must be subscription or managed");
}

function normalizeShieldTargetOrigin(value, label) {
  let target;
  try {
    target = new URL(value);
  } catch {
    target = null;
  }
  if (
    target === null
    || (target.protocol !== "http:" && target.protocol !== "https:")
    || target.username !== ""
    || target.password !== ""
    || target.pathname !== "/"
    || target.search !== ""
    || target.hash !== ""
  ) {
    throw new Error(`${label} origin is missing or invalid`);
  }
  return target.origin;
}

function assertShieldPaths(paths) {
  if (!paths?.rootDir || !paths.configPath || !paths.identityPath || !paths.launchAgentPath || !paths.launchdDomain || !paths.launchdTarget) {
    throw new TypeError("shield service paths are required");
  }
  if (!/^gui\/\d+$/.test(paths.launchdDomain) || paths.launchdTarget !== `${paths.launchdDomain}/${SHIELD_SERVICE_LABEL}`) {
    throw new Error("paths.launchdTarget must target com.airkit.shield");
  }
  if (!isAbsolute(paths.launchAgentPath) || basename(paths.launchAgentPath) !== `${SHIELD_SERVICE_LABEL}.plist`) {
    throw new Error("paths.launchAgentPath must be the absolute shield plist path");
  }
  if (!isAbsolute(paths.rootDir) || paths.configPath !== resolve(paths.rootDir, "config.json") || paths.identityPath !== resolve(paths.rootDir, "identity.json")) {
    throw new Error("shield service paths must use the canonical shield state layout");
  }
}

async function ensurePathDrift(plan, io) {
  const existing = await io.readFile(plan.plistPath, "utf8");
  if (existing !== plan.plistXml) throw new Error(`shield launch plist path drift detected: ${plan.plistPath}`);
}

async function launch(runLaunchctl, args, tolerateFailure) {
  const result = await runLaunchctl(args);
  if (result?.ok === false && !(tolerateFailure && /already (loaded|bootstrapped)|could not find service|no such process/i.test(result.stderr ?? ""))) {
    throw new Error(`launchctl ${args[0]} failed: ${result.stderr ?? "unknown error"}`);
  }
  return { ok: result?.ok !== false, ...result };
}

async function defaultLaunchctl(args) {
  try {
    const result = await execFileAsync("launchctl", args);
    return { ok: true, status: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return { ok: false, status: error.code, stderr: error.stderr ?? error.message };
  }
}

async function defaultProbeShield(origin, capability) {
  try {
    const response = await fetch(new URL("/_airkit/shield/ready", origin), {
      headers: { "x-airkit-shield": capability },
      redirect: "manual",
      signal: AbortSignal.timeout(1_000),
    });
    await response.body?.cancel();
    return response.status === 204;
  } catch {
    return false;
  }
}

async function defaultIsProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function renderPlist(value) {
  const body = Object.entries(value).map(([key, item]) => `${indent(1)}<key>${escapeXml(key)}</key>\n${renderValue(item, 1)}`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict>\n${body}\n</dict>\n</plist>\n`;
}

function renderValue(value, level) {
  if (Array.isArray(value)) return `<array>\n${value.map((entry) => `${indent(level + 1)}${renderValue(entry, level + 1)}`).join("\n")}\n${indent(level)}</array>`;
  if (value && typeof value === "object") return `<dict>\n${Object.entries(value).map(([key, entry]) => `${indent(level + 1)}<key>${escapeXml(key)}</key>\n${indent(level + 1)}${renderValue(entry, level + 1)}`).join("\n")}\n${indent(level)}</dict>`;
  if (typeof value === "boolean") return value ? "<true/>" : "<false/>";
  return `<string>${escapeXml(String(value))}</string>`;
}

const indent = (level) => "  ".repeat(level);
const escapeXml = (text) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
