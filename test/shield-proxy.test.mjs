import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, request as httpRequest } from "node:http";
import { test } from "node:test";

import { startShieldProxy } from "../src/shield/proxy.mjs";

const CAPABILITY = "c".repeat(32);

test("proxy forwards only after allow and never emits OAuth", async (t) => {
  const events = [];
  const upstream = await startFixture(t, async (request, response) => {
    assert.equal(request.url, "/v1/messages");
    assert.equal(request.headers.authorization, "Bearer oauth-secret");
    assert.equal(request.headers.cookie, "session=cookie-secret");
    assert.equal(request.headers["x-forwarded-host"], undefined);
    assert.equal(request.headers["x-airkit-shield"], undefined);
    assert.equal(await readBody(request), '{"private":"body-secret"}');
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"type":"message"}');
  });
  const shield = await startShield(t, {
    targetOrigin: upstream.origin,
    decide: async () => ({ action: "allow" }),
    onDecision: (event) => events.push(event),
  });

  const result = await fetch(`${shield.origin}/v1/messages`, {
    method: "POST",
    headers: {
      authorization: "Bearer oauth-secret",
      cookie: "session=cookie-secret",
      "content-type": "application/json",
      "x-forwarded-host": "target-switch-secret",
      "x-airkit-shield": CAPABILITY,
    },
    body: '{"private":"body-secret"}',
  });

  assert.equal(result.status, 200);
  assert.equal(await result.text(), '{"type":"message"}');
  assert.deepEqual(events, [{ action: "allow", reason: "allowed", bytes: 25, elapsedMs: events[0].elapsedMs }]);
  assert.equal(Number.isInteger(events[0].elapsedMs), true);
  assert.doesNotMatch(JSON.stringify(events), /oauth-secret|cookie-secret|body-secret|target-switch-secret/);
});

test("authentication and decision failure never contact upstream", async (t) => {
  let upstreamCalls = 0;
  const upstream = await startFixture(t, async (_request, response) => {
    upstreamCalls += 1;
    response.end();
  });
  const denied = await startShield(t, {
    targetOrigin: upstream.origin,
    decide: async () => ({ action: "deny", reason: "policy" }),
  });

  const unauthenticated = await fetch(`${denied.origin}/v1/messages`, { method: "POST", body: "{}" });
  assert.equal(unauthenticated.status, 401);
  assert.deepEqual(await unauthenticated.json(), { error: { code: "shield_unauthorized" } });
  assert.equal(upstreamCalls, 0);

  const blocked = await fetch(`${denied.origin}/v1/messages`, {
    method: "POST",
    headers: { "x-airkit-shield": CAPABILITY },
    body: "{}",
  });
  assert.equal(blocked.status, 403);
  assert.deepEqual(await blocked.json(), { error: { code: "shield_blocked" } });
  assert.equal(upstreamCalls, 0);
});

test("proxy has a loopback listener and refuses malformed fixed targets", async (t) => {
  const upstream = await startFixture(t, async (_request, response) => response.end());
  const shield = await startShield(t, { targetOrigin: upstream.origin, decide: async () => ({ action: "deny" }) });
  assert.equal(new URL(shield.origin).hostname, "127.0.0.1");
  await assert.rejects(
    startShieldProxy({ capability: CAPABILITY, targetOrigin: "https://user:password@example.test", decide: async () => ({ action: "deny" }) }),
    /target origin/i,
  );
});

test("scheme-relative and backslash paths cannot change the fixed upstream target", async (t) => {
  let upstreamCalls = 0;
  const upstream = await startFixture(t, async (_request, response) => {
    upstreamCalls += 1;
    response.end();
  });
  const shield = await startShield(t, { targetOrigin: upstream.origin, decide: async () => ({ action: "allow" }) });

  for (const path of ["//other.example/v1/messages", "/\\other.example/v1/messages"]) {
    const result = await rawRequest(shield.origin, path, { "x-airkit-shield": CAPABILITY }, "{}");
    assert.equal(result.status, 403);
    assert.deepEqual(JSON.parse(result.body), { error: { code: "shield_blocked" } });
  }
  assert.equal(upstreamCalls, 0);
});

test("oversized inspection is blocked before contacting upstream", async (t) => {
  let upstreamCalls = 0;
  const upstream = await startFixture(t, async (_request, response) => {
    upstreamCalls += 1;
    response.end();
  });
  const shield = await startShield(t, { targetOrigin: upstream.origin, decide: async () => ({ action: "allow" }) });
  const result = await fetch(`${shield.origin}/v1/messages`, {
    method: "POST",
    headers: { "x-airkit-shield": CAPABILITY },
    body: "x".repeat(1_048_577),
  });

  assert.equal(result.status, 403);
  assert.deepEqual(await result.json(), { error: { code: "shield_blocked" } });
  assert.equal(upstreamCalls, 0);
});

test("proxy preserves streaming upstream responses", async (t) => {
  const upstream = await startFixture(t, async (_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write("data: first\n\n");
    setTimeout(() => response.end("data: second\n\n"), 5);
  });
  const shield = await startShield(t, { targetOrigin: upstream.origin, decide: async () => ({ action: "allow" }) });

  const result = await fetch(`${shield.origin}/v1/messages`, {
    method: "POST",
    headers: { "x-airkit-shield": CAPABILITY },
    body: "{}",
  });
  assert.equal(result.status, 200);
  assert.equal(result.headers.get("content-type"), "text/event-stream");
  assert.equal(await result.text(), "data: first\n\ndata: second\n\n");
});

test("decision exceptions are unavailable and diagnostics never contain credentials or body", async (t) => {
  let upstreamCalls = 0;
  const events = [];
  const upstream = await startFixture(t, async (_request, response) => {
    upstreamCalls += 1;
    response.end();
  });
  const shield = await startShield(t, {
    targetOrigin: upstream.origin,
    decide: async () => { throw new Error("oauth-secret body-secret cookie-secret"); },
    onDecision: (event) => events.push(event),
  });
  const result = await fetch(`${shield.origin}/v1/messages`, {
    method: "POST",
    headers: {
      authorization: "Bearer oauth-secret",
      cookie: "session=cookie-secret",
      "x-airkit-shield": CAPABILITY,
    },
    body: "body-secret",
  });

  assert.equal(result.status, 503);
  assert.deepEqual(await result.json(), { error: { code: "shield_unavailable" } });
  assert.equal(upstreamCalls, 0);
  assert.deepEqual(events, [{ action: "unavailable", reason: "decision_failed", bytes: 11, elapsedMs: events[0].elapsedMs }]);
  assert.doesNotMatch(JSON.stringify(events), /oauth-secret|cookie-secret|body-secret/);
});

async function startShield(t, options) {
  const shield = await startShieldProxy({ capability: CAPABILITY, ...options });
  t.after(() => shield.close());
  return shield;
}

async function startFixture(t, handler) {
  const server = createServer((request, response) => void handler(request, response));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  return { origin: `http://127.0.0.1:${address.port}` };
}

function rawRequest(origin, path, headers, body) {
  const target = new URL(origin);
  return new Promise((resolve, reject) => {
    const client = httpRequest({
      host: target.hostname,
      port: target.port,
      method: "POST",
      path,
      headers: { ...headers, "content-length": String(Buffer.byteLength(body)) },
    }, async (response) => {
      const chunks = [];
      for await (const chunk of response) chunks.push(chunk);
      resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString("utf8") });
    }).once("error", reject);
    client.end(body);
  });
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}
