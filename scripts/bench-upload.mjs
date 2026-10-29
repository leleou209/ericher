// 上传路径基准：在隔离 workerd 里比较三种上传方式的耗时与完整性。
// 只用本机 fixture，不接生产桶、不接模型服务。
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, openSync, closeSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const project = fileURLToPath(new URL('..', import.meta.url));
const port = Number(process.env.UPLOAD_BENCH_PORT || 8796);
const root = path.join(project, '.wrangler', `upload-bench-${Date.now()}`);
mkdirSync(root, { recursive: true });
writeFileSync(path.join(root, '.dev.vars'), '');
const fixture = path.join(project, 'test/integration/uploadBenchWorker.ts').split(path.sep).join('/');
writeFileSync(path.join(root, 'wrangler.json'), JSON.stringify({
  name: 'ericher-upload-bench-local-only', main: fixture, compatibility_date: '2026-05-14',
  compatibility_flags: ['nodejs_compat'],
  durable_objects: { bindings: [{ name: 'COWORK_AGENT', class_name: 'CoworkAgent' }] },
  migrations: [{ tag: 'v1', new_sqlite_classes: ['CoworkAgent'] }],
  r2_buckets: [{ binding: 'MEMORY_BUCKET', bucket_name: 'upload-bench-local-only' }],
  vars: { ADMIN_PASSWORD: 'local-test-123456', SESSION_SECRET: 'local-only-session-secret-not-for-public-use' },
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
async function waitReady() {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try { if ((await fetch(base + '/__test/health')).ok) return; } catch {}
    await sleep(150);
  }
  throw new Error('fixture 启动超时');
}
function payload(size) {
  const buffer = Buffer.alloc(size);
  for (let i = 0; i < size; i += 1) buffer[i] = i % 251;
  return buffer;
}
async function benchFormData(size) {
  const form = new FormData();
  form.append('file', new Blob([payload(size)], { type: 'application/octet-stream' }), 'bench.bin');
  const started = Date.now();
  const response = await fetch(base + '/bench/formdata', { method: 'POST', body: form });
  const body = await response.json();
  return { wall: Date.now() - started, server: body.ms, sha: body.sha };
}
async function benchRaw(size) {
  const started = Date.now();
  const response = await fetch(base + '/bench/raw?name=bench.bin', {
    method: 'POST', body: payload(size), headers: { 'content-type': 'application/octet-stream' },
  });
  const body = await response.json();
  return { wall: Date.now() - started, server: body.ms, sha: body.sha };
}
async function benchParts(size, partSize, concurrency) {
  const key = `bench/parts-${Date.now()}`;
  const parts = [];
  let uploadId = '';
  const started = Date.now();
  const init = await (await fetch(`${base}/bench/init?key=${encodeURIComponent(key)}`)).json();
  uploadId = init.uploadId;
  const count = Math.ceil(size / partSize);
  const queue = Array.from({ length: count }, (_, index) => index + 1);
  const workers = Array.from({ length: Math.min(concurrency, count) }, async () => {
    for (;;) {
      const partNumber = queue.shift();
      if (!partNumber) return;
      const offset = (partNumber - 1) * partSize;
      const chunk = payload(Math.min(partSize, size - offset));
      const query = new URLSearchParams({ key, part: String(partNumber), parts: JSON.stringify(parts), uploadId });
      const response = await fetch(`${base}/bench/part?${query}`, { method: 'POST', body: chunk });
      const body = await response.json();
      uploadId = body.uploadId;
      const merged = [...parts.filter(p => p.partNumber !== partNumber), { partNumber, etag: body.etag }]
        .sort((a, b) => a.partNumber - b.partNumber);
      parts.length = 0; parts.push(...merged);
    }
  });
  await Promise.all(workers);
  const query = new URLSearchParams({ key, uploadId, parts: JSON.stringify(parts) });
  const response = await fetch(`${base}/bench/complete?${query}`, { method: 'POST' });
  const body = await response.json();
  return { wall: Date.now() - started, server: body.ms, sha: body.sha, parts: parts.length };
}
try {
  await waitReady();
  const sizes = [1, 5, 20, 45].map(mb => mb * 1024 * 1024);
  const results = [];
  for (const size of sizes) {
    const formData = await benchFormData(size);
    const raw = await benchRaw(size);
    const parts = await benchParts(size, 8 * 1024 * 1024, 4);
    results.push({
      mb: size / 1024 / 1024,
      formdata: formData, raw, parts,
      sameDigest: formData.sha === raw.sha && raw.sha === parts.sha,
    });
  }
  console.log(JSON.stringify(results, null, 2));
} finally {
  if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' });
  else { try { process.kill(-child.pid, 'SIGTERM'); } catch {} }
  console.log('基准 fixture 已停止；证据目录：' + root);
}
