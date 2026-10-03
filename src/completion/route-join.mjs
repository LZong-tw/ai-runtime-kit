import { isBoundedId } from './checkpoint.mjs';
import { createHash } from 'node:crypto';

const unknown = () => ({ status: 'unknown' });
const validKey = (key) => key && ['sessionId', 'workspaceId', 'requestId'].every((field) => isBoundedId(key[field]))
  && Number.isSafeInteger(key.generation) && key.generation > 0;
const sameKey = (a, b) => validKey(a) && validKey(b)
  && ['sessionId', 'workspaceId', 'requestId', 'generation'].every((field) => a[field] === b[field]);

function family(model) {
  if (/^gpt-6(?:\.1)?(?:-(?:sol|astra|luna))?$/.test(model)) return 'gpt';
  if (/^claude-(?:sonnet|opus|haiku)-[0-9]+(?:-[0-9]+)*$/.test(model)) return 'claude';
  return 'unknown';
}

/** Exact private producer bindings; no native acceptance is implied by injection. */
export function createRouteJoin({ validatedContract } = {}) {
  const bindings = new Map();
  const validated = validatedContract?.status === 'validated' && typeof validatedContract.decode === 'function';

  function observe(payload) {
    if (!validated) return unknown();
    let event;
    try { event = validatedContract.decode(payload); } catch { return unknown(); }
    if (!validKey(event?.key) || !isBoundedId(event.transportRequestId) || !isBoundedId(event.provider)
      || typeof event.model !== 'string' || event.model.length > 128 || family(event.model) === 'unknown') return unknown();
    const prior = bindings.get(event.transportRequestId);
    if (bindings.has(event.transportRequestId) && (!prior || !sameKey(prior.key, event.key)
      || prior.providerId !== event.provider || prior.rawModel !== event.model)) {
      bindings.set(event.transportRequestId, null);
      return unknown();
    }
    if (!bindings.has(event.transportRequestId) && bindings.size >= 128) return unknown();
    bindings.set(event.transportRequestId, { key: structuredClone(event.key), providerId: event.provider,
      modelId: `model-${createHash('sha256').update(event.model).digest('hex')}`,
      rawModel: event.model, modelFamily: family(event.model) });
    return { status: 'ok' };
  }

  function resolve(observation, key) {
    if (!validated || !sameKey(observation?.key, key) || !isBoundedId(observation.transportRequestId)) return unknown();
    const binding = bindings.get(observation.transportRequestId);
    if (!binding || !sameKey(binding.key, key) || binding.providerId !== observation.provider
      || binding.rawModel !== observation.model) return unknown();
    return { status: 'ok', key: structuredClone(binding.key), providerId: binding.providerId,
      modelId: binding.modelId, modelFamily: binding.modelFamily };
  }

  return Object.freeze({ observe, resolve });
}
