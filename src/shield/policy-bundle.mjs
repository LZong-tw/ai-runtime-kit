import { createHash, verify } from "node:crypto";

export const SHIELD_POLICY_FORMAT_VERSION = 1;
export const SHIELD_OPA_WASM_SDK_VERSION = "1.8.0";
export const SUPPORTED_OPA_ABIS = new Set(["1"]);

export function validateShieldPolicyBundle(bundle) {
  if (!bundle || typeof bundle !== "object" || Array.isArray(bundle)) throw new TypeError("shield policy bundle is required");
  const manifest = parseManifest(bundle.manifest);
  const wasm = assertWasm(bundle.wasm);
  const signingKeyId = assertSafeIdentifier(bundle.signingKeyId, "shield policy signing key id");
  const trustedKey = bundle.trustedPublicKeys?.[signingKeyId];
  if (typeof trustedKey !== "string" || trustedKey.length === 0) throw new Error("shield policy signing key is not trusted");
  const signature = decodeSignature(bundle.signature);

  assertManifest(manifest);
  if (!verify(null, Buffer.from(canonicalJson(manifest)), trustedKey, signature)) {
    throw new Error("shield policy manifest signature is invalid");
  }
  const actualDigest = createHash("sha256").update(wasm).digest("hex");
  if (actualDigest !== manifest.wasmSha256) throw new Error("shield policy Wasm digest mismatch");

  return Object.freeze({ manifest: freezeManifest(manifest), wasm });
}

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function parseManifest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("shield policy manifest is malformed");
  return value;
}

function assertManifest(manifest) {
  assertExactKeys(manifest, ["formatVersion", "version", "opaAbi", "opaWasmSdkVersion", "wasmSha256", "detectorVersions", "selfTest"], "shield policy manifest");
  if (manifest.formatVersion !== SHIELD_POLICY_FORMAT_VERSION) throw new Error("shield policy manifest format is unsupported");
  assertSafeIdentifier(manifest.version, "shield policy version");
  if (typeof manifest.opaAbi !== "string" || !SUPPORTED_OPA_ABIS.has(manifest.opaAbi)) throw new Error("shield policy OPA ABI is unsupported");
  if (manifest.opaWasmSdkVersion !== SHIELD_OPA_WASM_SDK_VERSION) throw new Error("shield policy OPA/Wasm runtime version is unsupported");
  if (typeof manifest.wasmSha256 !== "string" || !/^[a-f0-9]{64}$/.test(manifest.wasmSha256)) throw new Error("shield policy Wasm digest is invalid");
  assertDetectorVersions(manifest.detectorVersions);
  assertSelfTest(manifest.selfTest);
}

function assertSelfTest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("shield policy self-test is required");
  assertExactKeys(value, ["input", "expected"], "shield policy self-test");
  if (!value.input || typeof value.input !== "object" || Array.isArray(value.input)) throw new Error("shield policy self-test input is invalid");
  if (!value.expected || typeof value.expected !== "object" || Array.isArray(value.expected)) throw new Error("shield policy self-test expected decision is invalid");
}

function assertDetectorVersions(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("shield policy detector versions are required");
  for (const [name, version] of Object.entries(value)) {
    assertSafeIdentifier(name, "shield policy detector name");
    assertSafeIdentifier(version, "shield policy detector version");
  }
}

function assertWasm(value) {
  if (!(value instanceof Uint8Array) || value.byteLength === 0) throw new Error("shield policy compiled Wasm artifact is required");
  return Buffer.from(value);
}

function decodeSignature(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0) throw new Error("shield policy manifest signature is required");
  const signature = Buffer.from(value, "base64");
  if (signature.length === 0) throw new Error("shield policy manifest signature is required");
  return signature;
}

function assertSafeIdentifier(value, label) {
  if (typeof value !== "string" || !/^[A-Za-z0-9._-]{1,128}$/.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function assertExactKeys(value, expected, label) {
  const actual = Object.keys(value).sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== [...expected].sort()[index])) {
    throw new Error(`${label} contains unsupported fields`);
  }
}

function freezeManifest(manifest) {
  return Object.freeze({
    formatVersion: manifest.formatVersion,
    version: manifest.version,
    opaAbi: manifest.opaAbi,
    opaWasmSdkVersion: manifest.opaWasmSdkVersion,
    wasmSha256: manifest.wasmSha256,
    detectorVersions: Object.freeze({ ...manifest.detectorVersions }),
    selfTest: Object.freeze({ input: Object.freeze({ ...manifest.selfTest.input }), expected: Object.freeze({ ...manifest.selfTest.expected }) }),
  });
}
