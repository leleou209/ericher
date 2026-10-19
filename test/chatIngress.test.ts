import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { ChatIngress } from "../src/agent/adapters/chatIngress";
import { AskDelivery } from "../src/agent/adapters/askDelivery";
import type { SqlTag } from "../src/agent/state";

function fixture() {
  const db = new DatabaseSync(":memory:");
  const sql = ((strings: TemplateStringsArray, ...values: (string | number | null)[]) =>
    db.prepare(strings.join("?")).all(...values)) as SqlTag;
  const sent: Record<string, unknown>[] = [];
  const connection = { send: (frame: string) => sent.push(JSON.parse(frame)) };
  return { db, sql, connection, sent };
}
const user = (id = "user-1") => ({ id, role: "user", parts: [{ type: "text", text: "同一内容" }] });
const request = (id: string, messages = [user()], trigger = "submit-message") => JSON.stringify({
  type: "cf_agent_use_chat_request", id, init: { method: "POST", body: JSON.stringify({ messages, trigger }) },
});

describe("聊天提交防重：真实SQLite，模拟模型/工具执行计数", () => {
  it("运行中及结束后重复提交同一消息不再启动工作，只恢复原任务", async () => {
    const f = fixture();
    try {
      const ingress = new ChatIngress(f.sql);
      let finish!: () => void;
      let runs = 0;
      const frames: string[] = [];
      const next = async (_: unknown, frame: string) => {
        frames.push(JSON.parse(frame).type);
        if (JSON.parse(frame).type === "cf_agent_use_chat_request") {
          runs++;
          await new Promise<void>(r => { finish = r; });
        }
      };
      const first = ingress.dispatch(f.connection, request("r1"), next, () => []);
      expect(ingress.running).toBe(true);
      await ingress.dispatch(f.connection, request("r2"), next, () => []);
      expect(runs).toBe(1);
      expect(frames.at(-1)).toBe("cf_agent_stream_resume_request");
      finish(); await first;
      expect(ingress.running).toBe(false);
      // 实例重建后依旧记得，不依赖内存 Set。
      await new ChatIngress(f.sql).dispatch(f.connection, request("r3"), next, () => []);
      expect(runs).toBe(1);
      expect(f.sent.filter(x => x.done)).toHaveLength(2);
    } finally { f.db.close(); }
  });
  it("相同正文不同消息id是合法新消息；显式重来允许一轮，重复同一重来请求仍防重", async () => {
    const f = fixture();
    try {
      const gate = new ChatIngress(f.sql);
      let runs = 0;
      const next = async (_: unknown, frame: string) => {
        if (JSON.parse(frame).type === "cf_agent_use_chat_request") runs++;
      };
      await gate.dispatch(f.connection, request("r1"), next, () => []);
      await gate.dispatch(f.connection, request("r2", [user("user-2")]), next, () => []);
      await gate.dispatch(f.connection, request("regen", [user()], "regenerate-message"), next, () => []);
      await gate.dispatch(f.connection, request("regen", [user()], "regenerate-message"), next, () => []);
      expect(runs).toBe(3);
    } finally { f.db.close(); }
  });
  it("旧客户端/收据过期仍通过权威历史阻止重新执行已收取用户消息", async () => {
    const f = fixture();
    try {
      const next = vi.fn(async (_: unknown, _frame: string) => {});
      await new ChatIngress(f.sql).dispatch(f.connection, request("r1"), next, () => [user()]);
      expect(JSON.parse(next.mock.calls[0]?.[1] ?? "{}").type).toBe("cf_agent_stream_resume_request");
    } finally { f.db.close(); }
  });
  it("不拦截恢复、停止、工具结果续跑；失败结果不确定时不撤销收据", async () => {
    const f = fixture();
    try {
      const gate = new ChatIngress(f.sql);
      const next = vi.fn(async (_: unknown, frame: string) => {
        if (JSON.parse(frame).id === "failure") throw new Error("response lost");
      });
      await expect(gate.dispatch(f.connection, request("failure"), next, () => [])).rejects.toThrow("response lost");
      expect(gate.running).toBe(false);
      await gate.dispatch(f.connection, request("retry"), next, () => []);
      for (const type of ["cf_agent_stream_resume_request", "cf_agent_stream_resume_ack", "cf_agent_chat_request_cancel"])
        await gate.dispatch(f.connection, JSON.stringify({ type }), next, () => []);
      const continuation = JSON.stringify({ type: "cf_agent_use_chat_request", id: "tool-1", init: {
        method: "POST", body: JSON.stringify({ messages: [user(), { id: "a1", role: "assistant", parts: [] }] }),
      } });
      await gate.dispatch(f.connection, continuation, next, () => [user()]);
      expect(next.mock.calls.filter(c => JSON.parse(c[1]).type === "cf_agent_use_chat_request")).toHaveLength(2);
    } finally { f.db.close(); }
  });
});

describe("提问卡响应丢失后的幂等作答", () => {
  it("同一答案重试、实例重建都返回成功，但只resolve一次", () => {
    const f = fixture();
    try {
      const resolve = vi.fn(() => true);
      expect(new AskDelivery(f.sql).deliver("ask-1", " yes ", resolve)).toBe(true);
      expect(new AskDelivery(f.sql).deliver("ask-1", "yes", resolve)).toBe(true);
      expect(resolve).toHaveBeenCalledTimes(1);
      expect(new AskDelivery(f.sql).deliver("ask-1", "no", resolve)).toBe(false);
      expect(resolve).toHaveBeenCalledTimes(1);
    } finally { f.db.close(); }
  });
  it("过期卡不伪装送达，也不启动任何新轮次", () => {
    const f = fixture();
    try {
      const resolve = vi.fn(() => false);
      expect(new AskDelivery(f.sql).deliver("expired", "yes", resolve)).toBe(false);
      expect(f.db.prepare("SELECT * FROM ask_deliveries").all()).toEqual([]);
    } finally { f.db.close(); }
  });
});
