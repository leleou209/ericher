import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, openSync, closeSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
const project = fileURLToPath(new URL('..', import.meta.url));
const root = path.join(project, '.wrangler', `web-encoding-test-${Date.now()}`);
const port = Number(process.env.WEB_ENCODING_TEST_PORT || 8793);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid test port');
mkdirSync(root,{recursive:true});
writeFileSync(path.join(root,'.dev.vars'),'');
writeFileSync(path.join(root,'wrangler.json'),JSON.stringify({name:'web-encoding-local-only',main:path.join(project,'test/integration/webEncodingWorker.ts'),compatibility_date:'2026-05-14'},null,2));
const log = openSync(path.join(root,'worker.log'),'a');
const child = spawn(process.execPath,[path.join(project,'node_modules/wrangler/bin/wrangler.js'),'dev','--config',path.join(root,'wrangler.json'),'--local','--ip','127.0.0.1','--port',String(port)],{cwd:root,stdio:['ignore',log,log],detached:true});
try {
  const deadline = Date.now()+25000;
  let result;
  while (Date.now()<deadline) {
    if (child.exitCode !== null) throw new Error('Local Worker exited; inspect '+root);
    try { result = await (await fetch(`http://127.0.0.1:${port}`)).json(); } catch {}
    if (result?.fixture==='web-encoding-local') break;
    await new Promise(r=>setTimeout(r,150));
  }
  assert.equal(result?.fixture,'web-encoding-local','Isolated worker startup timeout');
  assert.deepEqual(result.failures,[]);
  console.log('PASS: real workerd GB2312/GB18030/Big5/UTF8/UTF16 and fatal decoding.');
} finally {
  if (process.platform==='win32') {
    const stop=spawn('taskkill',['/pid',String(child.pid),'/t','/f'],{stdio:'ignore'});
    await new Promise(r=>stop.on('exit',r));
  } else { try { process.kill(-child.pid,'SIGTERM'); } catch {} }
  closeSync(log);
  console.log('Local fixture stopped; evidence: '+root);
}
