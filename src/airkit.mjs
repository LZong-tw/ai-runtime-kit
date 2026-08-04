#!/usr/bin/env node

import { access, chmod, copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import { readdirSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

import {
  codexSafetyPaths,
  inspectCodexTakeover,
  repairCodexTakeover,
} from "./codex-takeover-guard.mjs";
import {
  VERIFIED_NATIVE_COMPATIBILITY,
  AIRKIT_MODE_HEADER,
  airkitModeLabel,
  isAirkitModeLabel,
  resolveCompatibilityPolicies,
  validateCompatibilityConfig,
  validateCompatibilityProviderBinding,
} from "./compat/config.mjs";
import { startCompatibilityMiddleware } from "./compat/middleware.mjs";
import { renderHeartbeatManagedFiles } from "./context-heartbeat.mjs";
import { buildContextObservability } from "./context-observability.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const defaultCatalogPath = join(repoRoot, "profiles", "catalog.json");
const compatibilityPluginId = "airkit-compatibility";
const compatibilityPluginModule = join(here, "compat", "plugin.mjs");
export const RUNTIME_REQUIREMENTS = Object.freeze({
  claudeCode: ">=2.1.208",
  claudeCodeRouter: ">=3.0.4 <4",
  node: ">=22",
});
const RUNTIME_TARGETS = Object.freeze({ claudeCode: "2.1.208", claudeCodeRouter: "3.0.4" });
const reusableRuntimeLessonsPrompt = [
  "AirKit reusable runtime lessons:",
  "Treat durable lessons, project memory, and user corrections as hard constraints. Before retrying a failed command, check whether the failure matches a known lesson.",
  "When a user correction or repeated tool failure reveals a durable lesson, record it in the workspace's durable notes when available, using Symptom/Cause/Rule/Action/Verify. Do not record secrets, private endpoints, credential values, or company-only identifiers in shared notes.",
  "For Athena and similar query services, never assume the database, catalog, region, workgroup, or result output location. Discover or verify them first, pass explicit query context and result configuration, and inspect get-query-execution StateChangeReason before calling get-query-results after a failure.",
  "When a command fails inside a shell wrapper, first verify whether the command is a shell wrapper or the real binary with type, command -v, or whence. Rule out local shell wrapper/helper leakage before diagnosing the remote service.",
].join(" ");

export async function loadCatalog(path = defaultCatalogPath, options = {}) {
  const raw = await readFile(path, "utf8");
  const catalog = JSON.parse(raw);
  validateCatalog(catalog);

  if (options.includeLocal !== false) {
    const localPath = join(dirname(path), "catalog.local.json");
    try {
      const localRaw = await readFile(localPath, "utf8");
      const localCatalog = JSON.parse(localRaw);
      if (localCatalog && Array.isArray(localCatalog.profiles)) {
        for (const p of localCatalog.profiles) {
          const existingIdx = catalog.profiles.findIndex((item) => item.name === p.name);
          if (existingIdx >= 0) {
            catalog.profiles[existingIdx] = p;
          } else {
            catalog.profiles.push(p);
          }
        }
      }
    } catch {
      // Ignore missing or unreadable local catalog
    }
  }

  return catalog;
}

export function buildCcrConfig(catalog, profileName, options = {}) {
  const profile = findProfile(catalog, profileName);
  if (!profile.ccr) {
    throw new Error(`profile "${profileName}" does not define a CCR config`);
  }
  const config = renderTemplateValue(structuredClone(profile.ccr), profileTemplateVars(profile, options.configDir));
  validateConfiguredCompatibility(config);
  if (!Array.isArray(config.plugins)) return config;
  config.plugins = config.plugins.map((plugin) => plugin?.id === compatibilityPluginId
    ? { ...plugin, module: compatibilityPluginModule }
    : plugin);
  return config;
}

export function buildCcr3ManagedConfig(catalog, profileName, currentConfig = {}, options = {}) {
  const profile = findProfile(catalog, profileName);
  const configDir = resolve(options.configDir ?? defaultConfigDir());
  const templateVars = profileTemplateVars(profile, configDir);
  const launch = resolveLaunchConfig(profile, templateVars);
  const modes = Object.keys(launch.modes ?? { auto: {} }).sort();
  for (const mode of modes) {
    // Every mode must round-trip through the header contract: a label the
    // plugin would reject — or one like "__proto__" that a plain-object
    // route table would silently swallow — fails here instead of losing its
    // routes at request time.
    if (!isAirkitModeLabel(airkitModeLabel(mode))) {
      throw new Error(`launch mode cannot be labeled through ${AIRKIT_MODE_HEADER}: ${mode}`);
    }
  }
  const managedPrefix = `airkit-${slug(profile.name)}-`;
  const ownedPrefixes = catalogManagedPrefixes(catalog, installedProfileNames(configDir));
  const pruned = { profiles: [], providers: [], rules: [] };
  const providerBaseUrl = String(
    options.providerBaseUrl ?? options.env?.AIRCLAUDE_PROVIDER_BASE_URL ?? "",
  ).trim();
  const baseConfig = buildCcrConfig(catalog, profileName, { configDir });
  assertCcr3Compatible(baseConfig);
  const managedProviderEntries = baseConfig.Providers.map((provider) => {
    const id = `airkit-provider-${slug(profile.name)}-${slug(provider.name)}`;
    return {
      sourceName: provider.name,
      config: {
        ...provider,
        api_base_url: providerBaseUrl && provider.type === "openai_chat_completions"
          ? providerBaseUrl
          : provider.api_base_url,
        id,
        name: id,
        api_key: options.apiKeys?.[provider.name] ?? provider.api_key,
      },
    };
  });
  const managedProviders = managedProviderEntries.map((entry) => entry.config);
  const managedProviderIds = new Map(managedProviderEntries.map((entry) => [entry.sourceName, entry.config.id]));
  bindManagedCompatibilityProvider(baseConfig, managedProviderIds);
  const managedRouteSelector = (route) => {
    const selector = routeSelector(route);
    const separator = selector.indexOf("/");
    const providerName = selector.slice(0, separator);
    const providerId = managedProviderIds.get(providerName);
    if (!providerId) throw new Error(`CCR route references unmanaged provider: ${providerName}`);
    return `${providerId}/${selector.slice(separator + 1)}`;
  };
  const modeConfigs = new Map(
    modes.map((mode) => [mode, applyLaunchModeOverlay(structuredClone(baseConfig), profile, mode, templateVars)]),
  );
  bindManagedCompatibilityRoutes(baseConfig, managedRouteSelector, modeConfigs, resolveClaudeLaunchModel(profile));
  const compatibility = configuredCompatibility(baseConfig)
    ? structuredClone(configuredCompatibility(baseConfig))
    : null;
  if (Array.isArray(baseConfig.plugins)) {
    baseConfig.plugins = baseConfig.plugins.filter((plugin) => plugin?.id !== compatibilityPluginId);
  }
  const managedProviderNames = new Set(managedProviderEntries.map((entry) => entry.sourceName));
  const managedProviderIdSet = new Set(managedProviders.map((provider) => provider.id));
  for (const provider of currentConfig.Providers ?? []) {
    const managedEntry = managedProviderEntries.find((candidate) => candidate.sourceName === provider.name);
    const isOwned = managedProviderIdSet.has(provider.id);
    const isMatchingCcrImport = managedEntry && provider.id?.startsWith(`provider-${slug(provider.name)}-`)
      && provider.api_base_url === managedEntry.config.api_base_url
      && JSON.stringify([...(provider.models ?? [])].sort()) === JSON.stringify([...(managedEntry.config.models ?? [])].sort());
    if (managedProviderNames.has(provider.name) && !isOwned && !isMatchingCcrImport) {
      throw new Error(`unowned CCR provider name collision: ${provider.name}`);
    }
    if (managedProviderIdSet.has(provider.name) && !isOwned) {
      throw new Error(`unowned CCR provider name collision: ${provider.name}`);
    }
  }
  const preservedProviders = (currentConfig.Providers ?? []).filter((provider) => {
    if (managedProviderNames.has(provider.name) || managedProviderIdSet.has(provider.id)) return false;
    const owned = {
      managedPrefix: `airkit-provider-${slug(profile.name)}-`,
      ownedPrefixes: ownedPrefixes.providers,
      namespace: "airkit-provider-",
    };
    switch (classifyManagedId(provider.id, owned)) {
      // Inside this profile's own namespace but absent from what it now
      // generates: a provider dropped from the profile, replaced like any other
      // regenerated state rather than reported as somebody else's leftovers.
      case "mine": return false;
      case "orphan": pruned.providers.push(provider.id); return false;
      default: return true;
    }
  });
  const managedProfiles = modes.map((mode) => {
    const modeConfig = modeConfigs.get(mode);
    const claudeModel = resolveClaudeLaunchModel(profile);
    const launchVars = launchTemplateVars(profile, configDir, mode, modeConfig, claudeModel);
    return {
      agent: "claude-code",
      enabled: true,
      env: {
        ...airclaudeLaunchEnv(catalog, profile, mode, modeConfig, options.env),
        ...renderTemplateValue(launch.env ?? {}, launchVars),
        ...contextLaunchEnv(profile),
        ANTHROPIC_CUSTOM_HEADERS: `${AIRKIT_MODE_HEADER}: ${airkitModeLabel(mode)}`,
        CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1",
      },
      id: `${managedPrefix}${slug(mode)}`,
      model: managedRouteSelector(modeConfig.Router?.default),
      name: `AirKit ${profile.name} ${mode}`,
      scope: "ccr",
      settingsFile: join(configDir, "ccr-profiles", `${managedPrefix}${slug(mode)}`, "settings.json"),
      smallFastModel: managedRouteSelector(modeConfig.Router?.background ?? modeConfig.Router?.default),
      surface: "cli",
    };
  });
  const currentProfiles = currentConfig.profile?.profiles ?? [];

  return {
    config: {
      ...structuredClone(currentConfig),
      Providers: [...preservedProviders, ...managedProviders],
      Router: mergeManagedRouter(
        currentConfig.Router,
        buildManagedRouterRules(baseConfig, managedRouteSelector, managedPrefix),
        managedPrefix,
        { ownedPrefixes: ownedPrefixes.profiles, pruned: pruned.rules },
      ),
      ...mergeManagedConfigArrays(currentConfig, baseConfig, managedPrefix),
      ...(compatibility
        ? { observability: { ...(currentConfig.observability ?? {}), requestLogs: true } }
        : {}),
      profile: {
        ...(currentConfig.profile ?? {}),
        enabled: true,
        profiles: [
          ...currentProfiles.filter((candidate) => {
            const owned = { managedPrefix, ownedPrefixes: ownedPrefixes.profiles, namespace: "airkit-" };
            switch (classifyManagedId(candidate.id, owned)) {
              case "mine": return false;
              case "orphan": pruned.profiles.push(candidate.id); return false;
              default: return true;
            }
          }),
          ...managedProfiles,
        ],
      },
    },
    ...(compatibility ? { compatibility } : {}),
    profileIds: Object.fromEntries(modes.map((mode) => [mode, `${managedPrefix}${slug(mode)}`])),
    pruned,
  };
}

// Every merge above preserves whatever lies outside the current profile's
// prefix, so a profile that leaves the catalog — renamed, removed, or folded
// into another profile's mode — strands its managed CCR artifacts with no code
// path left that can remove them. Stale Router rules are not inert: CCR picks
// the first matching rule, so an orphan whose condition is broader than the
// live ones (a bare `claude-` prefix emitted by an older AirKit build) silently
// outranks every correct route. Drop artifacts owned by no catalog profile.
//
// Ownership is decided by prefix membership, not by parsing a profile name back
// out of an id: slugs contain dashes, so `airkit-web-litellm-route-default` is
// not attributable to "web" versus "web-litellm" by parsing. Because prefixes
// nest, membership alone is not enough — see managedIdOwner, which resolves an
// id to its longest matching owner so a launch of "web" cannot claim, and
// therefore silently replace, "web-litellm"'s artifacts.
// Removing state on the user's behalf has to be visible, so name what went and
// which profile it belonged to rather than letting a launch quietly shrink the
// live config.
function reportPrunedManagedState(pruned, stderr) {
  const removed = [
    ...(pruned?.rules ?? []).map((id) => `router rule ${id}`),
    ...(pruned?.providers ?? []).map((id) => `provider ${id}`),
    ...(pruned?.profiles ?? []).map((id) => `ccr profile ${id}`),
  ];
  if (removed.length === 0) return;
  stderr.write(`airkit: removed CCR state left by profiles no longer in the catalog:\n${removed.map((entry) => `  - ${entry}\n`).join("")}`);
}

function catalogManagedPrefixes(catalog, installedNames = []) {
  const profiles = [];
  const providers = [];
  const names = new Set(installedNames);
  for (const candidate of catalog?.profiles ?? []) {
    if (typeof candidate?.name !== "string" || candidate.name === "") continue;
    names.add(candidate.name);
  }
  for (const name of names) {
    profiles.push(`airkit-${slug(name)}-`);
    providers.push(`airkit-provider-${slug(name)}-`);
  }
  return { profiles, providers };
}

// One CCR install can be driven by more than one catalog: the private overlay
// repo ships `oneportal-lowcost` while the OSS checkout ships only its example,
// so ownership decided from the loaded catalog alone would let a launch from
// either side delete the other's live state. The generated profile files are the
// machine's record of which AirKit profiles are actually installed, so they own
// their prefixes too. An unreadable or absent directory just means no extra
// owners, never a licence to remove more.
function installedProfileNames(configDir) {
  if (typeof configDir !== "string" || configDir === "") return [];
  try {
    return readdirSync(join(configDir, "ccr"))
      .filter((entry) => entry.endsWith(".json"))
      .map((entry) => entry.slice(0, -".json".length));
  } catch {
    return [];
  }
}

// Slugs contain dashes, so one owner prefix can be a prefix of another: with
// both "web" and "web-litellm" installed, `airkit-web-litellm-route-default`
// starts with `airkit-web-` too. The longest matching owner wins, because the
// shorter one winning would let a launch of "web" replace its sibling's live
// state — and that deletion is silent, since state claimed as the launching
// profile's own is never reported as pruned.
function managedIdOwner(id, ownedPrefixes, namespace) {
  const value = String(id ?? "");
  if (!value.startsWith(namespace)) return null;
  let owner = null;
  for (const prefix of ownedPrefixes) {
    if (value.startsWith(prefix) && (owner === null || prefix.length > owner.length)) owner = prefix;
  }
  return owner;
}

// "mine" is replaced by freshly generated state, "other" belongs to a profile
// that is still installed and must survive untouched, "orphan" is owned by
// nobody and gets removed, and "foreign" was never AirKit's to begin with.
function classifyManagedId(id, { managedPrefix, ownedPrefixes, namespace }) {
  const value = String(id ?? "");
  if (!value.startsWith(namespace)) return "foreign";
  const owner = managedIdOwner(value, [...ownedPrefixes, managedPrefix], namespace);
  if (owner === managedPrefix) return "mine";
  // An empty owner list would make every managed id look orphaned; treat an
  // unattributable id as foreign rather than removing it on a guess.
  return owner === null ? (ownedPrefixes.length === 0 ? "foreign" : "orphan") : "other";
}

function orphanManagedIds(ids, ownedPrefixes, namespace) {
  if (ownedPrefixes.length === 0) return [];
  return ids
    .map((id) => String(id ?? ""))
    .filter((id) => id.startsWith(namespace) && managedIdOwner(id, ownedPrefixes, namespace) === null);
}

// A launch removes orphaned state, but a launch is also the only thing that
// does, so until one happens those rules keep deciding live traffic. Reporting
// the same set read-only lets doctor name what is wrong now instead of leaving
// the user to infer it from a routing symptom.
function findOrphanedManagedState(catalog, currentConfig = {}, options = {}) {
  const configDir = resolve(options.configDir ?? defaultConfigDir());
  const owned = catalogManagedPrefixes(catalog, installedProfileNames(configDir));
  return {
    profiles: orphanManagedIds((currentConfig.profile?.profiles ?? []).map(({ id }) => id), owned.profiles, "airkit-"),
    providers: orphanManagedIds((currentConfig.Providers ?? []).map(({ id }) => id), owned.providers, "airkit-provider-"),
    rules: orphanManagedIds((currentConfig.Router?.rules ?? []).map(({ id }) => id), owned.profiles, "airkit-"),
  };
}

// Doctor must never change what it inspects: `autoStart: false` reports a
// stopped management service instead of starting one, and a service it cannot
// reach is missing information rather than a failed check. One getConfig answers
// every live question, because two checks about one snapshot must not disagree.
async function inspectLiveCcrState(catalog, options = {}) {
  const createCcrClient = options.createCcrClient ?? createCcr3Client;
  const client = options.ccrClient ?? createCcrClient({ ...options, autoStart: false });
  // Counted before the RPC and reported either way: a duplicate service is a
  // plausible reason for the RPC to answer from somewhere unexpected, or not at
  // all, so it is exactly the case where suppressing it would hide the cause.
  const managementServices = await inspectManagementServices(options);
  let currentConfig;
  try {
    currentConfig = await client.getConfig();
  } catch (error) {
    const reason = `live CCR state not inspected: ${error.message}`;
    return {
      managedState: { ok: true, skipped: true, reason },
      managementServices,
      pluginFreshness: { ok: true, skipped: true, reason },
    };
  }
  return {
    managedState: inspectOrphanedManagedState(catalog, currentConfig, options),
    managementServices,
    pluginFreshness: await inspectPluginFreshness(currentConfig, options),
  };
}

function inspectOrphanedManagedState(catalog, currentConfig, options = {}) {
  const orphans = findOrphanedManagedState(catalog, currentConfig, options);
  const ids = [
    ...orphans.rules.map((id) => `router rule ${id}`),
    ...orphans.providers.map((id) => `provider ${id}`),
    ...orphans.profiles.map((id) => `ccr profile ${id}`),
  ];
  if (ids.length === 0) return { ok: true, orphans, count: 0 };
  // A warning, not a failure. Doctor's exit code is the installation contract's
  // blocked/verified gate, and these leftovers belong to a profile that is not
  // the one being diagnosed and that the next launch clears on its own. Failing
  // here would report a fresh install as blocked over somebody else's residue.
  return {
    ok: true,
    warn: true,
    orphans,
    count: ids.length,
    reason: `CCR state owned by no installed profile is still deciding live routes: ${ids.join(", ")}; the next airclaude launch removes it`,
  };
}

const HOST_NOT_RUNNING = "CCR plugin host is not running, so nothing is loaded to be stale";

// The daemon may be supervised by launchd — AirKit's installer registers
// com.airkit.ccr-daemon with KeepAlive. Under a supervisor `ccr stop` is not a
// stop: launchd brings the job back within its ThrottleInterval, and the
// `ccr start` that follows races that restart and wins often enough to leave two
// management services alive at once. So route the lifecycle through the
// supervisor, and only when it owns this exact label — kickstarting a job
// somebody else registered is worse than leaving the plain commands in place.
const CCR_DAEMON_LABEL = "com.airkit.ccr-daemon";

async function ccrSupervisorTarget(runCommand, env) {
  if (typeof process.getuid !== "function") return null;
  const target = `gui/${process.getuid()}/${CCR_DAEMON_LABEL}`;
  const printed = await runCommand("launchctl", ["print", target], { env, timeoutMs: 5000 });
  return printed?.ok ? target : null;
}

const MANAGEMENT_SERVICE_PATTERN = "cli.js serve --daemon-child --no-open$";

async function runLines(runCommand, command, args) {
  const result = await runCommand(command, args, { timeoutMs: 5000 });
  if (!result?.ok) return [];
  return String(result.stdout ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

// One CCR install is meant to have one management service. A second one is not
// idle: both answer the same RPCs and only one holds the port, so a launch can
// read its configuration from one and reach the gateway of the other — which is
// how a freshly written profile appears to have had no effect. The pair comes
// from starting CCR beside a KeepAlive supervisor, so the way out is to restart
// through the supervisor and kill what it does not own, never to start again.
async function inspectManagementServices(options = {}) {
  const runCommand = options.runCommand ?? runCommandSync;
  const pids = await runLines(runCommand, "pgrep", ["-f", MANAGEMENT_SERVICE_PATTERN]);
  if (pids.length <= 1) return { ok: true, pids };

  const supervisor = await ccrSupervisorTarget(runCommand, options.env);
  const supervisedPid = supervisor
    ? (await runLines(runCommand, "launchctl", ["list"]))
      .map((line) => line.split(/\s+/))
      .find((fields) => fields[2] === CCR_DAEMON_LABEL)?.[0] ?? null
    : null;
  const remedy = supervisor
    ? `\`launchctl kickstart -k ${supervisor}\` restarts the supervised one${supervisedPid ? `, so every pid other than ${supervisedPid} is a leftover to kill` : ""}`
    : "stop every one of them and start a single service";
  return {
    ok: true,
    warn: true,
    pids,
    supervisedPid,
    supervisor,
    reason: `${pids.length} CCR management services are running (pids ${pids.join(", ")}); they answer the same RPCs but only one holds the port, so a launch can write configuration to one and route through the other — ${remedy}`,
  };
}

// Attribute the plugin host by parentage: the host is whichever service fathered
// the running gateway core. Several `--no-gateway` daemon children outlive their
// gateway and match the same command line, so picking by uptime or by listening
// port names the wrong process — observed on one machine, two candidates started
// in the same second, only one of them the parent of the core.
//
// runCommand is awaited throughout this file because callers inject async stubs;
// treating its result as synchronous here would read `ok` off a promise and
// silently report every host as unlocatable.
//
// Returns the start time, or the reason there isn't one. "Cannot tell" and "not
// running" have to stay distinguishable: reporting ambiguity as absence is the
// same false clean this check exists to prevent.
async function readPluginHostStart(runCommand) {
  const lines = (command, args) => runLines(runCommand, command, args);
  const startedAt = async (pid) => {
    const [started] = await lines("ps", ["-o", "lstart=", "-p", pid]);
    const at = started ? new Date(started) : null;
    return at && !Number.isNaN(at.getTime())
      ? { at }
      : { at: null, reason: `CCR plugin host ${pid} did not report a start time` };
  };

  const [corePid] = await lines("pgrep", ["-f", "ai-gateway/dist/index.js"]);
  if (corePid) {
    const [hostPid] = await lines("ps", ["-o", "ppid=", "-p", corePid]);
    return hostPid ? await startedAt(hostPid) : { at: null, reason: HOST_NOT_RUNNING };
  }

  // Both `--restart-stale` and a plain `ccr start --no-gateway` leave the
  // management service up with no core to be fathered, and that is exactly when
  // a freshness answer matters most. Fall back to matching the service directly,
  // but only when the match is unique — with no core to disambiguate, choosing
  // between siblings would date the check against the wrong process.
  const candidates = await lines("pgrep", ["-f", MANAGEMENT_SERVICE_PATTERN]);
  if (candidates.length === 1) return await startedAt(candidates[0]);
  if (candidates.length === 0) return { at: null, reason: HOST_NOT_RUNNING };
  return {
    at: null,
    reason: `cannot tell which of ${candidates.length} management services loaded the plugins: no gateway core is running to attribute them by parentage`,
  };
}

// The entry module is not enough: today's failure came from a sibling this file
// imports, not from the entry itself, so a module graph has to be approximated.
// The containing directory tree is that approximation — node_modules excluded,
// since a dependency bump is a reinstall rather than the edit-and-relaunch loop
// this check exists to protect.
async function newestModuleMtime(entryPath) {
  let newest = null;
  const consider = async (path) => {
    const info = await stat(path).catch(() => null);
    if (info?.isFile() && (newest === null || info.mtime > newest)) newest = info.mtime;
    return info;
  };
  const entry = await consider(entryPath);
  if (!entry) return null;

  const walk = (dir, depth) => {
    if (depth > 6) return [];
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    return entries.flatMap((item) => {
      if (item.name.startsWith(".") || item.name === "node_modules") return [];
      const path = join(dir, item.name);
      if (item.isDirectory()) return walk(path, depth + 1);
      return /\.(?:mjs|cjs|js|json)$/.test(item.name) ? [path] : [];
    });
  };
  for (const path of walk(dirname(entryPath), 0)) await consider(path);
  return newest;
}

// A module newer than the host process cannot be the one that is loaded. This is
// the only reliable signal available: `/health` answers `{"status":"ok"}` whether
// or not a plugin loaded, and a broken plugin re-logs its failure on every
// gateway-core restart, which reads like a live error against current code.
async function inspectPluginFreshness(currentConfig = {}, options = {}) {
  const modules = (currentConfig.plugins ?? [])
    .map((plugin) => plugin?.module)
    .filter((module) => typeof module === "string" && module !== "");
  if (modules.length === 0) return { ok: true, skipped: true, reason: "no CCR plugins registered" };

  const runCommand = options.runCommand ?? runCommandSync;
  const host = options.pluginHostStartedAt
    ? { at: options.pluginHostStartedAt }
    : await readPluginHostStart(runCommand);
  if (!host.at) return { ok: true, skipped: true, reason: host.reason };
  const hostStartedAt = host.at;

  const stale = [];
  for (const module of modules) {
    const newest = await newestModuleMtime(module);
    if (newest && newest > hostStartedAt) stale.push(`${module} (changed ${newest.toISOString()})`);
  }
  if (stale.length === 0) return { ok: true, hostStartedAt: hostStartedAt.toISOString(), stale: [] };
  // Resolved here rather than at the top so an unaffected launch never shells
  // out to launchctl, and carried on the result so the restart path below does
  // not have to ask a second time.
  const supervisor = await ccrSupervisorTarget(runCommand, options.env);
  const remedy = supervisor ? `launchctl kickstart -k ${supervisor}` : "ccr stop && ccr start";
  return {
    ok: true,
    warn: true,
    hostStartedAt: hostStartedAt.toISOString(),
    stale,
    supervisor,
    reason: `the CCR plugin host started ${hostStartedAt.toISOString()} and cannot have loaded ${stale.join(", ")}; a gateway restart re-runs the plugin from the same cached module graph, so run \`${remedy}\``,
  };
}

// CCR 3 strips CCR 2 Router.default/background keys on load, so bare Claude
// model names (plain `claude` outside a named profile, including its constant
// claude-haiku background requests) would fail gateway model resolution.
// Translate the profile's base routes into managed condition rules instead.
function buildManagedRouterRules(baseConfig, managedRouteSelector, managedPrefix) {
  const router = baseConfig.Router ?? {};
  if (!router.default) return [];
  // CCR 3 canonicalizes a single-rewrite condition rule to carry BOTH the
  // singular `rewrite` and the `rewrites` array (same as the omitted-`enabled`
  // case). Emit the canonical pair, or every prepare sees getConfig drift,
  // re-saves, and restarts the gateway on each launch.
  const rule = (kind, name, prefix, route) => {
    const rewrite = { key: "request.body.model", operation: "set", value: managedRouteSelector(route) };
    return {
      id: `${managedPrefix}route-${kind}`,
      name,
      type: "condition",
      enabled: true,
      condition: { left: "request.body.model", operator: "starts-with", right: prefix },
      rewrite,
      rewrites: [{ ...rewrite }],
    };
  };
  return [
    rule("background", "AirKit background route", "claude-haiku-", router.background ?? router.default),
    rule("opus", "AirKit Opus route", "claude-opus-", router.opus ?? router.default),
    rule("default", "AirKit default route", "claude-sonnet-", router.sonnet ?? router.default),
  ];
}

function mergeManagedRouter(currentRouter, managedRules, managedPrefix, orphans = {}) {
  const router = structuredClone(currentRouter ?? {});
  const ownedPrefixes = orphans.ownedPrefixes ?? [];
  const preserved = (router.rules ?? []).filter((candidate) => {
    const id = String(candidate?.id ?? "");
    switch (classifyManagedId(id, { managedPrefix, ownedPrefixes, namespace: "airkit-" })) {
      case "mine": return false;
      case "orphan": orphans.pruned?.push(id); return false;
      default: return true;
    }
  });
  return { ...router, rules: [...preserved, ...managedRules] };
}

function bindManagedCompatibilityProvider(ccrConfig, managedProviderIds) {
  const compatibility = configuredCompatibility(ccrConfig);
  if (!compatibility) return;

  validateCompatibilityProviderBinding(compatibility, ccrConfig.Providers);
  const { familyFallbacks } = resolveCompatibilityPolicies(compatibility, {});
  compatibility.fallback.provider = managedProviderIds.get(compatibility.fallback.provider);
  for (const [family, fallback] of Object.entries(familyFallbacks)) {
    compatibility[family].fallback.provider = managedProviderIds.get(fallback.provider);
  }
}

// The compatibility plugin owns POST /v1/messages, so bare Claude model names
// never reach the CCR Router. Hand the plugin the same base routes as managed
// selectors so it can rewrite them before forwarding to the core. A single
// plugin instance serves every mode, so each mode's overlaid routes ship too,
// keyed by the mode label the launcher stamps on its requests; the flat table
// stays as the fallback for unlabelled callers.
function bindManagedCompatibilityRoutes(ccrConfig, managedRouteSelector, modeConfigs = new Map(), launchModel = null) {
  const compatibility = configuredCompatibility(ccrConfig);
  if (!compatibility) return;
  const routeTable = (router) => (router?.default
    ? {
      default: managedRouteSelector(router.default),
      background: managedRouteSelector(router.background ?? router.default),
      ...(router.opus ? { opus: managedRouteSelector(router.opus) } : {}),
      ...(router.sonnet ? { sonnet: managedRouteSelector(router.sonnet) } : {}),
    }
    : null);
  const routes = routeTable(ccrConfig.Router);
  if (!routes) return;
  compatibility.routes = routes;
  // The plugin needs the launcher's own model id to tell the launch route apart
  // from an in-session pick of the same family. `[1m]` is a Claude-Code-local
  // marker that never reaches the wire, so strip it to match what arrives.
  const bareLaunchModel = bareClaudeModelId(launchModel);
  if (bareLaunchModel) compatibility.launchModel = bareLaunchModel;
  const modeRoutes = {};
  for (const [mode, modeConfig] of modeConfigs) {
    // Mode labels are validated against the header contract where the modes
    // are enumerated, before this binding runs.
    const table = routeTable(modeConfig?.Router);
    if (table) modeRoutes[airkitModeLabel(mode)] = table;
  }
  if (Object.keys(modeRoutes).length > 0) compatibility.modeRoutes = modeRoutes;
}

function assertCcr3Compatible(ccrConfig) {
  const hasLegacyTransformers = (ccrConfig.transformers?.length ?? 0) > 0
    || (ccrConfig.Providers ?? []).some((provider) => (provider.transformer?.use?.length ?? 0) > 0);
  if (hasLegacyTransformers) {
    throw new Error("legacy CCR transformers are unsupported by CCR 3; remove them or migrate to a native CCR 3 gateway plugin");
  }
}

function mergeManagedConfigArrays(currentConfig, baseConfig, managedPrefix) {
  const merged = {};
  for (const key of ["plugins", "providerPlugins", "virtualModelProfiles"]) {
    if (!Array.isArray(baseConfig[key])) {
      if (key === "plugins" && Array.isArray(currentConfig.plugins)) {
        merged.plugins = currentConfig.plugins.filter((entry) => entry?.id !== compatibilityPluginId);
      }
      continue;
    }
    const managed = baseConfig[key].map((entry, index) => ({
      ...entry,
      ...(key === "plugins" && entry.enabled === undefined ? { enabled: true } : {}),
      id: entry.id ?? `${managedPrefix}${slug(key)}-${index + 1}`,
    }));
    const ownedIds = new Set(managed.map((entry) => entry.id));
    const ownedPaths = new Set(managed.map((entry) => entry.path).filter(Boolean));
    merged[key] = [
      ...(currentConfig[key] ?? []).filter((entry) =>
        (key !== "plugins" || entry?.id !== compatibilityPluginId)
        && !ownedIds.has(entry.id)
        && !ownedPaths.has(entry.path)),
      ...managed,
    ];
  }
  return merged;
}

export function buildShellSnippet(catalog, profileName, options = {}) {
  const profile = findProfile(catalog, profileName);
  validateShell(profile);
  const shell = profile.shell ?? {};
  const templateVars = profileTemplateVars(profile, options.configDir);
  const lines = [
    `# Generated by airkit for profile: ${profile.name}`,
    `# ${profile.summary}`,
  ];

  if ((shell.exports ?? []).length > 0) {
    lines.push("# Global routing exports (replaces CCR global agent profile)");
    for (const entry of shell.exports) {
      if (entry.value !== undefined) {
        lines.push(`export ${entry.name}=${quoteShell(renderTemplateValue(entry.value, templateVars))}`);
        continue;
      }
      const command = renderTemplateValue(entry.command, templateVars);
      lines.push(
        `if [[ -x ${quoteShell(command)} ]]; then`,
        `  export ${entry.name}="$(${quoteShell(command)})"`,
        "else",
        `  print -u2 ${quoteShell(`airkit: credential helper for ${entry.name} missing (${command}); export skipped`)}`,
        "fi",
      );
    }
  }

  if (shell.plainClaude === true) {
    lines.push(
      "claude() {",
      `  command airclaude --plain --profile ${quoteShell(profile.name)} -- "$@"`,
      "}",
    );
  }

  for (const wrapper of shell.wrappers ?? []) {
    lines.push(`${wrapper.name}() {`);
    const isAirclaudeLauncher = shouldAppendReusableRuntimeLessons(wrapper.command);
    const wrapperEnv = {};
    for (const [key, value] of Object.entries(wrapper.env ?? {})) {
      wrapperEnv[key] = renderTemplateValue(value, templateVars);
      lines.push(`  local -x ${key}=${quoteShell(wrapperEnv[key])}`);
    }
    if (profile.ccr) {
      const mode = wrapperEnv.AIRCLAUDE_MODE ?? profile.launch?.defaultMode ?? "auto";
      const wrapperArgs = (wrapper.args ?? []).map((arg) => quoteShell(renderTemplateValue(arg, templateVars)));
      const renderedArgs = wrapperArgs.length ? ` ${wrapperArgs.join(" ")}` : "";
      lines.push(
        `  command airclaude --profile ${quoteShell(profile.name)} --mode ${quoteShell(mode)} --${renderedArgs} "$@"`,
        "}",
      );
      continue;
    }
    const rawWrapperArgs = withAirclaudeModelArg(
      (wrapper.args ?? []).map((arg) => renderTemplateValue(arg, templateVars)),
      wrapper.command,
      resolveClaudeLaunchModel(profile),
    );
    const effectiveWrapperArgs = isAirclaudeLauncher
      ? appendRuntimePrompts(rawWrapperArgs, [reusableRuntimeLessonsPrompt])
      : rawWrapperArgs;
    const wrapperArgs = effectiveWrapperArgs.map((arg) => quoteShell(arg));
    const renderedArgs = wrapperArgs.length ? ` ${wrapperArgs.join(" ")}` : "";
    lines.push(`  ${wrapper.command}${renderedArgs} "$@"`, "}");
  }

  return `${lines.join("\n")}\n`;
}

export async function exportOssRelease({ outDir }) {
  if (!outDir) throw new Error("exportOssRelease requires outDir");

  const catalog = await loadCatalog();
  const publicCatalog = {
    schema: catalog.schema,
    ...(catalog.modelCatalog ? { modelCatalog: catalog.modelCatalog } : {}),
    profiles: catalog.profiles.filter((profile) => profile.visibility === "public"),
  };

  await mkdir(join(outDir, "src"), { recursive: true });
  await mkdir(join(outDir, "src", "compat"), { recursive: true });
  await mkdir(join(outDir, "profiles"), { recursive: true });
  await mkdir(join(outDir, "scripts"), { recursive: true });
  const binPath = join(outDir, "src", "airkit.mjs");
  await writeFile(binPath, await readFile(fileURLToPath(import.meta.url), "utf8"));
  await chmod(binPath, 0o755);
  await copyFile(join(here, "codex-takeover-guard.mjs"), join(outDir, "src", "codex-takeover-guard.mjs"));
  await copyFile(join(here, "context-heartbeat.mjs"), join(outDir, "src", "context-heartbeat.mjs"));
  await copyFile(join(here, "context-observability.mjs"), join(outDir, "src", "context-observability.mjs"));
  for (const module of [
    "config.mjs",
    "effort.mjs",
    "fallback.mjs",
    "gateway.mjs",
    "middleware.mjs",
    "plugin.mjs",
    "protocol.mjs",
    "server-history.mjs",
    "server-tools.mjs",
    "tool-search.mjs",
  ]) {
    await copyFile(join(here, "compat", module), join(outDir, "src", "compat", module));
  }
  await writeFile(join(outDir, "profiles", "catalog.json"), `${JSON.stringify(publicCatalog, null, 2)}\n`);
  await writeFile(
    join(outDir, "scripts", "verify-ccr3-e2e.mjs"),
    await readFile(join(repoRoot, "scripts", "verify-ccr3-e2e.mjs"), "utf8"),
  );
  await writeFile(
    join(outDir, "scripts", "capture-claude-tool-contract.mjs"),
    await readFile(join(repoRoot, "scripts", "capture-claude-tool-contract.mjs"), "utf8"),
  );
  await writeFile(join(outDir, "package.json"), `${JSON.stringify(publicPackage(), null, 2)}\n`);
  await copyFile(join(repoRoot, "CLAUDE.md"), join(outDir, "CLAUDE.md"));
  await copyFile(join(repoRoot, "README.md"), join(outDir, "README.md"));
}

export function planInstall(catalog, profileName, options = {}) {
  const profile = findProfile(catalog, profileName);
  const configDir = resolve(options.configDir ?? defaultConfigDir());
  const ccrConfig = join(configDir, "ccr", `${profile.name}.json`);
  const shellSnippet = join(configDir, "shell", `${profile.name}.zsh`);
  const managedFiles = renderManagedFiles(profile, { configDir }).map((file) => ({
    label: file.label,
    path: file.path,
  }));

  return {
    profile: { name: profile.name, summary: profile.summary, visibility: profile.visibility },
    configDir,
    write: options.write === true,
    force: options.force === true,
    files: { ccrConfig, shellSnippet, managedFiles },
    nextSteps: [
      `source ${shellSnippet}`,
      "Run airkit runtime check.",
      "Launch the rendered wrapper; AirKit will merge and open its managed CCR 3 profile.",
    ],
  };
}

export async function installProfile(catalog, profileName, options = {}) {
  const plan = planInstall(catalog, profileName, options);
  if (!plan.write) return plan;

  await mkdir(dirname(plan.files.ccrConfig), { recursive: true });
  await mkdir(dirname(plan.files.shellSnippet), { recursive: true });
  const rendered = renderProfile(catalog, profileName, { configDir: plan.configDir, ccrConfigPath: plan.files.ccrConfig });
  await writeTextFile(plan.files.ccrConfig, rendered.ccrConfig, { force: plan.force });
  await writeTextFile(plan.files.shellSnippet, rendered.shellSnippet, { force: plan.force });
  for (const file of rendered.managedFiles) {
    await mkdir(dirname(file.path), { recursive: true });
    await writeTextFile(file.path, file.content, { force: plan.force });
  }
  return plan;
}

export async function updateProfile(catalog, profileName, options = {}) {
  const plan = planInstall(catalog, profileName, options);
  const rendered = renderProfile(catalog, profileName, { configDir: plan.configDir, ccrConfigPath: plan.files.ccrConfig });
  const previewDir = options.previewDir
    ? resolve(options.previewDir)
    : await mkdtemp(join(tmpdir(), `airkit-${profileName}-update-`));
  const preview = {
    ccrConfig: join(previewDir, "ccr", `${plan.profile.name}.json`),
    shellSnippet: join(previewDir, "shell", `${plan.profile.name}.zsh`),
    managedFiles: rendered.managedFiles.map((file) => ({
      ...file,
      preview: join(previewDir, file.relativePath),
    })),
  };

  await mkdir(dirname(preview.ccrConfig), { recursive: true });
  await mkdir(dirname(preview.shellSnippet), { recursive: true });
  await writeFile(preview.ccrConfig, rendered.ccrConfig);
  await writeFile(preview.shellSnippet, rendered.shellSnippet);
  for (const file of preview.managedFiles) {
    await mkdir(dirname(file.preview), { recursive: true });
    await writeFile(file.preview, file.content);
  }

  const files = {
    ccrConfig: await planUpdateFile(plan.files.ccrConfig, preview.ccrConfig, rendered.ccrConfig, "CCR config"),
    shellSnippet: await planUpdateFile(
      plan.files.shellSnippet,
      preview.shellSnippet,
      rendered.shellSnippet,
      "shell snippet",
    ),
    managedFiles: await Promise.all(
      preview.managedFiles.map((file) => planUpdateFile(file.path, file.preview, file.content, file.label)),
    ),
  };

  if (plan.write) {
    await mkdir(dirname(plan.files.ccrConfig), { recursive: true });
    await mkdir(dirname(plan.files.shellSnippet), { recursive: true });
    await writeFile(plan.files.ccrConfig, rendered.ccrConfig);
    await writeFile(plan.files.shellSnippet, rendered.shellSnippet);
    for (const file of rendered.managedFiles) {
      await mkdir(dirname(file.path), { recursive: true });
      await writeFile(file.path, file.content);
    }
  }

  return { profile: plan.profile, write: plan.write, previewDir, files };
}

// CCR_LOG lets a single launch flip CCR request logging without editing the committed
// profile: CCR_LOG=1/true/on/yes -> true, 0/false/off/no -> false, unset/blank/unknown ->
// undefined (caller falls back to the profile's ccr.LOG). e.g. `CCR_LOG=1 airclaude`.
function resolveCcrLogOverride(env = process.env) {
  const raw = env?.CCR_LOG;
  if (raw === undefined) return undefined;
  const value = String(raw).trim().toLowerCase();
  if (["1", "true", "on", "yes"].includes(value)) return true;
  if (["0", "false", "off", "no"].includes(value)) return false;
  return undefined;
}

// Claude Code resolves a model from several channels, and a stale value in any
// of them silently outranks the launch model. Launching Claude directly means
// the user's own shell environment reaches it, so the inherited copies are
// dropped rather than trusted. ANTHROPIC_AUTH_TOKEN is absent on purpose: it is
// set from the gateway key at spawn, and clearing it here would defeat that.
const LAUNCH_CLEARED_ENV = Object.freeze([
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "CCR_CLAUDE_CODE_MODEL",
  "CODEXL_CLAUDE_CODE_MODEL",
  "AIRCLAUDE_COMPLETION_GUARD_MAX_STOP_BLOCKS",
  // Cloud-provider selectors reroute Claude Code away from ANTHROPIC_BASE_URL
  // entirely; one inherited from the shell would bypass the CCR gateway.
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD",
]);

// Upstream provider credentials arrive as $NAME environment placeholders. CCR
// receives their resolved values through the managed save, so the launched
// Claude has no use for them — and everything left in its environment is
// inherited by every Bash tool it runs. Clear each placeholder by name.
function providerCredentialEnvNames(profile) {
  const names = new Set();
  for (const provider of profile.ccr?.Providers ?? []) {
    const match = String(provider.api_key ?? "").match(/^\$([A-Za-z_][A-Za-z0-9_]*)$/);
    if (match) names.add(match[1]);
  }
  return [...names].sort();
}

// A live CCR config may hold its address as an environment reference, so
// resolve it the same way the compatibility MCP endpoint does.
function resolveLaunchGatewayEndpoint(ccrConfig, env) {
  return resolveCcrGatewayEndpoint({
    gateway: {
      host: expandEnvironmentReference(ccrConfig.gateway?.host ?? ccrConfig.HOST, env, "CCR gateway host"),
      port: expandEnvironmentReference(ccrConfig.gateway?.port ?? ccrConfig.PORT, env, "CCR gateway port"),
    },
  });
}

function gatewayBaseUrlEnv(endpoint) {
  const url = endpoint.toString().replace(/\/+$/, "");
  return {
    ANTHROPIC_API_BASE_URL: url,
    ANTHROPIC_BASE_URL: url,
    CLAUDE_AGENT_API_BASE_URL: url,
  };
}

// The mode header must not erase headers the caller already sends: keep every
// inherited ANTHROPIC_CUSTOM_HEADERS line except a stale x-airkit-mode from an
// outer airclaude session, then append this launch's own label.
function mergedCustomHeaders(inheritedValue, mode) {
  const kept = String(inheritedValue ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.toLowerCase().startsWith(`${AIRKIT_MODE_HEADER}:`));
  return [...kept, `${AIRKIT_MODE_HEADER}: ${airkitModeLabel(mode)}`].join("\n");
}

// CCR owns the gateway address, and a profile normally leaves it unset. Resolve
// it statically when the profile does pin one, otherwise the live config
// supplies it at spawn.
function profileGatewayEndpoint(ccrConfig) {
  try {
    return resolveCcrGatewayEndpoint(ccrConfig);
  } catch {
    return null;
  }
}

export function buildLaunchPlan(catalog, profileName, options = {}) {
  const profile = findProfile(catalog, profileName);
  const configDir = resolve(options.configDir ?? defaultConfigDir());
  const templateVars = profileTemplateVars(profile, configDir);
  const launch = resolveLaunchConfig(profile, templateVars);
  const mode = resolveLaunchMode(profile, launch, options.mode);
  const ccrConfig = applyLaunchModeOverlay(buildCcrConfig(catalog, profileName, { configDir }), profile, mode, templateVars);
  assertCcr3Compatible(ccrConfig);
  const compatibility = resolveConfiguredCompatibility(ccrConfig);
  const logOverride = resolveCcrLogOverride(options.env ?? process.env);
  if (logOverride !== undefined) ccrConfig.LOG = logOverride;
  const claudeModel = resolveClaudeLaunchModel(profile);
  const launchVars = launchTemplateVars(profile, configDir, mode, ccrConfig, claudeModel);
  const basePlan = planInstall(catalog, profileName, { configDir, write: true, force: true });
  const managedProfileId = `airkit-${slug(profile.name)}-${slug(mode)}`;
  const gatewayEndpoint = profileGatewayEndpoint(ccrConfig);
  const renderedLaunchArgs = (launch.args ?? []).map((arg) => renderTemplateValue(arg, launchVars));
  const plainClaude = options.plainClaude === true;
  // Passthrough arguments reach the same Claude argv as profile args, so both
  // go through the managed launch-argument rejections.
  const combinedLaunchArgs = [...renderedLaunchArgs, ...(options.userArgs ?? [])];
  assertNoManagedApiKeyHelperOverride(combinedLaunchArgs);
  assertNoDefaultSystemPromptOverride(combinedLaunchArgs);
  const renderedLaunchEnv = renderTemplateValue(launch.env ?? {}, launchVars);
  for (const key of ["CLAUDE_CONFIG_DIR", "HOME"]) {
    if (Object.hasOwn(renderedLaunchEnv, key)) {
      // Direct launch exists so every launcher shares one Claude home; a
      // profile that redirects it would split sessions by mode again.
      throw new Error(`launch.env must not set ${key}; the launched Claude inherits the caller's home`);
    }
  }
  const claudeArgs = plainClaude
    ? []
    : withHeartbeatPluginArg(
      appendLaunchRuntimePrompts(
        withAirclaudeModelArg(
          renderedLaunchArgs,
          launch.binary,
          claudeModel,
        ),
        launch.binary,
        mode,
        ccrConfig,
        claudeModel,
        modeAppendSystemPrompt(launch, mode),
      ),
      launch.binary,
      configDir,
    );

  return {
    profile: basePlan.profile,
    mode,
    configDir,
    files: basePlan.files,
    ccrConfig,
    ...(compatibility ? { compatibility } : {}),
    liveCcrConfig: { path: join(defaultCcrStateDir(options.env), "config.sqlite") },
    credential: {
      ccrTokenOpRef: profile.shell?.ccrTokenOpRef ?? null,
    },
    launch: {
      // Spawn Claude Code directly. Routing it through `ccr <profile> cli`
      // handed the child a per-mode CLAUDE_CONFIG_DIR, which split sessions,
      // statusline, and hooks across four homes; CCR stays the gateway daemon
      // and the shared ~/.claude is inherited untouched.
      command: launch.binary,
      args: claudeArgs,
      env: {
        ...airclaudeLaunchEnv(catalog, profile, mode, ccrConfig, options.env),
        ...renderedLaunchEnv,
        ...(plainClaude ? {} : contextLaunchEnv(profile)),
        ...(gatewayEndpoint ? gatewayBaseUrlEnv(gatewayEndpoint) : {}),
        ANTHROPIC_CUSTOM_HEADERS: mergedCustomHeaders((options.env ?? process.env).ANTHROPIC_CUSTOM_HEADERS, mode),
        // The old `ccr <profile> cli` path injected this from the managed
        // profile env; the direct spawn must carry it itself or gateway
        // models vanish from /model.
        CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1",
      },
      // When the profile pins a gateway address the spawn keeps it; otherwise
      // the live CCR config supplies the base URLs at spawn time.
      gatewayPinned: Boolean(gatewayEndpoint),
      // Provider credential placeholders join the cleared list: the child gets
      // the gateway key instead, and its Bash tools must not inherit upstream
      // secrets. ANTHROPIC_AUTH_TOKEN may appear here AND be set at spawn —
      // the inherited value is dropped, the gateway key replaces it.
      clearEnv: [...new Set([...LAUNCH_CLEARED_ENV, ...providerCredentialEnvNames(profile)])],
      // CCR mints one gateway key per managed profile and writes this helper
      // when the profile is saved. Run it at spawn so the token enters the
      // child's environment — never argv, a plan, or a dry run. Environment
      // means inheritance: the session's own Bash tools see it too, which is
      // the accepted tradeoff for a key that only opens the local gateway.
      gatewayTokenCommand: join(ccrRuntimePaths(options.env).configDir, "bin", `ccr-claude-code-api-key-${managedProfileId}`),
      managedProfileId,
      userArgs: options.userArgs ?? [],
    },
  };
}

export function assertNoManagedApiKeyHelperOverride(args) {
  for (let index = 0; index < args.length; index += 1) {
    const arg = String(args[index]);
    const value = arg === "--settings"
      ? args[index + 1]
      : arg.startsWith("--settings=")
        ? arg.slice("--settings=".length)
        : undefined;
    if (typeof value !== "string" || !value.trim().startsWith("{")) continue;
    let settings;
    try {
      settings = JSON.parse(value);
    } catch {
      continue;
    }
    if (settings && typeof settings === "object" && !Array.isArray(settings)
      && Object.hasOwn(settings, "apiKeyHelper")) {
      // An apiKeyHelper outranks the gateway token this launch puts in the
      // environment, so a profile that ships one would silently authenticate
      // the session as somebody else.
      throw new Error("Claude launch args must not set apiKeyHelper; it overrides the AirKit gateway token");
    }
  }
}

export function assertNoDefaultSystemPromptOverride(args) {
  for (const raw of args) {
    const arg = String(raw);
    if (arg === "--system-prompt" || arg.startsWith("--system-prompt=")
      || arg === "--system-prompt-file" || arg.startsWith("--system-prompt-file=")) {
      throw new Error("Claude launch args must not replace Claude Code's default system prompt");
    }
  }
}

// The shared Claude home is inherited on purpose, so a user-level apiKeyHelper
// there outranks the gateway token this launch injects. Refuse to launch
// rather than authenticate the session as somebody else; the file is only
// read, never edited.
async function assertNoInheritedApiKeyHelper(env) {
  const home = env.CLAUDE_CONFIG_DIR ?? join(env.HOME ?? homedir(), ".claude");
  const settingsPath = join(home, "settings.json");
  let raw;
  try {
    raw = await readFile(settingsPath, "utf8");
  } catch {
    return;
  }
  let settings;
  try {
    settings = JSON.parse(raw);
  } catch {
    return;
  }
  if (settings && typeof settings === "object" && !Array.isArray(settings)
    && Object.hasOwn(settings, "apiKeyHelper")) {
    throw new Error(
      `${settingsPath} sets apiKeyHelper, which overrides the AirKit gateway token; remove it before launching`,
    );
  }
}

async function resolveGatewayToken(plan, options = {}) {
  const runCommand = options.runCommand ?? runCommandSync;
  const command = plan.launch.gatewayTokenCommand;
  const result = await runCommand(command, [], {
    env: options.env,
    timeoutMs: options.commandTimeoutMs ?? 30000,
  });
  const token = String(result?.stdout ?? "").trim();
  // The failure text must stay free of the command's output: on a partial
  // write or a truncated helper the stdout that failed the check is itself
  // credential material.
  if (!result?.ok || token === "") {
    throw new Error(
      `unable to resolve the CCR gateway key for profile ${plan.launch.managedProfileId} from ${command}; restart the CCR gateway daemon so it re-applies its managed profiles, then retry`,
    );
  }
  return token;
}

export async function prepareLaunch(catalog, profileName, options = {}) {
  const plan = buildLaunchPlan(catalog, profileName, options);
  const rendered = renderProfile(catalog, profileName, {
    configDir: plan.configDir,
    ccrConfigPath: plan.files.ccrConfig,
  });
  const files = await planLaunchFiles(plan, rendered);

  if (options.dryRun || options.doctor) {
    return {
      ...plan,
      write: false,
      files,
      liveCcrConfig: { ...plan.liveCcrConfig, status: "would-manage" },
      // A dry run stays free of any RPC so it keeps proving the launch contract
      // offline; --doctor is the diagnostic mode, so it reads live state.
      ...(options.doctor
        ? await inspectLiveCcrState(catalog, { ...options, configDir: plan.configDir })
        : {}),
      runtime: await checkLaunchRuntime(plan, options),
    };
  }

  const launchEnv = options.env ?? process.env;
  const createCcrClient = options.createCcrClient ?? createCcr3Client;
  const ccrClient = options.ccrClient ?? createCcrClient({ ...options, autoStart: true });
  let currentConfig = await readCcrConfigSafely(ccrClient);
  assertNoCodexTakeover(inspectCodexTakeover({ ccrConfig: currentConfig }));
  assertNoCodexTakeover((await inspectCodexTakeoverFiles(launchEnv)).inspection);
  const runtime = await checkLaunchRuntime(plan, { ...options, ccrClient });
  if (!runtime.ccr.ok) throw new Error(runtime.ccr.reason);
  if (!runtime.launch.ok) throw new Error(runtime.launch.reason);
  currentConfig = await readCcrConfigSafely(ccrClient);
  assertNoCodexTakeover(inspectCodexTakeover({ ccrConfig: currentConfig }));
  const verifiedPreflight = await inspectCodexTakeoverFiles(launchEnv);
  assertNoCodexTakeover(verifiedPreflight.inspection);
  await writeLaunchFiles(plan, rendered);
  const apiKeys = await resolveProviderApiKeys(catalog, profileName, plan, options);
  const managed = buildCcr3ManagedConfig(catalog, profileName, currentConfig, {
    apiKeys,
    configDir: plan.configDir,
    env: launchEnv,
  });
  if (!isDeepStrictEqual(managed.config, currentConfig)) {
    reportPrunedManagedState(managed.pruned, options.stderr ?? process.stderr);
    await ccrClient.saveConfig(managed.config, { applyProfile: false });
  }
  let child = null;
  let childStatus;
  if (options.launch !== false) {
    // Announced here, not in the CLI: a launch prints its own report only after
    // the child exits, and this must reach the user before the session starts.
    // Sequenced after saveConfig so a restart brings up a service holding both
    // the new plugin code and the config just written.
    await announcePluginFreshness(currentConfig, options);
    await ccrClient.ensureGateway();
    await assertNoInheritedApiKeyHelper(launchEnv);
    let gatewayToken;
    try {
      gatewayToken = await resolveGatewayToken(plan, options);
    } catch {
      // CCR mints the per-profile key helper only while applying profiles, and
      // the managed save above deliberately passes applyProfile:false. A fresh
      // CCR home therefore reaches its first launch with no helper: apply once
      // — the Codex takeover guards above have already vetted this config —
      // and retry.
      await ccrClient.applyProfile();
      gatewayToken = await resolveGatewayToken(plan, options);
    }
    const gatewayOrigin = resolveLaunchGatewayEndpoint(
      plan.launch.gatewayPinned ? plan.ccrConfig : managed.config,
      launchEnv,
    )
      .toString()
      .replace(/\/+$/, "");
    const middleware = options.plainClaude === true || !managed.compatibility
      ? null
      : await (options.startCompatibilityMiddleware ?? startCompatibilityMiddleware)({
        compatibility: managed.compatibility,
        gatewayOrigin,
        gatewayToken,
      });
    const compatibilityLaunch = middleware
      ? buildCompatibilityLaunch(managed.compatibility, middleware.origin, gatewayToken)
      : { args: [], env: {} };
    const spawnCommand = options.spawnCommand ?? spawnCommandAsync;
    const inherited = { ...(options.env ?? process.env) };
    for (const key of plan.launch.clearEnv ?? []) delete inherited[key];
    try {
      child = spawnCommand(plan.launch.command, [
        ...plan.launch.args,
        ...compatibilityLaunch.args,
        ...plan.launch.userArgs,
      ], {
        env: {
          ...inherited,
          ...plan.launch.env,
          ...compatibilityLaunch.env,
          ...(middleware
            ? gatewayBaseUrlEnv(middleware.origin)
            : plan.launch.gatewayPinned
              ? {}
              : gatewayBaseUrlEnv(gatewayOrigin)),
          ANTHROPIC_AUTH_TOKEN: gatewayToken,
        },
        stdio: "inherit",
      });
    } catch (error) {
      await middleware?.close();
      throw error;
    }
    childStatus = await monitorChildLifecycle(middleware, child);
  }

  return {
    ...plan,
    write: true,
    files: await planLaunchFiles(plan, rendered),
    liveCcrConfig: { ...plan.liveCcrConfig, status: "managed" },
    runtime,
    child,
    ...(childStatus === undefined ? {} : { childStatus }),
  };
}

export async function doctorProfile(catalog, profileName, options = {}) {
  const profile = findProfile(catalog, profileName);
  const plan = planInstall(catalog, profileName, options);
  const expected = renderProfile(catalog, profileName, { configDir: plan.configDir, ccrConfigPath: plan.files.ccrConfig });
  const files = {
    ccrConfig: await checkRenderedFile(plan.files.ccrConfig, expected.ccrConfig, "CCR config"),
    shellSnippet: await checkRenderedFile(plan.files.shellSnippet, expected.shellSnippet, "shell snippet"),
    managedFiles: await Promise.all(
      expected.managedFiles.map((file) => checkRenderedFile(file.path, file.content, file.label)),
    ),
  };
  const ccrConfig = profile.ccr ? buildCcrConfig(catalog, profileName, { configDir: plan.configDir }) : null;
  const live = await inspectLiveCcrState(catalog, { ...options, configDir: plan.configDir });
  const runtime = {
    ccr: await checkCcrAvailability(profile, options.commandExists ?? commandExistsOnPath),
    compatibility: compatibilityCapabilityStatus(profile.ccr),
    context: {
      ok: true,
      ...buildContextObservability({
        autoCompactWindow: profile.launch?.context?.autoCompactWindow,
        modelCatalog: catalog.modelCatalog,
        modelInfo: options.modelInfo,
        route: ccrConfig?.Router?.default,
        usage: options.completionUsage,
      }),
    },
    managedState: live.managedState,
    managementServices: live.managementServices,
    pluginFreshness: live.pluginFreshness,
    shellSource: files.shellSnippet.ok
      ? await checkShellSourceability(plan.files.shellSnippet, profile, options.sourceShellSnippet ?? sourceShellSnippet)
      : { ok: true, skipped: true, path: plan.files.shellSnippet },
  };
  const failures = [files.ccrConfig, files.shellSnippet, ...files.managedFiles, ...Object.values(runtime)]
    .filter((file) => !file.ok)
    .map((file) => file.reason);

  return { ok: failures.length === 0, profile: plan.profile, files, runtime, failures };
}

function findProfile(catalog, profileName) {
  const profile = catalog.profiles.find((candidate) => candidate.name === profileName);
  if (!profile) {
    throw new Error(`unknown profile "${profileName}"`);
  }
  return profile;
}

function validateCatalog(catalog) {
  if (catalog.schema !== 1) throw new Error("catalog schema must be 1");
  if (!Array.isArray(catalog.profiles)) throw new Error("catalog profiles must be an array");

  const seen = new Set();
  for (const profile of catalog.profiles) {
    if (!profile.name || seen.has(profile.name)) throw new Error(`invalid or duplicate profile: ${profile.name}`);
    seen.add(profile.name);
    if (!["internal", "public"].includes(profile.visibility)) {
      throw new Error(`profile "${profile.name}" has invalid visibility`);
    }
    if (profile.ccr) validateCcr(profile.name, profile.ccr);
    validateLaunch(profile);
    validateShell(profile);
    validateManagedFiles(profile);
  }
}

function validateLaunch(profile) {
  const context = profile.launch?.context;
  if (context !== undefined) {
    if (!isPlainObject(context)) {
      throw new Error(`profile "${profile.name}" launch.context must be an object`);
    }

    const supportedFields = new Set(["autoCompactPercentage", "autoCompactWindow", "maxOutputTokens"]);
    for (const field of Object.keys(context)) {
      if (!supportedFields.has(field)) {
        throw new Error(`profile "${profile.name}" launch.context contains unsupported field: ${field}`);
      }
    }

    // Claude Code derives max output from the launch model id, and falls back to
    // 32000 for any id it does not recognize — including the dedicated launch id
    // a profile needs so an in-session model pick is distinguishable. Setting this
    // restores the value the routed model can actually produce.
    const maxOutput = context.maxOutputTokens;
    if (maxOutput !== undefined && (!Number.isInteger(maxOutput) || maxOutput < 1024 || maxOutput > 512000)) {
      throw new Error(`profile "${profile.name}" launch.context.maxOutputTokens must be an integer from 1024 to 512000`);
    }

    const window = context.autoCompactWindow;
    if (window !== undefined && (!Number.isInteger(window) || window < 100000 || window > 1000000)) {
      throw new Error(`profile "${profile.name}" launch.context.autoCompactWindow must be an integer from 100000 to 1000000`);
    }

    const percentage = context.autoCompactPercentage;
    if (percentage !== undefined && percentage !== "default"
      && (!Number.isInteger(percentage) || percentage < 1 || percentage > 100)) {
      throw new Error(`profile "${profile.name}" launch.context.autoCompactPercentage must be "default" or an integer from 1 to 100`);
    }
  }

  for (const [mode, definition] of Object.entries(profile.launch?.modes ?? {})) {
    const prompt = definition?.appendSystemPrompt;
    if (prompt !== undefined && (typeof prompt !== "string" || prompt.trim() === "")) {
      throw new Error(`profile "${profile.name}" launch.modes.${mode}.appendSystemPrompt must be a non-empty string`);
    }
    const completionGuard = definition?.completionGuard;
    if (completionGuard !== undefined) {
      if (!isPlainObject(completionGuard) || Object.keys(completionGuard).some((key) => key !== "maxStopBlocks")) {
        throw new Error(`profile "${profile.name}" launch.modes.${mode}.completionGuard must contain only maxStopBlocks`);
      }
      if (!Number.isInteger(completionGuard.maxStopBlocks) || completionGuard.maxStopBlocks < 1 || completionGuard.maxStopBlocks > 3) {
        throw new Error(`profile "${profile.name}" launch.modes.${mode}.completionGuard.maxStopBlocks must be an integer from 1 to 3`);
      }
    }
  }
}

function validateShell(profile) {
  const plainClaude = profile.shell?.plainClaude;
  if (plainClaude !== undefined && typeof plainClaude !== "boolean") {
    throw new Error(`profile "${profile.name}" shell.plainClaude must be a boolean`);
  }
  if (plainClaude === true && (!profile.ccr || !profile.launch)) {
    throw new Error(`profile "${profile.name}" shell.plainClaude requires CCR and launch`);
  }
  if (plainClaude === true && !hasUsableCcrLaunchContract(profile)) {
    throw new Error(`profile "${profile.name}" shell.plainClaude requires a usable CCR launch contract`);
  }
  if (plainClaude === true && (profile.shell?.wrappers ?? []).some((wrapper) => wrapper?.name === "claude")) {
    throw new Error(`profile "${profile.name}" shell.plainClaude cannot be combined with shell.wrappers named "claude"`);
  }

  const providerTokenOpRefs = profile.shell?.providerTokenOpRefs;
  if (providerTokenOpRefs !== undefined) {
    if (!isPlainObject(providerTokenOpRefs)) {
      throw new Error(`profile "${profile.name}" shell.providerTokenOpRefs must be an object`);
    }
    const providers = new Map((profile.ccr?.Providers ?? []).map((provider) => [provider.name, provider]));
    for (const [providerName, ref] of Object.entries(providerTokenOpRefs)) {
      const provider = providers.get(providerName);
      if (!provider) {
        throw new Error(`profile "${profile.name}" providerTokenOpRefs references unknown provider: ${providerName}`);
      }
      if (typeof ref !== "string" || !ref.startsWith("op://")) {
        throw new Error(`profile "${profile.name}" providerTokenOpRefs.${providerName} must be an op:// reference`);
      }
      if (!/^\$[A-Z_][A-Z0-9_]*$/.test(String(provider.api_key ?? ""))) {
        throw new Error(`profile "${profile.name}" providerTokenOpRefs.${providerName} requires an environment-placeholder api_key`);
      }
    }
  }

  const exports = profile.shell?.exports;
  if (exports === undefined) return;
  if (!Array.isArray(exports)) {
    throw new Error(`profile "${profile.name}" shell.exports must be an array`);
  }

  for (const entry of exports) {
    if (!isPlainObject(entry)) {
      throw new Error(`profile "${profile.name}" shell export must be an object`);
    }
    if (typeof entry.name !== "string" || !/^[A-Z][A-Z0-9_]*$/.test(entry.name)) {
      throw new Error(`profile "${profile.name}" shell export has an invalid name: ${JSON.stringify(entry.name)}`);
    }
    if ((entry.value === undefined) === (entry.command === undefined)) {
      throw new Error(`profile "${profile.name}" shell export "${entry.name}" must set exactly one of value or command`);
    }
    if (entry.value !== undefined && typeof entry.value !== "string") {
      throw new Error(`profile "${profile.name}" shell export "${entry.name}" value must be a string`);
    }
    if (entry.command !== undefined && typeof entry.command !== "string") {
      throw new Error(`profile "${profile.name}" shell export "${entry.name}" command must be a string`);
    }
  }
}

function hasUsableCcrLaunchContract(profile) {
  const { ccr, launch } = profile;
  if (!isPlainObject(launch) || typeof launch.binary !== "string" || launch.binary.trim() === "") return false;
  if (!isPlainObject(ccr) || !Array.isArray(ccr.Providers) || ccr.Providers.length === 0 || !isPlainObject(ccr.Router)) {
    return false;
  }

  const defaultRoute = ccr.Router.default;
  if (typeof defaultRoute !== "string") return false;
  const { model, provider } = splitRoute(defaultRoute);
  if (!provider || !model) return false;

  return ccr.Providers.some((candidate) => isPlainObject(candidate)
    && candidate.name === provider
    && Array.isArray(candidate.models)
    && candidate.models.includes(model));
}

function validateCcr(profileName, ccr) {
  for (const provider of ccr.Providers ?? []) {
    if (typeof provider.api_key === "string" && provider.api_key.startsWith("sk-")) {
      throw new Error(`profile "${profileName}" embeds a secret-looking API key`);
    }
  }
  validateConfiguredCompatibility(ccr);
}

function configuredCompatibility(ccrConfig) {
  return ccrConfig?.plugins?.find((plugin) => plugin?.id === compatibilityPluginId)?.config ?? null;
}

function validateConfiguredCompatibility(ccrConfig) {
  const config = configuredCompatibility(ccrConfig);
  if (config) {
    validateCompatibilityConfig(config);
    validateCompatibilityProviderBinding(config, ccrConfig.Providers);
  }
  return config;
}

function resolveConfiguredCompatibility(ccrConfig) {
  const config = configuredCompatibility(ccrConfig);
  return config ? resolveCompatibilityPolicies(config, VERIFIED_NATIVE_COMPATIBILITY) : null;
}

function buildCompatibilityLaunch(config, adapterOrigin, gatewayToken) {
  // Claude settings can apply their env values after the launcher's process
  // environment. Keep this per-launch overlay deliberately narrow so an old
  // CCR profile cannot bypass the loopback adapter, while preserving the
  // user's apiKeyHelper, MCP servers, plugins, and every other setting.
  const args = ["--settings", JSON.stringify({ env: gatewayBaseUrlEnv(adapterOrigin) })];
  if (config?.webSearch?.mode !== "mcp") return { args, env: {} };
  const mcpConfig = {
    mcpServers: {
      [compatibilityPluginId]: {
        headers: { "x-api-key": "${AIRKIT_COMPATIBILITY_MCP_TOKEN}" },
        type: "http",
        url: "${AIRKIT_COMPATIBILITY_MCP_URL}",
      },
    },
  };
  return {
    args: [...args, "--mcp-config", JSON.stringify(mcpConfig)],
    env: {
      AIRKIT_COMPATIBILITY_MCP_TOKEN: gatewayToken,
      AIRKIT_COMPATIBILITY_MCP_URL: new URL("/airkit/compatibility/mcp", adapterOrigin).toString(),
    },
  };
}

function compatibilityCapabilityStatus(ccrConfig) {
  const config = configuredCompatibility(ccrConfig);
  if (!config) return { capabilities: {}, notes: [], ok: true, skipped: true };
  const { policies, advisorUnsupported } = resolveCompatibilityPolicies(
    config,
    VERIFIED_NATIVE_COMPATIBILITY,
  );
  const stripped = advisorUnsupported === "strip";
  return {
    notes: stripped
      ? [
        "advisor tool definitions are removed from requests, so a request that "
        + "carries one stays on its normal route instead of diverting to the "
        + "fallback route. Advisor itself does not work through this gateway: "
        + "the tool definition carries its own model, which the gateway resolves "
        + "in a separate call it has no api_base or credentials for. Set "
        + 'advisor.unsupported to "passthrough" and re-test after the gateway '
        + "changes.",
      ]
      : [],
    capabilities: {
      advisor: stripped ? "stripped" : policyStatus(policies.advisor),
      codeExecution: policyStatus(policies.codeExecution),
      mcpConnector: policyStatus(policies.mcpConnector),
      toolSearch: policyStatus(policies.toolSearch),
      webFetch: policyStatus(policies.webFetch),
      webSearch: config.webSearch.mode === "mcp" ? "unverified" : policyStatus(policies.webSearch),
    },
    ok: true,
  };
}

function policyStatus(policy) {
  return policy === "bridge" ? "bridged" : policy;
}

function expandEnvironmentReference(value, env, fieldName) {
  if (typeof value !== "string") return value;
  const match = value.match(/^\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))$/);
  if (!match) return value;
  const name = match[1] ?? match[2];
  if (env?.[name] === undefined || env[name] === "") {
    throw new Error(`${fieldName} references missing environment variable ${name}`);
  }
  return env[name];
}

function validateManagedFiles(profile) {
  for (const file of profile.managedFiles ?? []) {
    if (!file.path || typeof file.content !== "string") {
      throw new Error(`profile "${profile.name}" has an invalid managed file`);
    }
    if (file.path.startsWith("/") || file.path.split("/").includes("..")) {
      throw new Error(`profile "${profile.name}" managed file must stay inside the config dir: ${file.path}`);
    }
  }
}

function quoteShell(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function airkitEnvVar(prefix, profileName) {
  return `${prefix}_${profileName.toUpperCase().replaceAll(/[^A-Z0-9]+/g, "_")}`;
}

function publicPackage() {
  return {
    name: "@untionglim/ai-runtime-kit",
    version: "0.2.0",
    publishConfig: { access: "public" },
    repository: {
      type: "git",
      url: "git+https://github.com/LZong-tw/ai-runtime-kit.git",
    },
    description: "Public-safe runtime profile templates for AI client wrappers.",
    type: "module",
    exports: "./src/airkit.mjs",
    bin: { airkit: "src/airkit.mjs", airclaude: "src/airkit.mjs" },
    files: [
      "CLAUDE.md",
      "README.md",
      "docs/install.md",
      "docs/profile-schema.md",
      "docs/runtime-lessons.md",
      "profiles",
      "scripts/capture-claude-tool-contract.mjs",
      "scripts/verify-ccr3-e2e.mjs",
      "src",
    ],
    scripts: {
      check: "node --check src/airkit.mjs",
      "pack:check": "npm pack --dry-run",
      test: "node --test",
      "verify:ccr3:e2e": "node scripts/verify-ccr3-e2e.mjs",
      "verify:tool-contract": "node scripts/capture-claude-tool-contract.mjs",
      verify: "npm test && npm run check && npm run pack:check",
    },
    engines: { node: RUNTIME_REQUIREMENTS.node },
    license: "MIT",
    author: "LZong, Lim, Un-tiong <lzong.tw@gmail.com>",
  };
}

export async function runCli(argv = process.argv.slice(2), options = {}) {
  const stdout = options.stdout ?? process.stdout;
  const [command, subcommand, ...rest] = argv;

  if (isHelpRequest(argv)) {
    stdout.write(renderAirkitHelp());
    return 0;
  }

  if (command === "airclaude") {
    return runAirclaudeCli([subcommand, ...rest].filter((arg) => arg !== undefined), options);
  }

  if (command === "runtime" && subcommand === "check") {
    const report = runtimeReport(options.runtimeVersions ?? await inspectRuntimeVersions(options));
    stdout.write(renderRuntimeReport(report));
    return report.every((entry) => entry.ok) ? 0 : 1;
  }

  if (command === "runtime" && subcommand === "update") {
    const result = await updateRuntime({ ...options, write: hasFlag(rest, "--write") });
    stdout.write(renderRuntimeUpdate(result));
    return 0;
  }

  if (command === "repair" && subcommand === "codex-takeover") {
    const write = hasFlag(rest, "--write");
    const createCcrClient = options.createCcrClient ?? createCcr3Client;
    const ccrClient = createCcrClient({ ...options, autoStart: write });
    const repair = options.repairCodexTakeover ?? repairCodexTakeover;
    const repairOptions = {
      ccrClient,
      env: options.env ?? process.env,
      write,
      ...codexSafetyPaths(options.env ?? process.env),
      ...(options.codexTakeoverIo ? { io: options.codexTakeoverIo } : {}),
      ...(options.codexTakeoverNonce ? { nonce: options.codexTakeoverNonce } : {}),
      ...(options.codexTakeoverNow ? { now: options.codexTakeoverNow } : {}),
    };
    let result;
    try {
      result = await repair(repairOptions);
    } catch (error) {
      if (write) throw error;
      throw new Error(
        "Codex takeover repair preview failed; preview never starts CCR. Run airkit repair codex-takeover --write to back up and repair safely",
      );
    }
    stdout.write(renderCodexTakeoverRepair(result));
    return 0;
  }

  const catalog = command === "export-oss" ? null : await loadCatalog(options.catalogPath ?? defaultCatalogPath);

  if (command === "init") {
    const profile = requireFlag([subcommand, ...rest], "--profile");
    const plan = await installProfile(catalog, profile, {
      configDir: readFlag(rest, "--config-dir") ?? defaultConfigDir(),
      force: hasFlag(rest, "--force"),
      write: hasFlag(rest, "--write"),
    });
    stdout.write(renderInstallPlan(plan));
    return 0;
  }

  if (command === "list") {
    const visibility = readFlag(rest, "--visibility") ?? "all";
    for (const profile of catalog.profiles) {
      if (visibility !== "all" && profile.visibility !== visibility) continue;
      stdout.write(`${profile.name}\t${profile.visibility}\t${profile.summary}\n`);
    }
    return 0;
  }

  if (command === "render" && subcommand === "ccr") {
    const profile = requireFlag(rest, "--profile");
    await emitJson(buildCcrConfig(catalog, profile), readFlag(rest, "--out"), stdout);
    return 0;
  }

  if (command === "render" && subcommand === "shell") {
    const profile = requireFlag(rest, "--profile");
    await emitText(buildShellSnippet(catalog, profile), readFlag(rest, "--out"), stdout);
    return 0;
  }

  if (command === "doctor") {
    const args = subcommand ? [subcommand, ...rest] : rest;
    const profile = readFlag(args, "--profile");
    if (!profile) {
      stdout.write(`profiles: ${catalog.profiles.length}\n`);
      stdout.write("catalog: ok\n");
      return 0;
    }

    const result = await doctorProfile(catalog, profile, {
      configDir: readFlag(args, "--config-dir") ?? defaultConfigDir(),
    });
    stdout.write(renderDoctorResult(result));
    return result.ok ? 0 : 1;
  }

  if (command === "update") {
    const args = subcommand ? [subcommand, ...rest] : rest;
    const profile = requireFlag(args, "--profile");
    const result = await updateProfile(catalog, profile, {
      configDir: readFlag(args, "--config-dir") ?? defaultConfigDir(),
      previewDir: readFlag(args, "--preview-dir"),
      write: hasFlag(args, "--write"),
    });
    stdout.write(renderUpdateResult(result));
    return 0;
  }

  if (command === "export-oss") {
    await exportOssRelease({ outDir: requireFlag([subcommand, ...rest], "--out") });
    return 0;
  }

  throw new Error(`unknown command: ${argv.join(" ") || "(none)"}`);
}

export async function runAirclaudeCli(argv = process.argv.slice(2), options = {}) {
  const stdout = options.stdout ?? process.stdout;

  if (isHelpRequest(argv)) {
    stdout.write(renderAirclaudeHelp());
    return 0;
  }

  const catalog = await loadCatalog(options.catalogPath ?? defaultCatalogPath);
  // Bare-positional modes are driven by the resolved profile's launch.modes (plus the
  // always-available auto/pro), so a profile that defines a custom mode can invoke it as
  // `airclaude <mode>` the same way `airclaude pro` works. Resolve the profile first
  // (--profile/env/default) so we know which mode names are valid before parsing positionals.
  const ownArgvForProfile = argv.indexOf("--") === -1 ? argv : argv.slice(0, argv.indexOf("--"));
  const preProfileName =
    readFlag(ownArgvForProfile, "--profile") ?? process.env.AIRCLAUDE_PROFILE ?? defaultLaunchProfile(catalog);
  const preProfile = catalog.profiles.find((candidate) => candidate.name === preProfileName);
  const validModes = new Set(["auto", "pro", ...Object.keys(preProfile?.launch?.modes ?? {})]);
  const parsed = parseAirclaudeArgs(argv, validModes);
  const profile = parsed.profile ?? process.env.AIRCLAUDE_PROFILE ?? defaultLaunchProfile(catalog);
  const result = await prepareLaunch(catalog, profile, {
    ...options,
    configDir: parsed.configDir ?? options.configDir ?? defaultConfigDir(),
    doctor: parsed.doctor,
    restartStale: parsed.restartStale,
    stdout,
    dryRun: parsed.dryRun || parsed.doctor,
    launch: !parsed.dryRun && !parsed.doctor,
    mode: parsed.plainClaude ? "plain" : parsed.mode,
    plainClaude: parsed.plainClaude,
    userArgs: parsed.userArgs,
  });
  stdout.write(renderLaunchResult(result, { doctor: parsed.doctor, dryRun: parsed.dryRun }));
  return result.childStatus ?? result.child?.status ?? 0;
}

function isHelpRequest(argv) {
  const [first] = argv;
  return first === "-h" || first === "--help" || first === "help";
}

async function emitJson(value, outPath, stdout = process.stdout) {
  await emitText(`${JSON.stringify(value, null, 2)}\n`, outPath, stdout);
}

async function emitText(value, outPath, stdout = process.stdout) {
  if (outPath) {
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, value);
  } else {
    stdout.write(value);
  }
}

// Reporting is the default and restarting is opt-in, because reloading plugin
// code means stopping the management service, which drops every session on the
// machine — not a side effect a launch may choose on the user's behalf.
//
// This takes the config the launch already fetched rather than reading its own.
// A second getConfig here would land before the Codex takeover guards, and the
// order of those RPCs is a safety contract with its own test.
async function announcePluginFreshness(currentConfig, options = {}) {
  const stdout = options.stdout ?? process.stdout;
  const pluginFreshness = await inspectPluginFreshness(currentConfig, options);
  if (!pluginFreshness.warn) return pluginFreshness;

  stdout.write(`warn CCR plugin freshness: ${pluginFreshness.reason}\n`);
  if (!options.restartStale) {
    stdout.write("     pass --restart-stale to reload it now (this stops every CCR-backed session)\n");
    return pluginFreshness;
  }

  const runCommand = options.runCommand ?? runCommandSync;
  const timeoutMs = options.commandTimeoutMs ?? 30000;
  // A supervised daemon gets restarted in place. Stopping it here would hand the
  // replacement to launchd and then race it with a start of our own, which is
  // how two management services end up holding one port between them.
  if (pluginFreshness.supervisor) {
    stdout.write(`     --restart-stale: running \`launchctl kickstart -k ${pluginFreshness.supervisor}\`\n`);
    const kicked = await runCommand("launchctl", ["kickstart", "-k", pluginFreshness.supervisor], { timeoutMs });
    if (!kicked?.ok) {
      stdout.write(`     launchctl kickstart failed: ${kicked?.stderr || `exit ${kicked?.status}`}\n`);
      return pluginFreshness;
    }
    stdout.write("     plugin host restarted\n");
    return pluginFreshness;
  }

  stdout.write("     --restart-stale: running `ccr stop` then `ccr start --no-gateway`\n");
  for (const args of [["stop"], ["start", "--no-gateway"]]) {
    const result = await runCommand("ccr", args, { timeoutMs });
    if (!result?.ok) {
      // Report and continue to the launch: a failed reload leaves the previous
      // service running, which is worse to hide than to name.
      stdout.write(`     ccr ${args.join(" ")} failed: ${result.stderr || `exit ${result.status}`}\n`);
      return pluginFreshness;
    }
  }
  // Two zero exit codes mean the commands ran, not that a plugin loaded. The
  // failure this feature exists for is a plugin that starts and disables itself
  // behind a `/health` that still answers ok, so claiming the modules are loaded
  // would be the same lie in a new place.
  stdout.write("     plugin host restarted\n");
  return pluginFreshness;
}

function parseAirclaudeArgs(argv, validModes = new Set(["auto", "pro"])) {
  const parsed = { userArgs: [] };
  let positionalMode;
  const passthroughIndex = argv.indexOf("--");
  const ownArgs = passthroughIndex === -1 ? argv : argv.slice(0, passthroughIndex);
  parsed.userArgs.push(...(passthroughIndex === -1 ? [] : argv.slice(passthroughIndex + 1)));

  for (let index = 0; index < ownArgs.length; index += 1) {
    const arg = ownArgs[index];
    if (arg === "--profile") {
      parsed.profile = ownArgs[++index];
    } else if (arg === "--config-dir") {
      parsed.configDir = ownArgs[++index];
    } else if (arg === "--mode") {
      parsed.mode = ownArgs[++index];
    } else if (arg === "--plain") {
      parsed.plainClaude = true;
    } else if (arg === "--dry-run") {
      parsed.dryRun = true;
    } else if (arg === "--doctor") {
      parsed.doctor = true;
    } else if (arg === "--restart-stale") {
      parsed.restartStale = true;
    } else if (["--repair-restore", "--restore-projects-dir", "--restore-backups-dir"].includes(arg)) {
      throw new Error(`${arg} was removed; AirKit no longer reads or rewrites Claude Code session model state`);
    } else if (validModes.has(arg) && !parsed.mode) {
      positionalMode = arg;
      parsed.mode = arg;
    } else {
      parsed.userArgs.push(arg);
    }
  }

  if (parsed.plainClaude && positionalMode && positionalMode !== "plain") {
    throw new Error(`--plain cannot be combined with positional mode "${positionalMode}"`);
  }

  return parsed;
}

function defaultLaunchProfile(catalog) {
  const profile = catalog.profiles.find((candidate) => candidate.launch || candidate.ccr);
  if (!profile) throw new Error("catalog does not define a launchable profile");
  return profile.name;
}

function readFlag(args, name) {
  const index = args.indexOf(name);
  return index === -1 ? null : args[index + 1];
}

function requireFlag(args, name) {
  const value = readFlag(args, name);
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

function hasFlag(args, name) {
  return args.includes(name);
}

function defaultConfigDir() {
  return process.env.AIRKIT_CONFIG_DIR ?? join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "ai-runtime-kit");
}

function defaultCcrStateDir(env = process.env) {
  return ccrRuntimePaths(env).configDir;
}

function ccrRuntimePaths(env = process.env) {
  const home = resolve(env?.CCR_INTERNAL_HOME_DIR ?? env?.HOME ?? homedir());
  const appData = resolve(env?.CCR_INTERNAL_APP_DATA_DIR ?? env?.XDG_CONFIG_HOME ?? join(home, ".config"));
  const configDir = process.platform === "win32" ? join(appData, "claude-code-router") : join(home, ".claude-code-router");
  const userDataDir = resolve(
    env?.CCR_INTERNAL_USER_DATA_DIR ?? (process.platform === "win32" ? configDir : join(configDir, "app-data")),
  );
  return { appDataDir: join(appData, "Claude Code Router"), configDir, home, userDataDir };
}

async function inspectCodexTakeoverFiles(env) {
  const codexHome = env?.CODEX_HOME ?? (env?.HOME ? join(env.HOME, ".codex") : join(homedir(), ".codex"));
  const { takeoverPath } = codexSafetyPaths(env);
  const takeoverText = await readOptionalText(takeoverPath);
  if (takeoverText !== undefined) {
    try {
      const takeover = JSON.parse(takeoverText);
      if (!takeover
        || typeof takeover !== "object"
        || Array.isArray(takeover)
        || takeover.version !== 1
        || !Array.isArray(takeover.profiles)) {
        throw new Error("invalid takeover shape");
      }
    } catch {
      throw new Error(
        "Codex takeover state could not be verified; run airkit repair codex-takeover --write",
      );
    }
  }
  const recorded = inspectCodexTakeover({ takeoverText });
  const expandPath = (path) => path.startsWith("~/") && env?.HOME ? join(env.HOME, path.slice(2)) : path;
  const canonicalPath = (path) => {
    try {
      return realpathSync(path);
    } catch (error) {
      if (error?.code === "ENOENT") return path;
      throw error;
    }
  };
  const codexConfigPaths = [...new Map([
    join(codexHome, "config.toml"),
    ...recorded.affectedPaths.map(expandPath),
  ].map(canonicalPath).map((path) => {
    const normalized = path.replaceAll("\\", "/");
    const key = process.platform === "win32" || /^[a-zA-Z]:\//.test(normalized)
      ? normalized.toLowerCase()
      : normalized;
    return [key, path];
  })).values()];
  const codexConfigText = (await Promise.all(codexConfigPaths.map(readOptionalText)))
    .filter((text) => text !== undefined)
    .join("\n");
  return {
    codexConfigPaths,
    inspection: inspectCodexTakeover({ codexConfigText, takeoverText }),
    takeoverPath,
  };
}

async function readOptionalText(path) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

function assertNoCodexTakeover(inspection) {
  if (!inspection.hazardous) return;
  throw new Error(
    "Codex takeover detected; preview with airkit repair codex-takeover, then apply with airkit repair codex-takeover --write",
  );
}

async function readCcrConfigSafely(ccrClient) {
  try {
    return await ccrClient.getConfig();
  } catch {
    throw new Error(
      "Unable to inspect CCR configuration safely. Run airkit repair codex-takeover --write to back up and repair safely",
    );
  }
}

function renderAirkitHelp() {
  return `Usage: airkit <command> [options]

Commands:
  runtime check
  runtime update [--write]
  repair codex-takeover [--write]
  list [--visibility all|public|internal]
  init --profile <name> [--write] [--force] [--config-dir <dir>]
  update --profile <name> [--write] [--config-dir <dir>] [--preview-dir <dir>]
  doctor [--profile <name>] [--config-dir <dir>]
  render ccr --profile <name> [--out <path>]
  render shell --profile <name> [--out <path>]
  airclaude [mode] [options] [-- <claude-args>]
  export-oss --out <dir>

Options:
  -h, --help    Show this help.

Examples:
  airkit list
  airkit init --profile openai-compatible-example
  airkit doctor --profile openai-compatible-example
  airkit airclaude pro --dry-run
`;
}

function renderRuntimeReport(report) {
  return `${report.map((entry) => `${entry.label} ${entry.version ?? "missing"} required ${entry.requirement} ${entry.ok ? "ok" : "fail"}`).join("\n")}\n`;
}

function renderRuntimeUpdate(result) {
  const packages = result.packages.map((packageName) => `- ${packageName}`).join("\n");
  const paths = result.statePaths.map((path) => `- ${path}`).join("\n");
  if (!result.write) return `Preview only\nCommand: npm install --global ${result.packages.join(" ")}\nCCR state to back up:\n${paths}\nPackages:\n${packages}\nRe-run with --write to update global packages.\n`;
  return `Updated runtime packages\n${packages}\nBackup: ${result.backupDir}\n${renderRuntimeReport(result.report)}`;
}

function renderCodexTakeoverRepair(result) {
  const affectedPaths = [...new Set([
    ...(result.codexConfigPaths ?? [result.codexConfigPath]),
    ...result.inspection.affectedPaths,
  ].filter(Boolean))];
  const pathLines = affectedPaths.length > 0 ? affectedPaths.map((path) => `- ${path}`).join("\n") : "- none";
  const actionLines = result.inspection.actions.length > 0
    ? result.inspection.actions.map((action) => `- ${action}`).join("\n")
    : "- none";
  if (!result.write) {
    return `Preview Codex takeover repair\nAffected paths:\n${pathLines}\nActions:\n${actionLines}\nNo changes written.\nRe-run with airkit repair codex-takeover --write to apply.\n`;
  }
  const backups = (result.backupPaths ?? [result.backupPath]).filter(Boolean).map((path) => `- ${path}`).join("\n") || "- none";
  const restored = (result.restoredPaths ?? [result.restoredPath]).filter(Boolean).map((path) => `- ${path}`).join("\n") || "- none";
  return `Repaired Codex takeover\nBackups:\n${backups}\nRestored:\n${restored}\nAffected paths:\n${pathLines}\nActions:\n${actionLines}\n`;
}

function renderAirclaudeHelp() {
  return `Usage: airclaude [mode] [options] [-- <claude-args>]

Modes:
  mode          Select any profile-defined routing mode (for example auto, pro, or glm).

Options:
  --profile <name>       Select a launch-capable profile.
  --config-dir <dir>     Use a custom ai-runtime-kit config directory.
  --mode <mode>          Select a profile-defined mode without positional syntax.
  --dry-run              Render and report the launch plan without writing or launching.
  --doctor               Run launch preflight checks without launching.
  --restart-stale        If the CCR plugin host predates its plugin modules,
                         reload it before launching. This stops every
                         CCR-backed session on the machine. Without the flag a
                         stale host is reported and left alone.
  -h, --help             Show this help.

Examples:
  airclaude
  airclaude pro
  airclaude --doctor
  airclaude --restart-stale
  airclaude -- --dangerously-skip-permissions
`;
}

function renderInstallPlan(plan) {
  const action = plan.write ? "Wrote" : "Dry run";
  const fileLines = [
    `- CCR config: ${plan.files.ccrConfig}`,
    `- Shell snippet: ${plan.files.shellSnippet}`,
    ...plan.files.managedFiles.map((file) => `- ${file.label}: ${file.path}`),
  ];

  return `${action} airkit profile: ${plan.profile.name}

Files:
${fileLines.join("\n")}

Next steps:
${plan.nextSteps.map((step) => `- ${step}`).join("\n")}

${plan.write ? "" : "Re-run with --write to create these files.\n"}`;
}

function renderUpdateResult(result) {
  const action = result.write ? "Wrote" : "Dry run";
  const targetLines = [
    `- ${result.files.ccrConfig.status} CCR config: ${result.files.ccrConfig.target}`,
    `- ${result.files.shellSnippet.status} shell snippet: ${result.files.shellSnippet.target}`,
    ...result.files.managedFiles.map((file) => `- ${file.status} ${file.label}: ${file.target}`),
  ];
  const previewLines = [
    `- CCR config: ${result.files.ccrConfig.preview}`,
    `- Shell snippet: ${result.files.shellSnippet.preview}`,
    ...result.files.managedFiles.map((file) => `- ${file.label}: ${file.preview}`),
  ];
  const diffLines = [
    `- CCR config: ${result.files.ccrConfig.diff}`,
    `- Shell snippet: ${result.files.shellSnippet.diff}`,
    ...result.files.managedFiles.map((file) => `- ${file.label}: ${file.diff}`),
  ];

  return `${action} update airkit profile: ${result.profile.name}

Targets:
${targetLines.join("\n")}

Preview files:
${previewLines.join("\n")}

Diff summary:
${diffLines.join("\n")}

${result.write ? "" : "Re-run with --write to overwrite stale or missing target files.\n"}`;
}

function renderLaunchResult(result, options = {}) {
  const action = options.doctor ? "Doctor" : options.dryRun || !result.write ? "Dry run" : "Launched";
  const fileLines = [
    `- ${result.files.ccrConfig.status} CCR config: ${result.files.ccrConfig.target}`,
    `- ${result.files.shellSnippet.status} shell snippet: ${result.files.shellSnippet.target}`,
    ...result.files.managedFiles.map((file) => `- ${file.status} ${file.label}: ${file.target}`),
  ];
  const runtimeLines = result.runtime
    ? [
        `- ${result.runtime.ccr.ok ? "ok" : "fail"} CCR: ${result.runtime.ccr.command}`,
        `- ${result.runtime.launch.ok ? "ok" : "fail"} launch command: ${result.runtime.launch.command}`,
      ]
    : [];

  // `opus` and `sonnet` only appear when the profile sets them, so a profile
  // that routes every Claude family to `default` reads exactly as before. They
  // are what an in-session `/model` pick reaches, which is worth proving in the
  // same output that proves the mode.
  const optionalRouteLines = ["opus", "sonnet"]
    .filter((key) => result.ccrConfig.Router?.[key])
    .map((key) => `- ${key}: ${result.ccrConfig.Router[key]}`);

  return `${action} airclaude profile: ${result.profile.name}
mode: ${result.mode}

Routes:
- default: ${result.ccrConfig.Router?.default ?? "unset"}
- background: ${result.ccrConfig.Router?.background ?? "unset"}
${optionalRouteLines.length ? `${optionalRouteLines.join("\n")}\n` : ""}
Files:
${fileLines.join("\n")}
- ${result.liveCcrConfig.status} CCR state database: ${result.liveCcrConfig.path}
${[
  ...(result.managedState ? renderManagedStateLines(result.managedState) : []),
  ...(result.managementServices ? renderManagementServiceLines(result.managementServices) : []),
  ...(result.pluginFreshness ? renderPluginFreshnessLines(result.pluginFreshness) : []),
]
  .map((line) => (line.startsWith("  ") ? line : `- ${line}`))
  .join("\n")}
Runtime:
${runtimeLines.join("\n") || "- skipped"}
Launch:
- ${result.launch.command} ${[...result.launch.args, ...result.launch.userArgs].map(quoteShell).join(" ")}

Environment:
- gateway: ${result.launch.env.ANTHROPIC_BASE_URL ?? "resolved from live CCR config at launch"}
- mode header: ${result.launch.env.ANTHROPIC_CUSTOM_HEADERS ?? "unset"}
- gateway key: resolved at launch from ${result.launch.gatewayTokenCommand}
- inherited Claude home: CLAUDE_CONFIG_DIR is left untouched
${contextEnvLines(result.launch.env)}- cleared: ${(result.launch.clearEnv ?? []).join(", ") || "none"}
`;
}

// `launch.context` overrides are invisible in the launch argv but change how the
// child behaves, so a dry run that omits them under-reports the plan.
function contextEnvLines(env = {}) {
  return ["CLAUDE_CODE_MAX_OUTPUT_TOKENS", "CLAUDE_CODE_AUTO_COMPACT_WINDOW", "CLAUDE_CODE_AUTO_COMPACT_PERCENTAGE"]
    .filter((name) => env[name] !== undefined)
    .map((name) => `- ${name}: ${env[name]}\n`)
    .join("");
}

function renderProfile(catalog, profileName, options = {}) {
  const profile = findProfile(catalog, profileName);
  const configDir = resolve(options.configDir ?? defaultConfigDir());

  return {
    ccrConfig: `${JSON.stringify(buildCcrConfig(catalog, profileName, { configDir }), null, 2)}\n`,
    shellSnippet: buildShellSnippet(catalog, profileName, options),
    managedFiles: renderManagedFiles(profile, { configDir }),
  };
}

function resolveLaunchConfig(profile, templateVars) {
  if (profile.launch) return withReusableRuntimeLessons(profile.launch);
  const wrapper = profile.shell?.wrappers?.[0];
  if (wrapper) {
    return withReusableRuntimeLessons({
      binary: wrapper.command,
      args: wrapper.args ?? [],
      env: wrapper.env ?? {},
      defaultMode: "auto",
      modes: { auto: {} },
    });
  }
  throw new Error(`profile "${profile.name}" must define launch or a shell wrapper for CCR 3`);
}

function withReusableRuntimeLessons(launch) {
  const next = structuredClone(launch);
  if (!shouldAppendReusableRuntimeLessons(next.binary)) return next;
  next.args = mergeAppendSystemPrompt(next.args ?? [], reusableRuntimeLessonsPrompt);
  return next;
}

function shouldAppendReusableRuntimeLessons(binary) {
  const commandName = basename(String(binary ?? "").trim().split(/\s+/)[0] || "");
  return commandName === "claude";
}

function mergeAppendSystemPrompt(args, prompt) {
  const next = [...args];
  const index = next.findIndex((arg) => arg === "--append-system-prompt");
  if (index >= 0 && typeof next[index + 1] === "string") {
    next[index + 1] = `${next[index + 1]} ${prompt}`;
  } else {
    next.push("--append-system-prompt", prompt);
  }
  return next;
}

function appendLaunchRuntimePrompts(args, binary, mode, ccrConfig, claudeModel, modePrompt = null) {
  if (!shouldAppendReusableRuntimeLessons(binary)) return args;
  return appendRuntimePrompts(args, [airclaudeRoutingPrompt(mode, ccrConfig, claudeModel), modePrompt]);
}

function modeAppendSystemPrompt(launch, mode) {
  const prompt = launch.modes?.[mode]?.appendSystemPrompt;
  return typeof prompt === "string" && prompt.trim() !== "" ? prompt : null;
}

function withHeartbeatPluginArg(args, binary, configDir) {
  if (!shouldAppendReusableRuntimeLessons(binary)) return args;
  return [...args, "--plugin-dir", join(configDir, "plugins", "airkit-context")];
}

// AirClaude launchers pass their Claude-compatible display model as `--model` for
// this managed launch only. AirKit never persists it to Claude settings or session
// transcripts, so Claude Code remains the owner of the user's saved model choice.
// Appended (not prepended) so existing arg order is preserved; a user `--model` passed
// after these base args (e.g. `airclaude -- --model …`) still wins.
function withAirclaudeModelArg(args, binary, claudeModel) {
  if (!shouldAppendReusableRuntimeLessons(binary) || !claudeModel) return args;
  if (args.includes("--model")) return args;
  return [...args, "--model", claudeModel];
}

function appendRuntimePrompts(args, prompts) {
  return prompts
    .filter((prompt) => typeof prompt === "string" && prompt.length > 0)
    .reduce((next, prompt) => mergeAppendSystemPrompt(next, prompt), args);
}

function resolveLaunchMode(profile, launch, requestedMode) {
  const mode = requestedMode ?? launch.defaultMode ?? "auto";
  const modes = launch.modes ?? { auto: {} };
  if (!Object.hasOwn(modes, mode)) {
    throw new Error(`profile "${profile.name}" does not define launch mode "${mode}"`);
  }
  return mode;
}

function applyLaunchModeOverlay(ccrConfig, profile, mode, templateVars) {
  const overlay = profile.launch?.modes?.[mode]?.ccr;
  if (!overlay) return ccrConfig;
  return mergeDeep(ccrConfig, renderTemplateValue(overlay, templateVars));
}

function launchTemplateVars(profile, configDir, mode, ccrConfig, claudeModel) {
  const vars = {
    ...profileTemplateVars(profile, configDir),
    launchMode: mode,
    claudeModel: claudeModel ?? "",
    statuslineLabel: statuslineLabel(mode, ccrConfig),
  };

  for (const [key, route] of Object.entries(ccrConfig.Router ?? {})) {
    if (typeof route !== "string") continue;
    const routeKey = `route${toPascalCase(key)}`;
    const { provider, model } = splitRoute(route);
    vars[routeKey] = route;
    vars[`${routeKey}Provider`] = provider;
    vars[`${routeKey}Model`] = model;
  }

  return vars;
}

function airclaudeLaunchEnv(catalog, profile, mode, ccrConfig, runtimeEnv = process.env) {
  const home = runtimeEnv.CCR_INTERNAL_HOME_DIR ?? runtimeEnv.HOME ?? homedir();
  const env = {
    AIRCLAUDE_PROFILE: profile.name,
    AIRCLAUDE_MODE: mode,
    AIRCLAUDE_STATUSLINE_LABEL: statuslineLabel(mode, ccrConfig),
    CLAUDE_STATUSLINE_CACHE_DIR: join(home, ".claude", "cache", "airclaude", profile.name, mode),
    // NOTE: there is no env var that enables Claude Code's 1M context window. (ANTHROPIC_1M_CONTEXT
    // is a no-op — it does not appear in the 2.1.178 binary.) 1M is gated purely on the resolved
    // model string ending in the literal suffix `[1m]` (Jf = /\[1m\]/i, checked first in the window
    // resolver), with CLAUDE_CODE_DISABLE_1M_CONTEXT as the only opt-out. So 1M is achieved by giving
    // the launch model a `[1m]` suffix (launch.claudeModel: claude-sonnet-5[1m]); the API
    // id is normalized back to claude-sonnet-5 on the wire, so the suffix is a Claude-Code-local
    // marker and the gateway never sees it. See resolveClaudeLaunchModel.
    // Claude Code sources the user's zsh snapshot in its non-interactive command shells. A
    // Powerlevel10k instant prompt there re-evals its git/dir segments and spams
    // "(eval): command not found: git/head/awk/dirname/basename". Quiet it for the launched
    // process only; the user's interactive P10k prompt and .zshrc are untouched.
    POWERLEVEL9K_INSTANT_PROMPT: "off",
  };
  const statuslineInputPrice = routeInputPrice(catalog, profile, ccrConfig.Router?.default);
  if (statuslineInputPrice !== null) {
    env.AIRCLAUDE_STATUSLINE_INPUT_PRICE_PER_MILLION = String(statuslineInputPrice);
  }
  const maxStopBlocks = profile.launch?.modes?.[mode]?.completionGuard?.maxStopBlocks;
  if (maxStopBlocks !== undefined) {
    env.AIRCLAUDE_COMPLETION_GUARD_MAX_STOP_BLOCKS = String(maxStopBlocks);
  }

  for (const [key, route] of managedRouterEntries(ccrConfig.Router)) {
    const envKey = `AIRCLAUDE_ROUTE_${toEnvKey(key)}`;
    const { provider, model } = splitRoute(route);
    env[envKey] = route;
    env[`${envKey}_PROVIDER`] = provider;
    env[`${envKey}_MODEL`] = model;
  }

  return env;
}

function contextLaunchEnv(profile) {
  const context = profile.launch?.context;
  if (!context) return {};

  const env = {};
  if (context.autoCompactWindow !== undefined) {
    env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = String(context.autoCompactWindow);
  }
  if (context.autoCompactPercentage === "default") {
    env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE = "";
  } else if (context.autoCompactPercentage !== undefined) {
    env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE = String(context.autoCompactPercentage);
  }
  if (context.maxOutputTokens !== undefined) {
    env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = String(context.maxOutputTokens);
  }
  return env;
}

function routeInputPrice(catalog, profile, route) {
  if (typeof route !== "string") return null;
  const { provider, model } = splitRoute(route);
  return profileInputPrice(profile, provider, model) ?? catalogInputPrice(catalog, provider, model);
}

function profileInputPrice(profile, provider, model) {
  const pricing = profile.statusline?.modelPricingUsdPer1M ?? profile.statusline?.pricingUsdPer1M;
  if (!pricing || typeof pricing !== "object") return null;

  return inputPriceFromValue(pricing[`${provider},${model}`] ?? pricing[model] ?? pricing[`${provider}/${model}`]);
}

function catalogInputPrice(catalog, provider, model) {
  const providers = catalog.modelCatalog?.providers;
  if (!Array.isArray(providers)) return null;

  for (const providerEntry of providers) {
    for (const modelEntry of providerEntry.models ?? []) {
      if (!modelMatches(provider, model, providerEntry, modelEntry)) continue;
      const price = inputPriceFromValue(modelEntry.pricingUsdPer1M);
      if (price !== null) return price;
    }
  }

  return null;
}

function modelMatches(provider, model, providerEntry, modelEntry) {
  const candidates = new Set([
    modelEntry.id,
    modelEntry.litellm,
    ...(Array.isArray(modelEntry.aliases) ? modelEntry.aliases : []),
  ].filter(Boolean));

  if (provider) {
    candidates.add(`${provider}/${model}`);
    candidates.add(`${provider},${model}`);
  }
  if (providerEntry.id) candidates.add(`${providerEntry.id}/${model}`);
  if (providerEntry.litellmProvider) candidates.add(`${providerEntry.litellmProvider}/${model}`);

  return candidates.has(model);
}

function inputPriceFromValue(value) {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  if (!value || typeof value !== "object") return null;

  const input = Number(value.input ?? value.inputCacheMiss);
  return Number.isFinite(input) && input > 0 ? input : null;
}

function airclaudeRoutingPrompt(mode, ccrConfig, claudeModel) {
  if (!ccrConfig?.Router || typeof ccrConfig.Router !== "object") return "";

  const routeLines = sortedRouterEntries(ccrConfig.Router).map(([key, route]) => {
    const { model } = splitRoute(route);
    return `- ${key}: ${route} (model ${model})`;
  });

  return [
    "AirClaude active routing:",
    `- mode: ${mode}`,
    "- AirClaude mode is routing mode, not Claude Code permission mode.",
    ...routeLines,
    claudeModel
      ? `- Claude launch/display model is the launcher's own id, not a served model: ${claudeModel}`
      : "- Claude launch/display model is the launcher's own id, not a served model.",
    "- Do not infer the active provider route from Claude Code's displayed model name; the launch id maps to the default route above.",
    ...(ccrConfig.Router.opus || ccrConfig.Router.sonnet
      ? ["- Picking a Claude model in session does change the route: it follows the opus/sonnet route listed above, not the default."]
      : []),
    "- background/tool-heavy work may use the background route when the runtime/router selects it.",
    "- When compacting, restoring, summarizing, or reporting status, preserve AirClaude mode and provider routes separately from Claude-compatible display metadata.",
    "- Every manual or automatic compact summary ends with the following seven-field, single-line-value capsule. Never include credentials or provider-private payloads in the capsule.\n[AIRKIT_TASK_CAPSULE]\nobjective: current objective\nconstraints: accepted constraints\ndecisions: accepted decisions\nchanged_files: changed files\nverification: verification state\nrepository_state: repository and worktree state\nnext_action: next concrete action\n[/AIRKIT_TASK_CAPSULE]",
  ].join(" ");
}

// The routing prompt lists every active route, including the `opus`/`sonnet`
// destinations an in-session model pick reaches. `managedRouterEntries` stays
// narrower on purpose: it names the launch environment variables, and profiles
// template against `default`/`background` only.
function sortedRouterEntries(router = {}) {
  return ["default", "background", "opus", "sonnet"]
    .filter((key) => typeof router[key] === "string")
    .map((key) => [key, router[key]]);
}

function managedRouterEntries(router = {}) {
  return ["default", "background"]
    .filter((key) => typeof router[key] === "string")
    .map((key) => [key, router[key]]);
}

function statuslineLabel(mode, ccrConfig) {
  const route = ccrConfig.Router?.default;
  if (typeof route !== "string") return `airclaude ${mode}`;
  return `airclaude ${mode} ${splitRoute(route).model}`;
}

function splitRoute(route) {
  const index = route.indexOf(",");
  if (index === -1) return { provider: "", model: route };
  return {
    provider: route.slice(0, index),
    model: route.slice(index + 1),
  };
}

function routeSelector(route) {
  const { provider, model } = splitRoute(String(route ?? ""));
  return provider ? `${provider}/${model}` : model;
}

function slug(value) {
  return String(value)
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-+|-+$/g, "");
}

function toPascalCase(value) {
  return String(value)
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .replace(/^[a-z]/, (match) => match.toUpperCase())
    .replace(/[A-Z]/g, (match) => ` ${match}`)
    .trim()
    .split(/\s+/)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join("");
}

function toEnvKey(value) {
  return String(value)
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();
}

function resolveClaudeLaunchModel(profile) {
  return profile.launch?.claudeModel ?? null;
}

// Claude Code strips `[1m]` before it builds the request, so the gateway only
// ever sees the bare id. Match what arrives, not what was typed.
function bareClaudeModelId(model) {
  if (typeof model !== "string") return null;
  const bare = model.replace(/\[1m\]$/i, "").trim();
  return /^claude-[a-z0-9][a-z0-9._-]*$/i.test(bare) ? bare : null;
}

function timestampForPath() {
  return new Date().toISOString().replaceAll(/[:.]/g, "-");
}

function mergeDeep(base, overlay) {
  if (Array.isArray(base) || Array.isArray(overlay) || !isPlainObject(base) || !isPlainObject(overlay)) {
    return structuredClone(overlay);
  }
  const merged = structuredClone(base);
  for (const [key, value] of Object.entries(overlay)) {
    merged[key] = key in merged ? mergeDeep(merged[key], value) : structuredClone(value);
  }
  return merged;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function planLaunchFiles(plan, rendered) {
  return {
    ccrConfig: await checkLaunchFile(plan.files.ccrConfig, rendered.ccrConfig, "CCR config"),
    shellSnippet: await checkLaunchFile(plan.files.shellSnippet, rendered.shellSnippet, "shell snippet"),
    managedFiles: await Promise.all(
      rendered.managedFiles.map((file) => checkLaunchFile(file.path, file.content, file.label)),
    ),
  };
}

async function checkLaunchFile(path, expected, label) {
  let actual;
  try {
    actual = await readFile(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { status: "missing", label, target: path };
    }
    throw error;
  }
  return { status: actual === expected ? "current" : "stale", label, target: path };
}

async function writeLaunchFiles(plan, rendered) {
  await mkdir(dirname(plan.files.ccrConfig), { recursive: true });
  await mkdir(dirname(plan.files.shellSnippet), { recursive: true });
  await writeFile(plan.files.ccrConfig, rendered.ccrConfig);
  await writeFile(plan.files.shellSnippet, rendered.shellSnippet);
  for (const file of rendered.managedFiles) {
    await mkdir(dirname(file.path), { recursive: true });
    await writeFile(file.path, file.content);
  }
}

async function inspectRuntimeVersions(options = {}) {
  const runCommand = options.runCommand ?? runCommandSync;
  const claude = await runCommand("claude", ["--version"], { timeoutMs: options.commandTimeoutMs });
  const packages = await runCommand(
    "npm",
    ["list", "--global", "--json", "--depth=0", "@anthropic-ai/claude-code", "@musistudio/claude-code-router"],
    { timeoutMs: options.commandTimeoutMs },
  );
  let dependencies = {};
  try {
    dependencies = JSON.parse(packages.stdout || "{}").dependencies ?? {};
  } catch {
    dependencies = {};
  }
  return {
    node: process.versions.node,
    claudeCode: dependencies["@anthropic-ai/claude-code"]?.version ?? extractVersion(claude.stdout),
    claudeCodeRouter: dependencies["@musistudio/claude-code-router"]?.version ?? null,
  };
}

function runtimeReport(versions) {
  return [
    { key: "node", label: "Node.js", requirement: RUNTIME_REQUIREMENTS.node },
    { key: "claudeCode", label: "Claude Code", requirement: RUNTIME_REQUIREMENTS.claudeCode },
    { key: "claudeCodeRouter", label: "Claude Code Router", requirement: RUNTIME_REQUIREMENTS.claudeCodeRouter },
  ].map((entry) => ({ ...entry, version: versions[entry.key] ?? null, ok: meetsRuntimeRequirement(entry.key, versions[entry.key]) }));
}

async function updateRuntime(options = {}) {
  const packages = [
    `@anthropic-ai/claude-code@${RUNTIME_TARGETS.claudeCode}`,
    `@musistudio/claude-code-router@${RUNTIME_TARGETS.claudeCodeRouter}`,
  ];
  const runtimePaths = ccrRuntimePaths(options.env);
  const statePaths = [...new Set([runtimePaths.configDir, runtimePaths.userDataDir, runtimePaths.appDataDir])];
  if (!options.write) return { write: false, packages, statePaths };

  const stateDir = runtimePaths.configDir;
  const backupDir = resolve(options.backupDir ?? join(stateDir, "backups", `airkit-runtime-${timestampForPath()}`));
  await mkdir(backupDir, { recursive: true });
  const stateFiles = ["config.json", "config.sqlite", "api-keys.sqlite", "usage.sqlite", "request-logs.sqlite", "service.json"];
  for (const [directoryIndex, directory] of statePaths.entries()) {
    for (const name of stateFiles.flatMap((file) => [file, `${file}-wal`, `${file}-shm`])) {
      const source = join(directory, name);
      if (await fileExists(source)) await copyFile(source, join(backupDir, `${directoryIndex}-${name}`));
    }
  }
  const runCommand = options.runCommand ?? runCommandSync;
  const install = await runCommand("npm", ["install", "--global", ...packages], { timeoutMs: options.commandTimeoutMs ?? 120000 });
  if (!install.ok) throw new Error(`runtime update failed; backup preserved at ${backupDir}${install.stderr ? `: ${install.stderr}` : ""}`);
  const report = runtimeReport(options.runtimeVersions ?? await inspectRuntimeVersions({ ...options, runCommand }));
  if (!report.every((entry) => entry.ok)) throw new Error(`runtime validation failed; backup preserved at ${backupDir}`);
  const probe = await (options.runtimeProbe ?? probeCcr3Runtime)({ ...options, runCommand });
  if (!meetsRuntimeRequirement("claudeCodeRouter", probe.version) || !probe.profileResolved) {
    throw new Error(`isolated CCR 3 validation failed; backup preserved at ${backupDir}`);
  }
  return { write: true, packages, statePaths, backupDir, probe, report };
}

async function probeCcr3Runtime(options = {}) {
  const root = await mkdtemp(join(tmpdir(), "airkit-runtime-probe-"));
  const env = {
    ...(options.env ?? process.env),
    HOME: join(root, "home"),
    CCR_INTERNAL_HOME_DIR: join(root, "home"),
    CCR_INTERNAL_APP_DATA_DIR: join(root, "app-data"),
    CCR_INTERNAL_USER_DATA_DIR: join(root, "user-data"),
  };
  const runCommand = options.runCommand ?? runCommandSync;
  await mkdir(env.HOME, { recursive: true });
  try {
    const client = createCcr3Client({ ...options, env, runCommand });
    const version = await client.getVersion();
    const config = await client.getConfig();
    await client.saveConfig({
      ...config,
      Providers: [...(config.Providers ?? []), {
        api_base_url: "http://127.0.0.1:9/v1/chat/completions",
        api_key: "airkit-runtime-probe",
        id: "airkit-runtime-probe-provider",
        models: ["probe"],
        name: "airkit-runtime-probe",
      }],
      profile: {
        ...(config.profile ?? {}),
        enabled: true,
        profiles: [...(config.profile?.profiles ?? []), {
          agent: "claude-code",
          enabled: true,
          id: "airkit-runtime-probe",
          model: "airkit-runtime-probe/probe",
          name: "AirKit runtime probe",
          scope: "ccr",
          surface: "cli",
        }],
      },
    });
    const resolved = await runCommand("ccr", ["airkit-runtime-probe", "cli", "--", "--version"], {
      env: { ...env, CCR_CLI_PREPARE_PROFILE_ONLY: "1" },
      timeoutMs: options.commandTimeoutMs ?? 30000,
    });
    return { profileResolved: resolved.ok, version };
  } finally {
    await runCommand("ccr", ["stop"], { env, timeoutMs: options.commandTimeoutMs ?? 30000 });
    await rm(root, { force: true, recursive: true });
  }
}

function meetsRuntimeRequirement(key, version) {
  const parsed = parseVersion(version);
  if (!parsed) return false;
  if (key === "node") return parsed[0] >= 22;
  if (key === "claudeCode") return compareVersions(parsed, [2, 1, 208]) >= 0;
  return compareVersions(parsed, [3, 0, 4]) >= 0 && parsed[0] < 4;
}

function parseVersion(value) {
  const match = String(value ?? "").match(/(\d+)\.(\d+)\.(\d+)/);
  return match ? match.slice(1).map(Number) : null;
}

function extractVersion(value) {
  const match = String(value ?? "").match(/\d+\.\d+\.\d+/);
  return match?.[0] ?? null;
}

function compareVersions(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

async function checkLaunchRuntime(plan, options = {}) {
  const commandExists = options.commandExists ?? commandExistsOnPath;
  const ccrExists = await commandExists("ccr");
  // CCR still has to be present as the gateway daemon, but the launch command
  // is now Claude Code itself, so it needs its own check.
  const launchExists = await commandExists(plan.launch.command);
  const versions = { ...(options.runtimeVersions ?? await inspectRuntimeVersions(options)) };
  if (options.ccrClient && !options.dryRun && !options.doctor) {
    versions.claudeCodeRouter = await readCcrVersionSafely(options.ccrClient);
  }
  const report = runtimeReport(versions);
  const runtime = {
    ccr: ccrExists ? { ok: true, command: "ccr" } : { ok: false, command: "ccr", reason: "missing command: ccr" },
    launch: launchExists
      ? { ok: true, command: plan.launch.command }
      : { ok: false, command: plan.launch.command, reason: `missing command: ${plan.launch.command}` },
    versions: report,
  };
  const failedVersion = report.find((entry) => !entry.ok);
  if (failedVersion) {
    runtime.ccr = { ok: false, command: "ccr", reason: `${failedVersion.label} ${failedVersion.version ?? "missing"} does not satisfy ${failedVersion.requirement}; run airkit runtime update --write` };
  }
  return runtime;
}

async function readCcrVersionSafely(ccrClient) {
  try {
    return await ccrClient.getVersion();
  } catch {
    throw new Error(
      "Unable to inspect CCR runtime version safely. Run airkit repair codex-takeover --write to back up and repair safely",
    );
  }
}

async function resolveCcrAuthEnv(plan, { commandExists, env, runCommand, timeoutMs }) {
  const existingToken = env.ANTHROPIC_AUTH_TOKEN;
  // Same reason as resolveProviderApiKeys: inside a launched session the
  // environment is not a credential source — ANTHROPIC_AUTH_TOKEN holds the
  // local gateway key, and any inherited op-ref override may be stale or
  // belong to a different launcher. Nested runs trust only the profile.
  const nested = Boolean(env.AIRCLAUDE_PROFILE || env.AIRCLAUDE_MODE);
  if (existingToken && !nested && !existingToken.startsWith("op://")) {
    return { ok: true, env: { ANTHROPIC_AUTH_TOKEN: existingToken } };
  }

  const ref = nested
    ? plan.credential.ccrTokenOpRef
    : env.CCR_ANTHROPIC_AUTH_TOKEN_OP_REF ??
      env.ANTHROPIC_AUTH_TOKEN_OP_REF_DEFAULT ??
      env.ANTHROPIC_AUTH_TOKEN_OP_REF ??
      plan.credential.ccrTokenOpRef;
  if (!ref) return { ok: true, env: {} };
  if (!(await commandExists("op"))) {
    return { ok: false, reason: `op not found; cannot resolve ${ref}` };
  }

  const token = await runCommand("op", ["read", ref, "--no-newline"], { env, timeoutMs });
  if (!token.ok) {
    return { ok: false, reason: `unable to read ${ref} from 1Password; run op signin and retry` };
  }
  return { ok: true, env: { ANTHROPIC_AUTH_TOKEN: token.stdout } };
}

async function resolveProviderApiKeys(catalog, profileName, plan, options) {
  const profile = findProfile(catalog, profileName);
  const env = options.env ?? process.env;
  // A launched session exports the CCR gateway key as ANTHROPIC_AUTH_TOKEN, and
  // running airkit from inside one would otherwise adopt that key as the
  // upstream provider credential and save it — repointing every mode at a key
  // the upstream rejects. Inside our own session the environment is not a
  // credential source; fall through to the profile's op reference.
  const nested = Boolean(env.AIRCLAUDE_PROFILE || env.AIRCLAUDE_MODE);
  const apiKeys = {};
  const providerTokenOpRefs = profile.shell?.providerTokenOpRefs ?? {};
  const commandExists = options.commandExists ?? commandExistsOnPath;
  const runCommand = options.runCommand ?? runCommandSync;
  const timeoutMs = options.commandTimeoutMs ?? 30000;
  for (const [providerName, ref] of Object.entries(providerTokenOpRefs)) {
    if (!(await commandExists("op"))) {
      throw new Error(`op not found; cannot resolve ${ref}`);
    }
    const token = await runCommand("op", ["read", ref, "--no-newline"], { env, timeoutMs });
    if (!token.ok) {
      throw new Error(`unable to read ${ref} from 1Password; run op signin and retry`);
    }
    apiKeys[providerName] = token.stdout;
  }
  const unresolved = [];
  for (const provider of profile.ccr?.Providers ?? []) {
    const match = String(provider.api_key ?? "").match(/^\$([A-Za-z_][A-Za-z0-9_]*)$/);
    if (!match) continue;
    if (Object.hasOwn(providerTokenOpRefs, provider.name)) continue;
    if (env[match[1]] && !nested) apiKeys[provider.name] = env[match[1]];
    else unresolved.push({ providerName: provider.name, envName: match[1] });
  }
  if (unresolved.length > 0 && plan.credential.ccrTokenOpRef) {
    const auth = await resolveCcrAuthEnv(plan, {
      commandExists,
      env,
      runCommand,
      timeoutMs,
    });
    if (!auth.ok) throw new Error(auth.reason);
    if (auth.env.ANTHROPIC_AUTH_TOKEN) {
      for (const credential of unresolved) {
        if (credential.envName === "ANTHROPIC_AUTH_TOKEN") {
          apiKeys[credential.providerName] = auth.env.ANTHROPIC_AUTH_TOKEN;
        }
      }
    }
  }
  const stillUnresolved = unresolved.filter(({ providerName }) => !apiKeys[providerName]);
  if (stillUnresolved.length > 0) {
    throw new Error(`unresolved provider credentials: ${stillUnresolved
      .map(({ providerName, envName }) => `${providerName} (${envName})`)
      .join(", ")}`);
  }
  return apiKeys;
}

export function createCcr3Client(options = {}) {
  const stateDir = defaultCcrStateDir(options.env);
  const runCommand = options.runCommand ?? runCommandSync;
  const fetchImpl = options.fetch ?? globalThis.fetch;
  let service;

  function serviceUnavailable() {
    return new Error("CCR 3 management service is not running; start it explicitly and retry");
  }

  async function startService() {
    if (options.autoStart === false) throw serviceUnavailable();
    const timeoutMs = options.commandTimeoutMs ?? 30000;
    const supervisor = await ccrSupervisorTarget(runCommand, options.env);
    if (supervisor) {
      // `kickstart` without -k starts a job that is down and does nothing to one
      // that is already up, so it cannot add a second service the way a bare
      // `ccr start` beside launchd can. It returns when the job is submitted,
      // not when the service is listening, so wait for what the caller needs.
      const kicked = await runCommand("launchctl", ["kickstart", supervisor], { env: options.env, timeoutMs });
      if (!kicked?.ok) {
        throw new Error(`unable to start supervised CCR 3 management service ${supervisor}${kicked?.stderr ? `: ${kicked.stderr}` : ""}`);
      }
      if (!(await waitForServiceFile(options.serviceReadyTimeoutMs ?? 15000))) {
        throw new Error(`supervised CCR 3 management service ${supervisor} did not publish service.json`);
      }
      return;
    }
    const started = await runCommand("ccr", ["start", "--no-gateway"], { env: options.env, timeoutMs });
    if (!started.ok) {
      throw new Error(`unable to start CCR 3 management service${started.stderr ? `: ${started.stderr}` : ""}`);
    }
  }

  async function waitForServiceFile(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const service = await readServiceFile();
      if (service) return service;
      if (Date.now() >= deadline) return null;
      await new Promise((settle) => setTimeout(settle, 100));
    }
  }

  // Deliberately separate from loadService: this one never starts anything and
  // never throws, because its only caller already has a service answering on
  // the wire and is asking a narrower question — did the token change?
  async function readServiceFile() {
    try {
      return JSON.parse(await readFile(join(stateDir, "service.json"), "utf8"));
    } catch {
      return null;
    }
  }

  async function loadService(forceStart = false) {
    if (forceStart) await startService();
    try {
      return JSON.parse(await readFile(join(stateDir, "service.json"), "utf8"));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      await startService();
      return JSON.parse(await readFile(join(stateDir, "service.json"), "utf8"));
    }
  }

  async function rpc(method, args = []) {
    service ??= await loadService();
    let serviceUrl = new URL(service.url);
    let token = serviceUrl.searchParams.get("ccr_web_token");
    if (!token) throw new Error("CCR service.json is missing its management token");
    const request = () => fetchImpl(new URL("/api/ccr/rpc", serviceUrl.origin), {
        method: "POST",
        headers: { "content-type": "application/json", origin: serviceUrl.origin, "x-ccr-web-auth": token },
        body: JSON.stringify({ method, args }),
        signal: AbortSignal.timeout(options.rpcTimeoutMs ?? 5_000),
      });
    let response;
    try {
      response = await request();
    } catch {
      if (options.autoStart === false) throw serviceUnavailable();
      // A restart mints a new port and token, so a connection failure often means
      // only that this client is holding the previous service.json. Re-read and
      // retry before starting anything: an unconditional start here is the most
      // direct way to end up with a second management service beside a supervised
      // one that launchd is already bringing back.
      const current = await readServiceFile();
      if (current && current.url !== service.url) {
        service = current;
        serviceUrl = new URL(service.url);
        token = serviceUrl.searchParams.get("ccr_web_token");
        response = await request().catch(() => undefined);
      }
      if (!response) {
        service = await loadService(true);
        serviceUrl = new URL(service.url);
        token = serviceUrl.searchParams.get("ccr_web_token");
        response = await request();
      }
    }
    // A management-service restart mints a new web token on the same port, so a
    // client holding the previous service.json authenticates against a service
    // that no longer exists. The connection succeeds, so the reconnect path
    // above never sees it — the rejection arrives as a status. The file on disk
    // is already correct: re-read it and retry once. This recovers rotation
    // only; a second rejection is a real authorization failure, and a service
    // answering at all means there is nothing here to start.
    if (response.status === 401 || response.status === 403) {
      const rotated = await readServiceFile();
      const rotatedToken = rotated ? new URL(rotated.url).searchParams.get("ccr_web_token") : null;
      if (rotatedToken && rotatedToken !== token) {
        service = rotated;
        serviceUrl = new URL(rotated.url);
        token = rotatedToken;
        response = await request();
      }
    }
    if (!response.ok) throw new Error(`CCR RPC ${method} failed: HTTP ${response.status}`);
    const payload = await response.json();
    if (payload.error) throw new Error(`CCR RPC ${method} failed: ${payload.error.message ?? payload.error}`);
    return payload.value;
  }

  return {
    getConfig: () => rpc("getConfig"),
    getVersion: async () => (await rpc("getAppInfo")).version,
    saveConfig: (config) => rpc("saveConfig", [config, { applyProfile: false }]),
    // Runs CCR's apply-all-profiles pass, which is what mints the per-profile
    // gateway key helpers. Callers must have vetted the config through the
    // Codex takeover guards first.
    applyProfile: () => rpc("applyProfile"),
    ensureGateway: () => ensureCcr3Gateway({
      fetchImpl,
      getConfig: () => rpc("getConfig"),
      healthTimeoutMs: options.gatewayHealthTimeoutMs,
      pollAttempts: options.gatewayPollAttempts,
      pollIntervalMs: options.gatewayPollIntervalMs,
      startGateway: () => rpc("startGateway"),
    }),
  };
}

export function resolveCcrGatewayEndpoint(config) {
  const bindHost = config.gateway?.host ?? config.HOST;
  const port = config.gateway?.port ?? config.PORT;
  if (!bindHost || !Number.isInteger(Number(port))) {
    throw new Error("CCR config does not define a gateway host and port");
  }
  const host = bindHost === "0.0.0.0" ? "127.0.0.1" : bindHost === "::" ? "::1" : bindHost;
  const authority = host.includes(":") ? `[${host}]` : host;
  return new URL(`http://${authority}:${port}`);
}

export async function ensureCcr3Gateway(options) {
  const config = await options.getConfig();
  const endpoint = resolveCcrGatewayEndpoint(config);
  const coreEndpoint = resolveCcrGatewayEndpoint({
    gateway: { host: config.gateway?.coreHost, port: config.gateway?.corePort },
  });
  const healthy = async () => {
    try {
      const outerHealth = await options.fetchImpl(new URL("/health", endpoint), {
        signal: AbortSignal.timeout(options.healthTimeoutMs ?? 1_000),
      });
      if (!outerHealth.ok) return false;
      const coreHealth = await options.fetchImpl(new URL("/health", coreEndpoint), {
        signal: AbortSignal.timeout(options.healthTimeoutMs ?? 1_000),
      });
      if (!coreHealth.ok) return false;
      return (await coreHealth.json().catch(() => null))?.status === "ok";
    } catch {
      return false;
    }
  };
  if (await healthy()) return endpoint.origin;
  await options.startGateway();
  const pollAttempts = options.pollAttempts ?? 50;
  const pollIntervalMs = options.pollIntervalMs ?? 100;
  for (let attempt = 0; attempt < pollAttempts; attempt += 1) {
    if (await healthy()) return endpoint.origin;
    if (pollIntervalMs > 0) await new Promise((done) => setTimeout(done, pollIntervalMs));
  }
  throw new Error(`CCR gateway is not healthy at ${endpoint.origin}`);
}

function renderManagedFiles(profile, options = {}) {
  const configDir = resolve(options.configDir ?? defaultConfigDir());
  const vars = profileTemplateVars(profile, configDir);
  const explicit = (profile.managedFiles ?? []).map((file) => ({
    label: file.label ?? `managed file ${file.path}`,
    path: resolve(configDir, file.path),
    relativePath: file.path,
    content: renderTemplateValue(file.content, vars),
  }));

  const binary = profile.launch?.binary ?? profile.shell?.wrappers?.[0]?.command;
  const heartbeat = profile.ccr && shouldAppendReusableRuntimeLessons(binary)
    ? renderHeartbeatManagedFiles(configDir)
    : [];

  return [...explicit, ...heartbeat];
}

async function writeTextFile(path, content, { force }) {
  if (!force && (await fileExists(path))) {
    throw new Error(`${path} already exists; pass --force to overwrite`);
  }
  await writeFile(path, content);
}

async function checkRenderedFile(path, expected, label) {
  let actual;
  try {
    actual = await readFile(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { ok: false, label, path, reason: `missing ${label}: ${path}` };
    }
    throw error;
  }

  if (actual !== expected) {
    return { ok: false, label, path, reason: `stale ${label}: ${path}` };
  }
  return { ok: true, label, path };
}

async function planUpdateFile(target, preview, expected, label) {
  let actual;
  try {
    actual = await readFile(target, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { status: "missing", label, target, preview, diff: `missing ${label}; would create` };
    }
    throw error;
  }

  if (actual === expected) {
    return { status: "current", label, target, preview, diff: "no changes" };
  }

  return { status: "stale", label, target, preview, diff: describeTextDiff(actual, expected) };
}

function describeTextDiff(actual, expected) {
  const actualLines = actual.split("\n");
  const expectedLines = expected.split("\n");
  const lineCount = Math.max(actualLines.length, expectedLines.length);

  for (let index = 0; index < lineCount; index += 1) {
    if (actualLines[index] !== expectedLines[index]) {
      return `first difference at line ${index + 1}`;
    }
  }

  return "content differs";
}

function renderDoctorResult(result) {
  const lines = [
    `profile: ${result.profile.name}`,
    `${result.files.ccrConfig.ok ? "ok" : "fail"} CCR config: ${result.files.ccrConfig.path}`,
    `${result.files.shellSnippet.ok ? "ok" : "fail"} shell snippet: ${result.files.shellSnippet.path}`,
    ...result.files.managedFiles.map(
      (file) => `${file.ok ? "ok" : "fail"} ${file.label ?? "managed file"}: ${file.path}`,
    ),
    `${statusOf(result.runtime.ccr)} CCR availability: ${result.runtime.ccr.command}`,
    ...renderManagedStateLines(result.runtime.managedState),
    ...renderManagementServiceLines(result.runtime.managementServices),
    ...renderPluginFreshnessLines(result.runtime.pluginFreshness),
    `${statusOf(result.runtime.shellSource)} shell source: ${result.runtime.shellSource.path}`,
    renderContextWindow(result.runtime.context),
    renderAutoCompactWindow(result.runtime.context),
    renderCompletionUsage(result.runtime.context),
  ];
  if (!result.runtime.compatibility.skipped) {
    for (const [capability, status] of Object.entries(result.runtime.compatibility.capabilities)) {
      lines.push(`${status} compatibility ${capability}`);
    }
    for (const note of result.runtime.compatibility.notes ?? []) {
      lines.push(`  note: ${note}`);
    }
  }
  for (const failure of result.failures) {
    lines.push(`- ${failure}`);
  }
  return `${lines.join("\n")}\n`;
}

function renderContextWindow(context) {
  const { source, tokens } = context.contextWindow;
  return tokens === null
    ? "info context window: unavailable"
    : `info context window: ${tokens} tokens (${source}; metadata only)`;
}

function renderAutoCompactWindow(context) {
  const { source, tokens } = context.autoCompactWindow;
  return tokens === null
    ? `info auto compact window: ${source}`
    : `info auto compact window: ${tokens} tokens (${source})`;
}

function renderCompletionUsage(context) {
  const { cacheDetails, inputTokens, totalTokens } = context.usage;
  const accounting = inputTokens === null ? "unavailable" : `${inputTokens} input / ${totalTokens} total tokens`;
  return `info completion usage: ${accounting}; cache details ${cacheDetails}`;
}

async function checkCcrAvailability(profile, commandExists) {
  if (!profile.ccr) {
    return { ok: true, skipped: true, command: "ccr" };
  }
  if (await commandExists("ccr")) {
    return { ok: true, command: "ccr" };
  }
  return { ok: false, command: "ccr", reason: "missing command: ccr" };
}

async function checkShellSourceability(path, profile, sourceSnippet) {
  const result = await sourceSnippet(path, shellFunctionNames(profile));
  if (result.ok) {
    return { ok: true, path };
  }

  const detail = result.detail ? ` (${result.detail})` : "";
  return { ok: false, path, reason: `shell snippet is not sourceable: ${path}${detail}` };
}

function commandExistsOnPath(command) {
  const result = spawnSync("sh", ["-c", 'command -v "$1" >/dev/null 2>&1', "airkit-command-check", command], {
    stdio: "ignore",
  });
  return result.status === 0;
}

function runCommandSync(command, args = [], options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    env: options.env ?? process.env,
    timeout: options.timeoutMs ?? 30000,
  });
  const stderr = [result.stderr?.trim(), result.error?.message].filter(Boolean).join("\n");

  return {
    ok: result.status === 0,
    status: result.status,
    stdout: result.stdout?.trim() ?? "",
    stderr,
  };
}

function spawnCommandAsync(command, args = [], options = {}) {
  return spawn(command, args, {
    stdio: options.stdio ?? "inherit",
    env: options.env ?? process.env,
  });
}

function spawnCommandSync(command, args = [], options = {}) {
  return spawnSync(command, args, {
    stdio: options.stdio ?? "inherit",
    env: options.env ?? process.env,
  });
}

async function monitorChildLifecycle(middleware, child) {
  let closePromise = null;
  const close = () => {
    closePromise ??= Promise.resolve().then(() => middleware?.close());
    return closePromise;
  };
  if (Number.isInteger(child?.status)) {
    await close();
    return child.status;
  }
  if (typeof child?.once !== "function") {
    await close();
    return 0;
  }
  return new Promise((resolve, reject) => {
    child.once("exit", (code, signal) => {
      void close().then(
        () => resolve(Number.isInteger(code) ? code : signal ? 1 : 0),
        reject,
      );
    });
    child.once("error", (error) => {
      void close().then(() => reject(error), reject);
    });
  });
}

function sourceShellSnippet(path, functionNames) {
  const script = 'source "$1" || exit $?; shift; for fn in "$@"; do typeset -f "$fn" >/dev/null || exit 1; done';
  const result = spawnSync("zsh", ["-fc", script, "airkit-source-check", path, ...functionNames], {
    encoding: "utf8",
  });
  if (result.error) {
    return { ok: false, detail: result.error.message };
  }
  if (result.status === 0) {
    return { ok: true };
  }

  const detail = [result.stderr?.trim(), result.stdout?.trim()].filter(Boolean).join("; ");
  return { ok: false, detail: detail || `zsh exited ${result.status}` };
}

function shellFunctionNames(profile) {
  const shell = profile.shell ?? {};
  return (shell.wrappers ?? []).map((wrapper) => wrapper.name).filter(Boolean);
}

function statusOf(check) {
  if (check.skipped) return "skip";
  if (check.warn) return "warn";
  return check.ok ? "ok" : "fail";
}

// A warning never reaches `result.failures`, so the detail has to be named right
// here or a bare count would be all the user ever sees.
function renderWarnableCheck(label, check, summarize) {
  const head = `${statusOf(check)} ${label}: ${summarize(check)}`;
  return check.warn ? [head, `  ${check.reason}`] : [head];
}

function renderManagedStateLines(managedState) {
  return renderWarnableCheck("orphaned CCR state", managedState, (check) => {
    if (check.skipped) return "not inspected";
    return check.count === 0 ? "none" : `${check.count} artifact(s) owned by no installed profile`;
  });
}

function renderManagementServiceLines(managementServices) {
  return renderWarnableCheck("CCR management services", managementServices, (check) =>
    check.pids.length <= 1 ? `${check.pids.length} running` : `${check.pids.length} running, only one can hold the port`);
}

function renderPluginFreshnessLines(pluginFreshness) {
  return renderWarnableCheck("CCR plugin freshness", pluginFreshness, (check) => {
    if (check.skipped) return check.reason;
    return check.stale.length === 0
      ? `host started ${check.hostStartedAt}, no module changed since`
      : `${check.stale.length} module tree(s) changed after the plugin host started`;
  });
}

function profileTemplateVars(profile, configDir = defaultConfigDir()) {
  return {
    configDir: resolve(configDir),
    home: homedir(),
    profileName: profile.name,
    claudeModel: profile.launch?.claudeModel ?? "",
  };
}

function renderTemplateValue(value, vars) {
  if (typeof value === "string") {
    let rendered = value;
    for (const [key, replacement] of Object.entries(vars)) {
      rendered = rendered.replaceAll(`{{${key}}}`, replacement);
    }
    return rendered;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => renderTemplateValue(entry, vars));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, renderTemplateValue(entry, vars)]));
  }
  return value;
}

async function fileExists(path) {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

if (isDirectEntrypoint()) {
  const entrypoint = basename(process.argv[1]);
  const argv = process.argv.slice(2);
  const runner = entrypoint === "airclaude" ? runAirclaudeCli : runCli;

  runner(argv)
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error) => {
      console.error(`airkit: ${error.message}`);
      process.exitCode = 1;
    });
}

function isDirectEntrypoint() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}
