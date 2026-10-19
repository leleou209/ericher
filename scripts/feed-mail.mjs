/**
 * 本地联调：造一封真形状的信，喂进这台机器的收件箱。
 *
 * 为什么要有这一份（而不是等 Cloudflare 真投递）：收件这条路的绝大部分代码
 * —— 解析、指纹去重、落库、读正文 —— 与「信是怎么送到门口的」无关，
 * 而那一步在这儿测不到（本机 DNS 查不了，MX 也没交出去）。
 * 它打的是 POST /api/mail/inbox/feed，走的是与 email() 投递**同一个** mailIngest，
 * 所以这里测过的，线上那一跳就只剩「把 message.raw 交出来」这一件没验。
 *
 * 用法（dev server 起好后）：
 *   node scripts/feed-mail.mjs --base http://localhost:5174 --pw 2547
 *   加 --twice 连喂两封一样的：第二封必须被判成重复（去重那条路的实机证据）
 *
 * 只认本机 dev：口令走命令行、只发给这一台，不落盘。
 */
import { request } from "node:http";

const argv = process.argv.slice(2);
const arg = (name, d) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : d;
};
const base = arg("base", "http://localhost:5174");
const pw = arg("pw", "");
const twice = argv.includes("--twice");

const url = new URL(base);
const port = Number(url.port || 80);

function post(path, body, cookie) {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: url.hostname, port, path, method: "POST", headers: { "Content-Type": "application/json" } },
      (res) => {
        let text = "";
        res.on("data", (c) => (text += c));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, text, cookie: res.headers["set-cookie"] }),
        );
      },
    );
    req.on("error", reject);
    if (cookie) req.setHeader("Cookie", cookie);
    req.end(body);
  });
}

/** 一封该有的样子都有的信：编码主题、multipart、base64 正文、一个附件 */
function sampleMail() {
  const boundary = "ericher-sample-8f2c1";
  const subject = "=?UTF-8?B?" + Buffer.from("关于邮箱托管的一件事").toString("base64") + "?=";
  return [
    "From: =?UTF-8?B?5b6Q5LiA5b6N?= <someone@example.org>",
    "To: ericher@bun.example.test",
    `Subject: ${subject}`,
    "Date: Mon, 19 Oct 2026 16:00:00 +0800",
    "Message-ID: <sample-1@example.org>",
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from("这是一封本地联调用的样例信。\n正文第二行：收到了就说明解析与落库都通了。", "utf8").toString("base64"),
    "",
    `--${boundary}`,
    'Content-Type: application/pdf; name="note.pdf"',
    "Content-Disposition: attachment; filename=\"note.pdf\"",
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from("%PDF-1.4 假附件内容", "utf8").toString("base64"),
    "",
    `--${boundary}--`,
    "",
  ].join("\r\n");
}

function show(label, res) {
  console.log(`${label}: HTTP ${res.status} ${res.text.slice(0, 400)}`);
}

const login = await post("/api/auth", JSON.stringify({ pw }), undefined);
if (login.status !== 200) {
  show("登录失败", login);
  process.exitCode = 1;
} else {
  const cookie = (login.cookie ?? []).map((c) => c.split(";")[0]).join("; ");
  const raw = sampleMail();
  for (let i = 0; i < (twice ? 2 : 1); i++) {
    const r = await post("/api/mail/inbox/feed", JSON.stringify({ raw }), cookie);
    show(`喂第 ${i + 1} 封`, r);
  }
  const box = await new Promise((resolve) => {
    const req = request(
      { host: url.hostname, port, path: "/api/mail/inbox", method: "GET", headers: { Cookie: cookie } },
      (res) => {
        let t = "";
        res.on("data", (c) => (t += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, text: t }));
      },
    );
    req.on("error", (e) => resolve({ status: 0, text: String(e) }));
    req.end();
  });
  show("收件箱", box);
}
