import assert from "node:assert/strict";
import { test } from "node:test";
import { Writable } from "node:stream";
import { createGatewayClient } from "../src/compat/gateway.mjs";
import { normalizeResponsesThinkingHistory } from "../src/compat/reasoning-history.mjs";

const providers = [
  { name: "responses", type: "openai_responses", models: ["gpt-6-astra"] },
  { name: "chat", type: "openai_chat_completions", models: ["gpt-6-astra"] },
  { name: "anthropic", type: "anthropic_messages", models: ["claude-opus-5.5"] },
];

function history(model = "responses/gpt-6-astra") {
  return {
    model,
    messages: [
      { role: "user", content: [{ type: "text", text: "Synthetic question" }] },
      { role: "assistant", content: [
        { type: "thinking", thinking: "Synthetic prior reasoning", signature: "" },
        { type: "text", text: "Prior answer" },
        { type: "tool_use", id: "call_fixture", name: "read", input: { path: "fixture" } },
      ] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call_fixture", content: "result" }] },
    ],
  };
}

async function capture(body, method = "requestFallback", configuredProviders = providers) {
  let sent;
  const client = createGatewayClient({
    origin: "http://127.0.0.1:3456", token: "synthetic-token", providers: configuredProviders,
    async fetchImpl(_url, options) {
      sent = JSON.parse(options.body);
      return new Response(JSON.stringify({ type: "message", content: [{ type: "text", text: "ok" }] }), {
        headers: { "content-type": "application/json" },
      });
    },
  });
  await client[method](body, {});
  return sent;
}

for (const method of ["requestFallback", "requestMessage"]) {
  test(`${method} preserves unsigned thinking as text for the configured Responses target`, async () => {
    const body = history();
    const original = structuredClone(body);
    const sent = await capture(body, method);
    assert.deepEqual(sent.messages[1].content[0], { type: "text", text: "Synthetic prior reasoning" });
    assert.deepEqual(sent.messages[1].content.slice(1), body.messages[1].content.slice(1));
    assert.deepEqual(sent.messages[0], body.messages[0]);
    assert.deepEqual(sent.messages[2], body.messages[2]);
    assert.deepEqual(body, original);
  });
}

test("does not rewrite Chat, Anthropic, unknown providers or unlisted models", async () => {
  for (const model of ["chat/gpt-6-astra", "anthropic/claude-opus-5.5", "unknown/gpt-6-astra", "responses/gpt-other"]) {
    const body = history(model);
    assert.deepEqual(await capture(body), body);
  }
  const body = history();
  assert.deepEqual(await capture(body, "requestFallback", []), body);
});

test("preserves signed thinking and opaque reasoning blocks without forging or stripping them", async () => {
  const body = history();
  body.messages[1].content[0].signature = "signed-fixture";
  body.messages[1].content.push({ type: "redacted_thinking", data: "opaque-fixture" });
  assert.deepEqual(await capture(body), body);
});

test("raw history transformation preserves unrelated numeric and escaped source bytes", () => {
  const raw = Buffer.from('{ "model":"responses/gpt-6-astra", "messages":[{"role":"assistant","content":[{"type":"thinking","thinking":"prior\\u0020reasoning","signature":""},{"type":"tool_use","id":"call_fixture","name":"read","input":{"account_id":9007199254740993,"fraction":1.00000000000000001,"zero":-0}}]}] }');
  const transformed = normalizeResponsesThinkingHistory(raw, providers);
  assert.match(transformed.toString(), /"account_id":9007199254740993/);
  assert.match(transformed.toString(), /"fraction":1\.00000000000000001/);
  assert.match(transformed.toString(), /"zero":-0/);
  assert.match(transformed.toString(), /"text":"prior\\u0020reasoning"/);
});

test("raw primary and retry audit callbacks observe exactly the transformed bytes sent", async () => {
  const sent = [];
  const attempts = [];
  const bindings = structuredClone(providers);
  const client = createGatewayClient({
    origin: "http://127.0.0.1:3456", token: "synthetic-token", providers: bindings,
    async fetchImpl(_url, options) {
      sent.push(Buffer.from(options.body));
      return new Response("fixture", { status: sent.length === 1 ? 401 : 200 });
    },
  });
  bindings[0].type = "anthropic_messages";
  const response = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  response.writeHead = () => {};
  await client.forwardRaw({
    body: Buffer.from(JSON.stringify(history())),
    fallback: { body: Buffer.from(JSON.stringify(history())), statuses: [401] },
    headers: {}, response,
    onAttempt(attempt) { attempts.push({ ...attempt, body: Buffer.from(attempt.body) }); },
  });
  assert.equal(sent.length, 2);
  assert.deepEqual(attempts.map((attempt) => attempt.phase), ["start", "response", "start", "response"]);
  assert.deepEqual(attempts.map((attempt) => attempt.body), [sent[0], sent[0], sent[1], sent[1]]);
  for (const body of sent) assert.equal(JSON.parse(body).messages[1].content[0].type, "text");
});

test("bounded ambiguous or malformed inputs are unchanged rather than guessed", () => {
  for (const raw of [
    Buffer.from('{"model":"responses/gpt-6-astra","messages":[],"messages":[]}'),
    Buffer.from("{invalid"), Buffer.from([0xff]), Buffer.from("\ufeff{}"),
  ]) assert.equal(normalizeResponsesThinkingHistory(raw, providers), raw);
  const body = history();
  body.messages[1].content[0].cache_control = { type: "ephemeral" };
  body.messages[1].content.push({ type: "thinking", thinking: 'quoted " and \\ 繁中 😀' });
  const raw = Buffer.from(JSON.stringify(body));
  const out = normalizeResponsesThinkingHistory(raw, providers);
  assert.deepEqual(JSON.parse(out).messages[1].content[0].cache_control, { type: "ephemeral" });
  assert.equal(JSON.parse(out).messages[1].content.at(-1).text, 'quoted " and \\ 繁中 😀');
  assert.deepEqual(normalizeResponsesThinkingHistory(out, providers), out);
});

test("does not mistake object-shaped content for a native content array", () => {
  const body = history();
  body.messages[1].content = { 0: body.messages[1].content[0] };
  const raw = Buffer.from(JSON.stringify(body));
  assert.equal(normalizeResponsesThinkingHistory(raw, providers), raw);
});

test("recognizes actual CCR /model selector encodings without changing the model control", async () => {
  const hex = Buffer.from("responses/gpt-6-astra").toString("hex");
  for (const model of [`claude-ccr-h${hex}`, `anthropic/claude-ccr-h${hex}`, `anthropic/claude-ccr-h${hex}[1m]`]) {
    const body = history(model);
    const sent = await capture(body);
    assert.equal(sent.model, model);
    assert.deepEqual(sent.messages[1].content[0], { type: "text", text: "Synthetic prior reasoning" });
  }
});

test("unknown or malformed encoded selectors do not authorize history rewriting", async () => {
  for (const route of ["chat/gpt-6-astra", "unknown/gpt-6-astra", "responses/gpt-other"]) {
    const body = history(`anthropic/claude-ccr-h${Buffer.from(route).toString("hex")}`);
    assert.deepEqual(await capture(body), body);
  }
  for (const model of ["anthropic/claude-ccr-hff", "anthropic/claude-ccr-h123", "anthropic/claude-ccr-hzz"]) {
    const body = history(model);
    assert.deepEqual(await capture(body), body);
  }
});
