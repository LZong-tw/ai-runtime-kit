import { readFile } from "node:fs/promises";

import { resolveAuditPaths } from "./paths.mjs";
import { createAuditQueryClient } from "./query.mjs";
import { createAuditUiAdapter } from "./ui-contract.mjs";

const PLUGIN_ID = "airkit-audit-ui";
const PAGE_PATH = "/plugins/airkit-audit";
const API_PATH = `${PAGE_PATH}/api`;
const QUERY_NAMES = ["requests", "sessions", "clients", "accounts", "repos", "usage", "cache", "gaps"];

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
    let clientPromise;
    const query = async (name, args = []) => {
      const client = await getClient();
      const result = await client.query(name, name === "request" ? { id: args[0] } : {});
      return { state: "healthy", rows: result.rows };
    };
    const status = async () => {
      try {
        await query("clients");
        return { state: "healthy", database: { present: true, ok: true }, service: { loaded: true } };
      } catch {
        return { state: "degraded", database: { present: false, ok: false }, service: { loaded: false } };
      }
    };
    const adapter = createAuditUiAdapter({ query, status });
    ctx.registerGatewayRoute({
      id: `${PLUGIN_ID}-page`, method: "GET", path: PAGE_PATH, auth: "gateway",
      handler(_request, response) {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        response.end(AUDIT_PAGE_HTML);
      },
    });
    ctx.registerGatewayRoute({
      id: `${PLUGIN_ID}-status`, method: "GET", path: `${API_PATH}/status`, auth: "gateway",
      async handler(_request, response, helpers) { helpers.sendJson(response, 200, await adapter.status()); },
    });
    ctx.registerGatewayRoute({
      id: `${PLUGIN_ID}-query`, method: "GET", path: `${API_PATH}/query`, auth: "gateway",
      async handler(request, response, helpers) {
        const url = new URL(request.url ?? "/", "http://airkit-audit.local");
        const name = url.searchParams.get("name") ?? "";
        const id = url.searchParams.get("id");
        helpers.sendJson(response, 200, await adapter.query(name, id ? [id] : []));
      },
    });
    ctx.registerApp({
      id: PLUGIN_ID,
      name: "AirKit Audit",
      description: "Metadata-only local audit and evidence gaps",
      url: PAGE_PATH,
    });

    async function getClient() {
      if (!clientPromise) {
        clientPromise = readFile(capabilityFile, "utf8").then((capability) => createAuditQueryClient({
          socketPath: paths.querySocketPath,
          capability: capability.trim(),
        }));
      }
      return clientPromise;
    }
  },
};

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
