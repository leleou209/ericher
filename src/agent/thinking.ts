// 思考强度：供应商定「怎么写」，模型条目定「多强」。
//
// 同一个档位，各家接口的字段名与形状都不一样：
// - Claude 原生（以及 DeepSeek / GLM / MiMo / MiniMax 的 anthropic 兼容口）认
//   thinking: { type: "enabled", budget_tokens } / { type: "disabled" }；
// - 新版 Claude 换成 output_config.effort（low / medium / high / xhigh / max）；
// - OpenAI 官方认 reasoning_effort（responses 线是 reasoning.effort）；
// - DeepSeek / GLM / Kimi 的 OpenAI 兼容口认 thinking: { type }；
// - Qwen 系认 enable_thinking。
//
// 档位是给人挑的，写法是给接口看的。混成一格，换一家就得重填一遍 ——
// 所以拆成供应商一级（怎么写）与条目一级（多强）。同一个模型挂两条、
// 普通模式轻思考、深度模式重思考，就是这么来的。
//
// 这一层只算「该发什么」，不发请求：
// - anthropic 线折成 AI SDK 的 providerOptions（anthropic 的 schema 只认自家键）；
// - OpenAI 系折成一小段指令，key 是 BRIDGE_KEY，交给 reasoningBridge 在 fetch 层
//   写进请求体 —— 那儿本来就在逐行改请求与响应流，顺路最省事，
//   也不依赖各家 SDK 的参数 schema（未知键会被 zod strip 掉）。
//
// 没配（level = ""）就一个字都不发：跟厂商默认走，这是最不容易踩坑的档，
// 也是所有存量条目的状态。

import type { JSONObject } from "@ai-sdk/provider";

/** 思考参数怎么写（供应商一级）。auto = 按接口格式挑默认写法 */
export type ThinkingDialect =
  | "auto"
  | "anthropic"
  | "anthropic-effort"
  | "reasoning-effort"
  | "thinking-object"
  | "enable-thinking"
  | "none";

/** 思考强度（模型条目一级）。"" = 没设，一个字都不发 */
export type ThinkingLevel = "" | "off" | "low" | "medium" | "high" | "max";

/** 下拉框的顺序就是这里的顺序：默认写法排第一，省事的档排前面 */
export const THINKING_DIALECTS: ThinkingDialect[] = [
  "auto",
  "anthropic",
  "anthropic-effort",
  "reasoning-effort",
  "thinking-object",
  "enable-thinking",
  "none",
];

/** 「没设」也算一档：存量条目全在这一档，界面要能选回它 */
export const THINKING_LEVELS: ThinkingLevel[] = [
  "",
  "off",
  "low",
  "medium",
  "high",
  "max",
];

/** reasoningBridge 认的那个 providerOptions 键。不叫 openai / anthropic：那是两家的地界 */
export const BRIDGE_KEY = "ericher";

/** anthropic 预算档的档位 → token。自定义预算优先，没填才按这张表 */
export const ANTHROPIC_BUDGET: Record<
  Exclude<ThinkingLevel, "" | "off">,
  number
> = { low: 1024, medium: 4096, high: 16384, max: 32768 };

/** OpenAI 系档位 → reasoning_effort。max 折成 xhigh（它那套的最高档） */
const OPENAI_EFFORT: Record<Exclude<ThinkingLevel, "">, string> = {
  off: "none",
  low: "low",
  medium: "medium",
  high: "high",
  max: "xhigh",
};

/** 认不出的写法一律回落 auto：目录里可能存着旧版本或手改过的值 */
export function toThinkingDialect(v: unknown): ThinkingDialect {
  return THINKING_DIALECTS.includes(v as ThinkingDialect)
    ? (v as ThinkingDialect)
    : "auto";
}

/** 认不出的档位一律当「没设」：宁可不发，也不要发一个厂商看不懂的值把整轮打挂 */
export function toThinkingLevel(v: unknown): ThinkingLevel {
  return THINKING_LEVELS.includes(v as ThinkingLevel)
    ? (v as ThinkingLevel)
    : "";
}

/** 预算只认正整数；0 与脏值都表示「没填，按档位换算」 */
export function toThinkingBudget(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isInteger(n) && n > 0 ? n : 0;
}

/** 三种接口格式（与 modelConfigs.ModelFormat 同形；不 import 是为了不造循环依赖） */
type WireFormat = "anthropic" | "openai-chat" | "openai-responses";

/** anthropic 线的两种写法；OpenAI 系的三种写法 */
type AnthropicDialect = Extract<
  ThinkingDialect,
  "anthropic" | "anthropic-effort"
>;
type OpenAIDialect = Extract<
  ThinkingDialect,
  "reasoning-effort" | "thinking-object" | "enable-thinking"
>;

/**
 * 把「供应商选的写法」落实到「这条线真能用的写法」。
 *
 * 选错不报错、也不丢配置：换格式时用户不一定回头改写法，此时按格式取默认 ——
 * anthropic 线认不了 reasoning_effort，OpenAI 线也认不了 thinking.budget_tokens，
 * 硬发过去就是 400。默认写法固定为 anthropic 预算档 / reasoning_effort，
 * 两边都最普遍的那一支。
 */
export function effectiveDialect(
  format: WireFormat,
  dialect: ThinkingDialect,
): AnthropicDialect | OpenAIDialect | "none" {
  const isAnthropic = format === "anthropic";
  // 显式选了「不下发」就照办，不管什么格式
  if (dialect === "none") return "none";
  if (isAnthropic) {
    if (dialect === "anthropic-effort") return "anthropic-effort";
    // auto / 选了别的线的写法 / anthropic：都落到预算档
    return "anthropic";
  }
  if (
    dialect === "reasoning-effort" ||
    dialect === "thinking-object" ||
    dialect === "enable-thinking"
  )
    return dialect;
  // auto / 选了 anthropic 的写法：落到 reasoning_effort
  return "reasoning-effort";
}

/**
 * anthropic 预算档：档位（或自定义预算）折成 budget_tokens。
 *
 * Anthropic 硬性要求 budget_tokens < max_tokens，且最小 1024。
 * 两头顶住就返回 0，由调用方当作「这一轮不发思考参数」：
 * 输出上限只有 2K 的条目，开了思考也只会换来一条 400。
 */
function budgetTokens(
  level: Exclude<ThinkingLevel, "" | "off">,
  custom: number,
  maxOutput: number,
): number {
  const want = custom > 0 ? custom : ANTHROPIC_BUDGET[level];
  const ceiling = maxOutput - 1024;
  if (ceiling < 1024) return 0;
  return Math.min(Math.max(want, 1024), ceiling);
}

/** reasoningBridge 要执行的那一小段指令：哪个写法、什么强度 */
export interface BridgeThinking {
  dialect: OpenAIDialect;
  level: Exclude<ThinkingLevel, "">;
}

/**
 * 这一条模型该下发的思考参数，折成 AI SDK 的 providerOptions。
 *
 * 返回 null 表示「这一轮一个字都不发」——没设、明确关了、窗口太窄、写法是 none。
 * 形状按接口线分两路：anthropic 交给 AI SDK 的 anthropic provider 解析，
 * OpenAI 系只带一句指令，改写请求体是 reasoningBridge 的活。
 */
export function thinkingProviderOptions(
  format: WireFormat,
  dialect: ThinkingDialect,
  level: ThinkingLevel,
  budget: number,
  maxOutput: number,
): Record<string, JSONObject> | null {
  if (!level) return null;
  const d = effectiveDialect(format, dialect);
  if (d === "none") return null;

  if (d === "anthropic" || d === "anthropic-effort") {
    // 关思考两边同一句：新版 Claude 也认 thinking.disabled
    if (level === "off") return { anthropic: { thinking: { type: "disabled" } } };
    if (d === "anthropic-effort") return { anthropic: { effort: level } };
    const tokens = budgetTokens(level, toThinkingBudget(budget), maxOutput);
    if (!tokens) return null;
    return {
      anthropic: {
        thinking: { type: "enabled", budgetTokens: tokens },
      },
    };
  }

  return { [BRIDGE_KEY]: { dialect: d, level } };
}

/**
 * 从一次调用的 providerOptions 里认出桥该不该动手。
 *
 * 只认自己那一个键：anthropic 的 cacheControl、别家的参数都原样放着不碰。
 * 形状不对（手改过、跨版本）就当没配 —— 宁可少一段思考参数，不能把请求打挂。
 */
export function bridgeThinkingOf(
  providerOptions: unknown,
): BridgeThinking | null {
  if (!providerOptions || typeof providerOptions !== "object") return null;
  const raw = (providerOptions as Record<string, unknown>)[BRIDGE_KEY];
  if (!raw || typeof raw !== "object") return null;
  const { dialect, level } = raw as { dialect?: unknown; level?: unknown };
  if (
    dialect !== "reasoning-effort" &&
    dialect !== "thinking-object" &&
    dialect !== "enable-thinking"
  )
    return null;
  if (!level || level === "" || !THINKING_LEVELS.includes(level as ThinkingLevel))
    return null;
  return { dialect, level: level as Exclude<ThinkingLevel, ""> };
}

/**
 * 把思考参数写进已经序列化好的请求体（reasoningBridge 的 fetch 层调用）。
 *
 * 就地改：调用方刚 parse 出来的对象，改完再 stringify 回去。
 * 三个写法各自的一层皮都在这里，bridge 那边只管「有没有指令、是不是 responses 线」。
 */
export function injectThinking(
  body: Record<string, unknown>,
  isResponses: boolean,
  cfg: BridgeThinking,
): void {
  const { dialect, level } = cfg;
  if (dialect === "reasoning-effort") {
    const effort = OPENAI_EFFORT[level];
    if (isResponses) {
      // responses 线是嵌套的 reasoning.effort；别把已有的 reasoning 对象整个盖掉
      const prev =
        body.reasoning && typeof body.reasoning === "object"
          ? (body.reasoning as Record<string, unknown>)
          : {};
      body.reasoning = { ...prev, effort };
      return;
    }
    body.reasoning_effort = effort;
    return;
  }
  if (dialect === "thinking-object") {
    // DeepSeek / GLM / Kimi 的 OpenAI 兼容口：只认开关，不认档位
    body.thinking = { type: level === "off" ? "disabled" : "enabled" };
    return;
  }
  // enable_thinking：Qwen 一系；布尔，档位同样不参与
  body.enable_thinking = level !== "off";
}
