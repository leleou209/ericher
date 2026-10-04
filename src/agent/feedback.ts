// 消息反馈：点赞 / 点踩 / 评论。
//
// 为什么不塞进 state blob：投票与评论是按 message id 关联的明细，条数随对话增长，
// 放 blob 里每次都要整体重写。这里只存 id，正文由 cowork.ts 从 this.messages 现取。
//
// 评论是「会话的补充上下文」——界面上只显示条数徽标，正文不进上下文，
// 只有 AI 主动调用 feedback 工具才读得到。

import type { SqlTag } from "./state";

/** 1 = 赞，-1 = 踩。前端对同一条消息再点一次即取消。 */
export type VoteValue = 1 | -1;

/** 评论作者：ai = ericher 自己，其余是登录角色（admin / user） */
export const AI_AUTHOR = "ai";

interface VoteRow {
  messageId: string;
  voter: string;
  value: number;
  ts: number;
}

export interface CommentRow {
  id: string;
  messageId: string;
  author: string;
  content: string;
  ts: number;
}

/** 单条消息的赞踩汇总（AI 的 signal 与提示词信号都用它） */
interface VoteTotal {
  messageId: string;
  score: number;
  up: number;
  down: number;
}

export function ensureFeedbackSchema(sql: SqlTag): void {
  sql`
    CREATE TABLE IF NOT EXISTS msg_votes (
      message_id TEXT NOT NULL,
      voter      TEXT NOT NULL,
      value      INTEGER NOT NULL,
      ts         INTEGER NOT NULL,
      PRIMARY KEY (message_id, voter)
    )
  `;
  sql`
    CREATE TABLE IF NOT EXISTS msg_comments (
      id         TEXT PRIMARY KEY,
      message_id TEXT NOT NULL,
      author     TEXT NOT NULL,
      content    TEXT NOT NULL,
      ts         INTEGER NOT NULL
    )
  `;
  sql`CREATE INDEX IF NOT EXISTS idx_msg_comments_message ON msg_comments(message_id)`;
  // 标重：管理员要求 ericher 重视某条自己的发言。可多条并存，各自单独取消。
  sql`
    CREATE TABLE IF NOT EXISTS msg_flags (
      message_id TEXT PRIMARY KEY,
      ts         INTEGER NOT NULL
    )
  `;
}

/** 标重开关。返回切换后的状态。 */
export function toggleFlag(sql: SqlTag, messageId: string): boolean {
  const rows = sql<{
    message_id: string;
  }>`SELECT message_id FROM msg_flags WHERE message_id = ${messageId}`;
  if (rows.length) {
    sql`DELETE FROM msg_flags WHERE message_id = ${messageId}`;
    return false;
  }
  sql`INSERT INTO msg_flags (message_id, ts) VALUES (${messageId}, ${Date.now()})`;
  return true;
}

/** 被标重的消息 id，最近的在前。 */
export function listFlags(sql: SqlTag): string[] {
  return sql<{ messageId: string }>`
    SELECT message_id AS messageId FROM msg_flags ORDER BY ts DESC LIMIT 100`.map(
    (r) => r.messageId,
  );
}

/**
 * 一条消息一个投票人只留一票：同值再投 = 取消，异值 = 改票。
 * 返回生效后的票值，null 表示已取消。
 */
export function setVote(
  sql: SqlTag,
  messageId: string,
  voter: string,
  value: VoteValue,
): VoteValue | null {
  const rows = sql<{ value: number }>`
    SELECT value FROM msg_votes WHERE message_id = ${messageId} AND voter = ${voter}`;
  if (rows[0]?.value === value) {
    sql`DELETE FROM msg_votes WHERE message_id = ${messageId} AND voter = ${voter}`;
    return null;
  }
  sql`
    INSERT INTO msg_votes (message_id, voter, value, ts)
    VALUES (${messageId}, ${voter}, ${value}, ${Date.now()})
    ON CONFLICT(message_id, voter) DO UPDATE SET value = excluded.value, ts = excluded.ts
  `;
  return value;
}

/** 全部投票。条数上限 ≈ 消息数 × 投票人数，量很小，前端一次全拿。 */
export function listVotes(sql: SqlTag): VoteRow[] {
  return sql<VoteRow>`
    SELECT message_id AS messageId, voter, value, ts FROM msg_votes ORDER BY ts DESC LIMIT 500`;
}

/** 按消息聚合的赞踩，最近的在前。 */
export function voteTotals(sql: SqlTag): VoteTotal[] {
  return sql<VoteTotal>`
    SELECT message_id AS messageId,
           SUM(value) AS score,
           SUM(CASE WHEN value > 0 THEN 1 ELSE 0 END) AS up,
           SUM(CASE WHEN value < 0 THEN 1 ELSE 0 END) AS down
    FROM msg_votes GROUP BY message_id ORDER BY MAX(ts) DESC LIMIT 50`;
}

export function addComment(
  sql: SqlTag,
  messageId: string,
  author: string,
  content: string,
): CommentRow {
  const row: CommentRow = {
    id: "c" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    messageId,
    author,
    content: content.trim().slice(0, 500),
    ts: Date.now(),
  };
  sql`
    INSERT INTO msg_comments (id, message_id, author, content, ts)
    VALUES (${row.id}, ${row.messageId}, ${row.author}, ${row.content}, ${row.ts})
  `;
  return row;
}

export function listComments(
  sql: SqlTag,
  messageId: string,
  limit = 200,
): CommentRow[] {
  return sql<CommentRow>`
    SELECT id, message_id AS messageId, author, content, ts
    FROM msg_comments WHERE message_id = ${messageId} ORDER BY ts ASC LIMIT ${limit}`;
}

/** 有评论的消息 + 各自条数，最近的在前。 */
export function commentCounts(
  sql: SqlTag,
  limit = 100,
): Array<{ messageId: string; n: number }> {
  return sql<{ messageId: string; n: number }>`
    SELECT message_id AS messageId, COUNT(*) AS n
    FROM msg_comments GROUP BY message_id ORDER BY MAX(ts) DESC LIMIT ${limit}`;
}
