import { describe, expect, it } from "vitest";
import { drawerMounted, rememberDrawer } from "./drawerKeepMounted";

describe("抽屉按需加载后仍保持挂载", () => {
  it("从未打开时不挂载，避免首屏拉起无用模块", () => {
    expect(drawerMounted(false, false)).toBe(false);
    expect(drawerMounted(true, false)).toBe(true);
  });
  it("打开过一次后即使收起也保持挂载，不丢未保存内容", () => {
    const visited = rememberDrawer({ note: false, memo: false, plan: false }, { note: true, memo: false, plan: false });
    expect(visited.note).toBe(true);
    expect(drawerMounted(false, visited.note)).toBe(true);
  });
  it("只记住真正打开过的抽屉，且状态未变时返回同一引用", () => {
    const previous = { note: false, memo: false, plan: false };
    expect(rememberDrawer(previous, { note: false, memo: false, plan: false })).toBe(previous);
    const after = rememberDrawer(previous, { note: false, memo: true, plan: false });
    expect(after).not.toBe(previous);
    expect(after.note).toBe(false); expect(after.memo).toBe(true); expect(after.plan).toBe(false);
    expect(rememberDrawer(after, { note: false, memo: false, plan: false })).toBe(after);
  });
});
