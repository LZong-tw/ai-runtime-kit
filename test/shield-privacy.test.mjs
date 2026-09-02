import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { createPrivacyFilter, runPrivacyWorkerSelfTest } from "../src/shield/privacy.mjs";

const sentinel = "privacy-raw-sentinel-must-not-escape";
const provision = {
  privacy: {
    version: "privacy-1",
    worker: { command: "/opt/airkit/privacy-worker", args: ["--stdio"], sha256: "a".repeat(64) },
  },
};

test("persistent privacy worker health-checks then returns a validated redacted JSON buffer", async (t) => {
  const worker = fakeWorker((message, emit) => {
    if (message.type === "health") emit({ type: "health", id: message.id, protocol: "airkit-privacy-ndjson-v1", version: "privacy-1" });
    if (message.type === "scan") emit({
      type: "scan", id: message.id, status: "ok", findings: [{ label: "email", count: 1 }],
      redactedBody: Buffer.from('{"content":"[EMAIL]"}').toString("base64"),
    });
  });
  const filter = await createPrivacyFilter({ provision, spawnWorker: () => worker });
  t.after(() => filter.close());

  const result = await filter.scan(Buffer.from(`{"content":"${sentinel}"}`));
  assert.equal(result.status, "ok");
  assert.deepEqual(result.findings, [{ label: "email", count: 1 }]);
  assert.deepEqual(result.redactedBody, Buffer.from('{"content":"[EMAIL]"}'));
  assert.notEqual(result.redactedBody, Buffer.from('{"content":"[EMAIL]"}'));
  assert.doesNotMatch(JSON.stringify(result), new RegExp(sentinel));
  assert.equal(worker.messages.filter((entry) => entry.type === "health").length, 1);
  assert.equal(worker.messages.filter((entry) => entry.type === "scan").length, 1);
});

test("privacy provision self-test requires deterministic supported-label redaction", async () => {
  const goodWorker = fakeWorker((message, emit) => {
    if (message.type === "health") emit(health(message));
    if (message.type === "scan") emit({ type: "scan", id: message.id, status: "ok", findings: [{ label: "email", count: 1 }], redactedBody: Buffer.from('{"content":"[EMAIL]"}').toString("base64") });
  });
  assert.deepEqual(await runPrivacyWorkerSelfTest(provision, { spawnWorker: () => goodWorker }), { version: "privacy-1" });

  const inadequateWorker = fakeWorker((message, emit) => {
    if (message.type === "health") emit(health(message));
    if (message.type === "scan") emit({ type: "scan", id: message.id, status: "ok", findings: [] });
  });
  await assert.rejects(runPrivacyWorkerSelfTest(provision, { spawnWorker: () => inadequateWorker }), /self-test failed/i);
});

test("privacy worker timeout, exit, malformed reply, unknown labels, and oversized output fail closed without raw data", async (t) => {
  const cases = [
    { name: "timeout", handler: (message, emit) => { if (message.type === "health") emit(health(message)); }, expected: "unavailable" },
    { name: "exit", handler: (message, emit, worker) => message.type === "health" ? emit(health(message)) : worker.emit("exit", 1), expected: "unavailable" },
    { name: "malformed", handler: (message, emit) => message.type === "health" ? emit(health(message)) : emit({ type: "scan", id: message.id, status: "ok", findings: "bad" }), expected: "unavailable" },
    { name: "mismatched", handler: (message, emit) => message.type === "health" ? emit(health(message)) : emit({ type: "scan", id: "different", status: "ok", findings: [] }), expected: "unavailable" },
    { name: "unknown", handler: (message, emit) => message.type === "health" ? emit(health(message)) : emit({ type: "scan", id: message.id, status: "ok", findings: [{ label: "mystery", count: 1 }] }), expected: "unknown" },
    { name: "oversized", handler: (message, emit, worker) => message.type === "health" ? emit(health(message)) : worker.stdout.emit("data", "x".repeat(1_048_577)), expected: "unavailable" },
  ];

  for (const fixture of cases) {
    const worker = fakeWorker(fixture.handler);
    const filter = await createPrivacyFilter({ provision, spawnWorker: () => worker, timeoutMs: 5 });
    t.after(() => filter.close());
    const result = await filter.scan(Buffer.from(`{"content":"${sentinel}"}`));
    assert.equal(result.status, fixture.expected, fixture.name);
    assert.equal(result.redactedBody, undefined, fixture.name);
    assert.doesNotMatch(JSON.stringify(result), new RegExp(sentinel), fixture.name);
  }
});

function health(message) {
  return { type: "health", id: message.id, protocol: "airkit-privacy-ndjson-v1", version: "privacy-1" };
}

function fakeWorker(handler) {
  const worker = new EventEmitter();
  worker.stdout = new EventEmitter();
  worker.stderr = new EventEmitter();
  worker.messages = [];
  worker.stdin = {
    write(chunk) {
      const message = JSON.parse(String(chunk).trim());
      worker.messages.push(message);
      handler(message, (reply) => emit(worker, reply), worker);
      return true;
    },
    end() {},
  };
  worker.kill = () => worker.emit("exit", 0);
  return worker;
}

function emit(worker, reply) {
  worker.stdout.emit("data", `${JSON.stringify(reply)}\n`);
}
