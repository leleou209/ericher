import { describe, expect, it } from "vitest";
import { DRAW_FORMAT_DEFAULTS } from "./presets";
import {
  DRAW_TIER_META,
  blankDrawDraft,
  drawDraftOf,
  drawIsBinding,
  drawMissingFields,
  drawPayloadOf,
  drawSummary,
  drawWithFormat,
  modelsToText,
  parseDrawModels,
} from "./drawConfigForm";
import type { DrawConfig, DrawFormat } from "./types";

const cfg = (over: Partial<DrawConfig> = {}): DrawConfig => ({
  tier: "fast",
  format: "siliconflow",
  endpoint: "https://api.siliconflow.cn/v1/images/generations",
  models: ["Tongyi-MAI/Z-Image-Turbo", "Kwai-Kolors/Kolors"],
  keySecret: "SILICONFLOW_KEY",
  label: "硅基流动",
  ...over,
});

describe("模型清单的文本与数组", () => {
  it("中英文逗号都认，逐格 trim，空段丢掉", () => {
    expect(parseDrawModels("a, b，c")).toEqual(["a", "b", "c"]);
    expect(parseDrawModels("  a  ，  b  ")).toEqual(["a", "b"]);
    expect(parseDrawModels("a,, ，b")).toEqual(["a", "b"]);
    expect(parseDrawModels("")).toEqual([]);
  });
  it("只填了逗号算没填：切出来还是空数组", () => {
    expect(parseDrawModels(" , , ")).toEqual([]);
    expect(drawMissingFields({ models: " , , " })).toEqual([
      { field: "models", message: "至少要留一个模型名" },
    ]);
  });
  it("数组折回文本再拆开是同一个清单（降级顺序不乱）", () => {
    const text = modelsToText(["a", "b", "c"]);
    expect(text).toBe("a, b, c");
    expect(parseDrawModels(text)).toEqual(["a", "b", "c"]);
  });
});

describe("必填校验报的是缺哪几项", () => {
  it("清单为空才拦，用的就是后端那句原话", () => {
    expect(drawMissingFields({ models: "   " })).toHaveLength(1);
    expect(drawMissingFields({ models: "flux-2-klein-4b" })).toEqual([]);
    expect(drawMissingFields({ models: "a,," })).toHaveLength(0);
  });
});

describe("协议默认值的联动", () => {
  it("没动过的格子跟着换到新格式的默认值", () => {
    const d = drawWithFormat(blankDrawDraft(), "zhipu");
    expect(d.endpoint).toBe(DRAW_FORMAT_DEFAULTS.zhipu.endpoint);
    expect(d.models).toBe(DRAW_FORMAT_DEFAULTS.zhipu.models);
    expect(d.keySecret).toBe(DRAW_FORMAT_DEFAULTS.zhipu.keySecret);
    expect(d.label).toBe(DRAW_FORMAT_DEFAULTS.zhipu.label);
  });
  it("手填过的格子留住不洗", () => {
    const hand = { ...blankDrawDraft(), endpoint: "https://my-proxy.example/v1" };
    const next = drawWithFormat(hand, "minimax");
    expect(next.endpoint).toBe("https://my-proxy.example/v1");
    expect(next.keySecret).toBe(DRAW_FORMAT_DEFAULTS.minimax.keySecret);
    expect(next.format).toBe("minimax");
  });
  it("条目回写成草稿时清单折成文本，提交前再切回数组", () => {
    const d = drawDraftOf(cfg());
    expect(d.models).toBe("Tongyi-MAI/Z-Image-Turbo, Kwai-Kolors/Kolors");
    expect(drawPayloadOf(d).models).toEqual(cfg().models);
  });
  it("提交前每格 trim", () => {
    const p = drawPayloadOf({
      ...drawDraftOf(cfg()),
      label: " 硅基 ",
      endpoint: " https://x ",
      keySecret: "  ",
    });
    expect(p.label).toBe("硅基");
    expect(p.endpoint).toBe("https://x");
    expect(p.keySecret).toBe("");
  });
  it("只有 workers-ai 这一档走平台绑定", () => {
    expect(drawIsBinding("workers-ai")).toBe(true);
    expect(drawIsBinding("siliconflow")).toBe(false);
    expect(drawIsBinding("zhipu")).toBe(false);
    expect(drawIsBinding("minimax")).toBe(false);
  });
});

describe("列表行摘要", () => {
  it("把协议、标注名、模型数与 Key 收成一句", () => {
    const s = drawSummary(cfg());
    expect(s).toContain("硅基流动");
    expect(s).toContain("标注 硅基流动");
    expect(s).toContain("2 个模型");
    expect(s).toContain("Key SILICONFLOW_KEY");
    expect(s.split(" · ")).toHaveLength(4);
  });
  it("走平台绑定的那档不谈 Key，端点也不塞进摘要", () => {
    const s = drawSummary(
      cfg({
        format: "workers-ai",
        keySecret: "",
        endpoint: "",
        models: ["@cf/flux-2-klein-4b"],
        label: "Workers AI",
      }),
    );
    expect(s).toContain("走平台 AI 绑定");
    expect(s).not.toContain("Key ");
    expect(s).not.toContain("http");
  });
  it("边界值各有一句人话：没标注名、清单空、Key 空", () => {
    expect(drawSummary(cfg({ label: "" }))).toContain("没有标注名");
    expect(drawSummary(cfg({ models: [] }))).toContain("没留模型名");
    expect(drawSummary(cfg({ keySecret: "" }))).toContain("Key 未配");
  });
  it("标签表里没有的格式原样显示，不抛也不漏成空白", () => {
    const s = drawSummary(cfg({ format: "flowthin" as DrawFormat }));
    expect(s.split(" · ")[0]).toBe("flowthin");
  });
});

describe("三档的名目", () => {
  it("每档都有标题与定位说明，fast 那句带着「不带平台水印」", () => {
    expect(Object.keys(DRAW_TIER_META)).toEqual(["fast", "high", "fallback"]);
    expect(DRAW_TIER_META.fast.title).toBe("主力 fast");
    expect(DRAW_TIER_META.fast.desc).toContain("不带平台水印");
    expect(DRAW_TIER_META.fallback.title).toContain("兜底");
  });
});
