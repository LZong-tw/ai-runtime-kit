import fs from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { isBoundedId, taskStatuses } from './checkpoint.mjs';
import { isValidSnapshot } from './evaluator.mjs';

const MAX_BYTES = 65536;
const TTL = 7 * 24 * 60 * 60 * 1000;
const STATE_NAME = /^completion-v1-[a-f0-9]{64}\.json$/;
const READ_FLAGS = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK;
const WRITE_FLAGS = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW;
const booleans = ['enabled', 'cancelled', 'awaitingAuthority', 'safeWorkRemaining', 'executionTask', 'checkpointPresent', 'stopHookActive'];
const fail = (reason) => { throw Object.assign(new Error(reason), { storeReason: reason }); };
const sameKey = (a, b) => a && b && ['sessionId', 'workspaceId', 'requestId', 'generation'].every((field) => a[field] === b[field]);
const sessionKey = (key) => key && isBoundedId(key.sessionId) && isBoundedId(key.workspaceId);
const fullKey = (key) => sessionKey(key) && isBoundedId(key.requestId) && Number.isSafeInteger(key.generation) && key.generation > 0;
const pickKey = ({ sessionId, workspaceId, requestId, generation }) => ({ sessionId, workspaceId, requestId, generation });
const nameFor = (key) => `completion-v1-${createHash('sha256').update(JSON.stringify([key.sessionId, key.workspaceId])).digest('hex')}.json`;

function ids(value) {
  return Array.isArray(value) && value.length <= 128 && [...value].every(isBoundedId) && new Set(value).size === value.length;
}

function normalize(state, now) {
  if (!state || !fullKey(state.key) || !isBoundedId(state.nativeEventId) || !ids(state.seenNativeEventIds)
    || !state.seenNativeEventIds.includes(state.nativeEventId) || !['disabled', 'shadow', 'enforce'].includes(state.mode)
    || !['unknown', 'verified'].includes(state.coverage) || !['unknown', 'gpt', 'claude', 'other'].includes(state.modelFamily)
    || ![null, 'upstream_error'].includes(state.upstreamError) || state.validity?.status !== 'valid'
    || !Array.isArray(state.items) || state.items.length > 64 || !Array.isArray(state.receipts) || state.receipts.length > 128) fail('state_invalid');
  const items = Array.from(state.items, (item) => {
    if (!item || (item.source !== 'model-proposed' && !isBoundedId(item.contractId))
      || !ids(item.requiredTargetIds) || !ids(item.receiptIds)
      || (item.unresolvedTargetIds !== undefined && !ids(item.unresolvedTargetIds))) fail('state_invalid');
    const normalized = { itemId: item.itemId, category: item.category, source: item.source, status: item.status,
      mustFinish: item.mustFinish, requiredTargetIds: item.requiredTargetIds, receiptIds: item.receiptIds };
    if (item.source !== 'model-proposed') normalized.contractId = item.contractId;
    if (item.ordinal !== undefined) {
      if (!Number.isInteger(item.ordinal) || item.ordinal < 1 || item.ordinal > 64) fail('state_invalid');
      normalized.ordinal = item.ordinal;
    }
    if (item.proposal !== undefined) {
      if (!taskStatuses.includes(item.proposal?.status) || !ids(item.proposal.receiptIds)) fail('state_invalid');
      normalized.proposal = { status: item.proposal.status, receiptIds: item.proposal.receiptIds };
    }
    if (item.unresolvedTargetIds !== undefined) normalized.unresolvedTargetIds = item.unresolvedTargetIds;
    return normalized;
  });
  const receipts = Array.from(state.receipts, (receipt) => {
    if (!fullKey(receipt?.key)) fail('state_invalid');
    return { id: receipt.id, executionId: receipt.executionId, itemId: receipt.itemId, targetId: receipt.targetId,
      revision: receipt.revision, result: receipt.result, startedAt: receipt.startedAt, endedAt: receipt.endedAt,
      key: pickKey(receipt.key) };
  });
  const budget = state.budget && { used: state.budget.used, remaining: state.budget.remaining,
    firstInterventionAt: state.budget.firstInterventionAt, lastProgressDigest: state.budget.lastProgressDigest,
    unknownReconciled: state.budget.unknownReconciled };
  const normalized = { key: pickKey(state.key), nativeEventId: state.nativeEventId, seenNativeEventIds: state.seenNativeEventIds,
    mode: state.mode, coverage: state.coverage, modelFamily: state.modelFamily, upstreamError: state.upstreamError,
    items, receipts, budget, revision: state.revision, validity: { status: 'valid' } };
  for (const field of booleans) normalized[field] = state[field];
  if (state.route !== undefined) {
    if (!isBoundedId(state.route?.providerId) || !isBoundedId(state.route?.modelId)) fail('state_invalid');
    normalized.route = { providerId: state.route.providerId, modelId: state.route.modelId };
  }
  if (state.verifierCoverage !== undefined) {
    if (!['verified', 'unknown'].includes(state.verifierCoverage)) fail('state_invalid');
    normalized.verifierCoverage = state.verifierCoverage;
  }
  if (!isValidSnapshot({ ...normalized, validity: { status: 'valid', now, progressDigest: 'store_validation' } })) fail('state_invalid');
  return structuredClone(normalized);
}

function decode(bytes, now) {
  if (bytes.length > MAX_BYTES) fail('state_oversize');
  let envelope;
  try { envelope = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { fail('state_invalid'); }
  if (envelope?.version !== 1 || !Number.isFinite(envelope.updatedAt) || envelope.updatedAt < 0
    || Object.keys(envelope).some((field) => !['version', 'updatedAt', 'state'].includes(field))) fail('state_invalid');
  return { updatedAt: envelope.updatedAt, state: normalize(envelope.state, now) };
}

/** One bounded ledger; an unknown lock always degrades instead of being reclaimed. */
export function createCompletionStore({ root, clock = Date.now, ownerUid = process.getuid() } = {}) {
  if (typeof root !== 'string' || !path.isAbsolute(root) || typeof clock !== 'function'
    || !Number.isInteger(ownerUid) || ownerUid < 0) throw new Error('invalid_store_options');
  const lockPath = path.join(root, '.completion-v1.lock');

  function check(options) {
    if (options.signal?.aborted || clock() >= options.deadline) fail('deadline');
  }

  function operationOptions(options = {}) {
    const deadline = options.deadline ?? clock() + 1000;
    if (!Number.isFinite(deadline) || (options.signal !== undefined && !(options.signal instanceof AbortSignal))) fail('invalid_options');
    return { signal: options.signal, deadline };
  }

  function rootInfo() {
    const info = fs.lstatSync(root);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== ownerUid || (info.mode & 0o777) !== 0o700) fail('unsafe_root');
    return info;
  }

  function verifyRoot(expected) {
    const current = rootInfo();
    if (current.dev !== expected.dev || current.ino !== expected.ino) fail('unsafe_root');
  }

  async function prepareRoot(options) {
    check(options);
    try { await fs.promises.mkdir(root, { mode: 0o700 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    check(options);
    return rootInfo();
  }

  function safeFile(info) {
    if (!info.isFile() || info.uid !== ownerUid || (info.mode & 0o777) !== 0o600 || info.nlink !== 1) fail('unsafe_state');
  }

  async function load(file, options, expectedRoot) {
    check(options); verifyRoot(expectedRoot);
    let handle;
    try {
      handle = await fs.promises.open(file, READ_FLAGS);
      check(options); verifyRoot(expectedRoot);
      safeFile(await handle.stat());
      const bytes = Buffer.alloc(MAX_BYTES + 1);
      let length = 0;
      while (length < bytes.length) {
        check(options);
        const { bytesRead } = await handle.read(bytes, length, bytes.length - length, null);
        if (!bytesRead) break;
        length += bytesRead;
      }
      check(options);
      return decode(bytes.subarray(0, length), clock());
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    } finally { if (handle) await handle.close(); }
  }

  function loadSync(file) {
    let fd;
    try {
      fd = fs.openSync(file, READ_FLAGS);
      safeFile(fs.fstatSync(fd));
      const bytes = Buffer.alloc(MAX_BYTES + 1);
      let length = 0;
      while (length < bytes.length) {
        const count = fs.readSync(fd, bytes, length, bytes.length - length, null);
        if (!count) break;
        length += count;
      }
      return decode(bytes.subarray(0, length), clock());
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    } finally { if (fd !== undefined) fs.closeSync(fd); }
  }

  function acquire(expectedRoot, options) {
    check(options); verifyRoot(expectedRoot);
    let fd;
    try {
      fd = fs.openSync(lockPath, WRITE_FLAGS, 0o600);
      const info = fs.fstatSync(fd);
      safeFile(info);
      return { fd, info };
    } catch (error) {
      if (fd !== undefined) fs.closeSync(fd);
      if (error.code === 'EEXIST') fail('lock_busy');
      throw error;
    }
  }

  function release(lock, expectedRoot) {
    try {
      verifyRoot(expectedRoot);
      const current = fs.lstatSync(lockPath);
      if (current.dev === lock.info.dev && current.ino === lock.info.ino && current.uid === ownerUid && current.isFile()) fs.unlinkSync(lockPath);
    } catch { /* An unknown or replaced lock is never removed. */ }
    fs.closeSync(lock.fd);
  }

  function verifyLock(lock) {
    const current = fs.lstatSync(lockPath);
    safeFile(current);
    if (current.dev !== lock.info.dev || current.ino !== lock.info.ino) fail('lock_lost');
  }

  function entries(options, expectedRoot) {
    check(options); verifyRoot(expectedRoot);
    const directory = fs.opendirSync(root);
    const names = [];
    let count = 0;
    try {
      let entry;
      while ((entry = directory.readSync())) {
        check(options);
        if (++count > 1024) fail('directory_capacity');
        if (STATE_NAME.test(entry.name)) names.push(entry.name);
        if (names.length > 128) fail('session_capacity');
      }
    } finally { directory.closeSync(); }
    return names;
  }

  function failure(error) {
    if (error?.completionInput) throw error;
    const reason = error?.storeReason ?? 'io_failure';
    return { status: reason === 'deadline' ? 'deadline' : reason === 'stale' ? 'stale' : 'degraded', reason };
  }

  async function read(key, inputOptions) {
    try {
      const options = operationOptions(inputOptions);
      check(options);
      if (!sessionKey(key) || ((key.requestId !== undefined || key.generation !== undefined) && !fullKey(key))) fail('invalid_key');
      const expectedRoot = await prepareRoot(options);
      const envelope = await load(path.join(root, nameFor(key)), options, expectedRoot);
      check(options); verifyRoot(expectedRoot);
      if (!envelope) return { status: 'missing' };
      if (nameFor(envelope.state.key) !== nameFor(key) || (fullKey(key) && !sameKey(envelope.state.key, key))) fail('stale');
      return { status: 'ok', state: envelope.state };
    } catch (error) { return failure(error); }
  }

  async function callback(fn, state, options) {
    let timer;
    let onAbort;
    try {
      return await Promise.race([
        Promise.resolve().then(() => { check(options); return fn(state); }),
        new Promise((_, reject) => {
          const expire = () => reject(Object.assign(new Error('deadline'), { storeReason: 'deadline' }));
          timer = setTimeout(expire, Math.min(2147483647, Math.max(0, options.deadline - clock())));
          onAbort = expire;
          options.signal?.addEventListener('abort', onAbort, { once: true });
        }),
      ]);
    } finally {
      clearTimeout(timer);
      if (onAbort) options.signal?.removeEventListener('abort', onAbort);
    }
  }

  async function transaction(key, fn, inputOptions) {
    let lock; let expectedRoot; let temp; let tempInfo;
    try {
      const options = operationOptions(inputOptions);
      check(options);
      if (!fullKey(key) || typeof fn !== 'function') fail('invalid_key');
      expectedRoot = await prepareRoot(options);
      lock = acquire(expectedRoot, options);
      const file = path.join(root, nameFor(key));
      const prior = await load(file, options, expectedRoot);
      if (prior && !sameKey(prior.state.key, key)) fail('stale');
      if (!prior && key.generation !== 1) fail('stale');
      if (!prior && entries(options, expectedRoot).length >= 128) fail('session_capacity');
      const mutable = structuredClone(prior?.state ?? {});
      const result = await callback(fn, mutable, options);
      check(options); verifyRoot(expectedRoot);
      const state = normalize(mutable, clock());
      if (nameFor(state.key) !== nameFor(key)) fail('stale');
      if (!prior && !sameKey(state.key, key)) fail('stale');
      if (prior && !sameKey(state.key, key)
        && (state.key.generation !== key.generation + 1 || state.key.requestId === key.requestId)) fail('stale');
      if (prior && sameKey(state.key, key) && (state.budget.used < prior.state.budget.used
        || (prior.state.budget.used > 0 && state.budget.firstInterventionAt !== prior.state.budget.firstInterventionAt)
        || (prior.state.budget.unknownReconciled && !state.budget.unknownReconciled))) fail('budget_regression');
      const bytes = Buffer.from(JSON.stringify({ version: 1, updatedAt: clock(), state }));
      if (bytes.length > MAX_BYTES || Buffer.byteLength(JSON.stringify({ status: 'ok', state, result })) > MAX_BYTES) fail('state_oversize');
      temp = path.join(root, `.completion-v1-${randomUUID()}.tmp`);
      const handle = await fs.promises.open(temp, WRITE_FLAGS, 0o600);
      try {
        tempInfo = await handle.stat();
        safeFile(tempInfo);
        let written = 0;
        while (written < bytes.length) {
          check(options); verifyRoot(expectedRoot);
          const { bytesWritten } = await handle.write(bytes, written, bytes.length - written, null);
          if (bytesWritten <= 0) fail('io_failure');
          written += bytesWritten;
        }
      } finally { await handle.close(); }
      // No await from the final CAS through rename: cancellation cannot race a queued commit.
      check(options); verifyRoot(expectedRoot);
      const current = loadSync(file);
      if (prior ? !sameKey(current?.state.key, prior.state.key) : current !== null) fail('stale');
      verifyRoot(expectedRoot); verifyLock(lock);
      const prepared = fs.lstatSync(temp);
      safeFile(prepared);
      if (prepared.dev !== tempInfo.dev || prepared.ino !== tempInfo.ino) fail('unsafe_state');
      check(options);
      fs.renameSync(temp, file);
      temp = undefined;
      return { status: 'ok', state, result };
    } catch (error) { return failure(error); }
    finally {
      if (temp && expectedRoot) {
        try {
          verifyRoot(expectedRoot);
          const current = fs.lstatSync(temp);
          if (tempInfo && current.dev === tempInfo.dev && current.ino === tempInfo.ino && current.uid === ownerUid && current.isFile()) fs.unlinkSync(temp);
        } catch { /* Never remove a replaced temporary file. */ }
      }
      if (lock) release(lock, expectedRoot);
    }
  }

  async function prune({ now = clock(), activeKeys = [] } = {}) {
    let lock; let expectedRoot;
    try {
      if (!Number.isFinite(now) || !Array.isArray(activeKeys) || activeKeys.length > 128 || !activeKeys.every(sessionKey)) fail('invalid_options');
      const options = operationOptions();
      expectedRoot = await prepareRoot(options);
      lock = acquire(expectedRoot, options);
      const active = new Set(activeKeys.map(nameFor));
      let removed = 0;
      for (const name of entries(options, expectedRoot)) {
        if (active.has(name)) continue;
        const file = path.join(root, name);
        const envelope = await load(file, options, expectedRoot);
        if (!envelope || nameFor(envelope.state.key) !== name || now - envelope.updatedAt < TTL) continue;
        check(options); verifyRoot(expectedRoot);
        const current = loadSync(file);
        if (!current || !sameKey(current.state.key, envelope.state.key) || current.updatedAt !== envelope.updatedAt) fail('stale');
        verifyRoot(expectedRoot); verifyLock(lock);
        check(options);
        fs.unlinkSync(file);
        removed += 1;
      }
      return { status: 'ok', removed };
    } catch (error) { return failure(error); }
    finally { if (lock) release(lock, expectedRoot); }
  }

  return Object.freeze({ transaction, read, prune });
}
