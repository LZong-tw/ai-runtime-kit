import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createPluginCoreClient,
  createPluginFixture,
  createPluginRequest,
  createRecordingResponse,
  message,
} from "./helpers/compat-fixtures.mjs";

// pxpipe gives up on a hop that sends no response headers for 300 s. These tests
// shrink the keepalive interval to a few milliseconds and hold the upstream call
// open, so "the client hears from us before the upstream answers" is observable.
const KEEPALIVE_MS = 5;

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function waitFor(predicate, label, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

function sseEvents(buffer) {
  return buffer.toString("utf8").split("\n\n").filter(Boolean).map((frame) => {
    const lines = frame.split("\n");
    const event = lines.find((line) => line.startsWith("event: "))?.slice(7);
    const data = lines.find((line) => line.startsWith("data: "))?.slice(6);
    return { event, data: data === undefined ? undefined : JSON.parse(data) };
  });
}

function pingCount(response) {
  return sseEvents(response.body).filter((frame) => frame.event === "ping").length;
}

// The bridged tool-search definition keeps a request on the compat path; an
// executor reply with no bridge call is the final answer.
function textRequest(stream) {
  return toolSearchRequest(stream, "think for a long time");
}

function toolSearchRequest(stream = true, prompt = "Search tools.") {
  return {
    model: "executor-model",
    max_tokens: 512,
    messages: [{ role: "user", content: prompt }],
    stream,
    tools: [
      { type: "tool_search_tool_regex_20251119", name: "tool_search_tool_regex" },
      {
        name: "get_weather",
        description: "Get weather",
        defer_loading: true,
        input_schema: { type: "object", properties: {} },
      },
    ],
  };
}

function codeExecutionRequest() {
  return {
    model: "executor-model",
    max_tokens: 512,
    messages: [{ role: "user", content: "run code" }],
    stream: true,
    tools: [{ type: "code_execution_20260521", name: "code_execution" }],
  };
}

async function slowExecutorFixture() {
  const pending = [];
  const fixture = await createPluginFixture({
    sseKeepaliveMs: KEEPALIVE_MS,
    coreClient: createPluginCoreClient({
      requestMessage(body, headers, signal) {
        const call = { body: structuredClone(body), signal, ...deferred() };
        pending.push(call);
        return call.promise;
      },
    }),
  });
  return { fixture, pending };
}

function send(fixture, body, response) {
  return fixture.messages.handler(
    createPluginRequest(Buffer.from(JSON.stringify(body))),
    response,
    fixture.helpers,
  );
}

test("a stream:true client gets SSE headers and pings while the executor is still generating", async () => {
  const { fixture, pending } = await slowExecutorFixture();
  const response = createRecordingResponse();
  const handled = send(fixture, textRequest(true), response);

  await waitFor(() => pending.length === 1, "the executor call");
  await waitFor(() => pingCount(response) >= 2, "keepalive pings before the upstream reply");
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["content-type"], "text/event-stream");
  assert.equal(typeof response.headers["x-airkit-request-id"], "string");
  assert.equal(pending[0].body.stream, false, "the executor call itself stays buffered");

  pending[0].resolve(message({ content: [{ type: "text", text: "slow answer" }] }));
  await handled;

  const frames = sseEvents(response.body);
  const start = frames.findIndex((frame) => frame.event === "message_start");
  assert.ok(start > 0, "message_start follows the keepalive pings");
  assert.ok(frames.slice(0, start).every((frame) => frame.event === "ping"));
  assert.ok(frames.slice(start).every((frame) => frame.event !== "ping"), "no ping inside the message");
  assert.deepEqual(frames.at(-1), { event: "message_stop", data: { type: "message_stop" } });
  const delta = frames.find((frame) => frame.event === "content_block_delta");
  assert.equal(delta.data.delta.text, "slow answer");
  assert.equal(response.ended, true);
});

test("a stream:false client still gets one JSON response with no early bytes", async () => {
  const { fixture, pending } = await slowExecutorFixture();
  const response = createRecordingResponse();
  const handled = send(fixture, textRequest(false), response);

  await waitFor(() => pending.length === 1, "the executor call");
  await new Promise((resolve) => setTimeout(resolve, KEEPALIVE_MS * 6));
  assert.equal(response.headersSent, false);
  assert.equal(response.body.length, 0);

  pending[0].resolve(message({ content: [{ type: "text", text: "json answer" }] }));
  await handled;
  assert.equal(response.headers["content-type"], "application/json");
  assert.equal(JSON.parse(response.body).content[0].text, "json answer");
});

test("a fast stream:true reply is written exactly as before, without pings", async () => {
  const fixture = await createPluginFixture({
    sseKeepaliveMs: 60_000,
    coreClient: createPluginCoreClient({
      async requestMessage() { return message({ content: [{ type: "text", text: "quick" }] }); },
    }),
  });
  const response = createRecordingResponse();
  await send(fixture, textRequest(true), response);
  const frames = sseEvents(response.body);
  assert.equal(frames[0].event, "message_start");
  assert.equal(pingCount(response), 0);
});

test("a fast upstream rejection keeps its real HTTP status and retry-after", async () => {
  const fixture = await createPluginFixture({
    sseKeepaliveMs: 60_000,
    coreClient: createPluginCoreClient({
      async requestMessage() {
        throw Object.assign(new Error("rate limited"), { status: 429, headers: { "retry-after": "7" } });
      },
    }),
  });
  const response = createRecordingResponse();
  await send(fixture, textRequest(true), response);
  assert.equal(response.statusCode, 429);
  assert.equal(response.headers["retry-after"], "7");
  assert.equal(response.headers["content-type"], "application/json");
});

test("pings keep flowing across every upstream call of the executor loop", async () => {
  const { fixture, pending } = await slowExecutorFixture();
  const response = createRecordingResponse();
  const handled = send(fixture, toolSearchRequest(), response);

  await waitFor(() => pending.length === 1, "the first executor call");
  await waitFor(() => pingCount(response) >= 2, "pings during the first call");
  pending[0].resolve(message({
    stop_reason: "tool_use",
    content: [{ type: "tool_use", id: "toolu_search", name: "airkit_tool_search", input: { query: "weather" } }],
  }));

  await waitFor(() => pending.length === 2, "the second executor call");
  const pingsAtSecondCall = pingCount(response);
  await waitFor(() => pingCount(response) >= pingsAtSecondCall + 2, "pings during the second call");
  pending[1].resolve(message({ content: [{ type: "text", text: "after search" }] }));
  await handled;

  const frames = sseEvents(response.body);
  const start = frames.findIndex((frame) => frame.event === "message_start");
  assert.ok(start >= 4);
  assert.deepEqual(
    frames.filter((frame) => frame.event === "content_block_start").map((frame) => frame.data.content_block.type),
    ["server_tool_use", "tool_search_tool_result", "text"],
    "the loop still rewrites the full reply before it is written",
  );
  assert.equal(frames.at(-1).event, "message_stop");
});

test("an upstream failure after the headers went out ends the stream with an SSE error event", async () => {
  const { fixture, pending } = await slowExecutorFixture();
  const response = createRecordingResponse();
  const handled = send(fixture, textRequest(true), response);

  await waitFor(() => pingCount(response) >= 1, "the first ping");
  pending[0].reject(Object.assign(new Error("upstream overloaded"), { status: 529 }));
  await handled;

  assert.equal(response.statusCode, 200);
  assert.equal(response.ended, true, "the stream is ended, not destroyed");
  const frames = sseEvents(response.body);
  assert.equal(frames.at(-1).event, "error");
  assert.equal(frames.at(-1).data.type, "error");
  // Claude Code retries a stream only when the error names overloaded_error.
  assert.equal(frames.at(-1).data.error.type, "overloaded_error");
  assert.equal(frames.at(-1).data.error.request_id, response.headers["x-airkit-request-id"]);
  const pings = pingCount(response);
  await new Promise((resolve) => setTimeout(resolve, KEEPALIVE_MS * 4));
  assert.equal(pingCount(response), pings, "no write after the stream ended");
});

test("an executor rejection after the pings keeps the upstream error type, message, and retry delay", async () => {
  const { fixture, pending } = await slowExecutorFixture();
  const response = createRecordingResponse();
  const handled = send(fixture, textRequest(true), response);

  await waitFor(() => pingCount(response) >= 1, "the first ping");
  pending[0].reject(Object.assign(new Error("rate limited"), {
    status: 429,
    headers: new Headers({ "retry-after": "7" }),
    upstreamBody: JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "Slow down" } }),
  }));
  await handled;

  const { error } = sseEvents(response.body).at(-1).data;
  assert.equal(error.type, "rate_limit_error");
  assert.match(error.message, /^Slow down/);
  assert.match(error.message, /retry-after: 7/);
  assert.equal(error.request_id, response.headers["x-airkit-request-id"]);
});

test("a client disconnect aborts the upstream call and stops the pings", async () => {
  const { fixture, pending } = await slowExecutorFixture();
  const response = createRecordingResponse();
  const handled = send(fixture, textRequest(true), response);

  await waitFor(() => pingCount(response) >= 1, "the first ping");
  response.emit("close");
  assert.equal(pending[0].signal.aborted, true, "upstream sees the disconnect");
  const bytes = response.body.length;
  await new Promise((resolve) => setTimeout(resolve, KEEPALIVE_MS * 4));
  assert.equal(response.body.length, bytes, "nothing is written after the client left");

  pending[0].reject(new DOMException("This operation was aborted", "AbortError"));
  await handled;
  assert.equal(response.body.length, bytes);
});

async function slowFallbackFixture() {
  const pending = [];
  const fixture = await createPluginFixture({
    sseKeepaliveMs: KEEPALIVE_MS,
    coreClient: createPluginCoreClient({
      requestFallback(body, headers, signal) {
        const call = { body: structuredClone(body), signal, ...deferred() };
        pending.push(call);
        return call.promise;
      },
    }),
  });
  return { fixture, pending };
}

test("a slow whole-request fallback pipes its SSE body after the pings with one set of headers", async () => {
  const { fixture, pending } = await slowFallbackFixture();
  const response = createRecordingResponse();
  const handled = send(fixture, codeExecutionRequest(), response);

  await waitFor(() => pending.length === 1, "the fallback call");
  await waitFor(() => pingCount(response) >= 2, "pings while the fallback has no headers yet");
  const upstream = "event: message_start\ndata: {\"type\":\"message_start\"}\n\n"
    + "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n";
  pending[0].resolve(new Response(upstream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  }));
  await handled;

  const body = response.body.toString("utf8");
  assert.ok(body.endsWith(upstream), "upstream bytes are relayed unchanged after the pings");
  assert.ok(sseEvents(Buffer.from(body.slice(0, -upstream.length))).every((frame) => frame.event === "ping"));
  assert.equal(response.statusCode, 200);
  assert.equal(response.ended, true);
});

test("a slow fallback rejection after the headers went out becomes the upstream SSE error", async () => {
  const { fixture, pending } = await slowFallbackFixture();
  const response = createRecordingResponse();
  const handled = send(fixture, codeExecutionRequest(), response);

  await waitFor(() => pingCount(response) >= 1, "the first ping");
  const upstreamError = { type: "error", error: { type: "overloaded_error", message: "Overloaded" } };
  pending[0].resolve(new Response(JSON.stringify(upstreamError), {
    status: 529,
    headers: { "content-type": "application/json" },
  }));
  await handled;

  assert.equal(response.statusCode, 200);
  assert.equal(response.ended, true);
  const frames = sseEvents(response.body);
  assert.deepEqual(frames.at(-1), { event: "error", data: upstreamError });
});

test("a fallback rejection without an Anthropic error body still names its status type", async () => {
  const { fixture, pending } = await slowFallbackFixture();
  const response = createRecordingResponse();
  const handled = send(fixture, codeExecutionRequest(), response);

  await waitFor(() => pingCount(response) >= 1, "the first ping");
  pending[0].resolve(new Response("<html>busy</html>", { status: 529, headers: { "content-type": "text/html" } }));
  await handled;

  const { error } = sseEvents(response.body).at(-1).data;
  assert.equal(error.type, "overloaded_error");
  assert.equal(error.request_id, response.headers["x-airkit-request-id"]);
});

test("a rate-limited fallback after the pings carries the retry delay it can no longer send as a header", async () => {
  const { fixture, pending } = await slowFallbackFixture();
  const response = createRecordingResponse();
  const handled = send(fixture, codeExecutionRequest(), response);

  await waitFor(() => pingCount(response) >= 1, "the first ping");
  const upstreamError = { type: "error", error: { type: "rate_limit_error", message: "Slow down" } };
  pending[0].resolve(new Response(JSON.stringify(upstreamError), {
    status: 429,
    headers: { "content-type": "application/json", "retry-after": "12" },
  }));
  await handled;

  const { error } = sseEvents(response.body).at(-1).data;
  assert.equal(error.type, "rate_limit_error");
  assert.equal(error.message, "Slow down (retry-after: 12)");
});
