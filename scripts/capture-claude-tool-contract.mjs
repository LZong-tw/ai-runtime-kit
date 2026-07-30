#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { access, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CHILD_TIMEOUT_MS = 30_000;

export async function runCapture({ claudePath = "claude", tool = "WebSearch" } = {}) {
  if (tool !== "WebSearch") throw new Error(`Unsupported capture tool: ${tool}`);
  if (process.platform !== "darwin") {
    return {
      status: "unsupported",
      reason: "Real Claude containment requires macOS sandbox-exec.",
    };
  }
  try {
    await access("/usr/bin/sandbox-exec");
  } catch {
    return {
      status: "unsupported",
      reason: "macOS sandbox-exec is unavailable.",
    };
  }

  const root = await mkdtemp(join(tmpdir(), "airkit-claude-tool-contract-"));
  const home = join(root, "home");
  const configDir = join(root, "claude-config");
  const workspace = join(root, "workspace");
  const requests = [];
  const providerResponses = [];
  const unexpectedNetwork = [];
  await Promise.all([home, configDir, workspace].map((path) => mkdir(path, { recursive: true })));
  await writeFile(join(home, ".claude.json"), JSON.stringify({
    customApiKeyResponses: { approved: ["fixture-key"], rejected: [] },
    hasCompletedOnboarding: true,
    projects: { [workspace]: { hasTrustDialogAccepted: true } },
  }));

  const server = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      let body = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        response.writeHead(400).end();
        return;
      }
      if (request.method !== "POST" || !request.url?.startsWith("/v1/messages")) {
        unexpectedNetwork.push({ method: request.method, url: request.url });
        response.writeHead(404).end();
        return;
      }
      requests.push({ body, headers: request.headers, url: request.url });
      const providerResponse = requests.length === 1
        ? webSearchToolUseResponse(body.model)
        : textResponse(body.model);
      providerResponses.push(providerResponse);
      writeProviderResponse(response, providerResponse);
    });
  });
  server.on("connect", (request, socket) => {
    unexpectedNetwork.push({ method: "CONNECT", url: request.url });
    socket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
  });

  try {
    await listen(server);
    const port = server.address().port;
    const env = isolatedClaudeEnvironment({ configDir, home, port });
    const claudeExecutable = await realpath(await resolveCommand(claudePath));
    const realHome = resolve(homedir());
    const sandboxProfile = createSandboxProfile({ claudeExecutable, realHome });
    const version = await runSandboxedClaude({
      args: ["--version"],
      claudeExecutable,
      cwd: workspace,
      env,
      sandboxProfile,
    });
    assert.equal(version.status, 0, `Claude version probe failed: ${version.stderr}`);
    const childArgs = [
      "--safe-mode",
      "--model", "claude-sonnet-5",
      "--permission-mode", "dontAsk",
      "--tools", "WebSearch",
      "--allowedTools", "WebSearch",
      "--no-session-persistence",
      "--output-format", "json",
      "--print",
      "Use WebSearch to look up the AirKit loopback contract fixture.",
    ];
    const child = await runSandboxedClaude({
      args: childArgs,
      claudeExecutable,
      cwd: workspace,
      env,
      sandboxProfile,
    });
    assert.equal(child.status, 0, `Claude wire capture failed: ${child.stderr || child.stdout}`);
    assert.ok(requests.length > 0, "Claude did not send a messages request");

    const initial = requests[0].body;
    const initialTools = (initial.tools ?? []).flatMap((entry) => {
      const values = [entry?.name];
      if (String(entry?.type ?? "").startsWith("web_search_")) values.push("WebSearch");
      return values.filter(Boolean);
    });
    const toolUse = providerResponses[0]?.content?.find((block) => block.type === "tool_use");
    const continuationIndex = requests.findIndex((request, index) =>
      index > 0 && findContentBlocks(request.body).some((block) =>
        block.type === "tool_result" && block.tool_use_id === toolUse?.id));
    assert.ok(toolUse?.id, "fake provider did not emit a tool use");
    assert.notEqual(continuationIndex, -1, "Claude did not continue with the WebSearch tool result");
    const toolResult = findContentBlocks(requests[continuationIndex].body)
      .find((block) => block.type === "tool_result" && block.tool_use_id === toolUse.id);
    const stateTrace = {
      args: childArgs,
      cwd: workspace,
      env: {
        HOME: env.HOME,
        CLAUDE_CONFIG_DIR: env.CLAUDE_CONFIG_DIR,
        ANTHROPIC_BASE_URL: env.ANTHROPIC_BASE_URL,
      },
      requests,
    };

    return {
      status: "enforced",
      claudeVersion: version.stdout.trim().split(/\s+/).find((value) => /^\d+\.\d+\.\d+$/.test(value)) ?? "unknown",
      initialTools: [...new Set(initialTools)].sort(),
      serverTypes: [toolUse.type, toolResult.type],
      toolUseId: toolUse.id,
      continuation: { requestIndex: continuationIndex, toolResultId: toolResult.tool_use_id },
      loopbackEnforced: true,
      loopbackOnly: unexpectedNetwork.length === 0,
      realHomeAccessDenied: true,
      realHomeReferenced: JSON.stringify(stateTrace).includes(realHome),
    };
  } finally {
    await new Promise((done) => server.close(done));
    await rm(root, { force: true, recursive: true });
  }
}

async function resolveCommand(command) {
  if (isAbsolute(command)) return command;
  for (const directory of String(process.env.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, command);
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Keep searching PATH.
    }
  }
  throw new Error(`Claude executable not found: ${command}`);
}

function createSandboxProfile({ claudeExecutable, realHome }) {
  const metadataPaths = ancestorPaths(claudeExecutable, realHome);
  return [
    "(version 1)",
    "(allow default)",
    `(deny file-read* file-write* (subpath ${sandboxLiteral(realHome)}))`,
    ...metadataPaths.map((path) => `(allow file-read-metadata (literal ${sandboxLiteral(path)}))`),
    `(allow file-read* (literal ${sandboxLiteral(claudeExecutable)}))`,
    "(deny network*)",
    '(allow network-outbound (remote ip "localhost:*"))',
  ].join(" ");
}

function ancestorPaths(path, stop) {
  const paths = [];
  for (let current = dirname(path); current === stop || current.startsWith(`${stop}/`); current = dirname(current)) {
    paths.push(current);
    if (current === stop) break;
  }
  return paths;
}

function sandboxLiteral(value) {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function runSandboxedClaude({ args, claudeExecutable, cwd, env, sandboxProfile }) {
  return runChild("/usr/bin/sandbox-exec", [
    "-p",
    sandboxProfile,
    claudeExecutable,
    ...args,
  ], { cwd, env });
}

function isolatedClaudeEnvironment({ configDir, home, port }) {
  return {
    HOME: home,
    CLAUDE_CONFIG_DIR: configDir,
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    LANG: process.env.LANG ?? "C.UTF-8",
    NO_PROXY: "127.0.0.1,localhost",
    HTTP_PROXY: `http://127.0.0.1:${port}`,
    HTTPS_PROXY: `http://127.0.0.1:${port}`,
    ALL_PROXY: `http://127.0.0.1:${port}`,
    ANTHROPIC_API_KEY: "fixture-key",
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "0",
  };
}

function webSearchToolUseResponse(model) {
  return {
    model,
    stopReason: "tool_use",
    content: [{
      type: "tool_use",
      id: "toolu_airkit_contract",
      name: "WebSearch",
      input: {},
    }],
  };
}

function textResponse(model) {
  return {
    model,
    stopReason: "end_turn",
    content: [{ type: "text", text: "FAKE_PROVIDER_OK" }],
  };
}

function writeProviderResponse(response, providerResponse) {
  response.writeHead(200, { "content-type": "text/event-stream" });
  sendEvent(response, "message_start", {
    type: "message_start",
    message: {
      id: "msg_airkit_contract",
      type: "message",
      role: "assistant",
      model: providerResponse.model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 0 },
    },
  });
  providerResponse.content.forEach((contentBlock, index) => {
    sendEvent(response, "content_block_start", { type: "content_block_start", index, content_block: contentBlock });
    sendEvent(response, "content_block_stop", { type: "content_block_stop", index });
  });
  sendEvent(response, "message_delta", {
    type: "message_delta",
    delta: { stop_reason: providerResponse.stopReason, stop_sequence: null },
    usage: { output_tokens: 1 },
  });
  sendEvent(response, "message_stop", { type: "message_stop" });
  response.end();
}

function findContentBlocks(body) {
  return (body.messages ?? []).flatMap((message) =>
    Array.isArray(message.content) ? message.content : []);
}

function sendEvent(response, event, data) {
  response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

async function listen(server) {
  await new Promise((done, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", done);
  });
}

async function runChild(command, args, options) {
  const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const timer = setTimeout(() => child.kill("SIGKILL"), CHILD_TIMEOUT_MS);
  let result;
  try {
    result = await new Promise((done, reject) => {
      child.once("error", reject);
      child.once("close", (status, signal) => done({ signal, status, stderr, stdout }));
    });
  } finally {
    clearTimeout(timer);
  }
  if (result.signal === "SIGKILL") throw new Error(`Claude capture exceeded ${CHILD_TIMEOUT_MS}ms`);
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCapture({ claudePath: process.env.CLAUDE_PATH ?? "claude", tool: process.argv[2] ?? "WebSearch" })
    .then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
    .catch((error) => {
      process.stderr.write(`${error.stack ?? error}\n`);
      process.exitCode = 1;
    });
}
