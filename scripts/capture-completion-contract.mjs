#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const CHILD_MS = 30_000;
const BATCH_MS = 300_000;
const OUTPUT_BYTES = 64 * 1024;
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;

function summary() {
  return { status: 'unsupported', version: 'unknown', coverage: { containment: false, stopFeedbackContinue: false,
    stopHookActive: false, nativeIdentity: false, userCancel: false, compact: false, resume: false,
    nativeAcceptance: false, exactTransportJoin: false, continuousRevision: false, enforcing: false },
  counts: { children: 0, childTimeouts: 0, childFailures: 0, requests: 0, feedbackContinuations: 0,
    stop: 0, activeStop: 0, feedback: 0, userPrompt: 0, sessionStart: 0, sessionEnd: 0,
    postCompact: 0, resume: 0, compact: 0, sessionIdentity: 0, userIdentity: 0, approval: 0, exactRoute: 0 }, reasons: [] };
}

function validateConstraints({ mode, home, baseUrl }) {
  if (!['shadow', 'isolated-enforce'].includes(mode)) throw new Error('unsupported_mode');
  const actualHome = resolve(homedir());
  if (home !== undefined && (typeof home !== 'string' || !isAbsolute(home)
    || resolve(home) === actualHome || resolve(home).startsWith(`${actualHome}/`))) throw new Error('unsafe_home');
  if (baseUrl !== undefined) {
    let url;
    try { url = new URL(baseUrl); } catch { throw new Error('non_loopback'); }
    if (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
      || url.username || url.password) throw new Error('non_loopback');
  }
}

function sandboxProfile(executable, port) {
  const actualHome = resolve(homedir());
  const paths = [];
  for (let current = dirname(executable); current === actualHome || current.startsWith(`${actualHome}/`); current = dirname(current)) {
    paths.push(current); if (current === actualHome) break;
  }
  return ['(version 1)', '(allow default)',
    `(deny file-read* file-write* (subpath ${JSON.stringify(actualHome)}))`,
    ...paths.map((value) => `(allow file-read-metadata (literal ${JSON.stringify(value)}))`),
    `(allow file-read* (literal ${JSON.stringify(executable)}))`, '(deny network*)',
    `(allow network-outbound (remote ip "localhost:${port}"))`].join(' ');
}

function terminate(child, signal = 'SIGKILL') {
  try { process.kill(-child.pid, signal); } catch { /* Only this owned process group is targeted. */ }
}

async function childRun({ executable, args, cwd, env, profile, deadline, counts, onStart }) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error('batch_deadline');
  const child = spawn('/usr/bin/sandbox-exec', ['-p', profile, executable, ...args], {
    cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  counts.children += 1;
  const chunks = []; let length = 0; let timedOut = false; let oversized = false;
  child.stdout.on('data', (chunk) => {
    length += chunk.length;
    if (length > OUTPUT_BYTES) { oversized = true; terminate(child); }
    else chunks.push(chunk);
  });
  let stderrLength = 0;
  child.stderr.on('data', (chunk) => { stderrLength += chunk.length; if (stderrLength > OUTPUT_BYTES) { oversized = true; terminate(child); } });
  const timer = setTimeout(() => { timedOut = true; terminate(child); }, Math.min(CHILD_MS, remaining));
  let spawnFailed = false;
  child.on('error', () => { spawnFailed = true; });
  try {
    onStart?.(child);
    const terminal = await new Promise((done) => child.once('close', (code, signal) => done({ code, signal })));
    if (timedOut) counts.childTimeouts += 1;
    if (terminal.code !== 0 || spawnFailed || oversized) counts.childFailures += 1;
    return { ...terminal, timedOut, oversized, stdout: Buffer.concat(chunks).toString('utf8') };
  } finally { clearTimeout(timer); terminate(child); }
}

const containmentProbe = `import fs from 'node:fs'; import net from 'node:net'; import http from 'node:http';
const denied = e => ['EPERM','EACCES'].includes(e?.code);
let homeDenied = false; try { fs.readdirSync(process.argv[2]); } catch(e) { homeDenied = denied(e); }
const externalDenied = await new Promise(resolve => { const socket = net.createConnection({host:'192.0.2.1',port:9});
 const timer=setTimeout(()=>{socket.destroy();resolve(false);},2000);
 socket.once('connect',()=>{clearTimeout(timer);socket.destroy();resolve(false);});
 socket.once('error',e=>{clearTimeout(timer);resolve(denied(e));}); });
const loopback = await new Promise(resolve => { const request=http.get(process.argv[3],response=>{response.resume();resolve(response.statusCode===204);});
 request.setTimeout(2000,()=>{request.destroy();resolve(false);}); request.on('error',()=>resolve(false)); });
console.log(JSON.stringify({homeDenied,externalDenied,loopback}));`;

function nativeHookSource(events, marker, mode) {
  return `import fs from 'node:fs';
let raw=''; for await(const chunk of process.stdin) {raw+=chunk; if(Buffer.byteLength(raw)>65536) process.exit(0);}
let input; try { input=JSON.parse(raw); } catch { process.exit(0); }
const allowed=['Stop','UserPromptSubmit','SessionStart','SessionEnd','PostCompact'];
if(!allowed.includes(input.hook_event_name)) process.exit(0);
const record={event:input.hook_event_name,active:input.stop_hook_active===true,
session:typeof input.session_id==='string'&&input.session_id.length>0,
user:typeof input.user_id==='string'&&input.user_id.length>0,
approval:typeof input.approval_id==='string',
route:typeof input.transport_request_id==='string'&&typeof input.provider==='string'&&typeof input.model==='string',
resume:input.source==='resume',compact:input.source==='compact',feedback:false};
if(input.hook_event_name==='Stop'&&${JSON.stringify(mode)}==='isolated-enforce'&&!record.active) {
try { fs.writeFileSync(${JSON.stringify(marker)},'1',{flag:'wx',mode:0o600});record.feedback=true; } catch {}
}
let size=0;try{size=fs.statSync(${JSON.stringify(events)}).size;}catch{}
if(size<16384)fs.appendFileSync(${JSON.stringify(events)},JSON.stringify(record)+'\\n',{mode:0o600});
if(record.feedback) console.log(JSON.stringify({decision:'block',reason:'pending_work',itemIds:['fixture-item'],
nextAction:'Check the listed accepted work and its existing verification receipts.',remaining:1}));`;
}

function providerResponse(response, model) {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  const send = (event, data) => response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  send('message_start', { type: 'message_start', message: { id: `msg_${randomUUID()}`, type: 'message', role: 'assistant',
    model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } });
  send('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
  send('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Synthetic fixture complete.' } });
  send('content_block_stop', { type: 'content_block_stop', index: 0 });
  send('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } });
  send('message_stop', { type: 'message_stop' }); response.end();
}

async function aggregate(events, result) {
  let raw;
  try { raw = await readFile(events, 'utf8'); } catch { return; }
  if (Buffer.byteLength(raw) > 32768) { result.reasons.push('native_events_oversize'); return; }
  for (const line of raw.split('\n').filter(Boolean)) {
    let event; try { event = JSON.parse(line); } catch { continue; }
    const field = { Stop: 'stop', UserPromptSubmit: 'userPrompt', SessionStart: 'sessionStart', SessionEnd: 'sessionEnd', PostCompact: 'postCompact' }[event.event];
    if (!field) continue;
    result.counts[field] += 1;
    for (const [present, count] of [['active', 'activeStop'], ['feedback', 'feedback'], ['session', 'sessionIdentity'],
      ['user', 'userIdentity'], ['approval', 'approval'], ['route', 'exactRoute'], ['resume', 'resume'], ['compact', 'compact']]) {
      if (event[present] === true) result.counts[count] += 1;
    }
  }
}

export async function runCompletionCapture({ claudePath = '/Users/untionglim/.local/bin/claude', mode = 'shadow', home, baseUrl } = {}) {
  validateConstraints({ mode, home, baseUrl });
  const deadline = Date.now() + BATCH_MS;
  const result = summary();
  result.reasons.push('native_acceptance_unknown', 'exact_transport_join_unknown', 'continuous_revision_unknown',
    'multi_target_revision_closure_unknown', 'native_user_cancel_unverified', 'native_approval_unverified');
  if (process.platform !== 'darwin') { result.reasons.push('sandbox_unavailable'); return result; }
  try { await access('/usr/bin/sandbox-exec'); } catch { result.reasons.push('sandbox_unavailable'); return result; }
  if (!isAbsolute(claudePath)) throw new Error('absolute_claude_path_required');
  const root = await mkdtemp(join(tmpdir(), 'airkit-completion-capture-'));
  let server;
  try {
    const executable = await realpath(claudePath);
    const homeDir = join(root, 'home'); const configDir = join(root, 'config'); const workspace = join(root, 'workspace');
    await Promise.all([homeDir, configDir, workspace].map((directory) => mkdir(directory, { mode: 0o700 })));
    await writeFile(join(homeDir, '.claude.json'), JSON.stringify({ customApiKeyResponses: { approved: ['fixture-key'], rejected: [] },
      hasCompletedOnboarding: true, projects: { [workspace]: { hasTrustDialogAccepted: true } } }), { mode: 0o600 });
    const events = join(root, 'events.jsonl'); const marker = join(root, 'feedback-used');
    const hook = join(root, 'native-hook.mjs'); const settings = join(root, 'settings.json');
    await writeFile(hook, nativeHookSource(events, marker, mode), { mode: 0o600 });
    const command = `${quote(process.execPath)} ${quote(hook)}`;
    await writeFile(settings, JSON.stringify({ hooks: Object.fromEntries(['Stop', 'UserPromptSubmit', 'SessionStart', 'SessionEnd', 'PostCompact']
      .map((event) => [event, [{ hooks: [{ type: 'command', command, timeout: 2 }] }]])) }), { mode: 0o600 });
    let phase = 'feedback'; let cancelChild; let phaseRequests = 0;
    server = createServer((request, response) => {
      if (request.url === '/containment' && request.method === 'GET') { response.writeHead(204).end(); return; }
      if (request.method !== 'POST' || !request.url?.startsWith('/v1/messages')) { response.writeHead(404).end(); return; }
      const chunks = []; let bytes = 0;
      request.on('data', (chunk) => { bytes += chunk.length; if (bytes > 2 * 1024 * 1024) request.destroy(); else chunks.push(chunk); });
      request.on('end', () => {
        let body; try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { response.writeHead(400).end(); return; }
        result.counts.requests += 1; phaseRequests += 1;
        if (phase === 'feedback' && phaseRequests > 1 && (body.messages ?? []).some((message) =>
          typeof message.content === 'string' ? message.content.includes('pending_work') : Array.isArray(message.content)
            && message.content.some((block) => typeof block.text === 'string' && block.text.includes('pending_work')))) result.counts.feedbackContinuations += 1;
        if (phase === 'cancel') { if (cancelChild) terminate(cancelChild, 'SIGINT'); return; }
        if (phaseRequests > 4) { response.writeHead(503).end(); return; }
        providerResponse(response, typeof body.model === 'string' ? body.model : 'claude-sonnet-5');
      });
      request.on('error', () => {});
    });
    await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
    const port = server.address().port; const endpoint = `http://127.0.0.1:${port}`;
    const profile = sandboxProfile(executable, port);
    const env = { HOME: homeDir, CLAUDE_CONFIG_DIR: configDir, PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'C.UTF-8',
      NO_PROXY: '127.0.0.1,localhost', HTTP_PROXY: endpoint, HTTPS_PROXY: endpoint, ALL_PROXY: endpoint,
      ANTHROPIC_API_KEY: 'fixture-key', ANTHROPIC_BASE_URL: endpoint, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '0' };
    const probe = join(root, 'containment.mjs'); await writeFile(probe, containmentProbe, { mode: 0o600 });
    const proof = await childRun({ executable: process.execPath, args: [probe, homedir(), `${endpoint}/containment`], cwd: workspace,
      env, profile, deadline, counts: result.counts });
    let contained; try { contained = JSON.parse(proof.stdout); } catch { /* A missing positive proof is unsupported. */ }
    if (proof.code !== 0 || !contained?.homeDenied || !contained?.externalDenied || !contained?.loopback) {
      result.reasons.push('containment_unproven'); return result;
    }
    result.coverage.containment = true;
    const options = { executable, cwd: workspace, env, profile, deadline, counts: result.counts };
    const version = await childRun({ ...options, args: ['--version'] });
    const parsedVersion = version.stdout.trim().match(/^(\d+\.\d+\.\d+)\b/);
    if (version.code !== 0 || !parsedVersion) { result.reasons.push('version_unobserved'); return result; }
    result.version = parsedVersion[1];
    const sessionId = randomUUID();
    const args = ['--model', 'claude-sonnet-5', '--permission-mode', 'dontAsk', '--tools', '', '--strict-mcp-config',
      '--mcp-config', '{"mcpServers":{}}', '--setting-sources', '', '--settings', settings, '--max-turns', '4', '--output-format', 'json', '--print'];
    const feedback = await childRun({ ...options, args: [...args, '--session-id', sessionId, 'Return a short synthetic fixture answer.'] });
    const feedbackRequests = phaseRequests;
    phase = 'resume'; phaseRequests = 0;
    const resumed = await childRun({ ...options, args: [...args, '--resume', sessionId, 'Return a short synthetic resume fixture answer.'] });
    phase = 'compact'; phaseRequests = 0;
    const compacted = await childRun({ ...options, args: [...args, '--resume', sessionId, '/compact'] });
    phase = 'cancel'; phaseRequests = 0;
    await childRun({ ...options, args: [...args, '--no-session-persistence', 'Return a short synthetic cancellation fixture answer.'],
      onStart(child) { cancelChild = child; } });
    await aggregate(events, result);
    result.coverage.stopFeedbackContinue = feedback.code === 0 && feedbackRequests >= 2 && result.counts.feedbackContinuations > 0
      && result.counts.feedback === 1 && result.counts.stop >= 2;
    result.coverage.stopHookActive = result.counts.activeStop > 0;
    result.coverage.nativeIdentity = result.counts.sessionIdentity > 0;
    result.coverage.resume = resumed.code === 0 && result.counts.resume > 0;
    result.coverage.compact = compacted.code === 0 && (result.counts.postCompact > 0 || result.counts.compact > 0);
    if (result.counts.stop > 0) result.status = 'observed'; else result.reasons.push('native_stop_unobserved');
    if (!result.coverage.stopFeedbackContinue) result.reasons.push('feedback_continuation_unverified');
    if (!result.coverage.stopHookActive) result.reasons.push('stop_hook_active_unverified');
    if (!result.coverage.resume) result.reasons.push('native_resume_unverified');
    if (!result.coverage.compact) result.reasons.push('native_compact_unverified');
    if (result.counts.childTimeouts) result.reasons.push('child_timeout');
    if (result.counts.childFailures) result.reasons.push('native_child_nonzero');
    return result;
  } catch (error) {
    result.reasons.push(error.message === 'batch_deadline' ? 'batch_deadline' : 'capture_unavailable');
    return result;
  } finally {
    if (server) { server.closeAllConnections(); await new Promise((done) => server.close(done)); }
    await rm(root, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.env.AIRKIT_VERIFY_COMPLETION_HOST !== '1') {
    process.stdout.write(`${JSON.stringify({ status: 'not-run', reason: 'explicit_opt_in_required' })}\n`);
  } else {
    runCompletionCapture({ mode: process.argv[2] ?? 'shadow' })
      .then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
      .catch(() => { process.stderr.write('completion_capture_invalid_options\n'); process.exitCode = 1; });
  }
}
