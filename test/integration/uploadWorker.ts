// 上传通道端到端验证用的 Worker：只用生产路由，不接模型服务。
// 仅允许 localhost，不作为公网入口。
import worker from "../../src/index";
import { CoworkAgent as ProductionAgent } from "../../src/agent/cowork";

export class CoworkAgent extends ProductionAgent {}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (!["localhost", "127.0.0.1"].includes(url.hostname))
      return new Response("Local test only", { status: 403 });
    if (url.pathname === "/__test/health") return Response.json({ ok: true });
    const started = Date.now();
    const response = await worker.fetch(request, env);
    const headers = new Headers(response.headers);
    headers.set("x-server-ms", String(Date.now() - started));
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  },
};
