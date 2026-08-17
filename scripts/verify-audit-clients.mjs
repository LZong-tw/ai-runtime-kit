#!/usr/bin/env node

import assert from "node:assert/strict";
import { runAuditCli } from "../src/audit/cli.mjs";

const CLIENTS = Object.freeze(["airclaude", "airpi", "airoc", "codex-desktop", "opencode", "headroom"]);

export async function verifyAuditClients({ mode = "fixture", client } = {}) {
  if (mode === "live") {
    if (!client || !CLIENTS.includes(client)) {
      throw new Error(`--live requires one supported client: ${CLIENTS.join(", ")}`);
    }
    return {
      mode,
      client,
      measured: false,
      completeness: "not_run",
      reason: "live probes require explicit client authorization and are never run by npm test",
    };
  }
  if (mode !== "fixture") throw new Error(`unknown audit client verification mode: ${mode}`);

  const clientRows = [
    { client: "airclaude", event_count: 4, completeness: "complete" },
    { client: "codex-desktop", event_count: 2, completeness: "metadata_only" },
    { client: "opencode", event_count: 3, completeness: "partial" },
  ];
  const calls = [];
  const audit = {
    async query(name, args) {
      calls.push(["query", name, args]);
      return { state: "healthy", name, rows: name === "clients" ? clientRows : [] };
    },
    async repo(options) {
      calls.push(["repo", options]);
      return { state: options.write ? "healthy" : "stopped", ...options };
    },
    async account(options) {
      calls.push(["account", options]);
      return { state: options.write ? "healthy" : "stopped", ...options };
    },
  };
  let output = "";
  const stdout = { write(chunk) { output += String(chunk); } };
  assert.equal(await runAuditCli(["repo", "classify", "repo-1", "personal", "--write"], { audit, stdout }), 0);
  assert.equal(await runAuditCli(["account", "group", "acct-1", "personal-main", "--write"], { audit, stdout }), 0);
  assert.equal(await runAuditCli(["clients"], { audit, stdout }), 0);
  const codex = clientRows.find(({ client: name }) => name === "codex-desktop");
  assert.equal(codex.completeness, "metadata_only");
  assert.match(output, /codex-desktop/);
  assert.doesNotMatch(output, /api[_-]?key|authorization|bearer|secret|token\s*[:=]/i);
  assert.deepEqual(calls.map(([kind]) => kind), ["repo", "account", "query"]);
  return { mode, clients: clientRows, checks: ["repo-classification", "account-group", "completeness", "secret-scan"] };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const liveIndex = process.argv.indexOf("--live");
  const mode = liveIndex >= 0 ? "live" : "fixture";
  const client = liveIndex >= 0 ? process.argv[liveIndex + 1] : undefined;
  const result = await verifyAuditClients({ mode, client });
  process.stdout.write(`audit clients verification: ${result.mode} ${result.completeness ?? "healthy"}\n`);
}
