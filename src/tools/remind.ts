// remind：到点主动回来找你。task 是「要做什么」，remind 是「什么时候想起它」。
// 工具只收绝对时间；description 必须带当前北京时间作参照。

import { tool } from "ai";
import { z } from "zod";
import {
  beijingHour,
  QUIET_END_HOUR,
  QUIET_START_HOUR,
} from "../agent/speakGate";
import type { ToolCtx } from "./types";

/** 北京时间的一句话时间戳，给模型做换算参照（Worker 跑在 UTC，必须显式转） */
export function nowInShanghai(): string {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "long",
    hour12: false,
  }).format(new Date());
}

export function remindTools(ctx: ToolCtx) {
  return {
    remind: tool({
      description:
        "提醒管理。set 定一条「到点我来找你」；list 看还没触发的；cancel 取消一条。" +
        "这让我能主动开口，而不只是等你问我。\n" +
        `现在是北京时间 ${nowInShanghai()}。\n` +
        "at 必须是绝对时间，带时区偏移（例如 2026-09-20T09:00:00+08:00）。" +
        "「明天早上」「两小时后」这类说法你要自己先换算成绝对时刻再传进来。" +
        "只提醒一次就只给 at；要重复就给 every。\n" +
        "every 推荐用人话格式：「每天 09:00」「每周三 21:30」（北京时间，代码会换算成正确的调度时刻）。" +
        "也可以给 cron 表达式，但 cron 按 UTC 解释——「0 9 * * *」是北京时间 17 点，不是早上九点，" +
        "所以固定时刻的重复提醒别自己写 cron。\n" +
        "注意：晚上 23 点到早上 8 点是我的安静时段，那段时间里的一次性提醒我会压到早上八点再说，" +
        "不会丢掉，只是不吵醒他。重复提醒不受影响 —— 那个时刻是他自己排的作息，我照办。" +
        "只有他明说「必须叫醒我」（比如凌晨要吃的药、三点开抢的票）才把 urgent 设成 true；" +
        "拿不准就别设，重要的事放到早上说通常也来得及。",
      inputSchema: z
        .object({
          action: z.enum(["set", "list", "cancel"]),
          what: z
            .string()
            .optional()
            .describe("set 必填：到点要提醒的事，一句自然语言"),
          at: z
            .string()
            .optional()
            .describe("set 必填：首次触发时刻，ISO 8601 带时区"),
          every: z
            .string()
            .optional()
            .describe(
              "重复提醒的排期；留空表示只提醒一次。用「每天 09:00」「每周三 21:30」这种北京时间人话格式（推荐），cron 表达式按 UTC 解释",
            ),
          urgent: z
            .boolean()
            .optional()
            .describe(
              "set 可选：他明确说了「必须叫醒我」才传 true，否则留空。只对一次性提醒有意义",
            ),
          id: z
            .string()
            .optional()
            .describe("cancel 时的提醒 id（先用 list 看）"),
        })
        .superRefine((a, refine) => {
          // action 的条件必填在 schema 层就拦下：缺参数到执行层才报错，
          // 会被统计记成一次成功的使用，模型也白花一步
          if (a.action === "set") {
            if (!a.what?.trim())
              refine.addIssue({
                code: "custom",
                path: ["what"],
                message: "set 必填：到点要提醒的事，一句自然语言",
              });
            if (!a.at?.trim())
              refine.addIssue({
                code: "custom",
                path: ["at"],
                message: "set 必填：首次触发时刻（ISO 8601 带时区）",
              });
          }
          if (a.action === "cancel" && !a.id?.trim())
            refine.addIssue({
              code: "custom",
              path: ["id"],
              message: "cancel 必填：提醒 id（先用 list 看）",
            });
        }),
      execute: async (a) => {
        if (a.action === "list") {
          const rows = ctx.listReminders();
          if (!rows.length) return "还没有待触发的提醒。";
          return rows
            .map((r) => {
              const when = r.every ? `${r.at} 起，每 ${r.every}` : r.at;
              const last = r.firedAt ? `\n    上次触发：${r.firedAt}` : "";
              return `${r.id}｜${when}${r.urgent ? "｜必须叫醒" : ""}\n    ${r.what}${last}`;
            })
            .join("\n");
        }

        if (a.action === "cancel") {
          if (!a.id) return "cancel 需要提供 id，先用 list 看有哪些。";
          return ctx.cancelReminder(a.id)
            ? `已取消提醒 ${a.id}`
            : `没找到待触发的提醒：${a.id}`;
        }

        const what = (a.what || "").trim();
        const at = (a.at || "").trim();
        if (!what) return "set 需要提供 what：到点要提醒你什么。";
        if (!at) return "set 需要提供 at：什么时候提醒，绝对时间带时区。";
        // 不带偏移的写法会被按 UTC 解释（Worker 的本地时区就是 UTC）：
        // 北京人定「明天九点」写 09:00 会被存成 09:00Z，17 点才响，而回话照样说「定好了」
        if (!/(?:Z|[+-]\d{2}:?\d{2})$/.test(at))
          return `at 得带上时区偏移，比如 2026-09-20T09:00:00+08:00 —— 只写「${at}」会被按 UTC 算，差 8 小时。`;

        try {
          const r = await ctx.scheduleReminder({
            what,
            at,
            every: (a.every || "").trim(),
            urgent: !!a.urgent,
          });
          const when = r.every ? `${r.at} 起每 ${r.every}` : r.at;
          // 撞上安静时段要说清楚，免得他以为我定错了时间
          const held = !r.every && !r.urgent && quietHint(at);
          return `定好了：${when} 我会来找你 —— ${what}${held}`;
        } catch (e) {
          return `没能定下这条提醒：${(e as Error).message}`;
        }
      },
    }),
  };
}

/**
 * 这个时刻落在安静时段里吗？是的话补一句说明。
 * 工具层只负责「说清楚」，真正的推迟在 fireReminder 里做 ——
 * 定的时候算一次和响的时候算一次，中间可能跨了天，不能只算一次。
 */
function quietHint(at: string): string {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return "";
  const h = beijingHour(d);
  return h >= QUIET_START_HOUR || h < QUIET_END_HOUR
    ? `（这个点我在安静时段，会压到早上 ${QUIET_END_HOUR} 点再说）`
    : "";
}
