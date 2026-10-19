import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { writeFileSync, openSync, mkdirSync, closeSync } from 'node:fs';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const project = fileURLToPath(new URL("..", import.meta.url));
const port = Number(process.env.CHAT_TEST_PORT || 8792);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Invalid CHAT_TEST_PORT");
const root = path.join(project, '.wrangler', `chat-recovery-test-${Date.now()}`);
mkdirSync(root, { recursive: true });
writeFileSync(path.join(root, '.dev.vars'), `API_KEY=""
MINIMAX_KEY=""
SK_MAINTENANCE=""
MIMO_KEY=""
`);
writeFileSync(path.join(root, 'wrangler.json'), JSON.stringify({
 name:'hr-chat-recovery-local-only', main:path.join(project,'test/integration/chatRecoveryWorker.ts'),
 compatibility_date:'2026-05-14', compatibility_flags:['nodejs_compat'],
 assets:{ directory:path.join(project,'dist/client'), binding:'ASSETS', not_found_handling:'single-page-application', run_worker_first:true },
 durable_objects:{bindings:[{name:'COWORK_AGENT',class_name:'CoworkAgent'}]}, migrations:[{tag:'v1',new_sqlite_classes:['CoworkAgent']}],
 r2_buckets:[{binding:'MEMORY_BUCKET',bucket_name:'hr-chat-recovery-local-only'}],
 vars:{CHAT_TEST_RUN:path.basename(root),ADMIN_PASSWORD:'local-test-123456',SESSION_SECRET:'local-only-session-secret-not-for-public-use',API_KEY:'',API_ENDPOINT:'',API_MODEL:''},
 define:{__APP_VERSION__:'"local-test"',__GIT_HASH__:'"local-test"'}
}, null, 2));
const require = createRequire(path.join(project, 'package.json'));
const WebSocket = require('ws');
const log = openSync(path.join(root, 'worker.log'), 'a');
const child = spawn(process.execPath, [path.join(project, 'node_modules/wrangler/bin/wrangler.js'), 'dev', '--config', path.join(root, 'wrangler.json'), '--port', String(port), '--persist-to', path.join(root, 'state'), '--local'], { cwd: root, stdio: ['ignore', log, log], detached: true });
writeFileSync(path.join(root, 'pid.txt'), String(child.pid));
child.unref();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const base = `http://127.0.0.1:${port}`;
const sockets = [];
async function until(fn, label, ms = 20000) {
 const end = Date.now() + ms;
 while (Date.now() < end) { try { const result = await fn(); if (result) return result; } catch {} await sleep(100); }
 throw new Error('timeout: ' + label);
}
try {
await until(async () => (await (await fetch(base + '/__test/health')).json()).runId === path.basename(root), 'isolated startup');
const auth = await fetch(base + '/api/auth', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({pw:'local-test-123456'}) });
assert.equal(auth.status, 200);
const cookie = auth.headers.get('set-cookie').split(';')[0];
async function connect(room) {
 const ws = new WebSocket(`ws://127.0.0.1:${port}/agents/cowork-agent/${room}`, { headers:{Cookie:cookie} });
 sockets.push(ws);
 const frames = [];
 ws.on('message', data => {
  const frame = JSON.parse(String(data)); frames.push(frame);
  if (frame.type === 'cf_agent_stream_resuming') ws.send(JSON.stringify({type:'cf_agent_stream_resume_ack', id:frame.id}));
 });
 await until(() => frames.some(f => f.type === 'cf_agent_identity'), 'identity ' + room);
 return { ws, frames };
}
function submit(ws, requestId, userId, text = 'slow') {
 ws.send(JSON.stringify({type:'cf_agent_use_chat_request', id:requestId, init:{method:'POST', body:JSON.stringify({trigger:'submit-message', messages:[{id:userId, role:'user', parts:[{type:'text',text}]}]})}}));
}
const metrics = async room => (await fetch(base + '/__test/metrics?room=' + room)).json();
const stamp = Date.now();
const roomA = 'default--recovery-' + stamp;
const roomB = 'default--parallel-' + stamp;
let a = await connect(roomA);
submit(a.ws, 'req-a', 'user-a');
await until(() => a.frames.some(f => f.body?.includes('text-delta')), 'first delta');
a.ws.close();
let b = await connect(roomB);
submit(b.ws, 'req-b', 'user-b', 'fast');
const returned = await connect(roomA);
submit(returned.ws, 'duplicate-a', 'user-a');
await until(async () => (await metrics(roomB)).completed === 1, 'parallel completed');
const during = await metrics(roomA);
assert.equal(during.starts, 1); assert.equal(during.tools, 1); assert.equal(during.aborted, 0); assert.equal(during.completed, 0);
await until(async () => (await metrics(roomA)).completed === 1, 'background completed');
assert(returned.frames.some(f => f.replay), 'existing stream was replayed');
assert.equal((await metrics(roomA)).starts, 1);
returned.ws.close(); b.ws.close();
console.log('PASS: disconnect/room switch preserves original task; independent room completes concurrently; duplicate submission executes one fake tool; reconnect replays original stream.');
const cancelRoom = 'default--cancel-' + stamp;
const c = await connect(cancelRoom);
submit(c.ws, 'req-cancel', 'user-cancel');
await until(() => c.frames.some(f => f.body?.includes('text-delta')), 'cancel first delta');
c.ws.send(JSON.stringify({type:'cf_agent_chat_request_cancel', id:'req-cancel'}));
await until(async () => (await metrics(cancelRoom)).aborted === 1, 'explicit cancellation');
assert.equal((await metrics(cancelRoom)).completed, 0);
c.ws.close();
console.log('PASS: explicit stop still cancels original task.');
} finally {
 for (const ws of sockets) ws.terminate();
 // 只停止本次脚本创建的进程树；不接触任何已有开发服务。
 if (process.platform === 'win32') {
   const stop = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], {stdio:'ignore'});
   await new Promise(resolve => stop.on('exit', resolve));
 } else { try { process.kill(-child.pid, 'SIGTERM'); } catch {} }
 closeSync(log);
 console.log('Isolated local fixture stopped. Evidence: ' + root);
}
