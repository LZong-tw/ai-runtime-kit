import assert from "node:assert/strict";
import {
  chmod,
  mkdtemp,
  open as fsOpen,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test } from "node:test";

import {
  AUDIT_EVENT_VERSION,
  createAuditEvent,
} from "../src/audit/event.mjs";
import { resolveAuditPaths } from "../src/audit/paths.mjs";
import { createEncryptedSpool } from "../src/audit/spool.mjs";

const MASTER_KEY = Buffer.alloc(32, 9);

function createFixture(overrides = {}) {
  return createAuditEvent({
    event_id: "event_01",
    event_version: AUDIT_EVENT_VERSION,
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

async function withRoot(run) {
  const root = await mkdtemp(join(tmpdir(), "airkit-audit-spool-"));
  try {
    await run(root);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

async function withFrozenDate(isoTimestamp, run) {
  const RealDate = Date;
  const frozen = new RealDate(isoTimestamp);
  globalThis.Date = class extends RealDate {
    constructor(value) {
      super(value ?? frozen.toISOString());
    }

    static now() {
      return frozen.valueOf();
    }

    static parse(value) {
      return RealDate.parse(value);
    }

    static UTC(...args) {
      return RealDate.UTC(...args);
    }
  };
  try {
    await run();
  } finally {
    globalThis.Date = RealDate;
  }
}

function makePaths(root, overrides = {}) {
  return resolveAuditPaths({
    env: {
      HOME: root,
      XDG_STATE_HOME: join(root, ".state"),
    },
    overrides,
  });
}

function createTrackingIo(events) {
  return {
    chmod,
    async mkdir(path, options) {
      const { mkdir } = await import("node:fs/promises");
      return mkdir(path, options);
    },
    async open(path, flags, mode) {
      events.push(`open:${flags}:${basename(path)}`);
      const handle = await fsOpen(path, flags, mode);
      return {
        async close() {
          events.push(`close:${basename(path)}`);
          return handle.close();
        },
        async readFile(options) {
          return handle.readFile(options);
        },
        async sync() {
          events.push(`sync:${basename(path)}`);
          return handle.sync();
        },
        async writeFile(value, options) {
          events.push(`write:${basename(path)}`);
          return handle.writeFile(value, options);
        },
      };
    },
    async readdir(path, options) {
      return readdir(path, options);
    },
    async readFile(path, options) {
      return readFile(path, options);
    },
    async rename(from, to) {
      const { rename } = await import("node:fs/promises");
      events.push(`rename:${basename(from)}->${basename(to)}`);
      return rename(from, to);
    },
    async rm(path, options) {
      return rm(path, options);
    },
    async stat(path) {
      return stat(path);
    },
    async writeFile(path, value, options) {
      events.push(`writeFile:${basename(path)}`);
      return writeFile(path, value, options);
    },
  };
}

test("resolveAuditPaths derives the shared audit root, spool, and both sockets", async () => {
  await withRoot(async (root) => {
    const paths = makePaths(root);
    assert.equal(paths.rootDir, join(root, ".state", "airkit-audit"));
    assert.equal(paths.spoolDir, join(root, ".state", "airkit-audit", "spool"));
    assert.equal(paths.socketPath, join(root, ".state", "airkit-audit", "auditd.sock"));
    assert.equal(paths.querySocketPath, join(root, ".state", "airkit-audit", "auditd-query.sock"));

    const overridden = makePaths(root, { rootDir: join(root, "custom-audit") });
    assert.equal(overridden.rootDir, join(root, "custom-audit"));
    assert.equal(overridden.spoolDir, join(root, "custom-audit", "spool"));
    assert.equal(overridden.socketPath, join(root, "custom-audit", "auditd.sock"));
    assert.equal(overridden.querySocketPath, join(root, "custom-audit", "auditd-query.sock"));
  });
});

test("spool writes encrypted files with strict modes, fsync ordering, and ignores temp leftovers", async () => {
  await withRoot(async (root) => {
    const paths = makePaths(root);
    const events = [];
    const spool = createEncryptedSpool({
      paths,
      masterKey: MASTER_KEY,
      maxEvents: 8,
      maxBytes: 32 * 1024,
      nearLimitRatio: 0.75,
      io: createTrackingIo(events),
    });

    const leftover = join(paths.spoolDir, ".leftover.tmp");
    await spool.enqueue(createFixture({
      event_id: "event_modes",
      payload: { marker: "super-secret-marker" },
    }));
    await writeFile(leftover, "incomplete", { mode: 0o600 });

    const pending = await spool.entries();
    assert.equal(pending.length, 1);
    assert.equal(pending[0].event.event_id, "event_modes");

    const names = await readdir(paths.spoolDir);
    assert.ok(names.some((name) => name.endsWith(".json")));
    assert.ok(names.includes(".leftover.tmp"));

    const recordPath = join(paths.spoolDir, names.find((name) => name.endsWith(".json")));
    assert.equal((await stat(paths.spoolDir)).mode & 0o777, 0o700);
    assert.equal((await stat(recordPath)).mode & 0o777, 0o600);
    assert.doesNotMatch(await readFile(recordPath, "utf8"), /super-secret-marker/);

    const renameIndex = events.findIndex((event) => event.startsWith("rename:"));
    const fileSyncIndex = events.findIndex((event) => event.startsWith("sync:."));
    const dirSyncIndex = events.lastIndexOf(`sync:${basename(paths.spoolDir)}`);
    assert.ok(fileSyncIndex >= 0);
    assert.ok(renameIndex > fileSyncIndex);
    assert.ok(dirSyncIndex > renameIndex);
  });
});

test("spool removes an event only after a matching ACK", async () => {
  await withRoot(async (root) => {
    const paths = makePaths(root);
    const spool = createEncryptedSpool({
      paths,
      masterKey: MASTER_KEY,
      maxEvents: 8,
      maxBytes: 32 * 1024,
      nearLimitRatio: 0.75,
    });
    const event = createFixture({ event_id: "event_ack" });

    const entry = await spool.enqueue(event);
    await assert.rejects(
      spool.acknowledge(entry, { event_id: "other", status: "committed" }),
      /matching ACK/i,
    );
    assert.equal((await spool.entries()).length, 1);

    await spool.acknowledge(entry, { event_id: event.event_id, status: "duplicate" });
    assert.equal((await spool.entries()).length, 0);
  });
});

test("deliverPending is FIFO and idempotent until explicit acknowledgement", async () => {
  await withRoot(async (root) => {
    const paths = makePaths(root);
    const spool = createEncryptedSpool({
      paths,
      masterKey: MASTER_KEY,
      maxEvents: 8,
      maxBytes: 32 * 1024,
      nearLimitRatio: 0.75,
    });

    await spool.enqueue(createFixture({
      event_id: "event_fifo_1",
      observed_at: "2026-08-13T01:02:03.004Z",
      payload: { marker: "payload-1" },
    }));
    await spool.enqueue(createFixture({
      event_id: "event_fifo_2",
      observed_at: "2026-08-13T01:02:04.004Z",
      payload: { marker: "payload-2" },
    }));

    const firstPass = await spool.deliverPending();
    const secondPass = await spool.deliverPending();
    assert.deepEqual(firstPass.map((entry) => entry.event.event_id), ["event_fifo_1", "event_fifo_2"]);
    assert.deepEqual(secondPass.map((entry) => entry.event.event_id), ["event_fifo_1", "event_fifo_2"]);

    await spool.acknowledge(firstPass[0], { event_id: "event_fifo_1", status: "committed" });
    assert.deepEqual((await spool.deliverPending()).map((entry) => entry.event.event_id), ["event_fifo_2"]);
  });
});

test("deliverPending preserves enqueue FIFO when enqueued_at timestamps are identical", async () => {
  await withRoot(async (root) => {
    const paths = makePaths(root);
    const spool = createEncryptedSpool({
      paths,
      masterKey: MASTER_KEY,
      maxEvents: 8,
      maxBytes: 32 * 1024,
      nearLimitRatio: 0.75,
    });

    await withFrozenDate("2026-08-13T01:02:03.004Z", async () => {
      await spool.enqueue(createFixture({
        event_id: "event_b",
        observed_at: "2026-08-13T01:02:03.004Z",
        payload: { marker: "payload-b" },
      }));
      await spool.enqueue(createFixture({
        event_id: "event_a",
        observed_at: "2026-08-13T01:02:03.004Z",
        payload: { marker: "payload-a" },
      }));
    });

    assert.deepEqual(
      (await spool.deliverPending()).map((entry) => entry.event.event_id),
      ["event_b", "event_a"],
    );
  });
});

test("spool reserves one rolling encrypted overflow gap and reports near/full thresholds", async () => {
  await withRoot(async (root) => {
    const paths = makePaths(root);
    const spool = createEncryptedSpool({
      paths,
      masterKey: MASTER_KEY,
      maxEvents: 2,
      maxBytes: 16 * 1024,
      nearLimitRatio: 0.5,
    });

    await spool.enqueue(createFixture({
      event_id: "event_kept",
      payload: { marker: "secret-keep" },
    }));
    const nearStats = await spool.stats();
    assert.equal(nearStats.nearLimit, true);
    assert.equal(nearStats.atCapacity, false);

    await spool.enqueue(createFixture({
      event_id: "event_drop_1",
      payload: { marker: "secret-drop-1" },
    }));
    await spool.enqueue(createFixture({
      event_id: "event_drop_2",
      observed_at: "2026-08-13T01:02:09.004Z",
      payload: { marker: "secret-drop-2" },
    }));

    const pending = await spool.entries();
    const gapEntries = pending.filter((entry) => entry.event.event_kind === "collector_gap");
    assert.equal(pending.length, 2);
    assert.equal(gapEntries.length, 1);
    assert.equal(gapEntries[0].event.payload.reason, "spool-overflow");
    assert.equal(gapEntries[0].event.payload.dropped_events, 2);
    assert.doesNotMatch(JSON.stringify(gapEntries[0]), /secret-drop-1|secret-drop-2/);

    const fullStats = await spool.stats();
    assert.equal(fullStats.nearLimit, true);
    assert.equal(fullStats.atCapacity, true);
  });
});

test("overflow gap reservation never leaves byteCount above maxBytes", async () => {
  await withRoot(async (root) => {
    const paths = makePaths(root);
    const oversizedIdentity = "z".repeat(900);
    const spool = createEncryptedSpool({
      paths,
      masterKey: MASTER_KEY,
      maxEvents: 4,
      maxBytes: 2800,
      nearLimitRatio: 0.5,
    });

    await spool.enqueue(createFixture({
      event_id: "event_byte_kept",
      source_event_id: `source_event_byte_kept_${oversizedIdentity}`,
      logical_request_id: `req_${oversizedIdentity}`,
      session_id: `session_${oversizedIdentity}`,
      payload: { marker: "payload-kept" },
    }));
    await spool.enqueue(createFixture({
      event_id: "event_byte_drop_1",
      observed_at: "2026-08-13T01:02:07.004Z",
      source_event_id: `source_event_byte_drop_1_${oversizedIdentity}`,
      logical_request_id: `req_${oversizedIdentity}`,
      session_id: `session_${oversizedIdentity}`,
      payload: { marker: "payload-drop-1" },
    }));
    await spool.enqueue(createFixture({
      event_id: "event_byte_drop_2",
      observed_at: "2026-08-13T01:02:08.004Z",
      source_event_id: `source_event_byte_drop_2_${oversizedIdentity}`,
      logical_request_id: `req_${oversizedIdentity}`,
      session_id: `session_${oversizedIdentity}`,
      payload: { marker: "payload-drop-2" },
    }));

    const spoolStats = await spool.stats();
    assert.ok(spoolStats.byteCount <= 2800, `byteCount ${spoolStats.byteCount} exceeded maxBytes`);
    assert.equal((await spool.entries()).some((entry) => entry.event.event_kind === "collector_gap"), true);
  });
});

test("corrupt ciphertext stays on disk and is skipped during delivery", async () => {
  await withRoot(async (root) => {
    const paths = makePaths(root);
    const spool = createEncryptedSpool({
      paths,
      masterKey: MASTER_KEY,
      maxEvents: 8,
      maxBytes: 32 * 1024,
      nearLimitRatio: 0.75,
    });

    await spool.enqueue(createFixture({
      event_id: "event_corrupt",
      payload: { marker: "secret-corrupt" },
    }));
    const [recordName] = (await readdir(paths.spoolDir)).filter((name) => name.endsWith(".json"));
    const recordPath = join(paths.spoolDir, recordName);
    await writeFile(recordPath, "{not-json", { mode: 0o600 });

    assert.deepEqual(await spool.deliverPending(), []);
    assert.ok((await readdir(paths.spoolDir)).includes(recordName));

    const stats = await spool.stats();
    assert.equal(stats.corruptCount, 1);
    assert.equal(stats.pendingCount, 0);
  });
});
