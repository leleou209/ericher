// recall：跨会话回忆当时的原话。memory 是提炼过的结论，recall 是翻回那一天的聊天记录；
// 结论省事，但他说「上次那个方案」时，要的往往是当时的上下文。

import { tool } from "ai";
import { z } from "zod";
import type { ToolCtx } from "./types";

/** 命中片段压成一行，太长就截断 —— 工具结果是给模型看的，不是给界面看的 */
function oneLine(text: string, max = 200): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max) + "…" : flat;
}

export function recallTools(ctx: ToolCtx) {
  return {
    recall: tool({
      description:
        "搜旧会话：去以前的会话里搜原话。当用户说「上次」「之前」「我们聊过的那个」" +
        "而当前这场里找不到时，先来这里搜，别顺着他的话编一个「上次」出来。\n" +
        "和 memory 的分工：memory 存的是我提炼过的结论，recall 找的是当时具体怎么说的。" +
        "query 用他提到的那个实词（比如「方案」「进度」「那个项目」），别把整句照抄进去。",
      inputSchema: z.object({
        query: z.string().describe("要搜的关键词，一到两个实词最好用"),
      }),
      execute: async (a) => {
        const q = (a.query || "").trim();
        if (!q) return "要搜什么？给我一个关键词。";

        const hits = await ctx.recall(q);
        if (!hits.length) return `没找到和「${q}」有关的旧对话。`;

        // 按会话归拢：先给「我们哪几次聊到过」，再给具体说了什么，模型才好说清出处
        const bySession = new Map<
          string,
          { title: string; date: string; lines: string[] }
        >();
        for (const h of hits) {
          const slot = bySession.get(h.sessionId) ?? {
            title: h.sessionTitle,
            date: h.lastActive.slice(0, 10),
            lines: [],
          };
          slot.lines.push(
            `    ${h.role === "user" ? "用户" : "我"}：${oneLine(h.message)}`,
          );
          bySession.set(h.sessionId, slot);
        }

        const blocks = [...bySession.values()].map(
          (s) => `【${s.title}】${s.date}\n${s.lines.join("\n")}`,
        );
        return (
          `搜到 ${bySession.size} 场相关会话：\n\n` +
          blocks.join("\n\n") +
          "\n\n（这些是当时的原话。引用时说清是哪一次聊的，别把旧结论直接套到现在。）"
        );
      },
    }),
  };
}
