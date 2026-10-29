import { describe, expect, it, vi } from "vitest";
import {
  BALANCED_PART_SIZE,
  LITE_LIMIT,
  PRO_PART_SIZE,
  TIER_CONCURRENCY,
  partSizeFor,
  pickTier,
  retrying,
  runPool,
  sliceBounds,
  uploadFile,
} from "./upload";

function fakeResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("档位选择", () => {
  it("小文件走轻量，大文件走均衡，明确指定时听用户的", () => {
    expect(pickTier(1024)).toBe("lite");
    expect(pickTier(LITE_LIMIT)).toBe("lite");
    expect(pickTier(LITE_LIMIT + 1)).toBe("balanced");
    expect(pickTier(1024, "pro")).toBe("pro");
    expect(pickTier(100 * 1024 * 1024, "lite")).toBe("lite");
  });
  it("分片大小与并发数按档位区分：专业档片更小、并发更多", () => {
    expect(partSizeFor("balanced")).toBe(BALANCED_PART_SIZE);
    expect(partSizeFor("pro")).toBe(PRO_PART_SIZE);
    expect(partSizeFor("balanced", 1024)).toBe(5 * 1024 * 1024);
    expect(TIER_CONCURRENCY.pro).toBeGreaterThan(TIER_CONCURRENCY.balanced);
    expect(TIER_CONCURRENCY.balanced).toBeGreaterThan(TIER_CONCURRENCY.lite);
  });
  it("切片边界覆盖整份文件且不重叠", () => {
    const bounds = sliceBounds(20 * 1024 * 1024, 8 * 1024 * 1024);
    expect(bounds).toHaveLength(3);
    expect(bounds[0].start).toBe(0);
    expect(bounds.at(-1)!.end).toBe(20 * 1024 * 1024);
    for (let i = 1; i < bounds.length; i += 1) expect(bounds[i].start).toBe(bounds[i - 1].end);
  });
});

describe("重试与并发", () => {
  it("网络错误会重试，超过次数才抛", async () => {
    let calls = 0;
    const run = vi.fn(async () => {
      calls += 1;
      if (calls < 3) throw Object.assign(new Error("网络断了"), { status: undefined });
      return "ok";
    });
    await expect(retrying(run, 3)).resolves.toBe("ok");
    expect(calls).toBe(3);
  });
  it("4xx 不重试：请求本身不对，重试也没用", async () => {
    const run = vi.fn(async () => {
      throw Object.assign(new Error("文件过大"), { status: 413 });
    });
    await expect(retrying(run, 5)).rejects.toThrow("文件过大");
    expect(run).toHaveBeenCalledTimes(1);
  });
  it("并发不超过任务数，任一失败即中止其余", async () => {
    let peak = 0;
    let active = 0;
    let calls = 0;
    let failedOnce = false;
    await expect(
      runPool(6, 3, async () => {
        active += 1;
        calls += 1;
        peak = Math.max(peak, active);
        await new Promise(resolve => setTimeout(resolve, 5));
        active -= 1;
        // 第一片就失败：后面的片不该再被启动
        if (!failedOnce) {
          failedOnce = true;
          throw new Error("炸了");
        }
      }),
    ).rejects.toThrow("炸了");
    expect(peak).toBeLessThanOrEqual(3);
    // 失败一旦发生，其余在跑的片不再接着取新任务
    expect(calls).toBeLessThan(6);
  });
});

describe("上传通道", () => {
  it("轻量档：单请求原始流，不走分片", async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return fakeResponse({ ok: true, key: "f/default/x.bin", name: "x.bin", type: "application/octet-stream", size: 10 });
    }) as unknown as typeof fetch;
    const file = new File([new Uint8Array(10)], "x.bin", { type: "application/octet-stream" });
    const progress: number[] = [];
    const result = await uploadFile(file, { fetchImpl, onProgress: loaded => progress.push(loaded) });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("/api/upload/raw");
    expect(result.parted).toBe(false);
    expect(result.key).toBe("f/default/x.bin");
    expect(progress.at(-1)).toBe(10);
  });

  it("均衡档：大文件切片并发上传，先传片再合并", async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url.includes("/api/upload/part"))
        return fakeResponse({ ok: true, partNumber: 1, received: 1, totalParts: 2 });
      return fakeResponse({ ok: true, key: "f/default/big.bin", name: "big.bin", type: "", size: 16 * 1024 * 1024 });
    }) as unknown as typeof fetch;
    const file = new File([new Uint8Array(16 * 1024 * 1024)], "big.bin");
    const result = await uploadFile(file, { fetchImpl, partSize: 8 * 1024 * 1024 });
    expect(result.parted).toBe(true);
    expect(calls.filter(c => c.includes("/api/upload/part"))).toHaveLength(2);
    expect(calls.at(-1)).toContain("/api/upload/finish");
  });

  it("失败的分片会单独重试，不牵动已成功的片", async () => {
    let partCalls = 0;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/upload/part")) {
        partCalls += 1;
        if (partCalls === 1) return new Response("boom", { status: 500 });
        return fakeResponse({ ok: true });
      }
      return fakeResponse({ ok: true, key: "k", name: "n", type: "", size: 1 });
    }) as unknown as typeof fetch;
    const file = new File([new Uint8Array(16 * 1024 * 1024)], "big.bin");
    await uploadFile(file, { fetchImpl, partSize: 8 * 1024 * 1024 });
    expect(partCalls).toBe(3);
  });

  it("取消分片上传时会请求服务端中止 R2 会话", async () => {
    const controller = new AbortController();
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url.includes("/api/upload/part")) {
        controller.abort();
        return fakeResponse({ ok: true });
      }
      return fakeResponse({ ok: true });
    }) as unknown as typeof fetch;
    const file = new File([new Uint8Array(16 * 1024 * 1024)], "x.bin");
    await expect(uploadFile(file, { fetchImpl, signal: controller.signal })).rejects.toThrow();
    expect(calls.some(url => url.includes("/api/upload/abort"))).toBe(true);
  });
});
