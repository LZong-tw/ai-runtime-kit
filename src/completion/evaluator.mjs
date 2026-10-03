import { categories, isBoundedId, taskStatuses } from './checkpoint.mjs';

function sameKey(a, b) {
  return a && b && ['sessionId', 'workspaceId', 'requestId', 'generation'].every((field) => a[field] === b[field]);
}

export function isValidSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return false;
  const { key, items, receipts, budget, validity } = snapshot;
  return key && ['sessionId', 'workspaceId', 'requestId'].every((field) => isBoundedId(key[field]))
    && Number.isSafeInteger(key.generation) && key.generation > 0
    && Array.isArray(items) && items.length <= 64 && new Set(items.map((item) => item?.itemId)).size === items.length
    && items.every((item) => item && isBoundedId(item.itemId) && categories.includes(item.category)
      && taskStatuses.includes(item.status) && ['user-explicit', 'accepted-plan', 'model-proposed'].includes(item.source)
      && typeof item.mustFinish === 'boolean' && Array.isArray(item.requiredTargetIds)
      && item.requiredTargetIds.length <= 128 && item.requiredTargetIds.every(isBoundedId)
      && new Set(item.requiredTargetIds).size === item.requiredTargetIds.length
      && Array.isArray(item.receiptIds) && item.receiptIds.length <= 128 && item.receiptIds.every(isBoundedId)
      && new Set(item.receiptIds).size === item.receiptIds.length)
    && Array.isArray(receipts) && receipts.length <= 128
    && receipts.every((receipt) => receipt && ['id', 'executionId', 'itemId', 'targetId', 'revision']
      .every((field) => isBoundedId(receipt[field])) && receipt.key
      && ['sessionId', 'workspaceId', 'requestId'].every((field) => isBoundedId(receipt.key[field]))
      && Number.isSafeInteger(receipt.key.generation) && receipt.key.generation > 0
      && ['verified', 'failed', 'stale', 'cancelled', 'unknown'].includes(receipt.result)
      && Number.isFinite(receipt.startedAt) && Number.isFinite(receipt.endedAt) && receipt.endedAt >= receipt.startedAt)
    && new Set(receipts.map((receipt) => receipt.id)).size === receipts.length
    && budget && Number.isInteger(budget.used) && budget.used >= 0 && budget.used <= 2
    && Number.isInteger(budget.remaining) && budget.remaining === 2 - budget.used
    && typeof budget.unknownReconciled === 'boolean'
    && (budget.firstInterventionAt === null || (Number.isFinite(budget.firstInterventionAt)
      && budget.firstInterventionAt <= validity?.now))
    && (budget.lastProgressDigest === null || isBoundedId(budget.lastProgressDigest))
    && isBoundedId(snapshot.revision) && validity?.status === 'valid'
    && Number.isFinite(validity.now) && isBoundedId(validity.progressDigest)
    && ['enabled', 'cancelled', 'awaitingAuthority', 'safeWorkRemaining', 'executionTask', 'checkpointPresent', 'stopHookActive']
      .every((field) => typeof snapshot[field] === 'boolean');
}

export function hasVerifiedTargets(item, snapshot) {
  if (item.source === 'model-proposed' || item.requiredTargetIds.length === 0) return false;
  return item.requiredTargetIds.every((targetId) => {
    const receipt = snapshot.receipts.findLast((candidate) => candidate?.itemId === item.itemId
      && candidate.targetId === targetId && sameKey(candidate.key, snapshot.key));
    return receipt && item.receiptIds.includes(receipt.id) && isBoundedId(receipt.id)
      && isBoundedId(receipt.executionId) && receipt.revision === snapshot.revision
      && receipt.result === 'verified' && Number.isFinite(receipt.startedAt)
      && Number.isFinite(receipt.endedAt) && receipt.endedAt >= receipt.startedAt;
  });
}

/** Pure policy over an already normalized, bounded host snapshot. */
export function evaluateCompletion(snapshot) {
  const remaining = Number.isInteger(snapshot?.budget?.remaining) ? snapshot.budget.remaining : 0;
  const decide = (action, reason, itemIds = []) => ({ action, reason, itemIds, remaining });
  if (!snapshot || typeof snapshot !== 'object') return decide('degraded', 'state_invalid');
  // 1. Explicit user authority always takes precedence.
  if (snapshot.cancelled === true) return decide('allow', 'cancelled');
  if (snapshot.awaitingAuthority === true && snapshot.safeWorkRemaining === false) return decide('allow', 'awaiting_authority');
  // 2. Coverage is required before enforcing GPT policy.
  if (snapshot.enabled !== true || snapshot.mode === 'disabled') return decide('allow', 'disabled');
  if (snapshot.mode !== 'enforce') return decide('degraded', 'shadow');
  if (snapshot.modelFamily === 'unknown') return decide('degraded', 'model_unknown');
  if (snapshot.modelFamily !== 'gpt') return decide('allow', 'model_ineligible');
  if (snapshot.coverage !== 'verified') return decide('degraded', 'coverage_unknown');
  // 3. Invalid state never implies completion.
  if (!isValidSnapshot(snapshot)) return decide('degraded', 'state_invalid');
  if (snapshot.upstreamError) return decide('degraded', 'upstream_error');
  if (snapshot.stopHookActive) return decide('allow', 'stop_hook_active');
  const pending = snapshot.items.filter((item) => item.source !== 'model-proposed'
    && !['blocked', 'cancelled'].includes(item.status)
    && !(item.category === 'background' && !item.mustFinish) && !hasVerifiedTargets(item, snapshot));
  const unknown = snapshot.items.filter((item) => item.source === 'model-proposed');
  const missing = snapshot.executionTask && !snapshot.checkpointPresent;
  // 4. A genuine blocker does not hide other safe work.
  if (!pending.length && !unknown.length && !missing) return decide('allow',
    snapshot.items.some((item) => item.source !== 'model-proposed' && item.status === 'blocked') ? 'external_blocker' : 'complete');
  if (!snapshot.safeWorkRemaining && !missing && !unknown.length) return decide('allow', 'external_blocker');
  // 5/6. Determine a concrete next check, then apply all continuation bounds.
  const reason = missing ? 'checkpoint_missing' : pending.length ? 'pending_work' : 'reconciliation_required';
  if (snapshot.budget.used >= 2 || snapshot.budget.remaining === 0) return decide('degraded', 'budget_exhausted');
  if (snapshot.budget.firstInterventionAt !== null
    && snapshot.validity.now - snapshot.budget.firstInterventionAt >= 600000) return decide('degraded', 'window_expired');
  if (snapshot.budget.used > 0 && snapshot.budget.lastProgressDigest === snapshot.validity.progressDigest) return decide('degraded', 'no_progress');
  if ((missing || !pending.length) && snapshot.budget.unknownReconciled) return decide('degraded', 'unknown_reconciled');
  return decide('continue', reason, pending.slice(0, 3).map((item) => item.itemId));
}
