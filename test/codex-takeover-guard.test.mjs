import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename as fsRename,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
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

test("inspects only Codex entries in the takeover file's strict top-level profiles array", () => {
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
  const backupPath = `${codexPath}.backup-2026-07-15T01-02-03-004Z-fixture-nonce`;
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
  const concurrentText = `${managedCodexText}concurrent = "preserved"\n`;
  const concurrentSanitized = Buffer.from(stripCcrManagedCodexBlocks(concurrentText));
  const mutateTarget = () => {
    files.set(codexPath, Buffer.from(concurrentText));
    modes.set(codexPath, 0o100600);
  };
  const io = {
    chmod: async (path, mode) => {
      modes.set(path, mode);
    },
    mkdir: async () => {},
    mkdtemp: async (prefix) => `${prefix}fixture-swap`,
    readFile: async (path) => {
      events.push(`read:${path}`);
      if (!files.has(path)) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      if (failAt === "captureRead" && path.endsWith("/captured")) {
        files.set(codexPath, Buffer.from("user_edit = \"wins\"\n"));
        modes.set(codexPath, 0o600);
        throw new Error("private captured read failure");
      }
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
      if (failAt === "swapConcurrent" && from === codexPath) {
        files.set(codexPath, Buffer.from("user_edit = \"wins\"\n"));
        modes.set(codexPath, 0o600);
      }
    },
    realpath: async (path) => {
      if (!files.has(path)) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      return path;
    },
    stat: async (path) => {
      events.push(`stat:${path}`);
      if (failAt === "captureStat" && path.endsWith("/captured")) {
        throw new Error("private captured stat failure");
      }
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
      if (failAt === "targetWrite" && path === codexPath && events.some((event) => event.startsWith(`rename:${codexPath}->`))) {
        throw new Error("target write failed with private bytes");
      }
      if (failAt === "concurrent" && path === temporaryPath) {
        files.set(codexPath, Buffer.from("user_edit = \"wins\"\n"));
      }
    },
  };
  const ccrClient = {
    getConfig: async () => {
      events.push("getConfig");
      return structuredClone(activeConfig);
    },
    saveConfig: async (config, options) => {
      events.push("saveConfig");
      assert.deepEqual(options, { applyProfile: false });
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
    concurrentSanitized,
    temporaryPath,
    writeOptions,
  };
}

test("write repair reads live config first, then backs up latest bytes before mutation-capable save", async () => {
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
    "getConfig",
    "read:/home/example/.claude-code-router/global-profile-takeover.json",
    `read:${fixture.codexPath}`,
    `stat:${fixture.codexPath}`,
    `write:${fixture.backupPath}`,
    "saveConfig",
    `read:${fixture.codexPath}`,
  ]);
  assert.ok(fixture.events.some((event) => event.startsWith(`rename:${fixture.codexPath}->`) && event.endsWith("/captured")));
  assert.deepEqual(fixture.files.get(fixture.backupPath), fixture.latest);
  assert.deepEqual(fixture.files.get(fixture.codexPath), fixture.concurrentSanitized);
  assert.equal(fixture.modes.get(fixture.codexPath), 0o600);
  assert.deepEqual(fixture.writeOptions.get(fixture.backupPath), { flag: "wx", mode: 0o640 });
  assert.deepEqual(fixture.writeOptions.get(fixture.codexPath), { flag: "wx", mode: 0o600 });
  assert.equal(result.backupPath, fixture.backupPath);
  assert.equal(result.restoredPath, fixture.codexPath);
  assert.equal(result.write, true);
  assert.doesNotMatch(JSON.stringify(result), /must-not-leak|private payload|temporary/);
});

for (const failAt of ["saveConfig"]) {
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
    assert.deepEqual(fixture.files.get(fixture.codexPath), fixture.concurrentSanitized);
    assert.equal(fixture.modes.get(fixture.codexPath), 0o600);
    assert.ok(fixture.events.includes(`read:${fixture.codexPath}`));
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
    "getConfig",
    "read:/home/example/.claude-code-router/global-profile-takeover.json",
    `read:${fixture.codexPath}`,
    `stat:${fixture.codexPath}`,
  ]);
  assert.equal(result.write, false);
  assert.equal(result.backupPath, null);
  assert.equal(result.inspection.hazardous, true);
  assert.ok(!fixture.events.some((event) => event.startsWith("write:") || event === "saveConfig"));
});

test("an existing unique backup fails safely before mutation-capable save", async () => {
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
    "getConfig",
    "read:/home/example/.claude-code-router/global-profile-takeover.json",
    `read:${fixture.codexPath}`,
    `stat:${fixture.codexPath}`,
    `write:${fixture.backupPath}`,
  ]);
});

for (const failAt of ["targetWrite", "rename", "verification"]) {
  test(`retains rollback evidence after ${failAt} failure`, async () => {
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

    assert.deepEqual(fixture.files.get(fixture.backupPath), fixture.latest);
    if (failAt !== "rename") {
      assert.ok([...fixture.files.keys()].some((path) => path.endsWith("/captured")));
    }
  });
}

for (const failAt of ["captureStat", "captureRead"]) {
  test(`restores active ownership and reports retained capture after ${failAt} failure`, async () => {
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
        assert.equal(error.failedPaths.includes(fixture.codexPath), true);
        assert.equal(error.conflictPaths.length, 1);
        assert.match(error.conflictPaths[0], /\/captured$/);
        assert.doesNotMatch(`${error.message} ${JSON.stringify(error)}`, /private captured/);
        return true;
      },
    );

    const capturedPath = [...fixture.files.keys()].find((path) => path.endsWith("/captured"));
    assert.ok(capturedPath);
    assert.deepEqual(fixture.files.get(capturedPath), Buffer.from(`${managedCodexText}concurrent = "preserved"\n`));
    assert.equal(fixture.files.has(fixture.codexPath), true);
    assert.deepEqual(
      fixture.files.get(fixture.codexPath),
      Buffer.from(failAt === "captureRead" ? "user_edit = \"wins\"\n" : `${managedCodexText}concurrent = "preserved"\n`),
    );
  });
}

test("repairs every live and recorded target before save, preserves symlinks and non-Codex takeover entries", async () => {
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
      version: 1,
      profiles: [
        { agent: "claude-code", settingsFile: "~/.claude/settings.json", keep: true },
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
    let getCount = 0;
    const ccrClient = {
      getConfig: async () => {
        getCount += 1;
        if (!saved && getCount > 1) {
          await readFile(`${realDefault}.backup-2026-07-15T01-02-03-004Z-multi-1`);
          await readFile(`${custom}.backup-2026-07-15T01-02-03-004Z-multi-2`);
          await readFile(`${takeoverPath}.backup-2026-07-15T01-02-03-004Z-multi-3`);
        }
        return structuredClone(activeConfig);
      },
      saveConfig: async (config, options) => {
        assert.deepEqual(options, { applyProfile: false });
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
    assert.equal(repairedTakeover.version, 1);
    assert.deepEqual(repairedTakeover.profiles, [takeover.profiles[0], { agent: "claude-code", id: "concurrent" }]);
    assert.deepEqual(repairedTakeover.untouched, takeover.untouched);
    assert.equal((await stat(result.backupPaths[0])).mode & 0o777, 0o640);
    const { realpath } = await import("node:fs/promises");
    assert.equal(result.codexConfigPaths.includes(await realpath(realDefault)), true);
    assert.equal(result.codexConfigPaths.includes(await realpath(custom)), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("discovers an unrecorded live global Codex target before backup and save", async () => {
  const fixture = transactionFixture();
  const unknownPath = "/unknown/CONFIG.TOML";
  fixture.files.set(unknownPath, Buffer.from(managedCodexText));
  fixture.modes.set(unknownPath, 0o100600);
  let saveCalled = false;
  let activeConfig = {
    profile: { profiles: [{ agent: "codex", configFile: unknownPath, enabled: true, scope: "global" }] },
  };
  fixture.ccrClient.getConfig = async () => ({
    ...structuredClone(activeConfig),
  });
  fixture.ccrClient.saveConfig = async (config, options) => {
    fixture.events.push("saveConfig");
    assert.deepEqual(options, { applyProfile: false });
    saveCalled = true;
    activeConfig = structuredClone(config);
  };

  await repairCodexTakeover({
    ccrClient: fixture.ccrClient,
    env: fixture.env,
    io: fixture.io,
    nonce: fixture.nonce,
    now: fixture.now,
    write: true,
  });
  assert.equal(saveCalled, true);
  const unknownBackup = `${unknownPath}.backup-2026-07-15T01-02-03-004Z-fixture-nonce`;
  assert.deepEqual(fixture.files.get(unknownBackup), Buffer.from(managedCodexText));
  assert.ok(fixture.events.indexOf(`write:${unknownBackup}`) < fixture.events.indexOf("saveConfig"));
  assert.doesNotMatch(fixture.files.get(unknownPath).toString("utf8"), /BEGIN CCR managed/);
  assert.deepEqual(fixture.files.get(fixture.backupPath), fixture.latest);
  assert.deepEqual(fixture.files.get(fixture.codexPath), fixture.sanitized);
});

test("sanitizes an initially missing live target created by save on success and failure", async () => {
  for (const failSave of [false, true]) {
    const root = await mkdtemp(join(tmpdir(), `airkit-guard-missing-${failSave}-`));
    const home = join(root, "home");
    const target = join(root, "created", "config.toml");
    let activeConfig = {
      profile: { profiles: [{ agent: "codex", configFile: target, enabled: true, scope: "global" }] },
    };
    try {
      await mkdir(join(home, ".claude-code-router"), { recursive: true });
      const ccrClient = {
        getConfig: async () => structuredClone(activeConfig),
        saveConfig: async (config, options) => {
          assert.deepEqual(options, { applyProfile: false });
          await mkdir(join(root, "created"), { recursive: true });
          await writeFile(target, `${managedCodexText}user_edit = "preserved"\n`, { mode: 0o600 });
          activeConfig = structuredClone(config);
          if (failSave) throw new Error("private save failure");
        },
      };
      const repair = repairCodexTakeover({ ccrClient, env: { HOME: home }, write: true });
      if (failSave) await assert.rejects(repair, (error) => error.code === "CODEX_TAKEOVER_REPAIR_FAILED");
      else await repair;
      const repaired = await readFile(target, "utf8");
      assert.match(repaired, /user_edit = "preserved"/);
      assert.doesNotMatch(repaired, /BEGIN CCR managed/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("retains swap-time bytes and does not clobber a writer in the former compare-rename window", async () => {
  const fixture = transactionFixture({ failAt: "swapConcurrent" });
  await assert.rejects(
    repairCodexTakeover({
      ccrClient: fixture.ccrClient,
      env: fixture.env,
      io: fixture.io,
      nonce: fixture.nonce,
      now: fixture.now,
      write: true,
    }),
    (error) => error.code === "CODEX_TAKEOVER_RESTORE_FAILED"
      && error.failedPaths.includes(fixture.codexPath),
  );
  assert.equal(fixture.files.get(fixture.codexPath).toString("utf8"), "user_edit = \"wins\"\n");
  const capturedPath = [...fixture.files.keys()].find((path) => path.endsWith("/captured"));
  assert.ok(capturedPath);
  assert.deepEqual(fixture.files.get(capturedPath), Buffer.from(`${managedCodexText}concurrent = "preserved"\n`));
});

test("rejects malformed takeover shapes before mutation-capable save", async () => {
  const invalidTexts = [
    "",
    ...[[], {}, { profiles: [] }, { version: "1", profiles: [] }, { version: 2, profiles: [] }].map(JSON.stringify),
  ];
  for (const text of invalidTexts) {
    const fixture = transactionFixture();
    const takeoverPath = "/home/example/.claude-code-router/global-profile-takeover.json";
    fixture.files.set(takeoverPath, Buffer.from(text));
    fixture.modes.set(takeoverPath, 0o100600);
    await assert.rejects(
      repairCodexTakeover({
        ccrClient: fixture.ccrClient,
        env: fixture.env,
        io: fixture.io,
        nonce: fixture.nonce,
        now: fixture.now,
        write: true,
      }),
      (error) => error.code === "CODEX_TAKEOVER_INVALID",
    );
    assert.ok(!fixture.events.includes("saveConfig"));
  }
});

test("quarantines a newly-created malformed takeover record and fails without data loss", async () => {
  const root = await mkdtemp(join(tmpdir(), "airkit-guard-malformed-record-"));
  const home = join(root, "home");
  const stateDir = join(home, ".claude-code-router");
  const takeoverPath = join(stateDir, "global-profile-takeover.json");
  const malformed = "{private malformed bytes";
  let activeConfig = { profile: { profiles: [] } };
  try {
    await mkdir(join(home, ".codex"), { recursive: true });
    await mkdir(stateDir, { recursive: true });
    await writeFile(join(home, ".codex", "config.toml"), "theme = \"dark\"\n");
    const ccrClient = {
      getConfig: async () => structuredClone(activeConfig),
      saveConfig: async (config, options) => {
        assert.deepEqual(options, { applyProfile: false });
        activeConfig = structuredClone(config);
        await writeFile(takeoverPath, malformed, { mode: 0o600 });
      },
    };
    const io = {
      chmod,
      mkdtemp,
      readFile,
      realpath,
      rename: async (from, to) => {
        await fsRename(from, to);
        if (from === takeoverPath) await writeFile(takeoverPath, "writer = \"wins\"\n", { mode: 0o600 });
      },
      stat,
      writeFile,
    };
    await assert.rejects(
      repairCodexTakeover({ ccrClient, env: { HOME: home }, io, write: true }),
      (error) => error.code === "CODEX_TAKEOVER_RESTORE_FAILED" && error.failedPaths.includes(takeoverPath),
    );
    assert.equal(await readFile(takeoverPath, "utf8"), "writer = \"wins\"\n");
    const swapDir = (await readdir(stateDir)).find((name) => name.includes(".airkit-swap-"));
    assert.ok(swapDir);
    assert.equal(await readFile(join(stateDir, swapDir, "captured"), "utf8"), malformed);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("save failure restores original Codex entries while preserving concurrent non-Codex takeover data", async () => {
  const root = await mkdtemp(join(tmpdir(), "airkit-guard-record-merge-"));
  const home = join(root, "home");
  const stateDir = join(home, ".claude-code-router");
  const takeoverPath = join(stateDir, "global-profile-takeover.json");
  const originalCodex = { agent: "codex", configFile: join(home, ".codex", "config.toml") };
  const original = { version: 1, profiles: [originalCodex, { agent: "claude-code", id: "original" }], meta: "original" };
  let activeConfig = { profile: { profiles: [{ ...originalCodex, enabled: true, scope: "global" }] } };
  try {
    await mkdir(join(home, ".codex"), { recursive: true });
    await mkdir(stateDir, { recursive: true });
    await writeFile(join(home, ".codex", "config.toml"), managedCodexText);
    await writeFile(takeoverPath, JSON.stringify(original));
    const ccrClient = {
      getConfig: async () => structuredClone(activeConfig),
      saveConfig: async (config, options) => {
        assert.deepEqual(options, { applyProfile: false });
        activeConfig = structuredClone(config);
        await writeFile(takeoverPath, JSON.stringify({
          version: 1,
          profiles: [{ agent: "codex", configFile: "/mutated/config.toml" }, { agent: "claude-code", id: "concurrent" }],
          meta: "concurrent",
        }));
        throw new Error("private save failure");
      },
    };
    await assert.rejects(
      repairCodexTakeover({ ccrClient, env: { HOME: home }, write: true }),
      (error) => error.code === "CODEX_TAKEOVER_REPAIR_FAILED",
    );
    const repaired = JSON.parse(await readFile(takeoverPath, "utf8"));
    assert.equal(repaired.meta, "concurrent");
    assert.deepEqual(repaired.profiles, [{ agent: "claude-code", id: "concurrent" }, originalCodex]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("continues cleanup across every target and takeover record when one restore fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "airkit-guard-best-effort-"));
  const home = join(root, "home");
  const defaultPath = join(home, ".codex", "config.toml");
  const customPath = join(root, "custom.toml");
  const stateDir = join(home, ".claude-code-router");
  const takeoverPath = join(stateDir, "global-profile-takeover.json");
  let activeConfig = {
    profile: { profiles: [
      { agent: "codex", configFile: defaultPath, enabled: true, scope: "global" },
      { agent: "codex", configFile: customPath, enabled: true, scope: "global" },
    ] },
  };
  try {
    await mkdir(join(home, ".codex"), { recursive: true });
    await mkdir(stateDir, { recursive: true });
    await writeFile(defaultPath, managedCodexText);
    await writeFile(customPath, managedCodexText);
    await writeFile(takeoverPath, JSON.stringify({ version: 1, profiles: [
      { agent: "codex", configFile: customPath },
      { agent: "claude-code", settingsFile: "~/.claude/settings.json" },
    ] }));
    const io = {
      chmod,
      mkdtemp,
      readFile,
      realpath,
      rename: async (from, to) => {
        if (from === await realpath(defaultPath)) throw new Error("private rename failure");
        await fsRename(from, to);
      },
      stat,
      unlink,
      writeFile,
    };
    const ccrClient = {
      getConfig: async () => structuredClone(activeConfig),
      saveConfig: async (config, options) => {
        assert.deepEqual(options, { applyProfile: false });
        activeConfig = structuredClone(config);
      },
    };
    const canonicalDefault = await realpath(defaultPath);
    await assert.rejects(
      repairCodexTakeover({ ccrClient, env: { HOME: home }, io, write: true }),
      (error) => error.code === "CODEX_TAKEOVER_RESTORE_FAILED"
        && error.failedPaths.includes(canonicalDefault),
    );
    assert.doesNotMatch(await readFile(customPath, "utf8"), /BEGIN CCR managed/);
    const record = JSON.parse(await readFile(takeoverPath, "utf8"));
    assert.equal(record.version, 1);
    assert.deepEqual(record.profiles, [{ agent: "claude-code", settingsFile: "~/.claude/settings.json" }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
