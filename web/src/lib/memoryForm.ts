// 记忆面板与弹页里的纯规则：必填校验、标签串↔数组、提交载荷、删除引文、tag 门槛摘要。
//
// 为什么要外提：「写一条记忆」原先是面板底下一根裸输入条，必填与否藏在 disabled
// 表达式里，标签怎么切、哪句该进删除确认都散在 JSX 中。改一句措辞就可能顺手碰坏
// 「纯空格算不算填了」「逗号混进标签会冒充一道门」这类边界 —— 抽成不依赖 React 的函数才拿得住回归。
// 这里只有规则，不碰接口、不碰 DOM —— 提交口径仍由面板走 lib/api。
//
// 字段清单以 POST /api/memory 为准（src/index.ts）：管理员这条路认
// content / type / shelf / tags / person / volatility，其余一概不在这张表单里凭空长出来。

import { SENSITIVITY_LABEL, type Sensitivity, type Shelf, type TagStat } from "./types";

/** 会不会变：说的是现状（volatile，会进复核清单）还是他一直如此（stable） */
export type MemoryVolatility = "stable" | "volatile";

/** 写一条新记忆的草稿：四格对齐后端 POST /api/memory 收的那几样 */
export interface MemoryDraft {
  content: string;
  shelf: Shelf;
  /** 输入框里的那一串，提交前才切成数组 */
  tags: string;
  volatility: MemoryVolatility;
}

/** 弹页里出现顺序就是缺项提示的顺序 */
export type MemoryRequiredField = "content";

/** 缺一格给一句能直接给人看的话；field 让调用方知道该往哪一格上指 */
export interface FieldError {
  field: MemoryRequiredField;
  message: string;
}

/** 架子默认落在「知识」：和后端 insertMemory 的回落同一档，新增时不必再挑 */
export const DEFAULT_MEMORY_SHELF: Shelf = "knowledge";

/** 后端 POST /api/memory 把单条正文截到 500 字（src/index.ts）：超出的部分服务端会丢掉 */
export const MAX_MEMORY_CONTENT = 500;

/**
 * 必填校验：返回缺的那几项（填齐了就空数组）。
 * trim 后才判空 —— 「   」是手滑留下的空格，不是填了一条记忆。
 */
export const memoryMissingFields = (d: Pick<MemoryDraft, "content">): FieldError[] =>
  d.content.trim() ? [] : [{ field: "content", message: "请写下要记住的事" }];

/** 正文超长只做提示、不拦保存：截断本来就是后端的规矩，拦死等于让人去别处写 */
export const memoryContentTooLong = (raw: string): boolean =>
  raw.trim().length > MAX_MEMORY_CONTENT;

/**
 * 标签输入串 → 数组：逗号（半角全角）、顿号、分号、空白都当分隔符。
 * 逗号必须当分隔符而不是留在 tag 里 —— tag 在库里就是按逗号分隔存的，
 * 一个 tag 里带逗号等于凭空多出的一道门（见 src/agent/memory.ts 的 insertMemory）。
 * 顺手去重、去空，保持人写的先后顺序。
 */
export const parseTags = (raw: string): string[] => {
  const out: string[] = [];
  for (const tag of (raw || "").split(/[,，、;；\s]+/)) {
    const t = tag.trim();
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
};

/** 数组 → 输入框里的一串：用顿号回写，跟 parseTags 互为逆操作（空数组就是空串） */
export const tagsToText = (tags: string[]): string => tags.join("、");

/** 提交前折成请求体：留空的标签格不硬塞空数组之外的东西，volatility 按后端口径二选一 */
export const memoryPayloadOf = (d: MemoryDraft) => ({
  content: d.content.trim(),
  shelf: d.shelf,
  tags: parseTags(d.tags),
  volatility: d.volatility,
});

/**
 * 删除确认里引的那一句。
 * 不做 trim、不改标点：引文照原文摆出来，人才对得上「我要删的到底是哪条」。
 */
export const contentSnippet = (content: string, max = 40): string => {
  const s = content || "";
  return s.length > max ? `${s.slice(0, max)}…` : s;
};

/** 一道 tag 门显示成一句话：「不公开」是没开门，其余是「某档及以下」 */
export const gateLevelLabel = (maxLevel: string): string =>
  maxLevel
    ? `${SENSITIVITY_LABEL[maxLevel as Sensitivity] || maxLevel}及以下`
    : "不公开";

/**
 * tag 门槛行的摘要：几条、各量级几条。
 * 绝密只在真有的那天才出现 —— 绝大多数 tag 后面挂个「绝密 0」只会占掉整行。
 */
export const tagStatSummary = (s: TagStat): string => {
  if (!s.n) return "还没有带这个 tag 的条目";
  const parts = [
    `不重要 ${s.trivial}`,
    `一般 ${s.normal}`,
    `重要 ${s.important}`,
    `机密 ${s.secret}`,
  ];
  if (s.topsecret) parts.push(`绝密 ${s.topsecret}（永不出门）`);
  return `${s.n} 条（${parts.join(" · ")}）`;
};
