import { randomUUID } from 'node:crypto';
import { categories, isBoundedId, parseCheckpoint } from './checkpoint.mjs';
import { hasVerifiedTargets, isValidSnapshot } from './evaluator.mjs';
import { applyCheckpoint, progressDigest } from './state-operations.mjs';

const unknown = (reason = 'unknown') => ({ status: 'unknown', reason });
const sameKey = (a, b) => a && b && ['sessionId', 'workspaceId', 'requestId', 'generation'].every((field) => a[field] === b[field]);
const validKey = (key) => key && ['sessionId', 'workspaceId', 'requestId'].every((field) => isBoundedId(key[field]))
  && Number.isSafeInteger(key.generation) && key.generation > 0;

async function bounded(operation, timeout = 1000) {
  const abort = new AbortController();
  const deadline = Date.now() + timeout;
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(() => operation({ signal: abort.signal, deadline })),
      new Promise((resolve) => { timer = setTimeout(() => { abort.abort(); resolve(unknown('deadline')); }, timeout); }),
    ]);
  } catch (error) {
    if (error?.completionInput) throw error;
    return unknown(error?.completionReason ?? 'dependency_failure');
  } finally {
    clearTimeout(timer);
    abort.abort();
  }
}

function inputError(reason) {
  const error = new Error(reason);
  error.completionInput = true;
  throw error;
}

function unavailable(reason) {
  throw Object.assign(new Error(reason), { completionReason: reason });
}

function projectTask(item) {
  return { itemId: item.itemId, category: item.category,
    requiredTargetIds: [...item.requiredTargetIds], mustFinish: item.mustFinish };
}

function validReceipt(produced, targetId) {
  const receipt = produced?.receipt;
  return isBoundedId(produced?.executionId) && receipt && isBoundedId(receipt.id)
    && receipt.executionId === produced.executionId && receipt.targetId === targetId
    && isBoundedId(receipt.revision) && ['verified', 'failed', 'stale', 'cancelled', 'unknown'].includes(receipt.result)
    && Number.isFinite(receipt.startedAt) && Number.isFinite(receipt.endedAt) && receipt.endedAt >= receipt.startedAt;
}

function validLedger(state) {
  return state && isValidSnapshot({ ...state,
    validity: { ...state.validity, now: Date.now(), progressDigest: 'uncomputed' } })
    && isBoundedId(state.nativeEventId) && Array.isArray(state.seenNativeEventIds)
    && state.seenNativeEventIds.length <= 128 && state.seenNativeEventIds.every(isBoundedId)
    && new Set(state.seenNativeEventIds).size === state.seenNativeEventIds.length
    && state.seenNativeEventIds.includes(state.nativeEventId)
    && state.items.every((item) => item.source === 'model-proposed' || isBoundedId(item.contractId));
}

function unknownSnapshot(key, reason) {
  return { key: key ? structuredClone(key) : null, enabled: false, mode: 'shadow',
    coverage: 'unknown', modelFamily: 'unknown', cancelled: false, awaitingAuthority: false,
    safeWorkRemaining: false, executionTask: false, checkpointPresent: false, items: [], receipts: [],
    budget: { used: 2, remaining: 0, firstInterventionAt: null, lastProgressDigest: null, unknownReconciled: true },
    revision: 'unknown', validity: { status: reason }, stopHookActive: false, upstreamError: null };
}

/** Private host composition; callers and injected producers are trusted. */
export function createCompletionController({ store, acceptedContracts, verifier, routeJoin } = {}) {
  if (!store?.read || !store?.transaction || !(acceptedContracts instanceof Set)
    || !verifier?.run || !routeJoin?.resolve) throw new Error('invalid_dependencies');
  // These are immutable contract definitions and an identity locator, not ledgers.
  const contracts = new Map();
  const handles = new WeakMap();
  const requestKeys = new Map();
  for (const acceptance of acceptedContracts) {
    if (!isBoundedId(acceptance?.contractId) || contracts.has(acceptance.contractId)
      || !categories.includes(acceptance.category) || typeof acceptance.mustFinish !== 'boolean'
      || !Array.isArray(acceptance.requiredTargetIds) || acceptance.requiredTargetIds.length > 128
      || !acceptance.requiredTargetIds.every(isBoundedId)
      || new Set(acceptance.requiredTargetIds).size !== acceptance.requiredTargetIds.length
      || !Array.isArray(acceptance.targets) || acceptance.targets.length > 128
      || new Set(acceptance.targets.map((target) => target?.id)).size !== acceptance.targets.length
      || !acceptance.targets.every((target) => isBoundedId(target?.id) && Number.isFinite(target.timeoutMs)
        && target.timeoutMs > 0 && typeof target.sideEffectFree === 'boolean')
      || !acceptance.requiredTargetIds.every((id) => acceptance.targets.some((target) => target.id === id))) {
      throw new Error('invalid_acceptance_contract');
    }
    const source = acceptance.source ?? 'accepted-plan';
    if (!['user-explicit', 'accepted-plan'].includes(source)) throw new Error('invalid_acceptance_source');
    const contract = { ...structuredClone(acceptance), source };
    contracts.set(contract.contractId, contract);
    handles.set(acceptance, contract);
  }

  function locate(requestId) { return requestKeys.get(requestId); }
  function remember(key) {
    if (requestKeys.size >= 128 && !requestKeys.has(key.requestId)) return false;
    requestKeys.set(key.requestId, structuredClone(key));
    return true;
  }

  async function read(requestId) {
    const key = locate(requestId);
    if (!key) return unknown('unknown_identity');
    const result = await bounded((options) => store.read(key, options));
    if (result?.status !== 'ok') return unknown(result?.reason ?? result?.status);
    return sameKey(result.state?.key, key) && validLedger(result.state) ? result : unknown('state_invalid');
  }

  async function transact(requestId, fn) {
    const key = locate(requestId);
    if (!key) return unknown('unknown_identity');
    const result = await bounded((options) => store.transaction(key, (state) => {
      if (options.signal.aborted || Date.now() >= options.deadline || !sameKey(state.key, key)) unavailable('stale_request');
      if (!validLedger(state)) unavailable('state_invalid');
      const value = fn(state, key);
      if (options.signal.aborted || Date.now() >= options.deadline) unavailable('deadline');
      return value;
    }, options));
    return result?.status === 'ok' ? result : unknown(result?.status ?? 'state_invalid');
  }

  async function beginRequest(event) {
    if (event?.kind !== 'user' || !['nativeEventId', 'sessionId', 'workspaceId'].every((field) => isBoundedId(event[field]))) {
      return unknown('unknown_identity');
    }
    const sessionKey = { sessionId: event.sessionId, workspaceId: event.workspaceId };
    const prior = await bounded((options) => store.read(sessionKey, options));
    if (!['ok', 'missing'].includes(prior?.status)) return unknown(prior?.status);
    if (prior.status === 'ok' && (!validLedger(prior.state) || prior.state.key.sessionId !== sessionKey.sessionId
      || prior.state.key.workspaceId !== sessionKey.workspaceId)) return unknown('state_invalid');
    if (prior.state?.nativeEventId === event.nativeEventId) {
      if (!remember(prior.state.key)) return unknown('capacity');
      return { status: 'ok', requestId: prior.state.key.requestId, key: structuredClone(prior.state.key) };
    }
    if (prior.state?.seenNativeEventIds.includes(event.nativeEventId)) return unknown('stale_event');
    if (requestKeys.size >= 128 || (prior.state?.seenNativeEventIds.length ?? 0) >= 128) return unknown('capacity');
    const key = { ...sessionKey, requestId: randomUUID(), generation: (prior.state?.key.generation ?? 0) + 1 };
    if (!validKey(key)) return unknown('state_invalid');
    const expected = prior.state?.key ?? key;
    const result = await bounded((options) => store.transaction(expected, (state) => {
      if (options.signal.aborted || Date.now() >= options.deadline) unavailable('deadline');
      if (prior.status === 'missing' && state.key) unavailable('stale_request');
      if (prior.status === 'ok' && !sameKey(state.key, expected)) unavailable('stale_request');
      const pending = (state.items ?? []).filter((item) => item.source !== 'model-proposed'
        && item.status !== 'cancelled' && !hasVerifiedTargets(item, state))
        .map((item) => ({ itemId: randomUUID(), contractId: item.contractId, category: item.category,
          source: item.source, requiredTargetIds: [...item.requiredTargetIds], mustFinish: item.mustFinish,
          status: 'pending', receiptIds: [], unresolvedTargetIds: [...(item.unresolvedTargetIds ?? [])] }));
      const seen = [...(state.seenNativeEventIds ?? []), event.nativeEventId];
      Object.assign(state, { key, nativeEventId: event.nativeEventId, seenNativeEventIds: seen,
        enabled: false, mode: 'shadow', coverage: 'unknown', modelFamily: 'unknown',
        cancelled: false, awaitingAuthority: false, safeWorkRemaining: pending.some((item) => item.source !== 'model-proposed'),
        executionTask: pending.length > 0, checkpointPresent: false, items: pending, receipts: [], revision: 'unknown',
        budget: { used: 0, remaining: 2, firstInterventionAt: null, lastProgressDigest: null, unknownReconciled: false },
        validity: { status: 'valid' }, stopHookActive: false, upstreamError: null });
      delete state.route;
      delete state.verifierCoverage;
      return key;
    }, options));
    if (result?.status !== 'ok') return unknown(result?.status);
    if (!remember(key)) return unknown('capacity');
    return { status: 'ok', requestId: key.requestId, key: structuredClone(key) };
  }

  async function registerTask(requestId, acceptance) {
    if (!acceptedContracts.has(acceptance) || !handles.has(acceptance)) inputError('untrusted_acceptance');
    const contract = handles.get(acceptance);
    const result = await transact(requestId, (state) => {
      const existing = state.items.find((item) => item.contractId === contract.contractId);
      if (existing) return projectTask(existing);
      if (state.items.length >= 64) unavailable('item_capacity');
      const item = { itemId: randomUUID(), contractId: contract.contractId, category: contract.category,
        requiredTargetIds: [...contract.requiredTargetIds], mustFinish: contract.mustFinish,
        source: contract.source, status: 'pending', receiptIds: [], unresolvedTargetIds: [] };
      state.items.push(item);
      state.executionTask = true;
      state.safeWorkRemaining = true;
      return projectTask(item);
    });
    return result.status === 'ok' ? result.result : result;
  }

  async function declareTask(requestId, declaration) {
    let bytes;
    try { bytes = declaration instanceof Uint8Array ? declaration : Buffer.from(JSON.stringify(declaration)); }
    catch { inputError('invalid_checkpoint'); }
    const parsed = parseCheckpoint(bytes);
    if (parsed.error) inputError('invalid_checkpoint');
    const result = await transact(requestId, (state) => {
      try {
        return applyCheckpoint(state, parsed, { createItemId: randomUUID });
      } catch (error) {
        switch (error.checkpointReason) {
          case 'item_capacity': unavailable('item_capacity'); break;
          case 'conflicting_declaration':
          case 'unknown_item':
          case 'unknown_receipt': inputError(error.checkpointReason); break;
          default: throw error;
        }
      }
    });
    return result.status === 'ok' ? result.result : result;
  }

  async function runVerification(requestId, itemId, targetId) {
    const current = await read(requestId);
    if (current.status !== 'ok') return current;
    const item = current.state.items.find((candidate) => candidate.itemId === itemId);
    const contract = item?.source !== 'model-proposed' ? contracts.get(item?.contractId) : null;
    const target = contract?.targets.find((candidate) => candidate.id === targetId);
    if (!item || !target || !target.sideEffectFree || !item.requiredTargetIds.includes(targetId)) inputError('unaccepted_target');
    const produced = await bounded(({ signal }) => verifier.run({ key: structuredClone(current.state.key),
      item: structuredClone(item), target: structuredClone(target), signal }), target.timeoutMs + 1000);
    if (!validReceipt(produced, targetId)) {
      await transact(requestId, (state) => {
        const liveItem = state.items.find((candidate) => candidate.itemId === itemId);
        liveItem.unresolvedTargetIds = [...new Set([...(liveItem.unresolvedTargetIds ?? []), targetId])];
        liveItem.status = 'pending';
        state.verifierCoverage = 'unknown'; state.coverage = 'unknown';
      });
      return unknown('verification_unknown');
    }
    const result = await transact(requestId, (state, key) => {
      if (state.revision !== current.state.revision) unavailable('stale_revision');
      if (state.receipts.length >= 128 || state.receipts.some((receipt) => receipt.id === produced.receipt.id)) unavailable('receipt_capacity');
      const { id, executionId, revision, result: receiptResult, startedAt, endedAt } = produced.receipt;
      const receipt = { id, executionId, targetId, revision, result: receiptResult, startedAt, endedAt,
        itemId, key: structuredClone(key) };
      state.receipts.push(receipt);
      const liveItem = state.items.find((candidate) => candidate.itemId === itemId);
      liveItem.receiptIds.push(id);
      if (receiptResult === 'unknown') {
        liveItem.unresolvedTargetIds = [...new Set([...(liveItem.unresolvedTargetIds ?? []), targetId])];
      } else if (receiptResult === 'verified') {
        liveItem.unresolvedTargetIds = (liveItem.unresolvedTargetIds ?? []).filter((id) => id !== targetId);
      }
      if (receiptResult === 'verified') state.revision = revision;
      liveItem.status = hasVerifiedTargets(liveItem, state) ? 'verified' : 'pending';
      state.verifierCoverage = receiptResult === 'unknown' || state.items.some((item) => item.unresolvedTargetIds?.length)
        ? 'unknown' : 'verified';
      state.coverage = state.route && state.verifierCoverage === 'verified' ? 'verified' : 'unknown';
      return { status: 'ok', executionId: produced.executionId, receiptId: id };
    });
    return result.status === 'ok' ? result.result : result;
  }

  async function bindRoute(requestId, observation) {
    const current = await read(requestId);
    if (current.status !== 'ok') return current;
    const joined = await bounded(() => routeJoin.resolve(observation, structuredClone(current.state.key)));
    const trusted = joined?.status === 'ok' && sameKey(joined.key, current.state.key)
      && isBoundedId(joined.providerId) && isBoundedId(joined.modelId)
      && ['gpt', 'claude', 'other'].includes(joined.modelFamily);
    const result = await transact(requestId, (state) => {
      state.modelFamily = trusted ? joined.modelFamily : 'unknown';
      if (trusted) state.route = { providerId: joined.providerId, modelId: joined.modelId };
      else delete state.route;
      state.coverage = trusted && state.verifierCoverage === 'verified' ? 'verified' : 'unknown';
      return trusted ? { status: 'ok' } : unknown('route_unknown');
    });
    return result.status === 'ok' ? result.result : result;
  }

  async function snapshot(requestId) {
    const current = await read(requestId);
    if (current.status !== 'ok') return unknownSnapshot(locate(requestId), current.reason);
    const state = current.state;
    return structuredClone({ key: state.key, enabled: state.enabled, mode: state.mode, coverage: state.coverage,
      modelFamily: state.modelFamily, cancelled: state.cancelled, awaitingAuthority: state.awaitingAuthority,
      safeWorkRemaining: state.safeWorkRemaining, executionTask: state.executionTask, checkpointPresent: state.checkpointPresent,
      items: state.items, receipts: state.receipts, budget: state.budget, revision: state.revision,
      validity: { ...state.validity, now: Date.now(), progressDigest: progressDigest(state) },
      stopHookActive: state.stopHookActive, upstreamError: state.upstreamError });
  }

  return Object.freeze({ beginRequest, registerTask, declareTask, runVerification, bindRoute, snapshot });
}
