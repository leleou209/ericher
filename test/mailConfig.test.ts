/**
 * 邮件配置（mail_config）的后端门禁。
 *
 * 验的是四件「错了会真出事」的事：
 *   1. 默认 fail-closed：没配过的机器一封都不发，且原因看得懂；
 *   2. 保存能读回真表，可写的只有那十一格 —— password 一类字段进不来也不回显；
 *   3. 每日额度的记账扛得住并发（同一秒两封不能都过闸），寄失败也不退款；
 *   4. 测试发送如实回报：sendMail 抛错就回 {ok:false, 服务器那句话}，绝不吞成成功。
 * 末尾再补路由级底线：坏 body 400 且不执行、来客 403、/api/mail/test 原样转发。
 *
 * 库用真 SQLite（node:sqlite）：建表、补列、种行这些 SQL 只有真库能证明跑得通。
 * SMTP 走注入的假服务器 —— smtp.ts 的 transport 位就是为此而留。
 *
 * 运行: npx vitest run test/mailConfig.test.ts
 */

import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { issueToken, sessionCookie } from "../src/auth";
import { attachFakeSessions } from "./fakeSessions";
import {
  DEFAULT_MAIL_CONFIG,
  MAX_MAIL_RECIPIENTS,
  assertAddressList,
  ensureMailConfigSchema,
  getMailConfigView,
  mailDayKey,
  parseAddressList,
  parseMailConfigInput,
  recordMailSend,
  reserveMailSlot,
  saveMailConfig,
  type MailConfigPatch,
  type MailConfigView,
} from "../src/mail/store";
import { listMailOut } from "../src/mail/mailbox";
import {
  sendConfiguredMail,
  type MailJob,
  type MailSendResult,
} from "../src/mail/send";
import type { SocketTransport } from "../src/mail/smtp";
import type { SqlTag } from "../src/agent/state";
import { CoworkAgent } from "../src/agent/cowork";
import worker from "../src/index";
import { EML_FEED_MAX } from "../src/mail/mailbox";

vi.mock("@cloudflare/ai-chat", () => ({ AIChatAgent: class {} }));
vi.mock("agents", () => ({
  routeAgentRequest: vi.fn(async () => null),
  getCurrentAgent: () => ({ agent: undefined }),
}));

// ── 真 SQLite ───────────────────────────────────────────

function database(): { db: DatabaseSync; sql: SqlTag } {
  const db = new DatabaseSync(":memory:");
  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) =>
    db
      .prepare(strings.join("?"))
      .all(...(values as (string | number | null)[])) as never) as unknown as SqlTag;
  return { db, sql };
}

/** 库里那一行的原文：证明「读回来」读的是落进真表的东西，不是返回值里的自说自话 */
function rawRow(db: DatabaseSync): Record<string, unknown> {
  return db
    .prepare("SELECT * FROM mail_config WHERE id = 'main'")
    .get() as Record<string, unknown>;
}

// ── 一份「配好了」的配置 ─────────────────────────────────

const SECRET_NAME = "SMTP_PASSWORD";
const SECRET_VALUE = "sup3rs3cret-pw";
const USER = "ericher@example.test";

function readyEnv(): Record<string, unknown> {
  return { [SECRET_NAME]: SECRET_VALUE };
}

function readyPatch(): MailConfigPatch {
  return parseMailConfigInput({
    enabled: true,
    hostname: "smtp.example.test",
    port: 465,
    secure: true,
    username: USER,
    keySecret: SECRET_NAME,
    from: "ericher@example.test",
    to: "owner@example.test",
    dailyCap: 5,
  });
}

/** 建库 + 存好配置：返回同一个库的句柄，好把「发一封」和「查真表」接起来 */
function readyDesk(patch: MailConfigPatch = readyPatch()) {
  const desk = database();
  saveMailConfig(desk.sql, patch);
  return desk;
}

const job = { subject: "测试邮件", text: "正文一行" };

// ── 假 SMTP 服务器 ──────────────────────────────────────

const enc = new TextEncoder();
const dec = new TextDecoder();

class FakeServer {
  opened = Promise.resolve();
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
  lines: string[] = [];
  // 运行时报告：本假件代表一条已加密的通道
  get secureTransport(): "on" | "off" | "starttls" {
    return "on";
  }
  afterTls?: FakeServer;
  private ctrl!: ReadableStreamDefaultController<Uint8Array>;
  private pending = "";
  private mode: "command" | "data" = "command";
  constructor(
    private opts: { authOk?: boolean; greet?: boolean } = {},
  ) {
    const self = this;
    this.readable = new ReadableStream({
      start(c) {
        self.ctrl = c;
        if (opts.greet !== false) c.enqueue(enc.encode("220 fake ESMTP\r\n"));
      },
    });
    this.writable = new WritableStream({
      write(chunk) {
        self.pending += dec.decode(chunk, { stream: true });
        let i: number;
        while ((i = self.pending.indexOf("\r\n")) >= 0) {
          const line = self.pending.slice(0, i);
          self.pending = self.pending.slice(i + 2);
          self.handle(line);
        }
      },
    });
  }
  private say(text: string): void {
    this.ctrl.enqueue(enc.encode(text));
  }
  private handle(line: string): void {
    this.lines.push(line);
    if (this.mode === "data") {
      if (line === ".") this.say("250 2.0.0 Ok: queued\r\n");
      return;
    }
    const cmd = line.split(" ")[0].toUpperCase();
    if (cmd === "EHLO") {
      this.say("250-fake\r\n250-AUTH PLAIN LOGIN\r\n250 Ok\r\n");
      return;
    }
    if (cmd === "AUTH")
      return this.say(
        this.opts.authOk === false ? "535 认证失败\r\n" : "235 2.7.0 Accepted\r\n",
      );
    if (cmd === "MAIL" || cmd === "RCPT") return this.say("250 2.1.0 Ok\r\n");
    if (cmd === "DATA") {
      this.mode = "data";
      return this.say("354 End data with <CR><LF>.<CR><LF>\r\n");
    }
    if (cmd === "QUIT") return this.say("221 2.0.0 Bye\r\n");
    this.say("250 Ok\r\n");
  }
  startTls(): FakeServer {
    const next = new FakeServer({ ...this.opts, greet: false });
    this.afterTls = next;
    return next;
  }
  close(): void {}
}

/**
 * delay 为真时先让出一个 tick：并发那两条断言要的就是「两个 await 都挂着」的那一刻。
 */
function harness(
  opts: { authOk?: boolean; delay?: boolean } = {},
): { transport: SocketTransport; calls: () => number; lines: () => string } {
  const made: FakeServer[] = [];
  const transport: SocketTransport = async () => {
    if (opts.delay) await new Promise((r) => setTimeout(r, 5));
    const s = new FakeServer({ authOk: opts.authOk });
    made.push(s);
    return s;
  };
  return {
    transport,
    calls: () => made.length,
    lines: () =>
      made
        .flatMap((s) => [...s.lines, ...(s.afterTls?.lines ?? [])])
        .join("\n"),
  };
}

// ── 1. 默认值 fail-closed ───────────────────────────────

describe("默认值 fail-closed", () => {
  it("新库读回来就是关着的配置，额度是个保守数", () => {
    const { sql } = database();
    // 值写死在这里，不拿 DEFAULT_MAIL_CONFIG 去对 DEFAULT_MAIL_CONFIG ——
    // 自指的断言翻不出「默认值本身被改坏了」这种错
    expect(getMailConfigView(sql, {})).toEqual({
      enabled: false,
      hostname: "",
      port: 465,
      secure: true,
      username: "",
      keySecret: "",
      from: "",
      to: "",
      dailyCap: 20,
      sayMail: false,
      inboxEnabled: false,
      keyAvailable: false,
      lastSend: null,
      toList: [],
    });
    // 常量与表定义得同时是关的：只钉其中一个，另一个被翻过来时测试不响
    expect(DEFAULT_MAIL_CONFIG.enabled).toBe(false);
    expect(DEFAULT_MAIL_CONFIG.dailyCap).toBe(20);
  });

  it("什么都没配过的新库：连一封都发不出去，也不会去拨号", async () => {
    const { sql } = database();
    const h = harness();
    const r = await sendConfiguredMail(
      sql,
      { [SECRET_NAME]: SECRET_VALUE },
      job,
      h.transport,
    );
    expect(r.ok === false && /关/.test(r.error)).toBe(true);
    expect(h.calls()).toBe(0);
  });

  it("种下的那一行 id 恒为 main；再建一次表也不把改过的洗回默认", () => {
    const { db, sql } = database();
    saveMailConfig(sql, { hostname: "smtp.example.test" });
    ensureMailConfigSchema(sql);
    ensureMailConfigSchema(sql);
    expect(rawRow(db).hostname).toBe("smtp.example.test");
    expect(db.prepare("SELECT COUNT(*) AS n FROM mail_config").get()).toEqual({
      n: 1,
    });
  });

  it("enabled 关着：不发、原因看得懂，而且压根不碰网络", async () => {
    const { sql } = readyDesk({ ...readyPatch(), enabled: false });
    const h = harness();
    const r = await sendConfiguredMail(sql, readyEnv(), job, h.transport);
    expect(r.ok === false && /关/.test(r.error)).toBe(true);
    expect(h.calls()).toBe(0);
  });

  it("变量名没选 / 变量没配 / 发件地址空：三样都拦在拨号之前", async () => {
    const h = harness();
    const noVar = database();
    saveMailConfig(noVar.sql, readyPatch());
    const a = await sendConfiguredMail(noVar.sql, {}, job, h.transport);
    expect(a.ok === false && a.error).toContain(SECRET_NAME);

    const noName = readyDesk({ ...readyPatch(), keySecret: "" });
    const b = await sendConfiguredMail(noName.sql, readyEnv(), job, h.transport);
    expect(b.ok === false && /secret|变量名/.test(b.error)).toBe(true);

    const noFrom = readyDesk({ ...readyPatch(), from: "" });
    const c = await sendConfiguredMail(noFrom.sql, readyEnv(), job, h.transport);
    expect(c.ok === false && /发件地址/.test(c.error)).toBe(true);

    expect(h.calls()).toBe(0);
  });

  it("没填 SMTP 服务器 / 用户名时同样不发", async () => {
    const h = harness();
    const noHost = readyDesk({ ...readyPatch(), hostname: "" });
    const noUser = readyDesk({ ...readyPatch(), username: "" });
    expect(
      (await sendConfiguredMail(noHost.sql, readyEnv(), job, h.transport)).ok ===
        false,
    ).toBe(true);
    expect(
      (await sendConfiguredMail(noUser.sql, readyEnv(), job, h.transport)).ok ===
        false,
    ).toBe(true);
    expect(h.calls()).toBe(0);
  });
});

// ── 2. 保存与读回 ───────────────────────────────────────

describe("保存与读回", () => {
  it("十一格存进去，能从真表里读回来", () => {
    const { db, sql } = readyDesk();
    expect(getMailConfigView(sql, readyEnv())).toEqual({
      enabled: true,
      hostname: "smtp.example.test",
      port: 465,
      secure: true,
      username: USER,
      keySecret: SECRET_NAME,
      from: "ericher@example.test",
      to: "owner@example.test",
      dailyCap: 5,
      sayMail: false,
      inboxEnabled: false,
      keyAvailable: true,
      lastSend: null,
      toList: ["owner@example.test"],
    });
    const row = rawRow(db);
    expect(row.hostname).toBe("smtp.example.test");
    expect(row.daily_cap).toBe(5);
    expect(row.enabled).toBe(1);
  });

  it("字段缺省不动：只改 dailyCap，其余原样；今天的账也不被这次保存洗掉", () => {
    const { db, sql } = readyDesk({ ...readyPatch(), dailyCap: 3 });
    reserveMailSlot(sql, new Date());
    saveMailConfig(sql, { dailyCap: 9 });
    const again = getMailConfigView(sql, readyEnv());
    expect(again.dailyCap).toBe(9);
    expect(again.hostname).toBe("smtp.example.test");
    expect(again.enabled).toBe(true);
    expect(rawRow(db).sent_count).toBe(1);
  });

  it("端口 25、地址非法、主机名带尖括号：存之前就被拦下", () => {
    expect(() => parseMailConfigInput({ port: 25 })).toThrow(/25 端口/);
    expect(() => parseMailConfigInput({ port: 70000 })).toThrow(/65535/);
    expect(() => parseMailConfigInput({ from: "a@b" })).toThrow(/格式不对/);
    expect(() => parseMailConfigInput({ hostname: "bad host" })).toThrow(
      /主机名/,
    );
    expect(() => parseMailConfigInput({ dailyCap: 100000 })).toThrow(
      /每日上限/,
    );
    expect(() => parseMailConfigInput({ enabled: "开" })).toThrow(/true/);
    // 绕过 HTTP 直接写库的，saveMailConfig 这一道也得拦住
    const { sql } = database();
    expect(() => saveMailConfig(sql, { hostname: "bad<x" })).toThrow(/主机名/);
    expect(() => saveMailConfig(sql, { port: 25 })).toThrow(/25 端口/);
  });

  it("password 一类字段进不来、不落表、不回显", () => {
    const { db, sql } = database();
    const patch = parseMailConfigInput({
      ...readyPatch(),
      password: "hunter2",
      passcode: "hunter2",
      smtpPassword: "hunter2",
      auth: { password: "hunter2" },
    });
    expect(Object.keys(patch).sort()).toEqual(
      [
        "dailyCap",
        "enabled",
        "from",
        "hostname",
        "keySecret",
        "port",
        "secure",
        "to",
        "username",
      ].sort(),
    );
    expect(JSON.stringify(patch)).not.toContain("hunter2");

    // 绕过 parse 直接经 RPC 调 DO 也写不进去：saveMailConfig 只按名取那十一格
    saveMailConfig(sql, {
      ...readyPatch(),
      password: "hunter2",
    } as MailConfigPatch);
    const view = JSON.stringify(getMailConfigView(sql, readyEnv()));
    expect(view).not.toContain("hunter2");
    expect(view).not.toContain(SECRET_VALUE);
    expect(Object.keys(getMailConfigView(sql, readyEnv())).sort()).toEqual(
      [
        "dailyCap",
        "enabled",
        "from",
        "hostname",
        "inboxEnabled",
        "keyAvailable",
        "keySecret",
        "lastSend",
        "port",
        "sayMail",
        "secure",
        "to",
        "toList",
        "username",
      ].sort(),
    );
    const cols = (db.prepare("PRAGMA table_info(mail_config)").all() as Array<{
      name: string;
    }>).map((c) => c.name);
    expect(cols).not.toContain("password");
    expect(cols).toContain("key_secret");
  });
});

// ── 3. keyAvailable 的真假两路 ──────────────────────────

describe("keyAvailable", () => {
  it("变量在 env 里就是真，值本身一个字节都不出去", () => {
    const { sql } = readyDesk();
    const on = getMailConfigView(sql, readyEnv());
    expect(on.keyAvailable).toBe(true);
    expect(JSON.stringify(on)).not.toContain(SECRET_VALUE);
  });

  it("变量不在 / 是空白 / 没选变量名：三种都算没配", () => {
    const { sql } = readyDesk();
    expect(getMailConfigView(sql, {}).keyAvailable).toBe(false);
    expect(getMailConfigView(sql, { [SECRET_NAME]: "   " }).keyAvailable).toBe(
      false,
    );
    saveMailConfig(sql, { keySecret: "" });
    expect(getMailConfigView(sql, readyEnv()).keyAvailable).toBe(false);
  });

  it("body 里塞口令不会让它变真：认的只是那个变量", () => {
    const { sql } = database();
    saveMailConfig(
      sql,
      parseMailConfigInput({ ...readyPatch(), password: SECRET_VALUE }),
    );
    expect(getMailConfigView(sql, {}).keyAvailable).toBe(false);
  });

  it("换了变量名就按新名字算：老变量还在也不作数", () => {
    const { sql } = readyDesk();
    saveMailConfig(sql, { keySecret: "OTHER_SECRET" });
    expect(getMailConfigView(sql, readyEnv()).keyAvailable).toBe(false);
    expect(
      getMailConfigView(sql, { OTHER_SECRET: "x" }).keyAvailable,
    ).toBe(true);
  });
});

// ── 4. 每日额度 ─────────────────────────────────────────

describe("每日额度", () => {
  it("上限 2：第 3 封被拦，且第 3 封不碰网络", async () => {
    const { sql } = readyDesk({ ...readyPatch(), dailyCap: 2 });
    const h = harness();
    expect(await sendConfiguredMail(sql, readyEnv(), job, h.transport)).toEqual({
      ok: true,
    });
    expect(await sendConfiguredMail(sql, readyEnv(), job, h.transport)).toEqual({
      ok: true,
    });
    const third = await sendConfiguredMail(sql, readyEnv(), job, h.transport);
    expect(third.ok === false && /额度用完/.test(third.error)).toBe(true);
    expect(h.calls()).toBe(2);
  });

  it("并发两封只占一格：一成一拒，账上只加一，网络只碰一次", async () => {
    const { db, sql } = readyDesk({ ...readyPatch(), dailyCap: 1 });
    const h = harness({ delay: true });
    const [a, b] = await Promise.all([
      sendConfiguredMail(sql, readyEnv(), job, h.transport),
      sendConfiguredMail(sql, readyEnv(), job, h.transport),
    ]);
    const results = [a, b];
    expect(results.filter((r) => r.ok === true).length).toBe(1);
    expect(
      results.filter((r) => r.ok === false && /额度/.test(r.error)).length,
    ).toBe(1);
    // 真正咬人的是这一条：被拦下的那封不许已经出了门。
    // 「记账挪到 await 之后」这种错，两个结果照样是一成一拒，只有拨号次数出卖它。
    expect(h.calls()).toBe(1);
    expect(h.lines().split("MAIL FROM").length - 1).toBe(1);
    expect(rawRow(db).sent_count).toBe(1);
  });

  it("账落进真表：占掉一格后 sent_day 是今天、sent_count 累加", () => {
    const { db, sql } = readyDesk({ ...readyPatch(), dailyCap: 3 });
    expect(reserveMailSlot(sql, new Date())).toEqual({ ok: true });
    expect(rawRow(db).sent_day).toBe(mailDayKey());
    expect(rawRow(db).sent_count).toBe(1);
    expect(reserveMailSlot(sql, new Date()).ok).toBe(true);
    expect(rawRow(db).sent_count).toBe(2);
    expect(reserveMailSlot(sql, new Date()).ok).toBe(true);
    expect(reserveMailSlot(sql, new Date()).ok === false).toBe(true);
    expect(rawRow(db).sent_count).toBe(3);
  });

  it("跨天就重置：昨天占满的额度挡不住今天", () => {
    const { db, sql } = readyDesk({ ...readyPatch(), dailyCap: 1 });
    const yesterday = new Date(Date.now() + 8 * 3600_000 - 86_400_000);
    expect(reserveMailSlot(sql, yesterday).ok).toBe(true);
    expect(reserveMailSlot(sql, yesterday).ok === false).toBe(true);
    db.exec("UPDATE mail_config SET sent_day = '' WHERE id = 'main'");
    expect(reserveMailSlot(sql, new Date()).ok).toBe(true);
  });

  it("mailDayKey 按北京时间切：UTC 零点那会儿还是同一天", () => {
    // 北京时间 00:30 == UTC 16:30（前一天）：按 UTC 算会把这天当成昨天，额度白重置
    const beijingMidnight = new Date("2026-03-05T16:30:00Z");
    expect(mailDayKey(beijingMidnight)).toBe("2026-03-06");
    expect(beijingMidnight.toISOString().slice(0, 10)).toBe("2026-03-05");
  });

  it("上限 0 等于不发：那是「静音」那一档，不是「随便发」", async () => {
    const { sql } = readyDesk({ ...readyPatch(), dailyCap: 0 });
    const h = harness();
    const r = await sendConfiguredMail(sql, readyEnv(), job, h.transport);
    expect(r.ok === false && /上限是 0/.test(r.error)).toBe(true);
    expect(h.calls()).toBe(0);
  });

  it("寄失败也占过额度，不退款：半路断时服务器可能已经收了件", async () => {
    const { sql } = readyDesk({ ...readyPatch(), dailyCap: 1 });
    const bad = harness({ authOk: false });
    expect((await sendConfiguredMail(sql, readyEnv(), job, bad.transport)).ok).toBe(
      false,
    );
    const second = await sendConfiguredMail(
      sql,
      readyEnv(),
      job,
      harness().transport,
    );
    expect(second.ok === false && /额度用完/.test(second.error)).toBe(true);
  });
});

// ── 5. 如实回报 ─────────────────────────────────────────

describe("如实回报", () => {
  it("sendMail 抛错时回 {ok:false, 服务器那句话}，并记进 lastSend", async () => {
    const { sql } = readyDesk();
    const h = harness({ authOk: false });
    const r = await sendConfiguredMail(sql, readyEnv(), job, h.transport);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toMatch(/^认证失败/);
    const log = getMailConfigView(sql, readyEnv()).lastSend;
    expect(log?.ok).toBe(false);
    expect(log?.to).toBe("owner@example.test");
    expect(log?.error).toMatch(/认证/);
    expect(log?.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("寄成功时 {ok:true}，lastSend 记成没有错误的一句", async () => {
    const { sql } = readyDesk();
    const h = harness();
    expect(await sendConfiguredMail(sql, readyEnv(), job, h.transport)).toEqual({
      ok: true,
    });
    expect(h.lines()).toContain("RCPT TO:<owner@example.test>");
    const log = getMailConfigView(sql, readyEnv()).lastSend;
    expect(log).toMatchObject({ ok: true, error: "", to: "owner@example.test" });
  });

  it("口令只在 AUTH 那一行：响应与 lastSend 里没有明文、也没有 base64", async () => {
    const { sql } = readyDesk();
    const h = harness({ authOk: false });
    const r = await sendConfiguredMail(sql, readyEnv(), job, h.transport);
    const token = btoa(`\0${USER}\0${SECRET_VALUE}`);
    const outward = JSON.stringify(r) +
      JSON.stringify(getMailConfigView(sql, readyEnv()).lastSend);
    expect(outward).not.toContain(SECRET_VALUE);
    expect(outward).not.toContain(btoa(SECRET_VALUE));
    expect(outward).not.toContain(token);
    // 但内核确实拿着口令去认证了 —— 否则这条断言会「因为没发而通过」
    expect(h.lines()).toContain(`AUTH PLAIN ${token}`);
  });

  it("body 里的 to 换掉收件地址，配置里的 to 不动", async () => {
    const { sql } = readyDesk();
    const h = harness();
    expect(
      await sendConfiguredMail(
        sql,
        readyEnv(),
        { ...job, to: "someone@example.test" },
        h.transport,
      ),
    ).toEqual({ ok: true });
    expect(h.lines()).toContain("RCPT TO:<someone@example.test>");
    const view = getMailConfigView(sql, readyEnv());
    expect(view.lastSend?.to).toBe("someone@example.test");
    expect(view.to).toBe("owner@example.test");
  });

  it("空白 to 落回配置里的默认收件地址", async () => {
    const { sql } = readyDesk();
    const h = harness();
    expect(
      await sendConfiguredMail(sql, readyEnv(), { ...job, to: "   " }, h.transport),
    ).toEqual({ ok: true });
    expect(h.lines()).toContain("RCPT TO:<owner@example.test>");
  });

  it("收件地址带 CRLF 时不占额度：形状错了根本不去连网络", async () => {
    const { db, sql } = readyDesk();
    const h = harness();
    const r = await sendConfiguredMail(
      sql,
      readyEnv(),
      { ...job, to: "a@b.test\r\nRCPT TO:<evil@x.test>" },
      h.transport,
    );
    expect(r.ok).toBe(false);
    expect(h.calls()).toBe(0);
    expect(rawRow(db).sent_count).toBe(0);
  });

  it("配置里的 to 是空的、这次也没带：明说没有收件地址", async () => {
    const { sql } = readyDesk({ ...readyPatch(), to: "" });
    const h = harness();
    const r = await sendConfiguredMail(sql, readyEnv(), job, h.transport);
    expect(r.ok === false && /收件地址/.test(r.error)).toBe(true);
    expect(h.calls()).toBe(0);
  });

  it("last_send 写坏了当没寄过：一次脏数据不该把面板弄崩", () => {
    const { db, sql } = readyDesk();
    recordMailSend(sql, { at: "x", ok: true, error: "", to: "a@b.test" });
    db.exec("UPDATE mail_config SET last_send = '{坏' WHERE id = 'main'");
    expect(getMailConfigView(sql, readyEnv()).lastSend).toBeNull();
  });
});

// ── 6. DO 上的三个方法 ──────────────────────────────────

/**
 * 顶着假 this 把 CoworkAgent 的三个方法 call 出来（真 SQLite，不起运行时）。
 * 这一层被「假 agent」顶掉时看不见两类错：路由接错名字、主人房守卫漏了。
 */
type MailDo = { dbTag: SqlTag; env: Record<string, unknown>; name: string };
const mailDo = CoworkAgent.prototype as unknown as {
  mailConfigGet(this: MailDo): Promise<MailConfigView>;
  mailConfigSave(this: MailDo, patch: MailConfigPatch): Promise<MailConfigView>;
  mailTestSend(this: MailDo, to?: string): Promise<MailSendResult>;
  mailSendForAgent(this: MailDo, job: MailJob): Promise<MailSendResult>;
  sendMailViaOwnerRoom(this: MailDo, job: MailJob): Promise<MailSendResult>;
  toolCtx(
    this: MailDo,
  ): { sendMail: (job: MailJob) => Promise<MailSendResult> };
  mailMissedSays(this: MailDo, lines: string[]): Promise<void>;
  mailComposeSend(
    this: MailDo,
    input: { to?: string; subject?: string; text?: string },
  ): Promise<MailSendResult>;
};

function fakeAgent(sql: SqlTag, env: Record<string, unknown>, name = "default") {
  const self = Object.create(CoworkAgent.prototype) as Record<string, unknown>;
  // db 是只有 getter 的属性，直接赋值会炸；注进它缓存的那个字段，getter 就不去碰 this.sql
  self.dbTag = sql;
  self.env = env;
  self.name = name;
  return self as unknown as MailDo;
}

describe("DO 上的三个方法", () => {
  it("mailConfigGet 读的就是这间屋的表：默认关着，口令不回显", async () => {
    const { sql } = database();
    const v = await mailDo.mailConfigGet.call(fakeAgent(sql, readyEnv()));
    expect(v.enabled).toBe(false);
    expect(v.keyAvailable).toBe(false);
    expect(v.keySecret).toBe("");
  });

  it("mailConfigSave 写进真表，再 call 一次 GET 读回来还是那份", async () => {
    const { db, sql } = database();
    const a = fakeAgent(sql, readyEnv());
    const saved = await mailDo.mailConfigSave.call(a, readyPatch());
    expect(saved.keyAvailable).toBe(true);
    expect(rawRow(db).hostname).toBe("smtp.example.test");
    expect(await mailDo.mailConfigGet.call(a)).toEqual(saved);
  });

  it("来客那间改不动邮件配置：主人房守卫在 DO 上，不在路由那一层", async () => {
    const { sql } = database();
    const guest = fakeAgent(sql, readyEnv(), "guest-abc");
    await expect(
      mailDo.mailConfigSave.call(guest, readyPatch()),
    ).rejects.toThrow(/主屋/);
    await expect(mailDo.mailTestSend.call(guest)).rejects.toThrow(/主屋/);
    // 场屋也不行：配置行与流水只存在主屋那一库里，让场屋写得动就等于
    // 写进一本没人读得到的账（fetchDrawTiers 那个坑的同型，见 sendMailViaOwnerRoom）
    const room = fakeAgent(sql, readyEnv(), "default--s9");
    await expect(
      mailDo.mailConfigSave.call(room, readyPatch()),
    ).rejects.toThrow(/主屋/);
    await expect(
      mailDo.mailTestSend.call(room),
    ).rejects.toThrow(/主屋/);
    await expect(
      mailDo.mailComposeSend.call(room, { subject: "s", text: "t" }),
    ).rejects.toThrow(/主屋/);
    // 主屋本尊照旧能存
    expect(
      (await mailDo.mailConfigSave.call(fakeAgent(sql, readyEnv()), readyPatch()))
        .enabled,
    ).toBe(true);
  });

  it("mailTestSend 走的正是那份配置：enabled 关着就发不出去", async () => {
    const { sql } = readyDesk();
    saveMailConfig(sql, { enabled: false });
    const r = await mailDo.mailTestSend.call(fakeAgent(sql, readyEnv()));
    expect(r.ok === false && /关/.test(r.error)).toBe(true);
  });

  it("mailTestSend 在钥匙没配时把变量名说给人看，值一个字节不出去", async () => {
    const { sql } = database();
    saveMailConfig(sql, readyPatch());
    const r = await mailDo.mailTestSend.call(fakeAgent(sql, {}));
    expect(r.ok === false && r.error).toContain(SECRET_NAME);
    expect(JSON.stringify(r)).not.toContain(SECRET_VALUE);
  });
});

/**
 * 发信工具在**场屋**里读哪张表 —— 真机上踩过的那一条：
 * 配置行与每日额度只存在主屋的库里，场屋（`default--某场`）自己那张是默认值
 * （enabled=false），就地读就等于「管理员明明配好了，工具却说开关没开」。
 * 所以这一组钉的是：转交真发生了、接线就是那一条、转不动时不许假装成功。
 */
describe("发信工具的跨间取配置", () => {
  const job: MailJob = { subject: "跨间测试", text: "一行正文" };

  /** 一间没有配置（空表 = 默认关着）的场屋，加一个记账的主屋替身 */
  function sessionRoom(get: (name: string) => unknown) {
    const { sql } = database();
    const room = fakeAgent(sql, {
      COWORK_AGENT: { idFromName: (n: string) => n, get },
    }, "default--s9");
    (room as unknown as Record<string, unknown>).state = {};
    return room;
  }

  it("场屋的发信转交主屋，读的不是自己那张空表", async () => {
    const owner = vi.fn(async () => ({ ok: true }) as MailSendResult);
    const r = await mailDo.sendMailViaOwnerRoom.call(
      sessionRoom(() => ({ mailSendForAgent: owner })),
      job,
    );
    expect(r).toEqual({ ok: true });
    expect(owner).toHaveBeenCalledTimes(1);
  });

  it("toolCtx 上那根线接的就是转交那一条", async () => {
    const owner = vi.fn(async () => ({ ok: true }) as MailSendResult);
    const ctx = mailDo.toolCtx.call(
      sessionRoom(() => ({ mailSendForAgent: owner })),
    );
    expect(await ctx.sendMail(job)).toEqual({ ok: true });
    expect(owner).toHaveBeenCalledTimes(1);
  });

  it("主屋没应答时照实说没寄出，不吞成成功", async () => {
    const r = await mailDo.sendMailViaOwnerRoom.call(
      sessionRoom(() => {
        throw new Error("DO 唤醒失败");
      }),
      job,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("没寄出");
  });

  it("场屋与来客都不许就地执行主屋那条路", async () => {
    const { sql } = database();
    for (const name of ["default--s9", "guest-abc"]) {
      await expect(
        mailDo.mailSendForAgent.call(fakeAgent(sql, readyEnv(), name), job),
      ).rejects.toThrow(/主屋/);
    }
    // 主屋本尊就地执行：这一步会真去连，凭据与额度都在主屋那行上判
    const owner = fakeAgent(readyDesk().sql, readyEnv(), "default");
    const r = await mailDo.mailSendForAgent.call(owner, job);
    expect(r.ok === false && /cloudflare:sockets|ECONN|TLS|认证|发送/.test(r.error)).toBe(
      true,
    );
  });
});

// ── 7. 路由层 ───────────────────────────────────────────

describe("路由", () => {
  function view(): MailConfigView {
    return { ...DEFAULT_MAIL_CONFIG, enabled: true, hostname: "smtp.example.test", keySecret: SECRET_NAME, keyAvailable: false, lastSend: null, toList: [] };
  }

  function environment() {
    const agent = {
      logVisitor: vi.fn(),
      cardPerm: vi.fn(async () => false),
      mailConfigGet: vi.fn(async () => view()),
      mailConfigSave: vi.fn(async (_patch: MailConfigPatch) => view()),
      mailTestSend: vi.fn(async (_to?: string) => ({ ok: true })),
      mailComposeSend: vi.fn(async (_input: unknown) => ({ ok: true })),
      // 信箱那几本账：路由只该把它们原样接过去，形状由 DO 那边给
      mailOutbox: vi.fn(async (_limit?: number) => [
        {
          at: "2026-10-19T08:00:00.000Z",
          to: ["a@x.test", "b@y.test"],
          subject: "周报",
          ok: false,
          error: "认证被拒绝",
          source: "tool",
        },
      ]),
      mailInbox: vi.fn(async (_limit?: number) => ({
        rows: [],
        unread: 0,
        enabled: true,
      })),
      mailInboxRead: vi.fn(async (id: string) => ({
        row: null,
        text: "",
        note: `没有这一封：${id}`,
      })),
      mailInboxOpen: vi.fn(async (id: string, read: boolean) => ({ id, read })),
      mailIngest: vi.fn(async (raw: string) => ({
        ok: true,
        row: {
          id: "m1",
          at: "2026-10-19T09:00:00.000Z",
          from: "x@y.test",
          fromName: "",
          to: "ericher@bun.example.test",
          subject: "hi",
          bytes: raw.length,
          read: false,
          hasAttachment: false,
          preview: "p",
          emlKey: "",
        },
      })),
    };
    const env = {
      ADMIN_PASSWORD: "admin-test",
      GATE_PASSWORD: "guest-test",
      SESSION_SECRET: "test-session-secret",
      COWORK_AGENT: {
        idFromName: (name: string) => name,
        get: () => agent,
      },
      ASSETS: { fetch: vi.fn(async () => new Response("app")) },
    } as unknown as Env;
    attachFakeSessions(agent);
    return { env, agent };
  }

  async function request(
    env: Env,
    path: string,
    role: "admin" | "user",
    init: RequestInit = {},
  ) {
    const token = await issueToken(env, role);
    return new Request(`https://app.test${path}`, {
      ...init,
      headers: { Cookie: sessionCookie(token, true).split(";")[0] },
    });
  }

  it("管理员 GET 拿到 {ok:true,data:视图}，里面没有口令", async () => {
    const { env, agent } = environment();
    const res = await worker.fetch(
      await request(env, "/api/mail/config", "admin"),
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; data: MailConfigView };
    expect(body.ok).toBe(true);
    expect(body.data.hostname).toBe("smtp.example.test");
    expect(body.data.keyAvailable).toBe(false);
    expect(JSON.stringify(body)).not.toContain("password");
    expect(JSON.stringify(body)).not.toContain(SECRET_VALUE);
    expect(agent.mailConfigGet).toHaveBeenCalledOnce();
  });

  it("来客碰不到邮件配置：读写都是 403，DO 一次没被叫", async () => {
    const { env, agent } = environment();
    expect(
      (await worker.fetch(await request(env, "/api/mail/config", "user"), env))
        .status,
    ).toBe(403);
    expect(
      (
        await worker.fetch(
          await request(env, "/api/mail/config", "user", {
            method: "POST",
            body: "{}",
          }),
          env,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await worker.fetch(
          await request(env, "/api/mail/test", "user", {
            method: "POST",
            body: "{}",
          }),
          env,
        )
      ).status,
    ).toBe(403);
    expect(agent.mailConfigGet).not.toHaveBeenCalled();
    expect(agent.mailConfigSave).not.toHaveBeenCalled();
    expect(agent.mailTestSend).not.toHaveBeenCalled();
  });

  it.each(["null", "[]", "broken", '{"a":1'])(
    "写接口坏 body 一律 400 且不执行：%s",
    async (body) => {
      const { env, agent } = environment();
      for (const path of ["/api/mail/config", "/api/mail/test"]) {
        const res = await worker.fetch(
          await request(env, path, "admin", { method: "POST", body }),
          env,
        );
        expect(`${path} ${res.status}`).toBe(`${path} 400`);
      }
      expect(agent.mailConfigSave).not.toHaveBeenCalled();
      expect(agent.mailTestSend).not.toHaveBeenCalled();
    },
  );

  it("POST /api/mail/config 的 password 进不了 DO", async () => {
    const { env, agent } = environment();
    const res = await worker.fetch(
      await request(env, "/api/mail/config", "admin", {
        method: "POST",
        body: JSON.stringify({ ...readyPatch(), password: "hunter2" }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    const patch = agent.mailConfigSave.mock
      .calls[0][0] as Record<string, unknown>;
    expect(Object.keys(patch)).not.toContain("password");
    expect(JSON.stringify(patch)).not.toContain("hunter2");
    expect(patch.hostname).toBe("smtp.example.test");
  });

  it("POST /api/mail/config 里非法字段值回 400，不落库", async () => {
    const { env, agent } = environment();
    const res = await worker.fetch(
      await request(env, "/api/mail/config", "admin", {
        method: "POST",
        body: JSON.stringify({ port: 25 }),
      }),
      env,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    // 那句是人话，不是「服务器开小差了」：端口 25 这条得让管理员看见为什么
    expect(body.error).toMatch(/25 端口/);
    expect(agent.mailConfigSave).not.toHaveBeenCalled();
  });

  it("POST /api/mail/test 原样转发 {ok:false,error}，不裹成 data", async () => {
    const { env, agent } = environment();
    agent.mailTestSend = vi.fn(async () => ({
      ok: false as const,
      error: "认证失败：535 认证失败",
    }));
    const res = await worker.fetch(
      await request(env, "/api/mail/test", "admin", {
        method: "POST",
        body: JSON.stringify({ to: "boss@example.test" }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: false,
      error: "认证失败：535 认证失败",
    });
    expect(agent.mailTestSend).toHaveBeenCalledWith("boss@example.test");
  });

  it("test 不带 to 就传 undefined（用配置里那个默认收件地址）", async () => {
    const { env, agent } = environment();
    const res = await worker.fetch(
      await request(env, "/api/mail/test", "admin", {
        method: "POST",
        body: "{}",
      }),
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(agent.mailTestSend).toHaveBeenCalledWith(undefined);
  });

  it("test 的 to 不是文本时 400，这一封不发", async () => {
    const { env, agent } = environment();
    const res = await worker.fetch(
      await request(env, "/api/mail/test", "admin", {
        method: "POST",
        body: '{"to":123}',
      }),
      env,
    );
    expect(res.status).toBe(400);
    expect(agent.mailTestSend).not.toHaveBeenCalled();
  });

  it("写信路由：三格原样交给 DO、回的是后端那句；形状错 400、来客 403", async () => {
    const { env, agent } = environment();
    const res = await worker.fetch(
      await request(env, "/api/mail/send", "admin", {
        method: "POST",
        body: '{"subject":" 周报 ","text":"正文","to":" a@x.test "}',
      }),
      env,
    );
    expect(res.status).toBe(200);
    // 契约同 /api/mail/test：裸 {ok}/{ok,error}，失败那句原话直接给到界面
    expect(await res.json()).toEqual({ ok: true });
    // 路由只挡「是不是文本」，trim 与必填归 DO —— 两处都判会判出两套口径
    expect(agent.mailComposeSend).toHaveBeenCalledWith({
      to: " a@x.test ",
      subject: " 周报 ",
      text: "正文",
    });

    for (const body of [
      '{"subject":1,"text":"t"}',
      '{"to":[]}',
      '{"text":{}}',
      "[]",
      "not json",
    ]) {
      const bad = await worker.fetch(
        await request(env, "/api/mail/send", "admin", { method: "POST", body }),
        env,
      );
      expect(bad.status).toBe(400);
    }
    expect(agent.mailComposeSend).toHaveBeenCalledTimes(1);

    const guest = await worker.fetch(
      await request(env, "/api/mail/send", "user", {
        method: "POST",
        body: '{"subject":"s","text":"t"}',
      }),
      env,
    );
    expect(guest.status).toBe(403);
    expect(agent.mailComposeSend).toHaveBeenCalledTimes(1);
  });

  it("发件箱与收件箱的读接口都转交 DO，形状原样回去", async () => {
    const { env, agent } = environment();
    const out = (await (
      await worker.fetch(await request(env, "/api/mail/outbox", "admin"), env)
    ).json()) as { ok: boolean; data: { rows: { error: string }[] } };
    expect(out.ok).toBe(true);
    // 契约是 {rows:[...]}：这一层裹不裹，界面都不会报错，只会显示「0 封」——
    // 所以这条断言是在钉形状本身，不是在钉读数
    expect(out.data.rows[0].error).toBe("认证被拒绝");
    expect(agent.mailOutbox).toHaveBeenCalledWith(50);

    const box = (await (
      await worker.fetch(await request(env, "/api/mail/inbox", "admin"), env)
    ).json()) as {
      ok: boolean;
      data: { rows: unknown[]; unread: number; enabled: boolean };
    };
    // enabled 必须在同一份响应里：界面要靠它分清「通道没接」与「没人寄信」
    expect(box.data).toEqual({ rows: [], unread: 0, enabled: true });
    expect(agent.mailInbox).toHaveBeenCalledWith(50);
  });

  it("读某一封正文按 id 转交，缺 id 也照实传下去（DO 说不存在）", async () => {
    const { env, agent } = environment();
    const res = await worker.fetch(
      await request(env, "/api/mail/inbox/read?id=m9", "admin"),
      env,
    );
    expect(res.status).toBe(200);
    expect(
      ((await res.json()) as { ok: boolean; data: { note: string } }).data.note,
    ).toContain("m9");
    expect(agent.mailInboxRead).toHaveBeenCalledWith("m9");
  });

  it("标已读：缺 id 或 read 不是布尔都 400，一次都不落到 DO", async () => {
    const { env, agent } = environment();
    for (const body of ['{"read":true}', '{"id":"m1"}', '{"id":"","read":true}', '{"id":"m1","read":"yes"}']) {
      const res = await worker.fetch(
        await request(env, "/api/mail/inbox/open", "admin", {
          method: "POST",
          body,
        }),
        env,
      );
      expect(res.status).toBe(400);
    }
    expect(agent.mailInboxOpen).not.toHaveBeenCalled();
    const ok = await worker.fetch(
      await request(env, "/api/mail/inbox/open", "admin", {
        method: "POST",
        body: '{"id":"m1","read":true}',
      }),
      env,
    );
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ id: "m1", read: true });
  });

  it("喂一封走的是与投递同一条 mailIngest；坏 body 与超体积都挡在 DO 之前", async () => {
    const { env, agent } = environment();
    const good = await worker.fetch(
      await request(env, "/api/mail/inbox/feed", "admin", {
        method: "POST",
        body: JSON.stringify({ raw: "Subject: hi\r\n\r\n正文" }),
      }),
      env,
    );
    expect(good.status).toBe(200);
    expect(
      ((await good.json()) as { ok: boolean }).ok,
    ).toBe(true);
    expect(agent.mailIngest).toHaveBeenCalledTimes(1);

    for (const body of ["[]", "not json", '{"raw":123}', "null"]) {
      const bad = await worker.fetch(
        await request(env, "/api/mail/inbox/feed", "admin", { method: "POST", body }),
        env,
      );
      expect(bad.status).toBe(400);
    }
    const big = await worker.fetch(
      await request(env, "/api/mail/inbox/feed", "admin", {
        method: "POST",
        body: JSON.stringify({ raw: "x".repeat(EML_FEED_MAX + 1) }),
      }),
      env,
    );
    expect(big.status).toBe(400);
    // 上面这些都没进去：只有那一次合法的是真落到 DO 的
    expect(agent.mailIngest).toHaveBeenCalledTimes(1);
  });

  it("来客碰不到信箱的任何一本账（发件箱、收件箱、喂一封都是 403）", async () => {
    const { env, agent } = environment();
    for (const [path, init] of [
      ["/api/mail/outbox", {}],
      ["/api/mail/inbox", {}],
      ["/api/mail/inbox/feed", { method: "POST", body: '{"raw":"Subject: x\\r\\n\\r\\ny"}' }],
    ] as const) {
      const res = await worker.fetch(
        await request(env, path, "user", init as RequestInit),
        env,
      );
      expect(res.status).toBe(403);
    }
    expect(agent.mailIngest).not.toHaveBeenCalled();
    expect(agent.mailOutbox).not.toHaveBeenCalled();
  });
});

// ── 8. 多收件人与发件流水 ───────────────────────────────

/**
 * 一封信寄给几个人、以及每一封在 mail_out 里留下的那行。
 *
 * 两条口径值得单独钉：
 *   · 一封三个收件人**只占一格额度** —— 额度管的是「这台机器今天对外拨了几次」，
 *     按收件人数乘一遍会让人莫名其妙把上限吃掉；
 *   · 发件箱记的是「真试过寄的」，被开关与额度挡在拨号之前的那些**不记** ——
 *     那些是这台机器的状态，面板顶上已经写着，混进账里就分不清「寄出去过什么」。
 */
describe("多收件人与发件流水", () => {
  it("一封信寄给逗号分隔的两个地址：两行 RCPT，额度只占一格", async () => {
    const { db, sql } = readyDesk();
    const h = harness();
    expect(
      await sendConfiguredMail(
        sql,
        readyEnv(),
        { ...job, to: "x@y.test, z@w.test" },
        h.transport,
      ),
    ).toEqual({ ok: true });
    const lines = h.lines();
    expect(lines).toContain("RCPT TO:<x@y.test>");
    expect(lines).toContain("RCPT TO:<z@w.test>");
    // 这次点名了收件人，配置里那张默认表就**不**参与 —— 管理员说「发给这两个人」，
    // 结果还抄送给表里所有人，那是一次泄露，不是贴心
    expect(lines).not.toContain("owner@example.test");
    expect(lines.split("RCPT TO:").length - 1).toBe(2);
    expect(h.calls()).toBe(1);
    expect(Number(rawRow(db).sent_count)).toBe(1);
  });

  it("没带收件人时用配置里那张表，两个地址都寄到", async () => {
    const { sql } = readyDesk({ ...readyPatch(), to: "a1@x.test\na2@x.test" });
    const h = harness();
    expect(await sendConfiguredMail(sql, readyEnv(), job, h.transport)).toEqual({
      ok: true,
    });
    const lines = h.lines();
    expect(lines).toContain("RCPT TO:<a1@x.test>");
    expect(lines).toContain("RCPT TO:<a2@x.test>");
  });

  it("表里同一个人写两种大小写只寄一次", async () => {
    const { sql } = readyDesk({
      ...readyPatch(),
      to: "A1@X.test, a1@x.test, b@y.test",
    });
    const h = harness();
    await sendConfiguredMail(sql, readyEnv(), job, h.transport);
    const lines = h.lines();
    const rcpts = lines.split("\n").filter((l) => l.startsWith("RCPT TO:"));
    // 去重按小写比，但保留先写的那一种原样（本地部分区分大小写，不该被改成另一个人）
    expect(rcpts.length).toBe(2);
    expect(
      rcpts.filter((l) => l.toLowerCase().includes("a1@x.test")).length,
    ).toBe(1);
    expect(rcpts).toContain("RCPT TO:<b@y.test>");
  });

  it("地址表里坏的那一条被点名是第几条，且存不进去", () => {
    expect(() =>
      saveMailConfig(
        readyDesk().sql,
        parseMailConfigInput({ to: "a@x.test\nb@y.test\nc@bad" }),
      ),
    ).toThrow(/第 3 条/);
    expect(() => parseMailConfigInput({ to: "a@x.test; 坏的一条" })).toThrow(
      /第 2 条/,
    );
  });

  it("超过 20 条的地址表在 HTTP 边上就拒，不落表", () => {
    const many = Array.from({ length: 21 }, (_, i) => `p${i}@x.test`).join(",");
    expect(MAX_MAIL_RECIPIENTS).toBe(20);
    expect(() => parseMailConfigInput({ to: many })).toThrow(/超过/);
    expect(() => saveMailConfig(readyDesk().sql, { to: many })).toThrow(/超过/);
  });

  it("地址形状被拦下也要在发件箱留一行；开关没开则一行都不留", async () => {
    const { sql } = readyDesk();
    const h = harness();
    const r = await sendConfiguredMail(
      sql,
      readyEnv(),
      { ...job, to: "坏地址" },
      h.transport,
    );
    expect(r.ok).toBe(false);
    expect(h.calls()).toBe(0);
    const rows = listMailOut(sql);
    expect(rows.length).toBe(1);
    expect(rows[0].ok).toBe(false);
    expect(rows[0].subject).toBe(job.subject);
    expect(rows[0].source).toBe("panel");

    const off = readyDesk({ ...readyPatch(), enabled: false });
    const h2 = harness();
    expect(
      (await sendConfiguredMail(off.sql, readyEnv(), job, h2.transport)).ok,
    ).toBe(false);
    expect(listMailOut(off.sql).length).toBe(0);
  });

  it("寄成功那一行带着来源：ericher 工具寄的就写 tool", async () => {
    const { sql } = readyDesk();
    const h = harness();
    expect(
      await sendConfiguredMail(
        sql,
        readyEnv(),
        { ...job, source: "tool" },
        h.transport,
      ),
    ).toEqual({ ok: true });
    const rows = listMailOut(sql);
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({
      ok: true,
      error: "",
      source: "tool",
      subject: job.subject,
    });
  });

  it("parseAddressList：三种分隔都认，空白与重复去掉", () => {
    expect(
      parseAddressList("a@x.test, b@y.test;\nc@z.test\n\n a@x.test "),
    ).toEqual(["a@x.test", "b@y.test", "c@z.test"]);
    expect(parseAddressList("")).toEqual([]);
    expect(assertAddressList("a@x.test")).toBeUndefined();
    expect(() => assertAddressList("nope", "收件地址")).toThrow(/第 1 条/);
  });

  it("两个新开关默认关着，保存后能读回真表", () => {
    const { db, sql } = readyDesk({
      ...readyPatch(),
      sayMail: true,
      inboxEnabled: true,
    });
    const v = getMailConfigView(sql, readyEnv());
    expect(v.sayMail).toBe(true);
    expect(v.inboxEnabled).toBe(true);
    expect(Number(rawRow(db).say_mail)).toBe(1);
    expect(Number(rawRow(db).inbox_enabled)).toBe(1);
    // 出厂默认必须是关：一次升级不该顺手把离线副本或收信落库打开
    expect(DEFAULT_MAIL_CONFIG.sayMail).toBe(false);
    expect(DEFAULT_MAIL_CONFIG.inboxEnabled).toBe(false);
  });
});

// ── 9. 主动消息的邮件副本 ───────────────────────────────

/**
 * 提醒/盯梢那句「人没在界面前听到」的话，要不要另寄一封。
 *
 * 判据是 speak 的落点（live / history / dropped，见 test/speakOrphan.test.ts），
 * 这里盯的是落点之后那一步：**一批攒成一封**（连珠炮的邮件只会让人关掉这一档），
 * 关着时连额度都不该动一格，开着时收件人必须就是配置里那张表。
 * 这一路真拨号会失败（vitest 里没有 cloudflare:sockets），要的正是这个：
 * 不去断言「寄成功了」，只断言「该寄的那一封长什么样、账上留了几行」。
 */
describe("主动消息的邮件副本", () => {
  async function call(sql: SqlTag, lines: string[]) {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await mailDo.mailMissedSays.call(fakeAgent(sql, readyEnv(), "default"), lines);
    warn.mockRestore();
  }

  it("开关关着：一行流水都不留，额度也不动", async () => {
    const { db, sql } = readyDesk({ ...readyPatch(), sayMail: false });
    await call(sql, ["到点了"]);
    expect(listMailOut(sql)).toEqual([]);
    expect(Number(rawRow(db).sent_count)).toBe(0);
  });

  it("开关开着：两条话攒成**一封**，来源记 say，额度只占一格", async () => {
    const { db, sql } = readyDesk({ ...readyPatch(), sayMail: true });
    await call(sql, ["盯的那页变了", "周报该交了"]);
    const rows = listMailOut(sql);
    expect(rows.length).toBe(1);
    expect(rows[0].source).toBe("say");
    expect(rows[0].subject).toContain("2 条");
    expect(Number(rawRow(db).sent_count)).toBe(1);
  });

  it("只有一条时主题不说「2 条」，也不留空正文", async () => {
    const { sql } = readyDesk({ ...readyPatch(), sayMail: true });
    await call(sql, ["到点了"]);
    const rows = listMailOut(sql);
    expect(rows[0].subject).toContain("有一条");
    expect(rows[0].subject).not.toContain("2 条");
  });

  it("收件人就是配置里那张表，一个不少；错误里不带口令", async () => {
    const { sql } = readyDesk({
      ...readyPatch(),
      sayMail: true,
      to: "a1@x.test, a2@x.test",
    });
    await call(sql, ["该开会了"]);
    const rows = listMailOut(sql);
    expect(rows[0].to).toEqual(["a1@x.test", "a2@x.test"]);
    expect(JSON.stringify(rows)).not.toContain(SECRET_VALUE);
  });

  it("空的一批不去拨号（没话可寄就不该占一格）", async () => {
    const { db, sql } = readyDesk({ ...readyPatch(), sayMail: true });
    await call(sql, []);
    expect(listMailOut(sql)).toEqual([]);
    expect(Number(rawRow(db).sent_count)).toBe(0);
  });
});

// ── 10. 信箱页上「寄出去」那一句 ────────────────────────

/**
 * 人亲自动笔那一封（POST /api/mail/send → DO 的 mailComposeSend）。
 *
 * 与「试一封」的分别是文案谁写，于是必填这条必须**在服务端**判：界面上禁用按钮
 * 挡不住从别处直连进来的一条空信，而一条空信不该吃掉一格额度。
 * 这里真拨号必然失败（vitest 里没有 cloudflare:sockets）—— 要的正是这个证据：
 * 断言它走到了拨号那一步（发件箱留下一行、额度占掉一格），而不是被前置闸拦下。
 */
describe("人亲自动笔那一封", () => {
  const compose = (sql: SqlTag, input: { to?: string; subject?: string; text?: string }) =>
    mailDo.mailComposeSend.call(fakeAgent(sql, readyEnv(), "default"), input);

  it("空主题或空正文：不占额度、不留流水，原因说得明白", async () => {
    const { db, sql } = readyDesk();
    for (const input of [
      { subject: "", text: "有正文" },
      { subject: "有主题", text: "   " },
    ]) {
      const r = await compose(sql, input);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain("都得有内容");
    }
    expect(Number(rawRow(db).sent_count)).toBe(0);
    expect(listMailOut(sql)).toEqual([]);
  });

  it("有主题有正文：走到了拨号那一步，账上留一行 source=panel，额度占一格", async () => {
    const { db, sql } = readyDesk();
    const r = await compose(sql, { subject: "该开会了", text: "三点，会议室。" });
    expect(r.ok).toBe(false);
    // 这一句是「已经去连了才有的错」，不是「配置没开」—— 前者才证明闸后面是通的
    if (!r.ok) expect(r.error).toMatch(/cloudflare:sockets|ECONN|TLS|认证|发送/);
    const rows = listMailOut(sql);
    expect(rows.length).toBe(1);
    expect(rows[0].source).toBe("panel");
    expect(rows[0].subject).toBe("该开会了");
    expect(rows[0].to).toEqual(["owner@example.test"]);
    expect(Number(rawRow(db).sent_count)).toBe(1);
  });

  it("自填两个地址：两个都记进那一行，落回默认表那一条不再参与", async () => {
    const { sql } = readyDesk();
    await compose(sql, {
      subject: "s",
      text: "t",
      to: "a@x.test, b@y.test",
    });
    expect(listMailOut(sql)[0].to).toEqual(["a@x.test", "b@y.test"]);
  });

  it("超长主题与正文由服务端裁，不靠界面拦", async () => {
    const { sql } = readyDesk();
    await compose(sql, { subject: "S".repeat(500), text: "T".repeat(30_000) });
    const row = listMailOut(sql)[0];
    expect(row.subject.length).toBe(200);
  });

  it("来客那一间动不了这封信（主人房守卫在 DO 上，不在路由那一层）", async () => {
    const { sql } = readyDesk();
    await expect(
      mailDo.mailComposeSend.call(fakeAgent(sql, readyEnv(), "guest-abc"), {
        subject: "s",
        text: "t",
      }),
    ).rejects.toThrow(/主屋/);
  });
});
