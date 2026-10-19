// 模型目录表单里的纯规则：必填校验、数字格解析、列表行摘要。
//
// 为什么要外提：这些判断原先散在 disabled 表达式和列表的 JSX 里，改一句措辞就可能
// 顺手碰坏「纯空格算不算填了」「1.5 该往哪收」这类边界。抽成不依赖 React 的函数才拿得住回归。
// 这里只有规则，不碰接口、不碰 DOM —— 提交口径仍由面板走 lib/api。

import { MODEL_FORMAT_LABEL } from "./presets";
import type { ModelEntry, ModelFormat, ModelProvider } from "./types";

/** 供应商弹页的草稿：前六格对齐 ModelProvider，后两格只在新增时顺手挂首个模型 */
export interface ProviderFormDraft {
  name: string;
  format: ModelFormat;
  baseUrl: string;
  keySecret: string;
  maintKeySecret: string;
  maintModel: string;
  firstModel: string;
  firstMax: string;
}

/** 必填三格：顺序就是表单里出现的顺序，缺项提示按这个顺序排 */
export type ProviderRequiredField = "name" | "baseUrl" | "keySecret";

/** 缺一格给一句能直接给人看的话；field 让调用方知道该往哪一格上指 */
export interface FieldError {
  field: ProviderRequiredField | "model";
  message: string;
}

/**
 * 供应商必填校验：返回缺的那几项（全填了就空数组），顺序就是表单里出现的顺序。
 * trim 后才判空 —— 「   」是手滑留下的空格，不是填过了。
 */
export const providerMissingFields = (
  d: Pick<ModelProvider, "name" | "baseUrl" | "keySecret">,
): FieldError[] => {
  const checks: Array<{
    field: ProviderRequiredField;
    value: string;
    message: string;
  }> = [
    { field: "name", value: d.name, message: "请填写供应商名称" },
    { field: "baseUrl", value: d.baseUrl, message: "请填写接口地址（Base URL）" },
    { field: "keySecret", value: d.keySecret, message: "请填写 Key 变量名" },
  ];
  return checks
    .filter(({ value }) => !value.trim())
    .map(({ field, message }) => ({ field, message }));
};

/** 模型条目只有模型名是必填的；两个额度格允许留空 */
export const entryMissingFields = (d: { model: string }): FieldError[] =>
  d.model.trim() ? [] : [{ field: "model", message: "请填写模型名" }];

/**
 * Key 那一栏常见手误：把 Key 本体当变量名贴进来。只用来提示，不拦保存 ——
 * 有的厂牌 Key 确实长这样，拦死等于逼人去别处填。
 */
export const looksLikeRawKey = (value: string): boolean =>
  /^sk-\S+/.test(value.trim());

/**
 * 一格里能填的最大 token 数。超过它一律收在这个数上：
 * 现在报得出准数的公开窗口就是 1M 一带（见 presets 各家备注），再大手基本是多打了几个 0，
 * 放过去聊天头部的「窗口占用」百分比会被算成 0%，看着像还没聊，不如收住。
 */
export const MAX_TOKEN_INPUT = 1_000_000;

/**
 * 字符串 → 正整数 token 的公共那段：
 * 留空 / 不像数字 / 0 / 负数 都当作「没填」（返回 undefined，交给后端默认档）；
 * 小数在这儿四舍五入 —— 后端 toMaxOutput、toContextWindow 只认整数，
 * 不收口就会把人写的 1.5 悄悄换成默认值，那比报错更糟。
 */
const toTokens = (value: number): number | undefined =>
  Number.isFinite(value) && value > 0
    ? Math.min(Math.round(value), MAX_TOKEN_INPUT)
    : undefined;

/** 输出上限：这一格本来就按 token 计 */
export const parseMaxOutput = (raw: string): number | undefined => {
  const t = raw.trim();
  // 空格算 0、"abc" 算 NaN：两者都不是「想要这个数」，一起当作没填
  return t ? toTokens(Number(t)) : undefined;
};

/** 最大上下文：界面以 K 计（填 200 就是 200K），提交前折回 token */
export const parseContextWindow = (rawK: string): number | undefined => {
  const t = rawK.trim();
  return t ? toTokens(Number(t) * 1000) : undefined;
};

/** token 数画成 K：200000 → 200K */
export const tokensToK = (n: number): string => `${Math.round(n / 1000)}K`;

/**
 * 条目 → 草稿：两个数字格回写成界面口径（上下文折成 K）。
 * 0 回写成空串而不是 "0" —— 0 在这里的意思就是「没设」，填成 0 会让人以为设过。
 */
export const entryFormOf = (
  e: Pick<ModelEntry, "model" | "maxOutput" | "contextWindow">,
): { model: string; maxOutput: string; contextWindow: string } => ({
  model: e.model,
  maxOutput: e.maxOutput ? String(e.maxOutput) : "",
  contextWindow: e.contextWindow
    ? String(Math.round(e.contextWindow / 1000))
    : "",
});

/**
 * 供应商行摘要：一行看清接的哪一家、用哪把 Key、挂了几个模型、维护走谁。
 * 地址放最后 —— 它是这行里最长的东西，窄屏被省略号切掉的应该是它，不是模型数。
 */
export const providerSummary = (
  p: Pick<ModelProvider, "format" | "baseUrl" | "keySecret" | "maintModel">,
  entryCount: number,
): string => {
  const parts = [
    // 老数据或后端新加格式时标签表里查不到：原样显示，别在这儿漏成空白
    MODEL_FORMAT_LABEL[p.format] || p.format,
    `Key ${p.keySecret}`,
    entryCount ? `${entryCount} 个模型` : "还没挂模型",
  ];
  if (p.maintModel) parts.push(`维护 ${p.maintModel}`);
  parts.push(p.baseUrl);
  return parts.join(" · ");
};

/** 条目行摘要：没设的那两格照后端口径说「默认」 */
export const entrySummary = (
  e: Pick<ModelEntry, "maxOutput" | "contextWindow">,
): string =>
  `输出上限 ${e.maxOutput || "默认"} · 上下文 ${
    e.contextWindow ? tokensToK(e.contextWindow) : "默认"
  }`;
