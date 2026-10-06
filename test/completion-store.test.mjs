import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { createCompletionStore } from '../src/completion/store.mjs';
import { createCompletionController } from '../src/completion/controller.mjs';

const key = { sessionId: 'session1', workspaceId: 'workspace1', requestId: 'request1', generation: 1 };
const options = () => ({ deadline: Date.now() + 1000 });
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForEvent(promise, name) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out waiting for ${name}`)), 1000);
    })]);
  } finally { clearTimeout(timer); }
}

function ledger(requestKey = key) {
  return { key: { ...requestKey }, nativeEventId: 'event1', seenNativeEventIds: ['event1'],
    enabled: false, mode: 'shadow', coverage: 'unknown', modelFamily: 'unknown',
    cancelled: false, awaitingAuthority: false, safeWorkRemaining: false, executionTask: false,
    checkpointPresent: false, stopHookActive: false, upstreamError: null,
    items: [], receipts: [], revision: 'unknown', validity: { status: 'valid' },
    budget: { used: 0, remaining: 2, firstInterventionAt: null, lastProgressDigest: null, unknownReconciled: false } };
}

function fixture(t, extra = {}) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'airkit-completion-store-'));
  const root = path.join(parent, 'state');
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  return { parent, root, store: createCompletionStore({ root, ...extra }) };
}

async function initialize(store, requestKey = key, change = () => {}) {
  return store.transaction(requestKey, (state) => { Object.assign(state, ledger(requestKey)); change(state); }, options());
}

function statePath(root) {
  return path.join(root, fs.readdirSync(root).find((name) => name.endsWith('.json')));
}

function child(script, args = []) {
  const process = spawn(globalThis.process.execPath, ['--input-type=module', '-e', script, ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = ''; let stderr = '';
  process.stdout.on('data', (data) => { stdout += data; });
  process.stderr.on('data', (data) => { stderr += data; });
  const done = new Promise((resolve, reject) => {
    process.on('error', reject);
    process.on('close', (code) => code === 0 ? resolve(stdout.trim()) : reject(new Error(stderr || `child exit ${code}`)));
  });
  return { process, done, output: () => stdout };
}

test('missing ledger initializes privately and survives store restart', async (t) => {
  const { root, store } = fixture(t);
  assert.equal((await store.read(key, options())).status, 'missing');
  assert.equal((await initialize(store)).status, 'ok');
  assert.equal(fs.statSync(root).mode & 0o777, 0o700);
  assert.equal(fs.statSync(statePath(root)).mode & 0o777, 0o600);
  assert.deepEqual((await createCompletionStore({ root }).read(key, options())).state, ledger());
});

test('session locator reads current generation and stale CAS never rewrites it', async (t) => {
  const { store } = fixture(t);
  await initialize(store);
  const next = { ...key, requestId: 'request2', generation: 2 };
  assert.equal((await store.transaction(key, (state) => { Object.assign(state, ledger(next)); }, options())).status, 'ok');
  let invoked = false;
  assert.equal((await store.transaction(key, () => { invoked = true; }, options())).status, 'stale');
  assert.equal(invoked, false);
  assert.equal((await store.read(key, options())).status, 'stale');
  assert.deepEqual((await store.read({ sessionId: key.sessionId, workspaceId: key.workspaceId }, options())).state.key, next);
});

test('eight simultaneous continuation transactions send once and preserve budget after process restart', async (t) => {
  const { root, store } = fixture(t);
  await initialize(store);
  const results = await Promise.all(Array.from({ length: 8 }, () => store.transaction(key, (state) => {
    if (state.budget.used) return { send: false };
    Object.assign(state.budget, { used: 1, remaining: 1, firstInterventionAt: Date.now(), lastProgressDigest: 'digest1' });
    return { send: true };
  }, options())));
  assert.equal(results.filter((result) => result.result?.send).length, 1);
  const moduleUrl = pathToFileURL(path.resolve('src/completion/store.mjs')).href;
  const restarted = child(`import { createCompletionStore } from ${JSON.stringify(moduleUrl)};
    const store = createCompletionStore({root:process.argv[1]});
    console.log(JSON.stringify(await store.read(JSON.parse(process.argv[2]), {deadline:Date.now()+1000})));`, [root, JSON.stringify(key)]);
  assert.equal(JSON.parse(await restarted.done).state.budget.used, 1);
  assert.equal((await store.transaction(key, (state) => { state.budget = ledger().budget; }, options())).status, 'degraded');
});

test('symlink root and state are refused without touching their targets', async (t) => {
  const { parent, root, store } = fixture(t);
  const target = path.join(parent, 'target');
  fs.mkdirSync(target, { mode: 0o700 });
  fs.symlinkSync(target, root);
  assert.equal((await initialize(store)).status, 'degraded');
  assert.deepEqual(fs.readdirSync(target), []);
  fs.unlinkSync(root);
  await initialize(store);
  const file = statePath(root);
  const targetFile = path.join(target, 'untouched');
  fs.writeFileSync(targetFile, 'private fixture');
  fs.unlinkSync(file); fs.symlinkSync(targetFile, file);
  assert.equal((await store.read(key, options())).status, 'degraded');
  assert.equal((await initialize(store)).status, 'degraded');
  assert.equal(fs.readFileSync(targetFile, 'utf8'), 'private fixture');
});

test('unsafe permissions, ownership and nonregular state are refused', async (t) => {
  const { root, store } = fixture(t);
  await initialize(store);
  fs.chmodSync(root, 0o755);
  assert.equal((await store.read(key, options())).status, 'degraded');
  fs.chmodSync(root, 0o700);
  const file = statePath(root);
  fs.chmodSync(file, 0o644);
  assert.equal((await store.read(key, options())).status, 'degraded');
  fs.chmodSync(file, 0o600);
  assert.equal((await createCompletionStore({ root, ownerUid: process.getuid() + 1 }).read(key, options())).status, 'degraded');
  fs.unlinkSync(file); fs.mkdirSync(file, { mode: 0o700 });
  assert.equal((await store.read(key, options())).status, 'degraded');
});

test('oversize bounded reads and invalid persisted schema degrade without rewrite', async (t) => {
  const { root, store } = fixture(t);
  await initialize(store);
  const file = statePath(root);
  for (const content of ['x'.repeat(65537), '{bad json', JSON.stringify({ version: 999, state: ledger() })]) {
    fs.writeFileSync(file, content);
    assert.equal((await store.read(key, options())).status, 'degraded');
    assert.equal((await initialize(store)).status, 'degraded');
    assert.equal(fs.readFileSync(file, 'utf8'), content);
  }
});

test('item, receipt, native event and serialized byte overflow preserve the prior ledger', async (t) => {
  const { store } = fixture(t);
  await initialize(store);
  const item = { itemId: 'item1', contractId: 'contract1', category: 'verification', source: 'accepted-plan',
    status: 'pending', mustFinish: true, requiredTargetIds: ['target1'], receiptIds: [], unresolvedTargetIds: ['target1'] };
  const receipt = { id: 'receipt1', executionId: 'execution1', itemId: 'item1', targetId: 'target1', revision: 'revision1',
    key, result: 'verified', startedAt: 1, endedAt: 2 };
  for (const mutate of [
    (state) => { state.items = Array.from({ length: 65 }, (_, i) => ({ ...item, itemId: `item${i}` })); },
    (state) => { state.receipts = Array.from({ length: 129 }, (_, i) => ({ ...receipt, id: `receipt${i}` })); },
    (state) => { state.seenNativeEventIds = Array.from({ length: 129 }, (_, i) => `event${i}`); },
    (state) => { state.items = Array.from({ length: 64 }, (_, i) => ({ ...item, itemId: `item${i}`,
      requiredTargetIds: Array.from({ length: 128 }, (_, j) => `target${j}_${'x'.repeat(100)}`), unresolvedTargetIds: [] })); },
  ]) {
    assert.equal((await store.transaction(key, mutate, options())).status, 'degraded');
    assert.deepEqual((await store.read(key, options())).state, ledger());
  }
});

test('allowlist preserves controller fields while stripping secret free text and snapshot metadata', async (t) => {
  const { root, store } = fixture(t);
  const secret = 'fixture-secret-not-for-disk';
  const initialized = await initialize(store, key, (state) => {
    state.items = [{ itemId: 'item1', contractId: 'contract1', category: 'verification', source: 'accepted-plan',
      status: 'pending', mustFinish: true, requiredTargetIds: ['target1'], receiptIds: [], unresolvedTargetIds: ['target1'], command: secret },
    { itemId: 'proposal1', ordinal: 1, category: 'report', source: 'model-proposed', status: 'pending', mustFinish: false,
      requiredTargetIds: [], receiptIds: [], proposal: { status: 'reported', receiptIds: [] }, prompt: secret }];
    state.route = { providerId: 'provider1', modelId: 'model1', url: secret };
    state.verifierCoverage = 'unknown';
    state.validity = { status: 'valid', now: Date.now(), progressDigest: 'transient', description: secret };
    state.rawOutput = secret;
  });
  assert.equal(initialized.status, 'ok');
  const saved = (await store.read(key, options())).state;
  assert.deepEqual(saved.items[0].unresolvedTargetIds, ['target1']);
  assert.deepEqual(saved.items[1].proposal, { status: 'reported', receiptIds: [] });
  assert.deepEqual(saved.route, { providerId: 'provider1', modelId: 'model1' });
  assert.deepEqual(saved.validity, { status: 'valid' });
  assert.equal(fs.readFileSync(statePath(root), 'utf8').includes(secret), false);
  assert.equal(fs.readFileSync(statePath(root), 'utf8').includes('transient'), false);
});

test('129th active session degrades instead of evicting or resetting any budget', async (t) => {
  const { root, store } = fixture(t);
  for (let i = 0; i < 128; i += 1) {
    assert.equal((await initialize(store, { ...key, sessionId: `session${i}` })).status, 'ok');
  }
  assert.equal((await initialize(store, { ...key, sessionId: 'session128' })).status, 'degraded');
  assert.equal(fs.readdirSync(root).filter((name) => name.endsWith('.json')).length, 128);
  assert.equal((await store.read({ ...key, sessionId: 'session0' }, options())).status, 'ok');
});

test('prune removes only owned versioned inactive entries at seven days', async (t) => {
  let now = 1000;
  const { root, store } = fixture(t, { clock: () => now });
  const active = { ...key, sessionId: 'active' };
  await initialize(store); await initialize(store, active);
  const other = path.join(root, 'other-plugin.json');
  fs.writeFileSync(other, 'untouched');
  now += 7 * 24 * 60 * 60 * 1000 - 1;
  await store.prune({ now, activeKeys: [active] });
  assert.equal((await store.read(key, { deadline: now + 1000 })).status, 'ok');
  now += 1;
  await store.prune({ now, activeKeys: [active] });
  assert.equal((await store.read(key, { deadline: now + 1000 })).status, 'missing');
  assert.equal((await store.read(active, { deadline: now + 1000 })).status, 'ok');
  assert.equal(fs.readFileSync(other, 'utf8'), 'untouched');
});

test('expired or aborted shared deadlines never invoke a mutating callback', async (t) => {
  const { store } = fixture(t);
  await initialize(store);
  let called = false;
  const abort = new AbortController(); abort.abort();
  for (const extra of [{ deadline: Date.now() - 1 }, { deadline: Date.now() + 1000, signal: abort.signal }]) {
    assert.equal((await store.transaction(key, () => { called = true; }, extra)).status, 'deadline');
  }
  assert.equal(called, false);
  assert.deepEqual((await store.read(key, options())).state, ledger());
});

test('deadline releases owned lock and a delayed callback cannot overwrite a new generation', async (t) => {
  let now = Date.now();
  // Hold the test clock during setup; the store still owns its real 30 ms callback timer.
  const { root, store } = fixture(t, { clock: () => now });
  assert.equal((await initialize(store)).status, 'ok');
  const entered = Promise.withResolvers();
  const gate = Promise.withResolvers();
  const exited = Promise.withResolvers();
  t.after(() => gate.resolve());
  const pending = store.transaction(key, async (state) => {
    entered.resolve();
    await gate.promise;
    state.cancelled = true;
    exited.resolve();
  }, { deadline: now + 30 });
  await waitForEvent(entered.promise, 'delayed callback entry');
  assert.equal(fs.existsSync(path.join(root, '.completion-v1.lock')), true);
  assert.deepEqual(await waitForEvent(pending, 'natural callback deadline'), { status: 'deadline', reason: 'deadline' });
  assert.equal(fs.existsSync(path.join(root, '.completion-v1.lock')), false);
  now += 30;
  const next = { ...key, generation: 2, requestId: 'request2' };
  assert.equal((await store.transaction(key, (state) => Object.assign(state, ledger(next)), { deadline: now + 1000 })).status, 'ok');
  const committed = fs.readFileSync(statePath(root), 'utf8');
  gate.resolve();
  await waitForEvent(exited.promise, 'expired callback mutation');
  assert.deepEqual((await store.read(next, { deadline: now + 1000 })).state, ledger(next));
  assert.equal(fs.readFileSync(statePath(root), 'utf8'), committed);
});

test('deadline during real state read never enters the callback and releases its owned lock', async (t) => {
  let now = Date.now();
  const { root, store } = fixture(t, { clock: () => now });
  assert.equal((await initialize(store)).status, 'ok');
  const file = statePath(root);
  const before = fs.readFileSync(file, 'utf8');
  const reading = Promise.withResolvers();
  const gate = Promise.withResolvers();
  t.after(() => gate.resolve());
  const open = fs.promises.open;
  t.mock.method(fs.promises, 'open', async (...args) => {
    const handle = await open(...args);
    if (args[0] === file) {
      const read = handle.read.bind(handle);
      handle.read = async (...readArgs) => {
        const result = await read(...readArgs);
        reading.resolve();
        await gate.promise;
        return result;
      };
    }
    return handle;
  });
  let invoked = false;
  const pending = store.transaction(key, () => { invoked = true; }, { deadline: now + 30 });
  await waitForEvent(reading.promise, 'real state read');
  assert.equal(fs.existsSync(path.join(root, '.completion-v1.lock')), true);
  now += 30;
  gate.resolve();
  assert.deepEqual(await waitForEvent(pending, 'deadline before callback entry'), { status: 'deadline', reason: 'deadline' });
  assert.equal(invoked, false);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.equal(fs.readdirSync(root).some((name) => name.endsWith('.lock') || name.endsWith('.tmp')), false);
});

test('two real processes contend on a lock and an ownerless lock is reclaimed only after it ages out', async (t) => {
  const { root, store } = fixture(t);
  await initialize(store);
  const moduleUrl = pathToFileURL(path.resolve('src/completion/store.mjs')).href;
  const holder = child(`import { createCompletionStore } from ${JSON.stringify(moduleUrl)};
    const store=createCompletionStore({root:process.argv[1]});
    console.log(JSON.stringify(await store.transaction(JSON.parse(process.argv[2]), async state => {
      console.log('locked'); await new Promise(resolve=>process.stdin.once('data',resolve)); state.checkpointPresent=true;
    }, {deadline:Date.now()+5000})));`, [root, JSON.stringify(key)]);
  t.after(() => holder.process.kill());
  while (!holder.output().includes('locked')) await Promise.race([delay(5), holder.done.then(() => { throw new Error('holder did not lock'); })]);
  const contender = child(`import { createCompletionStore } from ${JSON.stringify(moduleUrl)};
    console.log(JSON.stringify(await createCompletionStore({root:process.argv[1]}).transaction(JSON.parse(process.argv[2]), state=>{state.cancelled=true;}, {deadline:Date.now()+1000})));`, [root, JSON.stringify(key)]);
  assert.equal(JSON.parse(await contender.done).status, 'degraded');
  const lock = fs.readdirSync(root).find((name) => name.endsWith('.lock'));
  assert.ok(lock);
  holder.process.stdin.end('release');
  assert.equal(JSON.parse((await holder.done).split('\n').at(-1)).status, 'ok');
  const lockPath = path.join(root, lock);
  fs.writeFileSync(lockPath, 'unknown-lock', { mode: 0o600 });
  assert.deepEqual(await store.transaction(key, () => {}, options()), { status: 'degraded', reason: 'lock_busy' });
  assert.equal(fs.readFileSync(lockPath, 'utf8'), 'unknown-lock');
  fs.utimesSync(lockPath, new Date(0), new Date(0));
  assert.equal((await store.transaction(key, () => {}, options())).status, 'ok');
  assert.equal(fs.existsSync(lockPath), false);
});

const lockFile = (root) => path.join(root, '.completion-v1.lock');
const writeLock = (root, owner) => fs.writeFileSync(lockFile(root), JSON.stringify(owner), { mode: 0o600 });

async function deadPid() {
  const exited = child('');
  const { pid } = exited.process;
  await exited.done;
  return pid;
}

test('a held lock records its owner pid and creation time', async (t) => {
  const now = Date.now();
  const { root, store } = fixture(t, { clock: () => now });
  await initialize(store);
  let owner;
  await store.transaction(key, () => { owner = JSON.parse(fs.readFileSync(lockFile(root), 'utf8')); }, { deadline: now + 1000 });
  assert.deepEqual(owner, { pid: process.pid, createdAt: now });
});

test('a lock left by a dead owner is reclaimed by transaction and prune', async (t) => {
  const { root, store } = fixture(t);
  await initialize(store);
  const pid = await deadPid();
  writeLock(root, { pid, createdAt: Date.now() });
  assert.equal((await store.transaction(key, (state) => { state.cancelled = true; }, options())).status, 'ok');
  assert.equal((await store.read(key, options())).state.cancelled, true);
  writeLock(root, { pid, createdAt: Date.now() });
  assert.deepEqual(await store.prune(), { status: 'ok', removed: 0 });
  assert.deepEqual(fs.readdirSync(root).filter((name) => !name.endsWith('.json')), []);
});

test('a live owner keeps its lock until the age bound expires', async (t) => {
  let now = Date.now();
  const { root, store } = fixture(t, { clock: () => now });
  await initialize(store);
  const holder = child('await new Promise((resolve) => process.stdin.once("data", resolve));');
  t.after(() => { holder.process.stdin.end('release'); return holder.done; });
  writeLock(root, { pid: holder.process.pid, createdAt: now });
  assert.deepEqual(await store.transaction(key, () => {}, { deadline: now + 1000 }), { status: 'degraded', reason: 'lock_busy' });
  writeLock(root, { pid: process.pid, createdAt: now });
  assert.deepEqual(await store.prune({ now }), { status: 'degraded', reason: 'lock_busy' });
  assert.deepEqual(JSON.parse(fs.readFileSync(lockFile(root), 'utf8')), { pid: process.pid, createdAt: now });
  now += 10 * 60 * 1000;
  assert.equal((await store.transaction(key, () => {}, { deadline: now + 1000 })).status, 'ok');
  assert.equal(fs.existsSync(lockFile(root)), false);
});

test('unsafe locks are never followed or reclaimed even with a dead owner', async (t) => {
  const { parent, root, store } = fixture(t);
  await initialize(store);
  const pid = await deadPid();
  const outside = path.join(parent, 'outside-lock');
  fs.writeFileSync(outside, JSON.stringify({ pid, createdAt: 0 }), { mode: 0o600 });
  fs.symlinkSync(outside, lockFile(root));
  assert.equal((await store.transaction(key, () => {}, options())).status, 'degraded');
  assert.equal(fs.lstatSync(lockFile(root)).isSymbolicLink(), true);
  assert.equal(fs.existsSync(outside), true);
  fs.unlinkSync(lockFile(root));
  writeLock(root, { pid, createdAt: 0 });
  fs.chmodSync(lockFile(root), 0o644);
  assert.equal((await store.transaction(key, () => {}, options())).status, 'degraded');
  assert.equal(fs.existsSync(lockFile(root)), true);
});

test('reclaim that races a newer owner restores the newer lock instead of removing it', async (t) => {
  const { root, store } = fixture(t);
  await initialize(store);
  writeLock(root, { pid: await deadPid(), createdAt: Date.now() });
  const newer = JSON.stringify({ pid: process.pid, createdAt: Date.now() });
  const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (from, to) => {
    // Another contender reclaims the stale lock and creates its own between inspection and rename.
    if (from === lockFile(root)) { fs.unlinkSync(from); fs.writeFileSync(from, newer, { mode: 0o600 }); }
    return rename(from, to);
  });
  assert.deepEqual(await store.transaction(key, () => {}, options()), { status: 'degraded', reason: 'lock_busy' });
  assert.equal(fs.readFileSync(lockFile(root), 'utf8'), newer);
  assert.equal(fs.lstatSync(lockFile(root)).nlink, 1);
  assert.deepEqual(fs.readdirSync(root).filter((name) => !name.endsWith('.json')), ['.completion-v1.lock']);
});

test('actual controller recovers ledger after restart and preserves unresolved proof', async (t) => {
  const { root, store } = fixture(t);
  const acceptance = { contractId: 'contract1', category: 'verification', requiredTargetIds: ['target1'], mustFinish: true,
    targets: [{ id: 'target1', executable: 'fixture', argv: [], cwd: '/fixture', files: [], timeoutMs: 100, sideEffectFree: true }] };
  const dependencies = { acceptedContracts: new Set([acceptance]), verifier: { async run() { return {}; } },
    routeJoin: { async resolve() { return {}; } } };
  const controller = createCompletionController({ store, ...dependencies });
  const event = { kind: 'user', nativeEventId: 'event1', sessionId: key.sessionId, workspaceId: key.workspaceId };
  const begun = await controller.beginRequest(event);
  assert.equal(begun.status, 'ok');
  const task = await controller.registerTask(begun.requestId, acceptance);
  assert.equal((await controller.runVerification(begun.requestId, task.itemId, 'target1')).reason, 'verification_unknown');
  const restarted = createCompletionController({ store: createCompletionStore({ root }), ...dependencies });
  assert.equal((await restarted.beginRequest(event)).requestId, begun.requestId);
  assert.deepEqual((await restarted.snapshot(begun.requestId)).items[0].unresolvedTargetIds, ['target1']);
});

test('per-target revisions over different file sets survive a real store restart', async (t) => {
  const { root, store } = fixture(t);
  const target = { id: 'target1', executable: 'fixture', argv: [], cwd: '/fixture', files: ['a.mjs'], timeoutMs: 100, sideEffectFree: true };
  const acceptance = { contractId: 'contract1', category: 'verification', requiredTargetIds: ['target1', 'target2'], mustFinish: true,
    targets: [target, { ...target, id: 'target2', files: ['b.mjs'] }] };
  let execution = 0;
  const dependencies = { acceptedContracts: new Set([acceptance]), routeJoin: { async resolve() { return {}; } },
    verifier: { async run({ target: { id, files } }) {
      execution++;
      return { executionId: `execution${execution}`, receipt: { id: `receipt${execution}`, executionId: `execution${execution}`,
        targetId: id, revision: `digest-${files[0].replace('.', '_')}`, result: 'verified', startedAt: 1, endedAt: 2 } };
    } } };
  const controller = createCompletionController({ store, ...dependencies });
  const event = { kind: 'user', nativeEventId: 'event1', sessionId: key.sessionId, workspaceId: key.workspaceId };
  const begun = await controller.beginRequest(event);
  const task = await controller.registerTask(begun.requestId, acceptance);
  assert.equal((await controller.runVerification(begun.requestId, task.itemId, 'target1')).status, 'ok');
  assert.equal((await controller.runVerification(begun.requestId, task.itemId, 'target2')).status, 'ok');
  const restarted = createCompletionController({ store: createCompletionStore({ root }), ...dependencies });
  assert.equal((await restarted.beginRequest(event)).requestId, begun.requestId);
  const [item] = (await restarted.snapshot(begun.requestId)).items;
  assert.deepEqual(item.targetRevisions, { target1: 'digest-a_mjs', target2: 'digest-b_mjs' });
  assert.equal(item.status, 'verified');
});

test('per-target revisions are bounded to required targets and bounded IDs and paired with their observation', async (t) => {
  const { store } = fixture(t);
  const item = { itemId: 'item1', contractId: 'contract1', category: 'verification', source: 'accepted-plan',
    status: 'pending', mustFinish: true, requiredTargetIds: ['target1'], receiptIds: [] };
  await initialize(store, key, (state) => { state.items = [item]; });
  const prior = (await store.read(key, options())).state;
  const observed = { target1: 'observation1' };
  for (const [targetRevisions, targetObservedAt] of [[{ target2: 'revision1' }, { target2: 'observation1' }],
    [{ target1: 'not a bounded id' }, observed], [['revision1'], observed], ['target1', observed], [null, observed],
    [{ target1: 'revision1' }, undefined], [undefined, observed], [{ target1: 'revision1' }, { target1: 'not a bounded id' }]]) {
    assert.equal((await store.transaction(key, (state) => {
      state.items[0].targetRevisions = targetRevisions;
      state.items[0].targetObservedAt = targetObservedAt;
    }, options())).status, 'degraded');
    assert.deepEqual((await store.read(key, options())).state, prior);
  }
  assert.equal((await store.transaction(key, (state) => {
    state.items[0].targetRevisions = { target1: 'revision1' };
    state.items[0].targetObservedAt = observed;
  }, options())).status, 'ok');
  const stored = (await store.read(key, options())).state.items[0];
  assert.deepEqual([stored.targetRevisions, stored.targetObservedAt], [{ target1: 'revision1' }, observed]);
});

test('bounded real reads stop at 65537 bytes and accept a 65536-byte valid file', async (t) => {
  const { root, store } = fixture(t);
  await initialize(store);
  const file = statePath(root);
  const encoded = fs.readFileSync(file);
  fs.writeFileSync(file, Buffer.concat([encoded, Buffer.alloc(65536 - encoded.length, 32)]));
  assert.equal((await store.read(key, options())).status, 'ok');
  fs.appendFileSync(file, Buffer.alloc(1024 * 1024, 32));
  const open = fs.promises.open;
  let bytesRead = 0;
  t.mock.method(fs.promises, 'open', async function (...args) {
    const handle = await open(...args);
    const read = handle.read.bind(handle);
    handle.read = async (...readArgs) => {
      const result = await read(...readArgs);
      bytesRead += result.bytesRead;
      return result;
    };
    return handle;
  });
  assert.equal((await store.read(key, options())).status, 'degraded');
  assert.equal(bytesRead, 65537);
});

test('delayed real state I/O uses the original absolute deadline', async (t) => {
  const { root, store } = fixture(t);
  await initialize(store);
  const before = fs.readFileSync(statePath(root), 'utf8');
  const open = fs.promises.open;
  t.mock.method(fs.promises, 'open', async (...args) => {
    const handle = await open(...args);
    if (String(args[0]).endsWith('.json')) {
      const read = handle.read.bind(handle);
      handle.read = async (...readArgs) => { await delay(40); return read(...readArgs); };
    }
    return handle;
  });
  let invoked = false;
  assert.equal((await store.transaction(key, () => { invoked = true; }, { deadline: Date.now() + 20 })).status, 'deadline');
  assert.equal(invoked, false);
  assert.equal(fs.readFileSync(statePath(root), 'utf8'), before);
  assert.equal(fs.readdirSync(root).some((name) => name.endsWith('.lock') || name.endsWith('.tmp')), false);
});

test('abort during an actual delayed temp write never renames or leaves owned files', async (t) => {
  const { root, store } = fixture(t);
  await initialize(store);
  const before = fs.readFileSync(statePath(root), 'utf8');
  const open = fs.promises.open;
  let release; let entered;
  const writing = new Promise((resolve) => { entered = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  t.mock.method(fs.promises, 'open', async (...args) => {
    const handle = await open(...args);
    if (String(args[0]).endsWith('.tmp')) {
      const write = handle.write.bind(handle);
      handle.write = async (...writeArgs) => { entered(); await gate; return write(...writeArgs); };
    }
    return handle;
  });
  const abort = new AbortController();
  const pending = store.transaction(key, (state) => { state.cancelled = true; }, { ...options(), signal: abort.signal });
  await writing; abort.abort();
  assert.equal(fs.readFileSync(statePath(root), 'utf8'), before);
  release();
  assert.equal((await pending).status, 'deadline');
  await delay(20);
  assert.equal(fs.readFileSync(statePath(root), 'utf8'), before);
  assert.equal(fs.readdirSync(root).some((name) => name.endsWith('.lock') || name.endsWith('.tmp')), false);
});

test('final synchronous generation check rejects a replacement written during preparation', async (t) => {
  const { root, store } = fixture(t);
  await initialize(store);
  const file = statePath(root);
  const open = fs.promises.open;
  const next = { ...key, generation: 2, requestId: 'request2' };
  let replacement;
  t.mock.method(fs.promises, 'open', async (...args) => {
    const handle = await open(...args);
    if (String(args[0]).endsWith('.tmp')) {
      const write = handle.write.bind(handle);
      handle.write = async (...writeArgs) => {
        const result = await write(...writeArgs);
        const envelope = JSON.parse(fs.readFileSync(file, 'utf8'));
        envelope.state = ledger(next);
        replacement = JSON.stringify(envelope);
        fs.writeFileSync(file, replacement);
        return result;
      };
    }
    return handle;
  });
  assert.equal((await store.transaction(key, (state) => { state.cancelled = true; }, options())).status, 'stale');
  assert.equal(fs.readFileSync(file, 'utf8'), replacement);
});

test('deadline crossed inside final bounded read prevents rename', async (t) => {
  let now = 1000;
  const { root, store } = fixture(t, { clock: () => now });
  await initialize(store);
  const before = fs.readFileSync(statePath(root), 'utf8');
  const read = fs.readSync;
  t.mock.method(fs, 'readSync', (...args) => { const result = read(...args); now = 1100; return result; });
  assert.equal((await store.transaction(key, (state) => { state.cancelled = true; }, { deadline: 1050 })).status, 'deadline');
  assert.equal(fs.readFileSync(statePath(root), 'utf8'), before);
});

test('lost lock refuses commit and cleanup preserves its replacement', async (t) => {
  const { root, store } = fixture(t);
  await initialize(store);
  const before = fs.readFileSync(statePath(root), 'utf8');
  let replacement;
  const result = await store.transaction(key, (state) => {
    const lock = path.join(root, fs.readdirSync(root).find((name) => name.endsWith('.lock')));
    fs.renameSync(lock, `${lock}.old`);
    fs.writeFileSync(lock, 'replacement-lock', { mode: 0o600 });
    replacement = lock;
    state.cancelled = true;
  }, options());
  assert.equal(result.status, 'degraded');
  assert.equal(fs.readFileSync(statePath(root), 'utf8'), before);
  assert.equal(fs.readFileSync(replacement, 'utf8'), 'replacement-lock');
});

test('unsupported enums, free-text upstream errors and malformed proof subsets preserve ledger', async (t) => {
  const { store } = fixture(t);
  await initialize(store);
  for (const mutate of [
    (state) => { state.upstreamError = { message: 'fixture-secret-not-for-disk' }; },
    (state) => { state.coverage = 'healthy'; },
    (state) => { state.mode = 'automatic'; },
    (state) => { state.nativeEventId = 'unseen'; },
    (state) => { state.items = [{ itemId: 'item1', contractId: 'contract1', category: 'verification', source: 'accepted-plan',
      status: 'pending', mustFinish: true, requiredTargetIds: ['target1'], receiptIds: [], unresolvedTargetIds: ['different'] }]; },
  ]) {
    assert.equal((await store.transaction(key, mutate, options())).status, 'degraded');
    assert.deepEqual((await store.read(key, options())).state, ledger());
  }
  assert.equal((await store.transaction(key, (state) => { state.upstreamError = 'upstream_error'; }, options())).status, 'ok');
  assert.equal((await store.read(key, options())).state.upstreamError, 'upstream_error');
});

test('maximum item and receipt counts survive round trips without truncation', async (t) => {
  const { store } = fixture(t);
  const result = await initialize(store, key, (state) => {
    state.items = Array.from({ length: 64 }, (_, i) => ({ itemId: `item${i}`, contractId: `contract${i}`, category: 'verification',
      source: 'accepted-plan', status: 'pending', mustFinish: true, requiredTargetIds: ['target1'], receiptIds: [] }));
    state.receipts = Array.from({ length: 128 }, (_, i) => ({ id: `receipt${i}`, executionId: `execution${i}`, itemId: 'item0',
      targetId: 'target1', revision: 'revision1', key, result: 'verified', startedAt: 1, endedAt: 2 }));
    state.items[0].receiptIds = state.receipts.map((receipt) => receipt.id);
  });
  assert.equal(result.status, 'ok');
  const saved = (await store.read(key, options())).state;
  assert.equal(saved.items.length, 64);
  assert.equal(saved.receipts.length, 128);
  assert.equal(saved.items[0].receiptIds.length, 128);
});

test('sparse metadata arrays cannot serialize into a ledger that fails after restart', async (t) => {
  const { store } = fixture(t);
  await initialize(store);
  for (const mutate of [
    (state) => { state.items = Array(1); },
    (state) => { state.receipts = Array(1); },
    (state) => { state.seenNativeEventIds = ['event1', ...Array(1)]; },
    (state) => { state.items = [{ itemId: 'item1', contractId: 'contract1', category: 'verification', source: 'accepted-plan',
      status: 'pending', mustFinish: true, requiredTargetIds: Array(1), receiptIds: [] }]; },
  ]) {
    assert.equal((await store.transaction(key, mutate, options())).status, 'degraded');
    assert.deepEqual((await store.read(key, options())).state, ledger());
  }
});

test('stale crash debris is swept instead of filling the directory, while fresh debris and foreign files stay', async (t) => {
  const { root, store } = fixture(t);
  assert.equal((await initialize(store)).status, 'ok');
  const debris = (suffix) => path.join(root, `.completion-v1-${randomUUID()}.${suffix}`);
  const old = new Date(Date.now() - 10 * 60 * 1000);
  const stale = Array.from({ length: 1100 }, (_, index) => debris(index % 2 ? 'tmp' : 'reclaim'));
  for (const file of stale) { fs.writeFileSync(file, '', { mode: 0o600 }); fs.utimesSync(file, old, old); }
  const fresh = debris('tmp');
  fs.writeFileSync(fresh, '', { mode: 0o600 });
  const foreign = path.join(root, '.completion-v1-not-a-uuid.tmp');
  fs.writeFileSync(foreign, '', { mode: 0o600 });
  fs.utimesSync(foreign, old, old);
  const next = { ...key, sessionId: 'session2' };
  assert.equal((await initialize(store, next)).status, 'ok');
  assert.equal(stale.some((file) => fs.existsSync(file)), false);
  assert.equal(fs.existsSync(fresh), true);
  assert.equal(fs.existsSync(foreign), true);
});
