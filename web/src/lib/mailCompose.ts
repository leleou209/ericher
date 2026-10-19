/**
 * 信箱页「写一封」的纯规则：收件人怎么定、必填是什么、回信怎么预填、结果怎么如实说。
 *
 * 全部外提成函数，是因为这个界面没有 DOM 测试环境（vitest 跑在 node 里），
 * 渲染出来的东西测不到；那么至少**判断**这一层必须能被钉住 —— 尤其
 * 「寄出去」这种会离开本系统的动作，按钮禁不禁、空正文发不发，都得有证据。
 */

import type { MailInRow } from "./types";

/** 后端那条 {ok}/{ok,error} 契约的最小形状（不引 src，web 侧自己声明） */
export interface MailSendResultLike {
  ok: boolean;
  error?: string;
}

/** 与服务端同尺：主题 200、正文 20000（cowork.ts 的 mailComposeSend 裁的就是这两个数） */
export const COMPOSE_SUBJECT_MAX = 200;
export const COMPOSE_TEXT_MAX = 20_000;

/** 收件人两种来路：用配置里那张表，或这一次自己点名 */
export type RecipientMode = "default" | "custom";

export interface ComposeDraft {
  mode: RecipientMode;
  /** mode=custom 时的地址，逗号/换行分隔都收（后端再拆） */
  custom: string;
  subject: string;
  text: string;
}

export const blankCompose = (): ComposeDraft => ({
  mode: "default",
  custom: "",
  subject: "",
  text: "",
});

/** 地址表文本 → 数组（换行/逗号/分号都算分隔，去空、按小写去重保留原写法） */
export const addressListOf = (text: string): string[] => {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of (text || "").split(/[\n,;]+/)) {
    const a = raw.trim();
    if (!a) continue;
    const k = a.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(a);
  }
  return out;
};

/**
 * 这一次实际会寄给谁（只为界面那句「寄给 2 个人」服务，**不是**发给后端的东西）。
 *
 * default 那一路返回空数组是诚实的：表里有什么由后端说了算，界面不该替它数一遍
 * 再装作知道 —— 真数的是配置视图里那串文本，所以调用方会把它传进来。
 */
export const effectiveRecipients = (
  d: ComposeDraft,
  tableText: string,
): string[] =>
  d.mode === "default" ? addressListOf(tableText) : addressListOf(d.custom);

/** 后端要的 to：用默认表时留空（空=落回表），自填时原样交下去 */
export const composeTo = (d: ComposeDraft): string | undefined =>
  d.mode === "default" ? undefined : d.custom.trim() || undefined;

/** 缺什么是看得见的：返回缺项的名字，界面按顺序提示 */
export function composeMissing(d: ComposeDraft): string[] {
  const missing: string[] = [];
  if (!d.subject.trim()) missing.push("subject");
  if (!d.text.trim()) missing.push("text");
  if (d.mode === "custom" && !d.custom.trim()) missing.push("to");
  return missing;
}

export const composeCanSend = (d: ComposeDraft): boolean =>
  composeMissing(d).length === 0;

/** 提交载荷：裁到服务端那两把尺，别让人写了三万字才发现被切 */
export function composePayload(d: ComposeDraft) {
  return {
    to: composeTo(d),
    subject: d.subject.trim().slice(0, COMPOSE_SUBJECT_MAX),
    text: d.text.trim().slice(0, COMPOSE_TEXT_MAX),
  };
}

export const recipientModeLabel = (
  mode: RecipientMode,
  tableCount: number,
): string =>
  mode === "default"
    ? tableCount > 0
      ? `配置里那张表（现在 ${tableCount} 个地址）`
      : "配置里那张表（现在是空的，寄之前得先填）"
    : "只寄给我这一次填的地址";

/** 正文超界的提示：说清会被裁到哪儿，不假装收得下 */
export const textOverflowNote = (text: string): string =>
  text.trim().length > COMPOSE_TEXT_MAX
    ? `正文 ${text.trim().length} 字，超过 ${COMPOSE_TEXT_MAX} 字的部分会被裁掉再寄。`
    : "";

export interface ComposePrefill {
  subject: string;
  text: string;
  custom: string;
  mode: RecipientMode;
}

/**
 * 回信预填。
 *
 * 收件人锁在这封的 `from` 上，**不是**那个显示名 —— 名字是对方自己写的自称，
 * 当地址用等于让写信的人决定信去哪儿。表里目前没有单独存 Reply-To，
 * 所以来路只有 from 这一个来源；真要用 Reply-To 得先把它落进 mail_in。
 */
export function replyPrefill(row: MailInRow): ComposePrefill {
  const subject = row.subject.trim();
  return {
    mode: "custom",
    custom: row.from,
    subject: subject.startsWith("Re:") ? subject : `Re: ${subject || "（对方没写主题）"}`,
    text: "",
  };
}

/**
 * 寄出去之后的那句实话。
 *
 * 失败时把后端原话整段留着（不截、不改写、不补一句「稍后再试」）：
 * 这一句是管理员判断「是地址没验证还是今天额度用完了」的唯一线索。
 */
export function composeResultSentence(r: MailSendResultLike): string {
  return r.ok
    ? "已寄出。这一封占了今日的发信额度，发件箱里多了一行。"
    : `没寄出：${r.error || "后端没给原因"}`;
}
