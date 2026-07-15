import { test } from "node:test";
import assert from "node:assert/strict";

import {
  inspectCodexTakeover,
  repairCcrCodexProfiles,
  repairCodexTakeover,
  stripCcrManagedCodexBlocks,
} from "../src/codex-takeover-guard.mjs";

const managedCodexText = [
  "theme = \"dark\"",
  "# BEGIN CCR managed profile",
  "model = \"temporary\"",
  "# END CCR managed profile",
  "[model_providers.claude-code-router]",
  "name = \"user-owned\"",
  "# BEGIN CCR managed Codex provider",
  "[model_providers.ccr-generated]",
  "name = \"temporary\"",
  "# END CCR managed Codex provider",
  "notify = [\"keep\", \"these bytes\"]",
  "",
].join("\n");

test("strips only exact CCR-managed Codex blocks and preserves surrounding bytes", () => {
  const expected = [
    "theme = \"dark\"",
    "[model_providers.claude-code-router]",
    "name = \"user-owned\"",
    "notify = [\"keep\", \"these bytes\"]",
    "",
  ].join("\n");

  const stripped = stripCcrManagedCodexBlocks(managedCodexText);

  assert.equal(stripped, expected);
  assert.equal(stripCcrManagedCodexBlocks(stripped), expected);
});

test("leaves unmarked and inexact marker text byte-for-byte unchanged", () => {
  const userText = [
    "[model_providers.claude-code-router]",
    "name = \"user-owned\"",
    "  # BEGIN CCR managed profile",
    "model = \"also-user-owned\"",
    "# END CCR managed profile extra",
    "",
  ].join("\r\n");

  assert.equal(stripCcrManagedCodexBlocks(userText), userText);
});

test("detects only enabled global Codex profiles targeting the real Codex config", () => {
  const ccrConfig = {
    profile: {
      profiles: [
        {
          id: "hazardous",
          agent: "codex",
          enabled: true,
          scope: "global",
          configFile: "~/.codex/config.toml",
          privateValue: "must-not-leak",
        },
        {
          id: "hazardous-custom-home",
          agent: "codex",
          codexHome: "/home/example/.codex",
          enabled: true,
          scope: "global",
        },
        {
          id: "disabled",
          agent: "codex",
          enabled: false,
          scope: "global",
          configFile: "~/.codex/config.toml",
        },
        {
          id: "isolated",
          agent: "codex",
          enabled: true,
          scope: "ccr",
          configFile: "~/.codex/config.toml",
        },
      ],
    },
  };

  const inspection = inspectCodexTakeover({ ccrConfig, codexConfigText: managedCodexText });

  assert.deepEqual(inspection, {
    affectedPaths: ["~/.codex/config.toml", "/home/example/.codex/config.toml"],
    actions: ["remove-managed-codex-blocks", "scope-codex-profiles-to-ccr"],
    hasHazardousProfiles: true,
    hasManagedCodexBlocks: true,
    hasTakeoverRecord: false,
    hazardous: true,
    hazardousProfileCount: 2,
    managedCodexBlockCount: 2,
    takeoverRecordCount: 0,
  });
  assert.doesNotMatch(JSON.stringify(inspection), /must-not-leak|privateValue|"id"/);
});

test("inspects only Codex entries in the takeover file's top-level profiles array", () => {
  const takeoverText = JSON.stringify({
    version: 1,
    profiles: [
      { agent: "claude-code", settingsFile: "~/.claude/settings.json" },
      { agent: "codex", configFile: "~/.codex/config.toml", providerId: "private-provider" },
    ],
    nestedDecoy: { agent: "codex", configFile: "/decoy/.codex/config.toml" },
  });

  const inspection = inspectCodexTakeover({ takeoverText });

  assert.deepEqual(inspection, {
    affectedPaths: ["~/.codex/config.toml"],
    actions: ["remove-managed-codex-blocks"],
    hasHazardousProfiles: false,
    hasManagedCodexBlocks: false,
    hasTakeoverRecord: true,
    hazardous: true,
    hazardousProfileCount: 0,
    managedCodexBlockCount: 0,
    takeoverRecordCount: 1,
  });
  assert.doesNotMatch(JSON.stringify(inspection), /private-provider|decoy/);
});

test("repairs only hazardous profiles without mutating the source config", () => {
  const source = {
    untouched: { nested: true },
    profile: {
      profiles: [
        {
          agent: "codex",
          enabled: true,
          scope: "global",
          configFile: "/home/example/.codex/config.toml",
          secret: "preserved-but-never-reported",
        },
        {
          agent: "codex",
          enabled: false,
          scope: "global",
          configFile: "~/.codex/config.toml",
        },
        { agent: "claude-code", enabled: true, scope: "global" },
      ],
    },
  };
  const snapshot = structuredClone(source);

  const repaired = repairCcrCodexProfiles(source);

  assert.deepEqual(source, snapshot);
  assert.notEqual(repaired, source);
  assert.deepEqual(repaired.profile.profiles[0], {
    ...source.profile.profiles[0],
    scope: "ccr",
    showAllSessions: true,
  });
  assert.deepEqual(repaired.profile.profiles.slice(1), source.profile.profiles.slice(1));
});

function transactionFixture({ failAt } = {}) {
  const codexPath = "/home/example/.codex/config.toml";
  const backupPath = `${codexPath}.backup-2026-07-15T01-02-03-004Z`;
  const temporaryPath = `${codexPath}.airkit-repair-2026-07-15T01-02-03-004Z.tmp`;
  const latest = Buffer.from(managedCodexText);
  const sanitized = Buffer.from(stripCcrManagedCodexBlocks(managedCodexText));
  const files = new Map([[codexPath, latest]]);
  const modes = new Map([[codexPath, 0o100640]]);
  const events = [];
  const hazardousConfig = {
    profile: {
      profiles: [{
        agent: "codex",
        configFile: "~/.codex/config.toml",
        enabled: true,
        privateValue: "must-not-leak",
        scope: "global",
      }],
    },
  };
  const mutateTarget = () => files.set(codexPath, Buffer.from("CCR mutated the target"));
  const io = {
    readFile: async (path) => {
      events.push(`read:${path}`);
      if (!files.has(path)) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      return Buffer.from(files.get(path));
    },
    rename: async (from, to) => {
      events.push(`rename:${from}->${to}`);
      files.set(to, files.get(from));
      modes.set(to, modes.get(from));
      files.delete(from);
      modes.delete(from);
    },
    stat: async (path) => {
      events.push(`stat:${path}`);
      return { mode: modes.get(path) };
    },
    writeFile: async (path, value, options = {}) => {
      events.push(`write:${path}`);
      files.set(path, Buffer.from(value));
      if (options.mode !== undefined) modes.set(path, options.mode);
    },
  };
  const ccrClient = {
    getConfig: async () => {
      events.push("getConfig");
      if (failAt === "getConfig") {
        mutateTarget();
        throw new Error("getConfig failed with private payload");
      }
      return structuredClone(hazardousConfig);
    },
    saveConfig: async (config) => {
      events.push("saveConfig");
      assert.equal(config.profile.profiles[0].scope, "ccr");
      assert.equal(config.profile.profiles[0].showAllSessions, true);
      if (failAt === "saveConfig") {
        mutateTarget();
        throw new Error("saveConfig failed with private payload");
      }
      mutateTarget();
    },
  };

  return {
    backupPath,
    ccrClient,
    codexPath,
    env: { HOME: "/home/example" },
    events,
    files,
    io,
    latest,
    modes,
    now: () => new Date("2026-07-15T01:02:03.004Z"),
    sanitized,
    temporaryPath,
  };
}

test("write repair backs up latest bytes before CCR RPC and atomically restores sanitized bytes", async () => {
  const fixture = transactionFixture();

  const result = await repairCodexTakeover({
    ccrClient: fixture.ccrClient,
    env: fixture.env,
    io: fixture.io,
    now: fixture.now,
    write: true,
  });

  assert.deepEqual(fixture.events, [
    `read:${fixture.codexPath}`,
    `stat:${fixture.codexPath}`,
    `write:${fixture.backupPath}`,
    "getConfig",
    "saveConfig",
    `write:${fixture.temporaryPath}`,
    `rename:${fixture.temporaryPath}->${fixture.codexPath}`,
    `read:${fixture.codexPath}`,
  ]);
  assert.deepEqual(fixture.files.get(fixture.backupPath), fixture.latest);
  assert.deepEqual(fixture.files.get(fixture.codexPath), fixture.sanitized);
  assert.equal(fixture.modes.get(fixture.codexPath), 0o640);
  assert.equal(result.backupPath, fixture.backupPath);
  assert.equal(result.restoredPath, fixture.codexPath);
  assert.equal(result.write, true);
  assert.doesNotMatch(JSON.stringify(result), /must-not-leak|private payload|temporary/);
});

for (const failAt of ["getConfig", "saveConfig"]) {
  test(`restores the sanitized latest snapshot when ${failAt} mutates Codex then throws`, async () => {
    const fixture = transactionFixture({ failAt });

    await assert.rejects(
      repairCodexTakeover({
        ccrClient: fixture.ccrClient,
        env: fixture.env,
        io: fixture.io,
        now: fixture.now,
        write: true,
      }),
      (error) => {
        assert.equal(error.backupPath, fixture.backupPath);
        assert.equal(error.restoredPath, fixture.codexPath);
        assert.doesNotMatch(`${error.message} ${JSON.stringify(error)}`, /private payload|CCR mutated/);
        return true;
      },
    );

    assert.deepEqual(fixture.files.get(fixture.backupPath), fixture.latest);
    assert.deepEqual(fixture.files.get(fixture.codexPath), fixture.sanitized);
    assert.equal(fixture.modes.get(fixture.codexPath), 0o640);
    assert.equal(fixture.events.at(-1), `read:${fixture.codexPath}`);
  });
}

test("preview inspects current state without writes or saveConfig", async () => {
  const fixture = transactionFixture();

  const result = await repairCodexTakeover({
    ccrClient: fixture.ccrClient,
    env: fixture.env,
    io: fixture.io,
    now: fixture.now,
    write: false,
  });

  assert.deepEqual(fixture.events, [`read:${fixture.codexPath}`, "getConfig"]);
  assert.equal(result.write, false);
  assert.equal(result.backupPath, null);
  assert.equal(result.inspection.hazardous, true);
  assert.ok(!fixture.events.some((event) => event.startsWith("write:") || event === "saveConfig"));
});
