import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { runCompletionCapture } from '../scripts/capture-completion-contract.mjs';
import { evaluateCompletion } from '../src/completion/evaluator.mjs';

async function fakeCli(t, stdout) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'completion-fake-cli-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const cli = path.join(root, 'claude');
  await fs.writeFile(cli, `#!/bin/sh\nif [ "$1" = "--version" ]; then printf '2.1.288 (fixture)\\n'; exit 0; fi\nprintf '%s\\n' '${stdout}'\n`, { mode: 0o700 });
  return cli;
}

// A successful CLI exit/stdout is insufficient without native Stop and request provenance.
test('a CLI with no registered Stop cannot certify isolated enforcement', async (t) => {
  const claudePath = await fakeCli(t, 'PASS');
  const result = await runCompletionCapture({ claudePath, mode: 'isolated-enforce' });
  assert.equal(result.status, 'unsupported');
  assert.equal(result.coverage.enforcing, false);
  assert.equal(result.counts.stop, 0);
  if (process.platform === 'darwin') assert.equal(result.coverage.containment, true);
});

test('stdout PASS cannot become shadow or native provenance evidence or leak child output', async (t) => {
  const claudePath = await fakeCli(t, 'PASS PRIVATE_SYNTHETIC_STDOUT');
  const result = await runCompletionCapture({ claudePath, mode: 'shadow' });
  assert.equal(result.coverage.enforcing, false);
  assert.equal(result.coverage.nativeAcceptance, false);
  assert.equal(result.coverage.exactTransportJoin, false);
  assert.equal(result.counts.requests, 0);
  assert.equal(result.counts.stop, 0);
  assert.ok(result.reasons.includes(process.platform === 'darwin' ? 'native_stop_unobserved' : 'sandbox_unavailable'));
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_SYNTHETIC_STDOUT/);
  assert.ok(JSON.stringify(result).length < 8192);
});

test('unsupported platform returns unknown native coverage before admitting any child', () => {
  const moduleUrl = new URL('../scripts/capture-completion-contract.mjs', import.meta.url).href;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e',
    `Object.defineProperty(process, 'platform', { value: 'linux' });
     const { runCompletionCapture } = await import(${JSON.stringify(moduleUrl)});
     console.log(JSON.stringify(await runCompletionCapture({ claudePath: '/missing-must-not-spawn', mode: 'isolated-enforce' })));`],
  { env: { ...process.env, AIRKIT_VERIFY_COMPLETION_HOST: '' }, encoding: 'utf8', timeout: 3000 });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stderr, '');
  const result = JSON.parse(child.stdout);
  assert.equal(result.status, 'unsupported');
  assert.equal(result.version, 'unknown');
  assert.ok(result.reasons.includes('sandbox_unavailable'));
  assert.equal(result.counts.children, 0);
  assert.equal(result.counts.requests, 0);
  assert.equal(result.counts.stop, 0);
  assert.equal(result.coverage.containment, false);
  assert.equal(result.coverage.nativeAcceptance, false);
  assert.equal(result.coverage.exactTransportJoin, false);
  assert.equal(result.coverage.enforcing, false);
});

test('capture rejects real home and external destinations before executing any CLI', async (t) => {
  const claudePath = await fakeCli(t, 'PASS');
  await assert.rejects(runCompletionCapture({ claudePath, home: os.homedir() }), /unsafe_home/);
  for (const baseUrl of ['https://example.invalid/v1', 'http://localhost.example.invalid/v1', 'file:///tmp/fixture', 'http://127.0.0.1@evil.invalid/v1']) {
    await assert.rejects(runCompletionCapture({ claudePath, baseUrl }), /non_loopback/);
  }
  await assert.rejects(runCompletionCapture({ claudePath, mode: 'enforce' }), /unsupported_mode/);
});

// Dropping an accepted deliverable or treating a running must-finish agent as complete must fail these cases.
test('core coverage keeps missing deliverables and must-finish agents pending independently of native mechanics', () => {
  const key = { sessionId: 'session', workspaceId: 'workspace', requestId: 'request', generation: 1 };
  const item = { itemId: 'first', category: 'implementation', status: 'verified', source: 'accepted-plan',
    requiredTargetIds: ['target'], mustFinish: true, receiptIds: ['receipt'] };
  const receipt = { id: 'receipt', executionId: 'execution', itemId: 'first', targetId: 'target', key,
    revision: 'revision', result: 'verified', startedAt: 1, endedAt: 2 };
  const snapshot = { key, enabled: true, mode: 'enforce', coverage: 'verified', modelFamily: 'gpt',
    cancelled: false, awaitingAuthority: false, safeWorkRemaining: true, executionTask: true,
    checkpointPresent: true, items: [item, { ...item, itemId: 'missing', status: 'pending', receiptIds: [] }],
    receipts: [receipt], revision: 'revision', budget: { used: 0, remaining: 2, firstInterventionAt: null,
      lastProgressDigest: null, unknownReconciled: false }, validity: { status: 'valid', now: 1000, progressDigest: 'progress' },
    stopHookActive: false, upstreamError: null };
  const missing = evaluateCompletion(snapshot);
  assert.equal(missing.reason, 'pending_work'); assert.deepEqual(missing.itemIds, ['missing']);
  for (const [mustFinish, action] of [[true, 'continue'], [false, 'allow']]) {
    const decision = evaluateCompletion({ ...snapshot, items: [{ ...item, itemId: 'agent', category: 'background',
      status: 'running', receiptIds: [], mustFinish }], receipts: [] });
    assert.equal(decision.action, action);
  }
});

test('actual Claude capture requires explicit opt-in and preserves unknown enforcing gates', {
  skip: process.env.AIRKIT_VERIFY_COMPLETION_HOST !== '1' ? 'Native capture not requested; skip is not native PASS.' : false,
}, async () => {
  const result = await runCompletionCapture({ mode: 'isolated-enforce' });
  assert.equal(result.coverage.enforcing, false);
  assert.equal(result.coverage.nativeAcceptance, false);
  assert.equal(result.coverage.exactTransportJoin, false);
  assert.equal(result.coverage.continuousRevision, false);
  assert.ok(['unsupported', 'observed'].includes(result.status));
  assert.equal(result.coverage.containment, true);
  assert.match(result.version, /^\d+\.\d+\.\d+$/);
  assert.ok(result.reasons.includes('native_acceptance_unknown'));
  assert.ok(result.reasons.includes('exact_transport_join_unknown'));
});
