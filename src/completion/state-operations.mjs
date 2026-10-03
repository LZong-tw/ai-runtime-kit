import { createHash } from 'node:crypto';

const sameKey = (a, b) => a && b && ['sessionId', 'workspaceId', 'requestId', 'generation'].every((field) => a[field] === b[field]);
const reject = (reason) => { throw Object.assign(new Error(reason), { checkpointReason: reason }); };

export function progressDigest(state) {
  const progress = { revision: state.revision, items: state.items.filter((item) => item.source !== 'model-proposed')
    .map(({ itemId, status, requiredTargetIds, receiptIds, unresolvedTargetIds }) =>
      ({ itemId, status, requiredTargetIds, receiptIds, unresolvedTargetIds })),
    receipts: state.receipts };
  return createHash('sha256').update(JSON.stringify(progress)).digest('hex');
}

// The caller supplies a parsed checkpoint and owns transaction rollback and IDs.
export function applyCheckpoint(state, checkpoint, { createItemId }) {
  const proposed = [];
  for (const entry of checkpoint.items) {
    let item;
    if (checkpoint.kind === 'declare') {
      item = state.items.find((candidate) => candidate.source === 'model-proposed' && candidate.ordinal === entry.ordinal);
      if (item && item.category !== entry.category) reject('conflicting_declaration');
      if (!item) {
        if (state.items.length >= 64) reject('item_capacity');
        item = { itemId: createItemId(), ordinal: entry.ordinal, category: entry.category,
          source: 'model-proposed', status: 'pending', mustFinish: false, requiredTargetIds: [], receiptIds: [] };
        state.items.push(item);
      }
    } else {
      item = state.items.find((candidate) => candidate.itemId === entry.itemId);
      if (!item) reject('unknown_item');
      if (!entry.receiptIds.every((id) => state.receipts.some((receipt) => receipt.id === id
        && receipt.itemId === item.itemId && sameKey(receipt.key, state.key)))) reject('unknown_receipt');
      item.proposal = { status: entry.status, receiptIds: [...entry.receiptIds] };
    }
    proposed.push({ itemId: item.itemId, category: item.category,
      requiredTargetIds: [...item.requiredTargetIds], mustFinish: item.mustFinish });
  }
  state.checkpointPresent = true;
  return { status: 'ok', items: proposed };
}
