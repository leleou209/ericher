// 上传路径实测：量化 multipart 解析、原始流转发、分片上传各自的耗时与内存。
// 只在 localhost 使用，不接任何模型服务，不写生产桶。
import { createHash } from "node:crypto";
import { CoworkAgent } from "../../src/agent/cowork";

const MAX = 50 * 1024 * 1024;

function bytesOf(size: number): Uint8Array {
  const buffer = new Uint8Array(size);
  for (let i = 0; i < size; i += 1) buffer[i] = i % 251;
  return buffer;
}

export { CoworkAgent };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/__test/health") return Response.json({ ok: true });

    // A：现状 —— multipart 表单，Worker 解析成 File 再落 R2
    if (url.pathname === "/bench/formdata" && request.method === "POST") {
      const started = Date.now();
      const form = await request.formData();
      const file = form.get("file") as File;
      const key = `bench/formdata-${Date.now()}`;
      await env.MEMORY_BUCKET.put(key, file.stream());
      const bytes = new Uint8Array(await env.MEMORY_BUCKET.get(key).then(async o => new Uint8Array(await o!.arrayBuffer())));
      return Response.json({
        mode: "formdata",
        size: file.size,
        ms: Date.now() - started,
        sha: createHash("sha256").update(bytes).digest("hex").slice(0, 16),
      });
    }

    // B：原始字节直通 —— 不解析表单，直接把请求体流式写进 R2
    if (url.pathname === "/bench/raw" && request.method === "POST") {
      const started = Date.now();
      const key = `bench/raw-${Date.now()}`;
      const name = url.searchParams.get("name") ?? "upload.bin";
      const type = request.headers.get("content-type") ?? "application/octet-stream";
      await env.MEMORY_BUCKET.put(key, request.body!, {
        httpMetadata: { contentType: type },
        customMetadata: { name },
      });
      const bytes = new Uint8Array(await env.MEMORY_BUCKET.get(key).then(async o => new Uint8Array(await o!.arrayBuffer())));
      return Response.json({
        mode: "raw",
        size: bytes.byteLength,
        ms: Date.now() - started,
        sha: createHash("sha256").update(bytes).digest("hex").slice(0, 16),
      });
    }

    // C0：分片会话初始化 —— 先建好会话，并发传片时共用同一个 uploadId
    if (url.pathname === "/bench/init") {
      const key = url.searchParams.get("key") ?? `bench/part-${Date.now()}`;
      const multipart = await env.MEMORY_BUCKET.createMultipartUpload(key);
      return Response.json({ key, uploadId: multipart.uploadId });
    }

    // C：分片 —— 客户端并发传若干片，服务端逐片入 R2，最后合并
    if (url.pathname === "/bench/part" && request.method === "POST") {
      const started = Date.now();
      const key = url.searchParams.get("key") ?? `bench/part-${Date.now()}`;
      const partNumber = Number(url.searchParams.get("part") ?? "1");
      const uploadId = url.searchParams.get("uploadId") ?? "";
      const parts: Array<{ partNumber: number; etag: string }> = JSON.parse(
        url.searchParams.get("parts") ?? "[]",
      );
      const multipart = await env.MEMORY_BUCKET.resumeMultipartUpload(key, uploadId);
      const uploaded = await multipart.uploadPart(partNumber, request.body!);
      const all = [...parts.filter(p => p.partNumber !== partNumber), { partNumber, etag: uploaded.etag }].sort(
        (a, b) => a.partNumber - b.partNumber,
      );
      return Response.json({
        mode: "part",
        uploadId: multipart.uploadId,
        etag: uploaded.etag,
        parts: all,
        ms: Date.now() - started,
        total: all.length,
      });
    }

    // D：分片收尾 —— 合并成完整对象
    if (url.pathname === "/bench/complete" && request.method === "POST") {
      const started = Date.now();
      const key = url.searchParams.get("key") ?? "";
      const uploadId = url.searchParams.get("uploadId") ?? "";
      const parts: Array<{ partNumber: number; etag: string }> = JSON.parse(
        url.searchParams.get("parts") ?? "[]",
      );
      const multipart = await env.MEMORY_BUCKET.resumeMultipartUpload(key, uploadId);
      const object = await multipart.complete(parts);
      const bytes = new Uint8Array(await env.MEMORY_BUCKET.get(key).then(async o => new Uint8Array(await o!.arrayBuffer())));
      return Response.json({
        mode: "complete",
        size: object.size,
        ms: Date.now() - started,
        sha: createHash("sha256").update(bytes).digest("hex").slice(0, 16),
      });
    }

    // E：并发压测辅助 —— 返回一段指定大小的字节，供客户端直传
    if (url.pathname === "/bench/bytes") {
      const size = Number(url.searchParams.get("size") ?? "1048576");
      return new Response(bytesOf(Math.min(size, MAX)), {
        headers: { "content-type": "application/octet-stream" },
      });
    }

    return new Response("bench only", { status: 404 });
  },
};
