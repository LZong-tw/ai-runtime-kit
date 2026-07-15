import { resolveCompatibilityPolicies } from "./config.mjs";
import { inspectPendingServerHistory } from "./server-history.mjs";

const SAFE_HEADER_NAMES = new Set([
  "accept",
  "anthropic-beta",
  "anthropic-version",
  "b3",
  "baggage",
  "request-id",
  "traceparent",
  "tracestate",
  "user-agent",
  "x-amzn-trace-id",
  "x-b3-flags",
  "x-b3-parentspanid",
  "x-b3-sampled",
  "x-b3-spanid",
  "x-b3-traceid",
  "x-cloud-trace-context",
  "x-datadog-origin",
  "x-datadog-parent-id",
  "x-datadog-sampling-priority",
  "x-datadog-tags",
  "x-datadog-trace-id",
  "x-request-id",
]);

export function createFallbackRouter({ coreClient, config }) {
  if (typeof coreClient !== "function") throw new TypeError("fallback coreClient must be a function");
  const { fallback } = resolveCompatibilityPolicies(config, {});

  return async function route({ body, headers = {}, signal } = {}) {
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      throw new TypeError("fallback body must be an object");
    }
    if (signal?.aborted) throw new DOMException("This operation was aborted", "AbortError");

    const history = inspectPendingServerHistory(body);
    if (history.continuationTurns >= fallback.maxContinuationTurns) {
      throw Object.assign(new Error("Server-tool compatibility continuation limit reached"), {
        code: "compatibility_continuation_limit",
      });
    }

    return coreClient({
      body: { ...body, model: fallback.model },
      headers: copyAllowedHeaders(headers),
      signal,
    });
  };
}

function copyAllowedHeaders(headers) {
  const allowed = {};
  for (const [rawName, value] of new Headers(headers)) {
    const name = rawName.toLowerCase();
    if (SAFE_HEADER_NAMES.has(name)) allowed[name] = value;
  }
  return allowed;
}
