// 配置 → 内核之间的那层薄适配：把「这台机器该用哪个服务器、哪把钥匙、每天几封」
// 翻成 sendMail 的两个入参，并把每日额度的账记实。
//
// 消费方（说清楚这不是死配置）：三处，各自的账都记在 mail_out 那一本上
//   · 主人那间的 send_email 工具（agent 想说就寄，走 src/tools/mail.ts）；
//   · 面板上的「试一封」（POST /api/mail/test → DO 的 mailTestSend）；
//   · 提醒/盯梢的离线副本（cowork.ts 的 mailMissedSays：那句话说出口时人不在这
//     一场跟前，一批攒成一封寄出去 —— 判据是 speak 的落点，不是猜连接数）。
// 三条路共用同一个 reserveMailSlot 与同一张默认收件地址表；谁来寄都只有一本账。
//
// 两条红线：
//   1. 口令只从 env[keySecret] 取，配置里没有、也不该有口令本体；
//   2. 失败一律照实返回内核给的那句话，不吞成成功 —— 寄不出去却说「已发送」，
//      管理员会一直等那封永远不来的邮件。

import type { SqlTag } from "../agent/state";
import {
  getMailConfigView,
  parseAddressList,
  recordMailSend,
  reserveMailSlot,
  type MailConfigView,
} from "./store";
import { recordMailOut } from "./mailbox";
import type { MailSource } from "./mailboxTypes";
import {
  assertSafeAddress,
  sendMail,
  type MailAddress,
  type SmtpOptions,
  type SocketTransport,
} from "./smtp";

/** 一封要寄的东西。收件人可省 —— 省了就落回配置里那张默认收件地址表 */
export interface MailJob {
  /** 一个地址、逗号分隔一串、或数组都收；空白与重复自动去掉 */
  to?: string | string[];
  subject: string;
  text: string;
  /** 这一封是谁要寄的：面板试发 / ericher 的工具 / 提醒与盯梢的离线副本 */
  source?: MailSource;
}

export type MailSendResult = { ok: true } | { ok: false; error: string };

/** 正文与标题都截一下：内核还有一道 500 字的标题闸，这里先把过长的来话收敛掉 */
const SUBJECT_MAX = 200;
const TEXT_MAX = 20_000;

/**
 * 为什么现在不能发。返回一句能看懂的原因，返回 null 表示可以发。
 *
 * 判的顺序就是排查的顺序：先问开没开，再问通不通信道，最后问钥匙在不在。
 */
function blockedReason(cfg: MailConfigView): string | null {
  if (!cfg.enabled) return "邮件发送是关着的（配置里 enabled 没开）";
  if (!cfg.hostname) return "没填 SMTP 服务器地址";
  if (!cfg.username) return "没填 SMTP 用户名";
  if (!cfg.keySecret) return "没选存放 SMTP 口令的 secret 变量名";
  // 变量名填了、这台机器上却没有那把钥匙：这是线上最常见的「配好了怎么发不出去」
  if (!cfg.keyAvailable)
    return `环境变量 ${cfg.keySecret} 在这台机器上没配（wrangler secret put ${cfg.keySecret}）`;
  if (!cfg.from) return "没填发件地址";
  return null;
}

/**
 * 错误只截断、不拼接。
 *
 * 内核已经保证错误文本里没有口令；外层 catch 要是再把 hostname / username
 * 抹进去，等于自己把敏感面请回来 —— 一句「认证被拒绝」比一串上下文更有用。
 */
function brief(e: unknown): string {
  const m = (e as Error)?.message ? String((e as Error).message) : String(e);
  return (m.trim().slice(0, 300) || "发送失败").trim();
}

/**
 * 按当前配置寄一封。
 *
 * 额度在 await 之前占（见 store.ts 的 reserveMailSlot）：占上就不退，
 * 半路断的时候服务器可能已经收了件，还回去就等于同一件事寄两封。
 * 地址形状错了不占额度 —— 那种连网络都没碰的失败不该吃掉一格。
 *
 * 流水（mail_out）在两处记：占上额度之后的成与败、以及地址形状被闸拦下的那一次。
 * 被「开关没开 / 额度用完」挡住的**不记** —— 那是这台机器的状态，面板顶上已经
 * 如实写着；混进发件箱就等于把「寄出去的账」变成「为什么没寄的日志」。
 */
export async function sendConfiguredMail(
  sql: SqlTag,
  env: Record<string, unknown>,
  job: MailJob,
  transport?: SocketTransport,
): Promise<MailSendResult> {
  const at = new Date().toISOString();
  const source: MailSource = job.source ?? "panel";
  const subject = (job.subject || "").slice(0, SUBJECT_MAX);
  const log = (to: string[], ok: boolean, error: string) =>
    recordMailOut(sql, { at, to, subject, ok, error, source });

  const cfg = getMailConfigView(sql, env);
  const reason = blockedReason(cfg);
  if (reason) return { ok: false, error: reason };

  // 收件人：这次带的（一个或一串）优先，没带或全是空白就落回配置里那张表
  const wanted = parseAddressList(
    Array.isArray(job.to) ? job.to.join(",") : (job.to ?? ""),
  );
  const recipients = wanted.length ? wanted : cfg.toList;
  if (!recipients.length)
    return {
      ok: false,
      error: "没有收件地址（配置里的收件表是空的，这次也没带）",
    };

  let to: MailAddress[];
  let from: MailAddress;
  try {
    from = { email: assertSafeAddress({ email: cfg.from }, "发件地址") };
    to = recipients.map((email) => ({
      email: assertSafeAddress({ email }, "收件地址"),
    }));
  } catch (e) {
    const error = brief(e);
    log(recipients, false, error);
    return { ok: false, error };
  }

  const slot = reserveMailSlot(sql);
  if (!slot.ok) return slot;

  const opts: SmtpOptions = {
    hostname: cfg.hostname,
    port: cfg.port,
    secure: cfg.secure,
    // 口令只在这一刻从 env 里取，不落库、不进日志、不回显
    auth: { username: cfg.username, password: String(env[cfg.keySecret] ?? "") },
  };
  const mail = {
    from,
    to,
    subject,
    text: (job.text || "").slice(0, TEXT_MAX),
    // 发件人就是这台机器的主人：回复直接回到发件地址，不必另配
    replyTo: from,
  };
  const toAddrs = to.map((a) => a.email);

  try {
    await sendMail(opts, mail, transport);
  } catch (e) {
    const error = brief(e);
    recordMailSend(sql, { at, ok: false, error, to: toAddrs.join(", ") });
    log(toAddrs, false, error);
    return { ok: false, error };
  }
  recordMailSend(sql, { at, ok: true, error: "", to: toAddrs.join(", ") });
  log(toAddrs, true, "");
  return { ok: true };
}
