import type { SqlTag } from "../state";

/** 一张提问卡只能接收一次答案；响应丢失后重试同一答案仍回成功。 */
export class AskDelivery {
  constructor(private readonly sql: SqlTag) {}
  deliver(id: string, answer: string, resolve: () => boolean): boolean {
    this.sql`CREATE TABLE IF NOT EXISTS ask_deliveries (
      id TEXT PRIMARY KEY, answer TEXT NOT NULL, delivered_at INTEGER NOT NULL
    )`;
    const normalized = answer.trim();
    const previous = this.sql<{ answer: string }>`SELECT answer FROM ask_deliveries WHERE id = ${id}`[0];
    if (previous) return previous.answer === normalized;
    if (!resolve()) return false;
    const now = Date.now();
    this.sql`INSERT INTO ask_deliveries (id, answer, delivered_at) VALUES (${id}, ${normalized}, ${now})`;
    this.sql`DELETE FROM ask_deliveries WHERE delivered_at < ${now - 30 * 86400_000}`;
    return true;
  }
}
