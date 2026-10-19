/**
 * 信箱这一层共用的一份口径：发件流水、收件行、解析器输出、REST 字段名。
 *
 * 为什么单独立一个文件：后端（store/send/cowork/路由）、解析器（inbound.ts）、
 * 界面（MailPanel 与 mailForm）是三档并行开发的活，形状必须先钉死再各写各的，
 * 否则两边各造一份字段名、合流那天对不上还都绿灯。
 *
 * 改这里 = 改接口：必须同轮把所有消费方与假件一起补齐（本项目规矩）。
 */

/** 这一封信是谁要寄的：面板「试一封」、ericher 的工具、提醒/盯梢的离线副本 */
export type MailSource = "panel" | "tool" | "say";

export const MAIL_SOURCES: readonly MailSource[] = ["panel", "tool", "say"];

/** 发件箱里的一行（已落账的一封，成功失败都在） */
export interface MailOutRow {
  /** ISO 时刻 */
  at: string;
  /** 这一封实际寄给谁，可有多个 */
  to: string[];
  subject: string;
  ok: boolean;
  /** 失败原因原文；成功是空串 */
  error: string;
  source: MailSource;
}

/**
 * 收件箱里的一行：头部在 DO 表里，正文与原件在 R2。
 *
 * `emlKey` 为空 = 原件没落盘（太大或这台机器没配桶），只留摘要与字节数 ——
 * 界面要能看出来"这封只有摘要"，不能假装点得开全文。
 */
export interface MailInRow {
  id: string;
  at: string;
  from: string;
  fromName: string;
  to: string;
  subject: string;
  /** 整封原始报文的字节数，不是正文字节数 */
  bytes: number;
  read: boolean;
  hasAttachment: boolean;
  /** 纯文本正文的开头一段；随列表一起回 */
  preview: string;
  emlKey: string;
}

/**
 * 收一封进来的结果。`duplicate` 单独占一格、不塞进 error 那句话里：
 * 「这一封已经在了」是常态（平台会重投、面板上也会重喂同一封），
 * 把它写成失败会让人以为收件箱坏了。
 */
export type MailIngestResult =
  | { ok: true; row: MailInRow }
  | { ok: false; duplicate: boolean; error: string };

/**
 * 解析器（src/mail/inbound.ts）交出来的东西：纯数据，不做任何 IO。
 *
 * `now` 由调用方给（入库那一刻），解析器自己不许读时钟 —— 同一封报文喂两次
 * 必须出同一个结果，否则没法测。
 */
export interface ParsedMail {
  at: string;
  from: string;
  fromName: string;
  to: string;
  subject: string;
  /** Reply-To；没有就是空串（回信该去哪，以头为准，不以 From 为准） */
  replyTo: string;
  /** 纯文本正文：已解 base64/quoted-printable、multipart 里取 text/plain、HTML 不当正文用 */
  text: string;
  bytes: number;
  hasAttachment: boolean;
  /** multipart/mixed 里那些非文本段的「文件名 + 字节数」，只记不存内容 */
  attachments: { name: string; bytes: number }[];
  /** 这封信只有 HTML、没有 text/plain（此时 text 是剥了标签的） */
  htmlOnly: boolean;
  /** 正文是否被上限裁过（裁过的必须在界面上说明白，不能让人以为看的是全文） */
  truncated: boolean;
}

// ── REST 形状（GET 一律 {ok:true,data}；失败按本项目规矩 200+ok:false 也算失败）──
//
//   GET  /api/mail/config            → MailConfigView（多了 sayMail / inboxEnabled / toList）
//   POST /api/mail/config            → 同上（白名单十一格，含新增的两闸）
//   POST /api/mail/test              → MailSendResult
//   GET  /api/mail/outbox            → { rows: MailOutRow[] }
//   GET  /api/mail/inbox             → { rows: MailInRow[]; unread: number; enabled: boolean }
//   GET  /api/mail/inbox/read?id=    → { row: MailInRow; text: string; note: string }
//   POST /api/mail/inbox/open        → { id: string; read: boolean }   （标已读/未读）
//   POST /api/mail/inbox/feed        → { row: MailInRow; parsed: boolean }（本地联调：喂一封原始报文，走同一条解析+入库）
//
// 配置里新增的三格（名字定了就不许两边各写一份）：
//   sayMail      boolean  提醒/盯梢的离线邮件副本总开关，默认关
//   inboxEnabled boolean  收信落库开关，默认关（没接 MX 之前就该关着）
//   toList       string[] 默认收件地址表（`to` 那格存的是它的文本形态，一行一个）
