import { loadPolicy as loadOpaPolicy } from "@open-policy-agent/opa-wasm";

import { validateShieldPolicyBundle } from "./policy-bundle.mjs";

const ALLOWED_ACTIONS = new Set(["allow", "block", "require_approval", "redact"]);
const DECISION_FIELDS = ["action", "approvalEligible", "reasonCodes", "redactions"];

export async function loadShieldPolicy({ bundle, opa = { loadPolicy: loadOpaPolicy } } = {}) {
  const validated = validateShieldPolicyBundle(bundle);
  if (typeof opa?.loadPolicy !== "function") throw new TypeError("shield policy requires an OPA/Wasm evaluator");
  const evaluator = await opa.loadPolicy(validated.wasm);
  if (!evaluator || typeof evaluator.evaluate !== "function") throw new Error("shield policy OPA/Wasm evaluator is invalid");

  const evaluate = async (input) => evaluateShieldDecision(evaluator, input);
  const expected = assertShieldDecision(validated.manifest.selfTest.expected);
  const actual = await evaluate(validated.manifest.selfTest.input);
  if (!sameDecision(actual, expected)) throw new Error("shield policy self-test failed");

  return Object.freeze({
    version: validated.manifest.version,
    detectorVersions: Object.freeze({ ...validated.manifest.detectorVersions }),
    evaluate,
  });
}

export function createShieldPolicyActivation({ load = loadShieldPolicy } = {}) {
  if (typeof load !== "function") throw new TypeError("shield policy activation requires a policy loader");
  let active = null;
  return Object.freeze({
    async activate(options) {
      active = null;
      active = await load(options);
      return active;
    },
    current() {
      return active;
    },
  });
}

export function assertShieldDecision(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("shield policy decision is invalid");
  const keys = Object.keys(value).sort();
  if (keys.length !== DECISION_FIELDS.length || keys.some((key, index) => key !== DECISION_FIELDS[index])) {
    throw new Error("shield policy decision contains unsupported fields");
  }
  if (!ALLOWED_ACTIONS.has(value.action)) throw new Error("shield policy decision action is unsupported");
  if (!Array.isArray(value.reasonCodes) || value.reasonCodes.some((code) => typeof code !== "string" || !/^[A-Za-z0-9._-]{1,128}$/.test(code))) {
    throw new Error("shield policy decision reason codes are invalid");
  }
  if (typeof value.approvalEligible !== "boolean") throw new Error("shield policy decision approval eligibility is invalid");
  if (!Array.isArray(value.redactions) || value.redactions.some((redaction) => !isSafeRedaction(redaction))) {
    throw new Error("shield policy decision redactions are invalid");
  }
  if (value.action !== "redact" && value.redactions.length !== 0) throw new Error("shield policy decision redactions require redact action");
  if (value.action === "require_approval" ? !value.approvalEligible : value.approvalEligible) {
    throw new Error("shield policy decision approval eligibility conflicts with action");
  }
  return freezeDecision(value);
}

async function evaluateShieldDecision(evaluator, input) {
  let results;
  try {
    results = await evaluator.evaluate(input);
  } catch {
    throw new Error("shield policy evaluation failed");
  }
  if (!Array.isArray(results) || results.length !== 1 || !results[0] || !Object.hasOwn(results[0], "result")) {
    throw new Error("shield policy evaluation returned an invalid result set");
  }
  return assertShieldDecision(results[0].result);
}

function isSafeRedaction(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  if (keys.length !== 3 || keys[0] !== "category" || keys[1] !== "end" || keys[2] !== "start") return false;
  return typeof value.category === "string" && /^[A-Za-z0-9._-]{1,128}$/.test(value.category)
    && Number.isInteger(value.start) && value.start >= 0
    && Number.isInteger(value.end) && value.end >= value.start;
}

function freezeDecision(value) {
  return Object.freeze({
    action: value.action,
    reasonCodes: Object.freeze([...value.reasonCodes]),
    approvalEligible: value.approvalEligible,
    redactions: Object.freeze(value.redactions.map((redaction) => Object.freeze({ ...redaction }))),
  });
}

function sameDecision(actual, expected) {
  return JSON.stringify(actual) === JSON.stringify(expected);
}
