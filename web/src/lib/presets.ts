// 模型与读音的厂商预设表（2026-09-29 逐家官网核实后写死）。
// 预设只到「厂商」这一级：选一家，带出线格式、接口地址、Key 变量名；
// 模型名不预填 —— 留给「拉取模型列表」从厂商那边现拉现挑，
// 拉不到时 note 里的推荐型号就是兜底的参考值。
// 预设是给人起头用的参考值，不进接口：官网怎么写这里就怎么写，改起来也一目了然。

import type { ModelFormat, TtsProtocol } from "./types";

interface VendorPreset {
  key: string;
  label: string;
  /** 默认线格式（下拉里的初始值） */
  format: ModelFormat;
  /** 默认线格式的接口地址（= urls[format]，单列出来省一层查表） */
  baseUrl: string;
  /** 每种线格式各自的接口地址：换格式时面板按这份表把地址跟着换对 */
  urls: Partial<Record<ModelFormat, string>>;
  /** 模型列表端点（完整 URL，官网核实的），拉取模型列表时优先用它 */
  listUrl: string;
  /** 模型列表端点的鉴权头风格 */
  listAuth: "bearer" | "x-api-key";
  /** 官方模型列表页（给人看的），拉不到时的去处 */
  modelsPage: string;
  keySecret: string;
  maxOutput: number;
  note: string;
}

export const VENDOR_PRESETS: VendorPreset[] = [
  {
    key: "deepseek",
    label: "DeepSeek",
    format: "anthropic",
    baseUrl: "https://api.deepseek.com/anthropic/v1",
    urls: {
      anthropic: "https://api.deepseek.com/anthropic/v1",
      "openai-chat": "https://api.deepseek.com/v1",
      "openai-responses": "https://api.deepseek.com/v1",
    },
    listUrl: "https://api.deepseek.com/models",
    listAuth: "bearer",
    modelsPage: "https://api-docs.deepseek.com/quick_start/pricing",
    keySecret: "DEEPSEEK_KEY",
    maxOutput: 32768,
    note: "1M 上下文，输出上限 384K；旗舰 deepseek-v4-pro，便宜档 deepseek-flash（支持图像理解）",
  },
  {
    key: "openai",
    label: "OpenAI",
    format: "openai-responses",
    baseUrl: "https://api.openai.com/v1",
    urls: {
      "openai-chat": "https://api.openai.com/v1",
      "openai-responses": "https://api.openai.com/v1",
    },
    listUrl: "https://api.openai.com/v1/models",
    listAuth: "bearer",
    modelsPage: "https://platform.openai.com/api/docs/models",
    keySecret: "OPENAI_KEY",
    maxOutput: 32768,
    note: "全系 1.05M 上下文、128K 输出；旗舰 gpt-6-astra，平衡 gpt-6-sol，大流量便宜档 gpt-6-luna",
  },
  {
    key: "anthropic",
    label: "Anthropic (Claude)",
    format: "anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    urls: { anthropic: "https://api.anthropic.com/v1" },
    listUrl: "https://api.anthropic.com/v1/models",
    listAuth: "x-api-key",
    modelsPage:
      "https://docs.anthropic.com/en/docs/about-claude/models/overview",
    keySecret: "ANTHROPIC_KEY",
    maxOutput: 32768,
    note: "1M 上下文、128K 输出；旗舰 claude-opus-5-5 或 claude-fable-5-1，平衡 claude-sonnet-5，最快 claude-haiku-4-5",
  },
  {
    key: "google",
    label: "Google (Gemini)",
    format: "openai-chat",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    urls: {
      "openai-chat": "https://generativelanguage.googleapis.com/v1beta/openai",
    },
    listUrl: "https://generativelanguage.googleapis.com/v1beta/openai/models",
    listAuth: "bearer",
    modelsPage: "https://ai.google.dev/gemini-api/docs/models",
    keySecret: "GEMINI_KEY",
    maxOutput: 32768,
    note: "Google 官方 OpenAI 兼容端点；旗舰 gemini-3.1-pro，平衡 gemini-3.6-flash",
  },
  {
    key: "mimo",
    label: "小米 MiMo",
    format: "anthropic",
    baseUrl: "https://api.xiaomimimo.com/anthropic/v1",
    urls: {
      anthropic: "https://api.xiaomimimo.com/anthropic/v1",
      "openai-chat": "https://api.xiaomimimo.com/v1",
      "openai-responses": "https://api.xiaomimimo.com/v1",
    },
    listUrl: "https://api.xiaomimimo.com/v1/models",
    listAuth: "bearer",
    modelsPage: "https://mimo.mi.com/docs/zh-CN/quick-start/summary/model",
    keySecret: "MIMO_API_KEY",
    maxOutput: 32768,
    note: "上下文 1M、输出上限 131072；旗舰 mimo-v2.6-pro，便宜档 mimo-v2.6-flash（V2.5 系列 2026-10-21 下线）；包月 Token Plan 的地址是 token-plan-cn.xiaomimimo.com",
  },
  {
    key: "zhipu",
    label: "智谱 GLM",
    format: "anthropic",
    baseUrl: "https://open.bigmodel.cn/api/anthropic/v1",
    urls: {
      anthropic: "https://open.bigmodel.cn/api/anthropic/v1",
      "openai-chat": "https://open.bigmodel.cn/api/paas/v4",
    },
    listUrl: "https://open.bigmodel.cn/api/paas/v4/models",
    listAuth: "bearer",
    modelsPage: "https://docs.bigmodel.cn/cn/guide/start/model-overview",
    keySecret: "GLM_KEY",
    maxOutput: 32768,
    note: "1M 上下文、128K 输出，旗舰 glm-5.3；Coding Plan 套餐地址不同（open.bigmodel.cn/api/coding/paas/v4）",
  },
];

export const MODEL_FORMAT_LABEL: Record<ModelFormat, string> = {
  anthropic: "Anthropic 格式",
  "openai-chat": "OpenAI Chat 格式",
  "openai-responses": "OpenAI Responses 格式",
};

export const TTS_PROTOCOL_LABEL: Record<TtsProtocol, string> = {
  "mimo-chat": "MiMo 式对话接口",
  doubao: "豆包单向流式",
  "glm-speech": "智谱语音接口",
};

/**
 * 各读音协议的默认值（表单 placeholder 用）。
 * model：不填时服务端会用的默认模型；voice：可以拿来当起点的音色；
 * voicePh：voice 输入框的占位话 —— 豆包那家不填 voice 念不了，话得说重一点。
 */
export const TTS_DEFAULTS: Record<
  TtsProtocol,
  { model: string; voice: string; voicePh: string; note: string }
> = {
  "mimo-chat": {
    model: "mimo-v2.5-tts",
    voice: "",
    voicePh: "留空用服务端默认音色",
    note: "默认模型 mimo-v2.5-tts",
  },
  doubao: {
    model: "seed-tts-2.0",
    voice: "",
    voicePh: "必填：豆包按音色 id 发音",
    note: "默认模型 seed-tts-2.0，voice 必填",
  },
  "glm-speech": {
    model: "glm-tts",
    voice: "tongtong",
    voicePh: "如 tongtong",
    note: "默认模型 glm-tts，voice 如 tongtong",
  },
};
