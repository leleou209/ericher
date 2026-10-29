// 云盘上传的三档策略：轻量 / 均衡 / 专业。
//
// 为什么分档：上传慢的成因不止一种 ——
//   · 小文件：单请求最快，多一次往返反而更慢；
//   · 大文件：Worker 端解析 multipart 的 CPU 成本随体积上升（见 src/upload.ts 实测），
//     分片能把每片的成本压到常数级；
//   · 网络不稳：整份重传等于从头再来，分片级重试只补失败的那几片。
//
// 三档共用同一套服务端通道，只是切分与并发策略不同。

/** 档位：轻量（单请求）/ 均衡（默认分片）/ 专业（并发分片 + 续传）。 */
export type UploadTier = "lite" | "balanced" | "pro";

export interface UploadOptions {
  /** 目标文件夹（相对路径） */
  folder?: string;
  /** 是否放进公开空间 */
  public?: boolean;
  /** 显式指定档位；不给则按体积自动选 */
  tier?: UploadTier;
  /** 单片大小（字节）。分片数由此决定。 */
  partSize?: number;
  /** 取消信号 */
  signal?: AbortSignal;
  /** 进度回调：已传字节 / 总字节 */
  onProgress?: (loaded: number, total: number) => void;
  /** 可注入的请求实现，测试里换成假的 */
  fetchImpl?: typeof fetch;
}

export interface UploadResult {
  key: string;
  name: string;
  type: string;
  size: number;
  /** 实际走了哪一档 */
  tier: UploadTier;
  /** 是否走了分片通道 */
  parted: boolean;
}

/** 均衡档的分片大小。 */
export const BALANCED_PART_SIZE = 8 * 1024 * 1024;
/** 专业档的分片更小：并发更多，单片失败重传的代价更小。 */
/** R2 原生分片要求除最后一片外至少 5MiB。 */
export const MIN_R2_PART_SIZE = 5 * 1024 * 1024;
export const PRO_PART_SIZE = MIN_R2_PART_SIZE;
/** 轻量档的单请求上限：超过它就走分片。 */
export const LITE_LIMIT = 8 * 1024 * 1024;

/** 各档的并发片数。 */
export const TIER_CONCURRENCY: Record<UploadTier, number> = {
  lite: 1,
  balanced: 3,
  pro: 6,
};

/** 各档的失败重试次数（单片级）。 */
export const TIER_RETRIES: Record<UploadTier, number> = {
  lite: 2,
  balanced: 3,
  pro: 5,
};

/**
 * 自动选档：只有明确想要专业档时才用 pro，其余按体积分。
 *
 * 8MB 以下单请求 —— 这个体积下 Worker 解析成本还很低，多一次往返不划算。
 */
export function pickTier(size: number, explicit?: UploadTier): UploadTier {
  if (explicit) return explicit;
  return size > LITE_LIMIT ? "balanced" : "lite";
}

export function partSizeFor(tier: UploadTier, explicit?: number): number {
  if (explicit && explicit > 0) return Math.max(explicit, MIN_R2_PART_SIZE);
  return tier === "pro" ? PRO_PART_SIZE : BALANCED_PART_SIZE;
}

/** 把总长度切成 [起, 止) 区间。 */
export function sliceBounds(
  size: number,
  partSize: number,
): Array<{ start: number; end: number }> {
  const out: Array<{ start: number; end: number }> = [];
  if (size <= 0) return out;
  const step = Math.max(1, Math.floor(partSize));
  for (let start = 0; start < size; start += step) {
    out.push({ start, end: Math.min(start + step, size) });
  }
  return out;
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** 退避重试：越等越久，但有上限；只在网络错与 5xx 上重试。 */
export async function retrying<T>(
  run: () => Promise<T>,
  attempts: number,
  signal?: AbortSignal,
): Promise<T> {
  let last: unknown;
  for (let attempt = 0; attempt < Math.max(1, attempts); attempt += 1) {
    if (signal?.aborted) throw new DOMException("已取消", "AbortError");
    try {
      return await run();
    } catch (e) {
      last = e;
      if (signal?.aborted) throw e;
      // 4xx 是请求本身不对，重试多少次都一样
      const status = (e as { status?: number }).status;
      if (typeof status === "number" && status >= 400 && status < 500) throw e;
      if (attempt === attempts - 1) break;
      await sleep(Math.min(2000, 150 * 2 ** attempt));
    }
  }
  throw last;
}

function randomId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
}

/**
 * 上传一个文件，按档位走对应通道。
 *
 * lite   —— 单请求原始流直通，Worker 不解析 multipart。
 * balanced/pro —— 分片上传；pro 额外记录已传片，失败后可续。
 */
export async function uploadFile(
  file: File,
  options: UploadOptions = {},
): Promise<UploadResult> {
  const tier = pickTier(file.size, options.tier);
  const doFetch = options.fetchImpl ?? fetch;
  const partSize = partSizeFor(tier, options.partSize);
  const bounds = sliceBounds(file.size, partSize);
  const parted = tier !== "lite" && bounds.length > 1;
  const total = file.size;

  const report = (loaded: number) => options.onProgress?.(Math.min(loaded, total), total);

  if (!parted) {
    // 单请求：原始字节直接送出去，文件名与类型走 query
    const query = new URLSearchParams({
      name: file.name,
      type: file.type || "application/octet-stream",
      size: String(file.size),
    });
    if (options.folder) query.set("folder", options.folder);
    if (options.public) query.set("public", "1");
    const response = await retrying(
      async () => {
        const r = await doFetch(`/api/upload/raw?${query}`, {
          method: "POST",
          body: file,
          headers: { "content-type": file.type || "application/octet-stream" },
          signal: options.signal,
        });
        if (!r.ok) throw Object.assign(new Error(await errorText(r)), { status: r.status });
        return r.json() as Promise<{ ok: true; key: string; name: string; type: string; size: number }>;
      },
      TIER_RETRIES[tier],
      options.signal,
    );
    report(total);
    return { key: response.key, name: response.name, type: response.type, size: response.size, tier, parted: false };
  }

  // 分片：首片创建服务端会话，R2 原生 multipart id 由服务端单独保存
  const uploadId = randomId();
  const concurrency = Math.max(1, TIER_CONCURRENCY[tier]);
  const received = new Set<number>();
  let uploadedBytes = 0;

  const uploadOne = async (index: number) => {
    const { start, end } = bounds[index];
    const chunk = file.slice(start, end);
    const query = new URLSearchParams({
      uploadId,
      partNumber: String(index + 1),
      totalParts: String(bounds.length),
      name: file.name,
      type: file.type || "application/octet-stream",
      size: String(file.size),
    });
    if (options.folder) query.set("folder", options.folder);
    if (options.public) query.set("public", "1");
    await retrying(
      async () => {
        const r = await doFetch(`/api/upload/part?${query}`, {
          method: "POST",
          body: chunk,
          headers: { "content-type": "application/octet-stream" },
          signal: options.signal,
        });
        if (!r.ok) throw Object.assign(new Error(await errorText(r)), { status: r.status });
        return r.json() as Promise<{ ok: true }>;
      },
      TIER_RETRIES[tier],
      options.signal,
    );
    received.add(index + 1);
    uploadedBytes += chunk.size;
    report(uploadedBytes);
  };

  // 第一片必须先落地：会话由它创建。
  // 并发时后面的片可能比首片先到 —— 服务端会因「会话不存在」拒收，
  // 那不是网络问题，重试也没用（首片还没建好）。所以先单独发首片，再并发其余的。
  try {
    await uploadOne(0);
    await runPool(bounds.length - 1, concurrency, index => uploadOne(index + 1), options.signal);

    const finishQuery = new URLSearchParams({ uploadId });
  const response = await retrying(
    async () => {
      const r = await doFetch(`/api/upload/finish?${finishQuery}`, {
        method: "POST",
        signal: options.signal,
      });
      if (!r.ok) throw Object.assign(new Error(await errorText(r)), { status: r.status });
      return r.json() as Promise<{ ok: true; key: string; name: string; type: string; size: number }>;
    },
    TIER_RETRIES[tier],
    options.signal,
  );
    report(total);
    return { key: response.key, name: response.name, type: response.type, size: response.size, tier, parted: true };
  } catch (error) {
    if (options.signal?.aborted) await abortServerUpload(doFetch, uploadId);
    throw error;
  }
}

/**
 * 断点续传：接着上一次没传完的会话继续。
 *
 * 先问服务端已收到哪几片，只补缺的那些。professional 档用它把
 * 「网断了重连」从「从头再来」变成「补几片」。
 */
export async function resumeUpload(
  file: File,
  uploadId: string,
  options: UploadOptions = {},
): Promise<UploadResult> {
  const tier = options.tier ?? "pro";
  const doFetch = options.fetchImpl ?? fetch;
  const partSize = partSizeFor(tier, options.partSize);
  const bounds = sliceBounds(file.size, partSize);
  const total = file.size;
  const report = (loaded: number) => options.onProgress?.(Math.min(loaded, total), total);

  const status = await doFetch(`/api/upload/status?uploadId=${encodeURIComponent(uploadId)}`, {
    signal: options.signal,
  });
  if (!status.ok) throw new Error(await errorText(status));
  const info = (await status.json()) as {
    exists: boolean;
    received: number[];
    totalParts: number;
  };
  if (!info.exists) throw new Error("这个上传会话已经不在了，请重新开始");
  const have = new Set(info.received);
  let uploadedBytes = 0;
  for (const index of have) uploadedBytes += bounds[index - 1].end - bounds[index - 1].start;
  report(uploadedBytes);

  const concurrency = Math.max(1, TIER_CONCURRENCY[tier]);
  const uploadOne = async (index: number) => {
    const { start, end } = bounds[index];
    const chunk = file.slice(start, end);
    const query = new URLSearchParams({
      uploadId,
      partNumber: String(index + 1),
      totalParts: String(bounds.length),
      name: file.name,
      type: file.type || "application/octet-stream",
      size: String(file.size),
    });
    if (options.folder) query.set("folder", options.folder);
    if (options.public) query.set("public", "1");
    await retrying(
      async () => {
        const r = await doFetch(`/api/upload/part?${query}`, {
          method: "POST",
          body: chunk,
          headers: { "content-type": "application/octet-stream" },
          signal: options.signal,
        });
        if (!r.ok) throw Object.assign(new Error(await errorText(r)), { status: r.status });
        return r.json() as Promise<{ ok: true }>;
      },
      TIER_RETRIES[tier],
      options.signal,
    );
    uploadedBytes += chunk.size;
    report(uploadedBytes);
  };

  try {
    const missing = bounds.map((_, index) => index).filter(index => !have.has(index + 1));
    await runPool(missing.length, concurrency, uploadOne, options.signal);

    const finishQuery = new URLSearchParams({ uploadId });
  const response = await retrying(
    async () => {
      const r = await doFetch(`/api/upload/finish?${finishQuery}`, {
        method: "POST",
        signal: options.signal,
      });
      if (!r.ok) throw Object.assign(new Error(await errorText(r)), { status: r.status });
      return r.json() as Promise<{ ok: true; key: string; name: string; type: string; size: number }>;
    },
    TIER_RETRIES[tier],
    options.signal,
  );
    report(total);
    return { key: response.key, name: response.name, type: response.type, size: response.size, tier, parted: true };
  } catch (error) {
    if (options.signal?.aborted) await abortServerUpload(doFetch, uploadId);
    throw error;
  }
}

/**
 * 固定并发地跑一批任务；任何一个失败都立刻停下其余的。
 *
 * 失败要能真正停下：分片上传时一片失败，其余的片继续传就是白传 ——
 * 用户等的是合并，合并不了就是一次白等的网络开销。
 */
export async function runPool(
  total: number,
  concurrency: number,
  worker: (index: number) => Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  if (total <= 0) return;
  let next = 0;
  let failure: unknown;
  let failed = false;
  const runners = Array.from({ length: Math.min(concurrency, total) }, async () => {
    for (;;) {
      if (failed) return;
      if (signal?.aborted) throw new DOMException("已取消", "AbortError");
      const index = next++;
      if (index >= total) return;
      try {
        await worker(index);
      } catch (e) {
        failure = e;
        failed = true;
        return;
      }
    }
  });
  await Promise.all(runners);
  if (failure) throw failure;
}

async function abortServerUpload(doFetch: typeof fetch, uploadId: string): Promise<void> {
  try {
    // 原请求已被 AbortSignal 取消，这个清理请求故意不复用该 signal。
    await doFetch(`/api/upload/abort?uploadId=${encodeURIComponent(uploadId)}`, { method: "POST" });
  } catch {
    // 网络已断时无法通知服务端，未完成的 multipart 可能留在 R2，需后续清理策略回收。
  }
}

async function errorText(response: Response): Promise<string> {
  const text = await response.text().catch(() => "");
  try {
    const body = JSON.parse(text) as { error?: unknown };
    if (typeof body.error === "string" && body.error) return body.error;
  } catch {
    /* 不是 JSON 就用原文 */
  }
  return text || `上传失败（${response.status}）`;
}
