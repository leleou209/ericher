/**
 * 弱网/启动韧性门禁。
 *
 * 做法照 scripts/test-chat-recovery.mjs：一个 main() 驱动 + until() 就绪轮询 + 独立
 * .wrangler/weak-network-test-* 目录 + 默认端口（WEAK_NET_TEST_PORT 覆盖）+ 结束时只杀
 * 自己起的进程树 + 只用本地假环境、不配任何外部模型密钥（就绪探针、清理都复用
 * start-weak-network-fixture.mjs 导出的同一套实现，不另开第二套口径）。
 *
 * 覆盖的是「弱网首屏交付路径」上能用 HTTP 观测到的行为：
 *  1. 就绪探针 /__test/health 认得本次实例（runId），生产健康接口显示外部密钥一律未配；
 *  2. 入口 HTML 内联启动 CSS（data-startup-css，见 vite.config.ts 的 inline-startup-css）
 *     与 boot/boot-retry 兜底在限速下依旧完整、且没有外链阻塞样式；
 *  3. 延迟/限速注入真的生效（拿 fixture 自己报的 timings 核对），健康接口在此条件下仍返回；
 *  4. 首屏静态资源严格按 HTML 声明顺序取到，限速下字节与 dist/client 上的源文件完全一致；
 *  5. 身份接口 500 时首屏照样交付。
 *
 * 未覆盖（这里做不到，别当成验过了）：真实浏览器的渲染与绘制顺序、内联 CSS 是否先于内容画出、
 * React hydration / 首屏 JS 执行、弱网下 WebSocket 重连（那是 test-chat-recovery.mjs 的路子）。
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { projectRoot, startFixture } from './start-weak-network-fixture.mjs';

// 门禁要跑得快，这里收紧注入延迟；手工排查直接跑 start 脚本时用的是它自己的 3000/4000 真实档位。
process.env.WEAK_NET_SHELL_MS ??= '800';
process.env.WEAK_NET_AUTH_MS ??= '1000';
process.env.WEAK_NET_CHUNK_MS ??= '8';
process.env.WEAK_NET_CHUNK_BYTES ??= '4096';

const clientDir = path.join(projectRoot, 'dist', 'client');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function timedGet(base, href, { cookie } = {}) {
  const started = performance.now();
  const startedAtMs = Date.now();
  const response = await fetch(base + href, { headers: cookie ? { cookie } : undefined });
  const body = Buffer.from(await response.arrayBuffer());
  return {
    href,
    status: response.status,
    contentType: response.headers.get('content-type') ?? '',
    body,
    text: body.toString('utf8'),
    ms: Math.max(1, Math.round(performance.now() - started)),
    startedAtMs,
    endedAtMs: Date.now(),
    json: () => JSON.parse(body.toString('utf8')),
  };
}

/** 入口 HTML 声明的首屏资源，按它在文档里出现的先后排（浏览器就照这个顺序发请求）。 */
function firstScreenRefs(html) {
  const found = [];
  for (const match of html.matchAll(/<script\b[^>]*>/g)) {
    if (!/type="module"/.test(match[0])) continue;
    const href = /src="([^"]+)"/.exec(match[0])?.[1];
    if (href) found.push({ at: match.index, href, kind: 'entry' });
  }
  for (const match of html.matchAll(/<link\b[^>]*>/g)) {
    if (!/rel="modulepreload"/.test(match[0])) continue;
    const href = /href="([^"]+)"/.exec(match[0])?.[1];
    if (href) found.push({ at: match.index, href, kind: 'preload' });
  }
  return found.sort((a, b) => a.at - b.at);
}

async function main() {
  if (!existsSync(path.join(clientDir, 'index.html')))
    throw new Error(`${path.join(clientDir, 'index.html')} 不存在 —— 先跑一次构建（npm run build）再来门禁。`);

  // 先落一行心跳：门禁「一行都没打就非 0 退出」只可能是被外力打断（本机确实偶发），
  // 有这行才能把它和「断言跑挂了」区分开。
  console.log('准备启动隔离 workerd（端口默认 8794，用 WEAK_NET_TEST_PORT 覆盖）…');
  const fixture = await startFixture();
  const { base, runId } = fixture;
  let cleaned = null;
  try {
    const timings = fixture.ready.timings ?? {};
    assert.equal(fixture.ready.runId, runId, '就绪探针回的 runId 必须是本次目录');
    assert.ok(timings.chunkMs > 0 && timings.chunkBytes > 0, 'fixture 必须把限速档位报出来，否则断言无从核对');
    console.log(`PASS 1/5 就绪：/__test/health 认得本次实例（runId=${runId}，档位 shell=${timings.shellMs}ms auth=${timings.authMs}ms chunk=${timings.chunkMs}ms/${timings.chunkBytes}B）`);

    const login = await fetch(base + '/api/auth', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pw: 'local-test-123456' }),
    });
    assert.equal(login.status, 200, `/api/auth 登录失败（${login.status}），fixture 的 ADMIN_PASSWORD 没生效？`);
    const cookie = login.headers.get('set-cookie')?.split(';')[0];
    assert.ok(cookie, '/api/auth 没下发会话票');

    const fastHtml = await timedGet(base, '/?mode=fast', { cookie });
    assert.equal(fastHtml.status, 200, `入口 HTML 没返回 200（${fastHtml.status}）`);
    assert.match(fastHtml.contentType, /text\/html/, `入口 HTML 的 content-type 不对：${fastHtml.contentType}`);
    const health = (await timedGet(base, '/api/health', { cookie })).json();
    assert.equal(health.ok, true, '/api/health 不 ok');
    for (const flag of ['hasKey', 'hasEndpoint', 'hasTavily', 'hasVision'])
      assert.equal(health[flag], false, `fixture 不该配外部模型密钥，但 /api/health 报 ${flag}=true`);
    console.log(`PASS 2/5 隔离：/api/health 在本地 fixture 里报 ${JSON.stringify({ do: health.do, hasKey: health.hasKey, hasEndpoint: health.hasEndpoint })}（外部模型接口一律未配）`);

    const throttledHtml = await timedGet(base, '/?mode=throttle', { cookie });
    for (const [label, page] of [['fast', fastHtml], ['throttle', throttledHtml]]) {
      assert.equal(page.status, 200, `${label}：入口 HTML 没返回 200（${page.status}）`);
      assert.ok(page.text.includes('data-startup-css'), `${label}：入口 HTML 缺少内联启动 CSS 标记 data-startup-css`);
      assert.ok(!/<link\b[^>]*rel="stylesheet"/.test(page.text), `${label}：首屏仍存在外链阻塞样式 <link rel="stylesheet">`);
      assert.ok(page.text.includes('id="boot"'), `${label}：HTML 缺少 JS 未到时的启动占位 #boot`);
      assert.ok(page.text.includes('id="boot-retry"'), `${label}：HTML 缺少失败重试入口 #boot-retry`);
    }
    assert.equal(throttledHtml.text, fastHtml.text, '限速下 HTML 正文与 fast 基线不一致（分块流被截断或改写了）');
    assert.ok(throttledHtml.ms > fastHtml.ms, `限速没真的慢下来：throttle=${throttledHtml.ms}ms fast=${fastHtml.ms}ms`);
    console.log(`PASS 3/5 首屏：内联启动 CSS + #boot/#boot-retry 在限速下完整交付（fast ${fastHtml.ms}ms → throttle ${throttledHtml.ms}ms，${throttledHtml.body.length} 字节一致）`);

    const delayedHealth = await timedGet(base, '/__test/health?mode=slowShell');
    assert.equal(delayedHealth.status, 200, '整链路延迟下 /__test/health 没返回');
    assert.equal(delayedHealth.json().runId, runId, '延迟下 /__test/health 报错了 runId');
    assert.ok(delayedHealth.ms >= timings.shellMs * 0.8, `slowShell 应注入约 ${timings.shellMs}ms，实测只有 ${delayedHealth.ms}ms —— 延迟被短路了`);
    const delayedApi = await timedGet(base, '/api/health?mode=slowShell', { cookie });
    assert.equal(delayedApi.status, 200, `延迟下 /api/health 没返回（${delayedApi.status}）`);
    assert.equal(delayedApi.json().ok, true, '延迟下 /api/health 不 ok');
    const slowAuthMe = await timedGet(base, '/api/me?mode=slowAuth', { cookie });
    assert.equal(slowAuthMe.status, 200, `身份接口超时时 /api/me 应仍完成（${slowAuthMe.status}）`);
    assert.ok(slowAuthMe.ms >= timings.authMs * 0.8, `slowAuth 应注入约 ${timings.authMs}ms，实测 ${slowAuthMe.ms}ms`);
    console.log(`PASS 4/5 限流下健康接口仍返回：/__test/health ${delayedHealth.ms}ms、/api/health ${delayedApi.ms}ms、/api/me 超时 ${slowAuthMe.ms}ms 后仍 200`);

    const refs = firstScreenRefs(fastHtml.text);
    assert.ok(refs.length >= 1, '入口 HTML 没解析出任何首屏 module 资源，断言无从进行');
    assert.equal(refs[0].kind, 'entry', '首屏第一个声明资源必须是入口 module 脚本（preload 排在它之前就没法预取）');
    const steps = [{ label: '/', bytes: fastHtml.body.length, ms: fastHtml.ms, endedAtMs: fastHtml.endedAtMs }];
    for (const ref of refs) {
      const file = path.join(clientDir, ref.href.replace(/^\/+/, ''));
      assert.ok(existsSync(file), `${ref.href} 在 dist/client 下找不到对应文件`);
      const onDisk = readFileSync(file);
      const quick = await timedGet(base, `${ref.href}?mode=fast`);
      assert.equal(quick.status, 200, `${ref.href} 在 fast 下没返回 200（${quick.status}）`);
      const slow = await timedGet(base, `${ref.href}?mode=throttle`);
      assert.equal(slow.status, 200, `${ref.href} 在限速下没返回 200（${slow.status}）`);
      assert.match(slow.contentType, /javascript/, `${ref.href} 的 content-type 不对：${slow.contentType}`);
      assert.equal(slow.body.length, onDisk.length, `${ref.href} 限速下字节数不完整：收到 ${slow.body.length}，磁盘 ${onDisk.length}`);
      assert.ok(Buffer.compare(slow.body, onDisk) === 0, `${ref.href} 限速下正文与磁盘源文件不一致（分块被改坏）`);
      const expectedMs = Math.ceil(onDisk.length / timings.chunkBytes) * timings.chunkMs;
      assert.ok(slow.ms > quick.ms, `${ref.href} 限速没比 fast 慢：${slow.ms}ms vs ${quick.ms}ms`);
      assert.ok(slow.ms >= expectedMs * 0.5, `${ref.href} 限速强度不足：期望至少约 ${expectedMs}ms，实测 ${slow.ms}ms`);
      steps.push({ label: ref.href, bytes: slow.body.length, ms: slow.ms, endedAtMs: slow.endedAtMs });
    }
    assert.deepEqual(
      steps.map(step => step.label),
      ['/', ...refs.map(ref => ref.href)],
      '取用顺序必须是：入口 HTML 先到手（内联 CSS + boot 占位此刻已可用），再按 HTML 声明顺序取 JS',
    );
    for (let index = 1; index < steps.length; index++)
      assert.ok(
        steps[index].endedAtMs >= steps[index - 1].endedAtMs,
        `第 ${index + 1} 步（${steps[index].label}）早于前一步结束就返回了，说明请求顺序被打乱`,
      );
    console.log(`PASS 5/5 首屏资源按声明顺序限速可达：${steps.map(step => `${step.label}(${step.bytes}B/${step.ms}ms)`).join(' → ')}`);

    const brokenAuth = await timedGet(base, '/api/me?mode=auth500', { cookie });
    assert.equal(brokenAuth.status, 500, 'auth500 档位没让身份接口报错（说明失败面没被真的构造出来）');
    const htmlWithoutIdentity = await timedGet(base, '/?mode=auth500', { cookie });
    assert.equal(htmlWithoutIdentity.status, 200, '身份接口 500 时首屏 HTML 仍必须交付');
    assert.ok(htmlWithoutIdentity.text.includes('data-startup-css'), '身份接口 500 时首屏内联 CSS 丢了');
    console.log('PASS 补充：身份接口 500 不影响首屏交付（HTML 仍 200 且带内联启动 CSS）。');
    console.log('未覆盖（这套工装做不到，别当验过）：浏览器渲染/绘制顺序、内联 CSS 是否先于内容画出、React hydration 与首屏 JS 执行、弱网下 WebSocket 重连。');
  } finally {
    // 只杀自己写进 fixture.json 的那个 pid 的进程树；目录也只删自己建的。
    cleaned = await fixture.stop();
    await sleep(200);
    const residue = existsSync(fixture.root);
    console.log(
      `清理：pid=${cleaned.pid ?? '无'} 进程=${cleaned.skipped ?? (cleaned.killed ? '树已杀' : '没动')} 目录${cleaned.removed && !residue ? '已删' : '仍在（下次 start 会接手清理）'} ${fixture.root}`,
    );
  }
}

main().catch(error => {
  console.error(`弱网门禁失败：${error?.stack ?? error}`);
  process.exitCode = 1;
});
