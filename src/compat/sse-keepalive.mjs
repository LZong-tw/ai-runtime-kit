// The compat path buffers every upstream reply before it can answer: the
// executor loop rewrites tool calls and Advisor turns, and the forged-text
// guards need the whole message. A proxy in front of the gateway gives up on a
// hop that sends no response headers for a while (pxpipe: 300 s), so a long
// generation used to fail even though the upstream was still working.
//
// For a stream:true client the reply is SSE anyway, so the headers can go out
// early. A keepalive commits 200 + SSE headers after one quiet interval and
// then sends Anthropic `ping` events until a writer claims the stream. Replies
// that finish within the first interval are written exactly as before.

export const DEFAULT_SSE_KEEPALIVE_MS = 15_000;

const SSE_HEADERS = Object.freeze({
  "cache-control": "no-cache",
  connection: "keep-alive",
  "content-type": "text/event-stream",
});

const keepalives = new WeakMap();

export function startSseKeepalive(response, { intervalMs = DEFAULT_SSE_KEEPALIVE_MS, signal } = {}) {
  const state = { pinging: false, timer: null };
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
  state.timer = setInterval(ping, intervalMs);
  state.timer.unref?.();
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

function stop(state) {
  if (state.timer !== null) clearInterval(state.timer);
  state.timer = null;
}
