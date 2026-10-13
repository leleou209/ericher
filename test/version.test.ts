// compareSemver 是「检查更新」的开关：开源仓版本比本地新才提示升级。
// 它判错方向的代价不对称 —— 把旧的判成新的会让人白白升级，把新的判成旧的
// 会让更新永远静默。所以逐位比较、缺位补零这些小规矩值得几条自己的测试。

import { describe, expect, it } from "vitest";
import { compareSemver } from "../src/version";

describe("版本号比较（检查更新判新旧只认版本号，不认提交）", () => {
  it("逐位比大小：主 > 次 > 修", () => {
    expect(compareSemver("1.0.0", "0.9.9")).toBeGreaterThan(0);
    expect(compareSemver("0.3.0", "0.2.9")).toBeGreaterThan(0);
    expect(compareSemver("0.2.1", "0.2.0")).toBeGreaterThan(0);
    expect(compareSemver("0.2.0", "0.3.0")).toBeLessThan(0);
  });

  it("相等返回 0，缺位按 0 补", () => {
    expect(compareSemver("0.2.0", "0.2.0")).toBe(0);
    expect(compareSemver("0.2", "0.2.0")).toBe(0);
    expect(compareSemver("", "0.0.0")).toBe(0);
    // 第四段补丁位也要比：0.1.6.5 比 0.1.6 新，否则停在旧版的用户等不到提示
    expect(compareSemver("0.1.6.5", "0.1.6")).toBeGreaterThan(0);
    expect(compareSemver("0.1.6", "0.1.6.5")).toBeLessThan(0);
    expect(compareSemver("0.1.6.0", "0.1.6")).toBe(0);
  });

  it("本地领先（攒批未推）不算落后：远端 <= 本地即视为最新", () => {
    // 本地 0.3.0、开源仓还停在 0.2.0 —— 提交数这边多，但版本不比这边新
    expect(compareSemver("0.2.0", "0.3.0")).toBeLessThanOrEqual(0);
    // 两边同版本：即使提交数不同，也不喊「有更新」
    expect(compareSemver("0.2.0", "0.2.0")).toBeLessThanOrEqual(0);
  });
});
