import * as nodeFs from "node:fs";
import { basename, dirname, join } from "node:path";

import { ccrOnlyModelReason, globalSettingsPath } from "./global-model-guard.mjs";

// Claude Code persists a `/model` "set as default" pick into the shared
// settings.json, and inside airclaude that pick is an opaque CCR route id that
// plain `claude` and `claude-sub` cannot use. There is no hook for the save
// itself, so the launcher watches the file for the life of the session and
// puts back only the top-level `model` key whenever it turns CCR-only.

const ABSENT = Symbol("absent");
const DEFAULT_DEBOUNCE_MS = 200;
const DEFAULT_POLL_MS = 2_000;

// stat follows the link, so a rename onto the target changes ino/mtime/size.
function statKey(fs, path) {
  try {
    const s = fs.statSync(path);
    return `${s.ino}:${s.mtimeMs}:${s.size}`;
  } catch {
    return "missing";
  }
}

export function startGlobalModelWatch({
  env = process.env,
  ccrOnlyIds = [],
  fs = nodeFs,
  debounceMs = DEFAULT_DEBOUNCE_MS,
  watch = true,
  pollMs = DEFAULT_POLL_MS,
} = {}) {
  const path = globalSettingsPath(env);
  if (!path) return null;

  // The value to restore is the last legitimate one seen, not just the one at
  // launch: a change made meanwhile from plain claude or another airclaude
  // session must survive. A CCR-only value at launch gives no baseline.
  const initial = readModel(fs, resolveTarget(fs, path));
  let baseline = initial === undefined || initial === ABSENT ? initial
    : ccrOnlyModelReason(initial.model, ccrOnlyIds) ? undefined
    : initial.model;
  const restored = [];
  const watchers = [];
  let timer = null;
  let poller = null;
  let stopped = false;

  const check = () => {
    if (stopped) return;
    const outcome = restoreIfLeaked(fs, path, baseline, ccrOnlyIds);
    if (outcome.legit !== undefined) baseline = outcome.legit;
    if (outcome.restored) restored.push(outcome.restored);
  };

  const schedule = () => {
    if (stopped) return;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      try { check(); } catch {}
    }, debounceMs);
    timer.unref?.();
  };

  if (watch) {
    // Writers replace the file by rename, which ends a watch on the file
    // itself, so watch the directory: the link's and the target's.
    for (const target of watchTargets(fs, path)) {
      try {
        const watcher = fs.watch(target.dir, { persistent: false }, (_event, name) => {
          if (name == null || String(name) === target.name) schedule();
        });
        watcher.on?.("error", () => {});
        watchers.push(watcher);
      } catch {}
    }
    // FSEvents can drop or badly delay events right after a watch starts or
    // under load, so a cheap stat poll backs the watch up.
    if (pollMs > 0) {
      let last = statKey(fs, path);
      poller = setInterval(() => {
        const next = statKey(fs, path);
        if (next !== last) {
          last = next;
          schedule();
        }
      }, pollMs);
      poller.unref?.();
    }
  }

  const stop = () => {
    if (!stopped) {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      if (poller !== null) clearInterval(poller);
      poller = null;
      for (const watcher of watchers) {
        try { watcher.close(); } catch {}
      }
      try { check(); } catch {}
      stopped = true;
    }
    return { path, restored: [...restored] };
  };

  return { path, check, stop };
}

export function globalModelRestoreNotice({ path, restored }) {
  if (!restored?.length) return "";
  const last = restored.at(-1);
  const kept = last.to === null ? "left \"model\" unset" : `kept "model": "${last.to}"`;
  return `airkit: the /model default "${last.from}" is a CCR route only airclaude can serve, so it was kept out of ${path} (${kept}); inside airclaude the choice still applies to the current session.\n`;
}

// Restores on SIGINT/SIGTERM too, then lets the signal do what it would have
// done: re-raised once the handlers are gone, so the exit behaviour is unchanged.
export function withSignalRestore(watcher, proc = process) {
  if (!watcher) return () => {};
  const handlers = {};
  const detach = () => {
    for (const [signal, handler] of Object.entries(handlers)) proc.removeListener(signal, handler);
  };
  for (const signal of ["SIGINT", "SIGTERM"]) {
    handlers[signal] = () => {
      const result = watcher.stop();
      detach();
      try { proc.stderr?.write?.(globalModelRestoreNotice(result)); } catch {}
      proc.kill(proc.pid, signal);
    };
    proc.on(signal, handlers[signal]);
  }
  return detach;
}

function watchTargets(fs, path) {
  const targets = [{ dir: dirname(path), name: basename(path) }];
  const real = resolveTarget(fs, path);
  if (real !== path) targets.push({ dir: dirname(real), name: basename(real) });
  return targets.filter((target) => {
    try { return fs.statSync(target.dir).isDirectory(); } catch { return false; }
  });
}

function resolveTarget(fs, path) {
  try {
    return fs.realpathSync(path);
  } catch {
    // A dangling link still names the file a writer would create.
    try {
      const link = fs.readlinkSync(path);
      return link.startsWith("/") ? link : join(dirname(path), link);
    } catch {
      return path;
    }
  }
}

// undefined: unreadable or not an object, so nothing is known. ABSENT: no
// usable top-level model.
function readModel(fs, path) {
  const parsed = readSettings(fs, path);
  if (!parsed) return undefined;
  return modelOf(parsed.settings);
}

function modelOf(settings) {
  return Object.hasOwn(settings, "model") && typeof settings.model === "string"
    ? { model: settings.model }
    : ABSENT;
}

function readSettings(fs, path) {
  let text;
  try {
    text = fs.readFileSync(path, "utf8");
  } catch (error) {
    return error?.code === "ENOENT" ? { text: null, settings: {} } : null;
  }
  try {
    const settings = JSON.parse(text);
    if (!settings || typeof settings !== "object" || Array.isArray(settings)) return null;
    return { text, settings };
  } catch {
    // Mid-write or hand-edited; the next change event re-checks.
    return null;
  }
}

function restoreIfLeaked(fs, path, baseline, ccrOnlyIds) {
  const target = resolveTarget(fs, path);
  const before = readSettings(fs, target);
  if (!before || before.text === null) return {};
  const current = modelOf(before.settings);
  if (current === ABSENT) return { legit: ABSENT };
  if (!ccrOnlyModelReason(current.model, ccrOnlyIds)) return { legit: current.model };
  if (baseline === undefined) return {};

  const settings = { ...before.settings };
  if (baseline === ABSENT) delete settings.model;
  else settings.model = baseline;
  const text = formatLike(before.text, settings);

  const mode = fs.statSync(target).mode & 0o7777;
  const temp = join(dirname(target), `.${basename(target)}.airkit-${process.pid}-${Date.now()}.tmp`);
  fs.writeFileSync(temp, text, { mode, flag: "wx" });
  try {
    fs.chmodSync(temp, mode);
    // Claude Code may have written since the read above; never replace a
    // newer file, whatever it says. The next change event decides again.
    if (fs.readFileSync(target, "utf8") !== before.text) {
      fs.unlinkSync(temp);
      return {};
    }
    fs.renameSync(temp, target);
  } catch (error) {
    try { fs.unlinkSync(temp); } catch {}
    throw error;
  }
  return { restored: { from: current.model, to: baseline === ABSENT ? null : baseline } };
}

// Keep the file's indentation, line endings and trailing newline. Key order is
// preserved because the object is edited in place.
function formatLike(original, settings) {
  const indent = /\n([ \t]+)"/.exec(original)?.[1] ?? (original.includes("\n") ? 2 : 0);
  const eol = original.includes("\r\n") ? "\r\n" : "\n";
  let text = JSON.stringify(settings, null, indent);
  if (eol === "\r\n") text = text.replace(/\n/g, "\r\n");
  return /\r?\n$/.test(original) ? text + eol : text;
}
