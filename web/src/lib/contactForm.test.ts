import { describe, expect, it } from "vitest";
import {
  GUEST_PREFIX,
  MAX_PERSON_CHARS,
  contactMissingFields,
  contactPayloadOf,
  hasGuestPerson,
  isGuestPerson,
  personNameTooLong,
  personSummary,
  type ContactDraft,
} from "./contactForm";
import { parseTags, tagsToText } from "./memoryForm";

const draft = (over: Partial<ContactDraft> = {}): ContactDraft => ({
  person: "老周",
  content: "他换了工作站",
  tags: "",
  volatility: "stable",
  ...over,
});

describe("记一条人脉条目的必填校验", () => {
  it("两格都空时按弹页顺序报出缺的那两项", () => {
    const missing = contactMissingFields({ person: "", content: "" });
    expect(missing.map((m) => m.field)).toEqual(["person", "content"]);
    expect(missing.map((m) => m.message)).toEqual([
      "请填写人物姓名或称呼",
      "请写下要记住的事",
    ]);
  });
  it("只缺一格就只报那一格，填齐了是空数组", () => {
    expect(
      contactMissingFields({ person: "老周", content: "" }).map((m) => m.field),
    ).toEqual(["content"]);
    expect(
      contactMissingFields({ person: "", content: "换机器了" }).map((m) => m.field),
    ).toEqual(["person"]);
    expect(contactMissingFields(draft())).toEqual([]);
  });
  it("纯空格算没填：空格既不是名字，也不是要记住的事", () => {
    expect(contactMissingFields({ person: "  ", content: "\n\t" })).toHaveLength(
      2,
    );
    expect(contactMissingFields({ person: " 老周 ", content: " x " })).toEqual([]);
  });
});

describe("来客与本人的归类", () => {
  it("只有带上「来客·」前缀的才算来客", () => {
    expect(GUEST_PREFIX).toBe("来客·");
    expect(isGuestPerson("来客·张三")).toBe(true);
    expect(isGuestPerson("来客·")).toBe(true);
    expect(isGuestPerson("老周")).toBe(false);
    expect(isGuestPerson("来客")).toBe(false);
    expect(isGuestPerson("")).toBe(false);
  });
  it("名单里一个来客都没有时，那个开关不该摆出来", () => {
    expect(hasGuestPerson([{ person: "老周" }, { person: "她" }])).toBe(false);
    expect(hasGuestPerson([])).toBe(false);
    expect(hasGuestPerson([{ person: "老周" }, { person: "来客·小李" }])).toBe(
      true,
    );
  });
});

describe("姓名的长度边界", () => {
  it("后端把 person 截到 40 字：正好 40 不算过长，多一个字符才提示", () => {
    expect(MAX_PERSON_CHARS).toBe(40);
    expect(personNameTooLong("名".repeat(40))).toBe(false);
    expect(personNameTooLong("名".repeat(41))).toBe(true);
    expect(personNameTooLong(`${"名".repeat(40)}   `)).toBe(false);
    expect(personNameTooLong("")).toBe(false);
  });
});

describe("人物行的摘要", () => {
  it("有几条说几条", () => {
    expect(personSummary(1)).toBe("1 条记忆");
    expect(personSummary(23)).toBe("23 条记忆");
  });
  it("0 条说「还没记下」，并且不混进负数", () => {
    expect(personSummary(0)).toBe("还没记下关于他的事");
    expect(personSummary(0)).not.toContain("0 条");
    expect(personSummary(-1)).toBe("还没记下关于他的事");
  });
});

describe("提交载荷", () => {
  it("姓名与正文 trim，标签沿用记忆面板那套切法", () => {
    expect(
      contactPayloadOf(draft({ person: "  老周  ", content: " 换机器了 ", tags: "硬件, 工位" })),
    ).toEqual({
      content: "换机器了",
      person: "老周",
      tags: ["硬件", "工位"],
      volatility: "stable",
    });
  });
  it("标签格空着交空数组：不能拿一个空串去冒充一个 tag", () => {
    expect(contactPayloadOf(draft({ tags: "   " })).tags).toEqual([]);
    expect(contactPayloadOf(draft()).person).toBe("老周");
  });
  it("标签来回一趟不变：弹页回写和再次提交该是同一批 tag", () => {
    expect(tagsToText(parseTags("甲, 乙；丙"))).toBe("甲、乙、丙");
    expect(parseTags(tagsToText(["甲", "乙"]))).toEqual(["甲", "乙"]);
  });
});
