import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isBoundedId } from './checkpoint.mjs';

const unknown = () => ({ status: 'unknown' });
const text = (value) => typeof value === 'string' && value.length > 0 && !value.includes('\0');
const identity = (a, b) => a.dev === b.dev && a.ino === b.ino;
const unchanged = (a, b) => identity(a, b) && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;

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

async function revision(target, signal, deadline = Date.now() + target.timeoutMs) {
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
