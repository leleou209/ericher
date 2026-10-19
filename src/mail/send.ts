// 配置 → 内核的薄适配：把服务器/钥匙/每日额度翻成 sendMail 入参，并记实额度账。
// 三处消费方共用同一个 reserveMailSlot 与默认收件表：send_email 工具、面板「试一封」、
// 提醒/盯梢的离线副本（speak 落点判断人不在场，一批攒成一封）。
// 两条红线：口令只从 env[keySecret] 取；失败照实返回，不吞成成功。

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
 * 为什么现在不能发；null = 可以发。判的顺序就是排查顺序：开关 → 信道 → 钥匙。
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
 * 错误只截断、不拼接：内核已保证错误里没口令，外层再抹 hostname/username 等于请回敏感面。
 */
function brief(e: unknown): string {
  const m = (e as Error)?.message ? String((e as Error).message) : String(e);
  return (m.trim().slice(0, 300) || "发送失败").trim();
}

/**
 * 按当前配置寄一封。
 * 额度在 await 之前占且不退（半路断时服务器可能已收件，还回去等于寄两封）；地址形状错不占额度。
 * 流水 mail_out 记两处：占额度后的成败、地址被闸拦下；被开关/额度挡住的不记（那是机器状态，不是发件账）。
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
