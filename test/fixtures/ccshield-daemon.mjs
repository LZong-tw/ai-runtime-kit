import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A stand-in ccshield lane laid out the way ccshield 01b49e8 writes it: an HTTP
// listener on 127.0.0.1:<random> published as identity.origin, and no shield.sock.
export const CCSHIELD_CAPABILITY = "d".repeat(32);
export const CCSHIELD_CONTROL_CAPABILITY = "e".repeat(32);
export const CCSHIELD_POLICY = Object.freeze({
  version: "airkit-subscription-opf-2026.09.30-secret-redact",
  detectorVersions: Object.freeze({ gitleaks: "8.30.1", privacy: "opf-1-client-exempt" }),
});

export async function startCcshieldFixture({ lane = "subscription", identity: override = {}, listen = true, home } = {}) {
  home ??= await mkdtemp(join(tmpdir(), "airkit-ccshield-"));
  const root = join(home, ".local", "share", "ccshield", lane);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const requests = [];
  let server = null;
  let origin = "http://127.0.0.1:9";
  if (listen) {
    server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        requests.push({
          method: request.method,
          path: request.url,
          shield: request.headers["x-airkit-shield"],
          control: request.headers["x-airkit-shield-control"],
          body: body ? JSON.parse(body) : null,
        });
        const ready = request.url === "/_airkit/shield/ready" && request.headers["x-airkit-shield"] === CCSHIELD_CAPABILITY;
        const control = request.url !== "/_airkit/shield/ready" && request.headers["x-airkit-shield-control"] === CCSHIELD_CONTROL_CAPABILITY;
        response.statusCode = ready || control ? 204 : 401;
        response.end();
      });
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${server.address().port}`;
  }
  const generation = "ccshield-generation-1";
  const identity = {
    origin,
    capability: CCSHIELD_CAPABILITY,
    version: 1,
    pid: process.pid,
    lane,
    generation,
    targetClass: lane,
    policyVersion: CCSHIELD_POLICY.version,
    detectorVersions: CCSHIELD_POLICY.detectorVersions,
    media: { documents: "blocked", images: "unscanned" },
    ...override,
  };
  await writeFile(join(root, "identity.json"), JSON.stringify(identity), { mode: 0o600 });
  await writeFile(join(root, "config.json"), JSON.stringify({
    capability: CCSHIELD_CAPABILITY,
    controlCapability: CCSHIELD_CONTROL_CAPABILITY,
    lane,
    generation,
    targetClass: lane,
    ...(lane === "subscription" ? { targetOrigin: "https://api.anthropic.com" } : {}),
  }), { mode: 0o600 });
  await writeFile(join(root, "policy-state.json"), JSON.stringify(CCSHIELD_POLICY), { mode: 0o600 });
  return {
    home,
    root,
    origin,
    identity,
    requests,
    env: { HOME: home, AIRKIT_GUI_UID: String(process.getuid()) },
    legacyRoot: join(home, ".local", "state", "airkit-shield", lane),
    async close() {
      if (server) await new Promise((resolve) => server.close(resolve));
      await rm(home, { recursive: true, force: true });
    },
  };
}
