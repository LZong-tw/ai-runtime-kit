import { isBoundedId } from './checkpoint.mjs';
import { hasVerifiedTargets } from './evaluator.mjs';

const unknown = () => ({ status: 'unknown', key: null });
const validKey = (key) => key && ['sessionId', 'workspaceId', 'requestId'].every((field) => isBoundedId(key[field]))
  && Number.isSafeInteger(key.generation) && key.generation > 0;
const sameKey = (a, b) => validKey(a) && validKey(b)
  && ['sessionId', 'workspaceId', 'requestId', 'generation'].every((field) => a[field] === b[field]);

/** The decoder and controller are private host capabilities, never stdin objects. */
export function createNativeAdapter({ validatedContract, controller } = {}) {
  const nativeTasks = new Map();
  const validated = validatedContract?.status === 'validated' && typeof validatedContract.decode === 'function';

  async function observe(payload, options = {}) {
    if (!validated || options.signal?.aborted) return unknown();
    let event;
    try { event = await validatedContract.decode(payload); } catch { return unknown(); }
    if (!event || options.signal?.aborted || (options.deadline !== undefined && Date.now() >= options.deadline)) return unknown();
    if (options.stopOnly && event.kind !== 'stop') return unknown();
    if (event.kind === 'user') {
      if (!controller?.beginRequest || !['nativeEventId', 'sessionId', 'workspaceId'].every((field) => isBoundedId(event[field]))) return unknown();
      const result = await controller.beginRequest({ kind: 'user', nativeEventId: event.nativeEventId,
        sessionId: event.sessionId, workspaceId: event.workspaceId });
      return result?.status === 'ok' ? { status: 'ok', key: result.key, kind: 'user' } : unknown();
    }
    if (!validKey(event.key)) return unknown();
    const key = structuredClone(event.key);
    if (['stop', 'feedback', 'resume', 'compact'].includes(event.kind)) {
      return { status: 'ok', key, kind: event.kind,
        ...(event.kind === 'stop' && event.checkpointTail !== undefined ? { checkpointTail: structuredClone(event.checkpointTail) } : {}) };
    }
    if (!controller?.transaction) return unknown();
    const deadline = options.deadline ?? Date.now() + 1000;
    const signal = options.signal ?? new AbortController().signal;
    let binding;
    if (event.kind === 'background') {
      if (!['nativeTaskId', 'itemId', 'contractId'].every((field) => isBoundedId(event[field]))
        || !['start', 'running', 'completed', 'cancelled'].includes(event.phase)) return unknown();
      binding = nativeTasks.get(event.nativeTaskId);
      if (binding && (!sameKey(binding.key, key) || binding.itemId !== event.itemId || binding.contractId !== event.contractId)) return unknown();
      if (!binding && (event.phase !== 'start' || nativeTasks.size >= 128)) return unknown();
    } else if (event.kind !== 'cancel' && !(event.kind === 'authority'
      && typeof event.awaitingAuthority === 'boolean' && typeof event.safeWorkRemaining === 'boolean')) return unknown();
    try {
      const result = await controller.transaction(key, (state) => {
        if (signal.aborted || Date.now() >= deadline || !sameKey(state.key, key)) throw new Error('stale_observation');
        if (event.kind === 'cancel') state.cancelled = true;
        else if (event.kind === 'authority') {
          state.awaitingAuthority = event.awaitingAuthority;
          state.safeWorkRemaining = event.safeWorkRemaining;
        } else {
          const item = state.items.find((candidate) => candidate.itemId === event.itemId && candidate.contractId === event.contractId
            && candidate.source !== 'model-proposed' && candidate.category === 'background');
          if (!item) throw new Error('unknown_task');
          if (event.phase === 'cancelled') item.status = 'cancelled';
          else if (!['cancelled', 'blocked'].includes(item.status)) item.status = hasVerifiedTargets(item, state)
            ? 'verified' : event.phase === 'completed' ? 'pending' : 'running';
        }
        return { status: 'ok' };
      }, { signal, deadline });
      if (signal.aborted || Date.now() >= deadline || result?.status !== 'ok') return unknown();
      if (event.kind === 'background' && !binding) nativeTasks.set(event.nativeTaskId,
        { key, itemId: event.itemId, contractId: event.contractId });
      return { status: 'ok', key, kind: event.kind };
    } catch { return unknown(); }
  }

  return Object.freeze({ observe });
}
