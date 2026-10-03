import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isBoundedId } from './checkpoint.mjs';

const unknown = () => ({ status: 'unknown' });
const text = (value) => typeof value === 'string' && value.length > 0 && !value.includes('\0');
const identity = (a, b) => a.dev === b.dev && a.ino === b.ino;
const unchanged = (a, b) => identity(a, b) && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
const observerEntry = fileURLToPath(import.meta.url);

function acceptedTarget(target) {
  if (!isBoundedId(target?.id) || !text(target.executable) || !text(target.cwd) || !path.isAbsolute(target.cwd)
    || !Array.isArray(target.argv) || !target.argv.every((arg) => typeof arg === 'string' && !arg.includes('\0'))
    || !Array.isArray(target.files) || target.files.length === 0 || target.files.length > 128
    || !target.files.every((file) => text(file) && !path.isAbsolute(file) && path.normalize(file) === file
      && file.split(path.sep).every((part) => part !== '..' && part !== '.'))
    || new Set(target.files).size !== target.files.length || target.sideEffectFree !== true
    || !Number.isFinite(target.timeoutMs) || target.timeoutMs <= 0 || target.timeoutMs > 2147483647) return null;
  return structuredClone(target);
}

function check(signal, deadline) {
  if (signal?.aborted || Date.now() >= deadline) throw new Error('observation_unavailable');
}

async function readRevision(target, signal, deadline) {
  check(signal, deadline);
  const root = await fs.promises.realpath(target.cwd);
  const rootInfo = await fs.promises.lstat(root);
  if (!rootInfo.isDirectory()) throw new Error('observation_unavailable');
  const hash = createHash('sha256');
  for (const token of [...target.files].sort()) {
    check(signal, deadline);
    const parents = [{ file: root, info: rootInfo }];
    const parts = token.split(path.sep);
    let file = root;
    let missing = false;
    for (let index = 0; index < parts.length; index++) {
      file = path.join(file, parts[index]);
      let info;
      try { info = await fs.promises.lstat(file); }
      catch (error) { if (error.code !== 'ENOENT') throw error; missing = true; break; }
      if (info.isSymbolicLink()) throw new Error('observation_unavailable');
      if (index < parts.length - 1) {
        if (!info.isDirectory()) throw new Error('observation_unavailable');
        parents.push({ file, info });
      } else if (!info.isFile()) throw new Error('observation_unavailable');
    }
    let digest = null;
    if (!missing) {
      const handle = await fs.promises.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      try {
        const before = await handle.stat();
        if (!before.isFile()) throw new Error('observation_unavailable');
        const content = createHash('sha256');
        const bytes = Buffer.alloc(65536);
        for (;;) {
          check(signal, deadline);
          const { bytesRead } = await handle.read(bytes, 0, bytes.length, null);
          if (!bytesRead) break;
          content.update(bytes.subarray(0, bytesRead));
        }
        const after = await handle.stat();
        const current = await fs.promises.lstat(file);
        if (!unchanged(before, after) || !unchanged(after, current) || current.isSymbolicLink()) throw new Error('observation_unavailable');
        digest = content.digest('hex');
      } finally { await handle.close(); }
    }
    for (const parent of parents) {
      const current = await fs.promises.lstat(parent.file);
      if (!current.isDirectory() || current.isSymbolicLink() || !identity(parent.info, current)) throw new Error('observation_unavailable');
    }
    check(signal, deadline);
    hash.update(JSON.stringify([token, missing ? 'missing' : 'file', digest]));
  }
  return hash.digest('hex');
}

async function revision(target, signal, deadline = Date.now() + target.timeoutMs) {
  check(signal, deadline);
  const observation = { cwd: target.cwd, files: target.files, deadline };
  if (Buffer.byteLength(JSON.stringify(observation)) > 65536) throw new Error('observation_unavailable');
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  delete env.NODE_PATH;
  delete env.NODE_V8_COVERAGE;
  const child = spawn(process.execPath, [observerEntry, '--completion-observer'],
    { shell: false, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env });
  let timer;
  let stopped = false;
  let failed = false;
  let observed;
  const stop = () => { stopped = true; child.kill('SIGKILL'); };
  try {
    const terminal = await new Promise((resolve) => {
      child.once('error', () => { failed = true; stop(); });
      child.once('close', (code, childSignal) => resolve({ code, childSignal }));
      child.once('disconnect', () => { if (!observed) stop(); });
      child.on('message', (message) => {
        if (observed || signal?.aborted || Date.now() >= deadline
          || message?.status !== 'ok' || Object.keys(message).length !== 2
          || typeof message.revision !== 'string' || !/^[a-f0-9]{64}$/.test(message.revision)) { stop(); return; }
        observed = message.revision;
      });
      signal?.addEventListener('abort', stop, { once: true });
      timer = setTimeout(stop, Math.max(0, deadline - Date.now()));
      if (signal?.aborted) stop();
      else child.send(observation, (error) => { if (error) { failed = true; stop(); } });
    });
    if (stopped || failed || terminal.code !== 0 || terminal.childSignal || !observed) throw new Error('observation_unavailable');
    check(signal, deadline);
    return observed;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', stop);
  }
}

// Only an explicitly launched IPC child enters observer mode; ordinary imports
// never install a message handler or read files.
if (process.argv[1] === observerEntry && process.argv[2] === '--completion-observer' && typeof process.send === 'function') {
  process.once('disconnect', () => process.exit(0));
  process.once('message', async (message) => {
    let result = unknown();
    try {
      if (!message || Object.keys(message).length !== 3 || Buffer.byteLength(JSON.stringify(message)) > 65536
        || !Number.isFinite(message.deadline) || message.deadline > Date.now() + 2147483647) throw new Error('observation_unavailable');
      const target = acceptedTarget({ id: 'observer', executable: process.execPath, argv: [], cwd: message.cwd,
        files: message.files, timeoutMs: 1, sideEffectFree: true });
      if (!target) throw new Error('observation_unavailable');
      result = { status: 'ok', revision: await readRevision(target, undefined, message.deadline) };
    } catch { /* The IPC response contains no source, path or raw error. */ }
    if (process.connected) process.send(result, () => { if (process.connected) process.disconnect(); });
  });
}

async function authorized(authorize, key, target, signal, deadline) {
  let timer;
  let onAbort;
  try {
    if (signal?.aborted) return false;
    return await Promise.race([
      Promise.resolve().then(() => authorize({ key: structuredClone(key), target: structuredClone(target) })),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(false), Math.max(0, deadline - Date.now()));
        onAbort = () => resolve(false);
        signal?.addEventListener('abort', onAbort, { once: true });
      }),
    ]) === true;
  } catch { return false; }
  finally {
    clearTimeout(timer);
    if (onAbort) signal?.removeEventListener('abort', onAbort);
  }
}

async function execute(target, signal, deadline) {
  let child;
  try { child = spawn(target.executable, target.argv, { cwd: target.cwd, shell: false, stdio: 'ignore' }); }
  catch { return { error: true }; }
  let timer;
  let force;
  let stopReason;
  let error = false;
  const stop = (reason) => {
    if (stopReason) return;
    stopReason = reason;
    child.kill('SIGTERM');
    force = setTimeout(() => child.kill('SIGKILL'), 100);
  };
  const onAbort = () => stop('cancelled');
  try {
    return await new Promise((resolve) => {
      child.once('error', () => { error = true; });
      child.once('close', (code, childSignal) => resolve({ code, childSignal, error, stopReason }));
      signal?.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(() => stop('timeout'), Math.max(0, deadline - Date.now()));
      if (signal?.aborted) onAbort();
    });
  } finally {
    clearTimeout(timer);
    clearTimeout(force);
    signal?.removeEventListener('abort', onAbort);
  }
}

/** Private accepted-contract producer. Point observations never certify ongoing coverage. */
export function createOwnedVerifier({ authorize, clock = Date.now } = {}) {
  if (typeof authorize !== 'function' || typeof clock !== 'function') throw new Error('invalid_verifier_options');

  async function observeRevision({ target, signal } = {}) {
    const accepted = acceptedTarget(target);
    const targetId = isBoundedId(target?.id) ? target.id : 'unknown';
    if (!accepted) return { targetId, revision: 'unknown', status: 'unknown' };
    try {
      return { targetId, revision: await revision(accepted, signal), status: 'ok' };
    } catch { return { targetId, revision: 'unknown', status: 'unknown' }; }
  }

  async function run({ key, target, signal } = {}) {
    const accepted = acceptedTarget(target);
    if (!accepted) return unknown();
    const deadline = Date.now() + accepted.timeoutMs;
    if (!await authorized(authorize, key, accepted, signal, deadline)) return unknown();
    let before;
    try { before = await revision(accepted, signal, deadline); }
    catch { return unknown(); }
    if (signal?.aborted) return unknown();
    const startedAt = clock();
    if (!Number.isFinite(startedAt)) return unknown();
    const executionId = randomUUID();
    const terminal = await execute(accepted, signal, deadline);
    let after;
    try { after = await revision(accepted, signal, deadline); } catch { /* An unreadable or cancelled observation cannot verify. */ }
    let result = 'failed';
    if (terminal.stopReason === 'cancelled' || signal?.aborted) result = 'cancelled';
    else if (terminal.error) result = 'unknown';
    else if (terminal.stopReason === 'timeout' || terminal.childSignal || terminal.code !== 0) result = 'failed';
    else if (!after) result = 'unknown';
    else result = before === after ? 'verified' : 'stale';
    const endedAt = clock();
    if (!Number.isFinite(endedAt)) return unknown();
    return { executionId, receipt: { id: randomUUID(), executionId, targetId: accepted.id,
      revision: before, result, startedAt, endedAt: Math.max(startedAt, endedAt) } };
  }

  return Object.freeze({ run, observeRevision });
}
