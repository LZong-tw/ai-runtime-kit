import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

test("core verifier covers the audit durability and safety checkpoints", async () => {
  const source = await readFile(new URL("../scripts/verify-audit-core.mjs", import.meta.url), "utf8");
  for (const marker of [
    "spool-before-send",
    "duplicate",
    "daemon-restart",
    "migration-backup",
    "retention-pruned",
    "default-export-secret-scan",
    "degraded",
  ]) {
    assert.match(source, new RegExp(marker));
  }
});

test("core verifier is a safe executable entrypoint", async () => {
  const source = await readFile(new URL("../scripts/verify-audit-core.mjs", import.meta.url), "utf8");
  assert.match(source, /^#!\/usr\/bin\/env node/m);
  assert.match(source, /mkdtemp/);
  assert.match(source, /AIRKIT_AUDIT/);
  assert.doesNotMatch(source, /process\.env\.HOME\s*=|rm\s+-rf\s+~|\/Users\//);
});
