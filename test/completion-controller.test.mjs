import assert from 'node:assert/strict';
import test from 'node:test';
import { createCompletionController } from '../src/completion/controller.mjs';
import { evaluateCompletion, hasVerifiedTargets } from '../src/completion/evaluator.mjs';
import { parseCheckpoint } from '../src/completion/checkpoint.mjs';
import { applyCheckpoint, progressDigest } from '../src/completion/state-operations.mjs';
import { verifierDeadlineMs } from '../src/completion/verifier.mjs';

// A session-serialized, generation-checked store double. Native event and
// verifier fixtures exercise private composition, not real host provenance.
function memoryStore() {
  const states = new Map();
  let tail = Promise.resolve();
  const session = (key) => JSON.stringify([key.sessionId, key.workspaceId]);
  const matches = (state, key) => !key.requestId || (state?.key.requestId === key.requestId && state.key.generation === key.generation);
  return {
    async read(key, { signal, deadline }) {
      assert.ok(signal instanceof AbortSignal);
      assert.ok(Number.isFinite(deadline));
      if (signal.aborted || Date.now() >= deadline) return { status: 'unknown' };
      const state = states.get(session(key));
      if (!state) return { status: 'missing' };
      return matches(state, key) ? { status: 'ok', state: structuredClone(state) } : { status: 'stale' };
    },
    transaction(key, fn, { signal, deadline }) {
      const operation = tail.then(async () => {
        if (signal.aborted || Date.now() >= deadline) return { status: 'unknown' };
        const prior = states.get(session(key));
        if (prior && !matches(prior, key)) return { status: 'stale' };
        const state = structuredClone(prior ?? {});
        const result = await fn(state);
        if (signal.aborted || Date.now() >= deadline) return { status: 'unknown' };
        states.set(session(key), structuredClone(state));
        return { status: 'ok', state: structuredClone(state), result };
      });
      tail = operation.catch(() => {});
      return operation;
    },
  };
}

function fixture(overrides = {}) {
  const target = Object.freeze({ id: 't1', executable: 'fixture', argv: [], cwd: '/fixture',
    files: ['fixture.mjs'], timeoutMs: 100, sideEffectFree: true });
  const acceptance = Object.freeze({ contractId: 'c1', category: 'verification', requiredTargetIds: ['t1'],
    mustFinish: true, targets: [target], automationScope: 'accepted_fixture' });
  const store = memoryStore();
  const dependencies = { store, acceptedContracts: new Set([acceptance]),
    verifier: { async run() { return { executionId: 'e1', receipt: {
      id: 'receipt1', executionId: 'e1', targetId: 't1', revision: 'revision1',
      result: 'verified', startedAt: 1, endedAt: 2,
    } }; } },
    routeJoin: { async resolve(observation, key) { return { status: 'ok', key,
      providerId: 'fixture-provider', modelId: 'gpt-6', modelFamily: 'gpt' }; } },
    ...overrides,
  };
  return { store, acceptance, dependencies, controller: createCompletionController(dependencies) };
}

const event = (nativeEventId = 'event1') => ({ kind: 'user', nativeEventId, sessionId: 's1', workspaceId: 'w1' });

const storeOptions = () => ({ signal: new AbortController().signal, deadline: Date.now() + 1000 });
const parsed = (checkpoint) => parseCheckpoint(Buffer.from(JSON.stringify(checkpoint)));

test('shared checkpoint operation creates host IDs, replays identity and returns detached task projections', () => {
  const state = { key: { sessionId: 's1', workspaceId: 'w1', requestId: 'r1', generation: 1 },
    checkpointPresent: false, items: [], receipts: [] };
  const checkpoint = parsed({ version: 1, kind: 'declare', items: [{ ordinal: 1, category: 'report' }] });
  let issued = 0;
  const options = { createItemId: () => `host${++issued}` };
  const result = applyCheckpoint(state, checkpoint, options);
  assert.deepEqual(state.items, [{ itemId: 'host1', ordinal: 1, category: 'report', source: 'model-proposed',
    status: 'pending', mustFinish: false, requiredTargetIds: [], receiptIds: [] }]);
  assert.deepEqual(result, { status: 'ok', items: [{ itemId: 'host1', category: 'report', requiredTargetIds: [], mustFinish: false }] });
  assert.equal(state.checkpointPresent, true);
  assert.deepEqual(applyCheckpoint(state, checkpoint, options), result);
  assert.equal(issued, 1);
  result.items[0].requiredTargetIds.push('untrusted-target');
  assert.deepEqual(state.items[0].requiredTargetIds, []);
  applyCheckpoint(state, parsed({ version: 1, kind: 'update', items: [{ itemId: 'host1', status: 'verified', receiptIds: [] }] }), options);
  assert.deepEqual(state.items[0].proposal, { status: 'verified', receiptIds: [] });
  assert.equal(state.items[0].status, 'pending');
  assert.deepEqual(state.items[0].receiptIds, []);
});

test('shared digest preserves literal SHA256 projection bytes and undefined field omission', () => {
  const state = { revision: 'rev1', items: [{ itemId: 'host1', status: 'pending', source: 'accepted-plan',
    requiredTargetIds: ['target1'], receiptIds: [], category: 'implementation', mustFinish: true }], receipts: [] };
  assert.equal(progressDigest(state), '596d631c512ade08d5fee959f0bb8dd750c0ecfce5311b6b211a2bd7a06b8790');
  state.items[0].proposal = { status: 'verified', receiptIds: ['claimed'] };
  state.items.push({ itemId: 'proposal1', source: 'model-proposed', status: 'verified' });
  assert.equal(progressDigest(state), '596d631c512ade08d5fee959f0bb8dd750c0ecfce5311b6b211a2bd7a06b8790');
  state.items[0].unresolvedTargetIds = [];
  assert.equal(progressDigest(state), 'e69df10b77e9331d1972a9e605b47c0bde870e953eae49be048968a9ff077bbc');
});

test('controller declaration replay preserves identity and conflict rolls back earlier entries', async () => {
  const { controller, store } = fixture();
  const { requestId, key } = await controller.beginRequest(event());
  const declaration = { version: 1, kind: 'declare', items: [{ ordinal: 1, category: 'report' }] };
  const first = await controller.declareTask(requestId, declaration);
  assert.deepEqual(await controller.declareTask(requestId, declaration), first);
  await store.transaction(key, (state) => { state.checkpointPresent = false; }, storeOptions());
  const before = (await store.read(key, storeOptions())).state;
  await assert.rejects(controller.declareTask(requestId, { version: 1, kind: 'declare', items: [
    { ordinal: 2, category: 'verification' }, { ordinal: 1, category: 'implementation' },
  ] }), (error) => error.message === 'conflicting_declaration' && error.completionInput === true);
  assert.deepEqual((await store.read(key, storeOptions())).state, before);
});

test('controller capacity failure rolls back partial declarations and retains dependency classification', async () => {
  const { controller, store } = fixture();
  const { requestId, key } = await controller.beginRequest(event());
  await store.transaction(key, (state) => {
    state.items = Array.from({ length: 63 }, (_, i) => ({ itemId: `accepted${i}`, contractId: `contract${i}`,
      category: 'implementation', source: 'accepted-plan', status: 'pending', mustFinish: true, requiredTargetIds: [], receiptIds: [] }));
  }, storeOptions());
  const before = (await store.read(key, storeOptions())).state;
  let ownedError;
  const transaction = store.transaction;
  store.transaction = (transactionKey, fn, options) => transaction(transactionKey, (state) => {
    try { return fn(state); } catch (error) { ownedError = error; throw error; }
  }, options);
  assert.deepEqual(await controller.declareTask(requestId, { version: 1, kind: 'declare', items: [
    { ordinal: 1, category: 'report' }, { ordinal: 2, category: 'verification' },
  ] }), { status: 'unknown', reason: 'unknown' });
  assert.equal(ownedError.completionReason, 'item_capacity');
  assert.equal(ownedError.completionInput, undefined);
  assert.deepEqual((await store.read(key, storeOptions())).state, before);
});

test('controller receipt updates require the same item and every RequestKey field without granting authority', async () => {
  const { controller, store, acceptance } = fixture();
  const { requestId, key } = await controller.beginRequest(event());
  const task = await controller.registerTask(requestId, acceptance);
  const declared = await controller.declareTask(requestId, { version: 1, kind: 'declare', items: [{ ordinal: 1, category: 'report' }] });
  await controller.runVerification(requestId, task.itemId, 't1');
  const verified = await controller.snapshot(requestId);
  for (const status of ['verified', 'blocked', 'cancelled']) {
    await controller.declareTask(requestId, { version: 1, kind: 'update', items: [{ itemId: task.itemId, status, receiptIds: ['receipt1'] }] });
    const snapshot = await controller.snapshot(requestId);
    assert.equal(snapshot.items[0].status, 'verified');
    assert.deepEqual(snapshot.items[0].receiptIds, ['receipt1']);
    assert.deepEqual(snapshot.receipts, verified.receipts);
    assert.equal(snapshot.validity.progressDigest, verified.validity.progressDigest);
  }
  for (const foreign of [{ itemId: declared.items[0].itemId },
    ...['sessionId', 'workspaceId', 'requestId', 'generation'].map((field) => ({ key: { ...key, [field]: field === 'generation' ? 2 : 'foreign' } }))]) {
    await store.transaction(key, (state) => { Object.assign(state.receipts[0], foreign); state.checkpointPresent = false; }, storeOptions());
    const before = (await store.read(key, storeOptions())).state;
    await assert.rejects(controller.declareTask(requestId, { version: 1, kind: 'update', items: [
      { itemId: declared.items[0].itemId, status: 'blocked', receiptIds: [] },
      { itemId: task.itemId, status: 'verified', receiptIds: ['receipt1'] },
    ] }), (error) => error.message === 'unknown_receipt' && error.completionInput === true);
    assert.deepEqual((await store.read(key, storeOptions())).state, before);
    await store.transaction(key, (state) => { state.receipts = structuredClone(verified.receipts); }, storeOptions());
  }
  const before = (await store.read(key, storeOptions())).state;
  await assert.rejects(controller.declareTask(requestId, { version: 1, kind: 'update', items: [
    { itemId: task.itemId, status: 'blocked', receiptIds: [] }, { itemId: 'unknown-item', status: 'reported', receiptIds: [] },
  ] }), (error) => error.message === 'unknown_item' && error.completionInput === true);
  assert.deepEqual((await store.read(key, storeOptions())).state, before);
});

test('controller factory requires trusted private dependencies', () => {
  assert.throws(() => createCompletionController({}), /dependencies/);
});

test('native event is idempotent across controller restart, feedback cannot reset budget', async () => {
  const { controller, dependencies, store } = fixture();
  const first = await controller.beginRequest(event());
  assert.equal(first.status, 'ok');
  await store.transaction(first.key, (state) => { state.budget.used = 1; state.budget.remaining = 1;
    state.budget.firstInterventionAt = Date.now(); state.budget.lastProgressDigest = 'baseline'; },
    { signal: new AbortController().signal, deadline: Date.now() + 1000 });
  const restarted = createCompletionController(dependencies);
  assert.equal((await restarted.snapshot(first.requestId)).validity.status, 'unknown_identity');
  const duplicate = await restarted.beginRequest(event());
  assert.deepEqual(duplicate.key, first.key);
  assert.equal((await restarted.snapshot(first.requestId)).budget.used, 1);
  for (const kind of ['feedback', 'compact', 'resume', 'unknown']) {
    assert.equal((await restarted.beginRequest({ ...event(), kind })).status, 'unknown');
  }
  assert.equal((await restarted.beginRequest({ kind: 'user', sessionId: 's1', workspaceId: 'w1' })).status, 'unknown');
});

test('new genuine user generation preserves pending work and resets only new budget', async () => {
  const { controller, acceptance, store } = fixture();
  const first = await controller.beginRequest(event());
  const task = await controller.registerTask(first.requestId, acceptance);
  await store.transaction(first.key, (state) => { state.budget.used = 2; state.budget.remaining = 0;
    state.budget.firstInterventionAt = Date.now(); state.budget.lastProgressDigest = 'baseline'; },
    { signal: new AbortController().signal, deadline: Date.now() + 1000 });
  const next = await controller.beginRequest(event('event2'));
  assert.equal(next.key.generation, 2);
  assert.notEqual(next.key.requestId, first.key.requestId);
  const snapshot = await controller.snapshot(next.requestId);
  assert.notEqual(snapshot.items[0].itemId, task.itemId);
  assert.equal(snapshot.items[0].contractId, 'c1');
  assert.deepEqual(snapshot.items[0].requiredTargetIds, ['t1']);
  await assert.rejects(controller.declareTask(next.requestId, { version: 1, kind: 'update',
    items: [{ itemId: task.itemId, status: 'verified', receiptIds: [] }] }), /unknown_item/);
  assert.equal(snapshot.budget.used, 0);
  assert.equal(snapshot.budget.remaining, 2);
  assert.equal((await controller.snapshot(first.requestId)).validity.status, 'stale');
});

test('JSON acceptance is rejected and host accepted whole contract registers fixed targets once', async () => {
  const { controller, acceptance } = fixture();
  const { key } = await controller.beginRequest(event());
  await assert.rejects(controller.registerTask(key.requestId, JSON.parse(JSON.stringify(acceptance))), /untrusted_acceptance/);
  const task = await controller.registerTask(key.requestId, acceptance);
  assert.deepEqual(await controller.registerTask(key.requestId, acceptance), task);
  assert.deepEqual(task.requiredTargetIds, ['t1']);
  assert.equal(task.mustFinish, true);
  const snapshot = await controller.snapshot(key.requestId);
  assert.equal(snapshot.items.length, 1);
  assert.equal(snapshot.items[0].source, 'accepted-plan');
  for (const forbidden of ['executable', '/fixture', 'accepted_fixture']) {
    assert.ok(!JSON.stringify(snapshot).includes(forbidden));
  }
});

test('checkpoint proposals cannot grant authority, verify, block or cancel', async () => {
  const { controller, acceptance } = fixture();
  const { key } = await controller.beginRequest(event());
  const task = await controller.registerTask(key.requestId, acceptance);
  await assert.rejects(controller.declareTask(key.requestId, { version: 1, kind: 'update',
    items: [{ itemId: task.itemId, status: 'verified', receiptIds: [], exitCode: 0 }] }), /invalid_checkpoint/);
  for (const status of ['verified', 'blocked', 'cancelled']) {
    await controller.declareTask(key.requestId, { version: 1, kind: 'update',
      items: [{ itemId: task.itemId, status, receiptIds: [] }] });
    assert.equal((await controller.snapshot(key.requestId)).items[0].status, 'pending');
  }
  await assert.rejects(controller.declareTask(key.requestId, { version: 1, kind: 'update',
    items: [{ itemId: task.itemId, status: 'verified', receiptIds: ['invented'] }] }), /unknown_receipt/);
  await controller.declareTask(key.requestId, { version: 1, kind: 'declare', items: [{ ordinal: 1, category: 'implementation' }] });
  const snapshot = await controller.snapshot(key.requestId);
  assert.equal(snapshot.items[1].source, 'model-proposed');
  assert.equal(snapshot.items[1].status, 'pending');
  assert.equal(snapshot.items[1].mustFinish, false);
  assert.deepEqual(snapshot.items[1].requiredTargetIds, []);
  await assert.rejects(controller.runVerification(key.requestId, snapshot.items[1].itemId, 't1'), /unaccepted_target/);
});

test('only actual trusted verifier produces bound metadata receipt', async () => {
  const { controller, acceptance } = fixture();
  const { key } = await controller.beginRequest(event());
  const task = await controller.registerTask(key.requestId, acceptance);
  await assert.rejects(controller.runVerification(key.requestId, task.itemId, 'invented'), /unaccepted_target/);
  const result = await controller.runVerification(key.requestId, task.itemId, 't1');
  assert.equal(result.executionId, 'e1');
  const snapshot = await controller.snapshot(key.requestId);
  assert.equal(snapshot.items[0].status, 'verified');
  assert.equal(snapshot.receipts[0].id, 'receipt1');
  assert.deepEqual(snapshot.receipts[0].key, key);
  assert.equal(snapshot.receipts[0].itemId, task.itemId);
  assert.deepEqual(snapshot.items[0].targetRevisions, { t1: 'revision1' });
  assert.equal(snapshot.revision, 'unknown');
});

test('unknown and malformed verifier results cannot establish verification', async () => {
  for (const produced of [ { status: 'unknown' }, { executionId: 'e1', receipt: { id: 'r1', result: 'verified', exitCode: 0 } } ]) {
    const { controller, acceptance } = fixture({ verifier: { async run() { return produced; } } });
    const { key } = await controller.beginRequest(event());
    const task = await controller.registerTask(key.requestId, acceptance);
    assert.equal((await controller.runVerification(key.requestId, task.itemId, 't1')).status, 'unknown');
    const snapshot = await controller.snapshot(key.requestId);
    assert.equal(snapshot.coverage, 'unknown');
    assert.equal(snapshot.items[0].status, 'pending');
    assert.deepEqual(snapshot.receipts, []);
  }
});

test('trusted route join must match exact generation and conflicting or unknown data degrades', async () => {
  const { controller } = fixture();
  const { key } = await controller.beginRequest(event());
  await controller.bindRoute(key.requestId, { callerModel: 'gpt-6' });
  assert.equal((await controller.snapshot(key.requestId)).modelFamily, 'gpt');
  for (const joined of [ { status: 'unknown' }, { status: 'ok', key: { ...key, generation: 2 },
    providerId: 'p1', modelId: 'gpt-6', modelFamily: 'gpt' } ]) {
    const other = fixture({ routeJoin: { async resolve() { return joined; } } });
    const started = await other.controller.beginRequest(event());
    assert.equal((await other.controller.bindRoute(started.requestId, { modelFamily: 'gpt' })).status, 'unknown');
    assert.equal((await other.controller.snapshot(started.requestId)).modelFamily, 'unknown');
  }
});

test('model switches preserve request budget and model proposals do not count as progress', async () => {
  const { controller, store, dependencies } = fixture();
  const { key } = await controller.beginRequest(event());
  const before = await controller.snapshot(key.requestId);
  await controller.declareTask(key.requestId, { version: 1, kind: 'declare', items: [{ ordinal: 1, category: 'report' }] });
  assert.equal((await controller.snapshot(key.requestId)).validity.progressDigest, before.validity.progressDigest);
  await store.transaction(key, (state) => { state.budget.used = 1; state.budget.remaining = 1;
    state.budget.firstInterventionAt = Date.now(); state.budget.lastProgressDigest = 'baseline'; },
    { signal: new AbortController().signal, deadline: Date.now() + 1000 });
  dependencies.routeJoin.resolve = async (observation, joinedKey) => ({ status: 'ok', key: joinedKey,
    providerId: 'fixture-provider', modelId: 'claude-opus', modelFamily: 'claude' });
  await controller.bindRoute(key.requestId, {});
  assert.equal((await controller.snapshot(key.requestId)).modelFamily, 'claude');
  assert.equal((await controller.snapshot(key.requestId)).budget.used, 1);
});

test('dependency failures return unknown without fabricating ledger state', async () => {
  const { controller } = fixture({ store: { async read() { throw new Error('disk'); },
    async transaction() { throw new Error('disk'); } } });
  assert.equal((await controller.beginRequest(event())).status, 'unknown');
  assert.equal((await controller.snapshot('r1')).validity.status, 'unknown_identity');
});

test('older duplicate after a new request cannot create a generation or refresh budget', async () => {
  const { controller, dependencies, store } = fixture();
  await controller.beginRequest(event());
  const next = await controller.beginRequest(event('event2'));
  await store.transaction(next.key, (state) => { state.budget.used = 2; state.budget.remaining = 0;
    state.budget.firstInterventionAt = Date.now(); state.budget.lastProgressDigest = 'baseline'; },
    { signal: new AbortController().signal, deadline: Date.now() + 1000 });
  const restarted = createCompletionController(dependencies);
  assert.equal((await restarted.beginRequest(event())).reason, 'stale_event');
  assert.deepEqual((await restarted.beginRequest(event('event2'))).key, next.key);
  assert.equal((await restarted.snapshot(next.requestId)).budget.used, 2);
});

test('native event window slides past 128 events and still rejects recent replays', async () => {
  const { controller, store } = fixture();
  const current = await controller.beginRequest(event());
  await store.transaction(current.key, (state) => {
    state.seenNativeEventIds = Array.from({ length: 128 }, (_, i) => `event${i + 1}`);
    state.nativeEventId = 'event128';
  }, storeOptions());
  const next = await controller.beginRequest(event('event129'));
  assert.equal(next.status, 'ok');
  assert.equal(next.key.generation, 2);
  const saved = await store.read({ sessionId: 's1', workspaceId: 'w1' }, storeOptions());
  assert.equal(saved.state.seenNativeEventIds.length, 128);
  assert.equal(saved.state.seenNativeEventIds[0], 'event2');
  assert.equal(saved.state.seenNativeEventIds.at(-1), 'event129');
  assert.equal((await controller.beginRequest(event('event128'))).reason, 'stale_event');
  // Only the bounded window is remembered: an evicted ID is indistinguishable from a new event.
  assert.equal((await controller.beginRequest(event('event1'))).key.generation, 3);
});

test('concurrent genuine new requests do not overwrite a committed generation', async () => {
  const { controller, store } = fixture();
  const results = await Promise.all([controller.beginRequest(event()), controller.beginRequest(event('event2'))]);
  assert.equal(results.filter((result) => result.status === 'ok').length, 1);
  const saved = await store.read({ sessionId: 's1', workspaceId: 'w1' },
    { signal: new AbortController().signal, deadline: Date.now() + 1000 });
  assert.equal(saved.state.key.generation, 1);
});

test('concurrent repeated event is unknown or idempotent and never issues a second generation', async () => {
  const { controller, store } = fixture();
  const results = await Promise.all([controller.beginRequest(event()), controller.beginRequest(event())]);
  assert.ok(results.some((result) => result.status === 'ok'));
  const saved = await store.read({ sessionId: 's1', workspaceId: 'w1' },
    { signal: new AbortController().signal, deadline: Date.now() + 1000 });
  assert.equal(saved.state.key.generation, 1);
});

test('stale verification finishing after an authoritative revision change cannot commit', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { controller, acceptance, store } = fixture({ verifier: { async run() { await gate;
    return { executionId: 'e1', receipt: { id: 'receipt1', executionId: 'e1', targetId: 't1',
      revision: 'old', result: 'verified', startedAt: 1, endedAt: 2 } }; } } });
  const { requestId, key } = await controller.beginRequest(event());
  const task = await controller.registerTask(requestId, acceptance);
  const verification = controller.runVerification(requestId, task.itemId, 't1');
  await new Promise((resolve) => setImmediate(resolve));
  await store.transaction(key, (state) => { state.revision = 'new'; },
    { signal: new AbortController().signal, deadline: Date.now() + 1000 });
  release();
  assert.equal((await verification).status, 'unknown');
  assert.deepEqual((await controller.snapshot(requestId)).receipts, []);
});

test('bounded state timeout aborts operation and prevents a late callback mutation', async () => {
  const base = memoryStore();
  let held;
  let options;
  const store = { read: base.read, transaction(key, fn, opts) {
    held = fn; options = opts; return new Promise(() => {});
  } };
  const { controller } = fixture({ store });
  const result = await controller.beginRequest(event());
  assert.equal(result.status, 'unknown');
  assert.equal(options.signal.aborted, true);
  const state = {};
  assert.throws(() => held(state), /deadline/);
  assert.deepEqual(state, {});
});

test('side-effecting target cannot run under verification even in an accepted contract', async () => {
  const { dependencies, acceptance } = fixture();
  const unsafe = { ...acceptance, targets: [{ ...acceptance.targets[0], sideEffectFree: false }] };
  const controller = createCompletionController({ ...dependencies, acceptedContracts: new Set([unsafe]),
    verifier: { run() { assert.fail('side effect must not be executed'); } } });
  const { requestId } = await controller.beginRequest(event());
  const task = await controller.registerTask(requestId, unsafe);
  await assert.rejects(controller.runVerification(requestId, task.itemId, 't1'), /unaccepted_target/);
});

test('accepted identity retains its constructor contract when caller mutates its fields', async () => {
  const { dependencies, acceptance } = fixture();
  const mutable = structuredClone(acceptance);
  const controller = createCompletionController({ ...dependencies, acceptedContracts: new Set([mutable]) });
  const { requestId } = await controller.beginRequest(event());
  mutable.contractId = 'other'; mutable.mustFinish = false;
  const task = await controller.registerTask(requestId, mutable);
  assert.equal(task.mustFinish, true);
  assert.equal((await controller.snapshot(requestId)).items[0].contractId, 'c1');
});

test('later failed verifier result restores pending status instead of keeping old success', async () => {
  let calls = 0;
  const { controller, acceptance } = fixture({ verifier: { async run() {
    calls++;
    return { executionId: `e${calls}`, receipt: { id: `receipt${calls}`, executionId: `e${calls}`,
      targetId: 't1', revision: 'revision1', result: calls === 1 ? 'verified' : 'failed',
      startedAt: calls, endedAt: calls } };
  } } });
  const { requestId } = await controller.beginRequest(event());
  const task = await controller.registerTask(requestId, acceptance);
  await controller.runVerification(requestId, task.itemId, 't1');
  await controller.runVerification(requestId, task.itemId, 't1');
  assert.equal((await controller.snapshot(requestId)).items[0].status, 'pending');
});

test('malformed stored state yields bounded unknown snapshot and cannot reset generation', async () => {
  const { controller, store } = fixture();
  const { requestId, key } = await controller.beginRequest(event());
  await store.transaction(key, (state) => { state.items = null; },
    { signal: new AbortController().signal, deadline: Date.now() + 1000 });
  const snapshot = await controller.snapshot(requestId);
  assert.equal(snapshot.validity.status, 'state_invalid');
  assert.equal(snapshot.coverage, 'unknown');
  assert.deepEqual(snapshot.items, []);
  assert.equal(snapshot.budget.remaining, 0);
  assert.equal((await controller.beginRequest(event('event2'))).status, 'unknown');
});

test('unknown target remains unresolved after another target succeeds and only its new proof restores completion', async () => {
  const { dependencies, acceptance, store } = fixture();
  const contract = { ...acceptance, requiredTargetIds: ['t1', 't2'],
    targets: [acceptance.targets[0], { ...acceptance.targets[0], id: 't2' }] };
  let execution = 0;
  let unknownT1 = false;
  const controller = createCompletionController({ ...dependencies, acceptedContracts: new Set([contract]),
    verifier: { async run({ target }) {
      if (target.id === 't1' && unknownT1) return { status: 'unknown' };
      execution++;
      return { executionId: `e${execution}`, receipt: { id: `receipt${execution}`,
        executionId: `e${execution}`, targetId: target.id, revision: 'revision1',
        result: 'verified', startedAt: execution, endedAt: execution } };
    } } });
  const { requestId, key } = await controller.beginRequest(event());
  const task = await controller.registerTask(requestId, contract);
  await controller.bindRoute(requestId, {});
  await controller.declareTask(requestId, { version: 1, kind: 'update',
    items: [{ itemId: task.itemId, status: 'reported', receiptIds: [] }] });
  await store.transaction(key, (state) => { state.enabled = true; state.mode = 'enforce'; },
    { signal: new AbortController().signal, deadline: Date.now() + 1000 });
  await controller.runVerification(requestId, task.itemId, 't1');
  await controller.runVerification(requestId, task.itemId, 't2');
  assert.equal(evaluateCompletion(await controller.snapshot(requestId)).action, 'allow');
  unknownT1 = true;
  await controller.runVerification(requestId, task.itemId, 't1');
  await controller.runVerification(requestId, task.itemId, 't2');
  const unresolved = await controller.snapshot(requestId);
  assert.equal(unresolved.coverage, 'unknown');
  assert.equal(unresolved.items[0].status, 'pending');
  assert.notEqual(evaluateCompletion(unresolved).action, 'allow');
  assert.equal(unresolved.receipts.length, 3);
  unknownT1 = false;
  await controller.runVerification(requestId, task.itemId, 't1');
  const recovered = await controller.snapshot(requestId);
  assert.equal(recovered.coverage, 'verified');
  assert.equal(recovered.items[0].status, 'verified');
  assert.equal(evaluateCompletion(recovered).action, 'allow');
});

// Each fixture target's revision digests only its own files, as the real verifier does.
function digestVerifier({ gate } = {}) {
  let execution = 0;
  return { async run({ target }) {
    execution++;
    const id = execution;
    if (gate) await gate(target);
    return { executionId: `e${id}`, receipt: { id: `receipt${id}`, executionId: `e${id}`, targetId: target.id,
      revision: `digest-${target.files.join('-').replaceAll('.', '_')}`, result: 'verified', startedAt: id, endedAt: id } };
  } };
}

async function enforce(controller, store, requestId, key, task) {
  await controller.bindRoute(requestId, {});
  await controller.declareTask(requestId, { version: 1, kind: 'update',
    items: [{ itemId: task.itemId, status: 'reported', receiptIds: [] }] });
  await store.transaction(key, (state) => { state.enabled = true; state.mode = 'enforce'; }, storeOptions());
}

test('one item with targets over different file sets reaches verified completion', async () => {
  const { dependencies, acceptance, store } = fixture();
  const contract = { ...acceptance, requiredTargetIds: ['t1', 't2'],
    targets: [acceptance.targets[0], { ...acceptance.targets[0], id: 't2', files: ['other.mjs'] }] };
  const controller = createCompletionController({ ...dependencies, acceptedContracts: new Set([contract]),
    verifier: digestVerifier() });
  const { requestId, key } = await controller.beginRequest(event());
  const task = await controller.registerTask(requestId, contract);
  await enforce(controller, store, requestId, key, task);
  assert.equal((await controller.runVerification(requestId, task.itemId, 't1')).status, 'ok');
  assert.equal((await controller.runVerification(requestId, task.itemId, 't2')).status, 'ok');
  const snapshot = await controller.snapshot(requestId);
  assert.equal(snapshot.items[0].status, 'verified');
  assert.deepEqual(snapshot.items[0].targetRevisions, { t1: 'digest-fixture_mjs', t2: 'digest-other_mjs' });
  assert.equal(evaluateCompletion(snapshot).action, 'allow');
});

test('a workspace observation after per-target proofs invalidates every target, not only the newest', async () => {
  const { dependencies, acceptance, store } = fixture();
  const contract = { ...acceptance, requiredTargetIds: ['t1', 't2'],
    targets: [acceptance.targets[0], { ...acceptance.targets[0], id: 't2', files: ['other.mjs'] }] };
  const controller = createCompletionController({ ...dependencies, acceptedContracts: new Set([contract]),
    verifier: digestVerifier() });
  const { requestId, key } = await controller.beginRequest(event());
  const task = await controller.registerTask(requestId, contract);
  await enforce(controller, store, requestId, key, task);
  assert.equal((await controller.runVerification(requestId, task.itemId, 't1')).status, 'ok');
  assert.equal((await controller.runVerification(requestId, task.itemId, 't2')).status, 'ok');
  assert.equal(evaluateCompletion(await controller.snapshot(requestId)).action, 'allow');
  await store.transaction(key, (state) => { state.revision = 'observed-after-pass'; }, storeOptions());
  const after = await controller.snapshot(requestId);
  assert.equal(hasVerifiedTargets(after.items[0], after), false);
  assert.notEqual(evaluateCompletion(after).action, 'allow');
});

test('verifying another contract target with the same id and other files does not regress the first item', async () => {
  const { dependencies, acceptance } = fixture();
  const other = { ...acceptance, contractId: 'c2', targets: [{ ...acceptance.targets[0], files: ['other.mjs'] }] };
  const controller = createCompletionController({ ...dependencies, acceptedContracts: new Set([acceptance, other]),
    verifier: digestVerifier() });
  const { requestId } = await controller.beginRequest(event());
  const first = await controller.registerTask(requestId, acceptance);
  const second = await controller.registerTask(requestId, other);
  await controller.runVerification(requestId, first.itemId, 't1');
  assert.equal((await controller.runVerification(requestId, second.itemId, 't1')).status, 'ok');
  const snapshot = await controller.snapshot(requestId);
  assert.deepEqual(snapshot.items.map((item) => item.status), ['verified', 'verified']);
  assert.deepEqual(snapshot.items.map((item) => hasVerifiedTargets(item, snapshot)), [true, true]);
  assert.equal(snapshot.revision, 'unknown');
});

test('concurrent verifications of targets over different file sets both commit', async () => {
  const { dependencies, acceptance, store } = fixture();
  const contract = { ...acceptance, requiredTargetIds: ['t1', 't2'],
    targets: [acceptance.targets[0], { ...acceptance.targets[0], id: 't2', files: ['other.mjs'] }] };
  const started = [];
  const release = Promise.withResolvers();
  const controller = createCompletionController({ ...dependencies, acceptedContracts: new Set([contract]),
    verifier: digestVerifier({ gate: async (target) => { started.push(target.id); await release.promise; } }) });
  const { requestId, key } = await controller.beginRequest(event());
  const task = await controller.registerTask(requestId, contract);
  await enforce(controller, store, requestId, key, task);
  const runs = [controller.runVerification(requestId, task.itemId, 't1'), controller.runVerification(requestId, task.itemId, 't2')];
  while (started.length < 2) await new Promise((resolve) => setImmediate(resolve));
  release.resolve();
  assert.deepEqual((await Promise.all(runs)).map((result) => result.status), ['ok', 'ok']);
  const snapshot = await controller.snapshot(requestId);
  assert.equal(snapshot.receipts.length, 2);
  assert.equal(evaluateCompletion(snapshot).action, 'allow');
});

test('verification racing a newer proof of the same target cannot commit its older revision', async () => {
  const gates = [Promise.withResolvers(), Promise.withResolvers()];
  let calls = 0;
  const { controller, acceptance } = fixture({ verifier: { async run() {
    const id = ++calls;
    await gates[id - 1].promise;
    return { executionId: `e${id}`, receipt: { id: `receipt${id}`, executionId: `e${id}`, targetId: 't1',
      revision: `revision${id}`, result: 'verified', startedAt: id, endedAt: id } };
  } } });
  const { requestId } = await controller.beginRequest(event());
  const task = await controller.registerTask(requestId, acceptance);
  const older = controller.runVerification(requestId, task.itemId, 't1');
  const newer = controller.runVerification(requestId, task.itemId, 't1');
  while (calls < 2) await new Promise((resolve) => setImmediate(resolve));
  gates[1].resolve();
  assert.equal((await newer).status, 'ok');
  gates[0].resolve();
  assert.equal((await older).status, 'unknown');
  const snapshot = await controller.snapshot(requestId);
  assert.deepEqual(snapshot.receipts.map((receipt) => receipt.id), ['receipt2']);
  assert.deepEqual(snapshot.items[0].targetRevisions, { t1: 'revision2' });
  assert.equal(snapshot.items[0].status, 'verified');
});

test('the outer bound admits a clean run that uses its pre- and post-observation budgets', async () => {
  const { dependencies, acceptance } = fixture();
  // timeoutMs 100: the verifier may take 100 + 100 + 100 + kill grace, which the old timeoutMs + 1000 bound cut off.
  const slow = { async run() {
    await new Promise((resolve) => setTimeout(resolve, verifierDeadlineMs(acceptance.targets[0].timeoutMs) + 800));
    return { executionId: 'e1', receipt: { id: 'receipt1', executionId: 'e1', targetId: 't1',
      revision: 'revision1', result: 'verified', startedAt: 1, endedAt: 2 } };
  } };
  const controller = createCompletionController({ ...dependencies, verifier: slow });
  const { requestId } = await controller.beginRequest(event());
  const task = await controller.registerTask(requestId, acceptance);
  assert.equal((await controller.runVerification(requestId, task.itemId, 't1')).status, 'ok');
});
