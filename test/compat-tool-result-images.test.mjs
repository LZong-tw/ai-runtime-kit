import assert from "node:assert/strict";
import { test } from "node:test";
import { Writable } from "node:stream";
import { createGatewayClient } from "../src/compat/gateway.mjs";
import { hoistToolResultImages } from "../src/compat/tool-result-images.mjs";

const providers = [
  { name: "chat", type: "openai_chat_completions", models: ["model-a"] },
  { name: "responses", type: "openai_responses", models: ["model-b"] },
  { name: "messages", type: "anthropic_messages", models: ["claude-sonnet-5-5"] },
];

const png = (data) => ({ type: "image", source: { type: "base64", media_type: "image/png", data } });
const text = (value) => ({ type: "text", text: value });
const marker = (n, total) => text(`[image ${n} of ${total} from this tool result is attached separately as user content]`);
const label = (id, n, total) => text(`[image ${n} of ${total} from tool result ${id}]`);

function request(content, model = "chat/model-a") {
  return {
    model,
    max_tokens: 64,
    messages: [
      { role: "user", content: [text("Take a screenshot")] },
      { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "a.png" } }] },
      { role: "user", content },
    ],
  };
}

function hoist(body) {
  const raw = Buffer.from(JSON.stringify(body));
  const out = hoistToolResultImages(raw, providers);
  return { raw, out, sent: JSON.parse(out) };
}

test("an image-only tool_result keeps a marker and its image follows the tool results", () => {
  const { sent } = hoist(request([{ type: "tool_result", tool_use_id: "toolu_1", content: [png("AAAA")] }]));
  assert.deepEqual(sent.messages[2].content, [
    { type: "tool_result", tool_use_id: "toolu_1", content: [marker(1, 1)] },
    label("toolu_1", 1, 1),
    png("AAAA"),
  ]);
  assert.equal(sent.messages.length, 3);
});

test("text in a tool_result stays in place around the image markers", () => {
  const { sent } = hoist(request([{
    type: "tool_result",
    tool_use_id: "toolu_1",
    content: [text("Before"), png("AAAA"), text("Between"), png("BBBB")],
  }]));
  assert.deepEqual(sent.messages[2].content, [
    {
      type: "tool_result",
      tool_use_id: "toolu_1",
      content: [text("Before"), marker(1, 2), text("Between"), marker(2, 2)],
    },
    label("toolu_1", 1, 2),
    png("AAAA"),
    label("toolu_1", 2, 2),
    png("BBBB"),
  ]);
});

test("images from several tool_results follow the last one in order, before trailing user text", () => {
  const { sent } = hoist(request([
    { type: "tool_result", tool_use_id: "toolu_1", content: [png("AAAA")] },
    { type: "tool_result", tool_use_id: "toolu_2", content: "plain output" },
    { type: "tool_result", tool_use_id: "toolu_3", content: [text("Shot"), png("CCCC")] },
    text("<system-reminder>synthetic</system-reminder>"),
    text("Next question"),
  ]));
  assert.deepEqual(sent.messages[2].content, [
    { type: "tool_result", tool_use_id: "toolu_1", content: [marker(1, 1)] },
    { type: "tool_result", tool_use_id: "toolu_2", content: "plain output" },
    { type: "tool_result", tool_use_id: "toolu_3", content: [text("Shot"), marker(1, 1)] },
    label("toolu_1", 1, 1),
    png("AAAA"),
    label("toolu_3", 1, 1),
    png("CCCC"),
    text("<system-reminder>synthetic</system-reminder>"),
    text("Next question"),
  ]);
});

test("is_error and cache_control stay on the tool_result and images move verbatim", () => {
  const cached = { ...png("AAAA"), cache_control: { type: "ephemeral" } };
  const { sent } = hoist(request([{
    type: "tool_result",
    tool_use_id: "toolu_1",
    is_error: true,
    cache_control: { type: "ephemeral", ttl: "1h" },
    content: [cached],
  }]));
  assert.deepEqual(sent.messages[2].content, [
    {
      type: "tool_result",
      tool_use_id: "toolu_1",
      is_error: true,
      cache_control: { type: "ephemeral", ttl: "1h" },
      content: [marker(1, 1)],
    },
    label("toolu_1", 1, 1),
    cached,
  ]);
});

test("tool_reference blocks stay inside the tool_result", () => {
  const reference = { type: "tool_reference", tool_name: "Grep" };
  const { sent } = hoist(request([{ type: "tool_result", tool_use_id: "toolu_1", content: [reference, png("AAAA")] }]));
  assert.deepEqual(sent.messages[2].content[0].content, [reference, marker(1, 1)]);
});

test("no marker is left beside a document or search_result that carries no top-level text", () => {
  const doc = { type: "document", source: { type: "text", media_type: "text/plain", data: "doc body" } };
  const found = { type: "search_result", source: "https://example.test", title: "t", content: [text("hit")] };
  for (const others of [[doc], [found], [doc, found], [doc, text("")]]) {
    const { sent } = hoist(request([{ type: "tool_result", tool_use_id: "toolu_1", content: [others[0], png("AAAA"), ...others.slice(1)] }]));
    assert.deepEqual(sent.messages[2].content, [
      { type: "tool_result", tool_use_id: "toolu_1", content: others },
      label("toolu_1", 1, 1),
      png("AAAA"),
    ]);
  }
});

test("markers stay when the tool_result text already hides opaque blocks or only empty text remains", () => {
  const doc = { type: "document", source: { type: "text", media_type: "text/plain", data: "doc body" } };
  const withText = hoist(request([{ type: "tool_result", tool_use_id: "toolu_1", content: [text("Shot"), doc, png("AAAA")] }]));
  assert.deepEqual(withText.sent.messages[2].content[0].content, [text("Shot"), doc, marker(1, 1)]);
  const emptyText = hoist(request([{ type: "tool_result", tool_use_id: "toolu_1", content: [text(""), png("AAAA")] }]));
  assert.deepEqual(emptyText.sent.messages[2].content[0].content, [text(""), marker(1, 1)]);
});

test("bodies without tool_result images are returned as the same object", () => {
  for (const content of [
    [{ type: "tool_result", tool_use_id: "toolu_1", content: "string output with an \"image\" word" }],
    [{ type: "tool_result", tool_use_id: "toolu_1", content: [text("text only")] }],
    [{ type: "tool_result", tool_use_id: "toolu_1", content: "ok" }, png("AAAA"), text("user image")],
  ]) {
    const raw = Buffer.from(JSON.stringify(request(content)));
    assert.equal(hoistToolResultImages(raw, providers), raw);
  }
});

test("an assistant message is never rewritten", () => {
  const body = request([text("hi")]);
  body.messages[1].content.push({ type: "tool_result", tool_use_id: "toolu_x", content: [png("AAAA")] });
  const raw = Buffer.from(JSON.stringify(body));
  assert.equal(hoistToolResultImages(raw, providers), raw);
});

test("a second pass leaves the rewritten body unchanged", () => {
  const { out } = hoist(request([{ type: "tool_result", tool_use_id: "toolu_1", content: [png("AAAA")] }]));
  assert.equal(hoistToolResultImages(out, providers), out);
});

test("Anthropic Messages targets keep images inside tool_result; unbound and Responses models are rewritten", () => {
  const content = [{ type: "tool_result", tool_use_id: "toolu_1", content: [png("AAAA")] }];
  const anthropic = Buffer.from(JSON.stringify(request(content, "messages/claude-sonnet-5-5")));
  assert.equal(hoistToolResultImages(anthropic, providers), anthropic);
  for (const model of ["responses/model-b", "unknown/model", "claude-sonnet-5-5"]) {
    const { sent } = hoist(request(content, model));
    assert.deepEqual(sent.messages[2].content.at(-1), png("AAAA"), model);
  }
});

test("only the changed content array is re-encoded", () => {
  const before = '{"model":"chat/model-a","max_tokens":12345678901234567890,"metadata":{"note":"caf\\u00e9"},"messages":[' +
    '{"role":"user","content":[{"type":"text","text":"keep \\u00e9 escaped"}]},' +
    '{"role":"assistant","content":[{"type":"tool_use","id":"toolu_1","name":"Read","input":{}}]},' +
    '{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_1","content":[{"type":"image","source":{"type":"base64","media_type":"image/png","data":"AAAA"}}]}]}]}';
  const out = hoistToolResultImages(before, providers);
  assert.equal(typeof out, "string");
  const prefix = before.slice(0, before.lastIndexOf('"content":[{"type":"tool_result"') + '"content":'.length);
  assert.ok(out.startsWith(prefix));
  assert.ok(out.endsWith("}]}"));
  assert.equal(JSON.parse(out).messages[2].content.length, 3);
});

test("ambiguous, malformed or non-buffer input is returned unchanged", () => {
  const image = '{"type":"tool_result","tool_use_id":"t","content":[{"type":"image","source":{}}]}';
  for (const raw of [
    Buffer.from(`{"model":"chat/model-a","messages":[],"messages":[{"role":"user","content":[${image}]}]}`),
    Buffer.from(`{"model":"chat/model-a","messages":[{"role":"user","role":"user","content":[${image}]}]}`),
    Buffer.from('{"tool_result" "image"'),
    Buffer.from([0xff]),
  ]) assert.equal(hoistToolResultImages(raw, providers), raw);
  const stream = { pipe() {} };
  assert.equal(hoistToolResultImages(stream, providers), stream);
});

async function capture(body, method) {
  let sent;
  const client = createGatewayClient({
    origin: "http://127.0.0.1:3456",
    token: "synthetic-token",
    providers,
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
  test(`${method} hoists tool_result images`, async () => {
    const body = request([{ type: "tool_result", tool_use_id: "toolu_1", content: [png("AAAA")] }]);
    const original = structuredClone(body);
    const sent = await capture(body, method);
    assert.deepEqual(sent.messages[2].content.at(-1), png("AAAA"));
    assert.deepEqual(body, original);
  });
}

test("raw primary and fallback attempts send the hoisted bytes", async () => {
  const sent = [];
  const client = createGatewayClient({
    origin: "http://127.0.0.1:3456",
    token: "synthetic-token",
    providers,
    async fetchImpl(_url, options) {
      sent.push(Buffer.from(options.body));
      return new Response("fixture", { status: sent.length === 1 ? 401 : 200 });
    },
  });
  const response = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  response.writeHead = () => {};
  const content = [{ type: "tool_result", tool_use_id: "toolu_1", content: [png("AAAA")] }];
  await client.forwardRaw({
    body: Buffer.from(JSON.stringify(request(content, "responses/model-b"))),
    fallback: { body: Buffer.from(JSON.stringify(request(content, "messages/claude-sonnet-5-5"))), statuses: [401] },
    headers: {},
    response,
  });
  assert.equal(sent.length, 2);
  assert.deepEqual(JSON.parse(sent[0]).messages[2].content.at(-1), png("AAAA"));
  assert.deepEqual(JSON.parse(sent[1]).messages[2].content, content);
});
