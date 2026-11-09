import assert from "node:assert/strict";
import { test } from "node:test";
import { Writable } from "node:stream";
import { createGatewayClient } from "../src/compat/gateway.mjs";
import {
  validateCompatibilityConfig,
  validateCompatibilityProviderBinding,
} from "../src/compat/config.mjs";
import { normalizeRestrictedThinking } from "../src/compat/thinking-restrictions.mjs";

// Shapes captured from Web LiteLLM 400s on 2026-11-02..06: Claude Code sends
// `display: "updates"` and `type: "disabled"`, which that gateway's Messages
// validator rejects for claude-sonnet-5-5, claude-opus-5-5 and
// azure_ai/claude-fable-5-1.
const providers = [
  { name: "litellm", type: "anthropic_messages", models: ["claude-sonnet-5-5", "azure_ai/claude-fable-5-1"] },
  { name: "anthropic", type: "anthropic_messages", models: ["claude-sonnet-5-5"] },
  { name: "chat", type: "openai_chat_completions", models: ["Kimi-K3"] },
];
const restricted = ["litellm"];

function request(thinking, model = "litellm/claude-sonnet-5-5") {
  const body = {
    model,
    max_tokens: 64,
    messages: [{ role: "user", content: [{ type: "text", text: "Synthetic question" }] }],
  };
  if (thinking !== undefined) body.thinking = thinking;
  return body;
}

function normalize(body, names = restricted) {
  const raw = Buffer.from(JSON.stringify(body));
  const out = normalizeRestrictedThinking(raw, providers, names);
  return { raw, out, sent: JSON.parse(out) };
}

test("drops an adaptive display value the restricted provider does not accept", () => {
  const { sent } = normalize(request({ type: "adaptive", display: "updates" }));
  assert.deepEqual(sent.thinking, { type: "adaptive" });
});

test("removes disabled thinking instead of forwarding a type the provider rejects", () => {
  const { sent } = normalize(request({ type: "disabled" }));
  assert.equal(Object.hasOwn(sent, "thinking"), false);
  assert.equal(sent.max_tokens, 64);
  assert.deepEqual(sent.messages, request().messages);
});

test("removes disabled thinking whether it is the first, middle or last member", () => {
  for (const raw of [
    '{"thinking":{"type":"disabled"},"model":"litellm/claude-sonnet-5-5","messages":[]}',
    '{"model":"litellm/claude-sonnet-5-5", "thinking" : {"type":"disabled"} ,"messages":[]}',
    '{"model":"litellm/claude-sonnet-5-5","messages":[],"thinking":{"type":"disabled"}}',
  ]) {
    const out = normalizeRestrictedThinking(Buffer.from(raw), providers, restricted);
    assert.deepEqual(JSON.parse(out), { model: "litellm/claude-sonnet-5-5", messages: [] });
  }
});

test("keeps accepted thinking shapes byte-identical", () => {
  for (const thinking of [
    undefined,
    { type: "adaptive" },
    { type: "adaptive", display: "summarized" },
    { type: "adaptive", display: "omitted" },
    { type: "enabled", budget_tokens: 2048 },
  ]) {
    const { raw, out } = normalize(request(thinking));
    assert.equal(out, raw);
  }
});

test("leaves unlisted providers, non-Messages providers and unlisted models alone", () => {
  for (const model of ["anthropic/claude-sonnet-5-5", "chat/Kimi-K3", "litellm/claude-unlisted", "claude-sonnet-5-5"]) {
    const { raw, out } = normalize(request({ type: "adaptive", display: "updates" }, model));
    assert.equal(out, raw);
  }
  const { raw, out } = normalize(request({ type: "disabled" }), []);
  assert.equal(out, raw);
});

test("matches a provider-local model id that itself contains a slash", () => {
  const { sent } = normalize(request({ type: "adaptive", display: "updates" }, "litellm/azure_ai/claude-fable-5-1"));
  assert.deepEqual(sent.thinking, { type: "adaptive" });
});

test("recognizes the CCR hex selector encoding without changing the model control", () => {
  const hex = Buffer.from("litellm/claude-sonnet-5-5").toString("hex");
  const model = `claude-ccr-h${hex}`;
  const { sent } = normalize(request({ type: "adaptive", display: "updates" }, model));
  assert.equal(sent.model, model);
  assert.deepEqual(sent.thinking, { type: "adaptive" });
});

test("rewrites only the thinking member and preserves every other source byte", () => {
  const raw = Buffer.from('{ "model":"litellm/claude-sonnet-5-5", "thinking":{"type":"adaptive","display":"updates"}, "messages":[{"role":"assistant","content":[{"type":"tool_use","id":"call_fixture","name":"read","input":{"account_id":9007199254740993,"fraction":1.00000000000000001,"text":"a\\u0020b \\"thinking\\":{}"}}]}] }');
  const out = normalizeRestrictedThinking(raw, providers, restricted).toString();
  assert.equal(out, raw.toString().replace('{"type":"adaptive","display":"updates"}', '{"type":"adaptive"}'));
});

test("ambiguous, malformed or non-buffer input is returned unchanged", () => {
  for (const raw of [
    Buffer.from('{"model":"litellm/claude-sonnet-5-5","thinking":{"type":"disabled"},"thinking":{"type":"disabled"}}'),
    Buffer.from("{invalid"),
    Buffer.from([0xff]),
    Buffer.from('{"model":"litellm/claude-sonnet-5-5","thinking":"disabled"}'),
  ]) assert.equal(normalizeRestrictedThinking(raw, providers, restricted), raw);
  const stream = { pipe() {} };
  assert.equal(normalizeRestrictedThinking(stream, providers, restricted), stream);
  const text = JSON.stringify(request({ type: "adaptive", display: "updates" }));
  assert.equal(typeof normalizeRestrictedThinking(text, providers, restricted), "string");
});

async function capture(body, method) {
  let sent;
  const client = createGatewayClient({
    origin: "http://127.0.0.1:3456",
    token: "synthetic-token",
    providers,
    restrictedThinkingProviders: restricted,
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
  test(`${method} normalizes thinking for a restricted provider`, async () => {
    const body = request({ type: "adaptive", display: "updates" });
    const original = structuredClone(body);
    const sent = await capture(body, method);
    assert.deepEqual(sent.thinking, { type: "adaptive" });
    assert.deepEqual(body, original);
  });
}

test("raw primary and fallback attempts send and audit the normalized bytes", async () => {
  const sent = [];
  const attempts = [];
  const client = createGatewayClient({
    origin: "http://127.0.0.1:3456",
    token: "synthetic-token",
    providers,
    restrictedThinkingProviders: restricted,
    async fetchImpl(_url, options) {
      sent.push(Buffer.from(options.body));
      return new Response("fixture", { status: sent.length === 1 ? 401 : 200 });
    },
  });
  const response = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  response.writeHead = () => {};
  await client.forwardRaw({
    body: Buffer.from(JSON.stringify(request({ type: "adaptive", display: "updates" }, "chat/Kimi-K3"))),
    fallback: { body: Buffer.from(JSON.stringify(request({ type: "disabled" }))), statuses: [401] },
    headers: {},
    response,
    onAttempt(attempt) { attempts.push(Buffer.from(attempt.body)); },
  });
  assert.equal(sent.length, 2);
  assert.deepEqual(attempts, [sent[0], sent[0], sent[1], sent[1]]);
  assert.deepEqual(JSON.parse(sent[0]).thinking, { type: "adaptive", display: "updates" });
  assert.equal(Object.hasOwn(JSON.parse(sent[1]), "thinking"), false);
});

const CONFIG = {
  fallback: { provider: "litellm", model: "claude-sonnet-5-5", maxContinuationTurns: 8 },
  toolSearch: { mode: "bridge" },
  webSearch: { mode: "native-first" },
  webFetch: { mode: "native-first" },
  codeExecution: { mode: "anthropic-fallback" },
  advisor: { mode: "anthropic-fallback" },
  mcpConnector: { mode: "anthropic-fallback" },
};

test("restrictedThinkingProviders accepts provider identifiers only", () => {
  assert.doesNotThrow(() => validateCompatibilityConfig({ ...CONFIG, restrictedThinkingProviders: ["litellm"] }));
  for (const value of ["litellm", [""], ["a/b"], [1], {}]) {
    assert.throws(
      () => validateCompatibilityConfig({ ...CONFIG, restrictedThinkingProviders: value }),
      /restrictedThinkingProviders must be provider identifiers/,
    );
  }
});

test("restrictedThinkingProviders must bind to exactly one Anthropic Messages provider", () => {
  assert.doesNotThrow(() => validateCompatibilityProviderBinding(
    { ...CONFIG, restrictedThinkingProviders: ["litellm"] }, providers));
  assert.throws(
    () => validateCompatibilityProviderBinding({ ...CONFIG, restrictedThinkingProviders: ["missing"] }, providers),
    /restrictedThinkingProviders provider must resolve exactly once: missing/,
  );
  assert.throws(
    () => validateCompatibilityProviderBinding({ ...CONFIG, restrictedThinkingProviders: ["chat"] }, providers),
    /restrictedThinkingProviders provider must use anthropic_messages: chat/,
  );
});
