import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";

import {
  evaluateCompactionCaptures,
  topLevelEnvelopeSignature,
} from "../scripts/verify-compaction-routing.mjs";

const fixtureDir = join(import.meta.dirname, "fixtures", "compaction");

test("manual compact shares the top-level envelope of a long tool-enabled ordinary request", async () => {
  const ordinary = await fixture("ordinary-2.1.210.json");
  const manual = await fixture("manual-2.1.210.json");

  assert.equal(ordinary.scenario.kind, "long-context-tool-enabled");
  assert.equal(ordinary.scenario.promptCharacters, 40_000);
  assert.equal(ordinary.scenario.toolCount, 3);
  assert.equal(topLevelEnvelopeSignature(manual), topLevelEnvelopeSignature(ordinary));
  assert.match(manual.textObservation, /Prompt text is not a protocol discriminator/);
});

test("unobserved automatic compact fails closed and keeps the active route", async () => {
  const result = evaluateCompactionCaptures({
    automatic: await fixture("automatic-2.1.210.json"),
    manual: await fixture("manual-2.1.210.json"),
    ordinary: await fixture("ordinary-2.1.210.json"),
  });

  assert.deepEqual(result, {
    automaticObserved: false,
    decision: "keep-active-route",
    manualObserved: true,
    reason: "automatic_request_not_observed",
    stableTopLevelEnvelopeDiscriminator: false,
  });
});

async function fixture(name) {
  return JSON.parse(await readFile(join(fixtureDir, name), "utf8"));
}
