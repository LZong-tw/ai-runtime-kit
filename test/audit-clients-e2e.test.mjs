import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { verifyAuditClients } from "../scripts/verify-audit-clients.mjs";
import { openAuditStore } from "../src/audit/store.mjs";

test("fixture client matrix verifies mutations, completeness, and secret-free output", async () => {
  const result = await verifyAuditClients({ mode: "fixture" });
  assert.equal(result.mode, "fixture");
  assert.equal(result.clients.find(({ client }) => client === "codex-desktop").completeness, "metadata_only");
  assert.deepEqual(result.checks, ["repo-classification", "account-group", "completeness", "secret-scan"]);
});

test("live verification is opt-in and never silently probes a client", async () => {
  const result = await verifyAuditClients({ mode: "live", client: "airclaude" });
  assert.equal(result.measured, false);
  await assert.rejects(() => verifyAuditClients({ mode: "live" }), /--live requires/);
});

test("SQLite registry mutations update only their classified metadata", () => {
  const root = mkdtemp;
  return root(join(tmpdir(), "airkit-audit-clients-")).then(async (directory) => {
    const databasePath = join(directory, "audit.sqlite");
    const backupDir = join(directory, "backups");
    const encryptedPath = JSON.stringify({ v: 1, k: "key", n: "nonce", c: "cipher", t: "tag" });
    const seeded = new DatabaseSync(databasePath);
    const store = openAuditStore({ databasePath, backupDir });
    try {
      seeded.prepare(`INSERT INTO repositories (
        repository_id, root_encrypted_path, remote_encrypted_path, first_observed_at, last_observed_at, id
      ) VALUES (?, ?, ?, ?, ?, ?)`).run("repo-1", encryptedPath, null, "2026-08-17T00:00:00.000Z", "2026-08-17T00:00:00.000Z", "repo-public");
      seeded.prepare(`INSERT INTO provider_accounts (
        provider_account_id, provider, account_hash, first_observed_at, last_observed_at, id
      ) VALUES (?, ?, ?, ?, ?, ?)`).run("acct-1", "oneportal", "hash-only", "2026-08-17T00:00:00.000Z", "2026-08-17T00:00:00.000Z", "acct-public");
      assert.deepEqual(store.classifyRepository("repo-public", "personal"), { changes: 1 });
      assert.deepEqual(store.groupProviderAccount("acct-public", "personal-main"), { changes: 1 });
      assert.equal(store.query("SELECT classification FROM repositories WHERE repository_id = ?", ["repo-1"])[0].classification, "personal");
      assert.equal(store.query("SELECT logical_group FROM provider_accounts WHERE provider_account_id = ?", ["acct-1"])[0].logical_group, "personal-main");
    } finally {
      store.close();
      seeded.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
