// 自我认知、工具统计、会话整理、思考模式、来客口令。

import { tool } from "ai";
import { z } from "zod";
import type { ToolCtx } from "./types";

export function adminTools(ctx: ToolCtx) {
  return {
    self: tool({
      description:
        "自我的维护：reflect 会返回最近的对话、历史记录，和我现在这两块的内容供我反思；" +
        "想清楚后用 update 写入。两块分开：" +
        "target=core 是自我认知（我知道什么：关于用户、关于怎么把活干好、关于世界）；" +
        "target=demand 是我对我自己的要求（我要求自己成为什么样、怎么做）。" +
        "别把两者混着写：认知是越攒越厚的记录，要求是我主动立的标准 —— " +
        "把「我知道了什么」当成「我该怎么做」，成长就变成了流水账。",
      inputSchema: z.object({
        action: z.enum(["reflect", "update"]),
        target: z
          .enum(["core", "demand"])
          .default("core")
          .describe("update 改哪一块：core=自我认知，demand=我对我自己的要求"),
        content: z
          .string()
          .optional()
          .describe(
            "update 时的新内容，1000 字以内。demand 是「我要求自己……」那种口气，不是「用户喜欢……」",
          ),
      }),
      execute: async (a) => {
        if (a.action === "reflect") {
          // 读的是主屋那份（场屋本地那份不算数）—— 见 ToolCtx.readSelf
          const self = ctx.readSelf();
          const log = self.coreLog.slice(-5).join("\n") || "（空）";
          const demandLog = self.demandLog.slice(-5).join("\n") || "（空）";
          return (
            "以下是你最近的对话与历史记录。请基于这些内容反思并决定是否需要更新。\n\n" +
            "--- 最近对话 ---\n" +
            ctx.transcript(10) +
            "\n\n" +
            "--- 历史记录（自我认知） ---\n" +
            log +
            "\n\n" +
            "--- 我现在对自己的要求 ---\n" +
            (self.demand || "（还没写过）") +
            "\n\n" +
            "--- 历史记录（自我要求） ---\n" +
            demandLog +
            "\n\n" +
            "请反思：从这些对话里我学到了什么？关于用户、关于怎么把活干好、关于世界的认知要更新吗（target=core）？" +
            "有没有哪件事让我看清了自己该守什么、该往哪走，值得写下来（target=demand）？" +
            "要改哪一块，就调用 self 工具 action=update、带上对应的 target。"
          );
        }

        const now = new Date().toISOString().slice(0, 10);
        const content = (a.content || "").trim();

        if (a.target === "demand") {
          const ver = await ctx.writeSelfDemand(content);
          if (!content) return `自我要求已清除（${now}）`;
          ctx.notify("自我要求已更新");
          return `自我要求已更新 v${ver}（${now}）`;
        }

        const ver = await ctx.writeSelfCore(content);
        if (!content) return `内核已清除（${now}）`;
        ctx.notify("自我认知已更新");
        return `内核已更新 v${ver}（${now}）`;
      },
    }),

    stats: tool({
      description: "查看各工具的使用次数、成功率与平均耗时。",
      inputSchema: z.object({}),
      execute: async () => {
        const entries = Object.values(ctx.state.toolStats).sort(
          (a, b) => b.count - a.count,
        );
        if (!entries.length) return "暂无统计数据。";
        return (
          "📊 工具统计：\n" +
          entries
            .map(
              (s) =>
                `• ${s.tool}: ${s.count} 次 | ✅${s.ok} ❌${s.fail} | 均 ${Math.round(s.totalMs / s.count)}ms`,
            )
            .join("\n")
        );
      },
    }),

    organize: tool({
      description:
        "整理对话历史：把较早的消息压缩成摘要，并从中萃取出值得长期记住的洞察写入记忆库。" +
        "对话很长、或用户要求「整理一下」时调用。",
      inputSchema: z.object({}),
      execute: async () => ctx.organize(),
    }),

    set_think_mode: tool({
      description:
        "切换思考模式。deep 会启用更长的链式推理，适合复杂决策；normal 是日常模式。",
      inputSchema: z.object({
        mode: z.enum(["normal", "deep"]),
      }),
      execute: async ({ mode }) => {
        ctx.patchState({ thinkMode: mode });
        ctx.notify(mode === "deep" ? "🧠 深度思考模式已开启" : "💨 普通模式");
        return mode === "deep"
          ? "已切换到深度思考模式。"
          : "已切换到普通模式。";
      },
    }),
  };
}
