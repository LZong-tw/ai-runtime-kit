import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat } from "node:fs/promises";
import { createConnection } from "node:net";
import { join } from "node:path";
import { test } from "node:test";

import { encryptAuditValue } from "../src/audit/crypto.mjs";
import { createAuditEvent } from "../src/audit/event.mjs";
import { resolveAuditPaths } from "../src/audit/paths.mjs";
import { openAuditStore } from "../src/audit/store.mjs";
import {
  createAuditClient,
  createAuditFrameDecoder,
  encodeAuditFrame,
} from "../src/audit/transport.mjs";
import { createAuditDaemon } from "../src/audit/daemon.mjs";

const MASTER_KEY = Buffer.alloc(32, 7);
const CAPABILITY = "capability-transport-v1";

function createFixture(overrides = {}) {
  return createAuditEvent({
    event_id: "event_01",
    source: "airkit-test",
    source_version: "1.0.0",
    source_event_id: "source_event_01",
    observed_at: "2026-08-13T01:02:03.004Z",
    event_kind: "request_payload",
    logical_request_id: "req_01",
    attempt_id: null,
    session_id: "session_01",
    client: "airclaude",
    payload: { marker: "payload-01" },
    ...overrides,
  });
}

function encryptEnvelope(event, { masterKey = MASTER_KEY } = {}) {
  const plaintext = Buffer.from(JSON.stringify(event), "utf8");
  return {
    event_id: event.event_id,
    encrypted: encryptAuditValue({
      masterKey,
      purpose: "request-evidence/v1",
      identity: event.event_id,
      plaintext,
    }),
  };
}

function createKeyProvider(masterKey = MASTER_KEY) {
  let calls = 0;
  return {
    async getMasterKey() {
      calls += 1;
      return masterKey;
    },
    get calls() {
      return calls;
    },
  };
}

async function withRoot(run) {
  const root = await mkdtemp("/tmp/airkit-audit-daemon-");
  try {
    const paths = resolveAuditPaths({
      env: {
        HOME: root,
        XDG_STATE_HOME: root,
      },
      overrides: {
        rootDir: join(root, "audit"),
        spoolDir: join(root, "spool"),
        socketPath: join(root, "auditd.sock"),
        querySocketPath: join(root, "auditd-query.sock"),
      },
    });
    await run({ root, paths });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

async function startTestDaemon(paths, overrides = {}) {
  await mkdir(paths.rootDir, { recursive: true });
  const store = overrides.store ?? openAuditStore({
    databasePath: join(paths.rootDir, "audit.sqlite"),
    backupDir: join(paths.rootDir, "backups"),
    now: () => new Date("2026-08-13T02:03:04.005Z"),
  });
  const daemon = createAuditDaemon({
    paths,
    capability: overrides.capability ?? CAPABILITY,
    keyProvider: overrides.keyProvider ?? createKeyProvider(),
    storeFactory: () => store,
    clock: overrides.clock ?? { now: () => Date.now() },
    readTimeoutMs: overrides.readTimeoutMs ?? 30,
    maxFrameBytes: overrides.maxFrameBytes ?? 32 * 1024,
    stderr: overrides.stderr ?? { write() {} },
  });
  await daemon.start();
  return { daemon, store };
}

async function writeAndReadAck({ socketPath, payload, timeoutMs = 200 }) {
  const decoder = createAuditFrameDecoder({ maxFrameBytes: 8 * 1024, readTimeoutMs: timeoutMs });
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let settled = false;

    function finish(error, value) {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve(value);
    }

    socket.setTimeout(timeoutMs);
    socket.once("connect", () => socket.end(payload));
    socket.on("data", (chunk) => {
      try {
        const decoded = decoder.push(chunk);
        if (decoded !== null) finish(null, decoded);
      } catch (error) {
        finish(error);
      }
    });
    socket.once("timeout", () => {
      socket.destroy();
      finish(new Error("socket timeout"));
    });
    socket.once("error", (error) => finish(error));
    socket.once("close", () => {
      if (!settled) finish(new Error("socket closed without ACK"));
    });
  });
}

test("encodeAuditFrame uses a four-byte big-endian length prefix", () => {
  const frame = encodeAuditFrame({ ok: true });
  assert.equal(frame.readUInt32BE(0), Buffer.byteLength(JSON.stringify({ ok: true }), "utf8"));
  assert.deepEqual(JSON.parse(frame.subarray(4).toString("utf8")), { ok: true });
});

test("decoder accepts fragmented frames and rejects trailing second messages on one connection", () => {
  const first = encodeAuditFrame({ ok: 1 });
  const second = encodeAuditFrame({ ok: 2 });
  const decoder = createAuditFrameDecoder({ maxFrameBytes: 1024, readTimeoutMs: 50 });

  assert.equal(decoder.push(first.subarray(0, 2)), null);
  assert.equal(decoder.push(first.subarray(2, 6)), null);
  assert.deepEqual(decoder.push(first.subarray(6)), { ok: 1 });
  assert.throws(() => decoder.push(second), /one frame per connection/i);
});

test("ACK is emitted only after commit", async () => {
  await withRoot(async ({ paths }) => {
    let releaseCommit;
    let committed = false;
    const commitGate = new Promise((resolve) => {
      releaseCommit = () => {
        committed = true;
        resolve();
      };
    });
    const store = {
      async ingestEvent() {
        await commitGate;
        return { status: "committed" };
      },
      close() {},
    };
    const { daemon } = await startTestDaemon(paths, {
      store,
      keyProvider: createKeyProvider(),
    });
    try {
      const encryptedEnvelope = encryptEnvelope(createFixture({ event_id: "event_ack_after_commit" }));
      const client = createAuditClient({
        socketPath: paths.socketPath,
        capability: CAPABILITY,
        timeoutMs: 200,
      });
      const pendingAck = client.send(encryptedEnvelope);
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(committed, false);
      releaseCommit();
      assert.deepEqual(await pendingAck, {
        event_id: encryptedEnvelope.event_id,
        status: "committed",
      });
    } finally {
      await daemon.stop();
    }
  });
});

test("bad capability closes before decrypt", async () => {
  await withRoot(async ({ paths }) => {
    const keyProvider = createKeyProvider();
    const { daemon } = await startTestDaemon(paths, { keyProvider });
    try {
      const encryptedEnvelope = encryptEnvelope(createFixture({ event_id: "event_bad_capability" }));
      const badClient = createAuditClient({
        socketPath: paths.socketPath,
        capability: "wrong-capability",
        timeoutMs: 200,
      });

      await assert.rejects(badClient.send(encryptedEnvelope), /authorization/i);
      assert.equal(keyProvider.calls, 0);
    } finally {
      await daemon.stop();
    }
  });
});

test("duplicate events ACK as duplicate after the store result is committed", async () => {
  await withRoot(async ({ paths }) => {
    const { daemon } = await startTestDaemon(paths);
    try {
      const event = createFixture({ event_id: "event_duplicate", source_event_id: "src_duplicate" });
      const envelope = encryptEnvelope(event);
      const client = createAuditClient({
        socketPath: paths.socketPath,
        capability: CAPABILITY,
        timeoutMs: 200,
      });

      assert.deepEqual(await client.send(envelope), { event_id: event.event_id, status: "committed" });
      assert.deepEqual(await client.send(envelope), { event_id: event.event_id, status: "duplicate" });
    } finally {
      await daemon.stop();
    }
  });
});

test("daemon rejects malformed and oversized frames without writing secrets to stderr", async () => {
  await withRoot(async ({ paths }) => {
    const stderr = [];
    const { daemon } = await startTestDaemon(paths, {
      maxFrameBytes: 64,
      stderr: { write(value) { stderr.push(String(value)); } },
    });
    try {
      const oversized = Buffer.concat([
        Buffer.from([0, 0, 0, 80]),
        Buffer.from("x".repeat(80), "utf8"),
      ]);
      await assert.rejects(
        writeAndReadAck({ socketPath: paths.socketPath, payload: oversized }),
        /closed without ACK|frame/i,
      );

      const malformed = encodeAuditFrame({ event_id: "event_malformed", encrypted: { nope: true } });
      await assert.rejects(
        writeAndReadAck({ socketPath: paths.socketPath, payload: malformed }),
        /closed without ACK|invalid|authorization/i,
      );

      assert.equal(stderr.some((line) => line.includes("event_malformed")), false);
      assert.equal(stderr.some((line) => line.includes("xxxxx")), false);
    } finally {
      await daemon.stop();
    }
  });
});

test("slow frames time out and close", async () => {
  await withRoot(async ({ paths }) => {
    const { daemon } = await startTestDaemon(paths, { readTimeoutMs: 20 });
    try {
      const event = createFixture({ event_id: "event_slow" });
      const envelope = encryptEnvelope(event);
      const frame = encodeAuditFrame({
        event_id: envelope.event_id,
        encrypted: envelope.encrypted,
        ciphertext_hash: "placeholder",
        capability_hmac: "placeholder",
      });

      await assert.rejects(new Promise((resolve, reject) => {
        const socket = createConnection(paths.socketPath);
        socket.once("connect", async () => {
          socket.write(frame.subarray(0, 2));
          await new Promise((done) => setTimeout(done, 60));
          socket.write(frame.subarray(2));
        });
        socket.once("error", reject);
        socket.once("close", () => reject(new Error("socket closed")));
        socket.once("timeout", () => reject(new Error("socket timeout")));
        socket.on("data", resolve);
      }), /socket closed|timeout/i);
    } finally {
      await daemon.stop();
    }
  });
});

test("graceful drain waits for accepted work and then closes the store", async () => {
  await withRoot(async ({ paths }) => {
    let releaseCommit;
    let closeCount = 0;
    const store = {
      async ingestEvent() {
        await new Promise((resolve) => {
          releaseCommit = resolve;
        });
        return { status: "committed" };
      },
      close() {
        closeCount += 1;
      },
    };
    const { daemon } = await startTestDaemon(paths, { store });
    try {
      const client = createAuditClient({
        socketPath: paths.socketPath,
        capability: CAPABILITY,
        timeoutMs: 200,
      });
      const pendingAck = client.send(encryptEnvelope(createFixture({ event_id: "event_drain" })));
      await new Promise((resolve) => setTimeout(resolve, 20));

      const stopping = daemon.stop();
      assert.equal(daemon.status().draining, true);
      releaseCommit();
      await stopping;
      assert.equal(closeCount, 1);
      assert.deepEqual(await pendingAck, { event_id: "event_drain", status: "committed" });
    } finally {
      await daemon.stop();
    }
  });
});

test("starting a second daemon over the same database path fails the single-writer contract", async () => {
  await withRoot(async ({ paths }) => {
    const first = await startTestDaemon(paths);
    try {
      await assert.rejects(
        startTestDaemon(paths),
        /writer|listen|address already in use/i,
      );
    } finally {
      await first.daemon.stop();
    }
  });
});

test("daemon creates strict root and socket modes", async () => {
  await withRoot(async ({ paths }) => {
    const { daemon } = await startTestDaemon(paths);
    try {
      assert.equal((await stat(paths.rootDir)).mode & 0o777, 0o700);
      assert.equal((await stat(paths.socketPath)).mode & 0o777, 0o600);
      assert.doesNotMatch(await readFile(paths.socketPath, "utf8").catch(() => ""), /./);
    } finally {
      await daemon.stop();
    }
  });
});
