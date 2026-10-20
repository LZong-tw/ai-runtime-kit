import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CLAUDE_CODE_FIXED_BASELINE,
  collapseSettingsArgs,
  compactionThreshold,
  estimateFixedContext,
  laneWindow,
  resolveAutoCompactPolicy,
  thrashWarnings,
  validateAutoCompactEntry,
} from "../src/autocompact.mjs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildLaunchPlan, loadCatalog, runAirclaudeCli } from "../src/airkit.mjs";

const models = {
  "demo,grok": { contextWindow: 1_000_000, autoCompact: { window: 400_000 } },
  "demo,kimi": { contextWindow: 1_000_000, autoCompact: { window: 850_000 } },
  "demo,gpt": { contextWindow: 1_050_000, autoCompact: { window: 300_000 } },
  "demo,flash": { contextWindow: 1_000_000, autoCompact: { window: 278_000 } },
  "demo,bare": { contextWindow: 256_000 },
};

function policy(overrides = {}) {
  return resolveAutoCompactPolicy({
    enabled: true,
    binaryEligible: true,
    claudeCodeVersion: "2.1.304",
    router: { default: "demo,grok", background: "demo,flash", opus: "demo,kimi", sonnet: "demo,gpt" },
    launchModel: "claude-airkit-mode[1m]",
    lookupEntry: (route) => models[route] ?? null,
    label: "test",
    ...overrides,
  });
}

test("autoCompact entries accept a fixed window, auto, or a ratio and reject everything else", () => {
  for (const value of [undefined, { window: 400_000 }, { window: "auto" }, { ratio: 0.25 }, { ratio: 1 }]) {
    assert.doesNotThrow(() => validateAutoCompactEntry("m", value));
  }
  for (const value of [
    "auto",
    {},
    { window: 50_000 },
    { window: 400_000.5 },
    { ratio: 0 },
    { ratio: 1.5 },
    { window: 400_000, ratio: 0.5 },
    { windows: 400_000 },
  ]) {
    assert.throws(() => validateAutoCompactEntry("m", value), undefined, JSON.stringify(value));
  }
});

test("lane windows clamp to the model context and resolve ratios against the PCT threshold", () => {
  assert.equal(laneWindow({ contextWindow: 1_000_000, autoCompact: { window: 400_000 } }, "m"), 400_000);
  assert.equal(laneWindow({ contextWindow: 300_000, autoCompact: { window: 400_000 } }, "m"), 300_000);
  assert.equal(laneWindow({ contextWindow: 1_000_000 }, "m"), null);
  assert.equal(laneWindow({ contextWindow: 1_000_000, autoCompact: { window: "auto" } }, "m"), null);
  // floor((1M - 20K) * 0.25) + 20K + 13K: the same threshold PCT=25 gives on a 1M window.
  assert.equal(laneWindow({ contextWindow: 1_000_000, autoCompact: { ratio: 0.25 } }, "m"), 278_000);
  assert.throws(() => laneWindow({ autoCompact: { ratio: 0.25 } }, "m"), /needs a contextWindow/);
  assert.throws(() => laneWindow({ contextWindow: 1_000_000, autoCompact: { ratio: 0.05 } }, "m"), /below the 100000 floor/);
});

test("an active policy maps the launch id and each Claude family to its lane window", () => {
  const result = policy();
  assert.equal(result.status, "active");
  assert.equal(result.byModel["claude-airkit-mode"].window, 400_000);
  assert.equal(result.byModel["claude-opus-5-5"].window, 850_000);
  assert.equal(result.byModel["claude-sonnet-5"].window, 300_000);
  assert.equal(result.byModel["claude-haiku-5-5"].window, 278_000);
  assert.equal(result.fallbackWindow, 278_000, "unmatched ids get the smallest lane window");
  assert.deepEqual(result.settings.env, {
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: "",
    CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "100",
  });
  assert.equal(result.settings.autoCompactWindow, 278_000);
  assert.deepEqual(result.settings.modelSettings["claude-airkit-mode"], { autoCompactWindow: 400_000 });
  for (const id of Object.keys(result.settings.modelSettings)) {
    assert.doesNotMatch(id, /\[1m\]/i, "modelSettings keys are bare ids");
  }
  assert.match(result.policyGeneration, /^[0-9a-f]{12}$/);
});

test("the policy generation changes when any window changes and is stable otherwise", () => {
  const before = policy().policyGeneration;
  assert.equal(policy().policyGeneration, before);
  const lookup = (route) => (route === "demo,kimi" ? { contextWindow: 1_000_000, autoCompact: { window: 800_000 } } : models[route]);
  assert.notEqual(policy({ lookupEntry: lookup }).policyGeneration, before);
  assert.notEqual(policy({ claudeCodeVersion: "2.1.305" }).policyGeneration, before);
});

test("the policy stays inactive when the flag, binary, version, or catalog cannot support it", () => {
  assert.equal(policy({ enabled: false }).reason, "flag off");
  assert.equal(policy({ binaryEligible: false }).status, "inactive");
  assert.match(policy({ claudeCodeVersion: null }).reason, /version unknown/);
  assert.match(policy({ claudeCodeVersion: "2.1.295 (Claude Code)" }).reason, /predates modelSettings/);
  assert.equal(policy({ claudeCodeVersion: "2.1.296 (Claude Code)" }).status, "active");
  assert.equal(policy({ claudeCodeVersion: "2.2.0" }).status, "active");
  assert.match(
    policy({ router: { default: "demo,bare" } }).reason,
    /no lane has an autoCompact policy/,
  );
});

test("lanes without a policy are left to the top-level fallback window", () => {
  const result = policy({ router: { default: "demo,grok", opus: "demo,bare" } });
  assert.equal(result.status, "active");
  assert.equal(result.byModel["claude-opus-5-5"], undefined);
  assert.equal(result.byModel["claude-sonnet-5"].window, 400_000, "unset lanes follow the default route");
});

test("collapsing settings keeps one --settings argument with the policy last and user values elsewhere", () => {
  const files = { "/u.json": JSON.stringify({ env: { FOO: "file" }, statusLine: { type: "command" } }) };
  const readFile = (path) => {
    if (!(path in files)) throw new Error("ENOENT");
    return files[path];
  };
  const airkit = { env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: "" }, autoCompactWindow: 278_000 };
  const { head, tail } = collapseSettingsArgs(
    ["--model", "x", "--settings", '{"env":{"A":"1"},"autoCompactWindow":999999}'],
    ["--settings=/u.json", "-p", "hi"],
    airkit,
    readFile,
  );
  const all = [...head, ...tail];
  assert.equal(all.filter((arg) => String(arg).startsWith("--settings")).length, 1);
  const index = all.indexOf("--settings");
  const merged = JSON.parse(all[index + 1]);
  assert.deepEqual(merged.env, { A: "1", FOO: "file", CLAUDE_CODE_AUTO_COMPACT_WINDOW: "" });
  assert.equal(merged.autoCompactWindow, 278_000, "the policy wins over earlier sources");
  assert.deepEqual(merged.statusLine, { type: "command" });
  assert.deepEqual(all.filter((_, i) => i !== index && i !== index + 1), ["--model", "x", "-p", "hi"]);
});

test("collapsing settings fails loudly on unreadable or non-object sources", () => {
  const readFile = () => {
    throw new Error("ENOENT");
  };
  assert.throws(() => collapseSettingsArgs([], ["--settings", "/missing.json"], {}, readFile), /cannot read --settings/);
  assert.throws(() => collapseSettingsArgs([], ["--settings", "{not json"], {}, readFile), /not valid JSON/);
  assert.throws(() => collapseSettingsArgs([], ["--settings", "/list.json"], {}, () => "[1]"), /JSON object/);
});

function perModelCatalog() {
  return {
    schema: 1,
    modelCatalog: {
      providers: [
        {
          id: "demo",
          models: [
            { id: "grok", contextWindow: 1_000_000, autoCompact: { window: 400_000 } },
            { id: "flash", contextWindow: 1_000_000, autoCompact: { window: 278_000 } },
          ],
        },
      ],
    },
    profiles: [
      {
        name: "pm",
        visibility: "public",
        summary: "Per-model autocompact profile.",
        managedFiles: [],
        launch: {
          binary: "claude",
          args: [],
          claudeModel: "claude-airkit-mode[1m]",
          defaultMode: "auto",
          modes: { auto: { perModelAutoCompact: true }, legacy: {} },
        },
        ccr: {
          APIKEY: "ccr-local",
          LOG: false,
          Providers: [
            {
              name: "demo",
              type: "openai_chat_completions",
              api_base_url: "https://example.invalid/v1/chat/completions",
              api_key: "$DEMO_API_KEY",
              models: ["grok", "flash"],
            },
          ],
          Router: { default: "demo,grok", background: "demo,flash" },
        },
      },
    ],
  };
}

function settingsOf(args) {
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--settings") values.push(JSON.parse(args[index + 1]));
  }
  return values;
}

test("a per-model mode launches with one merged --settings and no --autocompact", () => {
  const plan = buildLaunchPlan(perModelCatalog(), "pm", {
    mode: "auto",
    runtimeVersions: { claudeCode: "2.1.304" },
    userArgs: ["--settings", '{"env":{"FOO":"1"}}', "-p", "hi"],
  });
  const all = [...plan.launch.args, ...plan.launch.userArgs];
  assert.equal(plan.launch.autoCompact.status, "active");
  assert.equal(all.includes("--autocompact"), false);
  const [settings, ...extra] = settingsOf(all);
  assert.equal(extra.length, 0);
  assert.equal(settings.env.FOO, "1");
  assert.equal(settings.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, "");
  assert.equal(settings.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE, "100");
  assert.equal(settings.modelSettings["airkit-mode"].autoCompactWindow, 400_000, "keyed by the --model id the client sends");
  assert.equal(all[all.indexOf("--model") + 1], "airkit-mode[1m]");
  assert.equal(settings.modelSettings["claude-haiku-5-5"].autoCompactWindow, 278_000);
  assert.equal(plan.launch.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, undefined, "nothing moves into the process env");
});

test("an old Claude Code or a mode without the flag keeps the native --autocompact auto launch", () => {
  const old = buildLaunchPlan(perModelCatalog(), "pm", { mode: "auto", runtimeVersions: { claudeCode: "2.1.208" } });
  assert.equal(old.launch.autoCompact.status, "inactive");
  assert.equal(old.launch.args.includes("--autocompact"), true);
  assert.equal(settingsOf(old.launch.args).length, 0);

  const legacy = buildLaunchPlan(perModelCatalog(), "pm", { mode: "legacy", runtimeVersions: { claudeCode: "2.1.304" } });
  assert.equal(legacy.launch.autoCompact, undefined);
  assert.equal(legacy.launch.args.includes("--autocompact"), true);
});

test("an explicit user autocompact choice turns the per-model policy off", () => {
  const readFile = (path) => {
    if (path === "/u/compact.json") return JSON.stringify({ modelSettings: { "claude-opus-5-5": { autoCompactWindow: 500_000 } } });
    throw new Error(`unexpected read ${path}`);
  };
  for (const userArgs of [
    ["--autocompact", "200000"],
    ["--autocompact=200000"],
    ["--settings", '{"autoCompactWindow":200000}'],
    ["--settings={\"env\":{\"CLAUDE_CODE_AUTO_COMPACT_WINDOW\":\"200000\"}}"],
    ["--settings", '{"env":{"CLAUDE_AUTOCOMPACT_PCT_OVERRIDE":"80"}}'],
    ["--settings", "/u/compact.json"],
  ]) {
    const plan = buildLaunchPlan(perModelCatalog(), "pm", {
      mode: "auto",
      runtimeVersions: { claudeCode: "2.1.304" },
      userArgs,
      fixedContextTokens: 20_000,
      readSettingsFile: readFile,
    });
    const label = JSON.stringify(userArgs);
    assert.deepEqual(plan.launch.autoCompact, { status: "inactive", reason: "explicit user autocompact setting" }, label);
    assert.deepEqual(plan.launch.userArgs, userArgs, `${label} reaches Claude untouched`);
    assert.equal(settingsOf(plan.launch.args).length, 0, `${label} gets no AirKit --settings`);
  }

  const unrelated = buildLaunchPlan(perModelCatalog(), "pm", {
    mode: "auto",
    runtimeVersions: { claudeCode: "2.1.304" },
    userArgs: ["--settings", '{"env":{"FOO":"1"},"modelSettings":{"x":{}}}'],
    fixedContextTokens: 20_000,
  });
  assert.equal(unrelated.launch.autoCompact.status, "active", "other settings keep the policy");
});

async function validateCatalog(catalog) {
  const dir = await mkdtemp(join(tmpdir(), "airkit-autocompact-"));
  try {
    const path = join(dir, "catalog.json");
    await writeFile(path, JSON.stringify(catalog));
    return await loadCatalog(path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("the catalog validator rejects bad per-model flags and autoCompact entries", async () => {
  await assert.doesNotReject(validateCatalog(perModelCatalog()));

  const badFlag = perModelCatalog();
  badFlag.profiles[0].launch.modes.auto.perModelAutoCompact = "true";
  await assert.rejects(validateCatalog(badFlag), /perModelAutoCompact must be a boolean/);

  const badEntry = perModelCatalog();
  badEntry.modelCatalog.providers[0].models[0].autoCompact = { window: 10 };
  await assert.rejects(validateCatalog(badEntry), /autoCompact/);

  const both = perModelCatalog();
  both.profiles[0].launch.context = { autoCompactWindow: 300_000 };
  await assert.rejects(validateCatalog(both), /choose one/);
});

test("the fixed-context estimate adds instruction files, project memory and the append prompt to the baseline", () => {
  const files = {
    "/home/u/.claude/CLAUDE.md": "x".repeat(700),
    "/home/u/work/repo/CLAUDE.md": "y".repeat(350),
    "/home/u/.claude/projects/-home-u-work-repo/memory/MEMORY.md": "z".repeat(35),
  };
  const readFile = (path) => {
    if (!(path in files)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    return files[path];
  };
  const tokens = estimateFixedContext({ appendPrompt: "p".repeat(70), cwd: "/home/u/work/repo", home: "/home/u", readFile });
  assert.equal(tokens, CLAUDE_CODE_FIXED_BASELINE + 330);
});

test("a lane warns once when the fixed floor passes a quarter of its compaction threshold", () => {
  assert.equal(compactionThreshold(180_000, 64_000), 147_000);
  const byModel = {
    "airkit-mode": { lane: "default", window: 180_000 },
    "claude-sonnet-5": { lane: "default", window: 180_000 },
    "claude-haiku-5-5": { lane: "background", window: 278_000 },
  };
  assert.deepEqual(thrashWarnings(byModel, 36_000, 64_000), []);
  const warnings = thrashWarnings(byModel, 40_000, 64_000);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /^default lane \(airkit-mode\): fixed context ~40000 tokens is 27% of its 147000-token compaction threshold/);
});

test("the launch plan carries the fixed-context estimate and its thrash warning", () => {
  const plan = buildLaunchPlan(perModelCatalog(), "pm", {
    mode: "auto",
    runtimeVersions: { claudeCode: "2.1.304" },
    fixedContextTokens: 100_000,
  });
  assert.equal(plan.launch.autoCompact.fixedContextTokens, 100_000);
  assert.deepEqual(
    plan.launch.autoCompact.warnings.map((warning) => warning.split(":")[0]),
    [
      "default lane (airkit-mode)",
      "opus lane (claude-opus-5-5)",
      "sonnet lane (claude-sonnet-5-5)",
      "background lane (claude-haiku-5-5)",
    ],
  );
});

test("a strictMcp mode launches with an empty strict MCP config and other modes do not", () => {
  const catalog = perModelCatalog();
  catalog.profiles[0].launch.modes.auto.strictMcp = true;
  const strict = buildLaunchPlan(catalog, "pm", { mode: "auto", runtimeVersions: { claudeCode: "2.1.304" } });
  assert.equal(strict.launch.strictMcp, true);
  const index = strict.launch.args.indexOf("--strict-mcp-config");
  assert.notEqual(index, -1);
  assert.equal(strict.launch.args[index + 1], '--mcp-config={"mcpServers":{}}');

  const other = buildLaunchPlan(catalog, "pm", { mode: "legacy", runtimeVersions: { claudeCode: "2.1.304" } });
  assert.equal(other.launch.strictMcp, undefined);
  assert.equal(other.launch.args.includes("--strict-mcp-config"), false);
});

test("the catalog validator rejects a non-boolean strictMcp and strictMcp on plain", async () => {
  const bad = perModelCatalog();
  bad.profiles[0].launch.modes.auto.strictMcp = "yes";
  await assert.rejects(validateCatalog(bad), /strictMcp must be a boolean/);

  const plain = perModelCatalog();
  plain.profiles[0].launch.modes.plain = { strictMcp: true };
  await assert.rejects(validateCatalog(plain), /plain cannot set strictMcp/);
});

test("the catalog validator ignores unknown mode fields but still type-checks known ones", async () => {
  const catalog = perModelCatalog();
  catalog.profiles[0].launch.modes.auto.description = "documentation only";
  catalog.profiles[0].launch.modes.legacy.description = "older launch";
  const loaded = await validateCatalog(catalog);
  assert.equal(loaded.profiles[0].launch.modes.auto.perModelAutoCompact, true);

  catalog.profiles[0].launch.modes.auto.strictMcp = 1;
  await assert.rejects(validateCatalog(catalog), /strictMcp must be a boolean/);
});

test("the catalog validator resolves ratio lanes at load, not only at a gated launch", async () => {
  const noContext = perModelCatalog();
  delete noContext.modelCatalog.providers[0].models[0].contextWindow;
  noContext.modelCatalog.providers[0].models[0].autoCompact = { ratio: 0.5 };
  await assert.rejects(validateCatalog(noContext), /demo\/grok\.autoCompact\.ratio needs a contextWindow/);

  const belowFloor = perModelCatalog();
  belowFloor.modelCatalog.providers[0].models[0] = { id: "grok", contextWindow: 200_000, autoCompact: { ratio: 0.01 } };
  await assert.rejects(validateCatalog(belowFloor), /demo\/grok\.autoCompact resolves to \d+, below the 100000 floor/);
});

test("the catalog validator rejects perModelAutoCompact on plain", async () => {
  const plain = perModelCatalog();
  plain.profiles[0].launch.modes.plain = { perModelAutoCompact: true };
  await assert.rejects(validateCatalog(plain), /plain cannot set perModelAutoCompact/);
});

test("the version gate reads the claude binary on PATH ahead of the npm global package", () => {
  const plan = buildLaunchPlan(perModelCatalog(), "pm", {
    mode: "auto",
    runtimeVersions: { claudeCode: "2.1.208", claudeBinary: "2.1.304" },
  });
  assert.equal(plan.launch.autoCompact.status, "active");

  const stale = buildLaunchPlan(perModelCatalog(), "pm", {
    mode: "auto",
    runtimeVersions: { claudeCode: "2.1.304", claudeBinary: "2.1.208" },
  });
  assert.equal(stale.launch.autoCompact.status, "inactive");
});

async function dryRun(mode, mutate = () => {}) {
  const dir = await mkdtemp(join(tmpdir(), "airkit-autocompact-dry-"));
  try {
    const catalog = perModelCatalog();
    mutate(catalog);
    const catalogPath = join(dir, "catalog.json");
    await writeFile(catalogPath, JSON.stringify(catalog));
    const out = [];
    const calls = [];
    const code = await runAirclaudeCli([mode, "--dry-run", "--profile", "pm", "--config-dir", join(dir, "cfg")], {
      catalogPath,
      env: { HOME: dir },
      stdout: { write: (chunk) => out.push(chunk) },
      stderr: { write: (chunk) => out.push(chunk) },
      commandExists: async () => true,
      runCommand: async (command, args) => {
        calls.push([command, ...args].join(" "));
        return { ok: true, status: 0, stdout: command === "claude" ? "2.1.304 (Claude Code)" : "{}" };
      },
      spawnCommand: () => {
        throw new Error("dry-run must not spawn");
      },
    });
    return { code, output: out.join(""), calls };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("dry-run reports the per-model autocompact and strict MCP lines for an opted-in mode", async () => {
  const { code, output, calls } = await dryRun("auto", (catalog) => {
    catalog.profiles[0].launch.modes.auto.strictMcp = true;
  });
  assert.equal(code, 0);
  assert.match(output, /- per-model autocompact: active [0-9a-f]{12}; fallback 278000; .*airkit-mode=400000 \(default\)/);
  assert.match(output, /- MCP: strict \(/);
  assert.equal(calls.filter((call) => call === "claude --version").length, 1, "the plan-time probe is reused by the runtime check");
});

test("dry-run of a mode without the flag prints neither line", async () => {
  const { code, output, calls } = await dryRun("legacy");
  assert.equal(code, 0);
  assert.doesNotMatch(output, /per-model autocompact/);
  assert.doesNotMatch(output, /MCP: strict/);
  assert.equal(calls.filter((call) => call === "claude --version").length, 1);
});
