import type { SqlTag } from "../state";

type ChatMessage = { id: string; role: string };
type Connection = { send(message: string): void };
type Dispatch = (connection: Connection, message: string) => void | Promise<unknown>;

/** 在 SDK 写入消息或启动模型之前防重。凭消息 ID 去重，不凭正文判断。 */
export class ChatIngress {
  private inFlight = 0;
  get running(): boolean { return this.inFlight > 0; }
  constructor(private readonly sql: SqlTag) {}

  private ensureSchema() {
    this.sql`CREATE TABLE IF NOT EXISTS chat_submissions (
      id TEXT PRIMARY KEY, accepted_at INTEGER NOT NULL
    )`;
  }

  async dispatch(connection: Connection, message: string, next: Dispatch,
    history: () => ChatMessage[], now = Date.now()): Promise<unknown> {
    let frame: { type?: string; id?: string; init?: { method?: string; body?: string } };
    let body: { trigger?: string; messages?: ChatMessage[] };
    try {
      frame = JSON.parse(message);
      if (frame.type !== "cf_agent_use_chat_request" || frame.init?.method !== "POST")
        return next(connection, message);
      body = JSON.parse(frame.init.body ?? "");
    } catch { return next(connection, message); }
    if (!body || typeof body !== "object") return next(connection, message);
    if (typeof frame.id !== "string" || !frame.id || frame.id.length > 128)
      return next(connection, message);
    const last = Array.isArray(body.messages) ? body.messages.at(-1) : undefined;
    const user = body.trigger !== "regenerate-message" && last?.role === "user" &&
      typeof last.id === "string" && last.id.length > 0 && last.id.length <= 128 ? last : null;
    const key = user ? `user:${user.id}` : `request:${frame.id}`;
    this.ensureSchema();
    const duplicate = this.sql<{ id: string }>`SELECT id FROM chat_submissions WHERE id = ${key}`.length > 0 ||
      (!!user && history().some(m => m.id === user.id && m.role === "user"));
    if (duplicate) {
      // 结束重复的客户端请求，再同步权威历史、握手恢复原流。绝不再提交一轮。
      connection.send(JSON.stringify({ type: "cf_agent_use_chat_response", id: frame.id, body: "", done: true }));
      connection.send(JSON.stringify({ type: "cf_agent_chat_messages", messages: history() }));
      return next(connection, JSON.stringify({ type: "cf_agent_stream_resume_request" }));
    }
    // 无 await 的查重/登记先于 SDK：同一 DO 中连发两次也只能认领一次。
    this.sql`INSERT INTO chat_submissions (id, accepted_at) VALUES (${key}, ${now})`;
    this.sql`DELETE FROM chat_submissions WHERE accepted_at < ${now - 30 * 86400_000}`;
    // 失败也不撤销认领：结果可能已提交。重新生成是显式的新请求。
    this.inFlight++;
    try { return await next(connection, message); }
    finally { this.inFlight--; }
  }
}
