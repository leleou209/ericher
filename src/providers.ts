// AI SDK model provider 工厂。
//
// 两条建模的路：
// - 目录链（模型目录，管理员面板配的）：生效的模型条目 + 它挂的供应商
//   说用哪家、什么协议、去哪个门，key 从供应商点名的 secret 变量名取；
// - 旧链（Worker secrets）：API_ENDPOINT 是 Anthropic 兼容端点（如
//   https://api.deepseek.com/anthropic）。注意 AI SDK 只会在 baseURL 后面补一个
//   /messages，**不会**补 /v1 —— 所以端点的 /v1 要自己带上（DeepSeek 恰好
//   /anthropic 与 /anthropic/v1 都收，少写一层看不出来；换成小米 MiMo 就直接 404）。
//
// AI Gateway 只属于旧链：目录条目不带网关概念，baseUrl 里用户自己可以填网关地址。

import { createAnthropic } from "@ai-sdk/anthropic";
import type { LanguageModel } from "ai";
import { openAIModelWithReasoning as withReasoningContent } from "./agent/reasoningBridge";
import { mimoAnthropicBase } from "./mimo";
import {
  toMaxOutput,
  type ActiveCatalog,
  type ModelFormat,
} from "./agent/modelConfigs";

const DEFAULT_MODEL = "claude-sonnet-4-20250514";

function provider(env: Env, apiKey: string) {
  // 走 AI Gateway 时用网关地址，并开启 1 小时结果缓存省 token
  const gateway = env.AI_GATEWAY_URL;
  return createAnthropic({
    baseURL: gateway || env.API_ENDPOINT || "https://api.anthropic.com",
    apiKey,
    headers: gateway ? { "cf-aig-cache-ttl": "3600" } : undefined,
  });
}

/** 主对话模型；未配置 API_KEY 时返回 null，由调用方给出明确提示。 */
export function mainModel(env: Env): LanguageModel | null {
  if (!env.API_KEY) return null;
  return provider(env, env.API_KEY)(env.API_MODEL || DEFAULT_MODEL);
}

/** 后台维护模型（夜间整理 / 反思 / 洞察萃取）；缺省复用主模型。 */
export function maintenanceModel(env: Env): LanguageModel | null {
  if (env.SK_MAINTENANCE)
    return provider(env, env.SK_MAINTENANCE)(env.API_MODEL || DEFAULT_MODEL);
  return mainModel(env);
}

/** 起会话标题用的模型；不填就用小米的 MiMo V2.5 Pro */
const DEFAULT_TITLE_MODEL = "mimo-v2.5-pro";

/**
 * 起标题的模型：小米 MiMo，走它自己的 Anthropic 兼容端点（见 src/mimo.ts）。
 *
 * 为什么不复用 maintenanceModel：起标题是「一句话的小活」，主线那台模型
 * 是按量计费的，用它等于拿大炮打蚊子。MiMo 这边是包月套餐，这类碎活正好塞进去。
 *
 * 没配 MIMO_API_KEY 时返回 null，标题就保持原来的「截前 18 个字」。
 */
export function titleModel(env: Env): LanguageModel | null {
  if (!env.MIMO_API_KEY) return null;
  return createAnthropic({
    baseURL: mimoAnthropicBase(env),
    apiKey: env.MIMO_API_KEY,
    // 不挂 AI Gateway：网关的缓存与限额是给主线那台模型配的，这里用不上
  })((env.MIMO_TITLE_MODEL || "").trim() || DEFAULT_TITLE_MODEL);
}

/**
 * 起标题时要一起传下去的参数：关掉思考。
 *
 * mimo-v2.5-pro 默认先想一遍再开口。起个名字用不着推理 ——
 * 实测 881 个字符的思考换来一个名字，而关掉之后它直接给，
 * 既不白等那几秒，也不白烧套餐额度。
 * 放在这里而不是散在调用处：这是这家模型的脾气，该跟选模型的地方待在一起。
 */
export const TITLE_PROVIDER_OPTIONS = {
  anthropic: { thinking: { type: "disabled" } },
} as const;

// ── 目录链：按模型目录（供应商 + 生效条目）建模 ───────────────

/**
 * 最大上下文的默认档：条目没设 context_window 时回落到这个数。
 * 主流长窗模型（Claude / GPT / DeepSeek）都在 128K-200K 一带，取 200K 做上限档；
 * 界面显示占用、压缩门槛都拿它当「这扇门有多宽」的兜底答案。
 */
export const DEFAULT_CONTEXT_WINDOW = 200_000;

/** 一次解析的结果：主模型 + 输出上限 + 接口格式 + 上下文宽度 + 维护模型 */
export interface ResolvedModel {
  model: LanguageModel;
  maxOutput: number;
  /** 这条模型走哪种协议：缓存断点等 Anthropic 专属待遇按它开（旧链就是 anthropic） */
  format: ModelFormat;
  /** 最大上下文（token）。条目设了用条目的，没设回落默认档 */
  contextWindow: number;
  maintModel: LanguageModel | null;
}

/** 从 env 里按变量名取 secret；不是字符串一律当没配 */
function envSecret(env: Env, name: string): string {
  const v = (env as unknown as Record<string, unknown>)[name || ""];
  return typeof v === "string" ? v : "";
}

/** 按供应商的格式建一个模型。baseUrl 原样透传 —— 路径语义由 AI SDK 自己补。 */
function buildModel(
  format: ModelFormat,
  baseUrl: string,
  apiKey: string,
  modelId: string,
): LanguageModel {
  if (format === "anthropic")
    return createAnthropic({ baseURL: baseUrl, apiKey })(modelId);
  // openai 两种格式的流都不认思维链（chat 的 reasoning_content、responses 的
  // reasoning_text.delta 都被 schema strip）—— DeepSeek/GLM/Kimi 这类端点
  // 的思考流靠这层桥找回来；anthropic 有原生 thinking 通道，不用包
  return withReasoningContent({
    apiKey,
    baseURL: baseUrl,
    format,
    modelId,
  }) as unknown as LanguageModel;
}

/**
 * 把「这一轮该用哪个模型」定下来。
 *
 * fetchActive 去主人那间读模型目录的生效一组（生效条目 + 它挂的供应商，
 * 调用方负责缓存），读到了且供应商点名的 key 在这台机器上真的配了，就走目录链；
 * 读不到、key 缺了、中途出错 —— 一律回落旧链。换厂商是锦上添花，
 * 不能因为目录那边出任何岔子让整台机器说不了话。
 */
export async function resolveModel(
  env: Env,
  fetchActive: () => Promise<ActiveCatalog | null>,
): Promise<ResolvedModel | null> {
  let catalog: ActiveCatalog | null = null;
  try {
    catalog = await fetchActive();
  } catch {
    catalog = null;
  }

  if (catalog) {
    const { entry, provider } = catalog;
    const apiKey = envSecret(env, provider.keySecret);
    if (apiKey) {
      const model = buildModel(
        provider.format,
        provider.baseUrl,
        apiKey,
        entry.model,
      );
      // 维护模型：供应商单独配了维护 key 就另建一个，模型名取维护口那行
      // （空了复用主线）；只写模型名没写 key 不算数 —— 用本家 key 去调另一个
      // 模型名，多半是没开通，报错只会更难查。
      const maintKey = provider.maintKeySecret
        ? envSecret(env, provider.maintKeySecret)
        : "";
      const maintModel = maintKey
        ? buildModel(
            provider.format,
            provider.baseUrl,
            maintKey,
            provider.maintModel || entry.model,
          )
        : model;
      return {
        model,
        maxOutput: toMaxOutput(entry.maxOutput),
        format: provider.format,
        contextWindow:
          entry.contextWindow > 0
            ? entry.contextWindow
            : DEFAULT_CONTEXT_WINDOW,
        maintModel,
      };
    }
    // 只提醒一行：目录配置了但这台机器没那把钥匙，是迁移期最常见的状态
    console.warn(
      `[model-configs] 供应商「${provider.name}」点名的 ${provider.keySecret} 没配 key，回落到内置配置`,
    );
  }

  const model = mainModel(env);
  if (!model) return null;
  return {
    model,
    maxOutput: 131072,
    format: "anthropic",
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maintModel: maintenanceModel(env),
  };
}
