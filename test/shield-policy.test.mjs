import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { shieldPaths } from "../src/shield/paths.mjs";
import { createShieldPolicyActivation, loadShieldPolicy } from "../src/shield/policy.mjs";

const wasm = Buffer.from("compiled-opa-policy-fixture");
const compiledWasm = await readFile(new URL("./fixtures/shield-policy.wasm", import.meta.url));
const keyPair = generateKeyPairSync("ed25519");

test("policy activation only accepts a signed, digest-matched OPA/Wasm bundle", async () => {
  const bundle = signedBundle();
  const policy = await loadTestPolicy({ bundle });

  assert.equal(policy.version, "2026.09.02.1");
  assert.deepEqual(policy.detectorVersions, { gitleaks: "8.24.0" });
  assert.deepEqual(await policy.evaluate({ lane: "subscription" }), allowDecision);
  assert.equal(Object.isFrozen(policy), true);
  assert.equal(Object.isFrozen(policy.detectorVersions), true);
});

test("policy activation rejects unsigned and digest-drifted bundles", async () => {
  await assert.rejects(
    loadTestPolicy({ bundle: { ...signedBundle(), signature: undefined } }),
    /signature/i,
  );
  await assert.rejects(
    loadTestPolicy({ bundle: { ...signedBundle(), wasm: Buffer.from("drift") } }),
    /digest/i,
  );
  await assert.rejects(
    loadTestPolicy({ bundle: { ...signedBundle(), signature: Buffer.alloc(64).toString("base64") } }),
    /signature/i,
  );
});

test("policy activation rejects an unsupported OPA ABI and missing self-test", async () => {
  await assert.rejects(
    loadTestPolicy({ bundle: signedBundle({ opaAbi: "999" }) }),
    /ABI/i,
  );
  await assert.rejects(
    loadTestPolicy({ bundle: signedBundle({ selfTest: undefined }) }),
    /self-test/i,
  );
  await assert.rejects(
    loadTestPolicy({ bundle: signedBundle({ opaWasmSdkVersion: "0.0.0" }) }),
    /runtime version/i,
  );
});

test("policy evaluator rejects unsupported actions and failing self-tests", async () => {
  await assert.rejects(
    loadTestPolicy({ opa: fakeOpa({ ...allowDecision, action: "allow_all" }) }),
    /action/i,
  );
  await assert.rejects(
    loadTestPolicy({ opa: fakeOpa({ ...allowDecision, action: "block", reasonCodes: ["fixture"] }) }),
    /self-test/i,
  );
});

test("a failed replacement activation clears a prior allow evaluator", async () => {
  const activation = createShieldPolicyActivation();
  await activation.activate({ bundle: signedBundle(), publicKey: keyPair.publicKey, opa: allowOpa });
  assert.notEqual(activation.current(), null);
  await assert.rejects(
    activation.activate({ bundle: { ...signedBundle(), wasm: Buffer.from("drift") }, publicKey: keyPair.publicKey, opa: allowOpa }),
    /digest/i,
  );
  assert.equal(activation.current(), null);
});

test("policy trust root is injected independently and must be an Ed25519 public key", async () => {
  await assert.rejects(
    loadShieldPolicy({ bundle: { ...signedBundle(), trustedPublicKeys: { attacker: keyPair.publicKey } }, opa: allowOpa }),
    /public key/i,
  );
  await assert.rejects(
    loadTestPolicy({ publicKey: generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey }),
    /Ed25519/i,
  );
  await assert.rejects(
    loadTestPolicy({ publicKey: keyPair.privateKey }),
    /public key/i,
  );
});

test("default OPA SDK evaluates an OPA-compiled Wasm fixture", async () => {
  const policy = await loadShieldPolicy({
    bundle: signedBundle({}, compiledWasm),
    publicKey: keyPair.publicKey,
  });
  assert.deepEqual(await policy.evaluate({ lane: "subscription" }), allowDecision);
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

function signedBundle(overrides = {}, artifact = wasm) {
  const manifest = {
    formatVersion: 1,
    version: "2026.09.02.1",
    opaAbi: "1",
    opaWasmSdkVersion: "1.8.0",
    wasmSha256: createHash("sha256").update(artifact).digest("hex"),
    detectorVersions: { gitleaks: "8.24.0" },
    selfTest: { input: { lane: "self-test" }, expected: allowDecision },
    ...overrides,
  };
  const signature = sign(null, Buffer.from(canonicalJson(manifest)), keyPair.privateKey).toString("base64");
  return {
    manifest,
    wasm: artifact,
    signature,
  };
}

async function loadTestPolicy({ bundle = signedBundle(), publicKey = keyPair.publicKey, opa = allowOpa } = {}) {
  return loadShieldPolicy({ bundle, publicKey, opa });
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
