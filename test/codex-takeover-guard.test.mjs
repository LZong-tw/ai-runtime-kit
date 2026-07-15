import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

function transactionFixture({ backupCollision = false, failAt } = {}) {
  const codexPath = "/home/example/.codex/config.toml";
  const backupPath = `${codexPath}.backup-2026-07-15T01-02-03-004Z`;
  const temporaryPath = `${codexPath}.airkit-repair-2026-07-15T01-02-03-004Z-fixture-nonce.tmp`;
  const latest = Buffer.from(managedCodexText);
  const sanitized = Buffer.from(stripCcrManagedCodexBlocks(managedCodexText));
  const files = new Map([[codexPath, latest]]);
  const modes = new Map([[codexPath, 0o100640]]);
  const writeOptions = new Map();
  const events = [];
  if (backupCollision) files.set(backupPath, Buffer.from("existing backup must survive"));
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
  let activeConfig = structuredClone(hazardousConfig);
  const mutateTarget = () => files.set(codexPath, Buffer.from("CCR mutated the target"));
  const io = {
    chmod: async (path, mode) => {
      modes.set(path, mode);
    },
    mkdir: async () => {},
    readFile: async (path) => {
      events.push(`read:${path}`);
      if (!files.has(path)) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      if (failAt === "verification" && path === codexPath && events.some((event) => event.startsWith("rename:"))) {
        return Buffer.from("verification failed with private bytes");
      }
      return Buffer.from(files.get(path));
    },
    rename: async (from, to) => {
      events.push(`rename:${from}->${to}`);
      if (failAt === "rename") throw new Error("rename failed with private path");
      files.set(to, files.get(from));
      modes.set(to, modes.get(from));
      files.delete(from);
      modes.delete(from);
    },
    realpath: async (path) => {
      if (!files.has(path)) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      return path;
    },
    stat: async (path) => {
      events.push(`stat:${path}`);
      return { mode: modes.get(path) };
    },
    unlink: async (path) => {
      events.push(`unlink:${path}`);
      if (!files.has(path)) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      files.delete(path);
      modes.delete(path);
    },
    writeFile: async (path, value, options = {}) => {
      events.push(`write:${path}`);
      if (options.flag === "wx" && files.has(path)) {
        throw Object.assign(new Error("exclusive collision with private path"), { code: "EEXIST" });
      }
      files.set(path, Buffer.from(value));
      if (options.mode !== undefined) modes.set(path, options.mode);
      writeOptions.set(path, { ...options });
      if (failAt === "tempWrite" && path === temporaryPath) {
        throw new Error("temporary write failed with private bytes");
      }
    },
  };
  const ccrClient = {
    getConfig: async () => {
      events.push("getConfig");
      if (failAt === "getConfig") {
        mutateTarget();
        throw new Error("getConfig failed with private payload");
      }
      return structuredClone(activeConfig);
    },
    saveConfig: async (config) => {
      events.push("saveConfig");
      assert.equal(config.profile.profiles[0].scope, "ccr");
      assert.equal(config.profile.profiles[0].showAllSessions, true);
      if (failAt === "saveConfig") {
        mutateTarget();
        throw new Error("saveConfig failed with private payload");
      }
      activeConfig = structuredClone(config);
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
    nonce: () => "fixture-nonce",
    now: () => new Date("2026-07-15T01:02:03.004Z"),
    sanitized,
    temporaryPath,
    writeOptions,
  };
}

test("write repair backs up latest bytes before CCR RPC and atomically restores sanitized bytes", async () => {
  const fixture = transactionFixture();

  const result = await repairCodexTakeover({
    ccrClient: fixture.ccrClient,
    env: fixture.env,
    io: fixture.io,
    nonce: fixture.nonce,
    now: fixture.now,
    write: true,
  });

  assert.deepEqual(fixture.events.slice(0, 7), [
    "read:/home/example/.claude-code-router/global-profile-takeover.json",
    `read:${fixture.codexPath}`,
    `stat:${fixture.codexPath}`,
    `write:${fixture.backupPath}`,
    "getConfig",
    "saveConfig",
    `read:${fixture.codexPath}`,
  ]);
  assert.ok(fixture.events.includes(
    `write:${fixture.temporaryPath}`,
  ));
  assert.deepEqual(fixture.files.get(fixture.backupPath), fixture.latest);
  assert.deepEqual(fixture.files.get(fixture.codexPath), Buffer.from("CCR mutated the target"));
  assert.equal(fixture.modes.get(fixture.codexPath), 0o640);
  assert.deepEqual(fixture.writeOptions.get(fixture.backupPath), { flag: "wx", mode: 0o640 });
  assert.deepEqual(fixture.writeOptions.get(fixture.temporaryPath), { flag: "wx", mode: 0o640 });
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
        nonce: fixture.nonce,
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

  assert.deepEqual(fixture.events, [
    "read:/home/example/.claude-code-router/global-profile-takeover.json",
    `read:${fixture.codexPath}`,
    `stat:${fixture.codexPath}`,
    "getConfig",
  ]);
  assert.equal(result.write, false);
  assert.equal(result.backupPath, null);
  assert.equal(result.inspection.hazardous, true);
  assert.ok(!fixture.events.some((event) => event.startsWith("write:") || event === "saveConfig"));
});

test("an existing timestamped backup fails safely before any CCR RPC", async () => {
  const fixture = transactionFixture({ backupCollision: true });
  const existingBackup = Buffer.from(fixture.files.get(fixture.backupPath));

  await assert.rejects(
    repairCodexTakeover({
      ccrClient: fixture.ccrClient,
      env: fixture.env,
      io: fixture.io,
      nonce: fixture.nonce,
      now: fixture.now,
      write: true,
    }),
    (error) => {
      assert.equal(error.code, "CODEX_TAKEOVER_BACKUP_FAILED");
      assert.equal(error.backupPath, fixture.backupPath);
      assert.equal(error.restoredPath, null);
      assert.doesNotMatch(`${error.message} ${JSON.stringify(error)}`, /exclusive collision|private path/);
      return true;
    },
  );

  assert.deepEqual(fixture.files.get(fixture.backupPath), existingBackup);
  assert.deepEqual(fixture.files.get(fixture.codexPath), fixture.latest);
  assert.deepEqual(fixture.events, [
    "read:/home/example/.claude-code-router/global-profile-takeover.json",
    `read:${fixture.codexPath}`,
    `stat:${fixture.codexPath}`,
    `write:${fixture.backupPath}`,
  ]);
});

for (const failAt of ["tempWrite", "rename", "verification"]) {
  test(`cleans the exclusive temporary file after ${failAt} failure`, async () => {
    const fixture = transactionFixture({ failAt });

    await assert.rejects(
      repairCodexTakeover({
        ccrClient: fixture.ccrClient,
        env: fixture.env,
        io: fixture.io,
        nonce: fixture.nonce,
        now: fixture.now,
        write: true,
      }),
      (error) => {
        assert.equal(error.code, "CODEX_TAKEOVER_RESTORE_FAILED");
        assert.equal(error.backupPath, fixture.backupPath);
        assert.doesNotMatch(
          `${error.message} ${JSON.stringify(error)}`,
          /private bytes|private path|temporary write|verification failed|rename failed/,
        );
        return true;
      },
    );

    assert.ok(fixture.files.has(fixture.codexPath));
    assert.deepEqual(fixture.files.get(fixture.backupPath), fixture.latest);
    assert.ok(!fixture.files.has(fixture.temporaryPath));
    if (failAt !== "verification") assert.ok(fixture.events.includes(`unlink:${fixture.temporaryPath}`));
  });
}

test("repairs every snapshot target before save, preserves symlinks and non-Codex takeover entries, and writes a hardened receipt", async () => {
  const root = await mkdtemp(join(tmpdir(), "airkit-guard-multi-"));
  const home = join(root, "home");
  const stateDir = join(home, ".claude-code-router");
  const codexDir = join(home, ".codex");
  const realDefault = join(root, "real-default.toml");
  const defaultLink = join(codexDir, "config.toml");
  const custom = join(root, "Custom", "CONFIG.TOML");
  const takeoverPath = join(stateDir, "global-profile-takeover.json");
  let activeConfig;
  let saved = false;

  try {
    await mkdir(codexDir, { recursive: true });
    await mkdir(join(root, "Custom"), { recursive: true });
    await mkdir(stateDir, { recursive: true });
    await writeFile(realDefault, managedCodexText, { mode: 0o640 });
    await import("node:fs/promises").then(({ symlink }) => symlink(realDefault, defaultLink));
    await writeFile(custom, managedCodexText, { mode: 0o640 });
    await chmod(realDefault, 0o640);
    await chmod(custom, 0o640);
    const takeover = {
      version: 7,
      profiles: [
        { agent: "claude-code", settingsFile: "~/.claude/settings.json", keep: true },
        { agent: "codex", configFile: custom, providerId: "private" },
        { agent: "codex", codexHome: codexDir },
      ],
      untouched: { bytes: "preserved semantically" },
    };
    await writeFile(takeoverPath, `${JSON.stringify(takeover, null, 2)}\n`, { mode: 0o600 });
    activeConfig = {
      profile: {
        profiles: [
          { agent: "codex", configFile: custom, enabled: true, scope: "global" },
          { agent: "codex", codexHome: codexDir, enabled: true, scope: "global" },
          { agent: "claude-code", enabled: true, scope: "global" },
        ],
      },
    };
    const ccrClient = {
      getConfig: async () => {
        if (!saved) {
          await readFile(`${realDefault}.backup-2026-07-15T01-02-03-004Z`);
          await readFile(`${custom}.backup-2026-07-15T01-02-03-004Z`);
          await readFile(`${takeoverPath}.backup-2026-07-15T01-02-03-004Z`);
        }
        return structuredClone(activeConfig);
      },
      saveConfig: async (config) => {
        saved = true;
        activeConfig = structuredClone(config);
        await writeFile(realDefault, `${managedCodexText}concurrent = "default"\n`);
        await writeFile(custom, `${managedCodexText}concurrent = "custom"\n`);
        await writeFile(takeoverPath, JSON.stringify({
          ...takeover,
          profiles: [...takeover.profiles, { agent: "claude-code", id: "concurrent" }],
        }));
      },
    };

    const result = await repairCodexTakeover({
      ccrClient,
      env: { HOME: home },
      nonce: (() => { let value = 0; return () => `multi-${++value}`; })(),
      now: () => new Date("2026-07-15T01:02:03.004Z"),
      write: true,
    });

    assert.equal((await lstat(defaultLink)).isSymbolicLink(), true);
    assert.match(await readFile(realDefault, "utf8"), /concurrent = "default"/);
    assert.match(await readFile(custom, "utf8"), /concurrent = "custom"/);
    assert.doesNotMatch(await readFile(realDefault, "utf8"), /BEGIN CCR managed/);
    assert.doesNotMatch(await readFile(custom, "utf8"), /BEGIN CCR managed/);
    const repairedTakeover = JSON.parse(await readFile(takeoverPath, "utf8"));
    assert.equal(repairedTakeover.version, 7);
    assert.deepEqual(repairedTakeover.profiles, [takeover.profiles[0], { agent: "claude-code", id: "concurrent" }]);
    assert.deepEqual(repairedTakeover.untouched, takeover.untouched);
    assert.equal((await stat(result.receiptPath)).mode & 0o777, 0o600);
    assert.equal((await stat(result.backupPaths[0])).mode & 0o777, 0o640);
    const { realpath } = await import("node:fs/promises");
    assert.equal(result.codexConfigPaths.includes(await realpath(realDefault)), true);
    assert.equal(result.codexConfigPaths.includes(await realpath(custom)), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fails before save when live CCR reveals an unrecorded global Codex target", async () => {
  const fixture = transactionFixture();
  let saveCalled = false;
  fixture.ccrClient.getConfig = async () => ({
    profile: { profiles: [{ agent: "codex", configFile: "/unknown/CONFIG.TOML", enabled: true, scope: "global" }] },
  });
  fixture.ccrClient.saveConfig = async () => { saveCalled = true; };

  await assert.rejects(
    repairCodexTakeover({
      ccrClient: fixture.ccrClient,
      env: fixture.env,
      io: fixture.io,
      nonce: fixture.nonce,
      now: fixture.now,
      write: true,
    }),
    (error) => error.code === "CODEX_TAKEOVER_REPAIR_FAILED" && !/unknown/i.test(error.message),
  );
  assert.equal(saveCalled, false);
  assert.deepEqual(fixture.files.get(fixture.backupPath), fixture.latest);
  assert.deepEqual(fixture.files.get(fixture.codexPath), fixture.sanitized);
});
