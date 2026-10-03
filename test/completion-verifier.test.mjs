import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createCompletionController } from '../src/completion/controller.mjs';
import { createCompletionStore } from '../src/completion/store.mjs';
import { evaluateCompletion, hasVerifiedTargets } from '../src/completion/evaluator.mjs';

const module = await import('../src/completion/verifier.mjs').catch((error) => {
  if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
  return {};
});
const key = { sessionId: 'session1', workspaceId: 'workspace1', requestId: 'request1', generation: 1 };
const item = { itemId: 'item1' };

async function fixture(t, options = {}) {
  assert.equal(typeof module.createOwnedVerifier, 'function', 'owned verifier factory is implemented');
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'completion-verifier-'));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  await fs.writeFile(path.join(workspace, 'source.mjs'), 'export const value = 1;\n');
  const target = { id: 'test-1', executable: process.execPath, argv: ['-e', 'process.exit(0)'],
    cwd: workspace, files: ['source.mjs'], timeoutMs: 1000, sideEffectFree: true };
  const verifier = module.createOwnedVerifier({ authorize: async () => true, ...options });
  return { workspace, target, verifier, run: (overrides = {}) => verifier.run({ key, item, target, ...overrides }) };
}

async function ready(file) {
  for (let attempt = 0; attempt < 200; attempt++) {
    try { return await fs.readFile(file, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await delay(5);
  }
  assert.fail('owned child did not become ready');
}

test('exit zero binds opaque IDs and a content revision to the owned execution', async (t) => {
  const { run } = await fixture(t, { clock: () => 42 });
  const first = await run();
  const second = await run();
  assert.equal(first.receipt.result, 'verified');
  assert.equal(first.receipt.targetId, 'test-1');
  assert.equal(first.receipt.executionId, first.executionId);
  assert.match(first.executionId, /^[A-Za-z0-9_-]{1,128}$/);
  assert.match(first.receipt.revision, /^[A-Za-z0-9_-]{1,128}$/);
  assert.notEqual(first.executionId, second.executionId);
  assert.notEqual(first.receipt.id, second.receipt.id);
  assert.equal(first.receipt.revision, second.receipt.revision);
  assert.equal(first.receipt.startedAt, 42);
  assert.equal(first.receipt.endedAt, 42);
});

test('permission denial never starts the command or manufactures a receipt', async (t) => {
  const { workspace, target, run } = await fixture(t, { authorize: async ({ key: supplied, target: accepted }) => {
    assert.deepEqual(supplied, key);
    assert.equal(accepted.id, 'test-1');
    return false;
  } });
  target.argv = ['-e', 'require("node:fs").writeFileSync("spawned", "yes")'];
  assert.equal((await run()).status, 'unknown');
  await assert.rejects(fs.access(path.join(workspace, 'spawned')), { code: 'ENOENT' });
});

test('unsafe contract and authority failures cannot launch a child', async (t) => {
  for (const options of [{ authorize: async () => { throw new Error('secret authority failure'); } },
    { authorize: async () => 'yes' }, {}]) {
    const { workspace, target, run } = await fixture(t, options);
    target.argv = ['-e', 'require("node:fs").writeFileSync("spawned", "yes")'];
    if (!options.authorize) target.sideEffectFree = false;
    const result = await run();
    assert.equal(result.status, 'unknown');
    assert.equal(result.receipt, undefined);
    await assert.rejects(fs.access(path.join(workspace, 'spawned')), { code: 'ENOENT' });
    assert.equal(JSON.stringify(result).includes('secret'), false);
  }
});

test('malformed accepted targets fail closed before launch', async (t) => {
  const { workspace, target, run } = await fixture(t);
  target.argv = ['-e', 'require("node:fs").writeFileSync("spawned", "yes")'];
  for (const overrides of [{ files: [] }, { files: ['source.mjs', 'source.mjs'] }, { files: ['/source.mjs'] },
    { timeoutMs: 0 }, { timeoutMs: 2147483648 }, { argv: [null] }, { executable: '' }]) {
    assert.equal((await run({ target: { ...target, ...overrides } })).status, 'unknown');
  }
  await assert.rejects(fs.access(path.join(workspace, 'spawned')), { code: 'ENOENT' });
});

test('abort while authority is pending never launches after authority later approves', async (t) => {
  let approve;
  const { workspace, target, run } = await fixture(t, { authorize: () => new Promise((resolve) => { approve = resolve; }) });
  target.argv = ['-e', 'require("node:fs").writeFileSync("spawned", "yes")'];
  const abort = new AbortController();
  const pending = run({ signal: abort.signal });
  await delay(5);
  abort.abort();
  assert.equal((await pending).status, 'unknown');
  approve(true);
  await delay(20);
  await assert.rejects(fs.access(path.join(workspace, 'spawned')), { code: 'ENOENT' });
});

test('one deadline bounds authorization and owned execution together', async (t) => {
  const { target, run } = await fixture(t, { authorize: async () => { await delay(150); return true; } });
  target.timeoutMs = 200;
  target.argv = ['-e', 'setTimeout(() => process.exit(0), 150)'];
  assert.equal((await run()).receipt.result, 'failed');
});

test('exit one fails even when stdout claims PASS and no output or command is returned', async (t) => {
  const { target, run } = await fixture(t);
  target.argv = ['-e', 'console.log("PASS secret-output"); console.error("secret-error"); process.exit(1)'];
  const result = await run();
  assert.equal(result.receipt.result, 'failed');
  for (const secret of ['process.exit', 'secret-output', 'secret-error', target.cwd, 'source.mjs']) {
    assert.equal(JSON.stringify(result).includes(secret), false);
  }
  assert.deepEqual(Object.keys(result).sort(), ['executionId', 'receipt']);
  assert.deepEqual(Object.keys(result.receipt).sort(), ['endedAt', 'executionId', 'id', 'result', 'revision', 'startedAt', 'targetId']);
});

test('a child terminated by its own signal cannot verify', async (t) => {
  const { target, run } = await fixture(t);
  target.argv = ['-e', 'process.kill(process.pid, "SIGTERM")'];
  assert.equal((await run()).receipt.result, 'failed');
});

test('spawn failure cannot verify or disclose its executable', async (t) => {
  const { workspace, target, run } = await fixture(t);
  target.executable = path.join(workspace, 'missing-secret-executable');
  const result = await run();
  assert.equal(result.receipt.result, 'unknown');
  assert.equal(JSON.stringify(result).includes('missing-secret'), false);
});

test('timeout awaits terminal death even when the owned child ignores SIGTERM', async (t) => {
  const { workspace, target, run } = await fixture(t);
  target.timeoutMs = 150;
  target.argv = ['-e', 'process.on("SIGTERM", () => {}); require("node:fs").writeFileSync("ready", String(process.pid)); setInterval(() => {}, 1000)'];
  const pending = run();
  const pid = Number(await ready(path.join(workspace, 'ready')));
  assert.equal((await pending).receipt.result, 'failed');
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});

test('cancellation awaits terminal death and cannot leave a verified receipt', async (t) => {
  const { workspace, target, run } = await fixture(t);
  const abort = new AbortController();
  target.argv = ['-e', 'process.on("SIGTERM", () => {}); require("node:fs").writeFileSync("ready", String(process.pid)); setInterval(() => {}, 1000)'];
  const pending = run({ signal: abort.signal });
  const pid = Number(await ready(path.join(workspace, 'ready')));
  abort.abort();
  assert.equal((await pending).receipt.result, 'cancelled');
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});

test('an already aborted signal refuses to spawn', async (t) => {
  const { workspace, target, run } = await fixture(t);
  const abort = new AbortController();
  abort.abort();
  target.argv = ['-e', 'require("node:fs").writeFileSync("spawned", "yes")'];
  assert.equal((await run({ signal: abort.signal })).status, 'unknown');
  await assert.rejects(fs.access(path.join(workspace, 'spawned')), { code: 'ENOENT' });
});

test('argv stays literal instead of being interpreted by a shell', async (t) => {
  const { workspace, target, run } = await fixture(t);
  target.argv = ['-e', 'process.exit(process.argv[1] === "; touch injected" ? 0 : 1)', '; touch injected'];
  assert.equal((await run()).receipt.result, 'verified');
  await assert.rejects(fs.access(path.join(workspace, 'injected')), { code: 'ENOENT' });
});

test('source mutation during verification makes a zero exit stale', async (t) => {
  const { target, run } = await fixture(t);
  target.argv = ['-e', 'require("node:fs").writeFileSync("source.mjs", "changed during verification")'];
  assert.equal((await run()).receipt.result, 'stale');
});

test('post-execution unreadable revision cannot turn exit zero into verification', async (t) => {
  const { target, run } = await fixture(t);
  target.argv = ['-e', 'const fs = require("node:fs"); fs.unlinkSync("source.mjs"); fs.symlinkSync("/", "source.mjs")'];
  assert.equal((await run()).receipt.result, 'unknown');
});

test('dirty and untracked content changes invalidate the observed revision', async (t) => {
  const { workspace, target, verifier, run } = await fixture(t);
  const git = (argv) => execFileSync('git', ['-c', 'user.name=Completion Fixture', '-c', 'user.email=fixture@example.invalid',
    '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...argv], { cwd: workspace, encoding: 'utf8' });
  git(['init', '--quiet']);
  git(['add', 'source.mjs']);
  git(['commit', '--quiet', '-m', 'fixture source']);
  await fs.writeFile(path.join(workspace, 'untracked.mjs'), 'untracked v1');
  target.files.push('untracked.mjs');
  const initial = (await run()).receipt.revision;
  await fs.writeFile(path.join(workspace, 'source.mjs'), 'dirty v2');
  const gitStatus = git(['status', '--porcelain']);
  assert.ok(gitStatus.includes(' M source.mjs'));
  assert.ok(gitStatus.includes('?? untracked.mjs'));
  const dirty = await verifier.observeRevision({ key, target });
  assert.equal(dirty.status, 'ok');
  assert.notEqual(dirty.revision, initial);
  await fs.writeFile(path.join(workspace, 'untracked.mjs'), 'untracked v2');
  const untracked = await verifier.observeRevision({ key, target });
  assert.notEqual(untracked.revision, dirty.revision);
  assert.equal(untracked.targetId, 'test-1');
  assert.equal(JSON.stringify(untracked).includes(workspace), false);
});

test('revision includes path tokens and missing files, with order independent hashing', async (t) => {
  const { workspace, target, verifier } = await fixture(t);
  await fs.writeFile(path.join(workspace, 'other.mjs'), 'export const value = 1;\n');
  const observe = () => verifier.observeRevision({ key, target });
  const source = await observe();
  target.files = ['other.mjs'];
  assert.notEqual((await observe()).revision, source.revision);
  target.files = ['source.mjs', 'other.mjs'];
  const ordered = await observe();
  target.files.reverse();
  assert.equal((await observe()).revision, ordered.revision);
  target.files.push('absent.mjs');
  const missing = await observe();
  assert.equal(missing.status, 'ok');
  await fs.writeFile(path.join(workspace, 'absent.mjs'), '');
  assert.notEqual((await observe()).revision, missing.revision);
});

test('symlinks, traversal, directories and unreadable sources cannot verify or spawn', async (t) => {
  const { workspace, target, verifier, run } = await fixture(t);
  await fs.mkdir(path.join(workspace, 'directory'));
  await fs.symlink(os.tmpdir(), path.join(workspace, 'escape'));
  await fs.symlink('source.mjs', path.join(workspace, 'linked.mjs'));
  await fs.writeFile(path.join(workspace, 'unreadable.mjs'), 'private', { mode: 0 });
  target.argv = ['-e', 'require("node:fs").writeFileSync("spawned", "yes")'];
  for (const file of ['escape/source.mjs', 'linked.mjs', '../source.mjs', 'directory', 'unreadable.mjs']) {
    target.files = [file];
    assert.equal((await run()).status, 'unknown', file);
    assert.equal((await verifier.observeRevision({ key, target })).status, 'unknown', file);
  }
  await assert.rejects(fs.access(path.join(workspace, 'spawned')), { code: 'ENOENT' });
});

test('normal workflow observation refuses an aborted read and does not execute the target', async (t) => {
  const { workspace, target, verifier } = await fixture(t);
  target.argv = ['-e', 'require("node:fs").writeFileSync("spawned", "yes")'];
  const abort = new AbortController();
  abort.abort();
  assert.equal((await verifier.observeRevision({ key, target, signal: abort.signal })).status, 'unknown');
  assert.equal((await verifier.observeRevision({ key, target })).status, 'ok');
  await assert.rejects(fs.access(path.join(workspace, 'spawned')), { code: 'ENOENT' });
});

test('real controller and store invalidate a receipt after a test-only host applies an observation', async (t) => {
  const { workspace, target, verifier } = await fixture(t);
  const store = createCompletionStore({ root: path.join(workspace, 'ledger') });
  const acceptance = { contractId: 'contract1', category: 'verification', mustFinish: true,
    requiredTargetIds: ['test-1'], targets: [target] };
  // Test-only trusted host composition. Native observation ingestion is Task 5.
  const controller = createCompletionController({ store, verifier, acceptedContracts: new Set([acceptance]),
    routeJoin: { resolve: async (_, boundKey) => ({ status: 'ok', key: boundKey,
      providerId: 'fixture-provider', modelId: 'gpt-6', modelFamily: 'gpt' }) } });
  const started = await controller.beginRequest({ kind: 'user', nativeEventId: 'event1', sessionId: 's1', workspaceId: 'w1' });
  const task = await controller.registerTask(started.requestId, acceptance);
  await controller.bindRoute(started.requestId, {});
  const result = await controller.runVerification(started.requestId, task.itemId, target.id);
  assert.equal(result.status, 'ok');
  const before = await controller.snapshot(started.requestId);
  assert.equal(hasVerifiedTargets(before.items[0], before), true);
  assert.deepEqual(before.receipts[0].key, started.key);
  assert.equal(before.receipts[0].itemId, task.itemId);
  await fs.writeFile(path.join(workspace, 'source.mjs'), 'changed after PASS');
  const observation = await verifier.observeRevision({ key: started.key, target });
  const transaction = await store.transaction(started.key, (state) => {
    state.revision = observation.revision;
    state.verifierCoverage = 'unknown';
    state.coverage = 'unknown';
    state.enabled = true;
    state.mode = 'enforce';
  });
  assert.equal(transaction.status, 'ok');
  const after = await controller.snapshot(started.requestId);
  assert.equal(hasVerifiedTargets(after.items[0], after), false);
  assert.equal(after.receipts[0].result, 'verified');
  assert.notEqual(after.receipts[0].revision, after.revision);
  assert.equal(evaluateCompletion(after).reason, 'coverage_unknown');
  // Snapshot reads only the persisted observation; no Stop-time workspace scan.
  await fs.writeFile(path.join(workspace, 'source.mjs'), 'another unobserved change');
  assert.equal((await controller.snapshot(started.requestId)).revision, observation.revision);
  assert.equal((await controller.snapshot(started.requestId)).coverage, 'unknown');
});
