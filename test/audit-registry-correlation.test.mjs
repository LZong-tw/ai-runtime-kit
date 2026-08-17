import assert from "node:assert/strict";
import test from "node:test";

import { buildCacheCohorts, correlateObservations } from "../src/audit/correlation.mjs";
import { resolveProviderAccountIdentity, resolveRepositoryIdentity } from "../src/audit/registry.mjs";

const KEY = Buffer.alloc(32, 7);

test("repository and provider account identities are domain-separated and redact remote credentials", () => {
  const repository = resolveRepositoryIdentity({ root: "/Users/test/project", remote: "https://token:secret@git.example.com/team/repo.git?private=1" }, KEY);
  assert.equal(repository.canonicalRemote, "https://git.example.com/team/repo.git");
  assert.doesNotMatch(JSON.stringify(repository), /token|secret|private/);
  const onePortal = resolveProviderAccountIdentity({ provider: "oneportal", accountRef: "acct-main", endpoint: "https://oneportal.example/v1", credentialKind: "oauth" }, KEY);
  const webLiteLlm = resolveProviderAccountIdentity({ provider: "web_litellm", accountRef: "acct-main", endpoint: "https://litellm.example/v1", credentialKind: "oauth" }, KEY);
  assert.notEqual(onePortal.providerAccountId, webLiteLlm.providerAccountId);
  assert.notEqual(onePortal.accountHmac, webLiteLlm.accountHmac);
});

test("correlation keeps bounded-time candidates and conflicts out of exact request ids", () => {
  const rows = correlateObservations([
    { request_id: "req-1", provider: "oneportal", model: "gpt-5.6-terra", body_hash: "same", observed_at: "2026-08-17T00:00:00.000Z" },
    { provider: "oneportal", model: "gpt-5.6-terra", body_hash: "same", observed_at: "2026-08-17T00:00:00.010Z" },
    { request_id: "req-2", provider: "oneportal", model: "gpt-5.6-terra", body_hash: "conflict", observed_at: "2026-08-17T00:00:00.020Z" },
    { request_id: "req-3", provider: "web_litellm", model: "gpt-5.6-terra", body_hash: "conflict", observed_at: "2026-08-17T00:00:00.021Z" },
    { provider: "oneportal", model: "gpt-5.6-terra", observed_at: "2026-08-17T00:00:00.030Z" },
  ]);
  assert.equal(rows[0].correlation, "exact");
  assert.equal(rows[1].correlation, "body_hash");
  assert.equal(rows[1].request_id, "req-1");
  assert.equal(rows[2].correlation, "conflict");
  assert.equal(rows[2].request_id, null);
  assert.equal(rows[4].correlation, "bounded_time_candidate");
  assert.equal(rows[4].request_id, null);
});

test("cache cohorts partition by provider account and actual model", () => {
  const rows = buildCacheCohorts([
    { provider: "oneportal", provider_account_id: "acct-1", model: "gpt-5.6-terra" },
    { provider: "oneportal", provider_account_id: "acct-1", model: "gpt-5.6-terra" },
    { provider: "oneportal", provider_account_id: "acct-2", model: "gpt-5.6-terra" },
    { provider: "oneportal", provider_account_id: "acct-1", model: "gpt-5.6-luna" },
  ]);
  assert.deepEqual(rows.map((row) => row.cohort), ["cold", "warm", "cold", "cold"]);
});
