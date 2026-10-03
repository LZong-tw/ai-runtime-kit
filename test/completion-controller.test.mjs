import assert from 'node:assert/strict';
import test from 'node:test';
import { createCompletionController } from '../src/completion/controller.mjs';

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

test('controller factory requires trusted private dependencies', () => {
  assert.throws(() => createCompletionController({}), /dependencies/);
});

test('native event is idempotent across controller restart, feedback cannot reset budget', async () => {
  const { controller, dependencies, store } = fixture();
  const first = await controller.beginRequest(event());
  assert.equal(first.status, 'ok');
  await store.transaction(first.key, (state) => { state.budget.used = 1; state.budget.remaining = 1; },
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
  await store.transaction(first.key, (state) => { state.budget.used = 2; state.budget.remaining = 0; },
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
  assert.equal(snapshot.revision, 'revision1');
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
  await store.transaction(key, (state) => { state.budget.used = 1; state.budget.remaining = 1; },
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
  await store.transaction(next.key, (state) => { state.budget.used = 2; state.budget.remaining = 0; },
    { signal: new AbortController().signal, deadline: Date.now() + 1000 });
  const restarted = createCompletionController(dependencies);
  assert.equal((await restarted.beginRequest(event())).reason, 'stale_event');
  assert.deepEqual((await restarted.beginRequest(event('event2'))).key, next.key);
  assert.equal((await restarted.snapshot(next.requestId)).budget.used, 2);
});

test('native event capacity rejects new generation and retains prior budget', async () => {
  const { controller, store } = fixture();
  const current = await controller.beginRequest(event());
  await store.transaction(current.key, (state) => {
    state.seenNativeEventIds = Array.from({ length: 128 }, (_, i) => `event${i + 1}`);
    state.budget.used = 2; state.budget.remaining = 0;
  }, { signal: new AbortController().signal, deadline: Date.now() + 1000 });
  assert.equal((await controller.beginRequest(event('event129'))).reason, 'capacity');
  assert.equal((await controller.snapshot(current.requestId)).budget.used, 2);
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
