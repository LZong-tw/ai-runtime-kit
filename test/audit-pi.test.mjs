import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { PI_AUDIT_EVENT_TYPES, buildPiAuditContract } from "../scripts/capture-pi-audit-contract.mjs";

test("Pi audit contract freezes the observed lifecycle events without secrets or local paths", async () => {
  const fixture = buildPiAuditContract("0.84.1", { capturedAt: "2026-08-17T00:00:00.000Z" });
  assert.deepEqual(fixture.events.map(({ type }) => type), PI_AUDIT_EVENT_TYPES);
  assert.match(fixture.piVersion, /^\d+\.\d+\.\d+/);
  assert.equal(fixture.contractVersion, 1);
  assert.doesNotMatch(JSON.stringify(fixture), /Bearer |sk-|\/Users\//i);
  assert.deepEqual(fixture.events.find(({ type }) => type === "before_agent_start").fields, ["prompt_bytes", "session_id"]);
});

test("the committed Pi fixture remains credential- and path-redacted", async () => {
  const fixture = JSON.parse(await readFile(new URL("./fixtures/audit/pi/current.json", import.meta.url), "utf8"));
  assert.deepEqual(fixture.events.map(({ type }) => type), PI_AUDIT_EVENT_TYPES);
  assert.match(fixture.piVersion, /^\d+\.\d+\.\d+/);
  assert.doesNotMatch(JSON.stringify(fixture), /Bearer |sk-|\/Users\//i);
});
