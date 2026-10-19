import { describe, expect, it } from "vitest";
import {
  DEFAULT_MEMORY_SHELF,
  MAX_MEMORY_CONTENT,
  contentSnippet,
  gateLevelLabel,
  memoryContentTooLong,
  memoryMissingFields,
  memoryPayloadOf,
  parseTags,
  tagStatSummary,
  tagsToText,
  type MemoryDraft,
} from "./memoryForm";
import type { Shelf, TagStat } from "./types";

const draft = (over: Partial<MemoryDraft> = {}): MemoryDraft => ({
  content: "他换了工作站",
  shelf: "knowledge" as Shelf,
  tags: "",
  volatility: "stable",
  ...over,
});

const stat = (over: Partial<TagStat> = {}): TagStat => ({
  tag: "workflow",
  n: 12,
  trivial: 5,
  normal: 4,
  important: 2,
  secret: 1,
  topsecret: 0,
  ...over,
});

describe("写一条记忆的必填校验", () => {
  it("正文空着报的是缺哪一项，不是一个是非", () => {
    const missing = memoryMissingFields({ content: "" });
    expect(missing).toHaveLength(1);
    expect(missing[0].field).toBe("content");
    expect(missing[0].message).toBe("请写下要记住的事");
  });
  it("纯空格与换行算没填：手滑留下的空格不是一条记忆", () => {
    expect(memoryMissingFields({ content: "   " })).toHaveLength(1);
    expect(memoryMissingFields({ content: "\n\t " })).toHaveLength(1);
  });
  it("写了字就没有缺项，前后空格不影响判定", () => {
    expect(memoryMissingFields({ content: " 他换了工作站 " })).toEqual([]);
    expect(memoryMissingFields(draft())).toEqual([]);
  });
  it("默认架子落在知识，与后端的回落同一档", () => {
    expect(DEFAULT_MEMORY_SHELF).toBe("knowledge");
    expect(draft().shelf).toBe(DEFAULT_MEMORY_SHELF);
  });
});

describe("正文长度的边界", () => {
  it("正好卡在 500 字不算超长，多一个字才算", () => {
    expect(MAX_MEMORY_CONTENT).toBe(500);
    expect(memoryContentTooLong("字".repeat(500))).toBe(false);
    expect(memoryContentTooLong("字".repeat(501))).toBe(true);
  });
  it("前后空格不计入长度：填到边上的空格不该把提示点起来", () => {
    expect(memoryContentTooLong(`${"字".repeat(500)}   `)).toBe(false);
    expect(memoryContentTooLong("   ")).toBe(false);
  });
});

describe("标签一格：字符串与数组来回", () => {
  it("空串与纯分隔符都归成空数组", () => {
    expect(parseTags("")).toEqual([]);
    expect(parseTags("   ")).toEqual([]);
    expect(parseTags("，、；,")).toEqual([]);
  });
  it("逗号（半角全角）、顿号、分号、空白都能分隔，顺手去空去重", () => {
    expect(parseTags("a b")).toEqual(["a", "b"]);
    expect(parseTags("a,b，c、d；e;f")).toEqual(["a", "b", "c", "d", "e", "f"]);
    expect(parseTags(" 甲 ,, 乙 ")).toEqual(["甲", "乙"]);
    expect(parseTags("a a b")).toEqual(["a", "b"]);
  });
  it("逗号不许留在 tag 里：库里 tag 按逗号分隔，留着它等于凭空多开一道门", () => {
    expect(parseTags("自定义,已开放标签")).toEqual(["自定义", "已开放标签"]);
    expect(parseTags("自定义，已开放标签")).toEqual(["自定义", "已开放标签"]);
    expect(parseTags("甲、乙")).toEqual(["甲", "乙"]);
  });
  it("数组回写成输入框的一串，空数组是空串，来回一趟不变", () => {
    expect(tagsToText([])).toBe("");
    expect(tagsToText(["甲", "乙"])).toBe("甲、乙");
    expect(tagsToText(parseTags("甲, 乙；丙"))).toBe("甲、乙、丙");
    expect(parseTags(tagsToText(["a", "b", "c"]))).toEqual(["a", "b", "c"]);
  });
});

describe("提交载荷", () => {
  it("正文与标签按后端口径收：trim 正文、切标签，架子与会不会变原样带上", () => {
    expect(
      memoryPayloadOf(draft({ content: "  他换了工作站  ", tags: "工位, 硬件" })),
    ).toEqual({
      content: "他换了工作站",
      shelf: "knowledge",
      tags: ["工位", "硬件"],
      volatility: "stable",
    });
  });
  it("标签格空着就交空数组，不拿一个空字符串去冒充一个标签", () => {
    expect(memoryPayloadOf(draft({ tags: "   " })).tags).toEqual([]);
    expect(memoryPayloadOf(draft({ volatility: "volatile" })).volatility).toBe(
      "volatile",
    );
  });
});

describe("删除确认里引的那一句", () => {
  it("短原文照抄，不加省略号也不改标点", () => {
    expect(contentSnippet("他换了工作站")).toBe("他换了工作站");
    expect(contentSnippet("")).toBe("");
    expect(contentSnippet("   ")).toBe("   ");
  });
  it("第 41 个字起才截：正好 40 字是完整引用", () => {
    expect(contentSnippet("字".repeat(40))).toBe("字".repeat(40));
    expect(contentSnippet("字".repeat(41))).toBe(`${"字".repeat(40)}…`);
    expect(contentSnippet("字".repeat(41)).length).toBe(41);
  });
  it("引文不做美化：前导空格留着，人才对得上要删的是哪条", () => {
    expect(contentSnippet("  " + "a".repeat(45))).toBe(
      "  " + "a".repeat(38) + "…",
    );
  });
});

describe("tag 门槛那一行的文案", () => {
  it("没开门说不公开，开了门说清开到哪一档", () => {
    expect(gateLevelLabel("")).toBe("不公开");
    expect(gateLevelLabel("normal")).toBe("一般及以下");
    expect(gateLevelLabel("secret")).toBe("机密及以下");
  });
  it("门槛表里没有的档位原样带出，不抛也不漏成空白", () => {
    expect(gateLevelLabel("topsecret")).toBe("绝密及以下");
    expect(gateLevelLabel("mystery")).toBe("mystery及以下");
  });
  it("摘要把各量级条数说全，绝密为 0 时不占行", () => {
    expect(tagStatSummary(stat())).toBe(
      "12 条（不重要 5 · 一般 4 · 重要 2 · 机密 1）",
    );
    expect(tagStatSummary(stat({ topsecret: 3 }))).toContain(
      "绝密 3（永不出门）",
    );
  });
  it("0 条说人话，不写「0 条（不重要 0 · …）」", () => {
    expect(tagStatSummary(stat({ n: 0 }))).toBe("还没有带这个 tag 的条目");
    expect(tagStatSummary(stat({ n: 0 }))).not.toContain("0 条");
  });
});
