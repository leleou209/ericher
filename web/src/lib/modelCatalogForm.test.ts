import { describe, expect, it } from "vitest";
import {
  MAX_TOKEN_INPUT,
  entryFormOf,
  entryMissingFields,
  entrySummary,
  looksLikeRawKey,
  parseContextWindow,
  parseMaxOutput,
  parseThinkingBudget,
  providerMissingFields,
  providerSummary,
  usesThinkingBudget,
} from "./modelCatalogForm";
import type {
  ModelFormat,
  ModelProvider,
  ThinkingDialect,
  ThinkingLevel,
} from "./types";

const filled = {
  name: "DeepSeek",
  baseUrl: "https://api.deepseek.com/anthropic/v1",
  keySecret: "DEEPSEEK_KEY",
};

const providerRow = (
  over: Partial<
    Pick<
      ModelProvider,
      "format" | "baseUrl" | "keySecret" | "maintModel" | "thinkingDialect"
    >
  > = {},
) => ({
  format: "anthropic" as ModelFormat,
  baseUrl: "https://api.deepseek.com/anthropic/v1",
  keySecret: "DEEPSEEK_KEY",
  maintModel: "",
  thinkingDialect: "auto" as ThinkingDialect,
  ...over,
});

describe("供应商必填校验报的是缺哪几项", () => {
  it("三格全空按表单顺序给出各自的提示", () => {
    const missing = providerMissingFields({ name: "", baseUrl: "", keySecret: "" });
    expect(missing.map((m) => m.field)).toEqual(["name", "baseUrl", "keySecret"]);
    expect(missing.map((m) => m.message)).toEqual([
      "请填写供应商名称",
      "请填写接口地址（Base URL）",
      "请填写 Key 变量名",
    ]);
  });
  it("纯空格算没填：手滑留下的空格不是值", () => {
    expect(providerMissingFields({ name: "   ", baseUrl: "\n\t", keySecret: "  " })).toHaveLength(3);
    expect(providerMissingFields({ ...filled, name: " " }).map((m) => m.field)).toEqual(["name"]);
  });
  it("填齐了就没有缺项，只缺 Key 变量名时只报那一条", () => {
    expect(providerMissingFields(filled)).toEqual([]);
    const only = providerMissingFields({ ...filled, keySecret: "" });
    expect(only).toHaveLength(1);
    expect(only[0].field).toBe("keySecret");
  });
  it("条目只认模型名必填，空格同样算空", () => {
    expect(entryMissingFields({ model: "" })).toEqual([
      { field: "model", message: "请填写模型名" },
    ]);
    expect(entryMissingFields({ model: "   " })).toHaveLength(1);
    expect(entryMissingFields({ model: " deepseek-v4 " })).toEqual([]);
  });
  it("sk- 开头提示像 Key 本体，但变量名不误报", () => {
    expect(looksLikeRawKey("sk-abcdef123456")).toBe(true);
    expect(looksLikeRawKey("  sk-abcdef  ")).toBe(true);
    expect(looksLikeRawKey("DEEPSEEK_KEY")).toBe(false);
    expect(looksLikeRawKey("sk-")).toBe(false);
  });
});

describe("额度两格的字符串→数字归一", () => {
  it("输出上限：留空与不像数字都当作没填", () => {
    expect(parseMaxOutput("")).toBeUndefined();
    expect(parseMaxOutput("   ")).toBeUndefined();
    expect(parseMaxOutput("abc")).toBeUndefined();
    expect(parseMaxOutput("12abc")).toBeUndefined();
  });
  it("输出上限：0 与负数没有意义，交给后端默认档", () => {
    expect(parseMaxOutput("0")).toBeUndefined();
    expect(parseMaxOutput("-5")).toBeUndefined();
    expect(parseMaxOutput("-0.5")).toBeUndefined();
  });
  it("输出上限：正常值原样收，小数四舍五入成整数（后端只认整数）", () => {
    expect(parseMaxOutput("32768")).toBe(32768);
    expect(parseMaxOutput(" 8000 ")).toBe(8000);
    expect(parseMaxOutput("1.4")).toBe(1);
    expect(parseMaxOutput("1.6")).toBe(2);
  });
  it("输出上限：多打几个 0 收在天花板，不把天文数字写进库", () => {
    expect(parseMaxOutput("999999999")).toBe(MAX_TOKEN_INPUT);
    expect(parseMaxOutput("1e21")).toBe(MAX_TOKEN_INPUT);
    expect(MAX_TOKEN_INPUT).toBe(1_000_000);
  });
  it("最大上下文按 K 计：折回 token 后同样的取舍", () => {
    expect(parseContextWindow("200")).toBe(200_000);
    expect(parseContextWindow("0.5")).toBe(500);
    expect(parseContextWindow("")).toBeUndefined();
    expect(parseContextWindow("abc")).toBeUndefined();
    expect(parseContextWindow("0")).toBeUndefined();
    expect(parseContextWindow("-2")).toBeUndefined();
    expect(parseContextWindow("100000")).toBe(MAX_TOKEN_INPUT);
  });
  it("条目回写成草稿时上下文折回 K，没设过的格子留空", () => {
    expect(
      entryFormOf({
        model: "glm-5.3",
        maxOutput: 32768,
        contextWindow: 200_000,
        thinking: "high",
        thinkingBudget: 8192,
      }),
    ).toEqual({
      model: "glm-5.3",
      maxOutput: "32768",
      contextWindow: "200",
      thinking: "high",
      thinkingBudget: "8192",
    });
    expect(
      entryFormOf({
        model: "x",
        maxOutput: 0,
        contextWindow: 0,
        thinking: "",
        thinkingBudget: 0,
      }),
    ).toEqual({
      model: "x",
      maxOutput: "",
      contextWindow: "",
      thinking: "",
      thinkingBudget: "",
    });
  });
});

describe("思考预算那格的字符串→数字归一", () => {
  it("留空与不像数字都当作没填：后端按档位换算，不把 0 写进去", () => {
    expect(parseThinkingBudget("")).toBeUndefined();
    expect(parseThinkingBudget("   ")).toBeUndefined();
    expect(parseThinkingBudget("abc")).toBeUndefined();
    expect(parseThinkingBudget("8k")).toBeUndefined();
  });
  it("0 与负数等于没说，一样交给后端", () => {
    expect(parseThinkingBudget("0")).toBeUndefined();
    expect(parseThinkingBudget("-3")).toBeUndefined();
  });
  it("正常值原样收，小数四舍五入（与输出上限同口径）", () => {
    expect(parseThinkingBudget("8192")).toBe(8192);
    expect(parseThinkingBudget(" 2048 ")).toBe(2048);
    expect(parseThinkingBudget("1.5")).toBe(2);
    expect(parseThinkingBudget("2.4")).toBe(2);
  });
  it("多打几个 0 收在天花板，和另外两格同一把尺", () => {
    expect(parseThinkingBudget("999999999")).toBe(MAX_TOKEN_INPUT);
    expect(parseThinkingBudget("1e21")).toBe(MAX_TOKEN_INPUT);
  });
});

describe("思考两格的回写与行摘要", () => {
  it("预算 0 回写成空串而不是「0」，强度空串原样", () => {
    const d = entryFormOf({
      model: "m",
      maxOutput: 0,
      contextWindow: 0,
      thinking: "",
      thinkingBudget: 0,
    });
    expect(d.thinkingBudget).toBe("");
    expect(d.thinking).toBe("");
  });
  it("条目摘要末尾追加思考档；没设就不提（默认是大多数，每行都写只是噪音）", () => {
    expect(entrySummary({ maxOutput: 0, contextWindow: 0, thinking: "" })).toBe(
      "输出上限 默认 · 上下文 默认",
    );
    expect(entrySummary({ maxOutput: 0, contextWindow: 0, thinking: "high" })).toBe(
      "输出上限 默认 · 上下文 默认 · 思考 高",
    );
  });
  it("关闭档说「思考 关闭」而不是漏成空白，最高档说「最高」", () => {
    expect(entrySummary({ maxOutput: 0, contextWindow: 0, thinking: "off" })).toContain(
      "思考 关闭",
    );
    expect(entrySummary({ maxOutput: 0, contextWindow: 0, thinking: "max" })).toContain(
      "思考 最高",
    );
  });
  it("后端加了没见过的档位就原样显示，不抛也不漏", () => {
    expect(
      entrySummary({
        maxOutput: 0,
        contextWindow: 0,
        thinking: "extreme" as ThinkingLevel,
      }),
    ).toContain("思考 extreme");
  });
});

describe("哪些写法用得上思考预算", () => {
  it("anthropic 线上只有自动档与 Anthropic 预算档真发得出预算 token", () => {
    expect(usesThinkingBudget("auto", "anthropic")).toBe(true);
    expect(usesThinkingBudget("anthropic", "anthropic")).toBe(true);
  });
  it("openai 线一律用不上预算：后端会把写法回落到 reasoning_effort", () => {
    expect(usesThinkingBudget("auto", "openai-chat")).toBe(false);
    expect(usesThinkingBudget("auto", "openai-responses")).toBe(false);
    expect(usesThinkingBudget("anthropic", "openai-chat")).toBe(false);
    expect(usesThinkingBudget("anthropic", "openai-responses")).toBe(false);
  });
  it("其余写法在 anthropic 线上也不带预算，条目弹页据此不摆那一格", () => {
    const others: ThinkingDialect[] = [
      "anthropic-effort",
      "reasoning-effort",
      "thinking-object",
      "enable-thinking",
      "none",
    ];
    for (const d of others) expect(usesThinkingBudget(d, "anthropic")).toBe(false);
  });
});

describe("列表行摘要", () => {
  it("把格式、Key 变量名、模型数与地址收成一句", () => {
    const s = providerSummary(providerRow(), 3);
    expect(s).toContain("Anthropic 格式");
    expect(s).toContain("Key DEEPSEEK_KEY");
    expect(s).toContain("3 个模型");
    expect(s).toContain("https://api.deepseek.com/anthropic/v1");
    expect(s).not.toContain("维护");
  });
  it("一家还没挂模型时说人话，不写「0 个模型」", () => {
    expect(providerSummary(providerRow(), 0)).toContain("还没挂模型");
    expect(providerSummary(providerRow(), 0)).not.toContain("0 个模型");
  });
  it("配了维护模型才带上那一句", () => {
    const s = providerSummary(providerRow({ maintModel: "deepseek-flash" }), 1);
    expect(s).toContain("维护 deepseek-flash");
  });
  it("标签表里没有的格式原样显示，不抛也不漏成空白", () => {
    const s = providerSummary(providerRow({ format: "mistral" as ModelFormat }), 1);
    expect(s.split(" · ")[0]).toBe("mistral");
  });
  it("思考写法为自动时摘要里不占位置", () => {
    expect(providerSummary(providerRow(), 1)).not.toContain("思考写法");
  });
  it("非自动档追加短名：只留人话名，不把字段名塞进一行摘要", () => {
    const s = providerSummary(providerRow({ thinkingDialect: "anthropic" }), 1);
    expect(s).toContain("思考写法 Anthropic 预算档");
    expect(s).not.toContain("thinking.budget_tokens");
  });
  it("思考写法排在地址前面（被省略号切掉的该是最长的地址）", () => {
    const s = providerSummary(providerRow({ thinkingDialect: "none" }), 1);
    expect(s.indexOf("思考写法 不下发")).toBeLessThan(
      s.indexOf("https://api.deepseek.com"),
    );
    expect(s.endsWith("https://api.deepseek.com/anthropic/v1")).toBe(true);
  });
  it("条目摘要：没设的两格说默认，设过的按 K 画", () => {
    expect(
      entrySummary({ maxOutput: 0, contextWindow: 0, thinking: "" }),
    ).toBe("输出上限 默认 · 上下文 默认");
    expect(
      entrySummary({
        maxOutput: 131072,
        contextWindow: 1_000_000,
        thinking: "",
      }),
    ).toBe("输出上限 131072 · 上下文 1000K");
  });
});
