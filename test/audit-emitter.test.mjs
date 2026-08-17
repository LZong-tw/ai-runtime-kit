import assert from "node:assert/strict";
import { createServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createAuditEmitter, hashAuditBody } from "../src/audit/emitter.mjs";
import { decryptAuditValue } from "../src/audit/crypto.mjs";
import { createAuditClient, createAuditFrameDecoder, encodeAuditFrame } from "../src/audit/transport.mjs";

test("audit emitter creates redacted request events and preserves request identity", async () => {
  const events = [];
  const masterKey = Buffer.alloc(32, 7);
  const emitter = createAuditEmitter({
    masterKey,
    client: {
      send: async (envelope) => events.push(JSON.parse(decryptAuditValue({
        masterKey,
        purpose: "request-evidence/v1",
        identity: envelope.event_id,
        encrypted: envelope.encrypted,
      }).toString("utf8"))),
    },
    launchInstanceId: "launch-1",
    sessionContext: { session_id: "session-1" },
  });

  const started = await emitter.emit("request_started", {
    logical_request_id: "request-1",
    payload: { path: "/v1/messages", authorization: "Bearer secret" },
  });

  assert.equal(started.logical_request_id, "request-1");
  assert.equal(started.session_id, "session-1");
  assert.equal(events[0].payload.authorization, "[redacted]");
  assert.equal(events[0].source_event_id, "launch-1");
});

test("audit emitter sends an encrypted envelope through the real audit client", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "airkit-audit-emitter-"));
  const socketPath = join(root, "audit.sock");
  const server = createServer((socket) => {
    const decoder = createAuditFrameDecoder();
    socket.on("data", (chunk) => {
      const frame = decoder.push(chunk);
      if (frame === null) return;
      assert.ok(frame.encrypted);
      socket.end(encodeAuditFrame({ event_id: frame.event_id, status: "committed" }));
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  t.after(async () => {
    await new Promise((resolve) => server.close(() => resolve()));
    await rm(root, { force: true, recursive: true });
  });

  const masterKey = Buffer.alloc(32, 9);
  const emitter = createAuditEmitter({
    masterKey,
    client: createAuditClient({ socketPath, capability: "test-capability" }),
  });
  const event = await emitter.emit("request_started", {
    logical_request_id: "request-transport",
    payload: { path: "/v1/messages" },
  });

  assert.equal(event.logical_request_id, "request-transport");
});

test("audit emitter fails open and emits only a bounded gap", async () => {
  const events = [];
  const masterKey = Buffer.alloc(32, 8);
  const emitter = createAuditEmitter({
    masterKey,
    client: {
      send: async (envelope) => {
        const event = JSON.parse(decryptAuditValue({
          masterKey,
          purpose: "request-evidence/v1",
          identity: envelope.event_id,
          encrypted: envelope.encrypted,
        }).toString("utf8"));
        events.push(event);
        if (event.event_kind !== "collector_gap") throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
      },
    },
  });

  assert.equal(await emitter.emit("request_payload", {
    logical_request_id: "request-2",
    payload: { body: "Bearer very-secret-value" },
  }), null);
  assert.equal(events.length, 2);
  assert.equal(events[1].event_kind, "collector_gap");
  assert.equal(events[1].payload.error, "ENOSPC");
  assert.doesNotMatch(JSON.stringify(events), /very-secret-value|disk full/);
});

test("hashAuditBody is byte based rather than JSON based", () => {
  assert.notEqual(hashAuditBody(Buffer.from('{"a":1}')), hashAuditBody(Buffer.from('{ "a": 1 }')));
  assert.equal(hashAuditBody(Buffer.from("abc")), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});
