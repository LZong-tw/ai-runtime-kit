import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const EXIT_CODES = Object.freeze({
  healthy: 0,
  degraded: 1,
  stopped: 2,
  blocked: 3,
});
const SENSITIVE_FIELD = /auth|capability|cipher|decrypt|evidence|hmac|key|payload|plaintext|secret|signature|token/i;
const AUDIT_QUERY_COMMANDS = new Map();

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");

export function registerAuditQueryCommand(name, handler) {
  if (typeof name !== "string" || name.trim() === "") {
    throw new TypeError("query command name must be a non-empty string");
  }
  if (typeof handler !== "function") {
    throw new TypeError(`query command "${name}" must be a function`);
  }
  AUDIT_QUERY_COMMANDS.set(name, handler);
}

export async function runAuditCli(argv = [], dependencies = {}) {
  const stdout = dependencies.stdout ?? process.stdout;
  const [command = "help", ...rest] = argv;

  if (command === "help" || command === "-h" || command === "--help") {
    stdout.write(renderAuditHelp());
    return 0;
  }

  if (command === "query") {
    return runAuditQueryCli(rest, dependencies);
  }

  const audit = dependencies.audit ?? await createDefaultAuditDependencies(dependencies);
  const handler = AUDIT_COMMANDS[command];
  if (!handler) throw new Error(`unknown audit command: ${argv.join(" ") || "(none)"}`);

  const result = await handler(rest, audit);
  stdout.write(renderAuditResult(command, result));
  return exitCodeFor(result?.state);
}

const AUDIT_COMMANDS = Object.freeze({
  install: (argv, audit) => audit.install({ write: hasFlag(argv, "--write") }),
  start: (_argv, audit) => audit.start(),
  stop: (_argv, audit) => audit.stop(),
  status: (_argv, audit) => audit.status(),
  doctor: (_argv, audit) => audit.doctor(),
  update: (argv, audit) => audit.update({ write: hasFlag(argv, "--write") }),
  verify: (_argv, audit) => audit.verify(),
});

async function runAuditQueryCli(argv, dependencies) {
  const stdout = dependencies.stdout ?? process.stdout;
  const [name, ...rest] = argv;
  if (!name) {
    const commands = [...AUDIT_QUERY_COMMANDS.keys()].sort();
    stdout.write(commands.length ? `query-commands: ${commands.join(", ")}\n` : "query-commands: none\n");
    return 0;
  }
  const handler = AUDIT_QUERY_COMMANDS.get(name);
  if (!handler) throw new Error(`unknown audit query command: ${name}`);
  const result = await handler({
    args: rest,
    audit: dependencies.audit ?? await createDefaultAuditDependencies(dependencies),
    env: dependencies.env ?? process.env,
    stdout,
  });
  stdout.write(renderAuditResult(`query.${name}`, result));
  return exitCodeFor(result?.state);
}

async function createDefaultAuditDependencies(dependencies = {}) {
  const env = dependencies.env ?? process.env;
  const [{ createMasterKeyProvider }, { resolveAuditPaths }, service, storeModule] = await Promise.all([
    import("./keychain.mjs"),
    import("./paths.mjs"),
    import("./service.mjs"),
    import("./store.mjs"),
  ]);
  const paths = resolveAuditPaths({ env, overrides: dependencies.auditPathOverrides ?? {} });
  const databasePath = env.AIRKIT_AUDIT_DATABASE_PATH ?? `${paths.rootDir}/audit.sqlite`;
  const backupDir = env.AIRKIT_AUDIT_BACKUP_DIR ?? `${paths.rootDir}/backups`;
  const nodePath = dependencies.nodePath ?? process.execPath;
  const daemonPath = dependencies.daemonPath ?? resolve(repoRoot, "src", "auditd.mjs");
  const authHelperPath = dependencies.authHelperPath ?? env.AIRKIT_AUDIT_AUTH_HELPER ?? resolve(repoRoot, "native", "airkit-audit-auth.swift");
  const runLaunchctl = dependencies.runLaunchctl ?? createExecRunner("launchctl");
  const runSecurity = dependencies.runSecurity ?? createExecRunner(env.AIRKIT_SECURITY_PATH || "security");
  const masterKeyProvider = createMasterKeyProvider({ env, runSecurity });

  return {
    async install({ write = false } = {}) {
      const keychain = await inspectKeychain(masterKeyProvider);
      const servicePlan = await service.installAuditService({
        authHelperPath,
        daemonPath,
        nodePath,
        paths,
        runLaunchctl,
        write,
      });
      if (write && !keychain.present) {
        await masterKeyProvider.create();
      }
      return {
        state: write ? "healthy" : keychain.present ? "stopped" : "degraded",
        write,
        keychain: keychain.present ? "present" : write ? "created" : "missing",
        service: servicePlan,
      };
    },

    async start() {
      const result = await service.startAuditService({ authHelperPath, daemonPath, nodePath, paths, runLaunchctl });
      return { state: "healthy", started: true, service: result };
    },

    async stop() {
      const result = await service.stopAuditService({ paths, runLaunchctl });
      return { state: "stopped", stopped: true, service: result };
    },

    async status() {
      return inspectAuditState({
        paths,
        authHelperPath,
        daemonPath,
        nodePath,
        runLaunchctl,
        masterKeyProvider,
        openAuditStore: storeModule.openAuditStore,
        databasePath,
        backupDir,
      });
    },

    async doctor() {
      const result = await inspectAuditState({
        paths,
        authHelperPath,
        daemonPath,
        nodePath,
        runLaunchctl,
        masterKeyProvider,
        openAuditStore: storeModule.openAuditStore,
        databasePath,
        backupDir,
      });
      return { ...result, checked: true };
    },

    async update({ write = false } = {}) {
      return this.install({ write });
    },

    async verify() {
      const database = await inspectDatabase({ backupDir, databasePath, openAuditStore: storeModule.openAuditStore });
      return {
        state: database.present ? (database.ok ? "healthy" : "blocked") : "stopped",
        verified: database.ok,
        database,
      };
    },
  };
}

async function inspectAuditState({
  paths,
  authHelperPath,
  daemonPath,
  nodePath,
  runLaunchctl,
  masterKeyProvider,
  openAuditStore,
  databasePath,
  backupDir,
}) {
  const [keychain, service, database] = await Promise.all([
    inspectKeychain(masterKeyProvider),
    inspectService({ authHelperPath, daemonPath, nodePath, paths, runLaunchctl }),
    inspectDatabase({ backupDir, databasePath, openAuditStore }),
  ]);
  return {
    state: deriveAuditState({ keychain, service, database }),
    database,
    keychain,
    service,
  };
}

async function inspectKeychain(provider) {
  try {
    return { present: await provider.inspect() };
  } catch (error) {
    return { present: false, reason: error?.code ?? "unavailable" };
  }
}

async function inspectService({ authHelperPath, daemonPath, nodePath, paths, runLaunchctl }) {
  const { inspectAuditService } = await import("./service.mjs");
  try {
    const inspected = await inspectAuditService({ authHelperPath, daemonPath, nodePath, paths, runLaunchctl });
    return {
      installed: inspected.installed,
      loaded: inspected.loaded,
      stale: inspected.stale,
      plistPath: inspected.plistPath,
    };
  } catch (error) {
    return { blocked: true, reason: error?.message ?? "service-inspection-failed" };
  }
}

async function inspectDatabase({ backupDir, databasePath, openAuditStore }) {
  if (!(await pathExists(databasePath))) {
    return { ok: false, present: false };
  }

  let store;
  try {
    store = openAuditStore({ backupDir, databasePath, readOnly: true });
    store.verify();
    return { ok: true, present: true };
  } catch (error) {
    return {
      ok: false,
      present: true,
      reason: error?.code ?? error?.message ?? "verify-failed",
    };
  } finally {
    store?.close?.();
  }
}

function deriveAuditState({ keychain, service, database }) {
  if (service.blocked || keychain.reason) return "blocked";
  if (!service.installed && !service.loaded && !database.present) return "stopped";
  if (service.loaded && keychain.present && database.ok) return "healthy";
  return "degraded";
}

function renderAuditHelp() {
  return `Commands:
  audit install [--write]
  audit start
  audit stop
  audit status
  audit doctor
  audit update [--write]
  audit verify
  audit query [name]

Options:
  --write    Apply the change instead of previewing it.
`;
}

function renderAuditResult(command, result = {}) {
  const lines = flattenMetadata({ command, ...sanitizeMetadata(result) });
  return `${lines.length ? lines.join("\n") : `${command}: ok`}\n`;
}

function sanitizeMetadata(value, key = "") {
  if (Buffer.isBuffer(value)) return "[redacted-bytes]";
  if (Array.isArray(value)) return value.map((entry) => sanitizeMetadata(entry, key));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entryValue]) => [
        entryKey,
        SENSITIVE_FIELD.test(entryKey) ? "[redacted]" : sanitizeMetadata(entryValue, entryKey),
      ]),
    );
  }
  if (typeof value === "string") {
    if (SENSITIVE_FIELD.test(key)) return "[redacted]";
    if (isAbsolute(value)) return shortenPath(value);
  }
  return value;
}

function flattenMetadata(value, prefix = "") {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return Object.entries(value).flatMap(([key, entry]) => flattenMetadata(entry, `${prefix}${key}.`));
  }
  const label = prefix.slice(0, -1);
  return [`${label}: ${formatValue(value)}`];
}

function formatValue(value) {
  if (Array.isArray(value)) return value.map((entry) => formatValue(entry)).join(", ");
  if (value && typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function shortenPath(value) {
  const leaf = basename(value);
  return leaf ? `…/${leaf}` : value;
}

function exitCodeFor(state) {
  return EXIT_CODES[state] ?? EXIT_CODES.blocked;
}

function hasFlag(argv, flag) {
  return argv.includes(flag);
}

async function pathExists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

function createExecRunner(command) {
  return async (request) => {
    const args = Array.isArray(request?.args) ? request.args : request;
    const input = request?.input;
    try {
      const result = await execFileAsync(command, args, input === undefined ? {} : { input });
      return { ok: true, status: 0, stderr: result.stderr, stdout: result.stdout };
    } catch (error) {
      return {
        ok: false,
        status: typeof error?.code === "number" ? error.code : 1,
        stderr: error?.stderr ?? error?.message ?? "",
        stdout: error?.stdout ?? "",
      };
    }
  };
}
