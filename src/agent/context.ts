// 上下文窗口管理：把一场对话的「很久以前」压成一段摘要，只把近处原样发给模型。
//
// 为什么必须做：会话是只增不减的，每轮都把整场历史重发一遍，token 会随时间线性涨，
// 到最后不是变贵变慢，而是直接撞上下文上限、整场对话说不了话。
//
// 两条自我约束：
// 1) 切点只能落在「用户发言」之前。工具调用和它的结果被切开，模型会看到一堆
//    无来由的 tool result —— 与其让它困惑，不如少压几条。
// 2) 摘要覆盖到哪里，记的是「最后一条被压掉的消息 id」而不是条数。
//    id 找不到（那条被清了）就退回「保留最近 N 条」，宁可重复摘要，不可错位。

import type { ModelMessage, UIMessage } from "ai";

/** 最近多少条原样保留。够模型接住当下的话题，又不至于让窗口失控。 */
export const KEEP_RECENT = 16;

/** 攒够多少条才值得花一次模型调用去压缩。太少就等下一轮，别为一句话付费。 */
export const COMPACT_TRIGGER = 8;

/** 摘要长度上限。它是「提个醒」用的，不是第二份对话记录。 */
export const DIGEST_MAX = 900;

interface ContextPlan {
  /** 这轮真正发给模型的消息（压掉的部分不含在内） */
  tail: UIMessage[];
  /** 不压缩时该发的消息（摘要已覆盖的部分仍然不含在内）——摘要生成失败时回退到它 */
  keepAll: UIMessage[];
  /** 这轮新折进摘要的消息；空数组表示这轮不压缩 */
  compacted: UIMessage[];
  /** 压缩后摘要覆盖到的最后一条消息 id（没压缩时原样返回入参） */
  upto: string;
}

/** 摘要覆盖到哪：按 id 找。找不到（消息被清过）就当作没覆盖，从头算。 */
function coveredCount(messages: UIMessage[], upto: string): number {
  if (!upto) return 0;
  const i = messages.findIndex((m) => m.id === upto);
  return i < 0 ? 0 : i + 1;
}

/** 从 from 起的第一条用户发言。返回 n 表示「后面没有用户发言了」。 */
function nextUserAt(messages: UIMessage[], from: number): number {
  for (let i = from; i < messages.length; i++) {
    if (messages[i].role === "user") return i;
  }
  return messages.length;
}

/**
 * 决定这轮发什么。
 * 返回的 tail 一定是原样消息；被折进摘要的部分由调用方去生成新摘要。
 */
export function planContext(messages: UIMessage[], upto: string): ContextPlan {
  const n = messages.length;
  // 至少留两条原样，否则模型会拿到一个「没有任何发言」的空上下文
  const covered = Math.min(coveredCount(messages, upto), Math.max(0, n - 2));
  const keepAll = messages.slice(covered);

  if (n <= KEEP_RECENT) return { tail: keepAll, keepAll, compacted: [], upto };

  const boundary = nextUserAt(messages, n - KEEP_RECENT);
  // 切不出干净的边界（后面全是工具往返）：这轮不压，保持现状
  if (boundary >= n) return { tail: keepAll, keepAll, compacted: [], upto };

  const candidate = messages.slice(covered, boundary);
  if (candidate.length < COMPACT_TRIGGER)
    return { tail: keepAll, keepAll, compacted: [], upto };
  return {
    tail: messages.slice(boundary),
    keepAll,
    compacted: candidate,
    upto: messages[boundary - 1].id,
  };
}

/**
 * 生成新摘要：老摘要 + 这一批要折进去的对话 → 一段更长的老摘要。
 * 提示词要的是「以后还用得上的东西」，不是复述——复述等于没压。
 */
export function digestPrompt(
  prev: string,
  transcript: string,
): { system: string; user: string } {
  return {
    system:
      "你在帮一个接待台助手整理它和用户的对话记忆。" +
      "下面给你的是「已经压过一轮的旧摘要」和「又过去的一段对话」，把它们合成一段新的旧摘要。" +
      "只保留以后还用得上的：做过什么决定、定过什么规矩、聊到过哪些人和事、情绪和态度的变化、" +
      "以及还没了结的事。不要复述对话过程，不要写「用户说」「AI 回答」，不要分点成清单，" +
      "用第一人称连续写成一段话，控制在 400 字以内。只输出这段摘要本身。",
    user:
      (prev ? "【已有旧摘要】\n" + prev + "\n\n" : "") +
      "【新过去的对话】\n" +
      transcript,
  };
}

/** 摘要进系统提示词时的措辞。要点：让它知道这是自己压的、细节别当原文用。 */
export function digestBlock(digest: string): string {
  if (!digest.trim()) return "";
  return (
    "\n\n## 这场对话更早的部分（我自己压缩过的）\n" +
    digest.trim() +
    "\n这是我自己压出来的提要，不是原话。要引原话、要较真细节，就用 recall 去翻原文。"
  );
}

// ── 提示词缓存 ─────────────────────────────────────────────
//
// 缓存命中只有一个决定因素：前缀逐字节一致。断点本身不产生命中，
// 它只决定「缓存写到哪」。所以命中率的大头在序列怎么排（稳定段在前、
// 动态段压尾、历史 append-only），断点只是把这份秩序记进账本。

/** Anthropic 语义的缓存断点标记。别家厂商不认 anthropic 这个键，原样忽略 */
export const CACHE_PROVIDER_OPTIONS = {
  anthropic: { cacheControl: { type: "ephemeral" } },
} as const;

/**
 * 给最后一条消息打缓存断点（Anthropic 语义；别家不该调它）。
 *
 * 为什么打在最后一条：历史是 append-only 的，这一轮的「最后一条」到了下一轮
 * 就躺在历史里 —— 上一轮写下的缓存前缀这一轮原样出现，模型只需读新长出来的
 * 一小段。每轮一次缓存写入，换长会话里绝大部分输入按缓存价计。
 *
 * 字符串内容没有可挂 providerOptions 的部件，包成单条文本部件再挂：
 * 建模方对两种形状的归一结果相同，不改变发出去的请求体。
 */
export function markCacheBreakpoint(messages: ModelMessage[]): ModelMessage[] {
  const last = messages[messages.length - 1];
  if (!last) return messages;
  const parts = (
    Array.isArray(last.content)
      ? [...last.content]
      : [{ type: "text" as const, text: last.content }]
  ) as Array<Record<string, unknown>>;
  if (!parts.length) return messages;
  parts[parts.length - 1] = {
    ...parts[parts.length - 1],
    providerOptions: CACHE_PROVIDER_OPTIONS,
  };
  const out = [...messages];
  out[out.length - 1] = {
    ...last,
    content: parts,
  } as ModelMessage;
  return out;
}
