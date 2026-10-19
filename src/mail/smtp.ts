/**
 * 一次性 SMTP 客户端（裁剪加固版）：连上发完就断（DO 随时可能被回收），只留 PLAIN/LOGIN，正文 base64。
 * 两处硬要求（上游没有）：1) 通道必须加密——STARTTLS 升级失败就断连，绝不在明文上发 AUTH；
 * 2) 地址必须校验——CR/LF 或尖括号进地址就能插协议命令，收件地址可能来自来客自填。
 */

export type MailAddress = { email: string; name?: string };

export interface SmtpOptions {
  hostname: string;
  port: number;
  /** true = 隐式 TLS（465/997）；false = 明文起步，但必须 STARTTLS 升级成功 */
  secure: boolean;
  auth?: { username: string; password: string };
  /** EHLO 用的客户端名，很多服务器会看 */
  clientName?: string;
  /** 单步读写超时 */
  timeoutMs?: number;
}

export interface MailRequest {
  from: MailAddress;
  to: MailAddress[];
  cc?: MailAddress[];
  bcc?: MailAddress[];
  subject: string;
  text?: string;
  html?: string;
  replyTo?: MailAddress;
}

/**
 * 只取 cloudflare:sockets 的这点形状，便于离线测协议。
 * secureTransport 是运行时实测值，加密判断只信它和 STARTTLS 后的重新握手，不信自己的配置；
 * workerd 不报告「升级过了」，升级是否生效只能按协议验（见 sendMail 的 RFC 3207 检查）。
 */
export interface SmtpSocket {
  opened: Promise<unknown>;
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
  readonly secureTransport: "on" | "off" | "starttls";
  startTls(options?: { expectedServerHostname?: string }): SmtpSocket;
  close(): void | Promise<void>;
}
/**
 * 明文起步必须传 "starttls" 而非 "off"：workerd 要求套接字当初以 "starttls" 打开，否则抛错。
 */
export type SocketTransport = (
  hostname: string,
  port: number,
  init: { secureTransport: "on" | "starttls" },
) => SmtpSocket | Promise<SmtpSocket>;

const ADDRESS_RE =
  /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
const MAX_RECIPIENTS = 50;
const NAME_MAX = 120;

/** 邮箱地址过闸：形状、长度，以及一切能改协议行的字符 */
export function assertSafeAddress(a: MailAddress, what = "邮箱地址"): string {
  const email = (a?.email || "").trim();
  if (!email) throw new Error(`${what}为空`);
  if (email.length > 254) throw new Error(`${what}过长`);
  // 协议行是 `RCPT TO: <x>`，尖括号和 CR/LF 一旦进地址就能提前收尾再插命令
  if (/[<>\r\n]/.test(email)) throw new Error(`${what}含有非法字符`);
  if (!ADDRESS_RE.test(email)) throw new Error(`${what}格式不对：${email}`);
  return email;
}

/** 显示名走 RFC 2047 编码，先把控制字符挡掉（引号和反斜杠由编码吃掉） */
export function assertSafeDisplayName(name: string, what = "名称"): string {
  if (/[\r\n]/.test(name)) throw new Error(`${what}含有换行`);
  return name.slice(0, NAME_MAX);
}

/** 只有加密通道才允许出现凭据：隐式 TLS，或 STARTTLS 明确升级成功 */
export function channelIsEncrypted(state: { implicitTls: boolean; upgraded: boolean }): boolean {
  return state.implicitTls || state.upgraded;
}

/** 非 ASCII 的头部值：=?UTF-8?B?…?= */
export function encodeHeader(value: string): string {
  // eslint-disable-next-line no-control-regex
  if (!/[^\x00-\x7F]/.test(value)) return value;
  return `=?UTF-8?B?${base64(value)}?=`;
}

function base64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** 一行一行的 base64（76 字符），正文里不会出现行首点，也就不需要 dot-stuffing */
function base64Lines(text: string): string {
  const raw = base64(text);
  return raw.replace(/.{1,76}/g, "$&\r\n");
}

/** 组装 MIME 报文：text/html 都在时走 multipart/alternative */
export function buildMimeMessage(mail: MailRequest): string {
  const from = assertSafeAddress(mail.from, "发件地址");
  const heads: string[] = [];
  const addr = (a: MailAddress) =>
    a.name ? `${encodeHeader(assertSafeDisplayName(a.name))} <${assertSafeAddress(a)}>` : `<${assertSafeAddress(a)}>`;
  heads.push(`From: ${addr(mail.from)}`);
  heads.push(`To: ${mail.to.map(addr).join(", ")}`);
  if (mail.cc?.length) heads.push(`Cc: ${mail.cc.map(addr).join(", ")}`);
  heads.push(`Subject: ${encodeHeader((mail.subject || "").slice(0, 500))}`);
  if (mail.replyTo) heads.push(`Reply-To: ${addr(mail.replyTo)}`);
  heads.push(`Date: ${new Date().toUTCString()}`);
  heads.push(`Message-ID: <${crypto.randomUUID()}@${from.split("@").pop()}>`);
  heads.push("MIME-Version: 1.0");

  const text = mail.text || "";
  const html = mail.html || "";
  if (!text && !html) throw new Error("邮件正文为空");

  let body: string;
  if (text && html) {
    // 边界只用 [A-Za-z0-9-]：base64 的 = 和 / 会让边界本身带 MIME 语法含义
    const rnd = base64(String(crypto.getRandomValues(new Uint8Array(9)).join(""))).replace(/[^A-Za-z0-9]/g, "");
    const boundary = `ericher${rnd}`;
    heads.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
    body = [
      `--${boundary}`,
      "Content-Type: text/plain; charset=UTF-8",
      "Content-Transfer-Encoding: base64",
      "",
      base64Lines(text),
      `--${boundary}`,
      "Content-Type: text/html; charset=UTF-8",
      "Content-Transfer-Encoding: base64",
      "",
      base64Lines(html),
      `--${boundary}--`,
      "",
    ].join("\r\n");
  } else {
    heads.push(
      html
        ? "Content-Type: text/html; charset=UTF-8"
        : "Content-Type: text/plain; charset=UTF-8",
    );
    heads.push("Content-Transfer-Encoding: base64");
    body = base64Lines(html || text);
  }
  return `${heads.join("\r\n")}\r\n\r\n${body}`;
}

async function defaultTransport(
  hostname: string,
  port: number,
  init: { secureTransport: "on" | "starttls" },
): Promise<SmtpSocket> {
  const { connect } = await import("cloudflare:sockets");
  // secureTransport 属于第二个参数 SocketOptions；放进第一个（地址）会被运行时静默丢弃，
  // 结果就是"以为开了 TLS 其实是明文"
  return connect({ hostname, port }, {
    secureTransport: init.secureTransport,
    allowHalfOpen: false,
  }) as unknown as SmtpSocket;
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what}超时（${ms}ms）`)), ms);
    }),
  ]);
}

/**
 * 寄一封：任何一步不对都抛错，错误只带阶段与服务器回文，绝不带凭据。transport 仅供测试注入。
 */
export async function sendMail(
  opts: SmtpOptions,
  mail: MailRequest,
  transport: SocketTransport = defaultTransport,
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const from = assertSafeAddress(mail.from, "发件地址");
  const recipients = [
    ...mail.to,
    ...(mail.cc ?? []),
    ...(mail.bcc ?? []),
  ].map((a) => assertSafeAddress(a));
  if (!recipients.length) throw new Error("没有收件人");
  if (recipients.length > MAX_RECIPIENTS) throw new Error(`收件人超过 ${MAX_RECIPIENTS} 个`);
  if (!/^[A-Za-z0-9.-]+$/.test(opts.hostname)) throw new Error("SMTP 主机名不合法");
  if (!Number.isInteger(opts.port) || opts.port < 1 || opts.port > 65535)
    throw new Error("SMTP 端口不合法");
  // 平台硬封 25，本地也没意义，配置面就该拦在前面
  if (opts.port === 25) throw new Error("不支持 25 端口（平台禁止出站），请改 465 或 587");

  let socket = await transport(opts.hostname, opts.port, {
    secureTransport: opts.secure ? "on" : "starttls",
  });
  // 升级是否真生效只能到 STARTTLS 之后按协议验；在那之前 tlsConfirmed 一律 false，凭据不许走
  let tlsConfirmed = false;
  // 加密与否只看套接字自己的报告 + 协议上的确认：opts.secure 是我们想要什么，不是得到了什么
  const encryptedNow = () =>
    channelIsEncrypted({
      implicitTls: socket.secureTransport === "on",
      upgraded: tlsConfirmed,
    });
  if (opts.secure && !encryptedNow())
    throw new Error("隐式 TLS 未生效（运行时没确认加密通道），已停止发送");
  let reader = socket.readable.getReader();
  let writer = socket.writable.getWriter();
  const decoder = new TextDecoder();
  let buffer = "";

  const step = <T>(p: Promise<T>, what: string) => withTimeout(p, timeoutMs, what);
  const write = (line: string) =>
    step(writer.write(new TextEncoder().encode(line)), "写入");

  /** SMTP 多行应答：`250-xxx` 续行，`250 xxx` 收尾；能力声明全在续行里，必须整体返回 */
  async function readReply(what: string): Promise<string> {
    const lines: string[] = [];
    for (;;) {
      const nl = buffer.indexOf("\r\n");
      if (nl >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 2);
        const code = line.slice(0, 3);
        if (!/^\d{3}$/.test(code)) throw new Error(`${what}：服务器应答不成形`);
        lines.push(line);
        if (line[3] !== "-") return lines.join("\n");
        continue;
      }
      const { value, done } = await step(reader.read(), what);
      if (done) throw new Error(`${what}：连接被服务器关闭`);
      if (value?.length) buffer += decoder.decode(value, { stream: true });
    }
  }

  async function command(line: string, expect: string, what: string): Promise<string> {
    await write(`${line}\r\n`);
    const reply = await readReply(what);
    if (!reply.startsWith(expect)) throw new Error(`${what}失败：${reply}`);
    return reply;
  }

  let authMechanisms: string[] = [];
  let advertisesStartTls = false;

  async function ehlo(): Promise<void> {
    await write(`EHLO ${opts.clientName || "ericher"}\r\n`);
    const reply = await readReply("EHLO");
    if (!reply.startsWith("2")) {
      // 老服务器不认 EHLO：退回 HELO，但这样就没有能力声明可谈 —— 加密无从保证，直接停
      throw new Error("服务器不支持 EHLO，无法确认加密能力，已停止发送");
    }
    authMechanisms = /AUTH[= ]([^\r\n]*)/i.exec(reply)?.[1]?.toUpperCase().split(/[\s,]+/).filter(Boolean) || [];
    advertisesStartTls = /(^|\s|-)STARTTLS\b/i.test(reply);
  }

  try {
    await step(socket.opened, "连接");
    await readReply("问候"); // 220
    await ehlo();

    if (!encryptedNow()) {
      if (!advertisesStartTls) throw new Error("服务器不提供 STARTTLS，明文通道不发送凭据，已停止发送");
      await command("STARTTLS", "220", "STARTTLS");
      reader.releaseLock();
      writer.releaseLock();
      // 升级时必须钉住证书的主机名，否则中间人可以拿任意一张合法证书接管
      const plain = socket;
      socket = socket.startTls({ expectedServerHostname: opts.hostname });
      await step(socket.opened, "TLS 升级");
      reader = socket.readable.getReader();
      writer = socket.writable.getWriter();
      // 运行时没给出一条新通道，就等于什么都没升级
      if (socket === plain) throw new Error("startTls 没有返回升级后的新通道，已停止发送");
      // 升级完必须重新握手：旧通道上的能力声明一律作废
      await ehlo();
      // RFC 3207：TLS established 之后服务器不得再 advertise STARTTLS。还在报，
      // 就说明这条通道其实仍是明文（被中间人把升级吃掉了），凭据一个字都不许出去。
      if (advertisesStartTls)
        throw new Error("STARTTLS 之后服务器仍声明 STARTTLS，升级未生效，已停止发送");
      tlsConfirmed = true;
    }

    // 到这里通道一定加密；这条是纵深防御，不信任上面任何一步的推断
    if (!encryptedNow()) throw new Error("通道未加密，拒绝继续");

    if (opts.auth) {
      if (!authMechanisms.length) throw new Error("服务器未声明 AUTH 能力，无法认证");
      const plain = authMechanisms.includes("PLAIN");
      const login = authMechanisms.includes("LOGIN");
      if (!plain && !login) throw new Error("服务器只支持我们不发的认证方式，已停止");
      if (plain) {
        const token = base64(`\0${opts.auth.username}\0${opts.auth.password}`);
        await command(`AUTH PLAIN ${token}`, "235", "认证");
      } else {
        await command("AUTH LOGIN", "334", "认证");
        await command(base64(opts.auth.username), "334", "认证");
        // 这一步之后无论成败，错误里都不许带上口令
        await command(base64(opts.auth.password), "235", "认证").catch((e) => {
          throw new Error(String(e.message).includes("认证") ? "认证被拒绝" : e.message);
        });
      }
    }

    await command(`MAIL FROM:<${from}>`, "25", "MAIL FROM");
    for (const to of recipients) await command(`RCPT TO:<${to}>`, "25", "RCPT TO");
    await command("DATA", "354", "DATA");
    await write(buildMimeMessage(mail));
    await write("\r\n.\r\n");
    await readReply("收件确认");
    await write("QUIT\r\n");
  } finally {
    try {
      socket.close();
    } catch {
      // 关闭失败不掩盖真正的错误
    }
  }
}
