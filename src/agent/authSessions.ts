// 服务端会话：Cookie 只带随机 sid，身份与过期都在主屋的 SQLite 里。
// 与旧的 HMAC 自包含票的区别：登出/撤销能真生效，Cookie 里也读不到 role/type/card。

import type { SqlTag } from "./state";

export interface AuthSessionRow {
  hash: string;
  role: string;
  type: string;
  card: string;
  created: string;
  lastSeen: string;
  expires: number;
}

interface Row {
  hash: string;
  role: string;
  type: string;
  card: string;
  created: string;
  last_seen: string;
  expires: number;
}

export function ensureAuthSessionSchema(sql: SqlTag): void {
  sql`CREATE TABLE IF NOT EXISTS auth_sessions (
       hash       TEXT PRIMARY KEY,
       role       TEXT NOT NULL,
       type       TEXT NOT NULL DEFAULT '',
       card       TEXT NOT NULL DEFAULT '',
       created    TEXT NOT NULL,
       last_seen  TEXT NOT NULL,
       expires    INTEGER NOT NULL
     )`;
  sql`CREATE INDEX IF NOT EXISTS idx_auth_sessions_expires ON auth_sessions(expires)`;
}

export function insertAuthSession(sql: SqlTag, row: AuthSessionRow): void {
  sql`INSERT OR REPLACE INTO auth_sessions
      (hash, role, type, card, created, last_seen, expires)
      VALUES (${row.hash}, ${row.role}, ${row.type}, ${row.card},
              ${row.created}, ${row.lastSeen}, ${row.expires})`;
}

export function getAuthSession(
  sql: SqlTag,
  hash: string,
): AuthSessionRow | null {
  const rows = sql<Row>`
    SELECT hash, role, type, card, created, last_seen, expires
    FROM auth_sessions WHERE hash = ${hash}`;
  if (!rows.length) return null;
  const r = rows[0];
  return {
    hash: r.hash,
    role: r.role,
    type: r.type,
    card: r.card,
    created: r.created,
    lastSeen: r.last_seen,
    expires: r.expires,
  };
}

/** 续期：只延长有效会话；已过期/不存在返回 false。 */
export function touchAuthSession(
  sql: SqlTag,
  hash: string,
  expires: number,
  lastSeen: string,
): boolean {
  const row = getAuthSession(sql, hash);
  if (!row || row.expires <= Date.now()) return false;
  sql`UPDATE auth_sessions SET expires = ${expires}, last_seen = ${lastSeen}
      WHERE hash = ${hash}`;
  return true;
}

export function revokeAuthSession(sql: SqlTag, hash: string): boolean {
  const row = getAuthSession(sql, hash);
  if (!row) return false;
  sql`DELETE FROM auth_sessions WHERE hash = ${hash}`;
  return true;
}

/** 账号级刷新：管理员清 role=admin，持卡人清这张卡；返回撤掉的会话数。 */
export function revokeAuthSessions(
  sql: SqlTag,
  filter: { role?: "admin"; card?: string },
): number {
  const rows =
    filter.role === "admin"
      ? sql<{ n: number }>`
          SELECT COUNT(*) AS n FROM auth_sessions WHERE role = 'admin'`
      : sql<{ n: number }>`
          SELECT COUNT(*) AS n FROM auth_sessions WHERE card = ${filter.card || ""}`;
  const count = rows[0]?.n ?? 0;
  if (filter.role === "admin")
    sql`DELETE FROM auth_sessions WHERE role = 'admin'`;
  else sql`DELETE FROM auth_sessions WHERE card = ${filter.card || ""}`;
  return count;
}

/** 过期一周以上的清掉；再按过期时间留最近 1000 条，防止无限长。 */
export function pruneAuthSessions(sql: SqlTag, cap = 1000): void {
  sql`DELETE FROM auth_sessions WHERE expires < ${Date.now() - 7 * 86400_000}`;
  sql`DELETE FROM auth_sessions WHERE hash NOT IN (
        SELECT hash FROM auth_sessions ORDER BY expires DESC LIMIT ${cap}
      )`;
}
