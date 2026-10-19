import { describe, expect, it } from "vitest";
import {
  assertSafeAddress,
  buildMimeMessage,
  channelIsEncrypted,
  encodeHeader,
  sendMail,
  type SmtpSocket,
  type SocketTransport,
} from "../src/mail/smtp";

const enc = new TextEncoder();
const dec = new TextDecoder();

/**
 * 假 SMTP 服务器：够走完一轮会话，且把客户端写来的每一行都记下来。
 * 记下来的东西才是证据 —— 尤其「明文通道上到底有没有出现 AUTH」。
 */
class FakeSocket implements SmtpSocket {
  opened = Promise.resolve();
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
  lines: string[] = [];
  private ctrl!: ReadableStreamDefaultController<Uint8Array>;
  private pending = "";
  private mode: "command" | "data" = "command";
  /** 运行时报告的真实加密状态：客户端只信这个，不信自己传了什么 */
  get secureTransport(): "on" | "off" | "starttls" {
    return this.opts.encrypted ? "on" : this.opts.mode;
  }
  constructor(
    private opts: {
      advertiseStartTls: boolean;
      encrypted: boolean;
      /** 明文起步时运行时报的模式 —— workerd 只认 "starttls"，客户端传错就抛 */
      mode: "on" | "starttls";
      authOk?: boolean;
      greet?: boolean;
      /** 耍赖的服务器：升级之后仍 advertise STARTTLS（等于中间人把升级吃了） */
      lieAboutStartTls?: boolean;
    },
  ) {
    const self = this;
    this.readable = new ReadableStream({
      start(c) {
        self.ctrl = c;
        // 只有新开连接才问候；STARTTLS 之后服务器不再发 220（RFC 3207）
        if (opts.greet !== false) c.enqueue(enc.encode("220 fake.smtp ESMTP\r\n"));
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
  private say(text: string) {
    this.ctrl.enqueue(enc.encode(text));
  }
  private handle(line: string) {
    this.lines.push(line);
    if (this.mode === "data") {
      if (line === ".") this.say("250 2.0.0 Ok: queued\r\n");
      return;
    }
    const cmd = line.split(" ")[0].toUpperCase();
    if (cmd === "EHLO") {
      const caps = ["250-fake", "250-SIZE 10485760"];
      // 真实服务器升级成功后就不再报 STARTTLS（RFC 3207），假服务器也得照规矩来，
      // 否则客户端那条「还在报就是没加密」的检查永远测不到
      if (this.opts.advertiseStartTls && (!this.opts.encrypted || this.opts.lieAboutStartTls))
        caps.push("250-STARTTLS");
      caps.push("250-AUTH PLAIN LOGIN");
      caps.push("250 Ok");
      this.say(caps.join("\r\n") + "\r\n");
      return;
    }
    if (cmd === "STARTTLS") {
      if (!this.opts.advertiseStartTls) return this.say("502 不支持\r\n");
      this.say("220 2.0.0 Ready to start TLS\r\n");
      return;
    }
    if (cmd === "AUTH") {
      this.say(this.opts.authOk === false ? "535 认证失败\r\n" : "235 2.7.0 Accepted\r\n");
      return;
    }
    if (cmd === "MAIL" || cmd === "RCPT") return this.say("250 2.1.0 Ok\r\n");
    if (cmd === "DATA") {
      this.mode = "data";
      return this.say("354 End data with <CR><LF>.<CR><LF>\r\n");
    }
    if (cmd === "QUIT") return this.say("221 2.0.0 Bye\r\n");
    this.say("250 Ok\r\n");
  }
  startTls(options?: { expectedServerHostname?: string }): SmtpSocket {
    // 客户端必须把主机名交下来做证书校验，否则升级可以被中间人接管
    this.tlsExpectedHost = options?.expectedServerHostname;
    const next = new FakeSocket({ ...this.opts, encrypted: true, greet: false });
    this.afterTls = next;
    return next;
  }
  tlsExpectedHost?: string;
  /** 升级之后那条新通道（与 SmtpSocket.upgraded 那个布尔不是一回事） */
  afterTls?: FakeSocket;
  close() {}
}

/** 记录 transport 被以什么参数调用了几次 */
function harness(opts: {
  advertiseStartTls?: boolean;
  authOk?: boolean;
  lieAboutStartTls?: boolean;
}) {
  const made: FakeSocket[] = [];
  const calls: Array<{ host: string; port: number; secure: string }> = [];
  const transport: SocketTransport = (hostname, port, init) => {
    calls.push({ host: hostname, port, secure: init.secureTransport });
    const s = new FakeSocket({
      advertiseStartTls: opts.advertiseStartTls ?? true,
      encrypted: init.secureTransport === "on",
      mode: init.secureTransport,
      authOk: opts.authOk,
      lieAboutStartTls: opts.lieAboutStartTls,
    });
    made.push(s);
    return s;
  };
  const allLines = () =>
    made.flatMap((s) => [...s.lines, ...(s.afterTls?.lines ?? [])]);
  return { transport, calls, made, allLines };
}

const mail = {
  from: { email: "ericher@example.test", name: "ericher" },
  to: [{ email: "owner@example.test" }],
  subject: "测试",
  text: "正文一行",
};

describe("SMTP 客户端", () => {
  it("隐式 TLS 下走完整轮会话并发出凭据", async () => {
    const h = harness({ advertiseStartTls: false });
    await sendMail(
      { hostname: "smtp.example.test", port: 465, secure: true, auth: { username: "u", password: "p" } },
      mail,
      h.transport,
    );
    expect(h.calls[0].secure).toBe("on");
    const lines = h.allLines().join("\n");
    expect(lines).toContain("EHLO");
    expect(lines).toContain("AUTH PLAIN");
    expect(lines).toContain("MAIL FROM:<ericher@example.test>");
    expect(lines).toContain("RCPT TO:<owner@example.test>");
    expect(lines).toContain("QUIT");
  });

  it("服务器剥掉 STARTTLS 时：断连，且明文里绝不出现 AUTH", async () => {
    const h = harness({ advertiseStartTls: false });
    await expect(
      sendMail(
        { hostname: "smtp.example.test", port: 587, secure: false, auth: { username: "u", password: "p" } },
        mail,
        h.transport,
      ),
    ).rejects.toThrow(/STARTTLS/);
    const plain = h.allLines().join("\n");
    expect(plain).not.toContain("AUTH");
    expect(plain).not.toContain(btoa("\0u\0p"));
  });

  it("STARTTLS 升级成功后重新 EHLO 再认证", async () => {
    const h = harness({ advertiseStartTls: true });
    await sendMail(
      { hostname: "smtp.example.test", port: 587, secure: false, auth: { username: "u", password: "p" } },
      mail,
      h.transport,
    );
    // 明文起步必须以 "starttls" 打开：workerd 对 "off" 的套接字直接拒绝 startTls()
    expect(h.calls[0].secure).toBe("starttls");
    expect(h.made[0].afterTls).toBeTruthy();
    const before = h.made[0].lines.join("\n");
    const after = (h.made[0].afterTls?.lines ?? []).join("\n");
    expect(before).toContain("STARTTLS");
    expect(before).not.toContain("AUTH");
    // 升级时必须把主机名交下去做证书校验，不然中间人拿任意合法证书就能接管
    expect(h.made[0].tlsExpectedHost).toBe("smtp.example.test");
    // 升级后的新通道上才允许出现凭据，且能力必须重新问过
    expect(after).toContain("EHLO");
    expect(after).toContain("AUTH PLAIN");
  });

  it("升级后服务器仍 advertise STARTTLS 时断连，凭据不出去", async () => {
    // 中间人场景：它回 220 Ready、但把 TLS 摘掉，重新 EHLO 仍报 STARTTLS。
    // 运行时不在套接字上报告「升级过了」，这条协议层检查就是唯一的实测证据
    const h = harness({ advertiseStartTls: true, lieAboutStartTls: true });
    await expect(
      sendMail(
        { hostname: "smtp.example.test", port: 587, secure: false, auth: { username: "u", password: "p" } },
        mail,
        h.transport,
      ),
    ).rejects.toThrow(/升级未生效/);
    const wire = h.allLines().join("\n");
    expect(wire).toContain("STARTTLS");
    expect(wire).not.toContain("AUTH");
    expect(wire).not.toContain(btoa("\0u\0p"));
  });

  it("地址里带 CRLF 时根本不去连网络", async () => {
    const h = harness({});
    await expect(
      sendMail(
        { hostname: "smtp.example.test", port: 465, secure: true },
        { ...mail, to: [{ email: "a@b.test\r\nRCPT TO:<evil@x.test>" }] },
        h.transport,
      ),
    ).rejects.toThrow(/非法字符/);
    expect(h.calls.length).toBe(0);
  });

  it("25 端口直接拒（平台本来就封）", async () => {
    const h = harness({});
    await expect(
      sendMail({ hostname: "smtp.example.test", port: 25, secure: false }, mail, h.transport),
    ).rejects.toThrow(/25 端口/);
    expect(h.calls.length).toBe(0);
  });

  it("认证失败时错误里不带口令", async () => {
    const h = harness({ authOk: false });
    const err = await sendMail(
      { hostname: "smtp.example.test", port: 465, secure: true, auth: { username: "u", password: "sup3rs3cret" } },
      mail,
      h.transport,
    ).then(
      () => null,
      (e) => e as Error,
    );
    expect(err?.message).toBeTruthy();
    expect(err?.message).not.toContain("sup3rs3cret");
    expect(err?.message).not.toContain(btoa("sup3rs3cret"));
  });

  it("收件人超上限时拒绝", async () => {
    const h = harness({});
    const to = Array.from({ length: 60 }, (_, i) => ({ email: `a${i}@b.test` }));
    await expect(
      sendMail({ hostname: "smtp.example.test", port: 465, secure: true }, { ...mail, to }, h.transport),
    ).rejects.toThrow(/收件人超过/);
  });
});

describe("发信前的地址与报文规则", () => {
  it("尖括号、换行、空值、超长都过不了闸", () => {
    expect(assertSafeAddress({ email: "a@b.test" })).toBe("a@b.test");
    expect(() => assertSafeAddress({ email: "a@b.test> x" })).toThrow(/非法字符/);
    expect(() => assertSafeAddress({ email: "a@b\ntest" })).toThrow(/非法字符/);
    expect(() => assertSafeAddress({ email: "" })).toThrow(/为空/);
    expect(() => assertSafeAddress({ email: "a@b" })).toThrow(/格式不对/);
    expect(() => assertSafeAddress({ email: `${"a".repeat(250)}@b.test` })).toThrow(/过长/);
  });
  it("只有加密通道才允许出现凭据", () => {
    expect(channelIsEncrypted({ implicitTls: true, upgraded: false })).toBe(true);
    expect(channelIsEncrypted({ implicitTls: false, upgraded: true })).toBe(true);
    expect(channelIsEncrypted({ implicitTls: false, upgraded: false })).toBe(false);
  });
  it("非 ASCII 标题走 RFC 2047，正文走 base64 且不含行首点", () => {
    expect(encodeHeader("提醒")).toBe("=?UTF-8?B?" + btoa(unescape(encodeURIComponent("提醒"))) + "?=");
    expect(encodeHeader("plain")).toBe("plain");
    const msg = buildMimeMessage({ ...mail, subject: "提醒", text: ".危险开头\n第二行" });
    const body = msg.split("\r\n\r\n")[1];
    expect(body).not.toContain("\r\n.");
    expect(msg).toContain("Content-Transfer-Encoding: base64");
    expect(msg).toContain("Subject: =?UTF-8?B?");
  });
  it("text 与 html 同时给时走 multipart，边界不含 MIME 语法字符", () => {
    const msg = buildMimeMessage({ ...mail, html: "<p>hi</p>" });
    expect(msg).toContain("multipart/alternative");
    expect(msg).toContain("Content-Type: text/html; charset=UTF-8");
    const boundary = /boundary="([^"]+)"/.exec(msg)?.[1] ?? "";
    expect(boundary.length).toBeGreaterThan(8);
    expect(boundary).toMatch(/^[A-Za-z0-9_-]+$/);
  });
  it("正文全空时不发", () => {
    expect(() => buildMimeMessage({ ...mail, text: "", html: "" })).toThrow(/正文为空/);
  });
});
