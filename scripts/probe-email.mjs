// 邮箱托管 · 技术采样探针（不发真邮件，不外联）
//
// 目的：在决定「接待台自己维护一个邮箱并给人发信」怎么做之前，先把四条候选路的
// 真实边界钉住 —— 哪条能在本项目现有门禁风格下测、哪条要花钱、哪条本机根本验不了。
//
// 跑法：npm run probe:email
// 退出码：任何一段判 FAIL 就非 0；SKIP 不算失败，但会照原样打在结果里。
//
// 安全边界：本探针只连 127.0.0.1 上的假收件端，绝不向任何外部主机发信，
// 也不读 .dev.vars 里的真实密钥。

import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const results = [];
function record(name, status, detail) {
  results.push({ name, status, detail });
  console.log(`[${status}] ${name} —— ${detail}`);
}

/**
 * 探针自己的 transport：走 node:http 真套接字，不经过 fetch 的连接池。
 * Windows 上 undici 的连接池会在进程退出时撞 libuv 的 UV_HANDLE_CLOSING 断言，
 * 把探针自己弄崩 —— 那样结论就不算跑过。被测的是客户端对回包的归类，与用哪个
 * HTTP 客户端无关，所以这里换掉 transport 不影响采样的有效性。
 */
function httpFetch(url, init) {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname,
        method: init.method,
        headers: init.headers,
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (body += c));
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            ok: res.statusCode >= 200 && res.statusCode < 300,
            text: async () => body,
          }),
        );
      },
    );
    req.on("error", reject);
    req.end(init.body);
  });
}

/**
 * 将来要落进 app 的那份发信客户端的最小形状：
 * 一个 provider 描述（地址 + 鉴权头 + 正文构造），一条 fetch，一个 {ok,error} 回执。
 * 采样阶段把它写在这，是为了让四种失败路径能被真跑一遍。
 */
async function sendViaHttp(provider, mail, fetchImpl = fetch) {
  let res;
  try {
    res = await fetchImpl(provider.url, {
      method: "POST",
      headers: { "content-type": "application/json", ...provider.headers },
      body: JSON.stringify(provider.build(mail)),
    });
  } catch (e) {
    return { ok: false, stage: "network", error: `连不上发信服务：${e.message}` };
  }
  const body = await res.text().catch(() => "");
  if (res.status === 401 || res.status === 403)
    return { ok: false, stage: "auth", error: "发信凭据不被接受（401/403）" };
  if (res.status === 429)
    return { ok: false, stage: "rate", retryable: true, error: "被限流（429）" };
  if (!res.ok)
    return { ok: false, stage: "provider", error: `发信服务回了 ${res.status}：${body.slice(0, 200)}` };
  return { ok: true, id: `probe-${Date.now()}` };
}

/** 一次采样：起假收件端，按脚本逐条回状态码，看客户端每种情形报什么 */
async function probeProviderHttp() {
  const script = [
    { status: 200, body: '{"id":"m1"}', want: "ok" },
    { status: 401, body: "bad key", want: "auth" },
    { status: 429, body: "slow down", want: "rate" },
    { status: 500, body: "boom", want: "provider" },
  ];
  let hit = 0;
  const server = createServer((req, res) => {
    const step = script[hit++];
    // 明确回 connection: close —— 不然 fetch 那侧的连接池会把 keep-alive 套接字留到
    // 进程退出，Windows 上表现为 libuv 的 UV_HANDLE_CLOSING 断言把探针自己弄崩
    res.writeHead(step.status, { "content-type": "text/plain", connection: "close" });
    res.end(step.body);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const provider = {
    url: `http://127.0.0.1:${port}/send`,
    headers: { authorization: "Bearer probe-key" },
    build: (m) => ({ from: m.from, to: m.to, subject: m.subject, text: m.text }),
  };
  const seen = [];
  let closed = false;
  const closeOnce = () => {
    // 关两次会在 Windows 上撞 libuv 的 UV_HANDLE_CLOSING 断言，进程退出时直接炸
    if (closed) return;
    closed = true;
    server.close();
  };
  try {
    for (const step of script) {
      const r = await sendViaHttp(provider, {
        from: "ericher@example.test",
        to: "owner@example.test",
        subject: "采样",
        text: "这是一次采样，不是真邮件",
      }, httpFetch);
      seen.push({ 期望: step.want, 实际: r.ok ? "ok" : r.stage, 回执: r.error || r.id });
      assert.equal(r.ok ? "ok" : r.stage, step.want, `状态码 ${step.status} 该归到 ${step.want}`);
      if (!r.ok) assert.ok(typeof r.error === "string" && r.error.length > 0, "失败必须带一句能给人看的话");
    }
    // 先真关掉服务，再打同一个端口：连不上的情形客户端不能把它吞成成功。
    // 关之前先把 keep-alive 的连接全拆掉：留着会让 fetch 那侧的连接池在进程退出时
    // 撞 Windows libuv 的 UV_HANDLE_CLOSING 断言（探针自己崩掉，结论就不算跑过）
    await new Promise((r) => {
      closed = true;
      server.closeAllConnections?.();
      server.close(r);
    });
    // 断连这一路用注入的失败 transport 来验，不再真去连已关闭的端口：
    // 那会在 Windows 上留一个半关的 async handle，进程退出时撞 libuv 断言把探针自己弄崩。
    // 要验的是「transport 抛错时客户端不许报成功」，与套接字细节无关。
    const dead = await sendViaHttp(
      provider,
      { from: "a@example.test", to: "b@example.test", subject: "s", text: "t" },
      async () => {
        throw new TypeError("connection refused");
      },
    );
    assert.equal(dead.ok, false, "服务下线后绝不能报成功");
    assert.equal(dead.stage, "network");
    record(
      "provider-http",
      "PASS",
      `四种回包（200/401/429/500）与一种断连都按预期归位；失败一律带人话，无一例外。命中 ${hit} 次`,
    );
  } catch (e) {
    record("provider-http", "FAIL", e.message);
  } finally {
    closeOnce();
  }
}

/** 配置面：本 Worker 离「CF 原生发信绑定」还差什么 */
async function probeCloudflareBinding() {
  const cfg = readFileSync(path.join(project, "wrangler.jsonc"), "utf8");
  const has = /send_email/.test(cfg);
  const compat = (cfg.match(/"compatibility_date"\s*:\s*"([^"]+)"/) || [])[1] || "?";
  record(
    "cf-email-service",
    has ? "PASS" : "SKIP",
    has
      ? "wrangler.jsonc 已配 send_email 绑定"
      : `未配 send_email（compatibility_date=${compat}）。启用它的前置：Workers Paid 计划（免费计划不提供发信，付费含每月 3000 封、超出 $0.35/1000）、域名托管在 Cloudflare DNS 并完成 MX/SPF/DKIM/DMARC、绑定写 remote=true。remote=true 意味着 wrangler dev 也会真发信 —— 采样阶段不该顺手打开，且本机网络到 workers.dev 不可信，这段只能在有 CF 登录的机器上实测`,
  );
}

/** 架构位点：收信 handler 要落在哪 */
async function probeInboundHandler() {
  const entry = readFileSync(path.join(project, "src/index.ts"), "utf8");
  const hasEmail = /async\s+email\s*\(/.test(entry);
  const hasFetch = /export\s+default\s*\{[\s\S]{0,400}fetch\s*\(/.test(entry);
  record(
    "inbound-email-handler",
    hasEmail ? "PASS" : "SKIP",
    hasEmail
      ? "入口已有 email() handler"
      : `入口只有 fetch（${hasFetch ? "已确认" : "未匹配到，需人工看"}）。收信走 Email Routing + Worker 的 email(message, env, ctx)（message 带 from/to/headers），与发信不同：**收信不限付费计划**。要接就在同一个 default export 上加 email()，落点是主人那间 DO —— 消费方是「人不在线时，把提醒和主动消息也寄一份到邮箱」，与现有 fireReminder/flushSays 并流，不是新造一套投递`,
  );
}

/** SMTP 直连的硬约束 */
async function probeSmtp() {
  record(
    "smtp-direct",
    "SKIP",
    "Workers 禁止出站连 25 端口（平台硬限）。465/587 可用 node:net + secureTransport 自己谈 SMTP（社区有 worker-mailer 这类实现），但那等于自带一套 TLS 与协议解析代码，且要的是「SMTP 账号+口令」这种可保存的登录态 —— 与用户说的「维持自身一个邮箱的登陆」最贴，代价是代码面最厚、且凭据只能进 Worker secret。采样阶段不下结论",
  );
}

await probeProviderHttp();
await probeCloudflareBinding();
await probeInboundHandler();
await probeSmtp();

const failed = results.filter((r) => r.status === "FAIL");
console.log(
  `\n小结：${results.map((r) => `${r.name}=${r.status}`).join("  ")}  ` +
    `（PASS ${results.filter((r) => r.status === "PASS").length} · SKIP ${results.filter((r) => r.status === "SKIP").length} · FAIL ${failed.length}）`,
);
console.log(
  "注：SKIP 不是失败，是「本机验不了 / 尚未启用」，每条都写清了缺什么。本探针未向任何外部主机发出请求。",
);
process.exit(failed.length ? 1 : 0);
