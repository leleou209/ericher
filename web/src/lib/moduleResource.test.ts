import { describe, expect, it, vi } from "vitest";
import { moduleResource } from "./moduleResource";

describe("按需模块资源", () => {
  it("预热与实际加载复用同一请求", async () => {
    const load = vi.fn(async () => ({ default: "ready" }));
    const resource = moduleResource(load);
    resource.preload();
    await expect(resource.load()).resolves.toEqual({ default: "ready" });
    expect(load).toHaveBeenCalledTimes(1);
  });
  it("失败预热不产生未处理异常，后续可重新尝试", async () => {
    const load = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce("ready");
    const resource = moduleResource(load);
    resource.preload();
    await new Promise(resolve => setTimeout(resolve, 0));
    await expect(resource.load()).resolves.toBe("ready");
    expect(load).toHaveBeenCalledTimes(2);
  });
});
