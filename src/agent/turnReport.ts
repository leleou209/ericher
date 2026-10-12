// 异常中断的死因判定。
//
// 一轮回答没跑完，原因是好几种：上游把请求拒了（流级 onError）、被叫停
// （abortSignal）、或者输出顶到上限被截断（finishReason === "length"）。
// 这三种以前都只写进 console，界面上只留一个「结果没回来」或者干脆静默 ——
// 用的人和排障的人都看不出发生了什么。
//
// 这里把「原始信号」翻译成两句能直接摆上界面的话：title 说是什么事，
// detail 说怎么办；raw 是给开发者的原始死因（status/url/body），
// 折叠起来，管理员想看才展开。
//
// 之所以做成纯函数：判定规则多、边界细，抽出来才测得动。

import type { TurnError } from "./state";

/** 一轮里攒下的原始死因。三个采集点各写一部分（见 cowork.ts）。 */
export interface TurnCapture {
  kind: "stream-error" | "aborted" | "output-limit";
  /** 流级错误的字段（Error 上能捞到的那几个） */
  name?: string;
  message?: string;
  statusCode?: number;
  url?: string;
  body?: string;
  /** 被叫停时 abortSignal 带的 reason */
  abortReason?: string;
}

/** 死因的人话版本（不含 messageId/sessionId/at，那三样由调用方补） */
export type TurnDescription = Pick<
  TurnError,
  "reason" | "title" | "detail" | "raw"
>;

/** raw 里原始返回体最多留这么长，够定位是哪个字段被拒就行 */
const RAW_CAP = 800;

/**
 * 判定这一轮该不该报、报什么。全正常（completed 且没截断）返回 null ——
 * 没有异常就不该在对话里多一块东西。
 */
export function describeTurn(input: {
  status: string;
  finishReason?: string;
  capture?: TurnCapture | null;
}): TurnDescription | null {
  const { status, finishReason } = input;
  const capture = input.capture ?? null;

  // 输出被截断：这一轮的 status 仍是 completed，只有 finishReason 认得出。
  // 这是最会骗人的一种 —— 界面看着「答完了」，实际话说到一半就没了
  if (finishReason === "length" || capture?.kind === "output-limit") {
    return {
      reason: "output-limit",
      title: "输出达到上限，话被截断了",
      detail:
        "答到一半就停住，多半是这家模型的输出上限偏低 —— 兼容层对没认出来的第三方模型名会兜底限到 4096 token。" +
        "去「模型配置」把这条条目的 maxOutput 调高，或让我分几次说。",
    };
  }

  // 被叫停：手动按停、换场、断线重连都会走到这里，信号里分不出是谁按的，
  // 所以两种都如实说，不猜
  if (status === "aborted" || capture?.kind === "aborted") {
    const why = capture?.abortReason || "";
    return {
      reason: "aborted",
      title: "这一轮没跑完就被停下来了",
      detail:
        "可能是你按了停止（或 Esc），也可能是换场/断线把它叫停了。" +
        "已经说出口的部分我留着 —— 那是说过的话；没跑完的工具调用也没在历史里留下半截。" +
        "想要完整答案就再问一次。",
      raw: why ? `abortReason: ${why}` : undefined,
    };
  }

  // 流级死亡：上游断流 / 请求被拒 / 桥层异常
  if (status === "error" || capture?.kind === "stream-error") {
    const msg = capture?.message || "上游没有说明是什么错";
    return {
      reason: "stream-error",
      title: "上游把这一轮拒了 / 流断了",
      detail:
        `模型服务那边报错，这一轮没跑完：${msg}。` +
        "可以重试一次；要是反复出现，多半是这次请求的形状或长度它接不住（比如工具参数太长），简化之后再来。",
      raw: rawSummary(capture),
    };
  }

  return null;
}

/** 把原始死因压成一行。状态码、地址、返回体一起摆出来，才看得出是哪个字段被拒。 */
function rawSummary(capture: TurnCapture | null): string | undefined {
  if (!capture) return undefined;
  const parts = [
    `${capture.name ?? "Error"}: ${capture.message ?? ""}`,
    capture.statusCode != null ? `status=${capture.statusCode}` : "",
    capture.url ? `url=${capture.url}` : "",
    capture.body ? `body=${capture.body}` : "",
  ].filter(Boolean);
  const s = parts.join(" | ");
  return s.length > RAW_CAP ? s.slice(0, RAW_CAP) + "…" : s;
}

/** 死因账最多留这么多条。滚动保留最近的那些，免得 state 越滚越大 */
export const TURN_ERROR_CAP = 20;

/** 追加一条死因，超出上限就丢掉最旧的。 */
export function appendTurnError(
  list: TurnError[] | undefined,
  entry: TurnError,
  cap = TURN_ERROR_CAP,
): TurnError[] {
  const next = [...(list ?? []), entry];
  return next.length > cap ? next.slice(next.length - cap) : next;
}
