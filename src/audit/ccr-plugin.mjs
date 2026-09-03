import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { resolveAuditPaths } from "./paths.mjs";
import { createAuditQueryClient } from "./query.mjs";
import { createAuditUiAdapter } from "./ui-contract.mjs";
import { readShieldOperationalStatus } from "../shield/operational-status.mjs";

const PLUGIN_ID = "airkit-audit-ui";
const API_PATH = "/api";
const QUERY_NAMES = ["requests", "sessions", "clients", "accounts", "repos", "usage", "cache", "gaps", "shield_decisions", "shield_policy_transitions"];
const DETAIL_QUERY_NAMES = new Set(["request", "shield_decision"]);

export default {
  async setup(ctx) {
    const paths = resolveAuditPaths({
      env: process.env,
      overrides: {
        rootDir: ctx.pluginConfig?.auditRootDir,
        querySocketPath: ctx.pluginConfig?.auditQuerySocketPath,
      },
    });
    const capabilityFile = ctx.pluginConfig?.capabilityFile ?? `${paths.rootDir}/capability`;
    const createQueryClient = ctx.createAuditQueryClient ?? createAuditQueryClient;
    const shieldStatus = ctx.shieldStatus ?? readShieldOperationalStatus;
    let clientPromise;
    const query = async (name, args = []) => {
      const client = await getClient();
      const result = await client.query(name, DETAIL_QUERY_NAMES.has(name) ? { id: args[0] } : {});
      return { state: "healthy", rows: result.rows };
    };
    const status = async () => {
      try {
        await query("clients");
        return { state: "healthy", database: { present: true, ok: true }, service: { loaded: true }, shield: await shieldUiStatus("healthy") };
      } catch {
        return { state: "degraded", database: { present: false, ok: false }, service: { loaded: false }, shield: await shieldUiStatus("unavailable") };
      }
    };
    const adapter = createAuditUiAdapter({ query, status });
    let bootstrapToken = randomToken();
    const sessions = new Map();
    const backend = await ctx.registerHttpBackend({
      id: PLUGIN_ID,
      host: "127.0.0.1",
      port: 0,
      async handler(request, response) {
        const url = new URL(request.url ?? "/", "http://airkit-audit.local");
        const session = sessions.get(readCookie(request.headers?.cookie, "airkit_audit_session"));
        if (request.method !== "GET") return sendJson(response, 405, { error: "method_not_allowed" });

        if (url.pathname === "/") {
          const supplied = url.searchParams.get("bootstrap");
          if (supplied !== null) {
            if (!bootstrapToken || supplied !== bootstrapToken) return sendJson(response, 410, { error: "bootstrap_expired" });
            bootstrapToken = null;
            await rm(paths.uiBootstrapPath, { force: true });
            const sessionId = randomToken();
            sessions.set(sessionId, { createdAt: Date.now() });
            response.writeHead(200, {
              "content-type": "text/html; charset=utf-8",
              "cache-control": "no-store",
              "set-cookie": `airkit_audit_session=${sessionId}; HttpOnly; SameSite=Strict; Path=/; Max-Age=1800`,
            });
            response.end(AUDIT_PAGE_HTML);
            return;
          }
          if (!session) return sendJson(response, 401, { error: "audit_session_required" });
          response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
          response.end(AUDIT_PAGE_HTML);
          return;
        }

        if (!session) return sendJson(response, 401, { error: "audit_session_required" });
        if (url.pathname === `${API_PATH}/status`) return sendJson(response, 200, await adapter.status());
        if (url.pathname === `${API_PATH}/query`) {
          const name = url.searchParams.get("name") ?? "";
          const id = url.searchParams.get("id");
          return sendJson(response, 200, await adapter.query(name, id ? [id] : []));
        }
        return sendJson(response, 404, { error: "not_found" });
      },
    });
    const appUrl = `${backend.url}/?bootstrap=${encodeURIComponent(bootstrapToken)}`;
    await publishBootstrapUrl(paths.uiBootstrapPath, appUrl);
    ctx.registerApp({
      id: "airkit-audit",
      name: "AirKit Audit",
      description: "Metadata-only local audit and evidence gaps",
      url: appUrl,
    });

    async function getClient() {
      if (!clientPromise) {
        clientPromise = readFile(capabilityFile, "utf8").then((capability) => createQueryClient({
          socketPath: paths.querySocketPath,
          capability: capability.trim(),
        }));
      }
      return clientPromise;
    }

    async function shieldUiStatus(audit) {
      try {
        return await shieldStatus({ audit });
      } catch {
        return { state: "unavailable" };
      }
    }
  },
};

function randomToken() {
  return randomBytes(24).toString("base64url");
}

async function publishBootstrapUrl(path, url) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${url}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(path, 0o600);
}

function readCookie(header, name) {
  if (typeof header !== "string") return "";
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index < 0 || part.slice(0, index).trim() !== name) continue;
    return decodeURIComponent(part.slice(index + 1).trim());
  }
  return "";
}

function sendJson(response, status, body) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

const AUDIT_PAGE_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AirKit Audit</title><style>
body{margin:24px;background:#111827;color:#e5e7eb;font:14px system-ui,sans-serif}section{margin-top:18px;padding:14px;border:1px solid #374151;border-radius:8px;background:#1f2937}h1{margin-bottom:4px}p{color:#9ca3af}.state{padding:4px 8px;border-radius:5px;background:#92400e}.state.healthy{background:#065f46}button{padding:5px 10px;border:0;border-radius:5px;background:#2563eb;color:white}table{border-collapse:collapse;width:100%;font-size:12px}th,td{padding:5px 7px;text-align:left;border-bottom:1px solid #374151;white-space:pre-wrap;vertical-align:top}th{color:#9ca3af}
</style></head><body><h1>AirKit Audit</h1><p>Metadata-only local audit view. Payloads, credentials, paths, and raw request bodies are not shown.</p>
<div>Service: <span id="state" class="state">loading</span> <button id="refresh">Refresh</button></div><div id="content"></div>
<script>
const names=${JSON.stringify(QUERY_NAMES)};const esc=v=>String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
async function load(){const s=await fetch("${API_PATH}/status").then(r=>r.json()).catch(()=>({state:"degraded"}));const b=document.getElementById("state");b.textContent=s.state||"degraded";b.className="state "+(s.state||"degraded");const out=[];for(const n of names){const q=await fetch("${API_PATH}/query?name="+encodeURIComponent(n)).then(r=>r.json()).catch(()=>({rows:[]}));const rows=q.rows||[];if(!rows.length){out.push("<section><h2>"+esc(n)+"</h2><p>No metadata captured.</p></section>");continue}const cols=Object.keys(rows[0]);out.push("<section><h2>"+esc(n)+" ("+rows.length+")</h2><table><thead><tr>"+cols.map(c=>"<th>"+esc(c)+"</th>").join("")+"</tr></thead><tbody>"+rows.map(r=>"<tr>"+cols.map(c=>"<td>"+esc(r[c])+"</td>").join("")+"</tr>").join("")+"</tbody></table></section>")}document.getElementById("content").innerHTML=out.join("")};document.getElementById("refresh").onclick=load;load();
</script></body></html>`;
