import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { chmod, mkdtemp, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { attestShieldCheckpoint } from "../src/shield/checkpoint.mjs";
import { createPrivacyFilter, isVerifiedRedaction, runPrivacyWorkerSelfTest } from "../src/shield/privacy.mjs";

const sentinel = "privacy-raw-sentinel-must-not-escape";
const provision = {
  privacy: {
    version: "privacy-1",
    worker: { command: "/opt/airkit/privacy-worker", args: ["--stdio"], sha256: "a".repeat(64) },
  },
};
const opfProvision = {
  privacy: {
    ...provision.privacy,
    checkpoint: { path: "/opt/airkit/model", sha256: "b".repeat(64), version: "opf-2026-09" },
    source: { path: "/opt/airkit/opf-source", sha256: "c".repeat(64), version: "opf-source-1" },
    adapter: { path: "/opt/airkit/opf-adapter.mjs", sha256: "d".repeat(64) },
    tokenizer: { path: "/opt/airkit/tiktoken-cache/fb374d419588a4632f3f557e76b4b70aebbca790", sha256: "e".repeat(64), version: "o200k_base" },
  },
};
opfProvision.privacy.worker = { ...opfProvision.privacy.worker, args: [
  "--python", "/opt/airkit/python", "--checkpoint", opfProvision.privacy.checkpoint.path,
  "--checkpoint-sha256", opfProvision.privacy.checkpoint.sha256, "--checkpoint-version", opfProvision.privacy.checkpoint.version,
  "--opf-source", opfProvision.privacy.source.path, "--opf-source-sha256", opfProvision.privacy.source.sha256,
  "--adapter-sha256", opfProvision.privacy.adapter.sha256,
  "--tokenizer", opfProvision.privacy.tokenizer.path, "--tokenizer-sha256", opfProvision.privacy.tokenizer.sha256,
  "--startup-timeout-ms", "30000", "--scan-timeout-ms", "2000",
] };
const validateWorker = async () => {};
const validateFile = async () => {};

test("persistent privacy worker health-checks then returns a validated redacted JSON buffer", async (t) => {
  const worker = fakeWorker((message, emit) => {
    if (message.type === "health") emit({ type: "health", id: message.id, protocol: "airkit-privacy-ndjson-v1", version: "privacy-1" });
    if (message.type === "scan") emit({
      type: "scan", id: message.id, status: "ok", findings: [{ label: "email", count: 1 }],
      redactedBody: Buffer.from('{"content":"[EMAIL]"}').toString("base64"),
    });
  });
  const filter = await createPrivacyFilter({ provision, spawnWorker: () => worker, validateWorker });
  t.after(() => filter.close());

  const result = await filter.scan(Buffer.from(`{"content":"${sentinel}"}`));
  assert.equal(result.status, "ok");
  assert.deepEqual(result.findings, [{ label: "email", count: 1 }]);
  assert.deepEqual(result.redactedBody, Buffer.from('{"content":"[EMAIL]"}'));
  assert.equal(result.redactedBody.equals(Buffer.from(`{"content":"${sentinel}"}`)), false);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(sentinel));
  assert.equal(worker.messages.filter((entry) => entry.type === "health").length, 1);
  assert.equal(worker.messages.filter((entry) => entry.type === "scan").length, 1);
});

test("Privacy Filter labels retain their original categories across the worker boundary", async (t) => {
  const labels = ["account_number", "private_address", "private_email", "private_person", "private_phone", "private_url", "private_date", "secret"];
  const worker = fakeWorker((message, emit) => {
    if (message.type === "health") emit(health(message));
    if (message.type === "scan") emit({
      type: "scan", id: message.id, status: "ok",
      findings: labels.map((label) => ({ label, count: 1 })),
    });
  });
  const filter = await createPrivacyFilter({ provision, spawnWorker: () => worker, validateWorker });
  t.after(() => filter.close());

  const result = await filter.scan(Buffer.from('{"content":"synthetic data"}'));
  assert.equal(result.status, "ok");
  assert.deepEqual(result.findings, labels.map((label) => ({ label, count: 1 })));
});

test("privacy worker assets are revalidated immediately before each worker spawn", async () => {
  let validations = 0;
  let spawns = 0;
  await assert.rejects(
    createPrivacyFilter({
      provision,
      validateWorker: async () => { validations += 1; throw new Error("digest changed"); },
      spawnWorker: () => { spawns += 1; return fakeWorker(() => {}); },
    }),
    /worker unavailable/i,
  );
  assert.equal(validations, 1);
  assert.equal(spawns, 0);
});

test("OPF filter accepts the pinned ten-second scan budget", async (t) => {
  const worker = fakeWorker((message, emit) => {
    if (message.type === "health") emit(health(message));
    if (message.type === "scan") emit({ type: "scan", id: message.id, status: "ok", findings: [] });
  });
  const extended = { privacy: {
    ...opfProvision.privacy,
    worker: { ...opfProvision.privacy.worker, args: [...opfProvision.privacy.worker.args.slice(0, 21), "10000"] },
  } };
  const filter = await createPrivacyFilter({
    provision: extended, spawnWorker: () => worker, validateWorker, validateFile,
    validateCheckpoint: async () => async () => {},
  });
  t.after(() => filter.close());
  assert.equal((await filter.scan(Buffer.from('{"content":"synthetic"}'))).status, "ok");
});

test("OPF scan waits beyond the generic two-second deadline when provisioned for ten seconds", async (t) => {
  const worker = fakeWorker((message, emit) => {
    if (message.type === "health") emit(health(message));
    if (message.type === "scan") setTimeout(() => emit({ type: "scan", id: message.id, status: "ok", findings: [] }), 2_100);
  });
  const extended = { privacy: {
    ...opfProvision.privacy,
    worker: { ...opfProvision.privacy.worker, args: [...opfProvision.privacy.worker.args.slice(0, 21), "10000"] },
  } };
  const filter = await createPrivacyFilter({
    provision: extended, spawnWorker: () => worker, validateWorker, validateFile,
    validateCheckpoint: async () => async () => {},
  });
  t.after(() => filter.close());
  assert.equal((await filter.scan(Buffer.from('{"content":"synthetic"}'))).status, "ok");
});

test("a missing or replaced checkpoint blocks before the worker receives request bytes", async (t) => {
  const worker = fakeWorker((message, emit) => {
    if (message.type === "health") emit(health(message));
    if (message.type === "scan") emit({ type: "scan", id: message.id, status: "ok", findings: [] });
  });
  let spawns = 0;
  await assert.rejects(createPrivacyFilter({
    provision: opfProvision,
    validateWorker,
    validateFile,
    validateCheckpoint: async () => { throw new Error("missing model"); },
    spawnWorker: () => { spawns += 1; return worker; },
  }), /checkpoint unavailable/i);
  assert.equal(spawns, 0);

  let validations = 0;
  const filter = await createPrivacyFilter({
    provision: opfProvision,
    validateWorker,
    validateFile,
    validateCheckpoint: async (_asset, { label } = {}) => {
      if (label !== "source") validations += 1;
      return async () => { if (label !== "source" && ++validations === 2) throw new Error("checkpoint replaced"); };
    },
    spawnWorker: () => worker,
  });
  t.after(() => filter.close());
  const result = await filter.scan(Buffer.from(`{"content":"${sentinel}"}`));
  assert.equal(result.status, "unavailable");
  assert.equal(validations, 2);
  assert.equal(worker.messages.filter((message) => message.type === "scan").length, 0);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(sentinel));
});

test("OPF source, adapter and tokenizer drift fail closed before scan bytes", async (t) => {
  for (const changed of ["source", "adapter", "tokenizer"]) {
    const worker = fakeWorker((message, emit) => {
      if (message.type === "health") emit(health(message));
      if (message.type === "scan") emit({ type: "scan", id: message.id, status: "ok", findings: [] });
    });
    let ready = false;
    const filter = await createPrivacyFilter({
      provision: opfProvision, validateWorker, spawnWorker: () => worker,
      validateCheckpoint: async (_asset, { label } = {}) => async () => {
        if (ready && label === changed) throw new Error("tree replaced");
      },
      validateFile: async (_asset, { label } = {}) => {
        if (ready && label === changed) throw new Error("file replaced");
      },
    });
    t.after(() => filter.close());
    ready = true;
    const result = await filter.scan(Buffer.from(`{"content":"${sentinel}"}`));
    assert.equal(result.status, "unavailable", changed);
    assert.equal(worker.messages.filter((message) => message.type === "scan").length, 0, changed);
  }
  await assert.rejects(createPrivacyFilter({
    provision: { privacy: { ...opfProvision.privacy, source: undefined } },
    validateWorker, validateFile, validateCheckpoint: async () => async () => {},
  }), /provision is invalid/i);
});

test("runtime redaction proof requires every reported privacy span to be absent from replacement JSON", () => {
  const original = Buffer.from('{"content":"alice@example.com"}');
  const span = { start: 12, end: 29 };
  const result = {
    status: "ok",
    findings: [{ label: "email", count: 1 }],
    redactions: [{ label: "email", count: 1, spans: [span] }],
    redactedBody: Buffer.from('{"content":"[EMAIL]"}'),
  };
  assert.equal(isVerifiedRedaction({ original, result }), true);
  assert.equal(isVerifiedRedaction({ original, result: { ...result, redactedBody: Buffer.from('{"content":"alice@example.com (reviewed)"}') } }), false);
  assert.equal(isVerifiedRedaction({ original, result: { ...result, redactions: [{ label: "email", count: 1, spans: [] }] } }), false);
});

test("privacy provision self-test requires deterministic supported-label redaction", async () => {
  const goodWorker = fakeWorker((message, emit) => {
    if (message.type === "health") emit(health(message));
    if (message.type === "scan") emit({ type: "scan", id: message.id, status: "ok", findings: [{ label: "email", count: 1 }], redactions: [{ label: "email", count: 1, spans: [{ start: 12, end: 47 }] }], redactedBody: Buffer.from('{"content":"[EMAIL]"}').toString("base64") });
  });
  assert.deepEqual(await runPrivacyWorkerSelfTest(provision, { spawnWorker: () => goodWorker, validateWorker }), { version: "privacy-1" });

  const inadequateWorker = fakeWorker((message, emit) => {
    if (message.type === "health") emit(health(message));
    if (message.type === "scan") emit({ type: "scan", id: message.id, status: "ok", findings: [] });
  });
  await assert.rejects(runPrivacyWorkerSelfTest(provision, { spawnWorker: () => inadequateWorker, validateWorker }), /self-test failed/i);
});

test("OPF provision self-test uses a valid synthetic mailbox and requires private_email", async () => {
  let scannedBody;
  const worker = fakeWorker((message, emit) => {
    if (message.type === "health") emit(health(message));
    if (message.type === "scan") {
      scannedBody = Buffer.from(message.body, "base64").toString("utf8");
      emit({ type: "scan", id: message.id, status: "ok",
        findings: [{ label: "private_email", count: 1 }],
        redactions: [{ label: "private_email", count: 1, spans: [{ start: 12, end: 29 }] }],
        redactedBody: Buffer.from('{"content":"[EMAIL]"}').toString("base64"),
      });
    }
  });
  assert.deepEqual(await runPrivacyWorkerSelfTest(opfProvision, {
    spawnWorker: () => worker, validateWorker, validateFile, validateCheckpoint: async () => async () => {},
  }), { version: "privacy-1" });
  assert.equal(scannedBody, '{"content":"alice@example.com"}');

  const wrongLabel = fakeWorker((message, emit) => {
    if (message.type === "health") emit(health(message));
    if (message.type === "scan") emit({ type: "scan", id: message.id, status: "ok",
      findings: [{ label: "email", count: 1 }],
      redactions: [{ label: "email", count: 1, spans: [{ start: 12, end: 29 }] }],
      redactedBody: Buffer.from('{"content":"[EMAIL]"}').toString("base64"),
    });
  });
  await assert.rejects(runPrivacyWorkerSelfTest(opfProvision, {
    spawnWorker: () => wrongLabel, validateWorker, validateFile, validateCheckpoint: async () => async () => {},
  }), /self-test failed/i);
});

test("privacy self-test rejects unchanged or category-incomplete replacement bodies", async () => {
  const unchangedWorker = fakeWorker((message, emit) => {
    if (message.type === "health") emit(health(message));
    if (message.type === "scan") emit({ type: "scan", id: message.id, status: "ok", findings: [{ label: "email", count: 1 }], redactions: [{ label: "email", count: 1, spans: [{ start: 12, end: 47 }] }], redactedBody: Buffer.from('{"content":"AIRKIT_PRIVACY_PROTOCOL_PROBE_EMAIL"}').toString("base64") });
  });
  await assert.rejects(runPrivacyWorkerSelfTest(provision, { spawnWorker: () => unchangedWorker, validateWorker }), /self-test failed/i);

  const incompleteWorker = fakeWorker((message, emit) => {
    if (message.type === "health") emit(health(message));
    if (message.type === "scan") emit({ type: "scan", id: message.id, status: "ok", findings: [{ label: "email", count: 1 }], redactions: [], redactedBody: Buffer.from('{"content":"[EMAIL]"}').toString("base64") });
  });
  await assert.rejects(runPrivacyWorkerSelfTest(provision, { spawnWorker: () => incompleteWorker, validateWorker }), /self-test failed/i);
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
    const filter = await createPrivacyFilter({ provision, spawnWorker: () => worker, validateWorker, timeoutMs: 5 });
    t.after(() => filter.close());
    const result = await filter.scan(Buffer.from(`{"content":"${sentinel}"}`));
    assert.equal(result.status, fixture.expected, fixture.name);
    assert.equal(result.redactedBody, undefined, fixture.name);
    assert.doesNotMatch(JSON.stringify(result), new RegExp(sentinel), fixture.name);
  }
});

test("privacy startup can exceed the scan deadline without disabling scan fail-closed", async (t) => {
  const worker = fakeWorker((message, emit) => {
    if (message.type === "health") setTimeout(() => emit(health(message)), 20);
  });
  const filter = await createPrivacyFilter({ provision, spawnWorker: () => worker, validateWorker, timeoutMs: 5, startupTimeoutMs: 50 });
  t.after(() => filter.close());
  assert.equal((await filter.scan(Buffer.from('{"content":"synthetic"}'))).status, "unavailable");
  assert.equal(worker.messages.filter((message) => message.type === "scan").length, 1);
});

test("OPF worker runs through the current Node interpreter instead of its executable shebang", async (t) => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "airkit-opf-interpreter-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const workerPath = join(directory, "worker.mjs");
  await writeFile(workerPath, `#!/usr/bin/false\nprocess.stdin.on("data", (chunk) => {\n  const request = JSON.parse(String(chunk).trim());\n  process.stdout.write(JSON.stringify({ type: "health", id: request.id, protocol: request.protocol, version: "privacy-1" }) + "\\n");\n});\n`);
  await chmod(workerPath, 0o700);
  const pinned = { privacy: {
    ...opfProvision.privacy,
    worker: { ...opfProvision.privacy.worker, command: workerPath },
    adapter: { ...opfProvision.privacy.adapter, path: join(directory, "opf-adapter.mjs") },
  } };
  const filter = await createPrivacyFilter({
    provision: pinned,
    validateWorker,
    validateFile,
    validateCheckpoint: async () => async () => {},
    startupTimeoutMs: 1_000,
  });
  t.after(() => filter.close());
  assert.equal(filter.version, "privacy-1");
});

test("checkpoint startup digest and per-scan metadata detect same-size inode replacement", async (t) => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "airkit-privacy-attest-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const model = join(directory, "model.bin");
  const bytes = Buffer.from("synthetic-model");
  await writeFile(model, bytes);
  const sha256 = createHash("sha256").update("model.bin\0").update(String(bytes.length)).update("\0").update(bytes).update("\0").digest("hex");
  const assertUnchanged = await attestShieldCheckpoint({ path: directory, sha256, version: "test" });
  await assertUnchanged();
  const replacement = join(directory, "new.bin");
  await writeFile(replacement, Buffer.from("synthetic-other"));
  await rename(replacement, model);
  await assert.rejects(assertUnchanged(), /metadata changed/i);
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
