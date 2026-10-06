import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createNativeAdapter } from '../src/completion/native-adapter.mjs';
import { createRouteJoin } from '../src/completion/route-join.mjs';
import { createCompletionController } from '../src/completion/controller.mjs';
import { createCompletionStore } from '../src/completion/store.mjs';
import { evaluateCompletion } from '../src/completion/evaluator.mjs';

// Private producer fixtures, not evidence that a native host supplies these fields.
const contract = { status: 'validated', decode: (payload) => payload.fixtureEvent };
const key = { sessionId: 'session', workspaceId: 'workspace', requestId: 'request', generation: 1 };

test('route join requires validated exact request and transport binding, never session hints', async () => {
  const join = createRouteJoin({ validatedContract: contract });
  assert.equal(join.observe({ key, transportRequestId: 't1', provider: 'p1', model: 'gpt-6.1-sol' }).status, 'unknown');
  assert.equal(join.observe({ fixtureEvent: { key, transportRequestId: 't1', provider: 'p1', model: 'gpt-6.1-sol' } }).status, 'ok');
  assert.deepEqual(await join.resolve({ key, transportRequestId: 't1', provider: 'p1', model: 'gpt-6.1-sol' }, key), {
    status: 'ok', key, providerId: 'p1', modelId: 'model-dedfefd51120f28386c9dba78e46feb403523e23d67980cdf24514ee0b50b5ed', modelFamily: 'gpt',
  });
  for (const observation of [
    { sessionId: key.sessionId, model: 'gpt-6.1-sol' },
    { key: { ...key, requestId: 'other' }, transportRequestId: 't1' },
    { key: { ...key, generation: 2 }, transportRequestId: 't1' },
    { key, confidence: 0.35, model: 'gpt-6.1-sol' },
    { key, lastRoute: 'gpt-6.1-sol' }, { key, maskedMarker: 'gpt' },
    { key, env: { MODEL: 'gpt-6.1-sol' } },
    { key, transportRequestId: 't1' },
    { key, transportRequestId: 't1', provider: 'wrong', model: 'gpt-6.1-sol' },
    { key, transportRequestId: 't1', provider: 'p1', model: 'gpt-6_1-sol' },
  ]) assert.equal((await join.resolve(observation, key)).status, 'unknown');
  assert.equal((await join.resolve({ key, transportRequestId: 't1' }, { ...key, generation: 2 })).status, 'unknown');
  assert.equal(createRouteJoin({}).observe({ fixtureEvent: { key, transportRequestId: 't1', provider: 'p1', model: 'gpt-6.1-sol' } }).status, 'unknown');
});

test('conflicting transport identity and unsupported model cannot establish eligibility', async () => {
  const join = createRouteJoin({ validatedContract: contract });
  const route = { key, transportRequestId: 't1', provider: 'p1', model: 'gpt-6.1-sol' };
  assert.equal(join.observe({ fixtureEvent: route }).status, 'ok');
  assert.equal(join.observe({ fixtureEvent: { ...route, model: 'claude-sonnet-4-6' } }).status, 'unknown');
  assert.equal((await join.resolve(route, key)).status, 'unknown');
  assert.equal(join.observe({ fixtureEvent: route }).status, 'unknown');
  assert.equal((await join.resolve(route, key)).status, 'unknown');
  assert.equal(join.observe({ fixtureEvent: { ...route, transportRequestId: 't2', model: 'totally-gpt-like' } }).status, 'unknown');
});

test('GPT 5.6 has GPT family coverage only through its exact accepted route binding', async () => {
  const join = createRouteJoin({ validatedContract: contract });
  const route = { key, transportRequestId: 't56', provider: 'p1', model: 'gpt-5.6-sol' };
  assert.equal(join.observe({ fixtureEvent: route }).status, 'ok');
  const result = await join.resolve(route, key);
  assert.equal(result.status, 'ok'); assert.equal(result.modelFamily, 'gpt');
  assert.equal((await join.resolve({ ...route, model: 'gpt-5_6-sol' }, key)).status, 'unknown');
  assert.equal((await join.resolve({ ...route, transportRequestId: 'other' }, key)).status, 'unknown');
});

test('every catalog-routed GPT 5.6 id is covered exactly, including the dated terra snapshot', async () => {
  const join = createRouteJoin({ validatedContract: contract });
  const models = ['gpt-5.6', 'gpt-5.6-sol', 'gpt-5.6-luna', 'gpt-5.6-terra', 'gpt-5.6-terra-2026-08-05'];
  for (const [index, model] of models.entries()) {
    const route = { key, transportRequestId: `c${index}`, provider: 'p1', model };
    assert.equal(join.observe({ fixtureEvent: route }).status, 'ok', model);
    assert.equal((await join.resolve(route, key)).modelFamily, 'gpt', model);
  }
  for (const [index, model] of ['gpt-5.6-terrax', 'gpt-5.6-terra-latest', 'gpt-5.6-terra-2026-8-5',
    'gpt-5.6-sol-2026-08-05', 'openai/gpt-5.6-terra', 'gpt-5.6-terra-2026-08-05-preview'].entries()) {
    assert.equal(join.observe({ fixtureEvent: { key, transportRequestId: `n${index}`, provider: 'p1', model } }).status, 'unknown', model);
  }
});

test('an unsupported-model identity conflict permanently poisons the original complete route tuple', async () => {
  const join = createRouteJoin({ validatedContract: contract });
  const route = { key, transportRequestId: 't1', provider: 'p1', model: 'gpt-6.1-sol' };
  assert.equal(join.observe({ fixtureEvent: route }).status, 'ok');
  assert.equal(join.observe({ fixtureEvent: { ...route, model: 'unsupported-model' } }).status, 'unknown');
  assert.equal((await join.resolve(route, key)).status, 'unknown');
  assert.equal(join.observe({ fixtureEvent: route }).status, 'unknown');
  assert.equal((await join.resolve(route, key)).status, 'unknown');
});

async function fixture(t, mustFinish = true) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'completion-native-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = createCompletionStore({ root });
  const acceptance = { contractId: 'background-contract', category: 'background', mustFinish,
    requiredTargetIds: ['target1'], targets: [{ id: 'target1', timeoutMs: 100, sideEffectFree: true }] };
  const join = createRouteJoin({ validatedContract: contract });
  const core = createCompletionController({ store, acceptedContracts: new Set([acceptance]),
    verifier: { run() { throw new Error('unexpected verifier'); } }, routeJoin: join });
  const host = { beginRequest: core.beginRequest, transaction: store.transaction };
  const adapter = createNativeAdapter({ validatedContract: contract, controller: host });
  const started = await adapter.observe({ fixtureEvent: { kind: 'user', nativeEventId: 'event1', sessionId: 'session', workspaceId: 'workspace' } });
  const task = await core.registerTask(started.key.requestId, acceptance);
  return { store, core, join, host, adapter, key: started.key, task };
}

test('unvalidated user and approval payloads stay unknown; feedback resume compact cannot create generation', async (t) => {
  const f = await fixture(t);
  const unknown = createNativeAdapter({ controller: f.host });
  assert.equal((await unknown.observe({ kind: 'user', nativeEventId: 'new', sessionId: 'session', workspaceId: 'workspace' })).status, 'unknown');
  assert.equal((await unknown.observe({ kind: 'approval', key: f.key })).status, 'unknown');
  for (const kind of ['feedback', 'resume', 'compact']) {
    assert.equal((await f.adapter.observe({ fixtureEvent: { kind, key: f.key, nativeEventId: 'new' } })).status, 'ok');
  }
  const state = await f.store.read(f.key);
  assert.equal(state.state.key.generation, 1);
  assert.equal(state.state.nativeEventId, 'event1');
});

test('background observations require accepted registered item and exact native task binding; completed is no receipt', async (t) => {
  const f = await fixture(t);
  const event = { kind: 'background', key: f.key, contractId: 'background-contract', itemId: f.task.itemId,
    nativeTaskId: 'native1', phase: 'start' };
  assert.equal((await f.adapter.observe({ fixtureEvent: { ...event, itemId: 'unregistered' } })).status, 'unknown');
  assert.equal((await f.adapter.observe({ fixtureEvent: event })).status, 'ok');
  assert.equal((await f.adapter.observe({ fixtureEvent: { ...event, phase: 'completed', nativeTaskId: 'other' } })).status, 'unknown');
  assert.equal((await f.adapter.observe({ stdout: 'TaskOutput completed native1' })).status, 'unknown');
  assert.equal((await f.adapter.observe({ fixtureEvent: { ...event, phase: 'completed' } })).status, 'ok');
  const state = (await f.store.read(f.key)).state;
  assert.equal(state.items[0].status, 'pending');
  assert.equal(state.receipts.length, 0);
  const restarted = createNativeAdapter({ validatedContract: contract, controller: f.host });
  assert.equal((await restarted.observe({ fixtureEvent: { ...event, phase: 'completed' } })).status, 'unknown');
});

test('changing GPT to Claude suspends GPT policy and switching back preserves intervention budget', async (t) => {
  const f = await fixture(t);
  await f.store.transaction(f.key, (state) => { state.enabled = true; state.mode = 'enforce'; state.verifierCoverage = 'verified';
    state.budget = { used: 1, remaining: 1, firstInterventionAt: Date.now(), lastProgressDigest: 'prior', unknownReconciled: false }; });
  for (const [transportRequestId, model, family] of [['t0', 'gpt-5.6-sol', 'gpt'], ['t1', 'gpt-6.1-sol', 'gpt'], ['t2', 'claude-sonnet-4-6', 'claude'], ['t3', 'gpt-6.1-sol', 'gpt']]) {
    assert.equal(f.join.observe({ fixtureEvent: { key: f.key, transportRequestId, provider: 'p1', model } }).status, 'ok');
    assert.equal((await f.core.bindRoute(f.key.requestId, { key: f.key, transportRequestId, provider: 'p1', model })).status, 'ok');
    const snapshot = await f.core.snapshot(f.key.requestId);
    assert.equal(snapshot.modelFamily, family);
    assert.equal(snapshot.budget.used, 1);
    if (family === 'claude') assert.equal(evaluateCompletion(snapshot).reason, 'model_ineligible');
  }
});

test('optional background work cannot block and proposed work cannot claim native accepted binding', async (t) => {
  const f = await fixture(t, false);
  await f.store.transaction(f.key, (state) => {
    Object.assign(state, { enabled: true, mode: 'enforce', coverage: 'verified', modelFamily: 'gpt', checkpointPresent: true });
  });
  assert.equal(evaluateCompletion(await f.core.snapshot(f.key.requestId)).reason, 'complete');
  await f.store.transaction(f.key, (state) => { state.items.push({ itemId: 'proposed', category: 'background', source: 'model-proposed',
    status: 'pending', mustFinish: false, requiredTargetIds: [], receiptIds: [] }); });
  assert.equal((await f.adapter.observe({ fixtureEvent: { kind: 'background', key: f.key, contractId: 'background-contract',
    itemId: 'proposed', nativeTaskId: 'native1', phase: 'start' } })).status, 'unknown');
});

test('trusted native authority allows cancellation without accepting raw approval assertion', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.adapter.observe({ kind: 'cancel', key: f.key })).status, 'unknown');
  assert.equal((await f.adapter.observe({ fixtureEvent: { kind: 'authority', key: f.key,
    awaitingAuthority: true, safeWorkRemaining: false } })).status, 'ok');
  assert.equal(evaluateCompletion(await f.core.snapshot(f.key.requestId)).reason, 'awaiting_authority');
  assert.equal((await f.adapter.observe({ fixtureEvent: { kind: 'cancel', key: f.key } })).status, 'ok');
  assert.equal(evaluateCompletion(await f.core.snapshot(f.key.requestId)).reason, 'cancelled');
});
