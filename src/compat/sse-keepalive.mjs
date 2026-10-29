// The compat path buffers every upstream reply before it can answer: the
// executor loop rewrites tool calls and Advisor turns, and the forged-text
// guards need the whole message. A proxy in front of the gateway gives up on a
// hop that sends no response headers for a while (pxpipe: 300 s), so a long
// generation used to fail even though the upstream was still working.
//
// For a stream:true client the reply is SSE anyway, so the headers can go out
// early. A keepalive commits 200 + SSE headers and a first Anthropic `ping`
// after one quiet delay, then pings at a slower interval until a writer claims
// the stream. Replies that finish within the first delay are written exactly
// as before.
//
// The two timings answer different budgets. pxpipe allows 300 s for the first
// byte and 120 s of silence after it (pxpipe-proxy dist/core/proxy.js:19,:21),
// so the first delay stays short and the interval stays under 120 s. Claude
// Code stops resetting its idle watchdog after 30 consecutive pings and its
// idle timeout is at least 300 s, so fewer pings buy a longer generation:
// 30 pings at 60 s cover 30 minutes, where 15 s pings ran out after 7.5.

export const DEFAULT_SSE_FIRST_HEADERS_MS = 15_000;
export const DEFAULT_SSE_PING_INTERVAL_MS = 60_000;

const SSE_HEADERS = Object.freeze({
  "cache-control": "no-cache",
  connection: "keep-alive",
  "content-type": "text/event-stream",
});

const keepalives = new WeakMap();

export function startSseKeepalive(response, {
  firstHeadersMs = DEFAULT_SSE_FIRST_HEADERS_MS,
  pingIntervalMs = DEFAULT_SSE_PING_INTERVAL_MS,
  signal,
} = {}) {
  const state = { pinging: false, timer: null, clear: null };
  const ping = () => {
    if (signal?.aborted === true || response.writableEnded === true || response.destroyed === true) {
      return stop(state);
    }
    if (response.headersSent !== true) {
      response.writeHead(200, SSE_HEADERS);
      state.pinging = true;
    }
    response.write("event: ping\ndata: {\"type\":\"ping\"}\n\n");
  };
  const schedule = (handle, clear) => {
    state.timer = handle;
    state.clear = clear;
    handle.unref?.();
  };
  schedule(setTimeout(() => {
    ping();
    if (state.timer !== null) schedule(setInterval(ping, pingIntervalMs), clearInterval);
  }, firstHeadersMs), clearTimeout);
  keepalives.set(response, state);
  signal?.addEventListener?.("abort", () => stop(state), { once: true });
  response.once?.("close", () => stop(state));
  return () => stop(state);
}

// A writer calls this before its first write. It stops the pings and reports
// whether the SSE headers are already on the wire, so the writer must not send
// its own status line.
export function claimSseStream(response) {
  const state = keepalives.get(response);
  if (state === undefined) return false;
  stop(state);
  keepalives.delete(response);
  return state.pinging;
}

// True while the client has seen only headers and pings: a failure can still be
// reported as an SSE `error` event instead of a torn connection.
export function sseKeepaliveOwnsStream(response) {
  return keepalives.get(response)?.pinging === true;
}

export function writeSseError(response, error) {
  response.write(`event: error\ndata: ${JSON.stringify(error)}\n\n`);
}

// Anthropic's error types by HTTP status. Once pings have committed a 200, the
// error event's type is the only retry signal a client has left: Claude Code
// retries a stream that fails with `overloaded_error`, and treats `api_error`
// as final.
const ERROR_TYPES = new Map([
  [400, "invalid_request_error"],
  [401, "authentication_error"],
  [402, "billing_error"],
  [403, "permission_error"],
  [404, "not_found_error"],
  [413, "request_too_large"],
  [429, "rate_limit_error"],
  [500, "api_error"],
  [504, "timeout_error"],
  [529, "overloaded_error"],
]);

// Builds the SSE error event for an upstream rejection that arrives after the
// headers went out. An Anthropic error envelope in the upstream body is kept
// as is; anything else gets the type that matches the upstream status. The
// status line already said 200, so a Retry-After header can only travel in the
// message text.
export function upstreamSseError({ status, body = null, retryAfter = null, message, requestId = null }) {
  const event = parseErrorEnvelope(body) ?? {
    type: "error",
    error: {
      type: ERROR_TYPES.get(status) ?? "api_error",
      message: message ?? `Upstream provider rejected the request (HTTP ${status})`,
      ...(requestId === null ? {} : { request_id: requestId }),
    },
  };
  if (typeof event.error.type !== "string") event.error.type = ERROR_TYPES.get(status) ?? "api_error";
  if (retryAfter !== null && typeof event.error.message === "string") {
    event.error.message += ` (retry-after: ${retryAfter})`;
  }
  return event;
}

function parseErrorEnvelope(body) {
  if (body === null || body === undefined) return null;
  try {
    const parsed = JSON.parse(Buffer.isBuffer(body) ? body.toString("utf8") : String(body));
    const valid = parsed?.type === "error" && parsed.error !== null && typeof parsed.error === "object" &&
      !Array.isArray(parsed.error);
    return valid ? parsed : null;
  } catch {
    return null;
  }
}

function stop(state) {
  if (state.timer !== null) state.clear(state.timer);
  state.timer = null;
}
