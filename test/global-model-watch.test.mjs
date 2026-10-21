import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";

import { globalModelRestoreNotice, startGlobalModelWatch, withSignalRestore } from "../src/global-model-watch.mjs";

const ROUTE_ID = "anthropic/claude-ccr-h6169726b";

async function withHome(run) {
  const home = await mkdtemp(join(tmpdir(), "airkit-model-watch-"));
  await mkdir(join(home, ".claude"), { recursive: true });
  try {
    return await run({ home, env: { HOME: home }, path: join(home, ".claude", "settings.json") });
  } finally {
    await rm(home, { force: true, recursive: true });
  }
}

function settingsText(settings, indent = 4) {
  return `${JSON.stringify(settings, null, indent)}\n`;
}

test("a CCR route saved as the default is put back to the launch value, keeping every other key and the file's style", async () => {
  await withHome(async ({ env, path }) => {
    await writeFile(path, settingsText({ permissions: { allow: ["Bash"] }, model: "opus", statusLine: { type: "command" } }));
    await chmod(path, 0o600);
    const watch = startGlobalModelWatch({ env, watch: false });

    await writeFile(path, settingsText({ permissions: { allow: ["Bash"] }, model: ROUTE_ID, statusLine: { type: "command" }, modelSettings: { [ROUTE_ID]: { effort: "high" } } }));
    const result = watch.stop();

    assert.equal(await readFile(path, "utf8"), settingsText({ permissions: { allow: ["Bash"] }, model: "opus", statusLine: { type: "command" }, modelSettings: { [ROUTE_ID]: { effort: "high" } } }));
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.deepEqual(result.restored, [{ from: ROUTE_ID, to: "opus" }]);
    assert.deepEqual((await readdir(join(path, ".."))).sort(), ["settings.json"]);
  });
});

test("a model that was absent at launch is removed again; bare catalog ids count as CCR-only", async () => {
  await withHome(async ({ env, path }) => {
    await writeFile(path, JSON.stringify({ theme: "dark" }));
    const watch = startGlobalModelWatch({ env, watch: false, ccrOnlyIds: ["GLM-5.3"] });
    await writeFile(path, JSON.stringify({ theme: "dark", model: "GLM-5.3" }));
    watch.stop();
    assert.equal(await readFile(path, "utf8"), JSON.stringify({ theme: "dark" }));
  });
});

test("a real model picked during the session is left alone, and becomes what a later leak is restored to", async () => {
  await withHome(async ({ env, path }) => {
    await writeFile(path, settingsText({ model: "opus" }, 2));
    const watch = startGlobalModelWatch({ env, watch: false });

    await writeFile(path, settingsText({ model: "sonnet[1m]" }, 2));
    watch.check();
    assert.equal(await readFile(path, "utf8"), settingsText({ model: "sonnet[1m]" }, 2));

    await writeFile(path, settingsText({ model: "claude-airkit-mode[1m]" }, 2));
    watch.stop();
    assert.equal(JSON.parse(await readFile(path, "utf8")).model, "sonnet[1m]");
  });
});

test("the file watcher restores the key while the session is still running", async () => {
  await withHome(async ({ env, path }) => {
    await writeFile(path, JSON.stringify({ model: "opus" }));
    const watch = startGlobalModelWatch({ env, debounceMs: 20 });
    try {
      // Claude Code replaces the file by rename, which a plain file watch would miss.
      await writeFile(`${path}.tmp`, JSON.stringify({ model: ROUTE_ID }));
      await fs.promises.rename(`${path}.tmp`, path);
      const deadline = Date.now() + 5_000;
      while (JSON.parse(await readFile(path, "utf8")).model !== "opus" && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.equal(JSON.parse(await readFile(path, "utf8")).model, "opus");
    } finally {
      watch.stop();
    }
  });
});

test("the stat poll restores the key when the file watch delivers no events", async () => {
  await withHome(async ({ env, path }) => {
    await writeFile(path, JSON.stringify({ model: "opus" }));
    const deafFs = { ...fs, watch: () => ({ on() {}, close() {} }) };
    const watch = startGlobalModelWatch({ env, fs: deafFs, debounceMs: 10, pollMs: 50 });
    try {
      await writeFile(`${path}.tmp`, JSON.stringify({ model: ROUTE_ID }));
      await fs.promises.rename(`${path}.tmp`, path);
      const deadline = Date.now() + 5_000;
      while (JSON.parse(await readFile(path, "utf8")).model !== "opus" && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.equal(JSON.parse(await readFile(path, "utf8")).model, "opus");
    } finally {
      watch.stop();
    }
  });
});

test("a launch that started from a CCR-only value has nothing to restore to and writes nothing", async () => {
  await withHome(async ({ env, path }) => {
    await writeFile(path, JSON.stringify({ model: ROUTE_ID }));
    const watch = startGlobalModelWatch({ env, watch: false });
    await writeFile(path, JSON.stringify({ model: "anthropic/claude-ccr-h626262" }));
    assert.deepEqual(watch.stop().restored, []);
    assert.equal(JSON.parse(await readFile(path, "utf8")).model, "anthropic/claude-ccr-h626262");
  });
});

test("a second session's legitimate change is not clobbered by the first session's snapshot", async () => {
  await withHome(async ({ env, path }) => {
    await writeFile(path, JSON.stringify({ model: "opus" }));
    const first = startGlobalModelWatch({ env, watch: false });
    const second = startGlobalModelWatch({ env, watch: false });
    await writeFile(path, JSON.stringify({ model: "haiku" }));
    second.check();
    first.check();
    await writeFile(path, JSON.stringify({ model: ROUTE_ID }));
    second.stop();
    first.stop();
    assert.equal(JSON.parse(await readFile(path, "utf8")).model, "haiku");
  });
});

test("a symlinked settings.json is restored through the link and stays a link", async () => {
  await withHome(async ({ home, env, path }) => {
    const target = join(home, "dotfiles", "claude-settings.json");
    await mkdir(join(home, "dotfiles"));
    await writeFile(target, JSON.stringify({ model: "opus", env: { A: "1" } }));
    await symlink(target, path);
    const watch = startGlobalModelWatch({ env, watch: false });
    await writeFile(target, JSON.stringify({ model: ROUTE_ID, env: { A: "1" } }));
    watch.stop();
    assert.ok((await lstat(path)).isSymbolicLink());
    assert.deepEqual(JSON.parse(await readFile(target, "utf8")), { model: "opus", env: { A: "1" } });
  });
});

test("a write that lands between the read and the rename wins over the restore", async () => {
  await withHome(async ({ env, path }) => {
    await writeFile(path, JSON.stringify({ model: "opus" }));
    let reads = 0;
    const racing = {
      ...fs,
      readFileSync(file, encoding) {
        const text = fs.readFileSync(file, encoding);
        // Read 1 is the launch snapshot, read 3 the pre-rename re-check: Claude Code writes first.
        if (String(file).endsWith("settings.json") && ++reads === 3) {
          fs.writeFileSync(path, JSON.stringify({ model: ROUTE_ID, theme: "light" }));
          return fs.readFileSync(file, encoding);
        }
        return text;
      },
    };
    const watch = startGlobalModelWatch({ env, watch: false, fs: racing });
    await writeFile(path, JSON.stringify({ model: ROUTE_ID }));
    watch.check();
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { model: ROUTE_ID, theme: "light" });
    assert.deepEqual((await readdir(join(path, ".."))).sort(), ["settings.json"]);
    watch.stop();
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { model: "opus", theme: "light" });
  });
});

test("unparseable or missing files are never rewritten", async () => {
  await withHome(async ({ env, path }) => {
    await writeFile(path, JSON.stringify({ model: "opus" }));
    const watch = startGlobalModelWatch({ env, watch: false });
    await writeFile(path, `{"model": "${ROUTE_ID}",`);
    watch.check();
    assert.equal(await readFile(path, "utf8"), `{"model": "${ROUTE_ID}",`);
    await rm(path);
    assert.deepEqual(watch.stop().restored, []);
    await assert.rejects(readFile(path, "utf8"), /ENOENT/);
  });
});

test("the notice says what was kept out and that the choice still holds in this session", () => {
  assert.equal(globalModelRestoreNotice({ path: "/h/.claude/settings.json", restored: [] }), "");
  const notice = globalModelRestoreNotice({ path: "/h/.claude/settings.json", restored: [{ from: ROUTE_ID, to: null }] });
  assert.equal(notice.split("\n").filter(Boolean).length, 1);
  assert.match(notice, /kept out of \/h\/\.claude\/settings\.json \(left "model" unset\)/);
  assert.match(notice, /still applies to the current session/);
});

test("SIGINT and SIGTERM restore before the signal is re-raised with the handlers gone", async () => {
  await withHome(async ({ env, path }) => {
    await writeFile(path, JSON.stringify({ model: "opus" }));
    const proc = new EventEmitter();
    const killed = [];
    const errors = [];
    proc.pid = 4242;
    proc.stderr = { write: (chunk) => errors.push(chunk) };
    proc.kill = (pid, signal) => killed.push([pid, signal, proc.listenerCount(signal)]);
    const watch = startGlobalModelWatch({ env, watch: false });
    withSignalRestore(watch, proc);
    await writeFile(path, JSON.stringify({ model: ROUTE_ID }));
    proc.emit("SIGTERM");
    assert.equal(JSON.parse(await readFile(path, "utf8")).model, "opus");
    assert.deepEqual(killed, [[4242, "SIGTERM", 0]]);
    assert.equal(proc.listenerCount("SIGINT"), 0);
    assert.match(errors.join(""), /kept out of/);
  });
});
