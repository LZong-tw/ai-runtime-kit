import { execFile } from "node:child_process";
import { spawn } from "node:child_process";
import { access, chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
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
  // A metadata export streamed to stdout is itself the CLI artifact; appending
  // a status line would corrupt JSONL/CSV. File exports may still report status.
  if (command !== "export" || hasFlag(rest, "--output")) stdout.write(renderAuditResult(command, result));
  return exitCodeFor(result?.state);
}

const AUDIT_COMMANDS = {
  install: (argv, audit) => audit.install({ write: hasFlag(argv, "--write") }),
  start: (_argv, audit) => audit.start(),
  stop: (_argv, audit) => audit.stop(),
  status: (_argv, audit) => audit.status(),
  doctor: (_argv, audit) => audit.doctor(),
  update: (argv, audit) => audit.update({ write: hasFlag(argv, "--write") }),
  verify: (_argv, audit) => audit.verify(),
  prune: (argv, audit) => audit.prune({
    write: hasFlag(argv, "--write"),
    preserve: hasFlag(argv, "--preserve"),
    retentionDays: numericFlag(argv, "--retention-days", 90),
    batchSize: numericFlag(argv, "--batch-size", 500),
  }),
  export: (argv, audit) => audit.export({
    format: valueFlag(argv, "--format", "jsonl"),
    includePayload: hasFlag(argv, "--include-payload"),
    decrypt: hasFlag(argv, "--decrypt"),
    outputPath: valueFlag(argv, "--output", undefined),
  }),
  repo: (argv, audit) => audit.repo({
    action: argv[0],
    repositoryId: argv[1],
    classification: argv[2],
    write: hasFlag(argv, "--write"),
  }),
  account: (argv, audit) => audit.account({
    action: argv[0],
    accountId: argv[1],
    group: argv[2],
    write: hasFlag(argv, "--write"),
  }),
};

for (const queryName of ["requests", "request", "sessions", "clients", "accounts", "repos", "usage", "cache", "gaps"]) {
  AUDIT_COMMANDS[queryName] = (argv, audit) => audit.query(queryName, argv.filter((arg) => arg !== "--json"));
}
Object.freeze(AUDIT_COMMANDS);

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
  const [{ createMasterKeyProvider }, { resolveAuditPaths }, service, storeModule, retention, exporter, revealExport, reveal] = await Promise.all([
    import("./keychain.mjs"),
    import("./paths.mjs"),
    import("./service.mjs"),
    import("./store.mjs"),
    import("./retention.mjs"),
    import("./export.mjs"),
    import("./reveal-export.mjs"),
    import("./reveal.mjs"),
  ]);
  const paths = resolveAuditPaths({ env, overrides: dependencies.auditPathOverrides ?? {} });
  const databasePath = env.AIRKIT_AUDIT_DATABASE_PATH ?? `${paths.rootDir}/audit.sqlite`;
  const backupDir = env.AIRKIT_AUDIT_BACKUP_DIR ?? `${paths.rootDir}/backups`;
  const nodePath = dependencies.nodePath ?? process.execPath;
  const daemonPath = dependencies.daemonPath ?? resolve(repoRoot, "src", "auditd.mjs");
  const authHelperPath = dependencies.authHelperPath ?? env.AIRKIT_AUDIT_AUTH_HELPER ?? resolve(repoRoot, "native", "airkit-audit-auth.swift");
  const runLaunchctl = dependencies.runLaunchctl ?? createExecRunner("launchctl");
  const runSecurity = dependencies.runSecurity ?? createExecRunner(env.AIRKIT_SECURITY_PATH || "security");
  const masterKeyProvider = dependencies.masterKeyProvider ?? createMasterKeyProvider({ env, runSecurity });
  const openAuditStore = dependencies.openAuditStore ?? storeModule.openAuditStore;

  return {
    async install({ write = false } = {}) {
      const keychain = await inspectKeychain(masterKeyProvider);
      const capabilityFile = paths.capabilityFile ?? resolve(paths.rootDir, "capability");
      if (write) {
        await ensureCapabilityFile(capabilityFile);
        if (!keychain.present) await masterKeyProvider.create();
      }
      const servicePlan = await service.installAuditService({
        authHelperPath,
        daemonPath,
        nodePath,
        paths,
        runLaunchctl,
        write,
      });
      const serviceState = write
        ? await inspectService({ authHelperPath, daemonPath, nodePath, paths, runLaunchctl })
        : null;
      const socketReady = write && await pathExists(paths.socketPath);
      return {
        state: write ? (serviceState.loaded && socketReady ? "healthy" : "degraded") : keychain.present ? "stopped" : "degraded",
        write,
        keychain: keychain.present ? "present" : write ? "created" : "missing",
        serviceState,
        socketReady: write ? socketReady : null,
        service: servicePlan,
      };
    },

    async start() {
      const keychain = await inspectKeychain(masterKeyProvider);
      const capabilityFile = paths.capabilityFile ?? resolve(paths.rootDir, "capability");
      await ensureCapabilityFile(capabilityFile);
      if (!keychain.present) await masterKeyProvider.create();
      const result = await service.startAuditService({ authHelperPath, daemonPath, nodePath, paths, runLaunchctl });
      const serviceState = await inspectService({ authHelperPath, daemonPath, nodePath, paths, runLaunchctl });
      const socketReady = await pathExists(paths.socketPath);
      return { state: serviceState.loaded && socketReady ? "healthy" : "degraded", started: true, socketReady, service: result };
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
        openAuditStore,
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
        openAuditStore,
        databasePath,
        backupDir,
      });
      return { ...result, checked: true };
    },

    async update({ write = false } = {}) {
      return this.install({ write });
    },

    async verify() {
      const database = await inspectDatabase({ backupDir, databasePath, openAuditStore });
      return {
        state: database.present ? (database.ok ? "healthy" : "blocked") : "stopped",
        verified: database.ok,
        database,
      };
    },

    async prune({ write = false, preserve = false, retentionDays = 90, batchSize = 500 } = {}) {
      if (!write || preserve) {
        return retention.pruneExpiredPayloads(null, { write: false, preserve, retentionDays, batchSize });
      }
      const store = openAuditStore({ backupDir, databasePath, readOnly: false });
      try {
        const result = await retention.pruneExpiredPayloads(store, {
          write: true,
          retentionDays,
          batchSize,
        });
        return { state: "healthy", ...result };
      } finally {
        store.close();
      }
    },

    async export({ format = "jsonl", includePayload = false, decrypt = false, outputPath } = {}) {
      const store = openAuditStore({ backupDir, databasePath, readOnly: true });
      try {
        const options = {
          format,
          includePayload,
          decrypt,
          outputPath,
          output: dependencies.stdout ?? process.stdout,
          signalProcess: dependencies.signalProcess,
        };
        if (includePayload && dependencies.authorizer && dependencies.decryptRow) {
          options.interactive = dependencies.interactive ?? false;
          options.authorizer = dependencies.authorizer;
          options.decryptRow = dependencies.decryptRow;
        } else if (includePayload) {
          const authorizer = dependencies.revealAuthorizer ?? reveal.createRevealAuthorizer({
            runHelper: dependencies.runAuditAuth ?? createExecRunner(authHelperPath),
            env,
          });
          const coordinator = dependencies.revealCoordinator ?? revealExport.createRevealExportCoordinator({
            authorizer,
            masterKeyProvider,
            runHelper: dependencies.runAuditAuth ?? createExecRunner(authHelperPath),
            publicKey: dependencies.publicKey,
            confirm: dependencies.confirmReveal ?? revealExport.createInteractiveRevealConfirmation(),
            env,
          });
          options.authorizeExport = coordinator.authorizeExport;
          options.decryptRow = coordinator.decryptRow;
        }
        return await exporter.exportAuditData(store, options);
      } finally {
        store.close();
      }
    },

    async repo({ action, repositoryId, classification, write = false } = {}) {
      if (action !== "classify" || !repositoryId || !classification) {
        throw new Error("usage: audit repo classify <repository-id> <classification> [--write]");
      }
      if (!write) return { state: "stopped", write: false, repositoryId, classification };
      const store = openAuditStore({ backupDir, databasePath, readOnly: false });
      try {
        const result = store.classifyRepository(repositoryId, classification);
        return { state: "healthy", write: true, repositoryId, classification, changed: result.changes ?? 0 };
      } finally {
        store.close();
      }
    },

    async account({ action, accountId, group, write = false } = {}) {
      if (action !== "group" || !accountId || !group) {
        throw new Error("usage: audit account group <account-id> <logical-group> [--write]");
      }
      if (!write) return { state: "stopped", write: false, accountId, group };
      const store = openAuditStore({ backupDir, databasePath, readOnly: false });
      try {
        const result = store.groupProviderAccount(accountId, group);
        return { state: "healthy", write: true, accountId, group, changed: result.changes ?? 0 };
      } finally {
        store.close();
      }
    },

    async query(name, args = []) {
      const store = openAuditStore({ backupDir, databasePath, readOnly: true });
      try {
        return { state: "healthy", name, rows: queryAuditStore(store, name, args) };
      } finally {
        store.close();
      }
    },
  };
}

const AUDIT_QUERY_SQL = Object.freeze({
  requests: `SELECT request_id, logical_request_id, session_id, repository_id, provider, model,
    client, started_at, last_observed_at, actual_provider, actual_model, status_code,
    capture_completeness, correlation_confidence FROM requests ORDER BY started_at, id`,
  request: `SELECT request_id, logical_request_id, session_id, repository_id, provider, model,
    client, started_at, last_observed_at, actual_provider, actual_model, status_code,
    capture_completeness, correlation_confidence FROM requests
    WHERE request_id = ? OR logical_request_id = ? ORDER BY started_at, id`,
  sessions: "SELECT session_id, client, first_observed_at, last_observed_at FROM sessions ORDER BY first_observed_at, session_id",
  clients: `SELECT client, COUNT(*) AS event_count, MIN(observed_at) AS first_observed_at,
    MAX(observed_at) AS last_observed_at,
    CASE WHEN SUM(event_kind = 'provider_request') > 0 AND SUM(event_kind = 'usage_reported') > 0
      THEN 'complete' WHEN COUNT(*) > 0 THEN 'metadata_only' ELSE 'gap' END AS completeness
    FROM source_events GROUP BY client ORDER BY client`,
  accounts: `SELECT provider_account_id, provider, first_observed_at, last_observed_at,
    logical_group, credential_kind, display_label, identity_source
    FROM provider_accounts ORDER BY provider, provider_account_id`,
  repos: `SELECT repository_id, id, classification, classification_source,
    remote_display, first_seen_at, last_seen_at FROM repositories ORDER BY repository_id`,
  usage: `SELECT r.request_id, r.provider, r.model, ru.metric, ru.value, ru.unit,
    ru.cache_read_tokens, ru.cache_creation_5m_tokens, ru.cache_creation_1h_tokens,
    ru.uncached_input_tokens, ru.output_tokens, ru.derived_total_cost, ru.normalization_state
    FROM request_usage ru JOIN requests r ON r.id = ru.request_id ORDER BY r.started_at, ru.request_usage_id`,
  cache: `SELECT r.request_id, r.provider, r.model, ru.cache_read_tokens,
    ru.cache_creation_5m_tokens, ru.cache_creation_1h_tokens, ru.cache_miss_tokens,
    ru.uncached_input_tokens, ru.cache_reuse_ratio, ru.normalization_state
    FROM request_usage ru JOIN requests r ON r.id = ru.request_id
    WHERE ru.cache_read_tokens IS NOT NULL OR ru.cache_creation_5m_tokens IS NOT NULL
      OR ru.cache_creation_1h_tokens IS NOT NULL OR ru.cache_miss_tokens IS NOT NULL
    ORDER BY r.started_at, ru.request_usage_id`,
  gaps: `SELECT 'evidence' AS gap_kind, source, reason, recorded_at, affected_client,
    affected_session, resolution FROM evidence_gaps
    UNION ALL SELECT 'collector', source, reason, recorded_at, NULL, NULL, NULL FROM collector_gaps
    ORDER BY recorded_at`,
});

function queryAuditStore(store, name, args = []) {
  const sql = AUDIT_QUERY_SQL[name];
  if (!sql) throw new Error(`unknown audit query command: ${name}`);
  if (name === "request") {
    const id = args.find((arg) => !arg.startsWith("--"));
    if (!id) throw new Error("usage: audit request <request-id>");
    return store.query(sql, [id, id]);
  }
  return store.query(sql);
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
  audit prune [--write] [--preserve]
  audit export [--format jsonl|csv] [--output path] [--include-payload --decrypt]
  audit repo classify <repository-id> <classification> [--write]
  audit account group <account-id> <logical-group> [--write]
  audit requests|request|sessions|clients|accounts|repos|usage|cache|gaps [id]
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
    return scrubEmbeddedAbsolutePaths(value);
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

function scrubEmbeddedAbsolutePaths(value) {
  if (isAbsolute(value)) return shortenPath(value);

  let result = "";
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== "/") {
      result += value[index];
      continue;
    }

    let end = index + 1;
    while (end < value.length && !isPathDelimiter(value[end])) {
      end += 1;
    }

    const candidate = value.slice(index, end);
    const match = candidate.match(/^(.*?)([),.:;\]}]+)?$/);
    const pathPart = match?.[1] ?? candidate;
    const suffix = match?.[2] ?? "";
    if (looksLikeUnixAbsolutePath(pathPart)) {
      result += `${shortenPath(pathPart)}${suffix}`;
      index = end - 1;
      continue;
    }

    result += value[index];
  }
  return result;
}

function looksLikeUnixAbsolutePath(value) {
  return isAbsolute(value)
    && value.includes("/")
    && /^\/(?:Users|private|tmp|var|opt|Volumes|Library|Applications|System|bin|sbin|etc|usr|dev|cores|Network|home)\//.test(value);
}

function isPathDelimiter(char) {
  return /\s|["'`<>{}|[\]()]/.test(char);
}

function exitCodeFor(state) {
  return EXIT_CODES[state] ?? EXIT_CODES.blocked;
}

function hasFlag(argv, flag) {
  return argv.includes(flag);
}

function valueFlag(argv, flag, fallback) {
  const index = argv.indexOf(flag);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
}

function numericFlag(argv, flag, fallback) {
  const value = Number(valueFlag(argv, flag, fallback));
  if (!Number.isInteger(value) || value < 1) throw new RangeError(`${flag} must be a positive integer`);
  return value;
}

async function pathExists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function ensureCapabilityFile(path) {
  if (await pathExists(path)) {
    const existing = (await readFile(path, "utf8")).trim();
    if (/^[0-9a-f]{64}$/i.test(existing)) return existing;
    throw new Error("audit capability file is invalid; remove it only after inspecting the audit service state");
  }
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const capability = randomBytes(32).toString("hex");
  const tempPath = `${path}.tmp-${process.pid}`;
  await writeFile(tempPath, `${capability}\n`, { mode: 0o600 });
  await chmod(tempPath, 0o600);
  await rename(tempPath, path);
  return capability;
}

function createExecRunner(command) {
  return async (request) => {
    const args = Array.isArray(request?.args) ? request.args : request;
    const input = request?.input;
    if (input === undefined) {
      try {
        const result = await execFileAsync(command, args, { timeout: 15_000, maxBuffer: 4 * 1024 });
        return { ok: true, status: 0, stderr: result.stderr, stdout: result.stdout };
      } catch (error) {
        return { ok: false, status: typeof error?.code === "number" ? error.code : 1, stderr: error?.stderr ?? error?.message ?? "", stdout: error?.stdout ?? "" };
      }
    }
    return runPipedCommand(command, args, input);
  };
}

function runPipedCommand(command, args, input) {
  return new Promise((resolveResult) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    const timer = setTimeout(() => child.kill("SIGTERM"), 15_000);
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", (error) => {
      clearTimeout(timer);
      resolveResult({ ok: false, status: typeof error?.code === "number" ? error.code : 1, stderr: error.message, stdout: "" });
    });
    child.once("close", (status) => {
      clearTimeout(timer);
      resolveResult({ ok: status === 0, status: status ?? 1, stderr: Buffer.concat(stderr).toString(), stdout: Buffer.concat(stdout).toString() });
    });
    child.stdin.end(input);
  });
}
