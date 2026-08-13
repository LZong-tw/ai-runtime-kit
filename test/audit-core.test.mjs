import assert from "node:assert/strict";
import { test } from "node:test";

import {
  AUDIT_EVENT_VERSION,
  AuditEventError,
  createAuditEvent,
  validateAuditEvent,
} from "../src/audit/event.mjs";
import {
  allowlistedUsage,
  canonicalizeEvidence,
  redactEvidence,
} from "../src/audit/redaction.mjs";
import {
  decryptAuditValue,
  deriveAuditKey,
  encryptAuditValue,
  packEncryptedValue,
  unpackEncryptedValue,
} from "../src/audit/crypto.mjs";

function createFixture(overrides = {}) {
  return createAuditEvent({
    event_id: "event_01",
    event_version: AUDIT_EVENT_VERSION,
    source: "airkit-test",
    source_version: "1.0.0",
    source_event_id: "source_event_01",
    observed_at: "2026-08-13T01:02:03.004Z",
    event_kind: "provider_response",
    logical_request_id: "req_01",
    attempt_id: "attempt_01",
    session_id: "session_01",
    client: "airclaude",
    payload: { status: 200 },
    ...overrides,
  });
}

test("provider terminal events require both request identities", () => {
  assert.throws(
    () => validateAuditEvent(createFixture({ event_kind: "provider_response", attempt_id: null })),
    (error) => error.code === "AIRKIT_AUDIT_INVALID_EVENT",
  );
});

test("request events require the logical request identity", () => {
  assert.throws(
    () => validateAuditEvent(createFixture({ event_kind: "request_started", logical_request_id: "" })),
    (error) =>
      error instanceof AuditEventError &&
      error.code === "AIRKIT_AUDIT_INVALID_EVENT" &&
      /logical_request_id/.test(error.message),
  );
});

test("valid audit events preserve the approved envelope and reject unknown kinds", () => {
  const valid = validateAuditEvent(createFixture({
    event_kind: "provider_request",
    payload: { nested: { b: 2, a: 1 } },
  }));

  assert.deepEqual(Object.keys(valid), [
    "event_id",
    "event_version",
    "source",
    "source_version",
    "source_event_id",
    "observed_at",
    "logical_request_id",
    "attempt_id",
    "session_id",
    "client",
    "event_kind",
    "payload",
  ]);
  assert.equal(valid.event_id, "event_01");
  assert.equal(valid.event_version, AUDIT_EVENT_VERSION);
  assert.equal(valid.source, "airkit-test");
  assert.equal(valid.source_version, "1.0.0");
  assert.equal(valid.source_event_id, "source_event_01");
  assert.equal(valid.observed_at, "2026-08-13T01:02:03.004Z");
  assert.equal(valid.event_kind, "provider_request");
  assert.equal(valid.logical_request_id, "req_01");
  assert.equal(valid.attempt_id, "attempt_01");
  assert.equal(valid.session_id, "session_01");
  assert.equal(valid.client, "airclaude");
  assert.notEqual(valid.payload, createFixture().payload);
  assert.throws(
    () => validateAuditEvent(createFixture({ event_kind: "provider_debug_dump" })),
    (error) => error.code === "AIRKIT_AUDIT_INVALID_EVENT",
  );
});

test("event payload validation rejects non JSON-safe values with audit errors", () => {
  const cyclic = {};
  cyclic.self = cyclic;
  const unsafeValues = [
    new Map([["status", 200]]),
    new Set(["status"]),
    1n,
    () => "status",
    cyclic,
  ];

  for (const payload of unsafeValues) {
    assert.throws(
      () => validateAuditEvent(createFixture({ payload })),
      (error) =>
        error instanceof AuditEventError &&
        error.code === "AIRKIT_AUDIT_INVALID_EVENT" &&
        !/TypeError/.test(error.name),
    );
  }
});

test("unsafe evidence downgrades without persisting the value", () => {
  const result = redactEvidence({ headers: { authorization: "Basic c2VjcmV0" } });
  assert.equal(result.state, "complete");
  assert.equal(result.value.headers.authorization, "[redacted]");
  assert.equal(result.redactionCount, 1);
  assert.deepEqual(result.credentialKinds, ["authorization"]);
  assert.equal(result.reason, null);
  assert.doesNotMatch(JSON.stringify(result), /c2VjcmV0/);
});

test("redaction covers token shaped credentials across nested evidence", () => {
  const result = redactEvidence({
    apiKey: "sk-abcDEF1234567890",
    nested: [
      { access_token: "ghp_0123456789abcdef0123456789abcdef0123" },
      { arn: "not-a-secret", account: "123456789012" },
    ],
  });

  assert.equal(result.state, "complete");
  assert.deepEqual(result.value, {
    apiKey: "[redacted]",
    nested: [
      { access_token: "[redacted]" },
      { arn: "not-a-secret", account: "123456789012" },
    ],
  });
  assert.deepEqual(result.credentialKinds, ["access_token", "api_key"]);
  assert.doesNotMatch(JSON.stringify(result), /sk-abcDEF|ghp_0123/);
});

test("redaction covers provider API key header families without persisting raw values", () => {
  const result = redactEvidence({
    headers: {
      "x-api-key": "plain-provider-secret",
      "X-Goog-Api-Key": "google-provider-secret",
      "openai-api-key": "openai-provider-secret",
    },
  });

  assert.deepEqual(result.value.headers, {
    "x-api-key": "[redacted]",
    "X-Goog-Api-Key": "[redacted]",
    "openai-api-key": "[redacted]",
  });
  assert.equal(result.redactionCount, 3);
  assert.deepEqual(result.credentialKinds, ["api_key"]);
  assert.doesNotMatch(
    JSON.stringify(result),
    /plain-provider-secret|google-provider-secret|openai-provider-secret/,
  );
});

test("usage allowlist drops unsupported fields without guessing conflicts", () => {
  assert.deepEqual(allowlistedUsage({
    input_tokens: 10,
    output_tokens: 3,
    cache_creation_input_tokens: 5,
    cache_read_input_tokens: 8,
    total_tokens: 13,
    billing_plan: "unsafe-extra-field",
  }), {
    cache_creation_input_tokens: 5,
    cache_read_input_tokens: 8,
    input_tokens: 10,
    output_tokens: 3,
    total_tokens: 13,
  });
});

test("canonical evidence sorts object keys while preserving array order", () => {
  assert.equal(
    canonicalizeEvidence({
      z: 1,
      a: [{ b: 2, a: 1 }, { c: 3 }],
      m: "same",
    }),
    '{"a":[{"a":1,"b":2},{"c":3}],"m":"same","z":1}',
  );
});

test("audit encryption uses domain separated keys and authenticated packing", () => {
  const masterKey = Buffer.alloc(32, 7);
  const aad = Buffer.from("audit-event:req_01");
  const nonce = Buffer.from("00112233445566778899aabb", "hex");
  const plaintext = Buffer.from("redacted evidence payload");
  const spoolKey = deriveAuditKey({ masterKey, purpose: "spool-event/v1", identity: "req_01" });
  const evidenceKey = deriveAuditKey({ masterKey, purpose: "request-evidence/v1", identity: "req_01" });

  assert.equal(spoolKey.length, 32);
  assert.equal(evidenceKey.length, 32);
  assert.notDeepEqual(spoolKey, evidenceKey);

  const encrypted = encryptAuditValue({
    masterKey,
    purpose: "request-evidence/v1",
    identity: "req_01",
    aad,
    plaintext,
    nonce,
  });
  assert.equal(encrypted.version, 1);
  assert.equal(encrypted.keyId, "payload-master-v1");
  assert.equal(encrypted.nonce, "00112233445566778899aabb");
  assert.notEqual(encrypted.ciphertext, plaintext.toString("base64"));

  const packed = packEncryptedValue(encrypted);
  assert.deepEqual(unpackEncryptedValue(packed), encrypted);
  assert.deepEqual(
    decryptAuditValue({
      masterKey,
      purpose: "request-evidence/v1",
      identity: "req_01",
      aad,
      encrypted: unpackEncryptedValue(packed),
    }),
    plaintext,
  );
  assert.throws(
    () => decryptAuditValue({
      masterKey,
      purpose: "spool-event/v1",
      identity: "req_01",
      aad,
      encrypted,
    }),
    /Unsupported state|authenticate|bad decrypt|invalid/i,
  );
});
