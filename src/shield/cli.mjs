import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { readShieldIdentity, shieldPaths } from "./paths.mjs";
import {
  ensureShieldReady,
  inspectShieldService,
  installShieldService,
  launchShieldChild,
  startShieldService,
  stopShieldService,
} from "./service.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const EXIT_CODES = Object.freeze({ healthy: 0, degraded: 1, stopped: 2, blocked: 3 });
const SENSITIVE_KEYS = new Set(["capability", "origin", "target", "targetClass", "targetOrigin"]);

export async function runShieldCli(argv = [], dependencies = {}) {
  const stdout = dependencies.stdout ?? process.stdout;
  const [command = "help", ...rest] = argv;
  if (["help", "-h", "--help"].includes(command)) {
    stdout.write(renderShieldHelp());
    return 0;
  }
  const shield = dependencies.shield ?? await createDefaultShieldDependencies(dependencies);
  const handler = SHIELD_COMMANDS[command];
  if (!handler) throw new Error(`unknown shield command: ${argv.join(" ") || "(none)"}`);
  const result = await handler(rest, shield);
  stdout.write(renderShieldResult(command, result));
  return EXIT_CODES[result?.state] ?? EXIT_CODES.blocked;
}

const SHIELD_COMMANDS = Object.freeze({
  install: (argv, shield) => shield.install({ write: argv.includes("--write") }),
  start: (_argv, shield) => shield.start(),
  stop: (_argv, shield) => shield.stop(),
  status: (_argv, shield) => shield.status(),
  doctor: (_argv, shield) => shield.doctor(),
  launch: (argv, shield) => {
    const launch = parseLaunch(argv);
    return shield.launch(launch);
  },
});

async function createDefaultShieldDependencies(dependencies) {
  const env = dependencies.env ?? process.env;
  const paths = dependencies.paths ?? shieldPaths({ env });
  const nodePath = dependencies.nodePath ?? process.execPath;
  const daemonPath = dependencies.daemonPath ?? resolve(repoRoot, "src", "shieldd.mjs");
  const common = { paths, nodePath, daemonPath, env, ...(dependencies.io ? { io: dependencies.io } : {}), ...(dependencies.runLaunchctl ? { runLaunchctl: dependencies.runLaunchctl } : {}) };
  return {
    async install({ write }) {
      const service = await installShieldService({ ...common, write });
      return { state: write ? "degraded" : "stopped", write, service: { planned: true } };
    },
    async start() {
      await startShieldService(common);
      return { state: "degraded", started: true };
    },
    async stop() {
      await stopShieldService(common);
      return { state: "stopped", stopped: true };
    },
    async status() {
      return await shieldStatus({ paths, io: dependencies.io, runLaunchctl: dependencies.runLaunchctl });
    },
    async doctor() {
      return { ...(await shieldStatus({ paths, io: dependencies.io, runLaunchctl: dependencies.runLaunchctl })), checked: true };
    },
    async launch({ lane, command, args }) {
      const ready = await ensureShieldReady({ lane, env, paths, io: dependencies.io, inspectService: dependencies.inspectService, isProcessAlive: dependencies.isProcessAlive });
      const outcome = await launchShieldChild({ command, args, ready, env, spawnChild: dependencies.spawnChild });
      return { state: outcome.code === 0 ? "healthy" : "degraded", launched: true, exitCode: outcome.code ?? 1 };
    },
  };
}

async function shieldStatus({ paths, io, runLaunchctl }) {
  const service = await inspectShieldService({ paths, io, runLaunchctl });
  try {
    const identity = await readShieldIdentity({ paths, io });
    if (!identity) return { state: service.loaded ? "degraded" : "stopped", service, identity: { present: false } };
    return { state: service.loaded ? "healthy" : "degraded", service, identity: { present: true } };
  } catch {
    return { state: "blocked", service, identity: { present: false, valid: false } };
  }
}

function parseLaunch(argv) {
  const laneIndex = argv.indexOf("--lane");
  const boundary = argv.indexOf("--");
  const lane = laneIndex >= 0 ? argv[laneIndex + 1] : undefined;
  if (laneIndex < 0 || !lane || boundary < 0 || boundary !== laneIndex + 2 || boundary === argv.length - 1 || (lane !== "subscription" && lane !== "managed")) {
    throw new Error("usage: shield launch --lane subscription|managed -- command [args...]");
  }
  return { lane, command: argv[boundary + 1], args: argv.slice(boundary + 2) };
}

function renderShieldHelp() {
  return `Commands:\n  shield install [--write]\n  shield start\n  shield stop\n  shield status\n  shield doctor\n  shield launch --lane subscription|managed -- command [args...]\n`;
}

function renderShieldResult(command, result = {}) {
  const lines = flatten(sanitize({ command, ...result }));
  return `${lines.length ? lines.join("\n") : `${command}: ok`}\n`;
}

function sanitize(value, key = "") {
  if (SENSITIVE_KEYS.has(key)) return undefined;
  if (Array.isArray(value)) return value.map((entry) => sanitize(entry, key));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).flatMap(([entryKey, entry]) => SENSITIVE_KEYS.has(entryKey) ? [] : [[entryKey, sanitize(entry, entryKey)]]));
  }
  return value;
}

function flatten(value, prefix = "") {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return Object.entries(value).flatMap(([key, entry]) => flatten(entry, `${prefix}${key}.`));
  }
  return [`${prefix.slice(0, -1)}: ${String(value)}`];
}
