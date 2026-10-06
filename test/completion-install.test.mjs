import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import { exportOssRelease, installProfile, loadCatalog, updateProfile } from '../src/airkit.mjs';
import { renderHeartbeatManagedFiles } from '../src/context-heartbeat.mjs';
import { createCompletionStore } from '../src/completion/store.mjs';
import { createCompletionController } from '../src/completion/controller.mjs';

async function temporary(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'completion-install-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
function hooks(files) { return JSON.parse(files.find((file) => file.relativePath.endsWith('/hooks/hooks.json')).content).hooks; }
async function writeManaged(files) {
  for (const file of files) { await fs.mkdir(path.dirname(file.path), { recursive: true }); await fs.writeFile(file.path, file.content); }
}
function probe(script, env, payload) {
  return spawnSync(process.execPath, [script], { env: { ...process.env, ...env }, input: JSON.stringify(payload), encoding: 'utf8', timeout: 3000 });
}

// Catch an unscoped opt-in, changed audit/context settings, or a parallel legacy Stop command.
test('shadow rendering adds exactly one dedicated Stop while preserving existing plugin hooks and settings', async (t) => {
  const root = await temporary(t);
  const off = renderHeartbeatManagedFiles(root);
  const shadow = renderHeartbeatManagedFiles(root, undefined, { completionMode: 'shadow' });
  const offHooks = hooks(off); const shadowHooks = hooks(shadow);
  assert.equal(offHooks.Stop, undefined);
  assert.equal(shadowHooks.Stop?.length, 1);
  assert.equal(shadowHooks.Stop[0].hooks.length, 1);
  assert.ok(JSON.stringify(shadowHooks.Stop).includes('completion/hook.mjs'));
  delete shadowHooks.Stop;
  assert.deepEqual(shadowHooks, offHooks);
  assert.equal(shadow.find((file) => file.relativePath.endsWith('/settings.json')).content,
    off.find((file) => file.relativePath.endsWith('/settings.json')).content);
  for (const mode of ['off', 'enforce', undefined]) {
    assert.equal(hooks(renderHeartbeatManagedFiles(root, undefined, { completionMode: mode })).Stop, undefined);
  }
});

// Catch missing explicit source copies: execute every exported completion module and the generated installed entrypoint.
test('exported runtime contains the full completion import closure and executes its generated shadow hook', async (t) => {
  const root = await temporary(t); const outDir = path.join(root, 'runtime');
  await exportOssRelease({ outDir });
  const sourceModules = (await fs.readdir(new URL('../src/completion/', import.meta.url))).filter((name) => name.endsWith('.mjs')).sort();
  const installedModules = (await fs.readdir(path.join(outDir, 'src/completion'))).sort();
  assert.deepEqual(installedModules, sourceModules);
  for (const name of installedModules) await import(pathToFileURL(path.join(outDir, 'src/completion', name)).href);
  const { renderHeartbeatManagedFiles: renderInstalled } = await import(pathToFileURL(path.join(outDir, 'src/context-heartbeat.mjs')).href);
  const files = renderInstalled(path.join(root, 'config'), undefined, { completionMode: 'shadow' });
  await writeManaged(files);
  const script = files.find((file) => file.relativePath.endsWith('/completion/hook.mjs'));
  assert.ok(script);
  const data = path.join(root, 'data'); await fs.mkdir(data);
  const installedProbe = probe(script.path, { CLAUDE_PLUGIN_DATA: data }, { hook_event_name: 'Stop', session_id: 'session', validatedContract: { status: 'validated' }, fixtureEvent: { kind: 'stop' } });
  assert.equal(installedProbe.status, 0, installedProbe.stderr);
  assert.equal(installedProbe.stdout, ''); assert.equal(installedProbe.stderr, '');
  assert.deepEqual(await fs.readdir(data), []);
  const directProbe = probe(path.join(outDir, 'src/completion/hook.mjs'), { CLAUDE_PLUGIN_DATA: data, AIRKIT_COMPLETION_MODE: 'enforce' }, {});
  assert.equal(directProbe.status, 0, directProbe.stderr);
  assert.equal(directProbe.stdout, '');
});

// Catch composition that lets a receipt or stdin model/decoder enable native blocking or debit a live request.
test('shadow hook keeps native coverage unknown even with a verified receipt in its shared ledger', async (t) => {
  const root = await temporary(t); const data = path.join(root, 'data'); await fs.mkdir(data);
  const store = createCompletionStore({ root: path.join(data, 'completion-v1') });
  const accepted = { contractId: 'contract', category: 'implementation', mustFinish: true, requiredTargetIds: ['target'], targets: [{ id: 'target', sideEffectFree: true, timeoutMs: 100 }] };
  const core = createCompletionController({ store, acceptedContracts: new Set([accepted]),
    verifier: { async run() { return { executionId: 'execution', receipt: { id: 'receipt', executionId: 'execution', targetId: 'target', revision: 'revision', result: 'verified', startedAt: 1, endedAt: 2 } }; } },
    routeJoin: { resolve(observation, key) { return { status: 'ok', key, providerId: 'provider', modelId: 'opaque-model', modelFamily: 'gpt' }; } } });
  const { key } = await core.beginRequest({ kind: 'user', nativeEventId: 'event', sessionId: 'session', workspaceId: 'workspace' });
  const item = await core.registerTask(key.requestId, accepted);
  await core.runVerification(key.requestId, item.itemId, 'target'); await core.bindRoute(key.requestId, {});
  assert.equal((await core.snapshot(key.requestId)).coverage, 'verified');
  const before = (await store.read(key)).state;
  const { runCompletionHook } = await import('../src/completion/hook.mjs');
  const chunks = []; const output = new Writable({ write(chunk, encoding, done) { chunks.push(chunk); done(); } });
  const decision = await runCompletionHook({ mode: 'shadow', env: { CLAUDE_PLUGIN_DATA: data },
    input: Readable.from([Buffer.from(JSON.stringify({ fixtureEvent: { kind: 'stop', key }, key, coverage: 'verified', modelFamily: 'gpt', mode: 'enforce', validatedContract: { status: 'validated' } }))], { objectMode: false }), output });
  assert.equal(decision.action, 'degraded'); assert.equal(decision.reason, 'coverage_unknown');
  assert.equal(chunks.length, 0); assert.deepEqual((await store.read(key)).state, before);
  for (const mode of ['off', 'enforce', undefined]) {
    const disabled = await runCompletionHook({ mode, input: { [Symbol.asyncIterator]() { throw new Error('disabled input consumed'); } }, output });
    assert.equal(disabled.reason, 'disabled');
  }
});

// Catch a second legacy ledger/budget in generated shadow heartbeat execution, and stale Stop registration on disable.
test('temporary profile install disables the parallel legacy budget and removes Stop on an off update', async (t) => {
  const root = await temporary(t); const catalog = await loadCatalog();
  const profile = catalog.profiles.find((candidate) => candidate.ccr && candidate.launch?.binary === 'claude');
  assert.ok(profile);
  const configDir = path.join(root, 'config');
  const installed = await installProfile(catalog, profile.name, { configDir, completionMode: 'shadow', write: true });
  const hookFile = installed.files.managedFiles.find((file) => file.path.endsWith('/hooks/hooks.json'));
  assert.equal(JSON.parse(await fs.readFile(hookFile.path, 'utf8')).hooks.Stop?.length, 1);
  const script = installed.files.managedFiles.find((file) => file.path.endsWith('/scripts/user-prompt-submit.mjs'));
  const data = path.join(root, 'data'); await fs.mkdir(data);
  const env = { CLAUDE_PLUGIN_DATA: data, AIRCLAUDE_PROFILE: profile.name, AIRCLAUDE_COMPLETION_GUARD_MAX_STOP_BLOCKS: '2', AIRCLAUDE_ACTIVE_MODEL: 'gpt-6.1-sol' };
  const postTool = probe(script.path, env, { hook_event_name: 'PostToolUse', session_id: 'session', tool_name: 'Read' });
  assert.equal(postTool.status, 0, postTool.stderr); assert.equal(postTool.stdout, ''); assert.equal(postTool.stderr, '');
  assert.deepEqual(await fs.readdir(data), []);
  const prompt = probe(script.path, env, { hook_event_name: 'UserPromptSubmit', session_id: 'session' });
  assert.equal(prompt.status, 0, prompt.stderr);
  assert.equal(JSON.parse(prompt.stdout).hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  await updateProfile(catalog, profile.name, { configDir, completionMode: 'off', write: true, previewDir: path.join(root, 'preview') });
  assert.equal(JSON.parse(await fs.readFile(hookFile.path, 'utf8')).hooks.Stop, undefined);
});
