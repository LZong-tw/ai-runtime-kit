import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { captureCodexContract } from "../scripts/capture-codex-audit-contract.mjs";
import { reconcileCodex } from "../src/audit/reconcile/codex.mjs";

test("Codex contract probe uses isolated config and records unverified routes as false", async () => {
  const frozen = JSON.parse(await readFile(new URL("./fixtures/audit/codex/current.json", import.meta.url), "utf8"));
  assert.match(frozen.codexVersion, /^\d+\.\d+\.\d+/);
  assert.equal(typeof frozen.responses_route_supported, "boolean");
  assert.doesNotMatch(JSON.stringify(frozen), /Bearer |sk-|\/Users\//);
  const root = await mkdtemp(join(tmpdir(), "airkit-codex-contract-test-"));
  const fake = join(root, "fake-codex.mjs");
  const output = join(root, "current.json");
  await writeFile(fake, `#!/usr/bin/env node
if (process.argv.includes("--version")) process.stdout.write("codex-cli 0.147.0\\n");
else process.stdout.write("codex exec --help\\n");
`, { mode: 0o700 });
  try {
    const fixture = await captureCodexContract({ output, codexCommand: fake, now: () => new Date("2026-08-17T00:00:00.000Z") });
    assert.equal(fixture.responses_route_supported, false);
    assert.equal(fixture.probe.provider_attempts_observed, false);
    assert.doesNotMatch(await readFile(output, "utf8"), /Bearer |sk-|\/Users\//);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Codex reconciliation preserves usage metadata but never invents provider attempts", async () => {
  const root = await mkdtemp(join(tmpdir(), "airkit-codex-jsonl-test-"));
  try {
    const sessionPath = join(root, "session.jsonl");
    await writeFile(sessionPath, [
      JSON.stringify({ timestamp: "2026-08-17T00:00:00.000Z", type: "session_meta", payload: { id: "session-1", cli_version: "0.147.0", source: "cli", model_provider: "openai" } }),
      JSON.stringify({ timestamp: "2026-08-17T00:00:01.000Z", type: "event_msg", payload: { type: "task_started", turn_id: "turn-1", model_context_window: 1000000 } }),
      JSON.stringify({ timestamp: "2026-08-17T00:00:02.000Z", type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { input_tokens: 20, cached_input_tokens: 12, output_tokens: 3, reasoning_output_tokens: 2, total_tokens: 25 } } } }),
      JSON.stringify({ timestamp: "2026-08-17T00:00:03.000Z", type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "secret prompt must not be retained" }] } }),
    ].join("\n") + "\n");
    const events = [];
    const result = await reconcileCodex({ sessionPath, emit: async (event) => events.push(event) });
    assert.equal(result.events, 3);
    assert.equal(events.some((event) => event.event_kind === "provider_request"), false);
    const usage = events.find((event) => event.event_kind === "usage_reported");
    assert.equal(usage.payload.usage.cached_input_tokens, 12);
    assert.equal(usage.payload.actual_provider, null);
    assert.equal(usage.payload.actual_model, null);
    assert.doesNotMatch(JSON.stringify(events), /secret prompt/);
    const tail = await reconcileCodex({ sessionPath, cursor: result.cursor, emit: async () => { throw new Error("should not emit"); } });
    assert.equal(tail.events, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
