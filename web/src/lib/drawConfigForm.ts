// 绘图配置表单里的纯规则：三档的名目、草稿与协议默认值的联动、
// 模型清单的文本↔数组、必填校验、列表行摘要。
//
// 为什么要外提：出图三档从「每张卡一排裸露输入条」换成「列表 + 详情弹页」后，
// 逗号怎么切、切完剩几个、哪些格子在 workers-ai 档用不上 —— 这些判断得能测。
// 这里只有规则：不碰接口、不碰 DOM，提交口径仍由面板走 lib/api。

import { DRAW_FORMAT_DEFAULTS } from "./presets";
import type { DrawConfig, DrawFormat } from "./types";

/** 三档的名目与定位。tier 就是配置主键，顺序永远是：high → fast → fallback */
export const DRAW_TIER_META: Record<
  DrawConfig["tier"],
  { title: string; desc: string }
> = {
  fast: { title: "主力 fast", desc: "日常配图走这档：便宜、不带平台水印" },
  high: {
    title: "高质量 high",
    desc: "按张付费：画立绘、二次元、封面，或者他说「要好看点」时她才升档",
  },
  fallback: {
    title: "兜底 fallback",
    desc: "前面全栽了才轮到它：能出一张是正事",
  },
};

export const DRAW_FORMAT_LABEL: Record<DrawFormat, string> = {
  "workers-ai": "Workers AI 绑定",
  siliconflow: "硅基流动",
  zhipu: "智谱",
  minimax: "MiniMax",
};

/** 表单草稿：模型清单在输入框里是逗号分隔的字符串，存库时折回数组 */
export interface DrawFormDraft {
  format: DrawFormat;
  label: string;
  endpoint: string;
  models: string;
  keySecret: string;
}

export const blankDrawDraft = (): DrawFormDraft => ({
  format: "workers-ai",
  label: "",
  endpoint: "",
  models: "",
  keySecret: "",
});

/** 清单文本：数组 → 输入框里那种「a, b」；分隔符与 parseDrawModels 认的对得上 */
export const modelsToText = (models: string[]): string => models.join(", ");

/**
 * 输入框里那串 → 数组：中英文逗号都认（老面板就这么收的），逐格 trim，空段丢掉。
 * 顺序就是降级顺序：前面的先试，没成才轮到后面。
 */
export const parseDrawModels = (raw: string): string[] =>
  raw.split(/[，,]/).map((m) => m.trim()).filter(Boolean);

export const drawDraftOf = (c: DrawConfig): DrawFormDraft => ({
  format: c.format,
  label: c.label,
  endpoint: c.endpoint,
  models: modelsToText(c.models),
  keySecret: c.keySecret,
});

/**
 * 「默认匹配」：换出图协议时，没被用户动过的字段跟到新格式的默认值
 * （端点 / 模型清单 / Key 变量名 / 标注名一起换对），手填过的留住不洗。
 */
export const drawWithFormat = (
  d: DrawFormDraft,
  next: DrawFormat,
): DrawFormDraft => {
  const from = DRAW_FORMAT_DEFAULTS[d.format];
  const to = DRAW_FORMAT_DEFAULTS[next];
  const swap = (cur: string, oldDef: string, newDef: string) =>
    cur.trim() === "" || cur.trim() === oldDef.trim() ? newDef : cur;
  return {
    ...d,
    format: next,
    endpoint: swap(d.endpoint, from.endpoint, to.endpoint),
    models: swap(d.models, from.models, to.models),
    keySecret: swap(d.keySecret, from.keySecret, to.keySecret),
    label: swap(d.label, from.label, to.label),
  };
};

/** workers-ai 档走平台 AI 绑定（neurons 计费），端点与 key 两格用不上 */
export const drawIsBinding = (format: DrawFormat): boolean =>
  format === "workers-ai";

/** 提交给后端的那份：文本清单在这儿折回数组，空格一律洗掉 */
export const drawPayloadOf = (d: DrawFormDraft) => ({
  format: d.format,
  label: d.label.trim(),
  endpoint: d.endpoint.trim(),
  keySecret: d.keySecret.trim(),
  models: parseDrawModels(d.models),
});

/** 缺项：field 让调用方知道该往哪一格上指 */
export interface DrawFieldError {
  field: "models";
  message: string;
}

/**
 * 必填校验：返回缺的那几项（填了就空数组）。
 * 只有模型清单是硬的 —— 后端 updateDrawConfig 见空清单抛「至少要留一个模型名」，
 * 这里用同一句话提前指到那一格，不另发明一条口径。
 * 只填了逗号「, ,」切出来还是空数组，照样算没填。
 */
export const drawMissingFields = (d: {
  models: string;
}): DrawFieldError[] =>
  parseDrawModels(d.models).length
    ? []
    : [{ field: "models", message: "至少要留一个模型名" }];

/**
 * 行摘要：一行看清这一档走哪家、画完图上那行字写什么、降级清单有几个。
 * 端点不放进来 —— 它是这行里最长的东西，真要看就在弹页里看。
 */
export const drawSummary = (c: DrawConfig): string => {
  const parts = [
    // 老数据或后端新加协议时标签表里查不到：原样显示，别在这儿漏成空白
    DRAW_FORMAT_LABEL[c.format] || c.format,
    c.label ? `标注 ${c.label}` : "没有标注名",
    c.models.length ? `${c.models.length} 个模型` : "没留模型名",
  ];
  parts.push(
    drawIsBinding(c.format) ? "走平台 AI 绑定" : `Key ${c.keySecret || "未配"}`,
  );
  return parts.join(" · ");
};
