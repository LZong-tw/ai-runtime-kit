const DEFAULT_RETENTION_DAYS = 90;
const DEFAULT_BATCH_SIZE = 500;

export async function pruneExpiredPayloads(store, options = {}) {
  const {
    now = new Date(),
    retentionDays = DEFAULT_RETENTION_DAYS,
    batchSize = DEFAULT_BATCH_SIZE,
    preserve = false,
    write = false,
  } = options;
  if (!Number.isInteger(retentionDays) || retentionDays < 0) {
    throw new RangeError("retentionDays must be a non-negative integer");
  }
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new RangeError("batchSize must be a positive integer");
  }
  const cutoff = new Date(toDate(now).getTime() - retentionDays * 86400000).toISOString();
  if (preserve) return { pruned: 0, preserved: true };
  if (!write) return { pruned: 0, preview: true, cutoff };
  if (!store || typeof store.prunePayloadBatch !== "function") {
    const error = new Error("audit store does not support payload retention");
    error.code = "AIRKIT_AUDIT_RETENTION_UNAVAILABLE";
    throw error;
  }
  let pruned = 0;
  let preservedCount = 0;
  let result;
  do {
    result = await store.prunePayloadBatch({ cutoff, batchSize, preserve: false });
    pruned += Number(result?.pruned ?? 0);
    preservedCount += Number(result?.preserved ?? 0);
  } while (result?.done === false && (result?.pruned ?? 0) > 0);
  return { pruned, preserved: preservedCount, done: result?.done !== false };
}

function toDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.valueOf())) throw new RangeError("now must be a valid date");
  return date;
}
