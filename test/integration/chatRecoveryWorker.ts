// 仅用于 localhost 隔离验证，不接任何模型服务，也不能作为公网入口。
import worker from "../../src/index";
import { CoworkAgent as ProductionAgent } from "../../src/agent/cowork";
import { createUIMessageStream, createUIMessageStreamResponse, type ToolSet, type StreamTextOnFinishCallback } from "ai";
import type { ChatResponseResult, OnChatMessageOptions } from "@cloudflare/ai-chat";
import { getAgentByName } from "agents";

export class CoworkAgent extends ProductionAgent {
  override async maintenance(_system: string, _user: string): Promise<string> { return ""; }
  metrics() {
    this.sql`CREATE TABLE IF NOT EXISTS test_runs (id INTEGER PRIMARY KEY, starts INTEGER, tools INTEGER, completed INTEGER, aborted INTEGER)`;
    this.sql`INSERT OR IGNORE INTO test_runs VALUES (1, 0, 0, 0, 0)`;
    return this.sql<{ starts: number; tools: number; completed: number; aborted: number }>`SELECT starts, tools, completed, aborted FROM test_runs WHERE id = 1`[0];
  }
  disconnectForTest() {
    for (const connection of this.getConnections()) connection.close(1012, "local simulated network interruption");
    return true;
  }
  override async onChatMessage(_finish: StreamTextOnFinishCallback<ToolSet>, options?: OnChatMessageOptions) {
    (this as unknown as { ensureRealSession(): string }).ensureRealSession();
    this.metrics();
    this.sql`UPDATE test_runs SET starts = starts + 1, tools = tools + 1 WHERE id = 1`;
    const text = this.messages.at(-1)?.parts.filter(p => p.type === "text").map(p => p.text).join(" ") ?? "";
    const delay = text.includes("ui-long") ? 3000 : text.includes("slow") ? 800 : 100;
    const stream = createUIMessageStream({ execute: async ({ writer }) => {
      writer.write({ type: "start", messageId: `fake-${options?.requestId}` });
      writer.write({ type: "text-start", id: "text" });
      for (let step = 0; step < 12; step++) {
        await new Promise(r => setTimeout(r, delay));
        if (options?.abortSignal?.aborted) {
          this.sql`UPDATE test_runs SET aborted = aborted + 1 WHERE id = 1`;
          writer.write({ type: "text-end", id: "text" });
          writer.write({ type: "finish", finishReason: "stop" });
          return;
        }
        writer.write({ type: "text-delta", id: "text", delta: `step-${step} ` });
      }
      this.sql`UPDATE test_runs SET completed = completed + 1 WHERE id = 1`;
      writer.write({ type: "text-end", id: "text" });
      writer.write({ type: "finish", finishReason: "stop" });
    } });
    return createUIMessageStreamResponse({ stream });
  }
  // 保留生产快照/目录逻辑；假模型没有外部调用。
  protected override async onChatResponse(result: ChatResponseResult) {
    await super.onChatResponse(result);
  }
}

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);
    if (!["localhost", "127.0.0.1"].includes(url.hostname)) return new Response("Local test only", { status: 403 });
    if (url.pathname === "/__test/health")
      return Response.json({ runId: (env as unknown as { CHAT_TEST_RUN?: string }).CHAT_TEST_RUN ?? "manual-fixture" });
    if (url.pathname === "/__test/disconnect" && request.method === "POST") {
      const agent = await getAgentByName(env.COWORK_AGENT, url.searchParams.get("room") ?? "default");
      return Response.json(await (agent as unknown as { disconnectForTest(): Promise<boolean> }).disconnectForTest());
    }
    if (url.pathname === "/__test/metrics") {
      const agent = await getAgentByName(env.COWORK_AGENT, url.searchParams.get("room") ?? "default");
      return Response.json(await (agent as unknown as { metrics(): Promise<unknown> }).metrics());
    }
    return worker.fetch(request, env);
  },
};
