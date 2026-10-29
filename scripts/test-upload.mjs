// 上传通道端到端验证：真实大文件走完三档，比对字节完整性。
// 隔离 workerd，无密钥、无模型服务、独立存储桶。
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, openSync, closeSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import path from 'node:path';

const project = fileURLToPath(new URL('..', import.meta.url));
const port = Number(process.env.UPLOAD_TEST_PORT || 8797);
const root = path.join(project, '.wrangler', `upload-test-${Date.now()}`);
mkdirSync(root, { recursive: true });
writeFileSync(path.join(root, '.dev.vars'), '');
const fixture = path.join(project, 'test/integration/uploadWorker.ts').split(path.sep).join('/');
writeFileSync(path.join(root, 'wrangler.json'), JSON.stringify({
  name: 'ericher-upload-test-local-only', main: fixture, compatibility_date: '2026-05-14',
  compatibility_flags: ['nodejs_compat'],
  assets: { directory: path.join(project, 'dist/client'), binding: 'ASSETS', not_found_handling: 'single-page-application', run_worker_first: true },
  durable_objects: { bindings: [{ name: 'COWORK_AGENT', class_name: 'CoworkAgent' }] },
  migrations: [{ tag: 'v1', new_sqlite_classes: ['CoworkAgent'] }],
  r2_buckets: [{ binding: 'MEMORY_BUCKET', bucket_name: 'upload-test-local-only' }],
  vars: { ADMIN_PASSWORD: 'local-test-123456', SESSION_SECRET: 'local-only-session-secret-not-for-public-use', API_KEY: '', API_ENDPOINT: '', API_MODEL: '' },
  define: { __APP_VERSION__: '"local-test"', __GIT_HASH__: '"local-test"' },
}, null, 2));
const log = openSync(path.join(root, 'worker.log'), 'a');
const child = spawn(process.execPath, [
  path.join(project, 'node_modules/wrangler/bin/wrangler.js'), 'dev',
  '--config', path.join(root, 'wrangler.json'), '--ip', '127.0.0.1', '--port', String(port),
  '--persist-to', path.join(root, 'state'), '--local',
], { cwd: root, stdio: ['ignore', log, log], detached: true });
child.unref(); closeSync(log);
const base = `http://127.0.0.1:${port}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));

function payload(size, seed = 0) {
  const buffer = Buffer.alloc(size);
  for (let i = 0; i < size; i += 1) buffer[i] = (i * 31 + seed) % 251;
  return buffer;
}
const sha = buffer => createHash('sha256').update(buffer).digest('hex');

async function waitReady() {
  const deadline = Date.now() + 40000;
  while (Date.now() < deadline) {
    try { if ((await fetch(base + '/__test/health')).ok) return; } catch {}
    await sleep(200);
  }
  throw new Error('fixture 启动超时');
}
async function auth() {
  const r = await fetch(base + '/api/auth', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pw: 'local-test-123456' }),
  });
  if (!r.ok) throw new Error('登录失败');
  return r.headers.get('set-cookie').split(';')[0];
}
async function uploadRaw(cookie, buffer, name) {
  const query = new URLSearchParams({ name, type: 'application/octet-stream', size: String(buffer.length) });
  const r = await fetch(`${base}/api/upload/raw?${query}`, {
    method: 'POST', headers: { cookie, 'content-type': 'application/octet-stream' }, body: buffer,
  });
  const body = await r.json();
  if (!body.ok) throw new Error(body.error);
  body.__serverMs = Number(r.headers.get('x-server-ms') || 0);
  return body;
}
async function uploadParts(cookie, buffer, name, partSize) {
  const uploadId = Math.random().toString(36).slice(2) + Date.now().toString(36);
  const totalParts = Math.ceil(buffer.length / partSize);
  const parts = [];
  const sendPart = async i => {
    const start = i * partSize;
    const chunk = buffer.subarray(start, Math.min(start + partSize, buffer.length));
    const query = new URLSearchParams({
      uploadId, partNumber: String(i + 1), totalParts: String(totalParts),
      name, type: 'application/octet-stream', size: String(buffer.length),
    });
    const r = await fetch(`${base}/api/upload/part?${query}`, {
      method: 'POST', headers: { cookie, 'content-type': 'application/octet-stream' }, body: chunk,
    });
    const body = await r.json();
    if (!body.ok) throw new Error(body.error);
    parts.push(i + 1);
  };
  // 首片负责创建会话；确认会话已存在后，其余分片并发上传。
  await sendPart(0);
  let cursor = 1;
  const workers = Array.from({ length: Math.min(3, Math.max(0, totalParts - 1)) }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= totalParts) return;
      await sendPart(i);
    }
  });
  await Promise.all(workers);
  const finish = await fetch(`${base}/api/upload/finish?uploadId=${uploadId}`, { method: 'POST', headers: { cookie } });
  const body = await finish.json();
  if (!body.ok) throw new Error(body.error);
  body.__serverMs = Number(finish.headers.get('x-server-ms') || 0);
  return { ...body, parts };
}
// 旧通道：multipart 表单（现网 /api/upload 原样）
async function uploadLegacyFormData(cookie, buffer, name) {
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: 'application/octet-stream' }), name);
  const r = await fetch(`${base}/api/upload`, { method: 'POST', headers: { cookie }, body: form });
  const body = await r.json();
  if (!body.ok) throw new Error(body.error);
  return body;
}
async function readBack(cookie, key) {
  const r = await fetch(`${base}/api/files/${key.split('/').map(encodeURIComponent).join('/')}`, { headers: { cookie } });
  if (!r.ok) throw new Error(`读回失败 ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}
async function listKeys(cookie) {
  const r = await fetch(`${base}/api/files`, { headers: { cookie } });
  const body = await r.json();
  return (body.files || []).map(f => f.key);
}
async function checkAbortAndStatus(cookie) {
  const uploadId = `abort-${Date.now()}`;
  const buffer = payload(5 * 1024 * 1024, 47);
  const query = new URLSearchParams({
    uploadId, partNumber: '1', totalParts: '1', name: 'abort-check.bin',
    type: 'application/octet-stream', size: String(buffer.length),
  });
  const part = await fetch(`${base}/api/upload/part?${query}`, {
    method: 'POST', headers: { cookie, 'content-type': 'application/octet-stream' }, body: buffer,
  });
  const partBody = await part.json();
  if (!partBody.ok) throw new Error(partBody.error);
  const statusBefore = await fetch(`${base}/api/upload/status?uploadId=${uploadId}`, { headers: { cookie } }).then(r => r.json());
  if (!statusBefore.exists || statusBefore.received?.[0] !== 1) throw new Error('上传状态查询未反映已收分片');
  const abort = await fetch(`${base}/api/upload/abort?uploadId=${uploadId}`, { method: 'POST', headers: { cookie } }).then(r => r.json());
  if (!abort.ok) throw new Error('中止上传失败');
  const statusAfter = await fetch(`${base}/api/upload/status?uploadId=${uploadId}`, { headers: { cookie } }).then(r => r.json());
  if (statusAfter.exists) throw new Error('中止后会话仍然存在');
  return true;
}

try {
  await waitReady();
  const cookie = await auth();
  const results = [];
  for (const mb of [5, 20, 45]) {
    const buffer = payload(mb * 1024 * 1024, mb);
    const expect = sha(buffer);

    // 服务端耗时：每档都报一次，用来分辨「慢在服务端」还是「慢在往返」
    const timed = async (fn) => { const t = Date.now(); const r = await fn(); return { r, ms: Date.now() - t }; };

    // 旧通道：multipart 表单（对比基准）
    const legacyStart = Date.now();
    const legacy = await uploadLegacyFormData(cookie, buffer, `legacy-${mb}.bin`);
    const legacyMs = Date.now() - legacyStart;
    const legacyBack = await readBack(cookie, legacy.key);

    // 轻量：单请求直通
    const liteStart = Date.now();
    const lite = await uploadRaw(cookie, buffer, `lite-${mb}.bin`);
    const liteMs = Date.now() - liteStart;
    const liteBack = await readBack(cookie, lite.key);

    // 均衡：8MB 分片
    const balStart = Date.now();
    const balanced = await uploadParts(cookie, buffer, `balanced-${mb}.bin`, 8 * 1024 * 1024);
    const balMs = Date.now() - balStart;
    const balBack = await readBack(cookie, balanced.key);

    // 专业：R2 允许的最小非末片大小为 5MiB
    const proStart = Date.now();
    const pro = await uploadParts(cookie, buffer, `pro-${mb}.bin`, 5 * 1024 * 1024);
    const proMs = Date.now() - proStart;
    const proBack = await readBack(cookie, pro.key);

    results.push({
      mb,
      legacyFormData: { ok: sha(legacyBack) === expect, bytes: legacyBack.length, ms: legacyMs, serverMs: legacy.__serverMs },
      lite: { ok: sha(liteBack) === expect, bytes: liteBack.length, ms: liteMs, serverMs: lite.__serverMs },
      balanced: { ok: sha(balBack) === expect, bytes: balBack.length, parts: balanced.parts.length, ms: balMs, serverMs: balanced.__serverMs },
      pro: { ok: sha(proBack) === expect, bytes: proBack.length, parts: pro.parts.length, ms: proMs, serverMs: pro.__serverMs },
    });
  }
  const abortAndStatus = await checkAbortAndStatus(cookie);
  // 临时分片不该留在云盘列表里
  const keys = await listKeys(cookie);
  const leaked = keys.filter(k => k.includes('.upload-sessions'));
  console.log(JSON.stringify({ results, abortAndStatus, leakedSessionKeys: leaked }, null, 2));
} finally {
  if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' });
  else { try { process.kill(-child.pid, 'SIGTERM'); } catch {} }
  console.log('上传测试 fixture 已停止；证据目录：' + root);
}
