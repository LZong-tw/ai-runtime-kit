import { spawn } from "node:child_process";
import { createServer, connect } from "node:net";

export const ANTHROPIC_ORIGIN = "https://api.anthropic.com";

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function probe(port) {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("error", () => resolve(false));
  });
}

// Starts a per-launch pxpipe between Shield and the gateway. Shield sees the
// pxpipe origin as its fixed target; pxpipe forwards to `upstream`. pxpipe
// only ever receives traffic Shield already redacted.
export async function startPxpipeHop({ upstream, command = "pxpipe", env = process.env, spawnProcess = spawn, timeoutMs = 10_000 } = {}) {
  const target = new URL(upstream);
  const loopback = target.hostname === "127.0.0.1" && target.protocol === "http:";
  if (!loopback && target.origin !== ANTHROPIC_ORIGIN) {
    throw new Error("pxpipe hop upstream must be a loopback http origin or the Anthropic API");
  }
  const port = await freePort();
  const child = spawnProcess(command, [], {
    env: {
      ...env,
      HOST: "127.0.0.1",
      PORT: String(port),
      PXPIPE_UPSTREAM: target.origin,
      ANTHROPIC_UPSTREAM: target.origin,
    },
    stdio: "ignore",
  });
  let exited = null;
  child.once("exit", (code) => { exited = code ?? -1; });
  child.once("error", () => { exited = -1; });
  const deadline = Date.now() + timeoutMs;
  while (!(await probe(port))) {
    if (exited !== null) throw new Error(`pxpipe exited before listening (code ${exited})`);
    if (Date.now() > deadline) {
      child.kill("SIGTERM");
      throw new Error("pxpipe did not start listening in time");
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return {
    origin: `http://127.0.0.1:${port}`,
    async close() {
      if (exited === null) child.kill("SIGTERM");
    },
  };
}
