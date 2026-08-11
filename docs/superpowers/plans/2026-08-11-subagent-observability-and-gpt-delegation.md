# Subagent Observability and GPT Delegation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show durable, bounded subagent progress outside Claude Code's collapsed child view and make GPT-backed AirClaude modes delegate only when parallel work is justified.

**Architecture:** Add a small OSS observer module that incrementally projects child JSONL into an AirKit-owned timeline and a `subagentStatusLine` row. Wire it into the generated additive AirKit context plugin without changing the user's ccstatusline or model context. Update the internal OnePortal catalog and documented example so every GPT mode receives the same delegation discipline.

**Tech Stack:** Node.js 22 ESM, `node:test`, Claude Code plugin hooks, JSONL, AirKit profile catalog JSON.

## Global Constraints

- Keep raw child JSONL as source of truth; never rewrite it or inject observer data into parent context.
- Timeline records only prose, tool metadata, offsets, and diagnostics; never tool-result bodies, secrets, or raw JSON.
- Timeline/state files use atomic writes and mode `0600`.
- `subagentStatusLine` is additive and must not replace the user `statusLine` / ccstatusline.
- Apply GPT delegation guidance to every GPT-backed internal mode, and no non-GPT mode.
- Preserve explicit user delegation and skill/project-rule-required agents.
- Do not create a replacement child merely because a child is running, retrying, or waiting on permissions.

---

## File Structure

- `src/subagent-observability.mjs` — child transcript parsing, incremental observer state/timeline persistence, and panel-row rendering.
- `src/context-heartbeat.mjs` — invoke the observer from AirKit hooks and render the generated `subagentStatusLine` plugin script/settings.
- `test/airkit.test.mjs` — fixture-level observer and generated-plugin integration coverage.
- `profiles/catalog.json` — canonical internal profile definitions and GPT delegation prompt.
- `docs/examples/oneportal-lowcost.profile.json` — user-facing profile example synchronized with the catalog.
- `test/airkit.test.mjs` in the internal overlay — assert prompt parity across all GPT modes and absence on other families.

### Task 1: Add the child transcript projection module

**Files:**
- Create: `src/subagent-observability.mjs`
- Modify: `test/airkit.test.mjs:1-20, 2860-2945`

**Interfaces:**
- Produces: `processSubagentObservabilityHook(input, env): Promise<null>`
- Produces: `renderSubagentStatusLine(input, env): Promise<string[]>`
- Produces: `runSubagentStatusLine({ env, input, output }): Promise<void>`
- Consumes: hook inputs with `hook_event_name`, `session_id`, `transcript_path`, `agent_id`, `tool_name`, and `tool_response`.

- [ ] **Step 1: Write failing observer fixture tests**

  Add imports and a fixture whose child JSONL contains an assistant text block, a `Bash` tool call, a very large tool result, a second assistant text block, and a repeated record. Assert the persisted timeline contains the two prose messages and `Bash`, excludes the large result body, has mode `0o600`, and is unchanged after a second observation:

  ```js
  const response = await processSubagentObservabilityHook({
    hook_event_name: "PostToolUse",
    session_id: "parent-1",
    transcript_path: childTranscript,
  }, { CLAUDE_PLUGIN_DATA: pluginData });
  assert.equal(response, null);
  const timeline = await readFile(timelinePath, "utf8");
  assert.match(timeline, /first child update/);
  assert.match(timeline, /tool: Bash/);
  assert.match(timeline, /second child update/);
  assert.doesNotMatch(timeline, /very-large-tool-result/);
  assert.equal((await stat(timelinePath)).mode & 0o777, 0o600);
  ```

- [ ] **Step 2: Run the focused test and verify it fails**

  Run: `node --test test/airkit.test.mjs --test-name-pattern="subagent observability"`

  Expected: FAIL because `processSubagentObservabilityHook` is not exported.

- [ ] **Step 3: Implement incremental, safe projection**

  Create `src/subagent-observability.mjs` with these exact exported contracts:

  ```js
  export async function processSubagentObservabilityHook(input, env = process.env) {
    if (!isSubagentLifecycleEvent(input) || !validPluginData(env)) return null;
    await observeChildTranscript(input, env);
    return null;
  }

  export async function renderSubagentStatusLine(input, env = process.env) {
    const rows = [];
    for (const task of Array.isArray(input?.tasks) ? input.tasks : []) {
      rows.push(await renderTaskRow(task, input, env));
    }
    return rows;
  }
  ```

  `observeChildTranscript` must read from the persisted byte offset, parse newline-complete JSON records only, project assistant text and tool names, replace each tool result with a byte-count marker, and atomically save `.state.json` plus `.md` under `subagent-timelines/<safe-parent-id>/<safe-child-id>/`. Invalid/missing records return successfully after a diagnostic line; they do not throw or return `additionalContext`.

- [ ] **Step 4: Add row-rendering tests before implementation completion**

  Extend the same fixture test to pass `tasks` containing the child name and token/elapsed data. Assert `renderSubagentStatusLine` returns a single-line JSON-row payload with the latest prose and tool; assert an ambiguous mapping returns `waiting for first event` or `ambiguous child transcript`, never another child's prose.

- [ ] **Step 5: Implement row rendering and CLI adapter**

  Implement `runSubagentStatusLine` to read one JSON object from stdin, call `renderSubagentStatusLine`, and write one JSON line per row in Claude Code's required shape:

  ```js
  output.write(`${JSON.stringify({ id: task.id, content })}\n`);
  ```

  Bound prose to one line and 160 visible characters. Include elapsed/token fields only when supplied by Claude Code. Match a task only when one child identity is unambiguous.

- [ ] **Step 6: Run focused tests and commit**

  Run: `node --test test/airkit.test.mjs --test-name-pattern="subagent observability"`

  Expected: PASS.

  ```bash
  git add src/subagent-observability.mjs test/airkit.test.mjs
  git commit -m "Add subagent progress observability"
  ```

### Task 2: Render the additive plugin integration

**Files:**
- Modify: `src/context-heartbeat.mjs:1-20, 72-108, 293-360`
- Modify: `src/airkit.mjs:833-850`
- Modify: `test/airkit.test.mjs:3070-3150`

**Interfaces:**
- Consumes: `processSubagentObservabilityHook` and `runSubagentStatusLine` from `src/subagent-observability.mjs`.
- Produces: generated `plugins/airkit-context/settings.json` with `subagentStatusLine` and `scripts/subagent-statusline.mjs`.

- [ ] **Step 1: Write failing generated-plugin tests**

  Extend `AirClaude renders an additive session plugin for the heartbeat` to require both generated files and both lifecycle hook names:

  ```js
  const settings = managed.find((file) => file.path.endsWith("/settings.json"));
  const statusline = managed.find((file) => file.path.endsWith("/scripts/subagent-statusline.mjs"));
  assert.ok(settings);
  assert.ok(statusline);
  const renderedSettings = JSON.parse(await readFile(settings.path, "utf8"));
  assert.equal(renderedSettings.subagentStatusLine.command.includes("subagent-statusline.mjs"), true);
  assert.ok(renderedHooks.SubagentStart);
  assert.ok(renderedHooks.SubagentStop);
  assert.equal(renderedSettings.statusLine, undefined);
  ```

- [ ] **Step 2: Run the focused test and verify it fails**

  Run: `node --test test/airkit.test.mjs --test-name-pattern="additive session plugin"`

  Expected: FAIL because the settings file, statusline script, and lifecycle hooks are absent.

- [ ] **Step 3: Wire the observer without context injection**

  Import `processSubagentObservabilityHook` into `context-heartbeat.mjs` and call it inside `processContextHook` for `SubagentStart`, `PostToolUse`, and `SubagentStop`; ignore its return value and continue existing behavior. In `renderHeartbeatManagedFiles`, add `SubagentStart` and `SubagentStop` entries using the existing heartbeat script, plus generated `settings.json` and `scripts/subagent-statusline.mjs` that import from the runtime module by absolute serialized URL. In `exportOssRelease`, copy `subagent-observability.mjs` alongside `context-heartbeat.mjs`; otherwise the exported runtime fails its ESM import at startup.

  The generated settings must be structurally:

  ```js
  {
    subagentStatusLine: {
      type: "command",
      command: `node ${JSON.stringify(join(root, "scripts", "subagent-statusline.mjs"))}`,
      refreshInterval: 1,
    },
  }
  ```

- [ ] **Step 4: Run integration tests and commit**

  Run: `node --test test/airkit.test.mjs --test-name-pattern="additive session plugin|subagent observability"`

  Expected: PASS. Confirm `statusLine` is not emitted by the generated plugin.

  ```bash
  git add src/context-heartbeat.mjs src/airkit.mjs test/airkit.test.mjs
  git commit -m "Render additive subagent statusline plugin"
  ```

### Task 3: Apply and verify GPT delegation discipline

**Files:**
- Modify: `profiles/catalog.json`
- Modify: `docs/examples/oneportal-lowcost.profile.json`
- Modify: `test/airkit.test.mjs:230-285`

**Interfaces:**
- Produces: identical `appendSystemPrompt` text on all GPT mode entries in catalog and example.
- Consumes: existing `launch.modes.<mode>.appendSystemPrompt` validation and `buildLaunchPlan` serialization.

- [ ] **Step 1: Write the failing all-GPT-mode parity test**

  Replace the existing single-mode GPT assertion with the explicit GPT mode list:

  ```js
  const gptModes = [
    "gpt-oneportal", "gpt-oneportal-luna", "gpt-oneportal-sol",
    "gpt-oneportal-sol-luna", "gpt-oneportal-sol-terra", "gpt-teamweb",
    "gpt-teamweb-sol", "gpt-teamweb-sol-luna", "gpt-teamweb-sol-terra",
  ];
  for (const mode of gptModes) {
    assert.match(profile.launch.modes[mode].appendSystemPrompt, /^GPT delegation discipline:/);
    assert.match(profile.launch.modes[mode].appendSystemPrompt, /three genuinely independent work streams/);
    assert.equal(example.launch.modes[mode].appendSystemPrompt, profile.launch.modes[mode].appendSystemPrompt);
  }
  ```

  Keep explicit absence assertions for DeepSeek, GLM, Kimi, plain, and web modes.

- [ ] **Step 2: Run the focused test and verify it fails**

  Run: `node --test test/airkit.test.mjs --test-name-pattern="GPT delegation discipline"`

  Expected: FAIL because only `gpt-oneportal` currently has a GPT prompt.

- [ ] **Step 3: Add the shared prompt without hard blocking delegation**

  Add this exact text to each GPT mode in both JSON files:

  ```text
  GPT delegation discipline: Work directly by default. Create a subagent only when the user explicitly asks, an active skill or project rule requires it, or at least three genuinely independent work streams benefit from parallel execution. Do not delegate linear work, a single lookup, a retry, or a permission failure. Do not create a duplicate or replacement agent while equivalent work is still active.
  ```

  Retain current completion guards exactly as configured; this task changes delegation wording only.

- [ ] **Step 4: Run catalog tests and commit**

  Run: `node --test test/airkit.test.mjs --test-name-pattern="GPT delegation discipline|DeepSeek evidence prompt"`

  Expected: PASS.

  ```bash
  git add profiles/catalog.json docs/examples/oneportal-lowcost.profile.json test/airkit.test.mjs
  git commit -m "Guide GPT subagent delegation"
  ```

### Task 4: Full verification and fresh-session smoke test

**Files:**
- No source changes expected.

**Interfaces:**
- Consumes: OSS runtime implementation and internal overlay catalog.
- Produces: verified generated plugin files and a fresh-session observation.

- [ ] **Step 1: Run OSS verification**

  Run:

  ```bash
  npm test
  npm run check
  ```

  Expected: both commands exit `0`.

- [ ] **Step 2: Run internal overlay verification**

  Run from `/Users/untionglim/projects/web/ai-runtime-kit`:

  ```bash
  npm test
  npm run check
  ```

  Expected: both commands exit `0`.

- [ ] **Step 3: Install and inspect generated artifacts**

  Run from the internal overlay:

  ```bash
  node src/airkit.mjs init --profile oneportal-lowcost --write
  node src/airkit.mjs doctor --profile oneportal-lowcost
  ```

  Expected: the doctor reports current managed files, including the AirKit context plugin settings and subagent statusline script, with no replacement of the user's existing statusline.

- [ ] **Step 4: Fresh GPT smoke test**

  Start a new `airclaude gpt-oneportal` session and request one explicitly parallel task. Confirm an agent-panel row shows a recent child tool/prose update, inspect the `subagent-timelines` file for full readable activity, and confirm no timeline text appears in the parent model response. Then issue a single linear task and confirm the model works directly.

- [ ] **Step 5: Commit verification-only fixes if needed, then push/release only on explicit request**

  Do not change versions, publish, or push as part of verification. If verification requires a source correction, add focused regression coverage, rerun all four verification commands, and make a separate corrective commit.
