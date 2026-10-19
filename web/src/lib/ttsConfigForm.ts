// 读音配置表单里的纯规则：草稿与协议默认值的联动、必填校验、列表行摘要。
//
// 为什么要外提：新增与编辑现在共用一个弹页，「切协议时哪些格子该跟着换」
// 「手填过的该不该被洗掉」这套取舍原先写在 renderTtsFields 的 patch 回调里，
// 挪不动也测不了。抽成不依赖 React 的函数才拿得住回归。
// 这里只有规则：不碰接口、不碰 DOM，提交口径仍由面板走 lib/api。

import { TTS_DEFAULTS, TTS_PROTOCOL_LABEL, voiceLabel } from "./presets";
import type { TtsConfig, TtsProtocol } from "./types";

/** 一副嗓子的草稿：新增与编辑共用 */
export interface TtsFormDraft {
  name: string;
  protocol: TtsProtocol;
  baseUrl: string;
  keySecret: string;
  model: string;
  voice: string;
  style: string;
}

export const blankTtsDraft = (): TtsFormDraft => ({
  name: "",
  protocol: "mimo-chat",
  baseUrl: "",
  keySecret: "",
  model: "",
  voice: "",
  style: "",
});

/**
 * 「默认匹配」：换协议时，没被用户动过的字段跟到新协议的默认值
 * （地址 / Key 变量名 / 模型 / 音色一起换对），手填过的字段留住不洗。
 * 判「没动过」就看是不是空的、或者还停在旧协议的默认值上。
 */
export const ttsWithProtocol = (
  d: TtsFormDraft,
  next: TtsProtocol,
): TtsFormDraft => {
  const from = TTS_DEFAULTS[d.protocol];
  const to = TTS_DEFAULTS[next];
  const swap = (cur: string, oldDef: string, newDef: string) =>
    cur.trim() === "" || cur.trim() === oldDef.trim() ? newDef : cur;
  return {
    ...d,
    protocol: next,
    baseUrl: swap(d.baseUrl, from.baseUrl, to.baseUrl),
    keySecret: swap(d.keySecret, from.keySecret, to.keySecret),
    model: swap(d.model, from.model, to.model),
    voice: swap(d.voice, from.voice, to.voice),
  };
};

/** 新增弹页一打开就带出默认协议（MiMo）的全套默认值，起个头再改 */
export const freshTtsDraft = (): TtsFormDraft =>
  ttsWithProtocol(blankTtsDraft(), "mimo-chat");

export const ttsDraftOf = (t: TtsConfig): TtsFormDraft => ({
  name: t.name,
  protocol: t.protocol,
  baseUrl: t.baseUrl,
  keySecret: t.keySecret,
  model: t.model,
  voice: t.voice,
  style: t.style,
});

/** 非MiMo 式的条目 style 没有意义，提交时清掉，免得留脏数据 */
export const ttsPayloadOf = (d: TtsFormDraft) => ({
  name: d.name.trim(),
  protocol: d.protocol,
  baseUrl: d.baseUrl.trim(),
  keySecret: d.keySecret.trim(),
  model: d.model.trim(),
  voice: d.voice.trim(),
  style: d.protocol === "mimo-chat" ? d.style.trim() : "",
});

/** 缺项：field 让调用方知道该往哪一格上指 */
export interface TtsFieldError {
  field: "name" | "keySecret" | "model";
  message: string;
}

/**
 * 必填校验：返回缺的那几项（都填了就空数组），顺序就是表单里出现的顺序。
 * 三格里名称与 Key 变量名是后端硬要求（空了直接抛），模型名是这页一直守着的老口径 ——
 * 留空虽然会退到该协议的默认模型，但一副听不出是什么模型念的嗓子不好排查。
 * trim 后才判空：「   」是手滑留下的空格，不是填过了。
 */
export const ttsMissingFields = (
  d: Pick<TtsFormDraft, "name" | "keySecret" | "model">,
): TtsFieldError[] => {
  const checks: Array<{
    field: TtsFieldError["field"];
    value: string;
    message: string;
  }> = [
    { field: "name", value: d.name, message: "请填写嗓子名称" },
    { field: "keySecret", value: d.keySecret, message: "请填写 Key 变量名" },
    { field: "model", value: d.model, message: "请填写模型名" },
  ];
  return checks
    .filter(({ value }) => !value.trim())
    .map(({ field, message }) => ({ field, message }));
};

/**
 * 行摘要：一行看清这副嗓子接的哪一家、用什么模型念、现在这台机器用不用得上。
 * why 直接用后端 /api/voices 给的那句原话（空串 = 用得上）——
 * 「Key 可用」是后端按 env 判的，前端照 keySecrets 下拉自己推会误伤清单外的变量名。
 * 默认嗓子就是「排在最前且用得上」的那条，由列表顺序表达，这里不加额外标记。
 */
export const ttsSummary = (
  t: Pick<TtsConfig, "protocol" | "model" | "voice" | "keySecret">,
  why = "",
): string => {
  const parts = [
    // 老数据或后端新加协议时标签表里查不到：原样显示，别在这儿漏成空白
    TTS_PROTOCOL_LABEL[t.protocol] || t.protocol,
    t.model || "默认模型",
    `音色 ${voiceLabel(t.protocol, t.voice)}`,
    `Key ${t.keySecret}`,
  ];
  if (why) parts.push(why);
  return parts.join(" · ");
};
