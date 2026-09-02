import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { shieldPaths } from "../src/shield/paths.mjs";
import { createShieldPolicyActivation, loadShieldPolicy } from "../src/shield/policy.mjs";

const wasm = Buffer.from("compiled-opa-policy-fixture");
const keyPair = generateKeyPairSync("ed25519");

test("policy activation only accepts a signed, digest-matched OPA/Wasm bundle", async () => {
  const bundle = signedBundle();
  const policy = await loadShieldPolicy({ bundle, opa: allowOpa });

  assert.equal(policy.version, "2026.09.02.1");
  assert.deepEqual(policy.detectorVersions, { gitleaks: "8.24.0" });
  assert.deepEqual(await policy.evaluate({ lane: "subscription" }), allowDecision);
  assert.equal(Object.isFrozen(policy), true);
  assert.equal(Object.isFrozen(policy.detectorVersions), true);
});

test("policy activation rejects unsigned and digest-drifted bundles", async () => {
  await assert.rejects(
    loadShieldPolicy({ bundle: { ...signedBundle(), signature: undefined }, opa: allowOpa }),
    /signature/i,
  );
  await assert.rejects(
    loadShieldPolicy({ bundle: { ...signedBundle(), wasm: Buffer.from("drift") }, opa: allowOpa }),
    /digest/i,
  );
  await assert.rejects(
    loadShieldPolicy({ bundle: { ...signedBundle(), signature: Buffer.alloc(64).toString("base64") }, opa: allowOpa }),
    /signature/i,
  );
});

test("policy activation rejects an unsupported OPA ABI and missing self-test", async () => {
  await assert.rejects(
    loadShieldPolicy({ bundle: signedBundle({ opaAbi: "999" }), opa: allowOpa }),
    /ABI/i,
  );
  await assert.rejects(
    loadShieldPolicy({ bundle: signedBundle({ selfTest: undefined }), opa: allowOpa }),
    /self-test/i,
  );
  await assert.rejects(
    loadShieldPolicy({ bundle: signedBundle({ opaWasmSdkVersion: "0.0.0" }), opa: allowOpa }),
    /runtime version/i,
  );
});

test("policy evaluator rejects unsupported actions and failing self-tests", async () => {
  await assert.rejects(
    loadShieldPolicy({ bundle: signedBundle(), opa: fakeOpa({ ...allowDecision, action: "allow_all" }) }),
    /action/i,
  );
  await assert.rejects(
    loadShieldPolicy({ bundle: signedBundle(), opa: fakeOpa({ ...allowDecision, action: "block", reasonCodes: ["fixture"] }) }),
    /self-test/i,
  );
});

test("a failed replacement activation clears a prior allow evaluator", async () => {
  const activation = createShieldPolicyActivation();
  await activation.activate({ bundle: signedBundle(), opa: allowOpa });
  assert.notEqual(activation.current(), null);
  await assert.rejects(
    activation.activate({ bundle: { ...signedBundle(), wasm: Buffer.from("drift") }, opa: allowOpa }),
    /digest/i,
  );
  assert.equal(activation.current(), null);
});

test("policy state exposes only version and detector versions", async () => {
  const homeDir = await mkdtemp(join(tmpdir(), "airkit-policy-state-"));
  const paths = shieldPaths({ homeDir, uid: process.getuid?.() });
  try {
    const { readShieldPolicyState, writeShieldPolicyState } = await import("../src/shield/paths.mjs");
    await writeShieldPolicyState({
      paths,
      state: { version: "2026.09.02.1", detectorVersions: { gitleaks: "8.24.0" } },
    });
    assert.deepEqual(await readShieldPolicyState({ paths }), {
      version: "2026.09.02.1",
      detectorVersions: { gitleaks: "8.24.0" },
    });
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
});

const allowDecision = {
  action: "allow",
  reasonCodes: [],
  approvalEligible: false,
  redactions: [],
};

const allowOpa = fakeOpa(allowDecision);

function fakeOpa(result) {
  return {
    async loadPolicy(receivedWasm) {
      assert.deepEqual(Buffer.from(receivedWasm), wasm);
      return { evaluate: () => [{ result }] };
    },
  };
}

function signedBundle(overrides = {}) {
  const manifest = {
    formatVersion: 1,
    version: "2026.09.02.1",
    opaAbi: "1",
    opaWasmSdkVersion: "1.8.0",
    wasmSha256: createHash("sha256").update(wasm).digest("hex"),
    detectorVersions: { gitleaks: "8.24.0" },
    selfTest: { input: { lane: "self-test" }, expected: allowDecision },
    ...overrides,
  };
  const signature = sign(null, Buffer.from(canonicalJson(manifest)), keyPair.privateKey).toString("base64");
  return {
    manifest,
    wasm,
    signature,
    trustedPublicKeys: { "shield-test-key": keyPair.publicKey.export({ format: "pem", type: "spki" }) },
    signingKeyId: "shield-test-key",
  };
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
