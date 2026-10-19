/**
 * 弱网/启动韧性 fixture —— 只在本机 127.0.0.1 起一个隔离 workerd。
 *
 * 口径完全照 scripts/test-chat-recovery.mjs（唯一已验证可用的同类工装）：
 * - 独立配置与状态目录：.wrangler/weak-network-test-<port>（名字按端口固定，可重复执行；
 *   不再每次 Date.now() 堆目录，启动前先把上一份残留杀干净再重建）。
 * - 端口默认 8794，用 WEAK_NET_TEST_PORT 覆盖；启动前检查占用，占用即以非 0 退出。
 * - readiness 用 until() 轮询 /__test/health 并核对 runId —— 只有本次实例起来才算就绪，
 *   超时把 worker.log 尾部打到 stdout 并杀掉自己起的进程树。
 * - 绑定对齐 wrangler.jsonc（DO / R2 / ASSETS / VECTORIZE / AI / BROWSER），
 *   否则首屏链路上任何读 env.VECTORIZE_INDEX / env.AI / env.BROWSER 的分支都会在 fixture 里
 *   以「绑定不存在」的方式挂掉，测出来的东西和生产不是一回事。
 * - .dev.vars 只写空串，绝不继承仓库根目录那份带真密钥的文件。
 * - 清理只认自己写的 fixture.json 里的 pid：Windows 用 taskkill /t /f 按 pid 杀进程树，
 *   绝不按进程名匹配，免得误杀别人正在跑的 dev server。
 */
import { spawn } from 'node:child_process';
import net from 'node:net';
import {
  closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const projectRoot = fileURLToPath(new URL('..', import.meta.url));
export const wranglerBase = path.join(projectRoot, '.wrangler');
/** stop 脚本只清理「这个前缀 + 带我们 marker」的目录，别的目录一律不碰。 */
export const TEST_DIR_PREFIX = 'weak-network-test-';
export const MARKER = 'ericher-weak-network-fixture';
const DEFAULT_PORT = 8794;

const posix = file => file.split(path.sep).join('/');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export function resolvePort() {
  const raw = process.env.WEAK_NET_TEST_PORT || process.env.WEAK_NET_PORT || String(DEFAULT_PORT);
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw new Error(`端口不合法：WEAK_NET_TEST_PORT=${raw}（要 1024-65535 的整数）`);
  return port;
}
export const fixtureDirName = port => `${TEST_DIR_PREFIX}${port}`;
export const fixtureRootFor = port => path.join(wranglerBase, fixtureDirName(port));

/** 端口有没有人听：能连上就是被占了。 */
export function portOccupied(port, host = '127.0.0.1') {
  return new Promise(resolve => {
    const socket = net.connect({ port, host });
    const finish = occupied => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(occupied);
    };
    socket.setTimeout(600);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

async function waitPortFree(port, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (!(await portOccupied(port))) return true;
    await sleep(150);
  }
  return false;
}

export function logTail(root, lines = 40) {
  const file = path.join(root, 'worker.log');
  if (!existsSync(file)) return '(worker.log 还不存在)';
  const kept = [];
  let previous;
  for (const line of readFileSync(file, 'utf8').trimEnd().split(/\r?\n/)) {
    // readiness 是反复打同一个探针，日志会全是同一句 GET；连续同形行只留一条，
    // 否则 40 行尾巴全是轮询噪声，把真正的报错挤出窗口。
    const shape = line.replace(/\(\d+(\.\d+)?ms\)/g, '()');
    if (shape === previous) continue;
    previous = shape;
    kept.push(line);
  }
  return kept.slice(-lines).join('\n');
}

function writeFixtureFiles(root, runId) {
  // 空串而不是留白：既保证 fixture 拿不到外部模型密钥，也说明「这里故意不配」。
  writeFileSync(
    path.join(root, '.dev.vars'),
    [
      '# 弱网 fixture 专用：这里刻意全部留空，绝不复制仓库根目录 .dev.vars 的真密钥。',
      'API_KEY=""',
      'API_ENDPOINT=""',
      'API_MODEL=""',
      'TAVILY_API_KEY=""',
      'ZHIPU_KEY=""',
      'MINIMAX_KEY=""',
      'MIMO_KEY=""',
      'DOUBAO_TTS_KEY=""',
      'SK_MAINTENANCE=""',
      '',
    ].join('\n'),
  );
  const num = (name, fallback) => {
    const value = Number(process.env[name]);
    return Number.isFinite(value) && value >= 0 ? value : fallback;
  };
  writeFileSync(
    path.join(root, 'wrangler.json'),
    JSON.stringify(
      {
        name: 'ericher-weak-network-local-only',
        main: posix(path.join(projectRoot, 'test/integration/weakNetworkWorker.ts')),
        compatibility_date: '2026-05-14',
        compatibility_flags: ['nodejs_compat'],
        assets: {
          directory: posix(path.join(projectRoot, 'dist/client')),
          binding: 'ASSETS',
          not_found_handling: 'single-page-application',
          run_worker_first: true,
        },
        durable_objects: { bindings: [{ name: 'COWORK_AGENT', class_name: 'CoworkAgent' }] },
        migrations: [{ tag: 'v1', new_sqlite_classes: ['CoworkAgent'] }],
        r2_buckets: [{ binding: 'MEMORY_BUCKET', bucket_name: 'ericher-weak-network-local-only' }],
        // 对齐 wrangler.jsonc：缺这三个绑定的话，fixture 里的首屏链路和生产不是同一条码。
        vectorize: [{ binding: 'VECTORIZE_INDEX', index_name: 'ericher-weak-network-local' }],
        ai: { binding: 'AI' },
        browser: { binding: 'BROWSER' },
        vars: {
          WEAK_NET_TEST_RUN: runId,
          TEST_MODE: process.env.WEAK_NET_TEST_MODE || 'fast',
          TEST_SHELL_MS: String(num('WEAK_NET_SHELL_MS', 3000)),
          TEST_AUTH_MS: String(num('WEAK_NET_AUTH_MS', 4000)),
          TEST_CHUNK_MS: String(num('WEAK_NET_CHUNK_MS', 12)),
          TEST_CHUNK_BYTES: String(num('WEAK_NET_CHUNK_BYTES', 4096)),
          ADMIN_PASSWORD: 'local-test-123456',
          SESSION_SECRET: 'local-only-session-secret-not-for-public-use',
          API_KEY: '',
          API_ENDPOINT: '',
          API_MODEL: '',
        },
        define: { __APP_VERSION__: '"local-test"', __GIT_HASH__: '"local-test"' },
      },
      null,
      2,
    ),
  );
}

/**
 * 取某个 pid 现在的命令行（Windows 会复用 pid，所以杀之前必须验一次身份）。
 *
 * 为什么验：隔几天再跑、或上一轮被外力打断时，fixture.json 里记的号很可能已经落到别的程序
 * —— 甚至落到我们自己头上。按号硬 taskkill 就是「误杀」，所以只认命令行里带着本次 fixture
 * 目录（--config / --persist-to 那个路径）的进程。返回 null 表示这台机器查不到命令行。
 */
async function commandLineOf(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return '';
  if (process.platform === 'win32') {
    return await new Promise(resolve => {
      const probe = spawn(
        'powershell',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" | Select-Object -ExpandProperty CommandLine`,
        ],
        { stdio: ['ignore', 'pipe', 'ignore'] },
      );
      let out = '';
      probe.stdout.on('data', chunk => (out += chunk));
      probe.once('error', () => resolve(null));
      probe.once('exit', code => resolve(code === 0 ? out.trim() : null));
    });
  }
  try {
    return readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ').trim();
  } catch {
    return await new Promise(resolve => {
      const probe = spawn('ps', ['-p', String(pid), '-o', 'command='], { stdio: ['ignore', 'pipe', 'ignore'] });
      let out = '';
      probe.stdout.on('data', chunk => (out += chunk));
      probe.once('error', () => resolve(null));
      probe.once('exit', code => resolve(code === 0 ? out.trim() : null));
    });
  }
}

/**
 * match=确认是我们那台 wrangler；gone=号上已经没进程；mismatch=号被系统复用（绝不杀）；
 * unknown=这台机器查不到命令行（没有 PowerShell 之类）。
 */
async function classifyFixtureProcess(pid, root) {
  if (!Number.isInteger(pid) || pid <= 0) return 'gone';
  if (pid === process.pid || pid === process.ppid) return 'mismatch'; // 绝不杀自己这条链
  const commandLine = await commandLineOf(pid);
  if (commandLine === null) return 'unknown';
  if (!commandLine) return 'gone';
  const needle = commandLine.toLowerCase();
  return needle.includes(root.toLowerCase()) || needle.includes(root.toLowerCase().replace(/\\/g, '/'))
    ? 'match'
    : 'mismatch';
}

async function killTree(pid) {
  if (process.platform === 'win32') {
    // 按 pid 杀整棵进程树：wrangler dev 会再派生 workerd 子进程，只杀父进程会留下孤儿。
    const stop = spawn('taskkill', ['/pid', String(pid), '/t', '/f'], { stdio: 'ignore' });
    await new Promise(resolve => stop.once('exit', resolve));
    return true;
  }
  try {
    process.kill(-pid, 'SIGTERM'); // detached 启动 = 独立进程组，整组端掉
  } catch {
    /* 进程已经先退出了 */
  }
  return true;
}

/** 杀掉某条 fixture 记录的进程树（只按自己写下的 pid），并删掉自己建的目录。 */
export async function stopFixtureEntry(root, { remove = true } = {}) {
  const marker = path.join(root, 'fixture.json');
  if (!existsSync(marker)) return { killed: false, removed: false };
  const { pid, port } = JSON.parse(readFileSync(marker, 'utf8'));
  let killed = false;
  let skipped;
  if (pid > 0) {
    const kind = await classifyFixtureProcess(pid, root);
    if (kind === 'match') killed = await killTree(pid);
    else if (kind === 'unknown') {
      // 查不到命令行时不能裸杀：加一道镜像名闸门（我们起的一定是 process.execPath 那个 node），
      // 仍按 pid 精确指定，不做按进程名的全表清扫。
      const guard = path.basename(process.execPath);
      const stop = spawn('taskkill', ['/pid', String(pid), '/t', '/f', '/fi', `IMAGENAME eq ${guard}`], { stdio: 'ignore' });
      await new Promise(resolve => stop.once('exit', resolve));
      killed = true;
      skipped = `命令行查不到，只按 ${guard} 闸门放行`;
    } else skipped = kind === 'mismatch' ? 'pid 已被系统复用给别的进程，不动它' : '进程已自行退出';
  }
  if (typeof port === 'number') await waitPortFree(port, 5000);
  let removed = false;
  if (remove) removed = await removeDir(root);
  return { killed, removed, pid, skipped };
}

/**
 * Windows 上进程刚没，workerd 的 SQLite/state 文件句柄可能还挂着几轮；
 * 多试几次，实在删不掉就留给下一次 start 清（同一套 marker，一定被它接手）。
 */
async function removeDir(root) {
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 150 });
    } catch {
      /* 句柄还没释放，下一轮再来 */
    }
    if (!existsSync(root)) return true;
    await sleep(300);
  }
  return !existsSync(root);
}

/**
 * 扫 .wrangler：只处理本工装建的目录（前缀对得上才是我们的命名空间）。
 * - 带 fixture.json 且 owner 对得上的：按里面记的 pid 杀进程树，再删目录。
 * - 只剩骨架的（上次删除时被 SQLite 句柄挡住，marker 已先没了）：只删目录，绝不碰进程。
 * 目录不存在（新克隆就是没有，.gitignore 忽略了它）不算失败。
 */
export async function stopAllFixtures({ remove = true, onlyPort } = {}) {
  if (!existsSync(wranglerBase)) return [];
  const handled = [];
  for (const entry of readdirSync(wranglerBase)) {
    if (!entry.startsWith(TEST_DIR_PREFIX)) continue;
    const root = path.join(wranglerBase, entry);
    // start 只清自己那个端口的残留（别人可能在另一个端口上对比两档弱网，别一起端掉）；
    // stop 脚本不带 onlyPort，收全部。
    if (onlyPort !== undefined && !entry.endsWith(`-${onlyPort}`)) continue;
    const marker = path.join(root, 'fixture.json');
    if (!existsSync(marker)) {
      // 上一轮删到一半被文件句柄卡住的空壳：没有 pid 可依，只能清目录。
      if (remove && (await removeDir(root))) handled.push({ entry, pid: 0, port: 0, killed: false, removed: true, orphan: true });
      continue;
    }
    let record;
    try {
      record = JSON.parse(readFileSync(marker, 'utf8'));
    } catch {
      record = {};
    }
    if (record.owner !== MARKER) continue; // 不是我们写的，绝不代劳去杀
    handled.push({ entry, pid: record.pid, port: record.port, ...(await stopFixtureEntry(root, { remove })) });
  }
  return handled;
}

/**
 * 起一个隔离 fixture，并等它真的能用。
 *
 * 本机 miniflare 开局会去网上一把捞 `Request.cf`（这台机器上这条路是坏的，会卡 5-20s，
 * 偶尔直接把 wrangler dev 拖退）—— 那不是工装坏了，所以「提前退出/超时」这类环境性失败
 * 自动重来一次；端口被占这种确定性失败不重试，直接非 0 退出。
 * @returns { root, runId, port, pid, url, base, ready, stop }
 */
export async function startFixture(options = {}) {
  const attempts = options.attempts ?? (Number(process.env.WEAK_NET_START_ATTEMPTS) || 2);
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await startOnce(options);
    } catch (error) {
      lastError = error;
      if (!error?.retryable || attempt === attempts) break;
      console.log(`第 ${attempt} 次启动没起来（${error.message}），清理后重试…`);
    }
  }
  throw lastError;
}

async function startOnce(options) {
  const port = options.port ?? resolvePort();
  const runId = fixtureDirName(port);
  const root = fixtureRootFor(port);
  const readyMs = options.readyMs ?? (Number(process.env.WEAK_NET_READY_MS) || 60000);
  const base = `http://127.0.0.1:${port}`;

  // 1) 先自愈残留：同端口上次留下的进程树和目录都清掉，保证不在同端口堆进程。
  const stale = await stopAllFixtures({ remove: true, onlyPort: port });
  for (const entry of stale)
    console.log(`清理上次残留的 fixture：pid=${entry.pid} ${entry.skipped ?? (entry.killed ? '进程树已杀' : '没动进程')} 目录${entry.removed ? '已删' : '待清理'}`);
  if (existsSync(root)) await removeDir(root);

  // 2) 端口必须真空出来，否则宁可失败也别把进程堆到同一个端口上。
  if (await portOccupied(port))
    throw new Error(
      `端口 ${port} 已被占用（不是本工装启动的进程，所以不动它）。换个端口：WEAK_NET_TEST_PORT=<其他端口>`,
    );

  mkdirSync(root, { recursive: true });
  writeFixtureFiles(root, runId);

  const log = openSync(path.join(root, 'worker.log'), 'a');
  const child = spawn(
    process.execPath,
    [
      path.join(projectRoot, 'node_modules/wrangler/bin/wrangler.js'),
      'dev',
      '--config',
      path.join(root, 'wrangler.json'),
      '--ip',
      '127.0.0.1',
      '--port',
      String(port),
      '--persist-to',
      path.join(root, 'state'),
      '--local',
    ],
    { cwd: root, stdio: ['ignore', log, log], detached: true },
  );
  const exited = new Promise(resolve => {
    child.once('exit', code => resolve(code ?? 'unknown'));
    child.once('error', error => resolve(`spawn error: ${error.message}`));
  });
  writeFileSync(
    path.join(root, 'fixture.json'),
    JSON.stringify({ owner: MARKER, pid: child.pid, port, runId, url: `${base}/`, startedAt: new Date().toISOString() }),
  );
  child.unref();

  const stop = async ({ remove } = {}) => {
    closeSyncQuiet(log);
    return stopFixtureEntry(root, { remove: remove ?? true });
  };

  // 3) readiness：轮询 /__test/health，且必须认得本次的 runId（挡「起的是别处的旧实例」）。
  let ready;
  try {
    ready = await untilWithAbort(
      async () => {
        const response = await fetch(`${base}/__test/health`, { signal: AbortSignal.timeout(3000) });
        const json = await response.json();
        return json?.runId === runId ? json : undefined;
      },
      { exitPromise: exited, ms: readyMs, label: `${runId} 的 /__test/health（runId 需等于 ${runId}）` },
    );
  } catch (error) {
    // 先把日志尾巴交到 stdout（CI 里 stdout 才会被完整收下），再收拾自己起的进程与目录。
    console.log(`失败：${error.message}`);
    console.log(`--- worker.log 末尾 ---\n${logTail(root)}\n--- 结束 ---`);
    closeSyncQuiet(log);
    const remove = process.env.WEAK_NET_KEEP_FIXTURE !== '1';
    await stopFixtureEntry(root, { remove });
    console.log(remove ? `现场已清理：${root}` : `现场留在：${root}`);
    error.retryable = true; // 只有「起不来」这一类才值得重来；端口占用 etc. 不带这个标记
    throw error;
  }
  closeSyncQuiet(log);
  return { root, runId, port, pid: child.pid, url: `${base}/`, base, ready, stop };
}

async function untilWithAbort(fn, { exitPromise, ms, label }) {
  const end = Date.now() + ms;
  // 就绪或提前退出后要把轮询叫停：否则这个循环会一直打到超时，
  // 白白拖着事件循环让脚本迟几十秒才退出。
  let settled = false;
  const winner = await Promise.race([
    (async () => {
      while (!settled && Date.now() < end) {
        try {
          const result = await fn();
          if (result) return { kind: 'ready', result };
        } catch {
          /* workerd 还没监听端口时 connect refused 属正常 */
        }
        await sleep(150);
      }
      return { kind: 'settled' };
    })(),
    exitPromise.then(code => ({ kind: 'exited', code })),
  ]);
  settled = true;
  if (winner.kind === 'ready') return winner.result;
  if (winner.kind === 'exited')
    throw new Error(`隔离 workerd 提前退出（exit=${winner.code}），多半是 wrangler 配置或绑定被拒：${label}`);
  throw new Error(`timeout: 隔离 workerd 未在 ${ms}ms 内让 ${label} 就绪`);
}

function closeSyncQuiet(fd) {
  try {
    closeSync(fd);
  } catch {
    /* 已经关过 */
  }
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  try {
    const fixture = await startFixture();
    console.log(
      `弱网 fixture 就绪：pid=${fixture.pid} url=${fixture.url} runId=${fixture.runId} 目录=${fixture.root}`,
    );
    console.log('手动检查用 ?mode=throttle|slowShell|slowAuth|auth500 切换弱网条件；stop 脚本按 pid 收进程树。');
  } catch (error) {
    console.error(`弱网 fixture 启动失败：${error.message}`);
    process.exitCode = 1;
  }
}
