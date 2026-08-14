import assert from "node:assert/strict";
import { test } from "node:test";

import { createAuditEmitter, hashAuditBody } from "../src/audit/emitter.mjs";

test("audit emitter creates redacted request events and preserves request identity", async () => {
  const events = [];
  const emitter = createAuditEmitter({
    client: { send: async (event) => events.push(event) },
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

test("audit emitter fails open and emits only a bounded gap", async () => {
  const events = [];
  const emitter = createAuditEmitter({
    client: {
      send: async (event) => {
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
