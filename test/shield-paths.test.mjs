import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, symlink } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import {
  assertShieldIdentity,
  readShieldIdentity,
  shieldPaths,
  writeShieldIdentity,
} from "../src/shield/paths.mjs";

const capability = "c".repeat(32);
const identity = {
  origin: "http://127.0.0.1:8811",
  capability,
  version: 1,
  pid: 42,
  targetClass: "loopback",
};

test("Shield identity is private and loopback-only", () => {
  const paths = shieldPaths({ homeDir: "/tmp/home", uid: 501 });
  assert.equal(paths.rootDir, "/tmp/home/.local/state/airkit-shield");
  assert.equal(paths.launchdTarget, "gui/501/com.airkit.shield");
  assert.throws(() => assertShieldIdentity({ origin: "https://proxy.example" }), /loopback/);
});

test("shield paths reject relative and escaping overrides", () => {
  assert.throws(() => shieldPaths({ homeDir: "/tmp/home", rootDir: "relative" }), /absolute/);
  assert.throws(() => shieldPaths({ homeDir: "/tmp/home", rootDir: "/tmp/other-state" }), /canonical/);
  assert.throws(() => shieldPaths({ homeDir: "/tmp/home", configPath: "/tmp/config.json" }), /under rootDir/);
});

test("identity rejects missing capability", async () => {
  const paths = shieldPaths({ homeDir: "/tmp/home", uid: 501 });
  const io = { async readFile() { return '{"origin":"http://127.0.0.1:8811"}'; } };
  await assert.rejects(readShieldIdentity({ paths, io }), /capability/);
});

test("missing identity is reported as null", async () => {
  const paths = shieldPaths({ homeDir: "/tmp/home", uid: 501 });
  const io = { async readFile() { const error = new Error("missing"); error.code = "ENOENT"; throw error; } };
  assert.equal(await readShieldIdentity({ paths, io }), null);
});

test("identity writes use a private directory and atomic 0600 replacement", async () => {
  const homeDir = await mkdtemp("/tmp/airkit-shield-");
  const paths = shieldPaths({ homeDir, uid: 501 });
  try {
    await writeShieldIdentity({ paths, identity });
    assert.equal((await stat(paths.rootDir)).mode & 0o777, 0o700);
    assert.equal((await stat(paths.identityPath)).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(await readFile(paths.identityPath, "utf8")), identity);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("identity writes reject a pre-existing symlink state root", async () => {
  const homeDir = await mkdtemp("/tmp/airkit-shield-");
  const targetDir = await mkdtemp("/tmp/airkit-shield-target-");
  const paths = shieldPaths({ homeDir, uid: 501 });
  try {
    await mkdir(join(paths.rootDir, ".."), { recursive: true });
    await symlink(targetDir, paths.rootDir);
    await assert.rejects(writeShieldIdentity({ paths, identity }), /symlink/);
    assert.equal((await stat(targetDir)).mode & 0o777, 0o700);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
    await rm(targetDir, { recursive: true, force: true });
  }
});
