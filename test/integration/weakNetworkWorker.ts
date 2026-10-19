// 仅用于 localhost 隔离验证：用可控延迟/限速模拟弱网，不接任何模型服务。
// mode: fast=无额外延迟（readiness 档位）; throttle=首屏资源分块限速;
// slowShell=整条链路延迟; slowAuth=身份接口超时; auth500=身份接口报错。
// 消费方：scripts/start-weak-network-fixture.mjs（readiness 打 /__test/health）
// 与 scripts/test-weak-network.mjs（HTTP 断言）。
import worker from "../../src/index";
import { CoworkAgent as ProductionAgent } from "../../src/agent/cowork";
import { createUIMessageStream, createUIMessageStreamResponse, type ToolSet, type StreamTextOnFinishCallback } from "ai";
import type { ChatResponseResult, OnChatMessageOptions } from "@cloudflare/ai-chat";
import { getAgentByName } from "agents";

export class CoworkAgent extends ProductionAgent {
  override async maintenance(_system: string, _user: string): Promise<string> { return ""; }
  override async onChatMessage(_finish: StreamTextOnFinishCallback<ToolSet>, options?: OnChatMessageOptions) {
    (this as unknown as { ensureRealSession(): string }).ensureRealSession();
    const stream = createUIMessageStream({ execute: async ({ writer }) => {
      writer.write({ type: "start", messageId: `fake-${options?.requestId}` });
      writer.write({ type: "text-start", id: "text" });
      for (let step = 0; step < 12; step++) {
        await new Promise(resolve => setTimeout(resolve, 100));
        if (options?.abortSignal?.aborted) { writer.write({ type: "text-end", id: "text" }); writer.write({ type: "finish", finishReason: "stop" }); return; }
        writer.write({ type: "text-delta", id: "text", delta: `step-${step} ` });
      }
      writer.write({ type: "text-end", id: "text" });
      writer.write({ type: "finish", finishReason: "stop" });
    } });
    return createUIMessageStreamResponse({ stream });
  }
  protected override async onChatResponse(result: ChatResponseResult) { await super.onChatResponse(result); }
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** 弱网条件由 fixture 的 vars 提供，改档位不必改代码（scripts/start-weak-network-fixture.mjs 写入）。 */
type FixtureEnv = Env & {
  WEAK_NET_TEST_RUN?: string;
  TEST_MODE?: string;
  TEST_SHELL_MS?: string;
  TEST_AUTH_MS?: string;
  TEST_CHUNK_MS?: string;
  TEST_CHUNK_BYTES?: string;
};
const settings = (env: FixtureEnv) => ({
  runId: env.WEAK_NET_TEST_RUN ?? "manual-fixture",
  shellMs: Number(env.TEST_SHELL_MS) || 3000,
  authMs: Number(env.TEST_AUTH_MS) || 4000,
  chunkMs: Number(env.TEST_CHUNK_MS) || 12,
  chunkBytes: Number(env.TEST_CHUNK_BYTES) || 4096,
});

/** 把响应体按小块延后吐出：模拟窄带宽下浏览器边下边画的那段时间，而不是整段卡住。 */
async function throttle(response: Response, chunkMs: number, chunkBytes: number) {
  if (!response.body || response.status === 101) return response;
  const reader = response.body.getReader();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        for (let offset = 0; offset < part.value.length; offset += chunkBytes) {
          controller.enqueue(part.value.subarray(offset, Math.min(offset + chunkBytes, part.value.length)));
          if (chunkMs > 0) await sleep(chunkMs);
        }
      }
      controller.close();
    },
    cancel(reason) {
      reader.cancel(reason);
    },
  });
  const headers = new Headers(response.headers);
  // 分块后长度不再等于原值，留着 content-length 会让下游按错误长度截断。
  headers.delete("content-length");
  return new Response(stream, { status: response.status, statusText: response.statusText, headers });
}

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);
    if (!["localhost", "127.0.0.1"].includes(url.hostname)) return new Response("Local test only", { status: 403 });
    const t = settings(env as FixtureEnv);
    const requested = url.searchParams.get("mode") ?? (env as unknown as { TEST_MODE?: string }).TEST_MODE ?? "fast";
    const cookieMode = /testmode=([a-z0-9]+)/i.exec(request.headers.get("cookie") ?? "")?.[1];
    const mode = cookieMode ?? requested;
    if (mode === "slowShell") await sleep(t.shellMs);
    if (mode === "slowAuth" && (url.pathname === "/api/me" || url.pathname === "/api/auth")) await sleep(t.authMs);
    if (url.pathname === "/api/me" && mode === "auth500")
      return Response.json({ ok: false, error: "服务器开小差了" }, { status: 500 });
    // readiness 探针：scripts/start-weak-network-fixture.mjs 与 runner 都靠它判断
    // 「起来的是本次这个实例」，runId 必须回显 fixture 目录名；timings 让断言拿实测档位核对，
    // 免得 runner 与 fixture 各写一份延迟常量。
    if (url.pathname === "/__test/health")
      return Response.json({
        ok: true,
        mode,
        runId: t.runId,
        timings: { shellMs: t.shellMs, authMs: t.authMs, chunkMs: t.chunkMs, chunkBytes: t.chunkBytes },
      });
    const response = await worker.fetch(request, env);
    // WebSocket 升级必须原样返回：重包 body 会毁掉 101 握手。
    if (response.status === 101) return response;
    const headers = new Headers(response.headers);
    // fast 清掉旧 cookie，其余档位沿用同一弱网条件（页面带 mode，后续 /api/* 跟着走）。
    headers.append(
      "set-cookie",
      requested === "fast" ? "testmode=; Path=/; SameSite=Lax; Max-Age=0" : `testmode=${requested}; Path=/; SameSite=Lax; Max-Age=600`,
    );
    if (mode === "throttle") return await throttle(new Response(response.body, { status: response.status, statusText: response.statusText, headers }), t.chunkMs, t.chunkBytes);
    if (requested === "fast") return response;
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  },
  async getAgentByNameStub() { return getAgentByName; },
};
