// 云盘上传通道：原始流直通、R2 原生分片、分片合并。
//
// 三条通道都只认「已经验证过身份的调用者」，落点与权限沿用既有规则：
// 管理员落桶根，持卡来客落自己房间前缀，公开空间要 permPublic。
// 分片会话存在 R2 里，uploadId 与最终 key 的绑定关系由房间前缀保证 ——
// 拿别人的 uploadId 来合并，越不过前缀这一关。
//
// 为什么用 R2 原生分片而不是「自己存片再拼」：
//   · 合并由 R2 完成，Worker 不用把整份文件读进内存（Workers 内存上限 128MB，
//     一份 50MB 文件在合并时缓冲两份就是 100MB —— 那会直接触顶）；
//   · 原生分片支持 uploadPart 直接吃流，也支持续传（resumeMultipartUpload）。
// 代价是 R2 要求「除最后一片外，每片至少 5MiB」，分片大小因此不能太小。

import {
  MAX_PARTS,
  MAX_UPLOAD_SIZE,
  SESSION_PREFIX,
  assertSessionScope,
  partFinalKey,
  sessionKey,
  type PartSession,
  type UploadMeta,
} from "./upload";

export interface UploadContext {
  /** 允许写入的 key 前缀集合；空串 = 管理员整只桶 */
  scope: string[];
  /** 落点用的房间前缀（来客是自己那间，管理员是 null） */
  roomPrefix: string | null;
  /** 是否已核过 permPublic */
  allowPublic: boolean;
}

/**
 * 上传元数据 → 最终落点。管理员与来客的落点规则与 uploadKeyFor 一致，
 * 公开空间统一 f/public/ 前缀。
 */
export function resolveKey(
  meta: UploadMeta,
  context: UploadContext,
): string {
  if (meta.public && !context.allowPublic)
    throw new Error("公开权益没开：这一档跟着长期身份的档位走");
  if (meta.public) return partFinalKey(meta, context.scope, null);
  return partFinalKey(meta, context.scope, context.roomPrefix);
}

/**
 * 收下请求体，返回字节。
 *
 * R2 的 put 要求写入内容的字节数是已知的，不接受长度未知的流。
 * 这里先把请求体读完再写：内存占用与单份文件体积成正比，
 * 而 multipart 表单解析除了这份内存还要额外的解析开销与副本 ——
 * 这正是分片通道存在的意义（每片只有几 MB）。
 */
export async function readBodyBytes(
  body: ReadableStream | null,
  limit: number,
): Promise<Uint8Array> {
  if (!body) throw new Error("缺少文件内容");
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let seen = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    seen += value.byteLength;
    // 超量就在流过去的过程中掐断，不让它进内存
    if (seen > limit) {
      await reader.cancel().catch(() => {});
      throw new Error(`文件过大，最大 ${Math.floor(limit / 1024 / 1024)}MB`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(seen);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/** 直接把请求体写进 R2：不做 multipart 解析，也不额外复制一份。 */
export async function putRaw(
  bucket: R2Bucket,
  key: string,
  body: ReadableStream | null,
  type: string,
  limit = MAX_UPLOAD_SIZE,
): Promise<R2Object> {
  const bytes = await readBodyBytes(body, limit);
  return bucket.put(key, bytes, {
    httpMetadata: { contentType: type || "application/octet-stream" },
  });
}

/**
 * 开始一次分片上传。
 *
 * 分片数据由 R2 自己存着（原生 multipart），Worker 只留一条会话记���
 * 「这是哪份文件、传到哪、总共几片」，以及每片的 etag 回执。
 */
export async function startMultipart(
  bucket: R2Bucket,
  key: string,
  meta: { name: string; type: string; size: number; totalParts: number },
  uploadId: string,
): Promise<PartSession> {
  const multipart = await bucket.createMultipartUpload(key, {
    httpMetadata: { contentType: meta.type || "application/octet-stream" },
  });
  const session: PartSession = {
    // 客户端 id 用于稳定定位服务端会话；R2 id 单独保留用于 resume/complete。
    uploadId,
    r2UploadId: multipart.uploadId,
    key,
    name: meta.name,
    type: meta.type,
    size: meta.size,
    totalParts: meta.totalParts,
    createdAt: Date.now(),
  };
  await writeSession(bucket, session);
  return session;
}

/**
 * 收下一片：交给 R2 原生分片存下，返回 etag。
 *
 * etag 回执单独存成一个小对象，而不是往会话里「读-改-写」：
 * 并发上传时两片同时到达，后写的会把先写的覆盖掉（各写各的才不出这个岔）。
 */
export async function putPart(
  bucket: R2Bucket,
  session: PartSession,
  partNumber: number,
  body: ReadableStream | null,
  limit = MAX_UPLOAD_SIZE,
): Promise<string> {
  if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > MAX_PARTS)
    throw new Error("分片编号不合法");
  const bytes = await readBodyBytes(body, limit);
  const multipart = bucket.resumeMultipartUpload(session.key, session.r2UploadId);
  const uploaded = await multipart.uploadPart(partNumber, bytes);
  await bucket.put(etagKey(session.uploadId, partNumber), JSON.stringify(uploaded), {
    httpMetadata: { contentType: "application/json" },
  });
  return uploaded.etag;
}

/** 某一片的 etag 回执落点。 */
export function etagKey(uploadId: string, partNumber: number): string {
  return `${SESSION_PREFIX}${uploadId}/etag-${partNumber}`;
}

/** 读回一个分片会话。 */
export async function readSession(
  bucket: R2Bucket,
  uploadId: string,
): Promise<PartSession | null> {
  if (!/^[\w-]{1,64}$/.test(uploadId)) return null;
  const object = await bucket.get(sessionKey(uploadId));
  if (!object) return null;
  try {
    const session = (await object.json()) as PartSession;
    if (
      !session ||
      session.uploadId !== uploadId ||
      typeof session.key !== "string" ||
      typeof session.r2UploadId !== "string" ||
      !session.r2UploadId
    ) return null;
    return session;
  } catch {
    return null;
  }
}

export async function writeSession(
  bucket: R2Bucket,
  session: PartSession,
): Promise<void> {
  await bucket.put(sessionKey(session.uploadId), JSON.stringify(session), {
    httpMetadata: { contentType: "application/json" },
  });
}

export async function dropSession(bucket: R2Bucket, uploadId: string): Promise<void> {
  await bucket.delete(sessionKey(uploadId));
}

/** 清掉这个会话的 etag 回执。 */
export async function dropParts(
  bucket: R2Bucket,
  uploadId: string,
): Promise<void> {
  let cursor: string | undefined;
  do {
    const list = await bucket.list({
      prefix: `${SESSION_PREFIX}${uploadId}/`,
      cursor,
      limit: 500,
    });
    const keys = list.objects.map((o) => o.key);
    if (keys.length) await bucket.delete(keys);
    cursor = list.truncated ? list.cursor : undefined;
  } while (cursor);
}

/** 已收到的片号（按 etag 回执判定 —— 回执写成功才算这片到位）。 */
export async function receivedParts(
  bucket: R2Bucket,
  uploadId: string,
): Promise<number[]> {
  const out: number[] = [];
  let cursor: string | undefined;
  do {
    const list = await bucket.list({
      prefix: `${SESSION_PREFIX}${uploadId}/`,
      cursor,
      limit: 1000,
    });
    for (const object of list.objects) {
      const part = Number(object.key.slice(`${SESSION_PREFIX}${uploadId}/etag-`.length));
      if (Number.isInteger(part) && part >= 1) out.push(part);
    }
    cursor = list.truncated ? list.cursor : undefined;
  } while (cursor);
  return out.sort((a, b) => a - b);
}

/**
 * 合并分片：交给 R2 完成。
 *
 * Worker 这一侧不碰文件内容 —— 只是把各片的 etag 交给 R2，
 * 由它把分片拼成完整对象。所以 50MB 的文件合并时，
 * Worker 内存里只有各片的几 MB 回执，不是整份文件。
 */
export async function mergeParts(
  bucket: R2Bucket,
  session: PartSession,
  scope: string[],
): Promise<{ key: string; size: number }> {
  assertSessionScope(session.key, scope);
  const parts = await receivedParts(bucket, session.uploadId);
  if (!parts.length) throw new Error("没有收到任何分片");
  if (parts.length !== session.totalParts)
    throw new Error(
      `分片不全：收到 ${parts.length} 片，应有 ${session.totalParts} 片`,
    );

  const uploaded: Array<{ partNumber: number; etag: string }> = [];
  for (const partNumber of parts) {
    const object = await bucket.get(etagKey(session.uploadId, partNumber));
    if (!object) throw new Error(`第 ${partNumber} 片的回执不见了，请重新上传`);
    const receipt = (await object.json()) as { partNumber: number; etag: string };
    uploaded.push({ partNumber: receipt.partNumber, etag: receipt.etag });
  }

  const multipart = bucket.resumeMultipartUpload(session.key, session.r2UploadId);
  const object = await multipart.complete(uploaded);
  await dropParts(bucket, session.uploadId);
  await dropSession(bucket, session.uploadId);
  return { key: object.key, size: object.size };
}

/** 放弃一次分片上传：中止 R2 侧的分片会话并清掉回执。 */
export async function abortMultipart(
  bucket: R2Bucket,
  uploadId: string,
): Promise<void> {
  const session = await readSession(bucket, uploadId);
  if (session) {
    try {
      await bucket.resumeMultipartUpload(session.key, session.r2UploadId).abort();
    } catch {
      /* 已经合并或已被 R2 清理，忽略 */
    }
  }
  await dropParts(bucket, uploadId);
  await dropSession(bucket, uploadId);
}

/** 上传总量兜底：任何通道都不许超过这个数。 */
export function assertUploadSize(size: number): void {
  if (size > MAX_UPLOAD_SIZE)
    throw new Error(`文件过大，最大 ${MAX_UPLOAD_SIZE / 1024 / 1024}MB`);
}
