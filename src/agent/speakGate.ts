// 「该不该开口」—— ericher 主动说话前的最后一道门。
//
// 为什么需要这道门：提醒到点，只说明「我知道了这件事」，
// 不等于「我该现在打断他」。一个每有动静就开口的助手不是省心，是噪音；
// 用不了多久他就会把提醒全关掉，那我这个能力就等于没有。
//
// 人的做法是三层判断，这里照做：
//   一、这件事值不值得说（内容）—— 在生成那句话时判断，不值就 SKIP
//   二、现在这个点合不合适说（时机）—— 安静时段把话按到早上
//   三、一次说几件（节奏）—— 同一批攒一下，合成一条说
//
// 前两层的生成时机各有归属（cowork.ts 的 fireReminder），
// 这个文件负责第三层和时机判定的纯逻辑，都是可以单独测的。

import type { SqlTag } from "./state";

// ── 时机：安静时段 ─────────────────────────────────────

/**
 * 安静时段的起止（北京时间，小时）。
 * 他习惯深夜工作，但「深夜还在」不等于「深夜欢迎被打断」——
 * 这两件事常常被混为一谈，而对一个守在门口的助手来说，分清它们是基本礼貌。
 */
export const QUIET_START_HOUR = 23;
export const QUIET_END_HOUR = 8;

/** 北京时间的小时（0-23）。Worker 跑在 UTC，而中国不实行夏令时，加 8 小时就是准确答案。 */
export function beijingHour(d: Date = new Date()): number {
  return new Date(d.getTime() + 8 * 3600_000).getUTCHours();
}

/** 现在是不是安静时段。 */
export function inQuietHours(d: Date = new Date()): boolean {
  const h = beijingHour(d);
  return h >= QUIET_START_HOUR || h < QUIET_END_HOUR;
}

/**
 * 安静时段什么时候结束；不在安静时段内返回 null。
 *
 * 用途是「把凌晨该说的话按到早上」，不是「不说」——
 * 丢掉等于我忘了，那比吵醒他更糟：他托付给我的事，我给弄没了。
 */
export function quietEndsAt(d: Date = new Date()): Date | null {
  if (!inQuietHours(d)) return null;
  const h = beijingHour(d);
  const bj = new Date(d.getTime() + 8 * 3600_000);
  // 23 点之后属于「今晚这个安静时段」，结束在明天早上；0-8 点结束在今天早上
  const day =
    h >= QUIET_START_HOUR
      ? new Date(bj.getTime() + 24 * 3600_000).toISOString().slice(0, 10)
      : bj.toISOString().slice(0, 10);
  return new Date(
    `${day}T${String(QUIET_END_HOUR).padStart(2, "0")}:00:00+08:00`,
  );
}

/**
 * 北京时间的今天零点，用来数「今天她主动开口几次」。按他的日子算，不按 UTC。
 *
 * 返回的是归一过的 ISO（UTC 的 Z 形式），不是带 +08:00 的那种 ——
 * 库里 created 存的就是 Z 形式，两边格式不一样的话字符串比大小会得出荒唐的结果。
 */
export function beijingDayStart(d: Date = new Date()): string {
  const day = new Date(d.getTime() + 8 * 3600_000).toISOString().slice(0, 10);
  return new Date(`${day}T00:00:00+08:00`).toISOString();
}

// ── 节奏：攒一下再说 ───────────────────────────────────

/**
 * 攒多久再说。
 * 盯梢常常是同一分钟里好几条一起变（都是「每小时看一次」的，自然同时醒），
 * 立刻说就是几条连珠炮。等一分半，该来的都来齐了，一句话讲完。
 */
export const SAY_DEBOUNCE_MS = 90_000;

/** 落库的主动消息保留多久。留一个月，是为了「今天说了几次」数得出来。 */
const SAY_KEEP_DAYS = 30;

interface PendingSay {
  id: string;
  sessionId: string;
  line: string;
  created: string;
}

/** 合并后要说的一句话：属于哪一场、说什么、由哪几行攒出来的。 */
interface MergedSay {
  sessionId: string;
  line: string;
  ids: string[];
}

interface SayRow {
  id: string;
  session_id: string;
  line: string;
  created: string;
}

export function ensureSpeakSchema(sql: SqlTag): void {
  sql`CREATE TABLE IF NOT EXISTS proactive_says (
       id         TEXT PRIMARY KEY,
       session_id TEXT NOT NULL,
       line       TEXT NOT NULL,
       created    TEXT NOT NULL,
       delivered  INTEGER NOT NULL DEFAULT 0
     )`;
  sql`CREATE INDEX IF NOT EXISTS idx_proactive_says_pending ON proactive_says(delivered, created)`;
}

export function enqueueSay(
  sql: SqlTag,
  sessionId: string,
  line: string,
): PendingSay {
  const row: PendingSay = {
    id: crypto.randomUUID(),
    sessionId,
    line,
    created: new Date().toISOString(),
  };
  sql`INSERT INTO proactive_says (id, session_id, line, created, delivered)
      VALUES (${row.id}, ${row.sessionId}, ${row.line}, ${row.created}, 0)`;
  return row;
}

export function listPendingSays(sql: SqlTag): PendingSay[] {
  const rows = sql<SayRow>`
    SELECT id, session_id, line, created FROM proactive_says
    WHERE delivered = 0 ORDER BY created ASC`;
  return rows.map((r) => ({
    id: r.id,
    sessionId: r.session_id,
    line: r.line,
    created: r.created,
  }));
}

/** 一条一条标，不用 IN 批量：批量语句一旦失败，整批都要重说。 */
export function markSaysDelivered(sql: SqlTag, ids: string[]): void {
  for (const id of ids)
    sql`UPDATE proactive_says SET delivered = 1 WHERE id = ${id}`;
}

/** 今天主动开口了几次（已说出口的）。面板上给他看，多了他会知道该关掉几条盯梢。 */
export function countSaysSince(sql: SqlTag, sinceIso: string): number {
  const rows = sql<{ n: number }>`
    SELECT COUNT(*) AS n FROM proactive_says WHERE delivered = 1 AND created >= ${sinceIso}`;
  return rows[0]?.n ?? 0;
}

/** 删掉太老的记录。只是记账，留着没用。 */
export function pruneSays(sql: SqlTag, now = Date.now()): void {
  const before = new Date(now - SAY_KEEP_DAYS * 86400_000).toISOString();
  sql`DELETE FROM proactive_says WHERE created < ${before}`;
}

/**
 * 把攒着的几行合成要说的话，按会话分组。
 *
 * 为什么按会话分而不是合成一条：这些话属于不同的场次，硬并到一起，
 * 等他切回去看那一场时就对不上了——「当时说的那句话」得在它该在的地方。
 *
 * 一条就是一条，不加任何引子：加了反而像在解释自己为什么要说话。
 * 三条以上才给个「几件事一起说」，否则一屏铺下来像刷屏。
 */
export function mergeSays(says: PendingSay[]): MergedSay[] {
  const bySession = new Map<string, PendingSay[]>();
  for (const s of says) {
    const arr = bySession.get(s.sessionId);
    if (arr) arr.push(s);
    else bySession.set(s.sessionId, [s]);
  }
  return [...bySession.entries()].map(([sessionId, group]) => ({
    sessionId,
    line:
      group.length === 1
        ? group[0].line
        : (group.length >= 3 ? "几件事一起说：\n\n" : "") +
          group.map((g) => g.line).join("\n\n"),
    ids: group.map((g) => g.id),
  }));
}
