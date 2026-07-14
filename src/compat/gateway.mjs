import { readFileSync } from "node:fs";

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

export function createCoreClient({ config, fetchImpl = fetch, readFile = readFileSync }) {
  const endpoint = coreMessagesEndpoint(config.gateway);
  const coreHeaders = (headers = {}) => ({
    ...copySafeAnthropicHeaders(headers),
    "content-type": "application/json",
    "x-ccr-core-auth": readGeneratedCoreToken(config.gateway.generatedConfigFile, readFile),
  });

  return {
    async requestMessage(body, headers) {
      const result = await fetchImpl(endpoint, {
        method: "POST",
        headers: coreHeaders(headers),
        body: JSON.stringify({ ...body, stream: false }),
      });
      return parseCoreMessageResponse(result);
    },
    async forwardRaw({ body, headers, method = "POST", response, signal }) {
      const result = await fetchImpl(endpoint, {
        method,
        headers: coreHeaders(headers),
        body,
        signal,
      });
      await pipeCoreResponse(result, response, signal);
    },
  };
}

function coreMessagesEndpoint({ coreHost, corePort }) {
  let host = coreHost;
  if (host === "0.0.0.0") host = "127.0.0.1";
  if (host === "::") host = "::1";
  if (host.includes(":")) host = `[${host}]`;
  return `http://${host}:${corePort}/v1/messages`;
}

function copySafeAnthropicHeaders(headers) {
  const safeHeaders = {};
  for (const [rawName, value] of new Headers(headers)) {
    const name = rawName.toLowerCase();
    if (name.startsWith("x-ccr-")) continue;
    if (SAFE_HEADER_NAMES.has(name)) {
      safeHeaders[name] = value;
    }
  }
  return safeHeaders;
}

function readGeneratedCoreToken(path, readFile) {
  let config;
  try {
    config = JSON.parse(readFile(path, "utf8").toString());
  } catch {
    throw new Error("Unable to read generated CCR core authentication");
  }

  const keys = config?.auth?.staticApiKeys?.keys;
  const entry = Array.isArray(keys)
    ? keys.find(
        (key) =>
          (typeof key === "string" && key.trim().length > 0) ||
          (typeof key?.key === "string" && key.key.trim().length > 0),
      )
    : undefined;
  const token = typeof entry === "string" ? entry : entry?.key;
  if (typeof token !== "string" || token.trim().length === 0) {
    throw new Error("Generated CCR core authentication is missing or invalid");
  }
  return token;
}

async function parseCoreMessageResponse(response) {
  return response.json();
}

async function pipeCoreResponse(result, response, signal) {
  const headers = Object.fromEntries(result.headers);
  response.writeHead(result.status, headers);
  if (result.body === null) {
    await endResponse(response, signal);
    return;
  }

  const reader = result.body.getReader();
  try {
    while (true) {
      const { done, value } = await waitForPassthrough(reader.read(), response, signal);
      if (done) break;
      if (!response.write(Buffer.from(value))) {
        await waitForResponseEvent(response, "drain", signal);
      }
    }
    await endResponse(response, signal);
  } catch (error) {
    await reader.cancel(error).catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}

async function endResponse(response, signal) {
  const finished = waitForResponseEvent(response, "finish", signal);
  response.end();
  await finished;
}

function waitForResponseEvent(response, eventName, signal) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      response.off(eventName, onEvent);
      response.off("close", onClose);
      response.off("error", onError);
      signal?.removeEventListener("abort", onAbort);
    };
    const settle = (callback, value) => {
      cleanup();
      callback(value);
    };
    const onEvent = () => settle(resolve);
    const onClose = () => settle(reject, downstreamClosedError());
    const onError = () => settle(reject, downstreamFailedError());
    const onAbort = () => settle(reject, passthroughAbortError());

    response.once(eventName, onEvent);
    response.once("close", onClose);
    response.once("error", onError);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (response.destroyed === true) onClose();
    else if (signal?.aborted) onAbort();
  });
}

function waitForPassthrough(operation, response, signal) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      response.off("close", onClose);
      response.off("error", onError);
      signal?.removeEventListener("abort", onAbort);
    };
    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };
    const onClose = () => settle(reject, downstreamClosedError());
    const onError = () => settle(reject, downstreamFailedError());
    const onAbort = () => settle(reject, passthroughAbortError());

    response.once("close", onClose);
    response.once("error", onError);
    signal?.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(operation).then(
      (value) => settle(resolve, value),
      (error) => settle(reject, error),
    );
    if (response.destroyed === true) onClose();
    else if (signal?.aborted) onAbort();
  });
}

function downstreamClosedError() {
  return Object.assign(new Error("CCR passthrough downstream closed"), {
    code: "ERR_STREAM_PREMATURE_CLOSE",
  });
}

function downstreamFailedError() {
  return Object.assign(new Error("CCR passthrough downstream failed"), {
    code: "ERR_STREAM_DESTROYED",
  });
}

function passthroughAbortError() {
  return new DOMException("This operation was aborted", "AbortError");
}
