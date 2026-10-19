import { describe, expect, it } from "vitest";
import {
  COMMON_TYPE_ID,
  GUEST_CARD_PERMS,
  blankGuestDraft,
  guestDraftOf,
  guestMissingFields,
  guestPasswordValue,
  guestTypeSummary,
} from "./guestTypeForm";
import type { GuestType } from "./types";

const row = (over: Partial<GuestType> = {}): GuestType => ({
  id: "vip",
  name: "私人空间",
  note: "",
  tools: ["search", "draw"],
  permNotes: false,
  permFiles: false,
  permPublic: false,
  active: true,
  created: "2026-01-01T00:00:00Z",
  ...over,
});

describe("必填校验报的是缺哪几项", () => {
  it("新增时空名加空口令按表单顺序给出各自的提示", () => {
    const missing = guestMissingFields({ name: "", password: "" }, true);
    expect(missing.map((m) => m.field)).toEqual(["name", "password"]);
    expect(missing.map((m) => m.message)).toEqual([
      "请填写这一档的名称",
      "请设一个进门口令",
    ]);
  });
  it("纯空格算没填：手滑留下的空格不是值", () => {
    expect(guestMissingFields({ name: "   ", password: "  " }, true)).toHaveLength(2);
    expect(guestMissingFields({ name: " ", password: "pw" }, true).map((m) => m.field)).toEqual([
      "name",
    ]);
    expect(guestMissingFields({ name: "VIP", password: "\n\t" }, true).map((m) => m.field)).toEqual(
      ["password"],
    );
  });
  it("编辑时口令留空是不改口令，不算缺项；名称空了照样拦", () => {
    expect(guestMissingFields({ name: "VIP", password: "" }, false)).toEqual([]);
    expect(guestMissingFields({ name: "  ", password: "" }, false).map((m) => m.field)).toEqual([
      "name",
    ]);
  });
  it("新增时只缺一项就只报那一条", () => {
    const only = guestMissingFields({ name: "VIP", password: "" }, true);
    expect(only).toHaveLength(1);
    expect(only[0].field).toBe("password");
  });
});

describe("口令格的处理", () => {
  it("留空与只有空格都返回 undefined，PATCH 就不带这个字段", () => {
    expect(guestPasswordValue("")).toBeUndefined();
    expect(guestPasswordValue("   ")).toBeUndefined();
    expect(guestPasswordValue("\n\t ")).toBeUndefined();
  });
  it("填了才当成新口令，前后空格洗掉", () => {
    expect(guestPasswordValue(" ab12 ")).toBe("ab12");
    expect(guestPasswordValue("pw with space")).toBe("pw with space");
  });
  it("没有「清除」这一态：写 clear 也只会被当成一串新口令", () => {
    expect(guestPasswordValue("clear")).toBe("clear");
  });
});

describe("弹页草稿", () => {
  it("空白草稿三格都是空的", () => {
    expect(blankGuestDraft()).toEqual({ name: "", password: "", note: "" });
  });
  it("拍快照只带名称与说明，口令格永远留空（后端只存摘要，没得回显）", () => {
    expect(guestDraftOf(row({ name: "老张", note: "只画图和搜索" }))).toEqual({
      name: "老张",
      password: "",
      note: "只画图和搜索",
    });
  });
});

describe("列表行摘要", () => {
  it("开着几件工具、哪几项长期权益，一行说完", () => {
    const s = guestTypeSummary(row({ tools: ["search", "draw", "memory"] }));
    expect(s).toContain("对外工具 3 件");
    expect(s).toContain("口令已设（只存摘要）");
    expect(s).toContain("长期权益全关");
    expect(s).not.toContain("已停用");
  });
  it("一件工具都没开时说人话，不写「0 件」", () => {
    const s = guestTypeSummary(row({ tools: [] }));
    expect(s).toContain("对外工具全关");
    expect(s).not.toContain("0 件");
  });
  it("权益按开关点名的顺序列出来，全关才说全关", () => {
    expect(
      guestTypeSummary(row({ permNotes: true, permFiles: false, permPublic: true })),
    ).toContain("长期权益 记事本/公开内容");
    expect(guestTypeSummary(row({ permFiles: true }))).toContain("长期权益 云盘上传");
  });
  it("内置通用档的口令就是前台门禁口令，不与自定义档同话", () => {
    const s = guestTypeSummary(row({ id: COMMON_TYPE_ID, name: "通用来客" }));
    expect(s).toContain("口令＝前台门禁口令");
    expect(s).not.toContain("口令已设");
  });
  it("停用的档把「已停用」顶在最前", () => {
    expect(guestTypeSummary(row({ active: false })).startsWith("已停用")).toBe(true);
  });
  it("说明带在最后一格；没填或只有空格就不拖尾巴", () => {
    const s = guestTypeSummary(row({ note: " 只在工作日接待 " }));
    expect(s.endsWith("只在工作日接待")).toBe(true);
    expect(guestTypeSummary(row({ note: "" }))).not.toMatch(/ · $/);
    expect(guestTypeSummary(row({ note: "   " }))).not.toMatch(/ · $/);
  });
  it("权益表的三项与 GuestType 的字段名一一对上", () => {
    expect(GUEST_CARD_PERMS.map((p) => p.key)).toEqual([
      "permNotes",
      "permFiles",
      "permPublic",
    ]);
    expect(GUEST_CARD_PERMS.map((p) => p.label)).toEqual(["记事本", "云盘上传", "公开内容"]);
  });
});
