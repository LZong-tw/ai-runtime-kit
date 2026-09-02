import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { provisionShieldAssets } from "../src/shield/provision.mjs";
import { readShieldAssetsProvision, shieldPaths } from "../src/shield/paths.mjs";

const policyPath = "/opt/airkit/policy.json";
const gitleaksPath = "/opt/airkit/gitleaks";
const privacyPath = "/opt/airkit/privacy-filter.json";
const workerPath = "/opt/airkit/privacy-worker";
const bytes = {
  [policyPath]: Buffer.from(JSON.stringify({ manifest: { version: "policy-1" } })),
  [gitleaksPath]: Buffer.from("gitleaks fixture"),
  [privacyPath]: Buffer.from(JSON.stringify({
    formatVersion: 1,
    protocol: "airkit-privacy-ndjson-v1",
    version: "privacy-1",
    worker: { command: workerPath, args: ["--stdio"], sha256: sha256(Buffer.from("privacy worker fixture")) },
  })),
  [workerPath]: Buffer.from("privacy worker fixture"),
};

test("asset provision previews without writes and only records opaque references after explicit write", async () => {
  const writes = [];
  const preview = await provisionShieldAssets({
    bundlePath: policyPath,
    gitleaksPath,
    privacyBundlePath: privacyPath,
    io: fixtureIo(),
    runPrivacySelfTest: async () => ({ version: "privacy-1" }),
    writeState: async (value) => writes.push(value),
  });

  assert.equal(writes.length, 0);
  assert.deepEqual(preview, {
    version: 1,
    bundle: { version: "policy-1", sha256: sha256(bytes[policyPath]), path: policyPath },
    gitleaks: { sha256: sha256(bytes[gitleaksPath]), path: gitleaksPath },
    privacy: {
      version: "privacy-1",
      sha256: sha256(bytes[privacyPath]),
      path: privacyPath,
      worker: { command: workerPath, args: ["--stdio"], sha256: sha256(bytes[workerPath]) },
    },
  });

  const written = await provisionShieldAssets({
    bundlePath: policyPath,
    gitleaksPath,
    privacyBundlePath: privacyPath,
    write: true,
    io: fixtureIo(),
    runPrivacySelfTest: async () => ({ version: "privacy-1" }),
    writeState: async (value) => writes.push(value),
  });
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0], written);
  assert.doesNotMatch(JSON.stringify(writes), /fixture|PRIVATE|secret/i);
});

test("asset provision rejects unsafe, drifted, or protocol-invalid preinstalled artifacts without a download path", async () => {
  const options = {
    bundlePath: policyPath,
    gitleaksPath,
    privacyBundlePath: privacyPath,
    runPrivacySelfTest: async () => ({ version: "privacy-1" }),
  };
  await assert.rejects(provisionShieldAssets({ ...options, bundlePath: "relative", io: fixtureIo() }), /canonical and absolute/i);
  await assert.rejects(provisionShieldAssets({ ...options, io: fixtureIo({ symlink: privacyPath }) }), /symlink/i);
  await assert.rejects(provisionShieldAssets({ ...options, io: fixtureIo({ owner: 999 }) }), /owner/i);
  await assert.rejects(provisionShieldAssets({ ...options, io: fixtureIo({ executable: false }) }), /executable/i);
  await assert.rejects(provisionShieldAssets({ ...options, io: fixtureIo({ mutate: workerPath }) }), /digest mismatch/i);
  await assert.rejects(provisionShieldAssets({ ...options, io: fixtureIo(), runPrivacySelfTest: async () => ({ version: "wrong-version" }) }), /self-test/i);
});

test("explicit write stores a private canonical asset provision record", async () => {
  const homeDir = await mkdtemp(join(tmpdir(), "airkit-shield-provision-"));
  const paths = shieldPaths({ homeDir, uid: process.getuid?.() });
  try {
    const written = await provisionShieldAssets({
      bundlePath: policyPath,
      gitleaksPath,
      privacyBundlePath: privacyPath,
      write: true,
      paths,
      io: fixtureIo(),
      runPrivacySelfTest: async () => ({ version: "privacy-1" }),
    });
    assert.equal((await stat(paths.assetsProvisionPath)).mode & 0o777, 0o600);
    assert.deepEqual(await readShieldAssetsProvision({ paths }), written);
    assert.deepEqual(JSON.parse(await readFile(paths.assetsProvisionPath, "utf8")), written);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
});

function fixtureIo({ symlink = null, owner = process.getuid?.(), executable = true, mutate = null } = {}) {
  return {
    async lstat(path) {
      return {
        uid: owner,
        mode: path === gitleaksPath || path === workerPath ? (executable ? 0o100700 : 0o100600) : 0o100600,
        isFile: () => true,
        isSymbolicLink: () => path === symlink,
      };
    },
    async realpath(path) { return path; },
    async readFile(path) { return path === mutate ? Buffer.from("drift") : bytes[path]; },
  };
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
