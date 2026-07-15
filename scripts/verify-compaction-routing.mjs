#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const fixtureDir = join(here, "..", "test", "fixtures", "compaction");

export function topLevelEnvelopeSignature(capture) {
  const request = capture?.request;
  if (!request) return null;
  return JSON.stringify({
    method: request.method,
    path: request.path,
    stream: request.stream,
    topLevelKeys: [...(request.topLevelKeys ?? [])].sort(),
  });
}

export function evaluateCompactionCaptures({ automatic, manual, ordinary }) {
  const automaticObserved = automatic?.observed === true && topLevelEnvelopeSignature(automatic) !== null;
  const manualObserved = topLevelEnvelopeSignature(manual) !== null;
  const ordinarySignature = topLevelEnvelopeSignature(ordinary);
  const manualSignature = topLevelEnvelopeSignature(manual);
  const automaticSignature = topLevelEnvelopeSignature(automatic);
  const stableTopLevelEnvelopeDiscriminator = Boolean(
    automaticObserved
      && manualObserved
      && automaticSignature === manualSignature
      && manualSignature !== ordinarySignature,
  );

  return {
    automaticObserved,
    decision: stableTopLevelEnvelopeDiscriminator ? "eligible-for-explicit-policy-review" : "keep-active-route",
    manualObserved,
    reason: !automaticObserved
      ? "automatic_request_not_observed"
      : stableTopLevelEnvelopeDiscriminator
        ? "shared_compaction_top_level_envelope"
        : "no_unique_top_level_envelope",
    stableTopLevelEnvelopeDiscriminator,
  };
}

async function main() {
  const [ordinary, manual, automatic] = await Promise.all([
    loadFixture("ordinary-2.1.210.json"),
    loadFixture("manual-2.1.210.json"),
    loadFixture("automatic-2.1.210.json"),
  ]);
  process.stdout.write(`${JSON.stringify(evaluateCompactionCaptures({ automatic, manual, ordinary }), null, 2)}\n`);
}

async function loadFixture(name) {
  return JSON.parse(await readFile(join(fixtureDir, name), "utf8"));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
