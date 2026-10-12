// 本场计划：这一场的目标与步骤。会话内的，不是会话外的。
//
// 三层分工，别混：
//   一、reminders（reminderStore.ts）—— 有时间的：到点回来找你
//   二、state.tasks（tools/task.ts） —— 没时间、跨会话的：全局待办
//   三、这里                        —— 没时间、只属于这一场的：本场目标 + 本场步骤
// 口径沿用 reminderStore 顶上那句：task 是「要做什么」，remind 是「什么时候想起它」。
// 本场计划里的事同样要做，但它不排队、不定点，只是钉在眼前这一场里，
// 让这场聊着聊着不至于跑毛。要「到点提醒」一律走 remind。

import { tool } from "ai";
import { z } from "zod";
import {
  SESSION_TASK_CAP,
  getSessionGoal,
  listSessionTasks,
  saveSessionTasks,
  setSessionGoal,
  type SessionTask,
} from "../agent/sessionStore";
import type { ToolCtx } from "./types";

const ICONS: Record<string, string> = { todo: "📋", doing: "🔄", done: "✅" };

/**
 * 计划改了：递增计数。
 * 内容在会话表里，state 里只留这个信号 —— 前端看它变了就重拉一次。
 */
function bumpRev(ctx: ToolCtx): void {
  ctx.patchState({ planRev: (ctx.state.planRev ?? 0) + 1 });
}

/** 现状的一句话视图，也是每个动作的返回值主体 */
function render(goal: string, tasks: SessionTask[]): string {
  const lines = [`🎯 本场目标：${goal || "（还没定）"}`];
  if (!tasks.length) {
    lines.push("本场步骤：还没排。");
    return lines.join("\n");
  }
  lines.push(`本场步骤（${tasks.length}/${SESSION_TASK_CAP}）：`);
  tasks.forEach((t, i) => {
    lines.push(
      `  [${i}] ${ICONS[t.status]} ${t.title}${t.desc ? ` —— ${t.desc}` : ""}`,
    );
  });
  return lines.join("\n");
}

export function planTools(ctx: ToolCtx) {
  return {
    plan: tool({
      description:
        "本场计划：这一场对话的目标与步骤。只属于当前这一场，不设时间、不定点——" +
        "要「到点提醒」用 remind，跨会话的全局待办用 task。" +
        "show 看现状；set_goal 写或改本场目标（空串 = 清除）；add 加一步；" +
        "update 改某一步的状态（索引从 0 开始，先 show 看）；delete 删一步。",
      inputSchema: z
        .object({
          action: z.enum(["show", "set_goal", "add", "update", "delete"]),
          goal: z
            .string()
            .optional()
            .describe("set_goal 时的目标，一段话；空串 = 清除目标"),
          title: z.string().optional().describe("add 时的步骤标题"),
          desc: z.string().optional().describe("add 时的补充说明"),
          index: z
            .number()
            .int()
            .min(0)
            .optional()
            .describe("update / delete 时的步骤索引"),
          status: z
            .enum(["todo", "doing", "done"])
            .optional()
            .describe("update 时的新状态"),
        })
        .superRefine((a, refine) => {
          // 条件必填在 schema 层就拦下，别让缺参数的调用混进统计
          if (a.action === "set_goal" && a.goal == null)
            refine.addIssue({
              code: "custom",
              path: ["goal"],
              message: "set_goal 必填：goal（想清除就传空串）",
            });
          if (a.action === "add" && !(a.title || "").trim())
            refine.addIssue({
              code: "custom",
              path: ["title"],
              message: "add 必填：步骤标题",
            });
          if (
            (a.action === "update" || a.action === "delete") &&
            a.index == null
          )
            refine.addIssue({
              code: "custom",
              path: ["index"],
              message: "update/delete 必填：步骤索引（先 show 看，从 0 开始）",
            });
          if (a.action === "update" && !a.status)
            refine.addIssue({
              code: "custom",
              path: ["status"],
              message: "update 必填：新状态（todo/doing/done）",
            });
        }),
      execute: async (a) => {
        const sid = ctx.sessionId;
        // 场外跑的活（回想、夜间维护）没有「正在聊的这一场」，也就没有本场
        if (!sid) return "现在不在任何一场对话里，本场计划无从谈起。";

        const goal = getSessionGoal(ctx.sql, sid);
        const tasks = listSessionTasks(ctx.sql, sid);

        if (a.action === "show") return render(goal, tasks);

        if (a.action === "set_goal") {
          setSessionGoal(ctx.sql, sid, a.goal || "");
          bumpRev(ctx);
          // 读回来再报：截断在写入那层做，这里报的必须是真落下去的那份
          const saved = getSessionGoal(ctx.sql, sid);
          return saved ? `🎯 本场目标已记下：${saved}` : "🎯 本场目标已清除。";
        }

        if (a.action === "add") {
          const title = (a.title || "").trim();
          if (!title) return "add 需要提供 title。";
          if (tasks.length >= SESSION_TASK_CAP)
            return `本场步骤已满 ${SESSION_TASK_CAP} 条，先做完或删掉几步再排。`;
          tasks.push({
            title,
            desc: (a.desc || "").trim(),
            status: "todo",
            created: new Date().toISOString().slice(0, 10),
          });
          saveSessionTasks(ctx.sql, sid, tasks);
          bumpRev(ctx);
          return `已排第 ${tasks.length} 步：[${tasks.length - 1}] 📋 ${title}\n${render(goal, tasks)}`;
        }

        if (a.index == null || a.index >= tasks.length)
          return `索引无效，本场步骤共 ${tasks.length} 条（0-${Math.max(0, tasks.length - 1)}）。`;

        if (a.action === "update") {
          if (!a.status) return "update 需要提供 status。";
          tasks[a.index] = { ...tasks[a.index], status: a.status };
          saveSessionTasks(ctx.sql, sid, tasks);
          bumpRev(ctx);
          return `[${a.index}] ${tasks[a.index].title} → ${a.status}\n${render(goal, tasks)}`;
        }

        const [removed] = tasks.splice(a.index, 1);
        saveSessionTasks(ctx.sql, sid, tasks);
        bumpRev(ctx);
        return `已删掉第 ${a.index} 步：${removed.title}\n${render(goal, tasks)}`;
      },
    }),
  };
}
