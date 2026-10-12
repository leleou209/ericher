// 反馈：用户对 ericher 回答的赞 / 踩 / 评论。
//
// 评论是「会话的补充上下文」——界面上只显示条数徽标，正文不进上下文，
// 只有这里主动 read 才读得到。

import { tool } from "ai";
import { z } from "zod";
import {
  addComment,
  AI_AUTHOR,
  commentCounts,
  ensureFeedbackSchema,
  listComments,
  voteTotals,
} from "../agent/feedback";
import type { ToolCtx } from "./types";

export function feedbackTools(ctx: ToolCtx) {
  return {
    feedback: tool({
      description:
        "看用户对我回答的反馈。signal 看赞踩汇总（哪些回答被赞、哪些被踩）；" +
        "read 读某条消息下的评论正文（不给 messageId 就列出哪些消息有评论）；" +
        "comment 我在某条消息的评论区补一句（解释、认错、补充），评论用户在界面上看得到。" +
        "messageId 从 signal / read 的结果里拿。",
      inputSchema: z.object({
        action: z.enum(["signal", "read", "comment"]),
        messageId: z.string().optional().describe("read / comment 时的消息 id"),
        content: z
          .string()
          .optional()
          .describe("comment 时的评论正文，一两句说清"),
      }),
      execute: async (a) => {
        const { sql } = ctx;
        // 老实例可能还没建过反馈表，防御性补一次
        ensureFeedbackSchema(sql);

        if (a.action === "signal") {
          const totals = voteTotals(sql);
          if (!totals.length) return "还没有任何赞踩。";
          const text = new Map(ctx.recentMessages(60).map((m) => [m.id, m]));
          return (
            "👍👎 赞踩汇总：\n" +
            totals
              .map((t) => {
                const marks = [
                  t.up ? `👍${t.up}` : "",
                  t.down ? `👎${t.down}` : "",
                ]
                  .filter(Boolean)
                  .join(" ");
                const m = text.get(t.messageId);
                const who = m
                  ? m.role === "user"
                    ? "用户"
                    : "我"
                  : "（已不在最近上下文里）";
                return `• [${t.messageId}] ${marks} ${who}${m ? "：" + m.text : ""}`;
              })
              .join("\n")
          );
        }

        if (a.action === "read") {
          if (!a.messageId) {
            // 只列当前这一场里的消息：主屋那张表收着各场的评论，
            // 不过滤就会把别场的评论摆到他眼前（串场）。
            const recent = new Set(ctx.recentMessages(60).map((m) => m.id));
            const counts = commentCounts(sql).filter((c) =>
              recent.has(c.messageId),
            );
            if (!counts.length) return "还没有任何评论。";
            return (
              "💬 有评论的消息：\n" +
              counts.map((c) => `• [${c.messageId}] ${c.n} 条`).join("\n")
            );
          }
          const list = listComments(sql, a.messageId);
          if (!list.length) return `[${a.messageId}] 还没有评论。`;
          return (
            `💬 [${a.messageId}] 的 ${list.length} 条评论：\n` +
            list
              .map(
                (c) =>
                  `• ${c.author === AI_AUTHOR ? "我" : "用户"}：${c.content}`,
              )
              .join("\n")
          );
        }

        // comment
        const content = (a.content || "").trim();
        if (!a.messageId || !content)
          return "comment 需要同时提供 messageId 和 content。";
        const row = addComment(sql, a.messageId, AI_AUTHOR, content);
        ctx.notify("ericher 在评论区回了一句");
        return `已在 [${row.messageId}] 的评论区留言：${row.content}`;
      },
    }),
  };
}
