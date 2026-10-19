import { afterEach, describe, expect, it, vi } from "vitest";
import { shouldWarmShell, rememberShellHint } from "./startupHint";
afterEach(() => vi.unstubAllGlobals());
function storage() {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) });
}
describe("代码预热提示不承载身份", () => {
  it("首次不预热，登录后只记录布尔提示，失效后清除", () => {
    storage();
    expect(shouldWarmShell(false)).toBe(false);
    rememberShellHint(true); expect(shouldWarmShell(false)).toBe(true);
    rememberShellHint(false); expect(shouldWarmShell(false)).toBe(false);
  });
  it("节省流量模式不做投机下载，存储不可用也不阻塞", () => {
    storage(); rememberShellHint(true); expect(shouldWarmShell(true)).toBe(false);
    vi.stubGlobal("localStorage", { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } });
    expect(shouldWarmShell(false)).toBe(false);
    expect(() => rememberShellHint(true)).not.toThrow();
  });
});
