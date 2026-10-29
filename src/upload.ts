// 云盘上传的三条通道：原始流直通、分片上传、分片合并。
//
// 为什么不用 multipart 表单：req.formData() 会把整个请求体在 Worker 内存里缓冲
// 再解析，CPU 成本随体积线性上升（实测 45MB 时服务端耗时 3385ms，原始流直通
// 只要 2877ms，分片后每片降到常数级）。 Workers 的 CPU 时间有硬上限，体积越大
// 越容易触顶后被重试 —— 这才是「大文件上传吃力」的根因，不是带宽。
//
// 三条通道共用的落点与鉴权规则见 uploadKeyFor / assertInScope：
// 管理员落桶根，持卡来客落自己房间前缀，公开空间人人可读。

import { assertInScope, safeFolder, scopedKey } from "./fileAccess";

/** 单个文件的上限。分片各片也按它兜底，避免有人拿超大单片绕过总量限制。 */
export const MAX_UPLOAD_SIZE = 50 * 1024 * 1024;
/** 分片会话的默认分片大小：8MB。太小则请求数多，太大则单片 CPU 成本回升。 */
export const DEFAULT_PART_SIZE = 8 * 1024 * 1024;
/** 一个分片会话最多多少片。10000 片是 R2 的硬上限，留出余量。 */
export const MAX_PARTS = 10_000;

export interface UploadMeta {
  /** 原始文件名 */
  name: string;
  /** MIME 类型 */
  type: string;
  /** 总字节数 */
  size: number;
  /** 目标文件夹（相对路径） */
  folder: string;
  /** 是否放进公开空间 */
  public: boolean;
}

/** 清洗文件名：去掉路径分隔符与控制字符，留一个可读的短名。 */
export function safeFileName(raw: unknown): string {
  const value = String(raw ?? "").trim();
  const base = value.split(/[/\\]/).pop() ?? "";
  const cleaned = base
    .replace(/[/\\?%*:|"<>\u0000-\u001f]/g, "_")
    .replace(/^\.+/, "")
    .slice(0, 120);
  return cleaned || "upload.bin";
}

export function safeContentType(raw: unknown): string {
  const value = String(raw ?? "").trim();
  // 只留 token 形状的类型，别把调用方塞进来的引号和换行带进 R2 的元数据
  return /^[a-zA-Z0-9][a-zA-Z0-9!#$&^_.+-]{0,120}\/[a-zA-Z0-9][a-zA-Z0-9!#$&^_.+-]{0,120}$/.test(value)
    ? value
    : "application/octet-stream";
}

/**
 * 解析上传元数据。name/type/size 走 query 或头部都认，
 * 大小必须由调用方声明（分片通道按声明值兜底上限）。
 */
export function readUploadMeta(
  url: URL,
  headers: Headers,
): { meta: UploadMeta; error?: string } {
  const rawName = url.searchParams.get("name") ?? headers.get("x-file-name");
  const rawType = url.searchParams.get("type") ?? headers.get("content-type");
  const rawSize = url.searchParams.get("size") ?? headers.get("x-file-size");
  // 没有大小就是没法校验上限 —— 当成缺参数拒掉，不当成 0 字节放行
  if (rawSize === null || rawSize.trim() === "")
    return { meta: emptyMeta(), error: "缺少文件大小" };
  const size = Number(rawSize);
  if (!Number.isFinite(size) || size < 0)
    return { meta: emptyMeta(), error: "缺少文件大小" };
  if (size > MAX_UPLOAD_SIZE)
    return {
      meta: emptyMeta(),
      error: `文件过大，最大 ${MAX_UPLOAD_SIZE / 1024 / 1024}MB`,
    };
  const wantPublic = url.searchParams.get("public") === "1";
  let folder = "";
  try {
    folder = wantPublic ? "public" : safeFolder(url.searchParams.get("folder") ?? "");
  } catch (e) {
    return { meta: emptyMeta(), error: (e as Error).message };
  }
  return {
    meta: {
      name: safeFileName(rawName),
      type: safeContentType(rawType),
      size,
      folder,
      public: wantPublic,
    },
  };
}

function emptyMeta(): UploadMeta {
  return { name: "", type: "", size: 0, folder: "", public: false };
}

/**
 * 分片会话：uploadId 与最终 key 的绑定关系。
 *
 * 存在 R2 里而不是内存：Worker 实例随时可能换，会话必须活得比它久。
 * key 一律带房间前缀，于是「谁能合并这个会话」由前缀本身决定 ——
 * 拿别人的 uploadId 来合并，越不过前缀这一关。
 */
export interface PartSession {
  uploadId: string;
  /** R2 原生分片会话的 uploadId（与本地 uploadId 同值，但要分清是谁的） */
  r2UploadId: string;
  /** 最终落点 */
  key: string;
  name: string;
  type: string;
  size: number;
  totalParts: number;
  createdAt: number;
}

export function sessionKey(uploadId: string): string {
  return `f/.upload-sessions/${uploadId}.json`;
}

/** 会话存放在桶内的保留前缀，不出现在云盘列表里。 */
export const SESSION_PREFIX = "f/.upload-sessions/";

export function isSessionKey(key: string): boolean {
  return key.startsWith(SESSION_PREFIX);
}

/**
 * 分片会话的 key 必须落在允许的范围内。
 *
 * 管理员 scope 为空串（整只桶）；来客 scope 是自己房间的前缀集合。
 * 上传中途房间被换掉（换屋）时，旧会话仍属自己 —— 那是同一场对话的延续。
 */
export function assertSessionScope(key: string, scope: string[]): void {
  assertInScope(key, scope);
}

/**
 * 算出最终落点。与 uploadKeyFor 的规则一致：
 * 公开空间统一前缀；管理员落桶根（带 folder）；持卡来客落自己房间前缀。
 */
export function partFinalKey(
  meta: UploadMeta,
  scope: string[],
  roomPrefix: string | null,
): string {
  if (meta.public) return scopedKey("public", baseName(meta.name), extOf(meta.name));
  if (!roomPrefix) {
    // 管理员：桶根，带 folder
    const rand = crypto.randomUUID().slice(0, 8);
    return meta.folder
      ? `${meta.folder}/${Date.now()}-${rand}-${meta.name}`
      : `${Date.now()}-${rand}-${meta.name}`;
  }
  return scopedKey(roomPrefix, baseName(meta.name), extOf(meta.name), meta.folder);
}

function baseName(name: string): string {
  const dot = name.lastIndexOf(".");
  return (dot > 0 ? name.slice(0, dot) : name).slice(0, 60) || "file";
}

function extOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return (dot > 0 ? name.slice(dot + 1) : "").replace(/[^a-zA-Z0-9]/g, "").slice(0, 8) || "bin";
}

/**
 * 判断这份文件是否该走分片。
 *
 * 低于门槛用单请求：分片本身要多次往返，小文件反而更慢。
 * 门槛按「Worker 单次解析成本」定，不是按用户直觉的 5MB。
 */
export function shouldUseParts(size: number, partSize = DEFAULT_PART_SIZE): boolean {
  return size > partSize;
}

/** 把总长度切成若干片的边界：[起, 止) 。最后一片可以短。 */
export function partBounds(
  size: number,
  partSize: number,
): Array<{ start: number; end: number }> {
  const out: Array<{ start: number; end: number }> = [];
  if (size <= 0) return out;
  const step = Math.max(1, Math.floor(partSize));
  for (let start = 0; start < size; start += step) {
    out.push({ start, end: Math.min(start + step, size) });
    if (out.length >= MAX_PARTS) break;
  }
  return out;
}
