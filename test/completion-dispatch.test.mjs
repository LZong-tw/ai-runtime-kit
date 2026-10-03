import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { Worker } from 'node:worker_threads';
import { runCompletionDispatch } from '../src/completion/dispatch.mjs';
import { createNativeAdapter } from '../src/completion/native-adapter.mjs';
import { createCompletionStore } from '../src/completion/store.mjs';
import { createCompletionController } from '../src/completion/controller.mjs';

const contract = { status: 'validated', decode: (payload) => payload.fixtureEvent };
function output() {
  const chunks = [];
  const stream = new Writable({ write(chunk, encoding, done) { chunks.push(Buffer.from(chunk)); done(); } });
  return { stream, text: () => Buffer.concat(chunks).toString() };
}
function input(event) { return Readable.from([Buffer.from(JSON.stringify(event))], { objectMode: false }); }
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'completion-dispatch-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = createCompletionStore({ root });
  const core = createCompletionController({ store, acceptedContracts: new Set(),
    verifier: { run() { throw new Error('unexpected verifier'); } }, routeJoin: { resolve() { return { status: 'unknown' }; } } });
  const { key } = await core.beginRequest({ kind: 'user', nativeEventId: 'event1', sessionId: 'session', workspaceId: 'workspace' });
  await store.transaction(key, (state) => {
    Object.assign(state, { enabled: true, mode: 'enforce', modelFamily: 'gpt', coverage: 'verified',
      safeWorkRemaining: true, executionTask: true, checkpointPresent: true });
    state.items = [1, 2, 3, 4].map((id) => ({ itemId: `item${id}`, contractId: `contract${id}`, category: 'implementation',
      source: 'accepted-plan', status: 'pending', mustFinish: true, requiredTargetIds: ['target'], receiptIds: [] }));
  });
  const host = { beginRequest: core.beginRequest, transaction: store.transaction };
  const adapter = createNativeAdapter({ validatedContract: contract, controller: host });
  return { store, key, host, adapter, root, event: { fixtureEvent: { kind: 'stop', key } } };
}

test('Stop atomically debits real store budget and emits at most three safe item IDs', async (t) => {
  const f = await fixture(t); const out = output();
  const decision = await runCompletionDispatch({ input: input(f.event), output: out.stream, controller: f.host, adapter: f.adapter });
  assert.equal(decision.action, 'continue'); assert.equal(decision.remaining, 1);
  assert.deepEqual(decision.itemIds, ['item1', 'item2', 'item3']);
  const feedback = JSON.parse(out.text());
  assert.equal(feedback.decision, 'block'); assert.equal(feedback.remaining, 1);
  assert.equal(feedback.reason, 'pending_work'); assert.equal(typeof feedback.nextAction, 'string');
  assert.equal((await f.store.read(f.key)).state.budget.used, 1);
  const second = output();
  assert.equal((await runCompletionDispatch({ input: input(f.event), output: second.stream, controller: f.host, adapter: f.adapter })).reason, 'no_progress');
  assert.equal(second.text(), '');
});

test('eight simultaneous Stops never exceed budget or feedback under real store contention', async (t) => {
  const f = await fixture(t); const outs = Array.from({ length: 8 }, output);
  const decisions = await Promise.all(outs.map((out) => runCompletionDispatch({ input: input(f.event), output: out.stream, controller: f.host, adapter: f.adapter })));
  assert.equal(decisions.filter((decision) => decision.action === 'continue').length, 1);
  assert.equal(outs.filter((out) => out.text()).length, 1);
  assert.equal((await f.store.read(f.key)).state.budget.used, 1);
  assert.deepEqual((await fs.readdir(f.root)).filter((name) => name.endsWith('.tmp') || name.endsWith('.lock')), []);
});

test('active Stop, unknown identity and stale generation emit nothing and never debit', async (t) => {
  const f = await fixture(t);
  for (const event of [{ ...f.event, stop_hook_active: true }, { kind: 'stop', key: f.key },
    { fixtureEvent: { kind: 'stop', key: { ...f.key, generation: 2 } } }]) {
    const out = output();
    const decision = await runCompletionDispatch({ input: input(event), output: out.stream, controller: f.host, adapter: f.adapter });
    assert.notEqual(decision.action, 'continue'); assert.equal(out.text(), '');
  }
  assert.equal((await f.store.read(f.key)).state.budget.used, 0);
});

test('stdin reads only cap plus one and destroys its reader on oversize', async () => {
  let consumed = 0;
  const source = new Readable({ read() { this.push(Buffer.alloc(16384, 32)); } });
  const read = source.read.bind(source);
  source.read = (size) => { const result = read(size); if (result) consumed += result.length; return result; };
  const out = output();
  const decision = await runCompletionDispatch({ input: source, output: out.stream, controller: {}, adapter: {} });
  assert.equal(decision.reason, 'input_oversize'); assert.equal(consumed, 65537);
  assert.equal(source.destroyed, true); assert.equal(out.text(), '');
});

test('non-byte object streams are rejected before consuming unbounded chunks', async () => {
  const source = Readable.from([Buffer.alloc(100000)]);
  let consumed = 0; const read = source.read.bind(source);
  source.read = (size) => { const result = read(size); if (result) consumed += result.length; return result; };
  const decision = await runCompletionDispatch({ input: source, output: output().stream, controller: {}, adapter: {} });
  assert.equal(decision.reason, 'input_invalid'); assert.equal(consumed, 0); assert.equal(source.destroyed, true);
});

test('output I/O failure degrades without unhandled error or replaying feedback', async (t) => {
  const f = await fixture(t);
  const stream = new Writable({ write(chunk, encoding, done) { done(new Error('fixture I/O failure')); } });
  assert.equal((await runCompletionDispatch({ input: input(f.event), output: stream, controller: f.host, adapter: f.adapter })).action, 'degraded');
  await delay(10); assert.equal((await f.store.read(f.key)).state.budget.used, 1);
});

test('stalled feedback output is destroyed at the shared deadline with listeners released', async (t) => {
  const f = await fixture(t); const started = performance.now();
  const stream = new Writable({ write() {} });
  const decision = await runCompletionDispatch({ input: input(f.event), output: stream, controller: f.host, adapter: f.adapter });
  assert.equal(decision.reason, 'deadline'); assert.ok(performance.now() - started < 1300);
  assert.equal(stream.destroyed, true); await delay(10);
  assert.equal(stream.listenerCount('error'), 0); assert.equal(stream.listenerCount('close'), 0);
  assert.equal((await f.store.read(f.key)).state.budget.used, 1);
});

test('never-ending stdin is cancelled at the one-second deadline without feedback', async () => {
  const source = new Readable({ read() {} }); const out = output(); const started = performance.now();
  const decision = await runCompletionDispatch({ input: source, output: out.stream, controller: {}, adapter: {} });
  const elapsed = performance.now() - started;
  assert.equal(decision.reason, 'deadline'); assert.ok(elapsed >= 900 && elapsed < 1300, `elapsed ${elapsed}`);
  assert.equal(source.destroyed, true); assert.equal(source.listenerCount('readable'), 0); assert.equal(out.text(), '');
});

test('late adapter return after the deadline cannot start store mutation or feedback', async (t) => {
  const f = await fixture(t); const out = output(); const started = performance.now();
  const adapter = { async observe() { await delay(1150); return { status: 'ok', key: f.key, kind: 'stop' }; } };
  const decision = await runCompletionDispatch({ input: input(f.event), output: out.stream, controller: f.host, adapter });
  assert.equal(decision.reason, 'deadline'); assert.ok(performance.now() - started < 1300);
  await delay(220);
  assert.equal(out.text(), ''); assert.equal((await f.store.read(f.key)).state.budget.used, 0);
});

test('Stop cannot turn a trusted ordinary user observation into a new generation', async (t) => {
  const f = await fixture(t); const out = output();
  const event = { fixtureEvent: { kind: 'user', nativeEventId: 'new-event', sessionId: 'session', workspaceId: 'workspace' } };
  assert.equal((await runCompletionDispatch({ input: input(event), output: out.stream, controller: f.host, adapter: f.adapter })).reason, 'coverage_unknown');
  assert.equal((await f.store.read(f.key)).state.key.generation, 1); assert.equal(out.text(), '');
});

test('a second intervention requires real progress and the third cannot exceed the two-use budget', async (t) => {
  const f = await fixture(t);
  const stop = () => runCompletionDispatch({ input: input(f.event), output: output().stream, controller: f.host, adapter: f.adapter });
  assert.equal((await stop()).remaining, 1);
  await f.store.transaction(f.key, (state) => { state.items[0].status = 'running'; });
  assert.equal((await stop()).remaining, 0);
  await f.store.transaction(f.key, (state) => { state.items[1].status = 'running'; });
  assert.equal((await stop()).reason, 'budget_exhausted');
  assert.equal((await f.store.read(f.key)).state.budget.used, 2);
});

test('deadline starts before stdin reading and cannot restart at adapter resolution', async (t) => {
  const f = await fixture(t); const out = output(); const started = performance.now();
  const source = new Readable({ read() {} });
  const feeder = setTimeout(() => { source.push(Buffer.from(JSON.stringify(f.event))); source.push(null); }, 550);
  t.after(() => clearTimeout(feeder));
  const adapter = { async observe(payload, options) { await delay(650); return f.adapter.observe(payload, options); } };
  const decision = await runCompletionDispatch({ input: source, output: out.stream, controller: f.host, adapter });
  assert.equal(decision.reason, 'deadline'); assert.ok(performance.now() - started < 1300);
  await delay(250); assert.equal((await f.store.read(f.key)).state.budget.used, 0); assert.equal(out.text(), '');
});

test('a late checkpoint reader is closed on abort and cannot produce late feedback or state mutation', async (t) => {
  const f = await fixture(t); const file = path.join(f.root, 'slow-checkpoint');
  const checkpoint = Buffer.from(JSON.stringify({ version: 1, kind: 'update', items: [] }));
  await fs.writeFile(file, checkpoint, { mode: 0o600 });
  const open = fs.open; let ownedHandle;
  fs.open = async (...args) => {
    const handle = await open(...args);
    if (args[0] !== file) return handle;
    ownedHandle = handle;
    return { stat: (...parameters) => handle.stat(...parameters), close: () => handle.close(),
      async read(...parameters) { const result = await handle.read(...parameters); await delay(1150); return result; } };
  };
  t.after(() => { fs.open = open; });
  const event = { fixtureEvent: { kind: 'stop', key: f.key, checkpointTail: { path: file, offset: 0, length: checkpoint.length } } };
  const out = output();
  assert.equal((await runCompletionDispatch({ input: input(event), output: out.stream, controller: f.host, adapter: f.adapter })).reason, 'deadline');
  await assert.rejects(ownedHandle.stat(), { code: 'EBADF' });
  await delay(220); assert.equal(out.text(), ''); assert.equal((await f.store.read(f.key)).state.budget.used, 0);
});

test('slow real-store callback receives shared cancellation and cannot commit late', async (t) => {
  const f = await fixture(t); const out = output();
  const host = { transaction(key, fn, options) {
    return f.store.transaction(key, async (state) => { await delay(1150); return fn(state); }, options);
  } };
  const decision = await runCompletionDispatch({ input: input(f.event), output: out.stream, controller: host, adapter: f.adapter });
  assert.equal(decision.reason, 'deadline'); await delay(220);
  assert.equal(out.text(), ''); assert.equal((await f.store.read(f.key)).state.budget.used, 0);
  assert.deepEqual((await fs.readdir(f.root)).filter((name) => name.endsWith('.tmp') || name.endsWith('.lock')), []);
});

test('checkpoint reads only an explicitly bounded positional tail and never stores model text', async (t) => {
  const f = await fixture(t); const file = path.join(f.root, 'transcript');
  const checkpoint = Buffer.from(JSON.stringify({ version: 1, kind: 'update', items: [{ itemId: 'item1', status: 'verified', receiptIds: [] }] }));
  await fs.writeFile(file, Buffer.concat([Buffer.alloc(100000, 120), checkpoint]), { mode: 0o600 });
  const open = fs.open; const reads = [];
  fs.open = async (...args) => {
    const handle = await open(...args);
    if (args[0] !== file) return handle;
    return { stat: (...parameters) => handle.stat(...parameters), close: () => handle.close(),
      read(...parameters) { reads.push({ length: parameters[2], position: parameters[3] }); return handle.read(...parameters); } };
  };
  t.after(() => { fs.open = open; });
  const event = { fixtureEvent: { kind: 'stop', key: f.key, checkpointTail: { path: file, offset: 100000, length: checkpoint.length } } };
  const out = output();
  const decision = await runCompletionDispatch({ input: input(event), output: out.stream, controller: f.host, adapter: f.adapter });
  assert.equal(decision.action, 'continue');
  assert.deepEqual(reads, [{ length: checkpoint.length, position: 100000 }]);
  const state = (await f.store.read(f.key)).state;
  assert.equal(state.items[0].status, 'pending');
  assert.deepEqual(state.items[0].proposal, { status: 'verified', receiptIds: [] });
  assert.equal(state.receipts.length, 0);
  const invalid = { fixtureEvent: { kind: 'stop', key: f.key, checkpointTail: { path: file, offset: 0, length: 8193 } } };
  assert.equal((await runCompletionDispatch({ input: input(invalid), output: output().stream, controller: f.host, adapter: f.adapter })).reason, 'checkpoint_unknown');
});

test('first declare checkpoint creates only model proposals and reconciles at most once', async (t) => {
  const f = await fixture(t); const file = path.join(f.root, 'first-checkpoint');
  await f.store.transaction(f.key, (state) => {
    state.items = []; state.executionTask = false; state.safeWorkRemaining = false; state.checkpointPresent = false;
  });
  const bytes = Buffer.from(JSON.stringify({ version: 1, kind: 'declare', items: [{ ordinal: 1, category: 'verification' }] }));
  await fs.writeFile(file, bytes, { mode: 0o600 });
  const event = { fixtureEvent: { kind: 'stop', key: f.key, checkpointTail: { path: file, offset: 0, length: bytes.length } } };
  const out = output();
  const decision = await runCompletionDispatch({ input: input(event), output: out.stream, controller: f.host, adapter: f.adapter });
  assert.equal(decision.reason, 'reconciliation_required'); assert.equal(decision.action, 'continue');
  assert.deepEqual(decision.itemIds, []);
  const state = (await f.store.read(f.key)).state;
  assert.equal(state.items.length, 1); assert.equal(state.items[0].source, 'model-proposed');
  assert.equal(state.items[0].status, 'pending'); assert.equal(state.items[0].mustFinish, false);
  assert.equal(state.items[0].ordinal, 1); assert.equal(state.items[0].category, 'verification');
  assert.match(state.items[0].itemId, /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/);
  assert.deepEqual(state.items[0].requiredTargetIds, []); assert.deepEqual(state.items[0].receiptIds, []);
  assert.deepEqual(state.receipts, []); assert.equal(state.budget.unknownReconciled, true);
  await f.store.transaction(f.key, (live) => { live.revision = 'progress2'; });
  const again = output();
  assert.equal((await runCompletionDispatch({ input: input(event), output: again.stream, controller: f.host, adapter: f.adapter })).reason, 'unknown_reconciled');
  const repeated = (await f.store.read(f.key)).state;
  assert.equal(repeated.items[0].itemId, state.items[0].itemId); assert.equal(repeated.items.length, 1);
  assert.equal(repeated.budget.used, 1); assert.equal(again.text(), '');
});

test('declare ordinal/category conflict rejects the whole transaction without budget debit', async (t) => {
  const f = await fixture(t); const file = path.join(f.root, 'conflicting-checkpoint');
  await f.store.transaction(f.key, (state) => { state.items.push({ itemId: 'proposal1', ordinal: 1,
    category: 'implementation', source: 'model-proposed', status: 'pending', mustFinish: false, requiredTargetIds: [], receiptIds: [] }); });
  const bytes = Buffer.from(JSON.stringify({ version: 1, kind: 'declare', items: [
    { ordinal: 2, category: 'verification' }, { ordinal: 1, category: 'report' },
  ] }));
  await fs.writeFile(file, bytes, { mode: 0o600 });
  const event = { fixtureEvent: { kind: 'stop', key: f.key, checkpointTail: { path: file, offset: 0, length: bytes.length } } };
  const out = output();
  assert.equal((await runCompletionDispatch({ input: input(event), output: out.stream, controller: f.host, adapter: f.adapter })).action, 'degraded');
  const state = (await f.store.read(f.key)).state;
  assert.equal(state.items.length, 5); assert.equal(state.items[4].category, 'implementation');
  assert.equal(state.budget.used, 0); assert.equal(out.text(), '');
});

test('declare cannot exceed the single ledger item capacity', async (t) => {
  const f = await fixture(t); const file = path.join(f.root, 'capacity-checkpoint');
  await f.store.transaction(f.key, (state) => { state.items.push(...Array.from({ length: 60 }, (_, id) => ({
    itemId: `extra${id}`, contractId: `extra-contract${id}`, category: 'implementation', source: 'accepted-plan',
    status: 'pending', mustFinish: true, requiredTargetIds: [], receiptIds: [],
  }))); });
  const bytes = Buffer.from(JSON.stringify({ version: 1, kind: 'declare', items: [{ ordinal: 1, category: 'verification' }] }));
  await fs.writeFile(file, bytes, { mode: 0o600 });
  const event = { fixtureEvent: { kind: 'stop', key: f.key, checkpointTail: { path: file, offset: 0, length: bytes.length } } };
  const out = output();
  assert.equal((await runCompletionDispatch({ input: input(event), output: out.stream, controller: f.host, adapter: f.adapter })).action, 'degraded');
  const state = (await f.store.read(f.key)).state;
  assert.equal(state.items.length, 64); assert.equal(state.budget.used, 0); assert.equal(out.text(), '');
});

test('fresh Stop import and execution cannot load audit Keychain or spawn dependencies', async (t) => {
  const source = `
    import { registerHooks } from 'node:module';
    import { parentPort } from 'node:worker_threads';
    import { Readable, Writable } from 'node:stream';
    registerHooks({ resolve(specifier, context, next) {
      if (/audit|keychain|child_process/.test(specifier)) throw new Error('forbidden Stop dependency');
      return next(specifier, context);
    } });
    const { runCompletionDispatch } = await import(${JSON.stringify(new URL('../src/completion/dispatch.mjs', import.meta.url).href)});
    const decision = await runCompletionDispatch({
      input: Readable.from([Buffer.from('{}')], { objectMode: false }),
      output: new Writable({ write(chunk, encoding, done) { done(); } }), controller: {}, adapter: {},
    });
    parentPort.postMessage(decision.reason);
  `;
  const worker = new Worker(new URL(`data:text/javascript,${encodeURIComponent(source)}`));
  t.after(() => worker.terminate());
  const reason = await new Promise((resolve, reject) => { worker.once('message', resolve); worker.once('error', reject); });
  assert.equal(reason, 'coverage_unknown');
});
