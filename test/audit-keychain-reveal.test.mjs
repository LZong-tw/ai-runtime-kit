import assert from "node:assert/strict";
import { test } from "node:test";
import { createMasterKeyProvider } from "../src/audit/keychain.mjs";
import { createRevealAuthorizer, revealAuthorizationMessage } from "../src/audit/reveal.mjs";

test("master key provider uses the fixed Keychain identity and never puts secret in argv", async () => {
  const calls = [];
  const secret = Buffer.alloc(32, 0x5a);
  const provider = createMasterKeyProvider({
    env: {},
    runSecurity: async (request) => {
      calls.push(request);
      if (request.args.includes("find-generic-password")) return { status: 0, stdout: secret };
      return { status: 0, stdout: "" };
    },
    randomBytes: () => secret,
  });
  assert.equal(await provider.inspect(), true);
  assert.deepEqual(await provider.create(), secret);
  assert.deepEqual(await provider.get(), secret);
  assert.ok(calls.every(({ args }) => !args.includes(secret.toString())));
  assert.ok(calls.some(({ args }) => args.includes("ai-runtime-kit.audit") && (args.includes("payload-master-v1") || args.includes("payload-master-v2"))));
});

test("reveal authorization binds request/session, expires after 30 seconds, and is single use", async () => {
  let now = 1_000;
  const calls = [];
  const authorizer = createRevealAuthorizer({
    clock: () => now,
    randomBytes: () => Buffer.alloc(32, 7),
    runHelper: async (request) => {
      calls.push(request);
      return { status: 0, stdout: Buffer.from("signature") };
    },
  });
  const challenge = await authorizer.challenge({ requestId: "req-1", sessionId: "session-1" });
  assert.equal(challenge.expiresAt, 31_000);
  assert.equal(calls[0].args.includes("signature"), false);
  const message = revealAuthorizationMessage(challenge);
  const publicKey = { verify: (data, signature) => data.equals(Buffer.from(message)) && signature.equals(Buffer.from("signature")) };
  assert.equal(await authorizer.verifyAndConsume({ challenge, requestId: "req-1", sessionId: "session-1", signature: Buffer.from("signature"), publicKey }), true);
  await assert.rejects(() => authorizer.verifyAndConsume({ challenge, requestId: "req-1", sessionId: "session-1", signature: Buffer.from("signature"), publicKey }), { code: "AIRKIT_AUDIT_REVEAL_UNAVAILABLE" });
  const second = await authorizer.challenge({ requestId: "req-1", sessionId: "session-1" });
  now += 30_001;
  await assert.rejects(() => authorizer.verifyAndConsume({ challenge: second, requestId: "req-1", sessionId: "session-1", signature: Buffer.from("signature"), publicKey }), { code: "AIRKIT_AUDIT_REVEAL_UNAVAILABLE" });
  const third = await authorizer.challenge({ requestId: "req-1", sessionId: "session-1" });
  now = 1_000;
  await assert.rejects(() => authorizer.verifyAndConsume({ challenge: third, requestId: "wrong", sessionId: "session-1", signature: Buffer.from("signature"), publicKey }), { code: "AIRKIT_AUDIT_REVEAL_UNAVAILABLE" });
  await assert.rejects(() => authorizer.verifyAndConsume({ challenge: third, requestId: "req-1", sessionId: "wrong", signature: Buffer.from("signature"), publicKey }), { code: "AIRKIT_AUDIT_REVEAL_UNAVAILABLE" });
});

test("helper failures, malformed signatures, and invalid challenge data fail closed", async () => {
  const unavailable = createRevealAuthorizer({ runHelper: async () => { throw new Error("helper down"); } });
  await assert.rejects(() => unavailable.challenge({ requestId: "r", sessionId: "s" }), { code: "AIRKIT_AUDIT_REVEAL_UNAVAILABLE" });
  const authorizer = createRevealAuthorizer({ runHelper: async () => ({ status: 0, stdout: Buffer.from("sig") }) });
  const challenge = await authorizer.challenge({ requestId: "r", sessionId: "s" });
  let verifyCalled = false;
  await assert.rejects(() => authorizer.verifyAndConsume({ challenge, requestId: "r", sessionId: "s", signature: "***", publicKey: { verify: () => { verifyCalled = true; return false; } } }), { code: "AIRKIT_AUDIT_REVEAL_UNAVAILABLE" });
  assert.equal(verifyCalled, false);
  await assert.rejects(() => authorizer.challenge({ requestId: "bad\nid", sessionId: "s" }), { code: "AIRKIT_AUDIT_REVEAL_UNAVAILABLE" });
  await assert.rejects(() => authorizer.challenge({ requestId: "r", sessionId: "bad\rs" }), { code: "AIRKIT_AUDIT_REVEAL_UNAVAILABLE" });
});
