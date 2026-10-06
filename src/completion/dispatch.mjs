import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { isBoundedId, parseCheckpoint } from './checkpoint.mjs';
import { evaluateCompletion, isValidSnapshot } from './evaluator.mjs';
import { applyCheckpoint, progressDigest } from './state-operations.mjs';

const degraded = (reason) => ({ action: 'degraded', reason, itemIds: [], remaining: 0 });
const sameKey = (a, b) => a && b && ['sessionId', 'workspaceId', 'requestId', 'generation'].every((field) => a[field] === b[field]);
const failure = (reason) => { throw Object.assign(new Error(reason), { dispatchReason: reason }); };

function readInput(input, signal, check) {
  if (!input?.read || input.readableObjectMode || input.readableEncoding) {
    input?.destroy?.(); failure('input_invalid');
  }
  return new Promise((resolve, reject) => {
    const chunks = []; let length = 0;
    const cleanup = () => {
      input.removeListener('readable', readable); input.removeListener('end', end); input.removeListener('error', error);
      signal.removeEventListener('abort', abort);
    };
    const error = (error) => { cleanup(); input.destroy(); reject(error); };
    const abort = () => { cleanup(); input.destroy(); reject(Object.assign(new Error('deadline'), { dispatchReason: 'deadline' })); };
    const end = () => { cleanup(); resolve(Buffer.concat(chunks, length)); };
    const readable = () => {
      try {
        check();
        let chunk;
        while ((chunk = input.read(65537 - length)) !== null) {
          if (!(chunk instanceof Uint8Array)) failure('input_invalid');
          length += chunk.length; chunks.push(chunk); check();
          if (length > 65536) { cleanup(); input.destroy(); failure('input_oversize'); }
        }
      } catch (caught) { error(caught); }
    };
    input.on('readable', readable); input.once('end', end); input.once('error', error);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort(); else readable();
  });
}

function writeFeedback(output, bytes, signal) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      output.removeListener('error', error); output.removeListener('close', close);
      signal.removeEventListener('abort', abort);
    };
    const error = (caught) => { cleanup(); reject(caught); };
    const close = () => { cleanup(); reject(Object.assign(new Error('output_closed'), { dispatchReason: 'dependency_failure' })); };
    const abort = () => { output.destroy(); reject(Object.assign(new Error('deadline'), { dispatchReason: 'deadline' })); };
    output.once('error', error); output.once('close', close); signal.addEventListener('abort', abort, { once: true });
    try {
      if (signal.aborted) { abort(); return; }
      output.write(bytes, (caught) => {
        // A Writable emits its error after the callback; keep the owner until then.
        if (caught) reject(caught);
        else { cleanup(); resolve(); }
      });
    } catch (caught) { error(caught); }
  });
}

async function readCheckpoint(tail, check, signal) {
  if (!tail || typeof tail.path !== 'string' || !tail.path.startsWith('/') || !Number.isSafeInteger(tail.offset)
    || tail.offset < 0 || !Number.isInteger(tail.length) || tail.length < 1 || tail.length > 8192) failure('checkpoint_unknown');
  let handle; let closing;
  const close = () => { if (handle) closing ??= handle.close().catch(() => {}); return closing; };
  const onAbort = () => { void close(); };
  try {
    check();
    handle = await fs.promises.open(tail.path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    signal.addEventListener('abort', onAbort, { once: true });
    check();
    if (!(await handle.stat()).isFile()) failure('checkpoint_unknown');
    const bytes = Buffer.alloc(tail.length); let length = 0;
    while (length < bytes.length) {
      check();
      const result = await handle.read(bytes, length, bytes.length - length, tail.offset + length);
      check(); if (!result.bytesRead) break; length += result.bytesRead;
    }
    if (signal.aborted || length !== bytes.length) failure('checkpoint_unknown');
    const checkpoint = parseCheckpoint(bytes);
    if (checkpoint.error) failure('checkpoint_unknown');
    return checkpoint;
  } catch (error) { if (error.dispatchReason) throw error; failure('checkpoint_unknown'); }
  finally { signal.removeEventListener('abort', onAbort); await close(); }
}

/** One absolute Stop deadline; only the injected private host can mutate its ledger. */
export async function runCompletionDispatch({ input, output, controller, adapter, clock = Date.now } = {}) {
  const abort = new AbortController();
  const deadline = Date.now() + 1000;
  const monotonicDeadline = performance.now() + 1000;
  let timer;
  const check = () => { if (abort.signal.aborted || Date.now() >= deadline || performance.now() >= monotonicDeadline) failure('deadline'); };
  const options = { signal: abort.signal, deadline, stopOnly: true };
  const operation = async () => {
    const bytes = await readInput(input, abort.signal, check); check();
    let payload;
    try { payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { failure('input_invalid'); }
    if (payload?.stop_hook_active === true) return { action: 'allow', reason: 'stop_hook_active', itemIds: [], remaining: 0 };
    if (!adapter?.observe || !controller?.transaction) return degraded('coverage_unknown');
    const observation = await adapter.observe(payload, options); check();
    if (observation?.status !== 'ok' || observation.kind !== 'stop' || !observation.key
      || !['sessionId', 'workspaceId', 'requestId'].every((field) => isBoundedId(observation.key[field]))
      || !Number.isSafeInteger(observation.key.generation) || observation.key.generation < 1) return degraded('coverage_unknown');
    const checkpoint = observation.checkpointTail === undefined ? null : await readCheckpoint(observation.checkpointTail, check, abort.signal);
    check();
    const result = await controller.transaction(observation.key, (state) => {
      check();
      if (!sameKey(state.key, observation.key)) failure('state_invalid');
      if (checkpoint) {
        try {
          applyCheckpoint(state, checkpoint, { createItemId: randomUUID });
        } catch (error) {
          switch (error.checkpointReason) {
            case 'conflicting_declaration':
            case 'item_capacity':
            case 'unknown_item':
            case 'unknown_receipt': failure('checkpoint_unknown'); break;
            default: throw error;
          }
        }
      }
      const now = clock();
      const snapshot = { ...state, validity: { ...state.validity, now, progressDigest: progressDigest(state) } };
      if (!isValidSnapshot(snapshot)) failure('state_invalid');
      const decision = evaluateCompletion(snapshot); check();
      if (decision.action === 'continue') {
        state.budget.used += 1; state.budget.remaining -= 1;
        state.budget.firstInterventionAt ??= now;
        state.budget.lastProgressDigest = snapshot.validity.progressDigest;
        if (['checkpoint_missing', 'reconciliation_required'].includes(decision.reason)) state.budget.unknownReconciled = true;
        decision.remaining = state.budget.remaining;
      }
      check(); return decision;
    }, options);
    check();
    if (result?.status !== 'ok' || !sameKey(result.state?.key, observation.key)) return degraded(result?.status === 'deadline' ? 'deadline' : 'state_unknown');
    const decision = result.result;
    if (decision.action === 'continue') {
      const feedback = { decision: 'block', reason: decision.reason, itemIds: decision.itemIds.slice(0, 3),
        nextAction: 'Check the listed accepted work and its existing verification receipts.', remaining: decision.remaining };
      check();
      await writeFeedback(output, `${JSON.stringify(feedback)}\n`, abort.signal);
      check();
    }
    return decision;
  };
  try {
    const expired = new Promise((resolve) => {
      timer = setTimeout(() => { abort.abort(); output?.destroy?.(); resolve(degraded('deadline')); },
        Math.max(0, Math.min(deadline - Date.now(), monotonicDeadline - performance.now())));
    });
    return await Promise.race([
      operation().catch((error) => degraded(error.dispatchReason ?? 'dependency_failure')),
      expired,
    ]);
  } finally { clearTimeout(timer); abort.abort(); }
}
