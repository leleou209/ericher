// ask：把「只有他能定」的问题变成可回答的对象；答了下一轮接上，不答也能自己拿主意。
// 回答/先不答/超时都 resolve 成工具结果，模型在同一轮继续；没有挂起点时退回让模型停笔等下一轮。

import { tool } from "ai";
import { z } from "zod";
import type { AskEntry } from "../agent/state";
import type { ToolCtx } from "./types";

/**
 * 同一场对话里最多摆几个没答的问题。
 *
 * 为什么要有这条上限：她要是连着几轮都在问，卡片会一层层叠在输入框上面，
 * 看着像一墙便签，人反而一个都不想答了。到了这个数就让她先自己拿主意，
 * 或者把新问题并进已有的那条里 —— 那也比再叠一张强。
 */
const PENDING_CAP = 3;

export function askTools(ctx: ToolCtx) {
  return {
    ask: tool({
      description:
        "遇到一个只有他能定的地方时，回头问他一句。问题会变成一张卡片摆在他眼前，他可以点你给的选项，也可以自己写。" +
        "用它的时机：你正往下做，但这一步的走向取决于他的偏好或事实，猜错了要白做一遍。" +
        "两件事必须做到：① 同一轮的回复正文里把这个问题说出来 —— 卡片只是入口，只留一张卡不写字，读起来像话说到一半突然卡住；" +
        "② 问完就等：他的回答会作为这次调用的结果直接回来，你带着答案接着往下做 —— 不需要停下来等下一轮。" +
        "已经问过、他还没答的，别重复再问一遍。",
      inputSchema: z.object({
        question: z
          .string()
          .describe(
            "要问他的那句话，写成一个具体的问题，别写成「请确认以下事项」",
          ),
        options: z
          .array(z.string())
          .optional()
          .describe(
            "可选项：只在你估计他多半会从这几条里挑时给。给了选项他仍然可以自己写",
          ),
        why: z
          .string()
          .optional()
          .describe(
            "你为什么问 —— 这个答案会被拿去做哪一步，让他知道这不是随口一问",
          ),
      }),
      execute: async (a) => {
        const text = (a.question || "").trim();
        if (!text) return "问题不能为空 —— 说清楚你想问什么。";

        const sessionId = ctx.state.activeSession;
        const pending = ctx.state.asks.filter((x) => x.sessionId === sessionId);
        // 已经问过一样的就别再问一遍：那不是催，是噪音
        if (pending.some((x) => x.text === text))
          return `这个问题已经摆在他面前了：「${text}」。等他答。`;

        if (pending.length >= PENDING_CAP) {
          return (
            `这场对话里已经压着 ${pending.length} 个没答的问题（${pending.map((x) => `「${x.text}」`).join("")}）。` +
            "先别再叠了：口味和做法类的偏好可以自己挑一个合理的往下走，做完把选择告诉他；" +
            "事实类和要他授权的（只有他知道、只有他能定）不能代答——把新问题并进已有的那条里，等他。"
          );
        }

        const options = (a.options || [])
          .map((o) => o.trim())
          .filter(Boolean)
          .slice(0, 6);
        const entry: AskEntry = {
          id: crypto.randomUUID(),
          text,
          options,
          why: (a.why || "").trim(),
          askedAt: new Date().toISOString(),
          sessionId,
        };
        ctx.patchState({ asks: [...ctx.state.asks, entry] });
        const asked = `问到了：「${text}」${options.length ? `（给了 ${options.length} 个选项）` : ""}。`;
        // 挂起等他作答：回答/先不答/超时都会 resolve 成一段话 —— 它就是这次
        // 工具调用的结果，模型在同一轮工作流里接着跑，答案不再是条新消息。
        // ctx 没配挂起点（后台专用的场景）才退回老路：让模型自己停笔等下一轮。
        if (!ctx.waitForAsk) return `${asked}现在停下，等他答。`;
        const answer = await new Promise<string>((resolve) => {
          ctx.waitForAsk!(entry.id, resolve);
        });
        return `${asked}${answer}`;
      },
    }),
  };
}
