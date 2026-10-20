// 事件台账：把「刚发生过的事」记成一条条带时刻的账，投给模型一次就划掉。
//
// 为什么单立一张表：这类动静原先都是「每轮现算」的 —— 评论条数每轮重数一遍、
// 塞进提示词，模型每轮被告知一次「有评论」，可它既不知道是什么时候发生的，
// 也不知道那是哪一场留下的，就串了场。账本把「发生过」和「提醒过」拆开：
// 写一次、说一次、说过就划掉。
//
// 两个层：
//   local  —— 只属于某一会话（如他给某条消息留了评论）。别的会话根本取不到。
//   global —— 属于「这个人」的，哪一场都该知道（如来客到访）。谁收、谁投，
//             由 cowork.ts 那边定（主屋收、主的场屋取）。

import type { SqlTag } from "./state";

export type EventScope = "local" | "global";

export interface LedgerEvent {
  id: string;
  scope: EventScope;
  /** local 专属：这件事属于哪一场；global 为空串 */
  sessionId: string;
  /** 去重与追认用的引用（如来客屋名）；不需要填空串 */
  ref: string;
  kind: string;
  /** 事件发生时刻，北京时间 ISO（带 +08:00；同偏移下字典序即时间序） */
  at: string;
  /** 一句话，直接拼进提示词 */
  text: string;
  status: "pending" | "delivered";
  created: string;
}

/** 北京时间 ISO 8601（+08:00）。存这个格式比时间戳好读，排序也对。 */
export function shanghaiIso(d: Date = new Date()): string {
  return (
    new Date(d.getTime() + 8 * 3600_000).toISOString().slice(0, 19) + "+08:00"
  );
}

/** 提示词里展示用的短时刻：2026-10-05 14:30 */
export function formatEventAt(at: string): string {
  return at.slice(0, 16).replace("T", " ");
}

interface Row {
  id: string;
  scope: string;
  session_id: string;
  ref: string;
  kind: string;
  at: string;
  text: string;
  status: string;
  created: string;
}

function toEvent(r: Row): LedgerEvent {
  return {
    id: r.id,
    scope: r.scope === "global" ? "global" : "local",
    sessionId: r.session_id,
    ref: r.ref,
    kind: r.kind,
    at: r.at,
    text: r.text,
    status: r.status === "delivered" ? "delivered" : "pending",
    created: r.created,
  };
}

export function ensureEventSchema(sql: SqlTag): void {
  sql`
    CREATE TABLE IF NOT EXISTS events (
      id         TEXT PRIMARY KEY,
      scope      TEXT NOT NULL,
      session_id TEXT NOT NULL DEFAULT '',
      ref        TEXT NOT NULL DEFAULT '',
      kind       TEXT NOT NULL,
      at         TEXT NOT NULL,
      text       TEXT NOT NULL,
      status     TEXT NOT NULL DEFAULT 'pending',
      created    TEXT NOT NULL
    )
  `;
  sql`CREATE INDEX IF NOT EXISTS idx_events_pending ON events(scope, session_id, status, at)`;
}

export function insertEvent(
  sql: SqlTag,
  e: {
    scope: EventScope;
    sessionId?: string;
    ref?: string;
    kind: string;
    at?: string;
    text: string;
  },
): LedgerEvent {
  const row: LedgerEvent = {
    id: "ev" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    scope: e.scope,
    sessionId: e.sessionId ?? "",
    ref: e.ref ?? "",
    kind: e.kind,
    at: e.at ?? shanghaiIso(),
    text: e.text.trim().slice(0, 300),
    status: "pending",
    created: new Date().toISOString(),
  };
  sql`INSERT INTO events (id, scope, session_id, ref, kind, at, text, status, created)
     VALUES (${row.id}, ${row.scope}, ${row.sessionId}, ${row.ref}, ${row.kind}, ${row.at}, ${row.text}, 'pending', ${row.created})`;
  return row;
}

/**
 * 取待报的账。local 必须点名会话 —— 不点就什么都不给，
 * 免得某一场把别场的账翻出来（串场就是这么串的）。
 */
export function listPendingEvents(
  sql: SqlTag,
  scope: EventScope,
  sessionId = "",
  limit = 20,
): LedgerEvent[] {
  const rows =
    scope === "local"
      ? sql<Row>`SELECT id, scope, session_id, ref, kind, at, text, status, created
           FROM events WHERE scope = 'local' AND session_id = ${sessionId} AND status = 'pending'
           ORDER BY at ASC LIMIT ${limit}`
      : sql<Row>`SELECT id, scope, session_id, ref, kind, at, text, status, created
           FROM events WHERE scope = 'global' AND status = 'pending'
           ORDER BY at ASC LIMIT ${limit}`;
  return rows.map(toEvent);
}

/** 说过就划掉 —— 同一条账不再报第二次。 */
export function markEventsDelivered(sql: SqlTag, ids: string[]): void {
  for (const id of ids) {
    sql`UPDATE events SET status = 'delivered' WHERE id = ${id}`;
  }
}

/** 某个时间点之后出现过某类动静的 ref（房间）。用来判断「这间屋最近有没有真的说话」。 */
export function listEventRefs(
  sql: SqlTag,
  kind: string,
  sinceIso: string,
): string[] {
  ensureEventSchema(sql);
  return sql<{ ref: string }>`
    SELECT DISTINCT ref FROM events
    WHERE scope = 'global' AND kind = ${kind} AND created > ${sinceIso} AND ref <> ''
  `.map((r) => r.ref);
}

/** 同一屋、同一类动静在窗口内是否已经记过 —— 重连、连发不该刷屏。 */
export function hasRecentEvent(
  sql: SqlTag,
  scope: EventScope,
  ref: string,
  kind: string,
  withinMs: number,
): boolean {
  const since = new Date(Date.now() - Math.max(0, withinMs)).toISOString();
  const rows = sql<{ n: number }>`
    SELECT COUNT(*) AS n FROM events
    WHERE scope = ${scope} AND ref = ${ref} AND kind = ${kind} AND created > ${since}`;
  return (rows[0]?.n ?? 0) > 0;
}

/** 裁账：已投递且过期的先清，再兜底按条数裁到上限 —— 账本是流水，不该无限长。 */
export function pruneEvents(sql: SqlTag, cap = 300): void {
  const cutoff = new Date(Date.now() - 3 * 86400_000).toISOString();
  sql`DELETE FROM events WHERE status = 'delivered' AND created < ${cutoff}`;
  sql`DELETE FROM events WHERE id NOT IN (SELECT id FROM events ORDER BY created DESC LIMIT ${cap})`;
}
