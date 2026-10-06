import assert from 'node:assert/strict';
import childProcess, { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { syncBuiltinESMExports } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
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

async function stalledObservation(t) {
  const fixtureState = await fixture(t);
  const { workspace } = fixtureState;
  const marker = path.join(workspace, 'observer-pid');
  const finished = path.join(workspace, 'observation-finished');
  const preload = path.join(workspace, 'stall-observation.mjs');
  const originalRealpath = fs.realpath;
  const stall = async (...args) => {
    await fs.writeFile(marker, String(process.pid));
    await delay(1400);
    await fs.writeFile(finished, 'unexpected abandoned work');
    return originalRealpath(...args);
  };
  // Original implementation ran reads in the host; future owned child loads
  // the same stalled real dependency, rather than bypassing the regression.
  t.mock.method(fs, 'realpath', stall);
  await fs.writeFile(preload, `import fs from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
const original = fs.promises.realpath;
fs.promises.realpath = async (...args) => {
  await fs.promises.writeFile(${JSON.stringify(marker)}, String(process.pid));
  await delay(1400);
  await fs.promises.writeFile(${JSON.stringify(finished)}, 'unexpected abandoned work');
  return original(...args);
};\n`);
  const originalSpawn = childProcess.spawn;
  const children = [];
  const patchedSpawn = t.mock.method(childProcess, 'spawn', (executable, argv, options) => {
    const child = originalSpawn(executable, ['--import', preload, ...argv], options);
    children.push(child);
    return child;
  });
  syncBuiltinESMExports();
  t.after(() => {
    patchedSpawn.mock.restore();
    syncBuiltinESMExports();
  });
  return { ...fixtureState, marker, finished, preload, originalSpawn, children };
}

test('cancellation terminates and awaits a stalled observation instead of abandoning I/O', async (t) => {
  const { marker, finished, verifier, target } = await stalledObservation(t);
  const abort = new AbortController();
  const pending = verifier.observeRevision({ key, target, signal: abort.signal });
  const pid = Number(await ready(marker));
  const stoppedAt = performance.now();
  abort.abort();
  const result = await pending;
  assert.equal(result.status, 'unknown');
  assert.ok(performance.now() - stoppedAt < 500, 'abort must not await the 1400ms stalled read');
  assert.notEqual(pid, process.pid, 'filesystem I/O must belong to an owned observer child');
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  await assert.rejects(fs.access(finished), { code: 'ENOENT' });
});

test('run deadline terminates and awaits stalled pre-observation without starting the target', async (t) => {
  const { workspace, marker, finished, target, run } = await stalledObservation(t);
  target.timeoutMs = 500;
  target.argv = ['-e', 'require("node:fs").writeFileSync("spawned", "yes")'];
  const startedAt = performance.now();
  const pending = run();
  const pid = Number(await ready(marker));
  const result = await pending;
  assert.equal(result.status, 'unknown');
  assert.ok(performance.now() - startedAt < 1000, 'deadline must not await the 1400ms stalled read');
  assert.notEqual(pid, process.pid, 'filesystem I/O must belong to an owned observer child');
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  await assert.rejects(fs.access(finished), { code: 'ENOENT' });
  await assert.rejects(fs.access(path.join(workspace, 'spawned')), { code: 'ENOENT' });
});

test('observer exits pending I/O when its owning IPC connection shuts down', async (t) => {
  const { target, marker, finished, preload, originalSpawn } = await stalledObservation(t);
  const entry = fileURLToPath(new URL('../src/completion/verifier.mjs', import.meta.url));
  const child = originalSpawn(process.execPath, ['--import', preload, entry, '--completion-observer'],
    { shell: false, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  const terminal = new Promise((resolve) => child.once('exit', resolve));
  child.send({ cwd: target.cwd, files: target.files, deadline: Date.now() + 5000 });
  const pid = Number(await ready(marker));
  const stoppedAt = performance.now();
  child.disconnect();
  await terminal;
  assert.ok(performance.now() - stoppedAt < 500, 'owner shutdown must not await the stalled read');
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  await assert.rejects(fs.access(finished), { code: 'ENOENT' });
});

test('malformed or disconnected observer replies terminate the owned child without disclosing data', async (t) => {
  for (const mode of ['malformed', 'disconnected']) {
    await t.test(mode, async (t) => {
      const { target, verifier } = await fixture(t);
      const originalSpawn = childProcess.spawn;
      let pid;
      const script = `process.once('message', () => {
        ${mode === 'malformed' ? 'process.send({status:"ok",revision:"secret source contents",path:"secret path"})' : 'process.disconnect()'};
        setInterval(() => {}, 1000);
      });`;
      const patched = t.mock.method(childProcess, 'spawn', (executable, argv, options) => {
        const child = originalSpawn(process.execPath, ['-e', script], options);
        pid = child.pid;
        return child;
      });
      syncBuiltinESMExports();
      t.after(() => { patched.mock.restore(); syncBuiltinESMExports(); });
      const result = await verifier.observeRevision({ key, target });
      assert.equal(result.status, 'unknown');
      assert.equal(JSON.stringify(result).includes('secret'), false);
      assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    });
  }
});

test('observer ignores ambient Node preloads and ordinary imports never enter worker mode', async (t) => {
  const { workspace, target, verifier } = await fixture(t);
  const marker = path.join(workspace, 'ambient-loaded');
  const preload = path.join(workspace, 'ambient.mjs');
  await fs.writeFile(preload, `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(marker)}, 'bad preload');`);
  const previous = process.env.NODE_OPTIONS;
  process.env.NODE_OPTIONS = `--import=${preload}`;
  try {
    assert.equal((await verifier.observeRevision({ key, target })).status, 'ok');
    await assert.rejects(fs.access(marker), { code: 'ENOENT' });
  } finally {
    if (previous === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = previous;
  }
  const imported = execFileSync(process.execPath, ['--input-type=module', '-e',
    `await import(${JSON.stringify(new URL('../src/completion/verifier.mjs', import.meta.url).href)}); console.log(process.listenerCount('message'));`],
  { encoding: 'utf8' });
  assert.equal(imported.trim(), '0');
});

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

test('pre-observation expiry has no execution receipt and awaits its owned observer', async (t) => {
  const { workspace, target, run, finished, children } = await stalledObservation(t);
  target.timeoutMs = 200;
  target.argv = ['-e', 'require("node:fs").writeFileSync("spawned", "yes"); setTimeout(() => process.exit(0), 150)'];
  const result = await run();
  assert.deepEqual(result, { status: 'unknown' });
  assert.equal(result.receipt, undefined);
  assert.equal(children.length, 1, 'the real observer must be launched, but the target must not');
  const [{ pid, signalCode }] = children;
  assert.notEqual(pid, process.pid);
  assert.equal(signalCode, 'SIGKILL');
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  await assert.rejects(fs.access(finished), { code: 'ENOENT' });
  await assert.rejects(fs.access(path.join(workspace, 'spawned')), { code: 'ENOENT' });
  assert.equal(JSON.stringify(result).includes(workspace), false);
});

// Only deadline scheduling is virtual. The children, filesystem reads, IPC,
// signal delivery, and terminal events remain real and separately wall-bounded.
async function logicalDeadlines(t, { timeoutMs, argv }, exercise) {
  let approve;
  let authorityEntered;
  const entered = new Promise((resolve) => { authorityEntered = resolve; });
  const { workspace, target, run } = await fixture(t, { authorize: () => {
    authorityEntered();
    return new Promise((resolve) => { approve = resolve; });
  } });
  const clockFile = path.join(workspace, 'logical-clock');
  const preload = path.join(workspace, 'observer-clock.mjs');
  const now = 1_000_000;
  await fs.writeFile(clockFile, String(now));
  await fs.writeFile(preload, `import fs from 'node:fs';
Date.now = () => Number(fs.readFileSync(${JSON.stringify(clockFile)}, 'utf8'));\n`);
  target.timeoutMs = timeoutMs;
  target.argv = argv;
  const originalSpawn = childProcess.spawn;
  const children = [];
  const patched = t.mock.method(childProcess, 'spawn', (executable, args, options) => {
    const observer = args.includes('--completion-observer');
    const child = originalSpawn(executable, observer ? ['--import', preload, ...args] : args, options);
    children.push({ child, observer, terminal: new Promise((resolve) => child.once('close', resolve)) });
    return child;
  });
  syncBuiltinESMExports();
  const wallSetTimeout = globalThis.setTimeout;
  const wallClearTimeout = globalThis.clearTimeout;
  const abort = new AbortController();
  let watchdog;
  let pending;
  let exercising;
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now });
  const logicalSetTimeout = globalThis.setTimeout;
  const deadlines = [];
  globalThis.setTimeout = (callback, milliseconds, ...args) => {
    deadlines.push(milliseconds);
    return logicalSetTimeout(callback, milliseconds, ...args);
  };
  const advance = async (milliseconds, at) => {
    await fs.writeFile(clockFile, String(now + at));
    t.mock.timers.tick(milliseconds);
  };
  try {
    exercising = (async () => {
      pending = run({ signal: abort.signal });
      await entered;
      await advance(150, 150);
      approve(true);
      const pid = Number(await ready(path.join(workspace, 'execution-ready')));
      assert.equal(children.length, 2, 'authorization and real pre-observation must reach execution');
      const [observation, execution] = children;
      assert.equal(observation.observer, true);
      assert.equal(observation.child.exitCode, 0);
      assert.equal(execution.observer, false);
      assert.equal(execution.child.pid, pid);
      process.kill(pid, 0);
      await exercise({ workspace, children, execution, pid, deadlines, advance, pending });
    })();
    await Promise.race([exercising, new Promise((_, reject) => {
      watchdog = wallSetTimeout(() => reject(new Error('real owned phases exceeded the wall-clock watchdog')), 3000);
    })]);
  } finally {
    wallClearTimeout(watchdog);
    abort.abort();
    for (const { child } of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
    await Promise.all(children.map(({ terminal }) => terminal));
    await pending?.catch(() => {});
    await exercising?.catch(() => {});
    globalThis.setTimeout = logicalSetTimeout;
    t.mock.timers.reset();
    patched.mock.restore();
    syncBuiltinESMExports();
  }
}

const gatedTarget = (ignoreTerm) => ['-e', `const fs = require('node:fs');
${ignoreTerm ? "process.on('SIGTERM', () => {});" : ''}
fs.writeFileSync('execution-ready', String(process.pid));
const wait = setInterval(() => {
  if (fs.existsSync('allow-success')) {
    fs.writeFileSync('late-success', 'unexpected abandoned execution');
    clearInterval(wait);
    process.exit(0);
  }
}, 5);`];

test('authorization and pre-observation share a bounded pre-phase while execution keeps its full timeout', async (t) => {
  await logicalDeadlines(t, { timeoutMs: 200, argv: gatedTarget(true) }, async ({ workspace, children, execution, pid, deadlines, advance, pending }) => {
    assert.deepEqual(deadlines, [200, 50, 200], 'authorization and observation share the pre-phase; execution starts its own full timeout');
    await advance(200, 350);
    await advance(100, 450); // The real target ignores SIGTERM; advance the owned SIGKILL grace.
    await execution.terminal;
    assert.equal(execution.child.signalCode, 'SIGKILL');
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    await fs.writeFile(path.join(workspace, 'allow-success'), 'yes');
    const result = await pending;
    assert.equal(result.receipt.result, 'failed');
    assert.equal(result.receipt.executionId, result.executionId);
    assert.equal(result.receipt.targetId, 'test-1');
    assert.equal(children.length, 2, 'an expired execution must not start a post-observer');
    await assert.rejects(fs.access(path.join(workspace, 'late-success')), { code: 'ENOENT' });
    for (const secret of [workspace, 'execution-ready', 'allow-success', 'late-success', 'process.exit']) {
      assert.equal(JSON.stringify(result).includes(secret), false);
    }
  });
});

test('a clean exit near its own timeout still verifies after a slow authorization', async (t) => {
  await logicalDeadlines(t, { timeoutMs: 200, argv: gatedTarget(false) }, async ({ workspace, children, advance, pending }) => {
    // 210ms into the run: past the old shared deadline, inside the command's own 200ms.
    await advance(60, 210);
    await fs.writeFile(path.join(workspace, 'allow-success'), 'yes');
    const result = await pending;
    assert.equal(result.receipt.result, 'verified');
    assert.equal(children.length, 3, 'a clean exit is followed by its own bounded post-observation');
    assert.equal(children[2].observer, true);
  });
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

async function gone(pid) {
  for (let attempt = 0; attempt < 200; attempt++) {
    try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') return; throw error; }
    await delay(5);
  }
  assert.fail(`descendant ${pid} survived the owned stop`);
}

// The direct child exits on SIGTERM while its grandchild ignores it, so only a
// group-wide stop that still escalates after the leader closes can reap both.
const forkingTarget = `const { spawn } = require('node:child_process');
const fs = require('node:fs');
const grandchild = spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'], { stdio: 'ignore' });
fs.writeFileSync('grandchild', String(grandchild.pid));
setInterval(() => {}, 1000);`;

for (const stopKind of ['timeout', 'cancellation']) {
  test(`${stopKind} stops the whole owned process group, not only the direct child`, async (t) => {
    const { workspace, target, run } = await fixture(t);
    const abort = new AbortController();
    target.timeoutMs = stopKind === 'timeout' ? 800 : 5000;
    target.argv = ['-e', forkingTarget];
    const pending = run({ signal: abort.signal });
    const grandchild = Number(await ready(path.join(workspace, 'grandchild')));
    t.after(() => { try { process.kill(grandchild, 'SIGKILL'); } catch { /* already reaped */ } });
    if (stopKind === 'cancellation') abort.abort();
    assert.equal((await pending).receipt.result, stopKind === 'timeout' ? 'failed' : 'cancelled');
    await gone(grandchild);
  });
}

test('a clean exit reaps descendants it leaves behind before the post-observation', async (t) => {
  const { workspace, target, run } = await fixture(t);
  target.argv = ['-e', forkingTarget.replace('setInterval(() => {}, 1000);', 'process.exit(0);')];
  const pending = run();
  const grandchild = Number(await ready(path.join(workspace, 'grandchild')));
  t.after(() => { try { process.kill(grandchild, 'SIGKILL'); } catch { /* already reaped */ } });
  assert.equal((await pending).receipt.result, 'verified');
  await gone(grandchild);
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
