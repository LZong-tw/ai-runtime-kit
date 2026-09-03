import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";

import { startShieldProxy } from "../src/shield/proxy.mjs";
import { createApprovalBroker } from "../src/shield/approval.mjs";
import { approvalChannelRegistration, createApprovalChannel } from "../src/shield/approval-channel.mjs";
import { createDecisionCache } from "../src/shield/decision-cache.mjs";

const CAPABILITY = "c".repeat(32);
const CONTROL_CAPABILITY = "d".repeat(32);

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
  assert.equal(events.length, 1);
  assert.equal(events[0].action, "allow");
  assert.deepEqual(events[0].reasonCodes, ["policy_allow"]);
  assert.equal(Number.isInteger(events[0].elapsedMs), true);
  assert.doesNotMatch(JSON.stringify(events), /oauth-secret|cookie-secret|body-secret|target-switch-secret/);
});

test("proxy reuses an exact terminal decision but re-audits and forwards each retry", async (t) => {
  let decisions = 0;
  let upstreamCalls = 0;
  const events = [];
  const upstream = await startFixture(t, async (_request, response) => {
    upstreamCalls += 1;
    response.end("{}");
  });
  const shield = await startShield(t, {
    targetOrigin: upstream.origin,
    decisionCache: createDecisionCache(),
    decisionContext: { lane: "subscription", destinationClass: "subscription", policyVersion: "policy-1", detectorVersions: { gitleaks: "1", privacy: "1" } },
    decide: async () => {
      decisions += 1;
      return { action: "allow", reasonCodes: ["policy_allow"], lane: "subscription", destinationClass: "subscription", bundleVersion: "policy-1", detectorVersions: { gitleaks: "1", privacy: "1" } };
    },
    onDecision: (event) => events.push(event),
  });
  const send = (body) => fetch(`${shield.origin}/v1/messages`, {
    method: "POST", headers: { "x-airkit-shield": CAPABILITY, "content-type": "application/json" }, body,
  });

  assert.equal((await send('{"same":true}')).status, 200);
  assert.equal((await send('{"same":true}')).status, 200);
  assert.equal((await send('{"same":false}')).status, 200);
  assert.equal(decisions, 2);
  assert.equal(upstreamCalls, 3);
  assert.equal(events.length, 3);
  assert.deepEqual(events.map((event) => event.decisionSource), ["evaluated", "cache_hit", "evaluated"]);
});

test("proxy preserves atomic cache provenance in its re-audit metadata", async (t) => {
  const events = [];
  const upstream = await startFixture(t, async (_request, response) => response.end("{}"));
  const shield = await startShield(t, {
    targetOrigin: upstream.origin,
    decisionCache: {
      async getOrCompute() {
        return {
          source: "coalesced",
          decision: { action: "allow", reasonCodes: ["policy_allow"], transformCount: 0, body: Buffer.alloc(0) },
        };
      },
    },
    decisionContext: { lane: "subscription", destinationClass: "subscription", policyVersion: "policy-1", detectorVersions: { gitleaks: "1", privacy: "1" } },
    decide: async () => assert.fail("atomic cache result must avoid reevaluation"),
    onDecision: (event) => events.push(event),
  });
  const result = await rawRequest(shield.origin, "/v1/messages", {
    "x-airkit-shield": CAPABILITY, "content-type": "application/json",
  }, '{"same":true}');
  assert.equal(result.status, 200);
  assert.deepEqual(events.map((event) => event.decisionSource), ["coalesced"]);
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

test("readiness probe authenticates the live loopback listener without policy or upstream access", async (t) => {
  let decisions = 0;
  let upstreamCalls = 0;
  const upstream = await startFixture(t, async (_request, response) => {
    upstreamCalls += 1;
    response.end();
  });
  const shield = await startShield(t, {
    targetOrigin: upstream.origin,
    decide: async () => {
      decisions += 1;
      return { action: "deny" };
    },
  });

  const ready = await fetch(`${shield.origin}/_airkit/shield/ready`, {
    headers: { "x-airkit-shield": CAPABILITY },
  });
  const unauthorized = await fetch(`${shield.origin}/_airkit/shield/ready`, {
    headers: { "x-airkit-shield": "x".repeat(32) },
  });

  assert.equal(ready.status, 204);
  assert.equal(unauthorized.status, 401);
  assert.equal(decisions, 0);
  assert.equal(upstreamCalls, 0);
});

test("readiness probe fails closed when durable audit storage is unavailable", async (t) => {
  const upstream = await startFixture(t, async (_request, response) => response.end());
  const shield = await startShield(t, {
    targetOrigin: upstream.origin,
    decide: async () => ({ action: "deny" }),
    isReady: async () => false,
  });

  const ready = await fetch(`${shield.origin}/_airkit/shield/ready`, {
    headers: { "x-airkit-shield": CAPABILITY },
  });

  assert.equal(ready.status, 503);
  assert.deepEqual(await ready.json(), { error: { code: "shield_unavailable" } });
});

test("proxy has a loopback listener and refuses malformed fixed targets", async (t) => {
  const upstream = await startFixture(t, async (_request, response) => response.end());
  const shield = await startShield(t, { targetOrigin: upstream.origin, decide: async () => ({ action: "deny" }) });
  assert.equal(new URL(shield.origin).hostname, "127.0.0.1");
  await assert.rejects(
    startShieldProxy({ capability: CAPABILITY, controlCapability: CONTROL_CAPABILITY, targetOrigin: "https://user:password@example.test", decide: async () => ({ action: "deny" }) }),
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

test("proxy blocks upstream redirects before a default-following client can leave the fixed origin", async (t) => {
  let secondaryCalls = 0;
  const secondary = await startFixture(t, async (_request, response) => {
    secondaryCalls += 1;
    response.end("must not be contacted");
  });
  const upstream = await startFixture(t, async (_request, response) => {
    response.writeHead(302, { location: `${secondary.origin}/v1/messages` });
    response.end();
  });
  const shield = await startShield(t, { targetOrigin: upstream.origin, decide: async () => ({ action: "allow" }) });

  const result = await fetch(`${shield.origin}/v1/messages`, {
    method: "POST",
    headers: { "x-airkit-shield": CAPABILITY },
    body: "{}",
  });

  assert.equal(result.status, 503);
  assert.equal(result.headers.get("location"), null);
  assert.deepEqual(await result.json(), { error: { code: "shield_unavailable" } });
  assert.equal(secondaryCalls, 0);
});

test("proxy removes stale compression headers after fetch decompression", async (t) => {
  const body = '{"type":"message","content":[]}';
  const compressed = gzipSync(body);
  const upstream = await startFixture(t, async (_request, response) => {
    response.writeHead(200, {
      "content-encoding": "gzip",
      "content-length": String(compressed.byteLength),
      "content-type": "application/json",
    });
    response.end(compressed);
  });
  const shield = await startShield(t, { targetOrigin: upstream.origin, decide: async () => ({ action: "allow" }) });

  const result = await fetch(`${shield.origin}/v1/messages`, {
    method: "POST",
    headers: { "x-airkit-shield": CAPABILITY },
    body: "{}",
  });

  assert.equal(result.headers.get("content-encoding"), null);
  assert.equal(result.headers.get("content-length"), null);
  assert.equal(await result.text(), body);
});

test("proxy aborts an upstream request when the downstream client disconnects", async (t) => {
  let notifyStarted;
  let notifyClosed;
  let upstreamResponse;
  const upstreamStarted = new Promise((resolve) => { notifyStarted = resolve; });
  const upstreamClosed = new Promise((resolve) => { notifyClosed = resolve; });
  const upstream = await startFixture(t, async (request, response) => {
    await readBody(request);
    upstreamResponse = response;
    response.once("close", notifyClosed);
    notifyStarted();
    await once(response, "close");
  });
  const shield = await startShield(t, { targetOrigin: upstream.origin, decide: async () => ({ action: "allow" }) });
  const target = new URL(shield.origin);
  const client = httpRequest({
    host: target.hostname,
    port: target.port,
    method: "POST",
    path: "/v1/messages",
    headers: { "content-length": "2", "x-airkit-shield": CAPABILITY },
  });
  const clientClosed = new Promise((resolve) => client.once("close", resolve));
  client.once("error", () => {});
  client.end("{}");

  await upstreamStarted;
  client.destroy();
  await clientClosed;
  const upstreamAborted = await Promise.race([
    upstreamClosed.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 250)),
  ]);
  if (!upstreamAborted) upstreamResponse.destroy();
  assert.equal(upstreamAborted, true, "upstream request was not aborted after downstream disconnect");
});

test("proxy does not forward after a downstream disconnect during decision", async (t) => {
  let releaseDecision;
  let notifyDecisionStarted;
  let observedSignal;
  let upstreamCalls = 0;
  const decisionStarted = new Promise((resolve) => { notifyDecisionStarted = resolve; });
  const upstream = await startFixture(t, async (_request, response) => {
    upstreamCalls += 1;
    response.end();
  });
  const shield = await startShield(t, {
    targetOrigin: upstream.origin,
    decide: ({ signal }) => {
      observedSignal = signal;
      notifyDecisionStarted();
      return new Promise((resolve) => { releaseDecision = () => resolve({ action: "allow" }); });
    },
  });
  const target = new URL(shield.origin);
  const client = httpRequest({
    host: target.hostname,
    port: target.port,
    method: "POST",
    path: "/v1/messages",
    headers: { "content-length": "2", "x-airkit-shield": CAPABILITY },
  });
  const clientClosed = new Promise((resolve) => client.once("close", resolve));
  client.once("error", () => {});
  client.end("{}");

  await decisionStarted;
  client.destroy();
  await clientClosed;
  await new Promise((resolve) => setTimeout(resolve, 25));
  const decisionAborted = observedSignal?.aborted === true;
  releaseDecision();
  await new Promise((resolve) => setTimeout(resolve, 25));

  assert.equal(decisionAborted, true, "decision did not receive the downstream lifecycle abort");
  assert.equal(upstreamCalls, 0);
});

test("proxy does not forward when the downstream disconnects as inspection completes", async (t) => {
  let upstreamCalls = 0;
  const upstream = await startFixture(t, async (_request, response) => {
    upstreamCalls += 1;
    response.end();
  });
  const shield = await startShield(t, { targetOrigin: upstream.origin, decide: async () => ({ action: "allow" }) });
  const target = new URL(shield.origin);
  const client = httpRequest({
    host: target.hostname,
    port: target.port,
    method: "POST",
    path: "/v1/messages",
    headers: { "content-length": "2", "x-airkit-shield": CAPABILITY },
  });
  const clientClosed = new Promise((resolve) => client.once("close", resolve));
  client.once("error", () => {});
  client.end("{}");
  setImmediate(() => client.destroy());

  await clientClosed;
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(upstreamCalls, 0);
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
  assert.deepEqual(events, []);
  assert.doesNotMatch(JSON.stringify(events), /oauth-secret|cookie-secret|body-secret/);
});

test("proxy durably records the policy action and reason before its first upstream fetch", async (t) => {
  const terminal = [];
  let upstreamCalls = 0;
  const upstream = await startFixture(t, async (_request, response) => {
    upstreamCalls += 1;
    assert.equal(terminal.length, 1, "audit gate must precede upstream fetch");
    response.end("ok");
  });
  const shield = await startShield(t, {
    targetOrigin: upstream.origin,
    decide: async () => ({
      action: "allow",
      reasonCodes: ["policy_allow"],
      lane: "subscription",
      destinationClass: "subscription",
      bundleVersion: "2026.09.02",
      detectorVersions: { gitleaks: "8.24.3" },
    }),
    recordShieldDecision: async (decision) => terminal.push(decision),
  });

  const result = await fetch(`${shield.origin}/v1/messages`, {
    method: "POST",
    headers: { "x-airkit-shield": CAPABILITY },
    body: "body-secret",
  });
  assert.equal(result.status, 200);
  assert.equal(upstreamCalls, 1);
  assert.equal(terminal.length, 1);
  assert.equal(terminal[0].action, "allow");
  assert.deepEqual(terminal[0].reasonCodes, ["policy_allow"]);
  assert.doesNotMatch(JSON.stringify(terminal), /body-secret|digest|\/v1\/messages/);
});

test("proxy forwards only a newly validated policy redaction buffer and never persists either body", async (t) => {
  const original = '{"content":"privacy-raw-sentinel-must-not-escape"}';
  const redacted = Buffer.from('{"content":"[EMAIL]"}');
  let upstreamBody = null;
  let terminal = null;
  const upstream = await startFixture(t, async (request, response) => {
    upstreamBody = await readBody(request);
    response.end("ok");
  });
  const shield = await startShield(t, {
    targetOrigin: upstream.origin,
    decide: async () => ({
      action: "redact",
      redactedBody: redacted,
      transformCount: 1,
      reasonCodes: ["pii_email_redacted"],
      lane: "subscription",
      destinationClass: "subscription",
      bundleVersion: "2026.09.02.4",
      detectorVersions: { privacy: "privacy-1", gitleaks: "8.24.0" },
    }),
    recordShieldDecision: async (decision) => { terminal = decision; },
  });

  const response = await fetch(`${shield.origin}/v1/messages`, {
    method: "POST",
    headers: { "x-airkit-shield": CAPABILITY, "content-type": "application/json" },
    body: original,
  });
  assert.equal(response.status, 200);
  assert.equal(upstreamBody, redacted.toString("utf8"));
  assert.equal(redacted.toString("utf8"), '{"content":"[EMAIL]"}');
  assert.equal(terminal.action, "redact");
  assert.equal(terminal.transformCount, 1);
  assert.doesNotMatch(JSON.stringify(terminal), /privacy-raw|\[EMAIL\]/);
});

test("proxy blocks malformed redaction instead of forwarding the original request", async (t) => {
  let upstreamCalls = 0;
  const upstream = await startFixture(t, async (_request, response) => { upstreamCalls += 1; response.end("wrong"); });
  const shield = await startShield(t, {
    targetOrigin: upstream.origin,
    decide: async () => ({ action: "redact", redactedBody: Buffer.from("not json"), transformCount: 1 }),
  });
  const response = await fetch(`${shield.origin}/v1/messages`, {
    method: "POST", headers: { "x-airkit-shield": CAPABILITY }, body: '{"content":"privacy-raw-sentinel-must-not-escape"}',
  });
  assert.equal(response.status, 503);
  assert.equal(upstreamCalls, 0);
});

test("approval and audit unavailability block before upstream fetch with generic responses", async (t) => {
  let upstreamCalls = 0;
  const upstream = await startFixture(t, async (_request, response) => {
    upstreamCalls += 1;
    response.end();
  });
  const requireApproval = () => ({
    action: "require_approval",
    reasonCodes: ["internal_repository_code"],
    lane: "subscription",
    destinationClass: "subscription",
    bundleVersion: "2026.09.02",
    detectorVersions: { gitleaks: "8.24.3" },
  });
  const headless = await startShield(t, {
    targetOrigin: upstream.origin,
    decide: async () => requireApproval(),
    recordShieldDecision: async () => {},
  });
  const denied = await fetch(`${headless.origin}/v1/messages`, {
    method: "POST", headers: { "x-airkit-shield": CAPABILITY }, body: "body-secret",
  });
  assert.equal(denied.status, 403);
  assert.deepEqual(await denied.json(), { error: { code: "shield_blocked" } });

  const auditDown = await startShield(t, {
    targetOrigin: upstream.origin,
    decide: async () => ({ ...requireApproval(), action: "allow", reasonCodes: ["policy_allow"] }),
    recordShieldDecision: async () => { throw new Error("audit secret/path/body"); },
  });
  const unavailable = await fetch(`${auditDown.origin}/v1/messages`, {
    method: "POST", headers: { "x-airkit-shield": CAPABILITY }, body: "body-secret",
  });
  assert.equal(unavailable.status, 503);
  assert.deepEqual(await unavailable.json(), { error: { code: "shield_unavailable" } });
  assert.equal(upstreamCalls, 0);
});

test("proxy scopes approval with evaluated lane, destination, and policy versions", async (t) => {
  let upstreamCalls = 0;
  let approvalScope;
  let terminal;
  const upstream = await startFixture(t, async (_request, response) => {
    upstreamCalls += 1;
    response.end("ok");
  });
  const grant = {};
  const shield = await startShield(t, {
    targetOrigin: upstream.origin,
    approvalBroker: {
      async request(scope) { approvalScope = scope; return grant; },
      consume(receivedGrant, scope) { return receivedGrant === grant && scope === approvalScope; },
    },
    decide: async () => ({
      action: "require_approval",
      reasonCodes: ["internal_repository_code"],
      lane: "subscription",
      destinationClass: "subscription",
      bundleVersion: "2026.09.02.2",
      detectorVersions: { gitleaks: "8.24.0" },
    }),
    recordShieldDecision: async (decision) => { terminal = decision; },
  });

  const result = await fetch(`${shield.origin}/v1/messages`, {
    method: "POST", headers: { "x-airkit-shield": CAPABILITY }, body: "body-secret",
  });
  assert.equal(result.status, 200);
  assert.equal(upstreamCalls, 1);
  assert.deepEqual({
    bundleVersion: approvalScope.bundleVersion,
    destinationClass: approvalScope.destinationClass,
    reasonCodes: approvalScope.reasonCodes,
  }, {
    bundleVersion: "2026.09.02.2",
    destinationClass: "subscription",
    reasonCodes: ["internal_repository_code"],
  });
  assert.match(approvalScope.digest, /^[a-f0-9]{64}$/);
  assert.equal(terminal.lane, "subscription");
  assert.equal(terminal.destinationClass, "subscription");
  assert.equal(terminal.bundleVersion, "2026.09.02.2");
  assert.deepEqual(terminal.detectorVersions, { gitleaks: "8.24.0" });
  assert.doesNotMatch(JSON.stringify(terminal), /body-secret|digest/);
});

test("proxy obtains one approval through the launcher-registered private channel and ignores channel headers upstream", async (t) => {
  let upstreamHeaders = null;
  const upstream = await startFixture(t, async (request, response) => {
    upstreamHeaders = request.headers;
    request.resume();
    response.end('{"ok":true}');
  });
  const directory = await mkdtemp(join(tmpdir(), "airkit-shield-approval-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const channel = await createApprovalChannel({
    directory,
    capability: "a".repeat(32),
    broker: createApprovalBroker({ tty: { interactive: true, write() {}, prompt: async () => "y" } }),
  });
  t.after(() => channel.close());
  const shield = await startShield(t, {
    targetOrigin: upstream.origin,
    decide: async () => ({ action: "require_approval", reasonCodes: ["internal-subscription"], lane: "subscription", destinationClass: "subscription", bundleVersion: "policy-1", detectorVersions: { gitleaks: "8", privacy: "1" } }),
  });
  await registerApprovalChannel(shield, channel);
  const headers = { "x-airkit-shield": CAPABILITY };
  assert.equal((await fetch(`${shield.origin}/v1/messages`, { method: "POST", headers, body: '{"content":"ordinary"}' })).status, 200);
  assert.equal((await fetch(`${shield.origin}/v1/messages`, { method: "POST", headers, body: '{"content":"ordinary"}' })).status, 403);
  assert.equal(upstreamHeaders["x-airkit-shield-approval"], undefined);
  assert.equal(upstreamHeaders["x-airkit-shield-approval-socket"], undefined);
});

test("proxy blocks a client-spoofed approval socket even when it reports approval", async (t) => {
  let upstreamCalls = 0;
  const upstream = await startFixture(t, (_request, response) => { upstreamCalls += 1; response.end(); });
  const directory = await mkdtemp(join(tmpdir(), "airkit-shield-approval-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const channel = await createApprovalChannel({
    directory,
    capability: "a".repeat(32),
    broker: createApprovalBroker({ tty: { interactive: true, write() {}, prompt: async () => "n" } }),
  });
  t.after(() => channel.close());
  const attacker = createNetServer((socket) => socket.end('{"approved":true}'));
  const attackerSocket = join(directory, "attacker.sock");
  await new Promise((resolve) => attacker.listen(attackerSocket, resolve));
  t.after(() => new Promise((resolve) => attacker.close(resolve)));
  const shield = await startShield(t, {
    targetOrigin: upstream.origin,
    decide: async () => ({ action: "require_approval", reasonCodes: ["internal-subscription"], lane: "subscription", destinationClass: "subscription", bundleVersion: "policy-1", detectorVersions: { gitleaks: "8", privacy: "1" } }),
  });
  const normalTransportRegistration = await fetch(`${shield.origin}/_airkit/shield/approval-channel`, {
    method: "POST",
    headers: { "x-airkit-shield": CAPABILITY, "content-type": "application/json" },
    body: JSON.stringify({ socketPath: attackerSocket, capability: "b".repeat(32) }),
  });
  assert.equal(normalTransportRegistration.status, 401);
  const beforeRegistration = await fetch(`${shield.origin}/v1/messages`, {
    method: "POST", headers: { "x-airkit-shield": CAPABILITY }, body: '{"content":"ordinary"}',
  });
  assert.equal(beforeRegistration.status, 403);
  await registerApprovalChannel(shield, channel);
  const response = await fetch(`${shield.origin}/v1/messages`, {
    method: "POST",
    headers: {
      "x-airkit-shield": CAPABILITY,
      "x-airkit-shield-approval-socket": attackerSocket,
      "x-airkit-shield-approval": "b".repeat(32),
    },
    body: '{"content":"ordinary"}',
  });
  assert.equal(response.status, 403);
  assert.equal(upstreamCalls, 0);
});

test("approval channel registration is control-only and can be replaced after lifecycle unregister", async (t) => {
  const firstDirectory = await mkdtemp("/tmp/as1-");
  const secondDirectory = await mkdtemp("/tmp/as2-");
  t.after(() => rm(firstDirectory, { recursive: true, force: true }));
  t.after(() => rm(secondDirectory, { recursive: true, force: true }));
  const broker = createApprovalBroker({ tty: { interactive: true, write() {}, prompt: async () => "n" } });
  const first = await createApprovalChannel({ directory: firstDirectory, capability: "a".repeat(32), broker });
  const second = await createApprovalChannel({ directory: secondDirectory, capability: "b".repeat(32), broker });
  t.after(() => first.close());
  t.after(() => second.close());
  const shield = await startShield(t, {
    targetOrigin: "https://api.anthropic.com",
    decide: async () => ({ action: "require_approval", reasonCodes: ["internal-subscription"], lane: "subscription", destinationClass: "subscription", bundleVersion: "policy-1", detectorVersions: { gitleaks: "8", privacy: "1" } }),
  });
  await registerApprovalChannel(shield, first);
  const secondWhileBound = await fetch(`${shield.origin}/_airkit/shield/approval-channel`, {
    method: "POST", headers: { "x-airkit-shield-control": CONTROL_CAPABILITY, "content-type": "application/json" }, body: JSON.stringify(approvalChannelRegistration(second)),
  });
  assert.equal(secondWhileBound.status, 403);
  const normalDelete = await fetch(`${shield.origin}/_airkit/shield/approval-channel`, { method: "DELETE", headers: { "x-airkit-shield": CAPABILITY } });
  assert.equal(normalDelete.status, 401);
  const unregister = await fetch(`${shield.origin}/_airkit/shield/approval-channel`, { method: "DELETE", headers: { "x-airkit-shield-control": CONTROL_CAPABILITY } });
  assert.equal(unregister.status, 204);
  const secondRegistration = await fetch(`${shield.origin}/_airkit/shield/approval-channel`, {
    method: "POST", headers: { "x-airkit-shield-control": CONTROL_CAPABILITY, "content-type": "application/json" }, body: JSON.stringify(approvalChannelRegistration(second)),
  });
  assert.equal(secondRegistration.status, 204);
});

async function registerApprovalChannel(shield, channel) {
  const response = await fetch(`${shield.origin}/_airkit/shield/approval-channel`, {
    method: "POST",
    headers: { "x-airkit-shield-control": CONTROL_CAPABILITY, "content-type": "application/json" },
    body: JSON.stringify(approvalChannelRegistration(channel)),
  });
  assert.equal(response.status, 204);
}

test("managed destination leases are control-authenticated, session-scoped, and revocable", async (t) => {
  let calls = 0;
  const upstream = await startFixture(t, async (_request, response) => { calls += 1; response.end("ok"); });
  const lease = "d".repeat(32);
  const shield = await startShield(t, {
    targetOrigin: undefined,
    allowDestinationLeases: true,
    decide: async () => ({ action: "allow", reasonCodes: ["policy_allow"], lane: "managed", destinationClass: "managed", bundleVersion: "policy-1", detectorVersions: { gitleaks: "8", privacy: "1" } }),
  });
  const unregistered = await fetch(`${shield.origin}/v1/messages`, { method: "POST", headers: { "x-airkit-shield": lease }, body: "{}" });
  assert.equal(unregistered.status, 401);
  const registered = await fetch(`${shield.origin}/_airkit/shield/destination-lease`, {
    method: "POST", headers: { "x-airkit-shield-control": CONTROL_CAPABILITY, "content-type": "application/json" }, body: JSON.stringify({ capability: lease, targetOrigin: upstream.origin, expiresAt: Date.now() + 30_000 }),
  });
  assert.equal(registered.status, 204);
  const forwarded = await fetch(`${shield.origin}/v1/messages`, { method: "POST", headers: { "x-airkit-shield": lease }, body: "{}" });
  assert.equal(forwarded.status, 200);
  assert.equal(calls, 1);
  const replay = await fetch(`${shield.origin}/_airkit/shield/destination-lease`, {
    method: "POST", headers: { "x-airkit-shield-control": CONTROL_CAPABILITY, "content-type": "application/json" }, body: JSON.stringify({ capability: lease, targetOrigin: upstream.origin, expiresAt: Date.now() + 30_000 }),
  });
  assert.equal(replay.status, 403);
  const renewed = await fetch(`${shield.origin}/_airkit/shield/destination-lease`, {
    method: "POST", headers: { "x-airkit-shield-control": CONTROL_CAPABILITY, "content-type": "application/json" }, body: JSON.stringify({ capability: lease, targetOrigin: upstream.origin, expiresAt: Date.now() + 30_000, renew: true }),
  });
  assert.equal(renewed.status, 204);
  const revoked = await fetch(`${shield.origin}/_airkit/shield/destination-lease`, { method: "DELETE", headers: { "x-airkit-shield-control": CONTROL_CAPABILITY, "content-type": "application/json" }, body: JSON.stringify({ capability: lease }) });
  assert.equal(revoked.status, 204);
  const afterRevoke = await fetch(`${shield.origin}/v1/messages`, { method: "POST", headers: { "x-airkit-shield": lease }, body: "{}" });
  assert.equal(afterRevoke.status, 401);
  assert.equal(calls, 1);
});

test("expired destination leases are removed before they can forward without renewal", async (t) => {
  let now = 1_000_000;
  let calls = 0;
  const upstream = await startFixture(t, async (_request, response) => { calls += 1; response.end("ok"); });
  const lease = "e".repeat(32);
  const shield = await startShield(t, {
    targetOrigin: undefined,
    allowDestinationLeases: true,
    now: () => now,
    decide: async () => ({ action: "allow", reasonCodes: ["policy_allow"], lane: "managed", destinationClass: "managed", bundleVersion: "policy-1", detectorVersions: { gitleaks: "8", privacy: "1" } }),
  });
  const registered = await fetch(`${shield.origin}/_airkit/shield/destination-lease`, {
    method: "POST", headers: { "x-airkit-shield-control": CONTROL_CAPABILITY, "content-type": "application/json" }, body: JSON.stringify({ capability: lease, targetOrigin: upstream.origin, expiresAt: now + 1_000 }),
  });
  assert.equal(registered.status, 204);
  now += 1_001;
  const expired = await fetch(`${shield.origin}/v1/messages`, { method: "POST", headers: { "x-airkit-shield": lease }, body: "{}" });
  assert.equal(expired.status, 401);
  assert.equal(calls, 0);
  const renewalAfterExpiry = await fetch(`${shield.origin}/_airkit/shield/destination-lease`, {
    method: "POST", headers: { "x-airkit-shield-control": CONTROL_CAPABILITY, "content-type": "application/json" }, body: JSON.stringify({ capability: lease, targetOrigin: upstream.origin, expiresAt: now + 1_000, renew: true }),
  });
  assert.equal(renewalAfterExpiry.status, 403, "renewal cannot recreate an expired session lease");
  const reusedAfterExpiry = await fetch(`${shield.origin}/_airkit/shield/destination-lease`, {
    method: "POST", headers: { "x-airkit-shield-control": CONTROL_CAPABILITY, "content-type": "application/json" }, body: JSON.stringify({ capability: lease, targetOrigin: upstream.origin, expiresAt: now + 1_000 }),
  });
  assert.equal(reusedAfterExpiry.status, 204, "expiry cleanup permits a fresh session registration");
});

test("lease renewal cannot revive a capability after control revocation", async (t) => {
  const upstream = await startFixture(t, async (_request, response) => response.end("ok"));
  const lease = "f".repeat(32);
  const shield = await startShield(t, {
    targetOrigin: undefined,
    allowDestinationLeases: true,
    decide: async () => ({ action: "allow", reasonCodes: ["policy_allow"], lane: "managed", destinationClass: "managed", bundleVersion: "policy-1", detectorVersions: { gitleaks: "8", privacy: "1" } }),
  });
  const headers = { "x-airkit-shield-control": CONTROL_CAPABILITY, "content-type": "application/json" };
  const create = await fetch(`${shield.origin}/_airkit/shield/destination-lease`, { method: "POST", headers, body: JSON.stringify({ capability: lease, targetOrigin: upstream.origin, expiresAt: Date.now() + 30_000 }) });
  assert.equal(create.status, 204);
  const revoke = await fetch(`${shield.origin}/_airkit/shield/destination-lease`, { method: "DELETE", headers, body: JSON.stringify({ capability: lease }) });
  assert.equal(revoke.status, 204);
  const renew = await fetch(`${shield.origin}/_airkit/shield/destination-lease`, { method: "POST", headers, body: JSON.stringify({ capability: lease, targetOrigin: upstream.origin, expiresAt: Date.now() + 30_000, renew: true }) });
  assert.equal(renew.status, 403);
});

async function startShield(t, options) {
  const shield = await startShieldProxy({
    capability: CAPABILITY,
    controlCapability: CONTROL_CAPABILITY,
    ...(options.recordShieldDecision || options.onDecision ? options : { ...options, recordShieldDecision: async () => {} }),
  });
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
