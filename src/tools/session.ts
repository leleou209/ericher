// session：另开一场把事说清楚（整理稿、办完的回复、结论），以后翻得到。
// 与 remind 的分工：remind 到点回到原场提一句，这里另开一场；定时那一支借提醒调度。

import { tool } from "ai";
import { z } from "zod";
import type { ToolCtx } from "./types";
import { nowInShanghai } from "./remind";

export function sessionTools(ctx: ToolCtx) {
  return {
    openSession: tool({
      description:
        "另开一场会话，把一件事单独说清楚，而不是塞进现在这一场的正文里。" +
        "用它的时机：这件事跟眼前聊的话题不是一条线（他现在多半没空看，得空才看得进去），" +
        "或者值得留在侧栏里、以后还翻得到（一份整理好的结果、一个结论、一件他交代给你、你办完了要回话的事）。\n" +
        "别为每句话都开一场 —— 会话列表会被塞满，他反而找不到真正在聊的那几场。" +
        "没想清楚值不值得单开一场时，就照常在正文里说。\n" +
        `现在是北京时间 ${nowInShanghai()}。\n` +
        "不填 at 就是现在开，他会看到侧栏里多出一行在闪；填了 at（绝对时间，带时区偏移）" +
        "就是到点再开，在那之前这场不存在。\n" +
        "⚠️ 定时那场到点说的是这件事的提要（一段话），不是原样投递完整正文 —— " +
        "成稿要一字不差地到的，先把它写进笔记存好，到点那场里说「笔记《xx》写好了」，别把定时投递当快递。",
      inputSchema: z.object({
        title: z
          .string()
          .describe(
            "这场对话的名字，写在侧栏里给他看的。十个字以内，他扫一眼就知道你为什么开这场",
          ),
        content: z
          .string()
          .describe(
            "要说的那件事的正文。第一人称，可以写得完整、具体 —— 这场的开头就是你这段话",
          ),
        at: z
          .string()
          .optional()
          .describe(
            "到点再开才填：绝对时刻，ISO 8601 带时区（例如 2026-09-20T09:00:00+08:00）。现在就开就留空",
          ),
        every: z
          .string()
          .optional()
          .describe(
            "只跟 at 一起用：重复的 cron 表达式（如 0 9 * * *）。留空表示只说这一次",
          ),
      }),
      execute: async (a) => {
        const title = (a.title || "").trim();
        const content = (a.content || "").trim();
        const at = (a.at || "").trim();
        const every = (a.every || "").trim();
        if (!title) return "得给这场起个名字：title 不能空。";
        if (!content) return "要说的事不能空：content 里写你打算跟他说什么。";

        if (!at) {
          try {
            const s = await ctx.openSession({ content, title });
            return `开好了：「${s.title}」。他现在能在侧栏里看到这一场（会先闪一下），得空进去就看见你说的了。`;
          } catch (e) {
            return `这场没能开起来：${(e as Error).message}`;
          }
        }

        try {
          await ctx.scheduleReminder({
            what: content,
            at,
            every,
            urgent: false,
            mode: "new",
            title,
          });
          const when = every ? `${at} 起每 ${every}` : at;
          return (
            `记下了：${when} 我会新开一场「${title}」跟你说这件事。` +
            `到点说的是这件事的提要；要是完整成稿才作数的，现在先把全文存进笔记，` +
            `到点那场里说「笔记《${title}》写好了」让他自己打开看。`
          );
        } catch (e) {
          return `没能定下来：${(e as Error).message}`;
        }
      },
    }),
  };
}
