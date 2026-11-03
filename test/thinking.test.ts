/**
 * 思考强度（thinking.ts）测试。
 *
 * 这一层不做请求，只回答「这一条模型该下发什么」：
 * - 供应商选的写法要按接口线落到真能用的那一支（选错了不报错、也不丢配置）；
 * - 档位要折成各家真正认的字段：anthropic 的 budget_tokens / effort，
 *   OpenAI 系的 reasoning_effort、thinking 对象、enable_thinking；
 * - 预算的两头都能顶住：最小 1024，且必须小于输出上限（否则 Anthropic 直接 400）；
 * - 没设就一个字都不发 —— 存量条目全在这一档，不能因为加了功能就偷偷改行为。
 *
 * 运行: npx vitest run test/thinking.test.ts
 */

import { describe, it, expect } from "vitest";
import {
  ANTHROPIC_BUDGET,
  BRIDGE_KEY,
  bridgeThinkingOf,
  effectiveDialect,
  injectThinking,
  thinkingProviderOptions,
  toThinkingBudget,
  toThinkingDialect,
  toThinkingLevel,
  THINKING_DIALECTS,
  THINKING_LEVELS,
} from "../src/agent/thinking";

describe("归一化：脏值不把整轮打挂", () => {
  it("写法只认表里的七个，其余回落 auto", () => {
    for (const d of THINKING_DIALECTS)
      expect(toThinkingDialect(d)).toBe(d);
    expect(toThinkingDialect("LOUD")).toBe("auto");
    expect(toThinkingDialect("")).toBe("auto");
    expect(toThinkingDialect(3)).toBe("auto");
    expect(toThinkingDialect(null)).toBe("auto");
    expect(toThinkingDialect(undefined)).toBe("auto");
  });

  it("档位只认六档，其余回落「没设」", () => {
    for (const l of THINKING_LEVELS) expect(toThinkingLevel(l)).toBe(l);
    expect(toThinkingLevel("high ")).toBe("");
    expect(toThinkingLevel("LOUD")).toBe("");
    expect(toThinkingLevel(123)).toBe("");
    expect(toThinkingLevel(null)).toBe("");
  });

  it("预算只认正整数，0 与脏值都是「没填」", () => {
    expect(toThinkingBudget(2048)).toBe(2048);
    expect(toThinkingBudget("2048")).toBe(2048);
    expect(toThinkingBudget(0)).toBe(0);
    expect(toThinkingBudget(-1)).toBe(0);
    expect(toThinkingBudget(1.5)).toBe(0);
    expect(toThinkingBudget("abc")).toBe(0);
    expect(toThinkingBudget(null)).toBe(0);
  });
});

describe("effectiveDialect：写法要落到这条线真能用的那一支", () => {
  it("auto 按接口格式挑默认（anthropic 预算档 / reasoning_effort）", () => {
    expect(effectiveDialect("anthropic", "auto")).toBe("anthropic");
    expect(effectiveDialect("openai-chat", "auto")).toBe("reasoning-effort");
    expect(effectiveDialect("openai-responses", "auto")).toBe(
      "reasoning-effort",
    );
  });

  it("换格式时用户没回头改写法：按格式回落，不硬发对面不认的字段", () => {
    // anthropic 线认不了 reasoning_effort / thinking 对象 / enable_thinking
    expect(effectiveDialect("anthropic", "reasoning-effort")).toBe("anthropic");
    expect(effectiveDialect("anthropic", "thinking-object")).toBe("anthropic");
    expect(effectiveDialect("anthropic", "enable-thinking")).toBe("anthropic");
    // OpenAI 线认不了 budget_tokens
    expect(effectiveDialect("openai-chat", "anthropic")).toBe(
      "reasoning-effort",
    );
    expect(effectiveDialect("openai-responses", "anthropic-effort")).toBe(
      "reasoning-effort",
    );
  });

  it("显式选「不下发」就照办，不管哪条线", () => {
    expect(effectiveDialect("anthropic", "none")).toBe("none");
    expect(effectiveDialect("openai-chat", "none")).toBe("none");
  });
});

describe("thinkingProviderOptions：anthropic 线", () => {
  const budget = (level: Parameters<typeof thinkingProviderOptions>[2]) =>
    thinkingProviderOptions("anthropic", "auto", level, 0, 131072);

  it("没设档位 → null（什么都不发）", () => {
    expect(thinkingProviderOptions("anthropic", "auto", "", 0, 131072)).toBe(
      null,
    );
  });

  it("档位折成 budget_tokens：低 1024 / 中 4096 / 高 16384 / 最高 32768", () => {
    expect(budget("low")).toEqual({
      anthropic: { thinking: { type: "enabled", budgetTokens: 1024 } },
    });
    expect(budget("medium")).toEqual({
      anthropic: { thinking: { type: "enabled", budgetTokens: 4096 } },
    });
    expect(budget("high")).toEqual({
      anthropic: { thinking: { type: "enabled", budgetTokens: 16384 } },
    });
    expect(budget("max")).toEqual({
      anthropic: { thinking: { type: "enabled", budgetTokens: 32768 } },
    });
    // 表本身也是一份对外口径，别让人以为最高档给了 64K
    expect(ANTHROPIC_BUDGET.max).toBe(32768);
  });

  it("自定义预算优先于档位表", () => {
    expect(
      thinkingProviderOptions("anthropic", "anthropic", "high", 2048, 131072),
    ).toEqual({
      anthropic: { thinking: { type: "enabled", budgetTokens: 2048 } },
    });
  });

  it("预算两头都能顶住：最小 1024，且必须小于输出上限", () => {
    // 自定义给得太小：抬到 1024
    expect(
      thinkingProviderOptions("anthropic", "auto", "low", 10, 131072),
    ).toEqual({
      anthropic: { thinking: { type: "enabled", budgetTokens: 1024 } },
    });
    // 输出上限只有 4096：最高档 32768 收在 3072（4096 - 1024）
    expect(
      thinkingProviderOptions("anthropic", "auto", "max", 0, 4096),
    ).toEqual({
      anthropic: { thinking: { type: "enabled", budgetTokens: 3072 } },
    });
  });

  it("输出上限窄到开不了思考（< 2048）→ null，不去换一条 400", () => {
    // 2048 还能塞下最小预算 1024（1024 < 2048），照发
    expect(thinkingProviderOptions("anthropic", "auto", "high", 0, 2048)).toEqual(
      { anthropic: { thinking: { type: "enabled", budgetTokens: 1024 } } },
    );
    // 再窄就没有 budget < max_tokens 的余地了，宁可一个字不发
    expect(thinkingProviderOptions("anthropic", "auto", "high", 0, 1920)).toBe(
      null,
    );
    expect(thinkingProviderOptions("anthropic", "auto", "high", 0, 1024)).toBe(
      null,
    );
  });

  it("关闭 → thinking.disabled（两种 anthropic 写法都是这一句）", () => {
    expect(thinkingProviderOptions("anthropic", "auto", "off", 0, 131072)).toEqual(
      { anthropic: { thinking: { type: "disabled" } } },
    );
    expect(
      thinkingProviderOptions("anthropic", "anthropic-effort", "off", 0, 131072),
    ).toEqual({ anthropic: { thinking: { type: "disabled" } } });
  });

  it("推理档写法折成 effort，不再带 budget", () => {
    expect(
      thinkingProviderOptions(
        "anthropic",
        "anthropic-effort",
        "medium",
        0,
        131072,
      ),
    ).toEqual({ anthropic: { effort: "medium" } });
    expect(
      thinkingProviderOptions(
        "anthropic",
        "anthropic-effort",
        "max",
        0,
        131072,
      ),
    ).toEqual({ anthropic: { effort: "max" } });
  });

  it("写法选 none → null，哪怕档位配了", () => {
    expect(thinkingProviderOptions("anthropic", "none", "high", 0, 131072)).toBe(
      null,
    );
  });
});

describe("thinkingProviderOptions：OpenAI 线交给桥", () => {
  it("只带一句指令：哪个写法、什么强度（字段落地在 reasoningBridge）", () => {
    expect(
      thinkingProviderOptions("openai-chat", "auto", "low", 0, 131072),
    ).toEqual({ [BRIDGE_KEY]: { dialect: "reasoning-effort", level: "low" } });
    expect(
      thinkingProviderOptions(
        "openai-responses",
        "enable-thinking",
        "off",
        0,
        131072,
      ),
    ).toEqual({ [BRIDGE_KEY]: { dialect: "enable-thinking", level: "off" } });
  });

  it("没设档位 / 写法 none → null", () => {
    expect(thinkingProviderOptions("openai-chat", "auto", "", 0, 131072)).toBe(
      null,
    );
    expect(
      thinkingProviderOptions("openai-chat", "none", "high", 0, 131072),
    ).toBe(null);
  });
});

describe("bridgeThinkingOf：只认自己那一个键", () => {
  it("认得三种 OpenAI 系写法", () => {
    expect(
      bridgeThinkingOf({ [BRIDGE_KEY]: { dialect: "thinking-object", level: "high" } }),
    ).toEqual({ dialect: "thinking-object", level: "high" });
    expect(
      bridgeThinkingOf({
        [BRIDGE_KEY]: { dialect: "enable-thinking", level: "off" },
      }),
    ).toEqual({ dialect: "enable-thinking", level: "off" });
  });

  it("没有那个键 / 形状不对 → null（宁可少一段，不能把请求打挂）", () => {
    expect(bridgeThinkingOf(undefined)).toBe(null);
    expect(bridgeThinkingOf({ anthropic: { cacheControl: {} } })).toBe(null);
    expect(bridgeThinkingOf({ [BRIDGE_KEY]: {} })).toBe(null);
    expect(
      bridgeThinkingOf({ [BRIDGE_KEY]: { dialect: "anthropic", level: "high" } }),
    ).toBe(null);
    expect(
      bridgeThinkingOf({ [BRIDGE_KEY]: { dialect: "reasoning-effort", level: "" } }),
    ).toBe(null);
    expect(
      bridgeThinkingOf({
        [BRIDGE_KEY]: { dialect: "reasoning-effort", level: "LOUD" },
      }),
    ).toBe(null);
  });
});

describe("injectThinking：写进请求体的那几行", () => {
  it("reasoning-effort：chat 是顶层 reasoning_effort，responses 是 reasoning.effort", () => {
    const chat: Record<string, unknown> = { model: "m" };
    injectThinking(chat, false, { dialect: "reasoning-effort", level: "high" });
    expect(chat.reasoning_effort).toBe("high");

    const responses: Record<string, unknown> = { model: "m" };
    injectThinking(responses, true, {
      dialect: "reasoning-effort",
      level: "max",
    });
    // max 折成 xhigh（OpenAI 那套的最高档）
    expect(responses.reasoning).toEqual({ effort: "xhigh" });
  });

  it("responses 线不把已有的 reasoning 对象整个盖掉", () => {
    const body: Record<string, unknown> = {
      reasoning: { summary: "auto" },
    };
    injectThinking(body, true, { dialect: "reasoning-effort", level: "low" });
    expect(body.reasoning).toEqual({ summary: "auto", effort: "low" });
  });

  it("thinking-object：只有开关，没有档位", () => {
    const on: Record<string, unknown> = {};
    injectThinking(on, false, { dialect: "thinking-object", level: "medium" });
    expect(on.thinking).toEqual({ type: "enabled" });

    const off: Record<string, unknown> = {};
    injectThinking(off, false, { dialect: "thinking-object", level: "off" });
    expect(off.thinking).toEqual({ type: "disabled" });
  });

  it("enable-thinking：布尔，档位同样不参与", () => {
    const on: Record<string, unknown> = {};
    injectThinking(on, false, { dialect: "enable-thinking", level: "low" });
    expect(on.enable_thinking).toBe(true);

    const off: Record<string, unknown> = {};
    injectThinking(off, false, { dialect: "enable-thinking", level: "off" });
    expect(off.enable_thinking).toBe(false);
  });

  it("只碰思考那一个字段，别的参数原样留着", () => {
    const body: Record<string, unknown> = {
      model: "m",
      stream: true,
      messages: [],
    };
    injectThinking(body, false, { dialect: "reasoning-effort", level: "low" });
    expect(body.model).toBe("m");
    expect(body.stream).toBe(true);
    expect(body.messages).toEqual([]);
  });
});
