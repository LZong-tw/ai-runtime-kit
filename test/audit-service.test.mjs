import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { resolveAuditPaths } from "../src/audit/paths.mjs";
import { installAuditService, inspectAuditService, planAuditService, stopAuditService, uninstallAuditService } from "../src/audit/service.mjs";

function fixture() {
  const home = join(tmpdir(), "airkit-service-home");
  const paths = resolveAuditPaths({ env: { HOME: home, UID: "501" }, overrides: { rootDir: join(home, ".state", "airkit-audit") } });
  const options = { paths, nodePath: "/opt/node/bin/node", daemonPath: "/opt/airkit/src/auditd.mjs", authHelperPath: "/opt/airkit/bin/airkit-audit-auth", env: {} };
  return { paths, options };
}

test("preview performs zero filesystem or launchctl writes", async () => {
  const { options } = fixture();
  const writes = [];
  const io = new Proxy({}, { get: () => async (...args) => writes.push(args) });
  const calls = [];
  const plan = await installAuditService({ ...options, write: false, io, runLaunchctl: async (args) => calls.push(args) });
  assert.equal(plan.label, "com.airkit.auditd");
  assert.equal(writes.length, 0);
  assert.equal(calls.length, 0);
  assert.match(plan.plistXml, /com\.airkit\.auditd/);
});

test("write install is atomic, private, and idempotent", async () => {
  const { options, paths } = fixture();
  const root = await mkdtemp(join(tmpdir(), "airkit-service-"));
  const actual = { ...paths, homeDir: root, launchAgentPath: join(root, "Library", "LaunchAgents", "com.airkit.auditd.plist") };
  const calls = [];
  const runLaunchctl = async (args) => { calls.push(args); return { ok: true, status: 0 }; };
  await installAuditService({ ...options, paths: actual, write: true, runLaunchctl });
  await installAuditService({ ...options, paths: actual, write: true, runLaunchctl });
  assert.equal((await stat(actual.launchAgentPath)).mode & 0o777, 0o600);
  assert.equal(calls.filter((args) => args[0] === "bootstrap").length, 2);
  assert.equal(calls.filter((args) => args[0] === "kickstart").length, 2);
  assert.equal((await readFile(actual.launchAgentPath, "utf8")).includes("/opt/node/bin/node"), true);
});

test("uninstall requires explicit write and confirmation", async () => {
  const { options } = fixture();
  const calls = [];
  const io = { unlink: async () => calls.push("unlink") };
  await uninstallAuditService({ ...options, io, runLaunchctl: async (args) => calls.push(args), write: true });
  assert.deepEqual(calls, []);
});

test("inspect reports stale or missing service without touching unrelated jobs", async () => {
  const { options } = fixture();
  const calls = [];
  const io = { readFile: async () => { const error = new Error("missing"); error.code = "ENOENT"; throw error; } };
  const result = await inspectAuditService({ ...options, io, runLaunchctl: async (args) => { calls.push(args); return { ok: false, stderr: "Could not find service" }; } });
  assert.equal(result.installed, false);
  assert.equal(result.loaded, false);
  assert.deepEqual(calls, [["print", "gui/501/com.airkit.auditd"]]);
});

test("plan has explicit GUI target and absolute paths", () => {
  const { options } = fixture();
  const plan = planAuditService(options);
  assert.equal(plan.target, "gui/501/com.airkit.auditd");
  assert.deepEqual(plan.plist.ProgramArguments, [options.nodePath, options.daemonPath, "--auth-helper", options.authHelperPath]);
});

test("rejects path or target drift before touching unrelated jobs", async () => {
  const { options, paths } = fixture();
  const calls = [];
  const io = { readFile: async () => { calls.push("read"); return ""; }, unlink: async () => calls.push("unlink") };
  const runLaunchctl = async (args) => { calls.push(args); return { ok: true, status: 0 }; };
  const cases = [
    [planAuditService, { paths: { ...paths, launchdTarget: "gui/501/com.airkit.ccr-daemon" } }],
    [planAuditService, { paths: { ...paths, launchAgentPath: "/tmp/com.airkit.auditd.plist" } }],
    [stopAuditService, { paths: { ...paths, launchdTarget: "gui/501/com.airkit.ccr-daemon" }, runLaunchctl }],
    [inspectAuditService, { paths: { ...paths, launchAgentPath: "/tmp/com.airkit.auditd.plist" }, io, runLaunchctl }],
    [uninstallAuditService, { paths: { ...paths, launchdTarget: "gui/501/com.airkit.ccr-daemon" }, io, runLaunchctl, write: true, confirm: true }],
  ];
  for (const [operation, input] of cases) {
    await assert.rejects(async () => operation({ ...options, ...input }), /auditd|audit service|LaunchAgents/i);
  }
  assert.deepEqual(calls, []);
});
