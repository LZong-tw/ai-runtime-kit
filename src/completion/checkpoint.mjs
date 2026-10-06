export const categories = Object.freeze(['implementation', 'verification', 'report', 'background']);
export const taskStatuses = Object.freeze(['pending', 'running', 'verified', 'reported', 'blocked', 'cancelled']);

export function isBoundedId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);
}

function exactKeys(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

export function parseCheckpoint(bytes) {
  if (!(bytes instanceof Uint8Array)) return { error: 'invalid_input' };
  if (bytes.byteLength > 8192) return { error: 'oversize' };
  let value;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return { error: 'invalid_json' };
  }
  if (!exactKeys(value, ['version', 'kind', 'items']) || value.version !== 1
    || !['declare', 'update'].includes(value.kind) || !Array.isArray(value.items)
    || value.items.length > 64) return { error: 'invalid_schema' };
  const ids = new Set();
  let receiptCount = 0;
  for (const item of value.items) {
    if (value.kind === 'declare') {
      if (!exactKeys(item, ['ordinal', 'category']) || !Number.isInteger(item.ordinal)
        || item.ordinal < 1 || item.ordinal > 64 || !categories.includes(item.category)
        || ids.has(item.ordinal)) return { error: 'invalid_schema' };
      ids.add(item.ordinal);
    } else {
      if (!exactKeys(item, ['itemId', 'status', 'receiptIds']) || !isBoundedId(item.itemId)
        || ids.has(item.itemId) || !taskStatuses.includes(item.status)
        || !Array.isArray(item.receiptIds) || !item.receiptIds.every(isBoundedId)
        || new Set(item.receiptIds).size !== item.receiptIds.length
        || (receiptCount += item.receiptIds.length) > 128) return { error: 'invalid_schema' };
      ids.add(item.itemId);
    }
  }
  return { kind: value.kind, items: value.items };
}
