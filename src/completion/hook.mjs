import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createCompletionStore } from './store.mjs';
import { createCompletionController } from './controller.mjs';
import { createOwnedVerifier } from './verifier.mjs';
import { createRouteJoin } from './route-join.mjs';
import { createNativeAdapter } from './native-adapter.mjs';
import { runCompletionDispatch } from './dispatch.mjs';

export async function runCompletionHook({ env = process.env, input = process.stdin, output = process.stdout, mode = 'off' } = {}) {
  if (mode !== 'shadow') return { action: 'allow', reason: 'disabled', itemIds: [], remaining: 0 };
  const data = env.CLAUDE_PLUGIN_DATA;
  if (typeof data !== 'string' || !isAbsolute(data) || data.length > 4096) {
    return { action: 'degraded', reason: 'state_unknown', itemIds: [], remaining: 0 };
  }
  const store = createCompletionStore({ root: join(data, 'completion-v1') });
  const core = createCompletionController({ store, acceptedContracts: new Set(),
    verifier: createOwnedVerifier({ authorize: () => false }), routeJoin: createRouteJoin() });
  const controller = {
    beginRequest: core.beginRequest,
    transaction(key, operation, options) {
      return store.transaction(key, (state) => {
        // Receipts cannot certify native ingestion, continuous observation or multi-target closure.
        state.mode = 'shadow'; state.coverage = 'unknown';
        return operation(state);
      }, options);
    },
  };
  // Native and transport decoders require independently captured contracts; stdin cannot supply them.
  const adapter = createNativeAdapter({ controller });
  return runCompletionDispatch({ input, output, controller, adapter });
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) await runCompletionHook();
