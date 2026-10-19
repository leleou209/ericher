import { afterEach, describe, expect, it, vi } from "vitest";
import { cacheTheme, defaultTheme, readCachedTheme } from "./theme";

afterEach(() => vi.unstubAllGlobals());
function storage(raw: string | null = null) {
  const store = new Map(raw === null ? [] : [["ericher.theme.cache.v1", raw]]);
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, value),
  });
}
describe("主题缓存不阻塞启动", () => {
  it("保存后的完整主题可用于首帧", () => {
    storage();
    const theme = { ...defaultTheme(), agentName: "测试接待台", base: "dark" as const };
    cacheTheme(theme);
    expect(readCachedTheme()).toEqual(theme);
  });
  it.each(["invalid", "null", "[]", "{}", '{"agentName":123}', JSON.stringify({ ...defaultTheme(), backgrounds: { chat: null } })])(
    "缓存损坏时回到出厂主题：%s", raw => {
      storage(raw);
      expect(readCachedTheme()).toBeNull();
    },
  );
  it("隐私模式无法读写时也不阻塞", () => {
    vi.stubGlobal("localStorage", { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } });
    expect(readCachedTheme()).toBeNull();
    expect(() => cacheTheme(defaultTheme())).not.toThrow();
  });
});
