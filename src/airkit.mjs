#!/usr/bin/env node

import { access, chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

import {
  codexSafetyPaths,
  inspectCodexTakeover,
  repairCodexTakeover,
} from "./codex-takeover-guard.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const defaultCatalogPath = join(repoRoot, "profiles", "catalog.json");
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

export async function loadCatalog(path = defaultCatalogPath) {
  const raw = await readFile(path, "utf8");
  const catalog = JSON.parse(raw);
  validateCatalog(catalog);
  return catalog;
}

export function buildCcrConfig(catalog, profileName, options = {}) {
  const profile = findProfile(catalog, profileName);
  if (!profile.ccr) {
    throw new Error(`profile "${profileName}" does not define a CCR config`);
  }
  return renderTemplateValue(structuredClone(profile.ccr), profileTemplateVars(profile, options.configDir));
}

export function buildCcr3ManagedConfig(catalog, profileName, currentConfig = {}, options = {}) {
  const profile = findProfile(catalog, profileName);
  const configDir = resolve(options.configDir ?? defaultConfigDir());
  const templateVars = profileTemplateVars(profile, configDir);
  const launch = resolveLaunchConfig(profile, templateVars);
  const modes = Object.keys(launch.modes ?? { auto: {} }).sort();
  const managedPrefix = `airkit-${slug(profile.name)}-`;
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
        api_base_url: providerBaseUrl || provider.api_base_url,
        id,
        name: id,
        api_key: options.apiKeys?.[provider.name] ?? provider.api_key,
      },
    };
  });
  const managedProviders = managedProviderEntries.map((entry) => entry.config);
  const managedProviderIds = new Map(managedProviderEntries.map((entry) => [entry.sourceName, entry.config.id]));
  const managedRouteSelector = (route) => {
    const selector = routeSelector(route);
    const separator = selector.indexOf("/");
    const providerName = selector.slice(0, separator);
    const providerId = managedProviderIds.get(providerName);
    if (!providerId) throw new Error(`CCR route references unmanaged provider: ${providerName}`);
    return `${providerId}/${selector.slice(separator + 1)}`;
  };
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
  const preservedProviders = (currentConfig.Providers ?? []).filter(
    (provider) => !managedProviderNames.has(provider.name) && !managedProviderIdSet.has(provider.id),
  );
  const managedProfiles = modes.map((mode) => {
    const modeConfig = applyLaunchModeOverlay(structuredClone(baseConfig), profile, mode, templateVars);
    const claudeModel = resolveClaudeLaunchModel(profile);
    const launchVars = launchTemplateVars(profile, configDir, mode, modeConfig, claudeModel);
    return {
      agent: "claude-code",
      enabled: true,
      env: {
        ...airclaudeLaunchEnv(catalog, profile, mode, modeConfig, options.env),
        ...renderTemplateValue(launch.env ?? {}, launchVars),
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
      ...mergeManagedConfigArrays(currentConfig, baseConfig, managedPrefix),
      profile: {
        ...(currentConfig.profile ?? {}),
        enabled: true,
        profiles: [...currentProfiles.filter((candidate) => !candidate.id?.startsWith(managedPrefix)), ...managedProfiles],
      },
    },
    profileIds: Object.fromEntries(modes.map((mode) => [mode, `${managedPrefix}${slug(mode)}`])),
  };
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
    if (!Array.isArray(baseConfig[key])) continue;
    const managed = baseConfig[key].map((entry, index) => ({
      ...entry,
      id: entry.id ?? `${managedPrefix}${slug(key)}-${index + 1}`,
    }));
    const ownedIds = new Set(managed.map((entry) => entry.id));
    const ownedPaths = new Set(managed.map((entry) => entry.path).filter(Boolean));
    merged[key] = [
      ...(currentConfig[key] ?? []).filter((entry) => !ownedIds.has(entry.id) && !ownedPaths.has(entry.path)),
      ...managed,
    ];
  }
  return merged;
}

export function buildShellSnippet(catalog, profileName, options = {}) {
  const profile = findProfile(catalog, profileName);
  const shell = profile.shell ?? {};
  const templateVars = profileTemplateVars(profile, options.configDir);
  const lines = [
    `# Generated by airkit for profile: ${profile.name}`,
    `# ${profile.summary}`,
  ];

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
  await mkdir(join(outDir, "profiles"), { recursive: true });
  await mkdir(join(outDir, "scripts"), { recursive: true });
  const binPath = join(outDir, "src", "airkit.mjs");
  await writeFile(binPath, await readFile(fileURLToPath(import.meta.url), "utf8"));
  await chmod(binPath, 0o755);
  await copyFile(join(here, "codex-takeover-guard.mjs"), join(outDir, "src", "codex-takeover-guard.mjs"));
  await writeFile(join(outDir, "profiles", "catalog.json"), `${JSON.stringify(publicCatalog, null, 2)}\n`);
  await writeFile(
    join(outDir, "scripts", "verify-ccr3-e2e.mjs"),
    await readFile(join(repoRoot, "scripts", "verify-ccr3-e2e.mjs"), "utf8"),
  );
  await writeFile(join(outDir, "package.json"), `${JSON.stringify(publicPackage(), null, 2)}\n`);
  await writeFile(join(outDir, "CLAUDE.md"), claudeGuide());
  await writeFile(join(outDir, "README.md"), publicReadme());
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

export function buildLaunchPlan(catalog, profileName, options = {}) {
  const profile = findProfile(catalog, profileName);
  const configDir = resolve(options.configDir ?? defaultConfigDir());
  const templateVars = profileTemplateVars(profile, configDir);
  const launch = resolveLaunchConfig(profile, templateVars);
  const mode = resolveLaunchMode(profile, launch, options.mode);
  const ccrConfig = applyLaunchModeOverlay(buildCcrConfig(catalog, profileName, { configDir }), profile, mode, templateVars);
  assertCcr3Compatible(ccrConfig);
  const logOverride = resolveCcrLogOverride(options.env ?? process.env);
  if (logOverride !== undefined) ccrConfig.LOG = logOverride;
  const claudeModel = resolveClaudeLaunchModel(profile);
  const launchVars = launchTemplateVars(profile, configDir, mode, ccrConfig, claudeModel);
  const basePlan = planInstall(catalog, profileName, { configDir, write: true, force: true });
  const managedProfileId = `airkit-${slug(profile.name)}-${slug(mode)}`;
  const claudeArgs = appendLaunchRuntimePrompts(
    withAirclaudeModelArg(
      (launch.args ?? []).map((arg) => renderTemplateValue(arg, launchVars)),
      launch.binary,
      claudeModel,
    ),
    launch.binary,
    mode,
    ccrConfig,
    claudeModel,
  );

  return {
    profile: basePlan.profile,
    mode,
    configDir,
    files: basePlan.files,
    ccrConfig,
    liveCcrConfig: { path: join(defaultCcrStateDir(options.env), "config.sqlite") },
    credential: {
      ccrTokenOpRef: profile.shell?.ccrTokenOpRef ?? null,
    },
    launch: {
      command: "ccr",
      args: [managedProfileId, "cli", "--", ...claudeArgs],
      env: {
        ...airclaudeLaunchEnv(catalog, profile, mode, ccrConfig, options.env),
        ...renderTemplateValue(launch.env ?? {}, launchVars),
      },
      userArgs: options.userArgs ?? [],
    },
  };
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
    env: options.env,
  });
  if (!isDeepStrictEqual(managed.config, currentConfig)) {
    await ccrClient.saveConfig(managed.config, { applyProfile: false });
  }
  let child = null;
  if (options.launch !== false) {
    await ccrClient.ensureGateway();
    const spawnCommand = options.spawnCommand ?? spawnCommandSync;
    child = spawnCommand(plan.launch.command, [...plan.launch.args, ...plan.launch.userArgs], {
      env: { ...(options.env ?? process.env), ...plan.launch.env },
      stdio: "inherit",
    });
  }

  return {
    ...plan,
    write: true,
    files: await planLaunchFiles(plan, rendered),
    liveCcrConfig: { ...plan.liveCcrConfig, status: "managed" },
    runtime,
    child,
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
  const runtime = {
    ccr: await checkCcrAvailability(profile, options.commandExists ?? commandExistsOnPath),
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
    validateManagedFiles(profile);
  }
}

function validateCcr(profileName, ccr) {
  for (const provider of ccr.Providers ?? []) {
    if (typeof provider.api_key === "string" && provider.api_key.startsWith("sk-")) {
      throw new Error(`profile "${profileName}" embeds a secret-looking API key`);
    }
  }
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
    name: "@lzong/ai-runtime-kit",
    version: "0.2.0",
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
      "scripts/verify-ccr3-e2e.mjs",
      "src",
    ],
    scripts: {
      check: "node --check src/airkit.mjs",
      "pack:check": "npm pack --dry-run",
      test: "node --test",
      "verify:ccr3:e2e": "node scripts/verify-ccr3-e2e.mjs",
      verify: "npm test && npm run check && npm run pack:check",
    },
    engines: { node: RUNTIME_REQUIREMENTS.node },
    license: "MIT",
    author: "LZong, Lim, Un-tiong <lzong.tw@gmail.com>",
  };
}

function publicReadme() {
  return `# ai-runtime-kit

Public-safe runtime profile templates for Claude Code Router and other AI client wrappers.

This repository intentionally contains no private endpoints, no credential-manager item references, and no secret values. Use \`profiles/catalog.json\` as a starting point, then keep machine-specific runtime state outside git.

\`\`\`bash
airclaude
airclaude pro
airclaude --dry-run
airclaude --doctor
airclaude --help
airkit list
airkit --help
airkit runtime check
airkit runtime update
airkit runtime update --write
airkit init --profile openai-compatible-example
airkit init --profile openai-compatible-example --write
airkit render ccr --profile openai-compatible-example
airkit render shell --profile openai-compatible-example
airkit update --profile openai-compatible-example
airkit doctor --profile openai-compatible-example
\`\`\`

\`airclaude\` is the daily entrypoint. It merges AirKit-owned providers and
profiles through the CCR 3 management API, then launches the managed CCR CLI
profile. Supported versions are Node.js 22+, Claude Code 2.1.208+, and CCR
3.0.4 through the latest 3.x release.
\`airclaude pro\` applies the profile's stronger routing overlay before launch.

For LLM-guided installation or debugging, start with \`CLAUDE.md\`. The
management flow remains inspectable: dry run first, then \`--write\` after the
user confirms the target paths.
`;
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
    dryRun: parsed.dryRun || parsed.doctor,
    launch: !parsed.dryRun && !parsed.doctor,
    mode: parsed.mode,
    userArgs: parsed.userArgs,
  });
  stdout.write(renderLaunchResult(result, { doctor: parsed.doctor, dryRun: parsed.dryRun }));
  return result.child?.status ?? 0;
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

function parseAirclaudeArgs(argv, validModes = new Set(["auto", "pro"])) {
  const parsed = { userArgs: [] };
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
    } else if (arg === "--dry-run") {
      parsed.dryRun = true;
    } else if (arg === "--doctor") {
      parsed.doctor = true;
    } else if (["--repair-restore", "--restore-projects-dir", "--restore-backups-dir"].includes(arg)) {
      throw new Error(`${arg} was removed; AirKit no longer reads or rewrites Claude Code session model state`);
    } else if (validModes.has(arg) && !parsed.mode) {
      parsed.mode = arg;
    } else {
      parsed.userArgs.push(arg);
    }
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
  if (takeoverText?.trim()) {
    try {
      JSON.parse(takeoverText);
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
  -h, --help             Show this help.

Examples:
  airclaude
  airclaude pro
  airclaude --doctor
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

  return `${action} airclaude profile: ${result.profile.name}
mode: ${result.mode}

Routes:
- default: ${result.ccrConfig.Router?.default ?? "unset"}
- background: ${result.ccrConfig.Router?.background ?? "unset"}

Files:
${fileLines.join("\n")}
- ${result.liveCcrConfig.status} CCR state database: ${result.liveCcrConfig.path}

Runtime:
${runtimeLines.join("\n") || "- skipped"}
Launch:
- ${result.launch.command} ${[...result.launch.args, ...result.launch.userArgs].map(quoteShell).join(" ")}
`;
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

function appendLaunchRuntimePrompts(args, binary, mode, ccrConfig, claudeModel) {
  if (!shouldAppendReusableRuntimeLessons(binary)) return args;
  return appendRuntimePrompts(args, [airclaudeRoutingPrompt(mode, ccrConfig, claudeModel)]);
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
    // the launch model a `[1m]` suffix (launch.claudeModel: claude-sonnet-4-6[1m]); the API
    // id is normalized back to claude-sonnet-4-6 on the wire, so the suffix is a Claude-Code-local
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

  for (const [key, route] of managedRouterEntries(ccrConfig.Router)) {
    const envKey = `AIRCLAUDE_ROUTE_${toEnvKey(key)}`;
    const { provider, model } = splitRoute(route);
    env[envKey] = route;
    env[`${envKey}_PROVIDER`] = provider;
    env[`${envKey}_MODEL`] = model;
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
      ? `- Claude launch/display model is compatibility metadata only: ${claudeModel}`
      : "- Claude launch/display model is compatibility metadata only.",
    "- Do not infer the active provider route from Claude Code's displayed model name.",
    "- background/tool-heavy work may use the background route when the runtime/router selects it.",
    "- When compacting, restoring, summarizing, or reporting status, preserve AirClaude mode and provider routes separately from Claude-compatible display metadata.",
  ].join(" ");
}

function sortedRouterEntries(router) {
  return managedRouterEntries(router);
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
  const versions = { ...(options.runtimeVersions ?? await inspectRuntimeVersions(options)) };
  if (options.ccrClient && !options.dryRun && !options.doctor) {
    versions.claudeCodeRouter = await readCcrVersionSafely(options.ccrClient);
  }
  const report = runtimeReport(versions);
  const runtime = {
    ccr: ccrExists ? { ok: true, command: "ccr" } : { ok: false, command: "ccr", reason: "missing command: ccr" },
    launch: ccrExists
      ? { ok: true, command: plan.launch.command }
      : { ok: false, command: plan.launch.command, reason: "missing command: ccr" },
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
  if (existingToken && !existingToken.startsWith("op://")) {
    return { ok: true, env: { ANTHROPIC_AUTH_TOKEN: existingToken } };
  }

  const ref =
    env.CCR_ANTHROPIC_AUTH_TOKEN_OP_REF ??
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
  const apiKeys = {};
  const unresolved = [];
  for (const provider of profile.ccr?.Providers ?? []) {
    const match = String(provider.api_key ?? "").match(/^\$([A-Za-z_][A-Za-z0-9_]*)$/);
    if (!match) continue;
    if (env[match[1]]) apiKeys[provider.name] = env[match[1]];
    else unresolved.push(provider.name);
  }
  if (unresolved.length > 0 && plan.credential.ccrTokenOpRef) {
    const auth = await resolveCcrAuthEnv(plan, {
      commandExists: options.commandExists ?? commandExistsOnPath,
      env,
      runCommand: options.runCommand ?? runCommandSync,
      timeoutMs: options.commandTimeoutMs ?? 30000,
    });
    if (!auth.ok) throw new Error(auth.reason);
    if (auth.env.ANTHROPIC_AUTH_TOKEN) {
      for (const providerName of unresolved) apiKeys[providerName] = auth.env.ANTHROPIC_AUTH_TOKEN;
    }
  }
  const stillUnresolved = unresolved.filter((providerName) => !apiKeys[providerName]);
  if (stillUnresolved.length > 0) {
    throw new Error(`unresolved provider credentials: ${stillUnresolved.join(", ")}`);
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
    const started = await runCommand("ccr", ["start", "--no-gateway"], {
      env: options.env,
      timeoutMs: options.commandTimeoutMs ?? 30000,
    });
    if (!started.ok) {
      throw new Error(`unable to start CCR 3 management service${started.stderr ? `: ${started.stderr}` : ""}`);
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
      service = await loadService(true);
      serviceUrl = new URL(service.url);
      token = serviceUrl.searchParams.get("ccr_web_token");
      response = await request();
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
  const endpoint = resolveCcrGatewayEndpoint(await options.getConfig());
  const healthUrl = new URL("/health", endpoint);
  const healthy = async () => {
    try {
      return (await options.fetchImpl(healthUrl, {
        signal: AbortSignal.timeout(options.healthTimeoutMs ?? 1_000),
      })).ok;
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

  return explicit;
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
    `${statusOf(result.runtime.shellSource)} shell source: ${result.runtime.shellSource.path}`,
  ];
  for (const failure of result.failures) {
    lines.push(`- ${failure}`);
  }
  return `${lines.join("\n")}\n`;
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

function spawnCommandSync(command, args = [], options = {}) {
  return spawnSync(command, args, {
    stdio: options.stdio ?? "inherit",
    env: options.env ?? process.env,
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
  return check.ok ? "ok" : "fail";
}

function profileTemplateVars(profile, configDir = defaultConfigDir()) {
  return {
    configDir: resolve(configDir),
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

function claudeGuide() {
  const defaultProfile = "openai-compatible-example";

  return `# CLAUDE.md - ai-runtime-kit

## Agent Start Here

This repo is the public OSS for AI runtime profiles. The goal is a guided,
OpenCode-style install flow: inspect first, write only when the user passes
\`--write\`.

Run these from the repo root:

\`\`\`bash
node src/airkit.mjs --help
node src/airkit.mjs airclaude --help
node src/airkit.mjs airclaude --dry-run
node src/airkit.mjs airclaude pro --dry-run
node src/airkit.mjs list
node src/airkit.mjs init --profile ${defaultProfile}
node src/airkit.mjs init --profile ${defaultProfile} --write
node src/airkit.mjs doctor
\`\`\`

\`airclaude\` is the daily launch path. The management dry run prints every file
path it would create. Do not edit runtime files directly unless the user
explicitly asks for a manual repair.

## Product Boundary

- Keep runtime state out of git: Claude sessions, CCR daemon state, caches,
  login state, and secret values.
- Profiles may contain placeholders such as \`$ANTHROPIC_AUTH_TOKEN\`.
- Public output must not contain private endpoints, company names,
  credential-manager item references, or personal/company tokens.

## Release Rules

For public changes:

\`\`\`bash
npm run verify
git push
\`\`\`

Do not add private endpoints, company names, credential-manager item references, or
personal/company tokens to this repository.
`;
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
