// 异常中断的死因判定 —— 这类 bug 以前最难查：
// 界面看着「答完了」，其实话说到一半就没了（输出顶到上限）；或者干脆一片安静，
// 真相只躺在 console 里。把判定抽成纯函数就是为了在这里把每种边界都钉住。

import { describe, expect, it } from "vitest";
import {
  TURN_ERROR_CAP,
  appendTurnError,
  describeTurn,
  type TurnCapture,
} from "../src/agent/turnReport";
import type { TurnError } from "../src/agent/state";

function entry(over: Partial<TurnError> = {}): TurnError {
  return {
    messageId: "m1",
    sessionId: "s1",
    reason: "stream-error",
    title: "t",
    detail: "d",
    at: 1,
    ...over,
  };
}

describe("describeTurn：这一轮该不该报、报什么", () => {
  it("正常跑完：completed 且没截断 → 不报", () => {
    expect(describeTurn({ status: "completed" })).toBeNull();
    expect(
      describeTurn({ status: "completed", finishReason: "stop" }),
    ).toBeNull();
  });

  it("输出被截断：finishReason=length 也认，状态仍是 completed 也照报", () => {
    // 最会骗人的一种：status 是 completed，界面看着答完了，实际被砍了
    const d = describeTurn({ status: "completed", finishReason: "length" });
    expect(d?.reason).toBe("output-limit");
    expect(d?.detail).toContain("maxOutput");
    expect(d?.raw).toBeUndefined();
  });

  it("采集口报了 output-limit，即便 status 没认出来也照报", () => {
    const d = describeTurn({
      status: "completed",
      capture: { kind: "output-limit" },
    });
    expect(d?.reason).toBe("output-limit");
  });

  it("被叫停：带 reason 时把原因照抄进 raw", () => {
    const d = describeTurn({
      status: "aborted",
      capture: { kind: "aborted", abortReason: "user-stop" },
    });
    expect(d?.reason).toBe("aborted");
    expect(d?.raw).toBe("abortReason: user-stop");
  });

  it("被叫停：没带 reason 时不编造，raw 留空", () => {
    const d = describeTurn({ status: "aborted" });
    expect(d?.reason).toBe("aborted");
    expect(d?.raw).toBeUndefined();
  });

  it("流级错误：把 name/message/status/url/body 压进 raw", () => {
    const capture: TurnCapture = {
      kind: "stream-error",
      name: "AI_APICallError",
      message: "upstream 429",
      statusCode: 429,
      url: "https://api.example/v1",
      body: '{"error":"rate limited"}',
    };
    const d = describeTurn({ status: "error", capture });
    expect(d?.reason).toBe("stream-error");
    expect(d?.detail).toContain("upstream 429");
    expect(d?.raw).toContain("AI_APICallError: upstream 429");
    expect(d?.raw).toContain("status=429");
    expect(d?.raw).toContain("url=https://api.example/v1");
    expect(d?.raw).toContain('body={"error":"rate limited"}');
  });

  it("流级错误：没有 captured 时给一句兜底，不空着", () => {
    const d = describeTurn({ status: "error" });
    expect(d?.reason).toBe("stream-error");
    expect(d?.detail).toContain("上游没有说明是什么错");
    expect(d?.raw).toBeUndefined();
  });

  it("raw 过长要截断，别把整个返回体拖进 state", () => {
    const d = describeTurn({
      status: "error",
      capture: { kind: "stream-error", message: "x".repeat(5000) },
    });
    expect(d?.raw?.endsWith("…")).toBe(true);
    expect(d?.raw?.length).toBe(801); // 800 上限 + 省略号
  });

  it("判定优先级：length 压过 aborted/error（截断是真凶，先报它）", () => {
    const d = describeTurn({
      status: "error",
      finishReason: "length",
      capture: { kind: "stream-error", message: "boom" },
    });
    expect(d?.reason).toBe("output-limit");
  });
});

describe("appendTurnError：死因账的追加与裁剪", () => {
  it("空账上追加第一条", () => {
    const list = appendTurnError(undefined, entry());
    expect(list).toHaveLength(1);
    expect(list[0].messageId).toBe("m1");
  });

  it("不满上限时按顺序往后排", () => {
    const list = appendTurnError(
      appendTurnError([], entry({ at: 1 })),
      entry({ at: 2 }),
    );
    expect(list.map((e) => e.at)).toEqual([1, 2]);
  });

  it("超出上限丢最旧的，只留最近 cap 条", () => {
    let list: TurnError[] = [];
    for (let i = 0; i < TURN_ERROR_CAP + 5; i++)
      list = appendTurnError(list, entry({ at: i }));
    expect(list).toHaveLength(TURN_ERROR_CAP);
    expect(list[0].at).toBe(5); // 头五条被裁掉
    expect(list.at(-1)?.at).toBe(TURN_ERROR_CAP + 4);
  });

  it("不就地改原数组（state 的不可变更新）", () => {
    const before: TurnError[] = [entry({ at: 1 })];
    const after = appendTurnError(before, entry({ at: 2 }));
    expect(before).toHaveLength(1);
    expect(after).not.toBe(before);
  });
});
