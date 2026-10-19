// 会话记录：一场对话里回头看过的那几次分别记了什么。
// 与 memory 的分工：memory 记关于世界的事实（何时学到、是否还算数）；这里记怎么聊的（哪一场、什么语气）；
// 检索、展示、生命周期都不同，不合并。

import { tool } from "ai";
import { z } from "zod";
import { getMemoryByDedupeKey, insertMemory } from "../agent/memory";
import { normalizeSentiment, SENTIMENTS } from "../agent/state";
import type { ToolCtx } from "./types";

/** 意图段的分隔标记。前端靠它把「怎么聊的」和「聊了什么」分开摆。 */
export const INTENT_MARK = "【这段怎么聊的】";

export function sessionMemoTools(ctx: ToolCtx) {
  return {
    session_memo: tool({
      description:
        "记下这一段对话：聊了什么、双方大致是什么意图、这一段是什么语气。" +
        "只在「没人说话时自己回头看」的时候用，不是聊天工具 —— " +
        "用户正在说话的时候不要调它。一段话调一次。",
      inputSchema: z.object({
        content: z
          .string()
          .describe("这一段聊了什么。第一人称，像自己给自己写的提要"),
        intent: z
          .string()
          .optional()
          .describe("双方大致意图，例：他问X；我说了Y，范围到Z。想不出就留空"),
        sentiment: z.enum(SENTIMENTS).describe("这一段说话的语气"),
      }),
      execute: async (input) => {
        const sentiment = normalizeSentiment(input.sentiment);
        const body = [
          input.content.trim(),
          input.intent?.trim() ? `${INTENT_MARK}${input.intent.trim()}` : "",
        ]
          .filter(Boolean)
          .join("\n\n");
        if (!body) return "没写内容，这条不记。";

        // 回想重跑的幂等保护：同键已落库就整段跳过，别拿这次的新说法喂向量
        const dedupeKey = ctx.recapDedupe
          ? `${ctx.recapDedupe}:recap`
          : undefined;
        if (dedupeKey && getMemoryByDedupeKey(ctx.sql, dedupeKey))
          return "这一段已经记过了（重跑的幂等保护），不重复入库。";

        const entry = insertMemory(ctx.sql, {
          type: "recap",
          shelf: "sessions",
          content: body,
          sentiment,
          tags: sentiment ? [sentiment] : [],
          // 挂到被回想的那一场上；没有那时（正常对话里被误调）就落到当前这一场
          sessionId: ctx.recapSessionId || ctx.state.activeSession,
          dedupeKey,
        });
        ctx.enqueueVector({
          id: entry.id,
          content: entry.content,
          type: entry.type,
          shelf: entry.shelf,
          tags: entry.tags,
        });
        return `记下了（${sentiment || "无标签"}）：${input.content.slice(0, 60)}…`;
      },
    }),
  };
}
