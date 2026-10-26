// 登录失败计数：持久化在主屋 DO 的 SQLite，按「IP 哈希 + 目标」退避。
// 只记失败，不阻塞成功登录的路径 —— 正常用户不会多等一次 DO。

import type { SqlTag } from "./state";

const WINDOW_MS = 10 * 60 * 1000;
const FAIL_LIMIT = 5;
const LOCK_MS = 60 * 1000;
const HARD_FAIL_LIMIT = 10;
const HARD_LOCK_MS = 5 * 60 * 1000;
const KEEP_MS = 24 * 60 * 60 * 1000;

export interface LoginThrottleResult {
  /** 还要等几秒；0 = 没锁 */
  blocked: number;
  /** 当前窗口内的失败数 */
  count: number;
}

export function ensureLoginThrottleSchema(sql: SqlTag): void {
  sql`CREATE TABLE IF NOT EXISTS login_throttle (
       key           TEXT PRIMARY KEY,
       failures      INTEGER NOT NULL DEFAULT 0,
       first_at      INTEGER NOT NULL,
       last_at       INTEGER NOT NULL,
       blocked_until INTEGER NOT NULL DEFAULT 0
     )`;
  sql`CREATE INDEX IF NOT EXISTS idx_login_throttle_last ON login_throttle(last_at)`;
}

/** 记一次失败并返回是否进入锁定；窗口内第 5 次锁 1 分钟，第 10 次锁 5 分钟。 */
export function bumpLoginFailure(
  sql: SqlTag,
  key: string,
  now = Date.now(),
): LoginThrottleResult {
  const rows = sql<{
    failures: number;
    first_at: number;
    blocked_until: number;
  }>`SELECT failures, first_at, blocked_until FROM login_throttle WHERE key = ${key}`;
  const row = rows[0];
  if (row && row.blocked_until > now) {
    return {
      blocked: Math.ceil((row.blocked_until - now) / 1000),
      count: row.failures,
    };
  }
  let failures = 1;
  let firstAt = now;
  if (row && now - row.first_at <= WINDOW_MS) {
    failures = row.failures + 1;
    firstAt = row.first_at;
  }
  const blockedUntil =
    failures >= HARD_FAIL_LIMIT
      ? now + HARD_LOCK_MS
      : failures >= FAIL_LIMIT
        ? now + LOCK_MS
        : 0;
  sql`INSERT OR REPLACE INTO login_throttle
      (key, failures, first_at, last_at, blocked_until)
      VALUES (${key}, ${failures}, ${firstAt}, ${now}, ${blockedUntil})`;
  return {
    blocked: blockedUntil > now ? Math.ceil((blockedUntil - now) / 1000) : 0,
    count: failures,
  };
}

export function clearLoginFailures(sql: SqlTag, key: string): void {
  sql`DELETE FROM login_throttle WHERE key = ${key}`;
}

export function pruneLoginThrottle(sql: SqlTag, cap = 2000): void {
  sql`DELETE FROM login_throttle WHERE last_at < ${Date.now() - KEEP_MS}`;
  sql`DELETE FROM login_throttle WHERE key NOT IN (
        SELECT key FROM login_throttle ORDER BY last_at DESC LIMIT ${cap}
      )`;
}
