import assert from 'node:assert/strict';
import test from 'node:test';
import { parseCheckpoint } from '../src/completion/checkpoint.mjs';
import { evaluateCompletion } from '../src/completion/evaluator.mjs';

function makeSnapshot(overrides = {}) {
  return {
    key: { sessionId: 's1', workspaceId: 'w1', requestId: 'r1', generation: 1 },
    enabled: true, mode: 'enforce', coverage: 'verified', modelFamily: 'gpt',
    cancelled: false, awaitingAuthority: false, safeWorkRemaining: true,
    executionTask: true, checkpointPresent: true,
    items: [{ itemId: 'i1', category: 'verification', status: 'pending',
      source: 'accepted-plan', requiredTargetIds: ['t1'], mustFinish: true, receiptIds: [] }],
    receipts: [], budget: { used: 0, remaining: 2, firstInterventionAt: null,
      lastProgressDigest: null, unknownReconciled: false },
    revision: 'rev1', validity: { status: 'valid', now: 1000, progressDigest: 'p1' },
    stopHookActive: false, upstreamError: null, ...overrides,
  };
}

const bytes = (value) => Buffer.from(JSON.stringify(value));

test('checkpoint rejects overflow and authorization keys', () => {
  assert.equal(parseCheckpoint(Buffer.alloc(8193)).error, 'oversize');
  assert.ok(parseCheckpoint(bytes({ version: 1, kind: 'declare',
    items: [{ ordinal: 1, category: 'verification' }], accepted: true })).error);
});

test('declaration validates ordinals, bounded count, and categories', () => {
  const good = { version: 1, kind: 'declare', items: [{ ordinal: 1, category: 'verification' }] };
  assert.deepEqual(parseCheckpoint(bytes(good)), { kind: 'declare', items: good.items });
  for (const items of [
    [{ ordinal: 0, category: 'verification' }],
    [{ ordinal: 65, category: 'verification' }],
    [{ ordinal: 1, category: 'anything' }],
    [good.items[0], good.items[0]],
    Array.from({ length: 65 }, (_, i) => ({ ordinal: i + 1, category: 'verification' })),
    [{ ordinal: 1, category: 'verification', source: 'accepted' }],
  ]) assert.ok(parseCheckpoint(bytes({ ...good, items })).error);
});

test('update accepts bounded references, never execution evidence', () => {
  const update = { version: 1, kind: 'update', items: [{ itemId: 'i1', status: 'verified', receiptIds: ['receipt1'] }] };
  assert.deepEqual(parseCheckpoint(bytes(update)), { kind: 'update', items: update.items });
  for (const item of [
    { ...update.items[0], exitCode: 0 },
    { ...update.items[0], itemId: '../secret' },
    { ...update.items[0], receiptIds: ['r1', 'r1'] },
    { ...update.items[0], receiptIds: ['x'.repeat(129)] },
    { ...update.items[0], receiptIds: Array.from({ length: 129 }, (_, i) => `r${i}`) },
    { ...update.items[0], status: 'PASS' },
  ]) assert.ok(parseCheckpoint(bytes({ ...update, items: [item] })).error);
  assert.ok(parseCheckpoint(bytes({ ...update, items: [update.items[0], update.items[0]] })).error);
  assert.ok(parseCheckpoint(Buffer.from('{bad')).error);
  assert.ok(parseCheckpoint(bytes({ version: 2, kind: 'declare', items: [] })).error);
});

test('cancellation and authority waits precede other gates', () => {
  assert.equal(evaluateCompletion(makeSnapshot({ cancelled: true })).action, 'allow');
  assert.equal(evaluateCompletion(makeSnapshot({ awaitingAuthority: true, safeWorkRemaining: false })).action, 'allow');
  assert.equal(evaluateCompletion(makeSnapshot({ awaitingAuthority: true })).action, 'continue');
});

test('coverage and model gates never continue', () => {
  for (const overrides of [ { enabled: false }, { mode: 'shadow' },
    { modelFamily: 'claude' }, { coverage: 'unknown' }, { modelFamily: 'unknown' } ]) {
    assert.notEqual(evaluateCompletion(makeSnapshot(overrides)).action, 'continue');
  }
  assert.equal(evaluateCompletion(makeSnapshot({ modelFamily: 'unknown' })).action, 'degraded');
});

test('invalid state is degraded and pure question does not need a checkpoint', () => {
  assert.equal(evaluateCompletion(makeSnapshot({ validity: { status: 'stale' } })).action, 'degraded');
  assert.equal(evaluateCompletion(makeSnapshot({ executionTask: false, checkpointPresent: false, items: [] })).action, 'allow');
  assert.equal(evaluateCompletion(makeSnapshot({ executionTask: true, checkpointPresent: false })).reason, 'checkpoint_missing');
});

test('external blocker only allows when no safe authorized work remains', () => {
  const blocked = { ...makeSnapshot().items[0], status: 'blocked' };
  assert.equal(evaluateCompletion(makeSnapshot({ items: [blocked], safeWorkRemaining: false })).action, 'allow');
  assert.equal(evaluateCompletion(makeSnapshot({ items: [blocked], safeWorkRemaining: false })).reason, 'external_blocker');
  assert.equal(evaluateCompletion(makeSnapshot({ items: [blocked, { ...blocked, itemId: 'i2', status: 'pending' }] })).action, 'continue');
});

test('running server without mustFinish is not a blocker', () => {
  assert.equal(evaluateCompletion(makeSnapshot({ safeWorkRemaining: false,
    items: [{ ...makeSnapshot().items[0], category: 'background', status: 'running', mustFinish: false }] })).action, 'allow');
});

test('model assertions and stale receipt cannot complete accepted verification', () => {
  const item = { ...makeSnapshot().items[0], status: 'verified', receiptIds: ['r1'] };
  assert.equal(evaluateCompletion(makeSnapshot({ items: [item] })).action, 'continue');
  const receipt = { id: 'r1', itemId: 'i1', targetId: 't1', key: makeSnapshot().key,
    executionId: 'e1', result: 'verified', revision: 'rev0', startedAt: 0, endedAt: 1 };
  assert.equal(evaluateCompletion(makeSnapshot({ items: [item], receipts: [receipt] })).action, 'continue');
  assert.equal(evaluateCompletion(makeSnapshot({ items: [item], receipts: [{ ...receipt, revision: 'rev1' }] })).action, 'allow');
});

test('continuation is bounded by budget, window, progress, recursion and upstream errors', () => {
  const base = makeSnapshot().budget;
  const cases = [
    [{ budget: { ...base, used: 2, remaining: 0 } }, 'budget_exhausted'],
    [{ budget: { ...base, used: 1, remaining: 1, firstInterventionAt: 0 }, validity: { status: 'valid', now: 600000, progressDigest: 'p2' } }, 'window_expired'],
    [{ budget: { ...base, used: 1, remaining: 1, firstInterventionAt: 0, lastProgressDigest: 'p1' } }, 'no_progress'],
    [{ stopHookActive: true }, 'stop_hook_active'],
    [{ upstreamError: { status: 429 } }, 'upstream_error'],
    [{ upstreamError: { status: 502 } }, 'upstream_error'],
  ];
  for (const [overrides, reason] of cases) {
    const decision = evaluateCompletion(makeSnapshot(overrides));
    assert.notEqual(decision.action, 'continue');
    assert.equal(decision.reason, reason);
  }
});

test('missing checkpoint and model proposals permit reconciliation only once', () => {
  const first = makeSnapshot({ checkpointPresent: false });
  assert.equal(evaluateCompletion(first).action, 'continue');
  assert.notEqual(evaluateCompletion({ ...first, budget: { ...first.budget, unknownReconciled: true } }).action, 'continue');
  const proposal = { ...first.items[0], source: 'model-proposed', requiredTargetIds: [] };
  assert.equal(evaluateCompletion(makeSnapshot({ items: [proposal] })).action, 'continue');
  assert.notEqual(evaluateCompletion(makeSnapshot({ items: [proposal], budget: { ...first.budget, unknownReconciled: true } })).action, 'continue');
});

test('feedback lists no more than three pending item IDs', () => {
  const items = Array.from({ length: 5 }, (_, i) => ({ ...makeSnapshot().items[0], itemId: `i${i}` }));
  assert.equal(evaluateCompletion(makeSnapshot({ items })).itemIds.length, 3);
});

test('invalid receipt collections, contradictory budget and future intervention degrade', () => {
  const base = makeSnapshot();
  for (const overrides of [
    { receipts: [null] },
    { budget: { ...base.budget, used: 1, remaining: 2 } },
    { budget: { ...base.budget, used: 1, remaining: 1, firstInterventionAt: 2000, lastProgressDigest: 'p0' } },
    { items: [{ ...base.items[0], requiredTargetIds: ['t1', 't1'] }] },
  ]) assert.equal(evaluateCompletion(makeSnapshot(overrides)).action, 'degraded');
});

test('a receipt from another session or generation never completes work', () => {
  const base = makeSnapshot();
  const item = { ...base.items[0], status: 'verified', receiptIds: ['r1'] };
  for (const key of [{ ...base.key, sessionId: 's2' }, { ...base.key, generation: 2 }]) {
    const receipt = { id: 'r1', itemId: 'i1', targetId: 't1', key, executionId: 'e1',
      result: 'verified', revision: 'rev1', startedAt: 0, endedAt: 1 };
    assert.equal(evaluateCompletion(makeSnapshot({ items: [item], receipts: [receipt] })).action, 'continue');
  }
});

test('a later failed, stale or unknown receipt supersedes earlier success', () => {
  const base = makeSnapshot();
  const good = { id: 'r1', itemId: 'i1', targetId: 't1', key: base.key, executionId: 'e1',
    result: 'verified', revision: 'rev1', startedAt: 0, endedAt: 1 };
  const item = { ...base.items[0], status: 'verified', receiptIds: ['r1', 'r2'] };
  for (const result of ['failed', 'stale', 'unknown']) {
    assert.equal(evaluateCompletion(makeSnapshot({ items: [item], receipts: [good,
      { ...good, id: 'r2', executionId: 'e2', result, startedAt: 2, endedAt: 3 }] })).action, 'continue');
  }
});
