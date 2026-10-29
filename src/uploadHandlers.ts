// 云盘上传通道的请求处理：原始流直通、分片上传、分片合并、续传查询。
//
// 与既有 /api/upload（multipart 表单）并存：老客户端继续用老入口。
// raw 通道不解析 multipart，但当前 putRaw 仍需先缓冲整份请求体；只有 R2 原生
// multipart 分片通道能把 Worker 内存占用限制在单片大小。

import {
  abortMultipart,
  assertUploadSize,
  mergeParts,
  putPart,
  putRaw,
  readSession,
  receivedParts,
  startMultipart,
} from "./uploadRoutes";
import { MAX_PARTS, readUploadMeta, type PartSession } from "./upload";

export interface UploadDeps {
  /** 允许写入的 key 前缀集合；空串 = 管理员整只桶 */
  scope: string[];
  /** 落点用的房间前缀（来客是自己那间，管理员是 null） */
  roomPrefix: string | null;
  allowPublic: boolean;
}

/** 上传通道的落点与鉴权上下文。 */
export type UploadScope = UploadDeps;

/**
 * 直通上传：请求体就是文件字节。
 *
 * 不做 multipart 解析，减少 multipart 解析与额外副本；但当前 putRaw 会将整份请求体
 * 读入 Worker 内存后再写 R2。超大文件若要控制 Worker 内存，应使用原生分片通道。
 */
export async function handleUploadRaw(
  req: Request,
  env: Env,
  url: URL,
  scope: UploadScope,
): Promise<Response> {
  const bucket = env.MEMORY_BUCKET;
  if (!bucket) return Response.json({ ok: false, error: "云盘未配置" }, { status: 500 });
  const { meta, error } = readUploadMeta(url, req.headers);
  if (error) return Response.json({ ok: false, error }, { status: 400 });
  if (meta.public && !scope.allowPublic)
    return Response.json(
      { ok: false, error: "公开权益没开：这一档跟着长期身份的档位走" },
      { status: 403 },
    );
  assertUploadSize(meta.size);
  const key = resolveUploadKey(meta, scope);
  const object = await putRaw(
    bucket,
    key,
    req.body,
    meta.type,
    meta.size,
  );
  // 实际收到的字节必须与声明一致：声明小、内容大，说明有人绕过了体积上限
  if (object.size !== meta.size) {
    await bucket.delete(key);
    return Response.json(
      { ok: false, error: "收到的字节数与声明不符，请重新上传" },
      { status: 400 },
    );
  }
  return Response.json({
    ok: true,
    key,
    public: meta.public,
    name: meta.name,
    type: meta.type,
    size: object.size,
  });
}

/**
 * 收下一片。
 *
 * 第一片顺带创建 R2 原生分片会话；客户端等首片确认后才并发发送其余分片，
 * 避免多个请求同时创建重复的 R2 会话。后续按客户端 uploadId 找回会话。
 */
export async function handleUploadPart(
  req: Request,
  env: Env,
  url: URL,
  scope: UploadScope,
): Promise<Response> {
  const bucket = env.MEMORY_BUCKET;
  if (!bucket) return Response.json({ ok: false, error: "云盘未配置" }, { status: 500 });
  const { meta, error } = readUploadMeta(url, req.headers);
  if (error) return Response.json({ ok: false, error }, { status: 400 });
  if (meta.public && !scope.allowPublic)
    return Response.json(
      { ok: false, error: "公开权益没开：这一档跟着长期身份的档位走" },
      { status: 403 },
    );
  assertUploadSize(meta.size);

  const uploadId = url.searchParams.get("uploadId") ?? "";
  if (!/^[\w-]{1,64}$/.test(uploadId))
    return Response.json({ ok: false, error: "分片会话编号不合法" }, { status: 400 });
  const partNumber = Number(url.searchParams.get("partNumber") ?? "");
  const totalParts = Number(url.searchParams.get("totalParts") ?? "");
  if (!Number.isInteger(totalParts) || totalParts < 1 || totalParts > MAX_PARTS)
    return Response.json({ ok: false, error: "分片总数不合法" }, { status: 400 });
  if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > totalParts)
    return Response.json({ ok: false, error: "分片编号不合法" }, { status: 400 });

  let session = await readSession(bucket, uploadId);
  if (!session) {
    // 只允许首片创建会话，防止并发首请求为同一个客户端 id 创建多个 R2 multipart。
    if (partNumber !== 1)
      return Response.json(
        { ok: false, error: "上传会话尚未创建，请重试首片" },
        { status: 409 },
      );
    session = await startMultipart(
      bucket,
      resolveUploadKey(meta, scope),
      {
        name: meta.name,
        type: meta.type,
        size: meta.size,
        totalParts,
      },
      uploadId,
    );
  } else {
    // 会话已存在：落点与总长不能被后来的请求改写
    if (session.totalParts !== totalParts || session.size !== meta.size)
      return Response.json(
        { ok: false, error: "分片参数与会话不符，请重新开始上传" },
        { status: 409 },
      );
  }
  try {
    assertSessionScopeSafe(session.key, scope.scope, scope.allowPublic);
  } catch (e) {
    return Response.json({ ok: false, error: (e as Error).message }, { status: 403 });
  }

  const etag = await putPart(
    bucket,
    session,
    partNumber,
    req.body,
    Math.max(1, meta.size),
  );
  const received = await receivedParts(bucket, uploadId);
  return Response.json({
    ok: true,
    uploadId,
    partNumber,
    etag,
    received: received.length,
    totalParts: session.totalParts,
  });
}

/** 合并分片。缺片就明说缺哪几片，别交一份坏文件。 */
export async function handleUploadFinish(
  req: Request,
  env: Env,
  url: URL,
  scope: UploadScope,
): Promise<Response> {
  const bucket = env.MEMORY_BUCKET;
  if (!bucket) return Response.json({ ok: false, error: "云盘未配置" }, { status: 500 });
  const uploadId = url.searchParams.get("uploadId") ?? "";
  const session = await readSession(bucket, uploadId);
  if (!session)
    return Response.json(
      { ok: false, error: "这个分片会话不存在或已过期，请重新开始上传" },
      { status: 409 },
    );
  try {
    assertSessionScopeSafe(session.key, scope.scope, scope.allowPublic);
    const mergeScope = session.key.startsWith("f/public/") && scope.allowPublic
      ? [...scope.scope, "f/public/"]
      : scope.scope;
    const merged = await mergeParts(bucket, session, mergeScope);
    return Response.json({
      ok: true,
      key: merged.key,
      public: session.key.startsWith("f/public/"),
      name: session.name,
      type: session.type,
      size: merged.size,
    });
  } catch (e) {
    return Response.json({ ok: false, error: (e as Error).message }, { status: 400 });
  }
}

/**
 * 查一个分片会话已经收到哪几片。
 *
 * 断点续传靠它：客户端重连后问一次，只补没传上的片。
 */
export async function handleUploadStatus(
  req: Request,
  env: Env,
  url: URL,
  scope: UploadScope,
): Promise<Response> {
  const bucket = env.MEMORY_BUCKET;
  if (!bucket) return Response.json({ ok: false, error: "云盘未配置" }, { status: 500 });
  const uploadId = url.searchParams.get("uploadId") ?? "";
  const session = await readSession(bucket, uploadId);
  if (!session) return Response.json({ ok: true, exists: false, received: [] });
  try {
    // 会话里的落点必须仍在允许范围内：换了身份的老会话不能被续传
    assertSessionScopeSafe(session.key, scope.scope, scope.allowPublic);
  } catch (e) {
    return Response.json({ ok: false, error: (e as Error).message }, { status: 403 });
  }
  return Response.json({
    ok: true,
    exists: true,
    received: await receivedParts(bucket, uploadId),
    totalParts: session.totalParts,
    size: session.size,
  });
}

/** 放弃一个分片会话：清掉临时分片，不留垃圾在桶里。 */
export async function handleUploadAbort(
  req: Request,
  env: Env,
  url: URL,
  scope: UploadScope,
): Promise<Response> {
  const bucket = env.MEMORY_BUCKET;
  if (!bucket) return Response.json({ ok: false, error: "云盘未配置" }, { status: 500 });
  const uploadId = url.searchParams.get("uploadId") ?? "";
  if (!/^[\w-]{1,64}$/.test(uploadId))
    return Response.json({ ok: false, error: "分片会话编号不合法" }, { status: 400 });
  const session = await readSession(bucket, uploadId);
  if (!session) return Response.json({ ok: true });
  try {
    assertSessionScopeSafe(session.key, scope.scope, scope.allowPublic);
  } catch (e) {
    return Response.json({ ok: false, error: (e as Error).message }, { status: 403 });
  }
  await abortMultipart(bucket, uploadId);
  return Response.json({ ok: true });
}

function assertSessionScopeSafe(key: string, scope: string[], allowPublic: boolean): void {
  if (key.startsWith("f/public/")) {
    if (!allowPublic && !scope.includes("")) throw new Error("公开权益没开：这一档跟着长期身份的档位走");
    return;
  }
  if (!scope.includes("") && !scope.some(prefix => key.startsWith(prefix)))
    throw new Error("这个分片会话不属于你");
}

/**
 * 落点规则：管理员落桶根（带 folder），持卡来客落自己房间前缀，
 * 公开空间统一 f/public/ 前缀。
 */
export function resolveUploadKey(
  meta: { name: string; folder: string; public: boolean },
  scope: UploadScope,
): string {
  const rand = crypto.randomUUID().slice(0, 8);
  if (meta.public) {
    const dot = meta.name.lastIndexOf(".");
    const base = (dot > 0 ? meta.name.slice(0, dot) : meta.name).slice(0, 60) || "file";
    const ext =
      (dot > 0 ? meta.name.slice(dot + 1) : "").replace(/[^a-zA-Z0-9]/g, "").slice(0, 8) || "bin";
    return `f/public/${base}-${Date.now()}-${rand}.${ext}`;
  }
  if (!scope.roomPrefix) {
    return meta.folder
      ? `${meta.folder}/${Date.now()}-${rand}-${meta.name}`
      : `${Date.now()}-${rand}-${meta.name}`;
  }
  const dot = meta.name.lastIndexOf(".");
  const base = (dot > 0 ? meta.name.slice(0, dot) : meta.name).slice(0, 60) || "file";
  const ext =
    (dot > 0 ? meta.name.slice(dot + 1) : "").replace(/[^a-zA-Z0-9]/g, "").slice(0, 8) || "bin";
  const dir = meta.folder ? `${meta.folder}/` : "";
  return `f/${scope.roomPrefix}/${dir}${base}-${Date.now()}-${rand}.${ext}`;
}

export type { PartSession };
