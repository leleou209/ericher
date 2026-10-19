/**
 * 信箱层共用口径：发件流水、收件行、解析器输出、REST 字段名。改这里 = 改接口，
 * 必须同轮补齐所有消费方与假件。
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
 * 收件行：头部在 DO 表，正文原件在 R2。emlKey 空 = 原件没落盘（太大/没桶），只留摘要。
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
  /** 附件清单（只有名字与大小，内容不在这儿）；空数组 = 没带或这封入库时还没这一列 */
  attachments: { name: string; bytes: number }[];
  /** 纯文本正文的开头一段；随列表一起回 */
  preview: string;
  emlKey: string;
}

/**
 * 收一封的结果。duplicate 单独占一格：「已经在了」是常态（平台重投/面板重喂），
 * 写成失败会让人以为收件箱坏了。
 */
export type MailIngestResult =
  | { ok: true; row: MailInRow }
  | { ok: false; duplicate: boolean; error: string };

/**
 * 解析器输出：纯数据、不做 IO。now 由调用方给，解析器不读时钟——同一封报文喂两次必须同结果。
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

// ── REST（/api/mail/ 下；GET 一律 {ok:true,data}，200+ok:false 也算失败）──
// config GET/POST→MailConfigView；test→MailSendResult；outbox→{rows}；inbox→{rows,unread,enabled}；
// inbox/read?id=→{row,text,note}；inbox/open→{id,read}；inbox/feed→{row,parsed}。新增 sayMail/inboxEnabled/toList 三格。
