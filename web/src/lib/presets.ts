// 模型与读音的厂商预设表（2026-09-29 逐家官网核实后写死）。
// 预设只到「厂商」这一级：选一家，带出线格式、接口地址、Key 变量名；
// 模型名不预填 —— 留给「拉取模型列表」从厂商那边现拉现挑，
// 拉不到时 note 里的推荐型号就是兜底的参考值。
// 预设是给人起头用的参考值，不进接口：官网怎么写这里就怎么写，改起来也一目了然。

import type { DrawFormat, ModelFormat, TtsProtocol } from "./types";

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
    key: "minimax",
    label: "MiniMax",
    format: "anthropic",
    baseUrl: "https://api.minimax.cn/anthropic/v1",
    urls: {
      anthropic: "https://api.minimax.cn/anthropic/v1",
      "openai-chat": "https://api.minimax.cn/v1",
      "openai-responses": "https://api.minimax.cn/v1",
    },
    listUrl: "https://api.minimax.cn/v1/models",
    listAuth: "bearer",
    modelsPage: "https://platform.minimaxi.com/docs/guides/models",
    keySecret: "MINIMAX_KEY",
    maxOutput: 32768,
    note:
      "M 系列：MiniMax-M3.1-Flash-Preview（聊天思考，anthropic 线自带思维链）、" +
      "MiniMax-M3 / M2.7 / M2.5 等；同 key 还管语音（speech-2.8-hd，t2a_v2）与绘图（image-01）。" +
      "M Plan 订阅 key（sk-cp- 开头）走 api.minimax.cn，api.minimax.io 不认",
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
  minimax: "MiniMax 语音接口",
};

/**
 * 各读音协议的默认值：面板切协议时按这份表把「默认匹配」带出来
 * （地址、Key 变量名、模型、音色一起跟到新协议），用户手填过的字段不动。
 * baseUrl：不填时服务端也会用同款地址兜底（见 src/audio/tts.ts）；
 * keySecret：起头用的 Key 变量名，最终以实际配的 secret 为准；
 * voicePh：voice 输入框的占位话 —— 豆包那家不填 voice 念不了，话得说重一点。
 */
export const TTS_DEFAULTS: Record<
  TtsProtocol,
  {
    model: string;
    voice: string;
    voicePh: string;
    baseUrl: string;
    keySecret: string;
    note: string;
  }
> = {
  "mimo-chat": {
    model: "mimo-v2.5-tts",
    voice: "",
    voicePh: "留空用服务端默认音色",
    // tp- 开头的 Token Plan key 走 token-plan-cn.xiaomimimo.com，服务端按前缀分路
    baseUrl: "https://api.xiaomimimo.com/v1/chat/completions",
    keySecret: "MIMO_API_KEY",
    note: "默认模型 mimo-v2.5-tts",
  },
  doubao: {
    model: "seed-tts-2.0",
    voice: "",
    voicePh: "必填：豆包按音色 id 发音",
    baseUrl: "https://openspeech.bytedance.com/api/v3/tts/unidirectional",
    keySecret: "DOUBAO_TTS_KEY",
    note: "默认模型 seed-tts-2.0，voice 必填",
  },
  "glm-speech": {
    model: "glm-tts",
    voice: "tongtong",
    voicePh: "如 tongtong",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4/audio/speech",
    keySecret: "GLM_KEY",
    note: "默认模型 glm-tts，voice 如 tongtong",
  },
  minimax: {
    model: "speech-2.8-hd",
    voice: "female-shaonv",
    voicePh: "如 female-shaonv（少女音）",
    baseUrl: "https://api.minimax.cn/v1/t2a_v2",
    keySecret: "MINIMAX_KEY",
    note: "默认模型 speech-2.8-hd；音色点输入框就能从系统音色表里挑",
  },
};

/** 预置音色一条：id 进接口，label 只给人看 */
export interface VoicePreset {
  id: string;
  label: string;
}

/**
 * 各读音协议的预置音色（voice 输入框下拉里点选即填 id）。
 * MiniMax 那 22 个是 t2a_v2 官方系统音色表（2026-10 官方文档核实）：
 * 前 8 个中文常用音色、4 个主持人/有声书音色，再 8 个 -jingpin 精品（beta）。
 * speech-2.8-hd 另有 300+ 多语言系统音色，不在表里的 id 手填也照样能用。
 * 其余各家只列官方默认音色；豆包按音色 id 发音、id 以控制台为准，不瞎猜。
 */
export const TTS_VOICE_PRESETS: Record<TtsProtocol, VoicePreset[]> = {
  "mimo-chat": [{ id: "冰糖", label: "冰糖（默认）" }],
  doubao: [],
  "glm-speech": [{ id: "tongtong", label: "通通（默认）" }],
  minimax: [
    // 中文常用音色
    { id: "female-shaonv", label: "少女（活泼年轻）" },
    { id: "female-yujie", label: "御姐（成熟优雅）" },
    { id: "female-chengshu", label: "成熟女性" },
    { id: "female-tianmei", label: "甜美女性（温柔柔和）" },
    { id: "male-qn-qingse", label: "青涩青年（校园青春）" },
    { id: "male-qn-jingying", label: "精英青年" },
    { id: "male-qn-badao", label: "霸道青年（傲气强势）" },
    { id: "male-qn-daxuesheng", label: "青年大学生" },
    // 主持人与有声书
    { id: "presenter_male", label: "男主持人" },
    { id: "presenter_female", label: "女主持人" },
    { id: "audiobook_male_1", label: "有声书男声 1" },
    { id: "audiobook_male_2", label: "有声书男声 2" },
    { id: "audiobook_female_1", label: "有声书女声 1" },
    { id: "audiobook_female_2", label: "有声书女声 2" },
    // -jingpin 精品音色（beta）
    { id: "female-shaonv-jingpin", label: "少女·精品（beta）" },
    { id: "female-yujie-jingpin", label: "御姐·精品（beta）" },
    { id: "female-chengshu-jingpin", label: "成熟女性·精品（beta）" },
    { id: "female-tianmei-jingpin", label: "甜美女性·精品（beta）" },
    { id: "male-qn-qingse-jingpin", label: "青涩青年·精品（beta）" },
    { id: "male-qn-jingying-jingpin", label: "精英青年·精品（beta）" },
    { id: "male-qn-badao-jingpin", label: "霸道青年·精品（beta）" },
    { id: "male-qn-daxuesheng-jingpin", label: "青年大学生·精品（beta）" },
  ],
};

/**
 * 音色 id 翻成人话名：清单和嗓音页显示用。
 * 表里没有的 id 原样返回 —— 用户手填的自定义音色照样显示，不挡新音色。
 */
export function voiceLabel(protocol: TtsProtocol | string, voice: string): string {
  if (!voice) return "默认";
  const table = (TTS_VOICE_PRESETS as Record<string, VoicePreset[]>)[protocol];
  const hit = table?.find((v) => v.id === voice);
  return hit ? `${hit.label}（${voice}）` : voice;
}

/**
 * 各出图协议的默认值：面板切格式时按这份表带出端点 / 模型清单 /
 * Key 变量名（模型清单是降级顺序，从主力排到兜底）。
 * 端点留空时服务端也用同款地址兜底（见 src/tools/draw.ts）；
 * workers-ai 走平台绑定，端点和 key 用不上，只有模型名有意义。
 */
export const DRAW_FORMAT_DEFAULTS: Record<
  DrawFormat,
  {
    endpoint: string;
    models: string;
    keySecret: string;
    label: string;
  }
> = {
  "workers-ai": {
    endpoint: "",
    models: "@cf/black-forest-labs/flux-2-klein-4b",
    keySecret: "",
    label: "Workers AI",
  },
  siliconflow: {
    endpoint: "https://api.siliconflow.cn/v1/images/generations",
    models: "Tongyi-MAI/Z-Image-Turbo, Kwai-Kolors/Kolors",
    keySecret: "SILICONFLOW_API_KEY",
    label: "硅基流动",
  },
  zhipu: {
    endpoint: "https://open.bigmodel.cn/api/paas/v4/images/generations",
    models: "cogview-4-250304, cogview-3-flash",
    keySecret: "ZHIPU_KEY",
    label: "智谱",
  },
  minimax: {
    endpoint: "https://api.minimax.cn/v1/image_generation",
    models: "image-01, image-01-live",
    keySecret: "MINIMAX_KEY",
    label: "MiniMax",
  },
};
