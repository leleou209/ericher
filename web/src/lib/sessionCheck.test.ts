import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "./http";
import { createSessionCheck, sessionFailure } from "./sessionCheck";
afterEach(() => vi.useRealTimers());

describe("弱网身份检查", () => {
  it("StrictMode/并发检查只发一次请求，完成后不缓存身份", async () => {
    let complete!: (value: string) => void;
    const probe = vi.fn(() => new Promise<string>(resolve => { complete = resolve; }));
    const check = createSessionCheck(probe);
    const a = check(); const b = check();
    expect(a).toBe(b);
    await Promise.resolve(); complete("identity");
    await expect(a).resolves.toBe("identity");
    const c = check(); expect(c).not.toBe(a);
    await Promise.resolve(); complete("fresh"); await c;
    expect(probe).toHaveBeenCalledTimes(2);
  });
  it("超时会中止请求并允许重试，不永久挂起", async () => {
    vi.useFakeTimers();
    let signal!: AbortSignal;
    const check = createSessionCheck((s) => { signal = s; return new Promise(() => {}); }, 100);
    const result = expect(check()).rejects.toThrow("身份检查超时");
    await vi.advanceTimersByTimeAsync(100); await result;
    expect(signal.aborted).toBe(true);
  });
  it("只有明确401才去门禁，5xx/断网/超时留在可重试检查态", () => {
    expect(sessionFailure(new ApiError("expired", 401))).toBe("locked");
    for (const error of [new ApiError("server", 500), new TypeError("Failed to fetch"), new Error("timeout")])
      expect(sessionFailure(error)).toBe("retry");
  });
});
