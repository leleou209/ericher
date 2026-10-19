// 记忆库：memories 表（SQLite） + bge-m3 embedding + Vectorize 语义检索。
// 不用 state.longMemory：上千条塞单个 JSON blob 会写放大、并发丢更新。

import type { MemEntry, Sensitivity, SqlTag } from "./state";
import { normalizeSentiment, SENSITIVITIES, TAG_GATE_LEVELS } from "./state";
import { usage } from "./usage";

const EMBED_MODEL = "@cf/baai/bge-m3";
/** 单次检索时最多加载的记忆条数，防止表无限增长后拖慢一轮对话 */
const SCAN_LIMIT = 1000;

/** 只声明用到的部分，避免依赖生成的 Vectorize 类型细节 */
interface VectorIndex {
  upsert(
    vectors: Array<{
      id: string;
      values: number[];
      metadata?: Record<string, unknown>;
    }>,
  ): Promise<unknown>;
  query(
    values: number[],
    options?: { topK?: number; returnMetadata?: "none" | "indexed" | "all" },
  ): Promise<{ matches: Array<{ id: string; score: number }> }>;
  deleteByIds?(ids: string[]): Promise<unknown>;
}

interface AiRunner {
  run(model: string, inputs: Record<string, unknown>): Promise<unknown>;
}

interface MemRow {
  id: string;
  date: string;
  type: string;
  tags: string;
  weight: number;
  shelf: string;
  person: string;
  visibility: string;
  content: string;
  accessed: number;
  learned: string;
  superseded_by: string;
  volatility: string;
  verified: string;
  valid_at: string;
  invalid_at: string;
  conflicts_with: string;
  title: string;
  file_key: string;
  session_id: string;
  sentiment: string;
  sensitivity: string;
  score: number;
  owner_key: string;
  visibility_hold: number;
  dedupe_key: string;
  last_accessed_at: number;
}

/** 只作废、不指向替代者的哨兵值（id 都以 m 开头，不会撞上）。 */
const RETIRED = "retired";

/** 会变的记忆多久没复核就提醒一次；30 天是粗数，「该问一句了」不必精确。 */
export const REVIEW_DAYS = 30;

/** 疑问挂过这么久还没对上，就不再进提示词（反复出现会变噪音）；面板上仍可见。 */
const CONFLICT_TTL_DAYS = 7;

/** 措辞几乎一样（字符二元组重合度）——「同一句话改了个细节」这种。 */
const CONFLICT_DICE = 0.5;
/** 同一个人身上，尺子放松一点：他身上的两句话像，更值得多看一眼。 */
const CONFLICT_DICE_SAME_PERSON = 0.35;
/** 换了说法但意思贴着（向量余弦）。 */
const CONFLICT_VECTOR = 0.72;

/** 检索向量路的最低余弦门槛（bge-m3 低于 0.35 多是同领域但不相干）；与 CONFLICT_VECTOR 是两把尺子。 */
const RECALL_MIN_VECTOR = 0.35;

/** 这条说的是「他是谁 / 什么一直成立」，还是「他现在怎么样」。 */
export type Volatility = "stable" | "volatile";

/** 条目的正文上限：一句话说得清的，硬写长反而是没想清 */
const ENTRY_CAP = 500;
/** 书册的正文上限：成体系的一篇文章值得上万字，但记忆库不是无限仓库 */
const BOOK_CAP = 20000;
/** 会话回想的正文上限：要装下「聊了什么 + 怎么聊」，500 字不够，又不该到书册量级。 */
const RECAP_CAP = 1200;

export function ensureMemorySchema(sql: SqlTag): void {
  sql`
    CREATE TABLE IF NOT EXISTS memories (
      id            TEXT PRIMARY KEY,
      date          TEXT NOT NULL,
      type          TEXT NOT NULL,
      tags          TEXT NOT NULL DEFAULT '',
      weight        REAL NOT NULL DEFAULT 0.5,
      shelf         TEXT NOT NULL DEFAULT 'knowledge',
      person        TEXT NOT NULL DEFAULT '',
      visibility    TEXT NOT NULL DEFAULT 'private',
      content       TEXT NOT NULL,
      accessed      INTEGER NOT NULL DEFAULT 0,
      learned       TEXT NOT NULL DEFAULT '',
      superseded_by TEXT NOT NULL DEFAULT '',
      volatility    TEXT NOT NULL DEFAULT 'stable',
      verified      TEXT NOT NULL DEFAULT '',
      valid_at      TEXT NOT NULL DEFAULT '',
      invalid_at    TEXT NOT NULL DEFAULT '',
      conflicts_with TEXT NOT NULL DEFAULT ''
    )
  `;
  sql`CREATE INDEX IF NOT EXISTS idx_memories_shelf ON memories(shelf)`;
  // 老表补列：CREATE TABLE IF NOT EXISTS 不会给已存在的表加列
  try {
    sql`ALTER TABLE memories ADD COLUMN person TEXT NOT NULL DEFAULT ''`;
  } catch {
    // 列已存在
  }
  try {
    sql`ALTER TABLE memories ADD COLUMN learned TEXT NOT NULL DEFAULT ''`;
    // 只在刚补列时回填一次：老数据只有日期，用当天零点顶上，不编精确时刻。
    sql`UPDATE memories SET learned = date || 'T00:00:00.000Z' WHERE learned = '' AND date <> ''`;
  } catch {
    // 列已存在，不回填
  }
  try {
    sql`ALTER TABLE memories ADD COLUMN superseded_by TEXT NOT NULL DEFAULT ''`;
  } catch {
    // 列已存在
  }
  // 老记忆一律落 stable：不知道会不会变，就不能编成会变（复核清单会一次涌进几十条）。
  // 要改就改那一条（确认时顺手改 / 管理面板改）。
  try {
    sql`ALTER TABLE memories ADD COLUMN volatility TEXT NOT NULL DEFAULT 'stable'`;
  } catch {
    // 列已存在
  }
  // 空串 = 从没复核过；老数据不能拿 learned 顶上，那等于替管理员宣布核对过了。
  try {
    sql`ALTER TABLE memories ADD COLUMN verified TEXT NOT NULL DEFAULT ''`;
  } catch {
    // 列已存在
  }
  sql`CREATE INDEX IF NOT EXISTS idx_memories_person ON memories(person)`;
  // 默认 private：老数据写在「能否给外人看」之前，没人同意过，不能替谁做主公开。
  try {
    sql`ALTER TABLE memories ADD COLUMN visibility TEXT NOT NULL DEFAULT 'private'`;
  } catch {
    // 列已存在
  }
  sql`CREATE INDEX IF NOT EXISTS idx_memories_visibility ON memories(visibility)`;
  sql`CREATE INDEX IF NOT EXISTS idx_memories_superseded ON memories(superseded_by)`;
  sql`CREATE INDEX IF NOT EXISTS idx_memories_volatility ON memories(volatility)`;

  // 从何时开始成立；老数据只能拿 learned 顶上（唯一能有的答案）。
  try {
    sql`ALTER TABLE memories ADD COLUMN valid_at TEXT NOT NULL DEFAULT ''`;
    sql`UPDATE memories SET valid_at = learned WHERE valid_at = '' AND learned <> ''`;
  } catch {
    // 列已存在，不回填
  }
  // 到何时不再成立；老作废数据不知道失效日，留空显示「失效时间不明」，不编时刻。
  try {
    sql`ALTER TABLE memories ADD COLUMN invalid_at TEXT NOT NULL DEFAULT ''`;
  } catch {
    // 列已存在
  }
  try {
    sql`ALTER TABLE memories ADD COLUMN conflicts_with TEXT NOT NULL DEFAULT ''`;
  } catch {
    // 列已存在
  }

  // title = 书册标题；file_key = 图像原件在云盘的 key（记忆只存说明 + 指针）。
  // 老数据一律空串：写下时还没有这两种类型，不能替它们补标题。
  try {
    sql`ALTER TABLE memories ADD COLUMN title TEXT NOT NULL DEFAULT ''`;
  } catch {
    // 列已存在
  }
  try {
    sql`ALTER TABLE memories ADD COLUMN file_key TEXT NOT NULL DEFAULT ''`;
  } catch {
    // 列已存在
  }

  // session_id = 哪一场聊出来的（空串 = 普通记忆）；sentiment = 语气标签，只许取固定枚举。
  // 老数据一律空串：当时还没有这两种说法，不能替它们认领。
  try {
    sql`ALTER TABLE memories ADD COLUMN session_id TEXT NOT NULL DEFAULT ''`;
  } catch {
    // 列已存在
  }
  try {
    sql`ALTER TABLE memories ADD COLUMN sentiment TEXT NOT NULL DEFAULT ''`;
  } catch {
    // 列已存在
  }
  sql`CREATE INDEX IF NOT EXISTS idx_memories_session ON memories(session_id)`;
  sql`CREATE INDEX IF NOT EXISTS idx_memories_sentiment ON memories(sentiment)`;

  // 量级（知道的人该有多少）：AI 按评分公式标，管理员可改。
  // 老数据落 normal：当时还没有量级这回事，不能替谁宣布重要或机密。
  try {
    sql`ALTER TABLE memories ADD COLUMN sensitivity TEXT NOT NULL DEFAULT 'normal'`;
  } catch {
    // 列已存在
  }
  // 量级评分依据（0-9）；10 不是分数，是管理员亲手设绝密时钉的记号。
  try {
    sql`ALTER TABLE memories ADD COLUMN score INTEGER NOT NULL DEFAULT 0`;
  } catch {
    // 列已存在
  }
  sql`CREATE INDEX IF NOT EXISTS idx_memories_sensitivity ON memories(sensitivity)`;

  // 归属键只认 room:<来客房间名>，房间名由 Worker 按签名票/卡绑定派生，客人自报不算数。
  // 旧归属按 person（自报称呼）可被同名冒领，故授权改跟 owner_key，person 仅展示。
  // 老数据空串 = 归属无法核实，不对任何来客开放名下读取（管理员面板照常可见）。
  try {
    sql`ALTER TABLE memories ADD COLUMN owner_key TEXT NOT NULL DEFAULT ''`;
  } catch {
    // 列已存在
  }
  sql`CREATE INDEX IF NOT EXISTS idx_memories_owner_key ON memories(owner_key)`;

  // 显式收回（1 = 管理员最后一次手动决定「不公开」）：压过 tag 门，只改 visibility
  // 收不回来。0 = 没收回或收回后又点了「公开」。只听「公开/收回」按钮，AI 与改档面板不碰。
  try {
    sql`ALTER TABLE memories ADD COLUMN visibility_hold INTEGER NOT NULL DEFAULT 0`;
  } catch {
    // 列已存在
  }

  // 回想幂等键 `${sessionId}:${起点}:${记忆用途}`，同键只落第一次，
  // 兜「写了记忆、游标没推进」的重跑。空串 = 无幂等要求。
  try {
    sql`ALTER TABLE memories ADD COLUMN dedupe_key TEXT NOT NULL DEFAULT ''`;
  } catch {
    // 列已存在
  }
  sql`CREATE INDEX IF NOT EXISTS idx_memories_dedupe ON memories(dedupe_key)`;

  // 最近一次用上的时刻（epoch ms）；accessed 是次数不能比时间阈值，否则保护形同虚设。
  // 老数据 0 = 没记过，不算近期活跃。
  try {
    sql`ALTER TABLE memories ADD COLUMN last_accessed_at INTEGER NOT NULL DEFAULT 0`;
  } catch {
    // 列已存在
  }

  // tag 公开门槛：带该 tag、量级不超过 max_level 的记忆放行给来客（表在主人那间）。
  // '' 或无行 = 门没开；枚举只到 secret，绝密没有出门的路。
  // 判定在 SQL 里（listPublicMemories / searchMemories）——数据层关的门提示词开不了。
  sql`
    CREATE TABLE IF NOT EXISTS tag_access (
      tag       TEXT PRIMARY KEY,
      max_level TEXT NOT NULL DEFAULT ''
    )
  `;
}

function rowToEntry(r: MemRow): MemEntry {
  return {
    id: r.id,
    date: r.date,
    type: r.type,
    tags: r.tags ? r.tags.split(",").filter(Boolean) : [],
    weight: r.weight,
    shelf: r.shelf,
    person: r.person || "",
    visibility: r.visibility === "public" ? "public" : "private",
    content: r.content,
    accessed: r.accessed,
    learned: r.learned || "",
    supersededBy: r.superseded_by || "",
    volatility: r.volatility === "volatile" ? "volatile" : "stable",
    verified: r.verified || "",
    validAt: r.valid_at || "",
    invalidAt: r.invalid_at || "",
    conflictsWith: r.conflicts_with
      ? r.conflicts_with.split(",").filter(Boolean)
      : [],
    title: r.title || "",
    fileKey: r.file_key || "",
    sessionId: r.session_id || "",
    sentiment: r.sentiment || "",
    sensitivity: (SENSITIVITIES as readonly string[]).includes(r.sensitivity)
      ? (r.sensitivity as Sensitivity)
      : "normal",
    score: r.score ?? 0,
    hold: r.visibility_hold === 1,
  };
}

/** 「学到多久了」的人话（「3 天前」之类），只用于提示新旧，不追求精确。 */
export function ageLabel(iso: string, now = Date.now()): string {
  const t = new Date(iso || 0).getTime();
  if (!Number.isFinite(t) || t <= 0) return "时间不明";
  const days = Math.max(0, (now - t) / 86400000);
  if (days < 1) return "今天";
  if (days < 2) return "昨天";
  if (days < 30) return `${Math.floor(days)} 天前`;
  if (days < 365) return `${Math.floor(days / 30)} 个月前`;
  return `${Math.floor(days / 365)} 年前`;
}

/** 复核参照时刻：verified 优先，退到 learned/date（date 是事情发生日，不是知道它的时刻）。 */
export function reviewRef(
  e: Pick<MemEntry, "verified" | "learned" | "date">,
): string {
  return e.verified || e.learned || e.date;
}

/** 该复核：会变 + 还算数 + 距上次确认超过 REVIEW_DAYS；变不变由模型判断，计时由代码算。 */
export function needsReview(e: MemEntry, now = Date.now()): boolean {
  if (e.volatility !== "volatile" || e.supersededBy) return false;
  const t = new Date(reviewRef(e)).getTime();
  if (!Number.isFinite(t) || t <= 0) return true;
  return now - t > REVIEW_DAYS * 86400000;
}

/** 注入提示词的记忆行；复核标记只挂命中项，全挂会把提醒稀释成背景噪音。 */
export function memoryHitLines(hits: MemEntry[], now = Date.now()): string[] {
  return hits.map((e) => {
    const warn = needsReview(e, now)
      ? ` ⚠️这条说的是现状，${ageLabel(reviewRef(e), now)}没核对过`
      : "";
    const head =
      e.type === "book" && e.title
        ? `「${e.title}」`
        : e.type === "image"
          ? `📷 ${e.content}`
          : e.content;
    return `[${e.shelf} · 学到${ageLabel(e.learned, now)}${e.person ? ` · ${e.person}` : ""}] ${head}${warn}`;
  });
}

/** 该复核的清单，最久没确认的排前面。 */
export function listDueForReview(
  sql: SqlTag,
  limit = 50,
  now = Date.now(),
): MemEntry[] {
  const cutoff = new Date(now - REVIEW_DAYS * 86400000).toISOString();
  // ISO 字符串按字典序比即按时间比；空串（时间不明）也落在 cutoff 前，正好被拎出来。
  const rows = sql<MemRow>`
    SELECT * FROM memories
    WHERE volatility = 'volatile' AND superseded_by = ''
      AND (CASE WHEN verified <> '' THEN verified ELSE learned END) < ${cutoff}
    ORDER BY (CASE WHEN verified <> '' THEN verified ELSE learned END) ASC LIMIT ${limit}`;
  return rows.map(rowToEntry);
}

/** 复核确认：记下「我最近核对过它」，不是新增一条、也不改内容。 */
export function confirmMemory(
  sql: SqlTag,
  id: string,
  when?: string,
): MemEntry | null {
  const old = getMemory(sql, id);
  if (!old) return null;
  const verified = when || new Date().toISOString();
  sql`UPDATE memories SET verified = ${verified} WHERE id = ${id}`;
  return { ...old, verified };
}

/** 标成「会变」或「稳定」。标错了可以改 —— 一条错标一直挂在那儿，比没有这个标记更糟。 */
export function setVolatility(
  sql: SqlTag,
  id: string,
  volatility: Volatility,
): MemEntry | null {
  const old = getMemory(sql, id);
  if (!old) return null;
  sql`UPDATE memories SET volatility = ${volatility} WHERE id = ${id}`;
  return { ...old, volatility };
}

export function countMemories(sql: SqlTag): number {
  const rows = sql<{ n: number }>`SELECT COUNT(*) AS n FROM memories`;
  return rows[0]?.n ?? 0;
}

/** 默认只给还算数的记忆：作废的仍可查历史，但进检索池就可能被当事实再讲出去。 */
interface MemQuery {
  includeSuperseded?: boolean;
  /** 只要公开的。来客那间问「管理员公开过什么」时用 —— 别的一律不出这间屋子。 */
  onlyPublic?: boolean;
  /**
   * 来客受限读：public + 他名下的（owner_key = room:<房间名>），其余不出。
   * 房间名由 Worker 按签名票派生，称呼对得上屋子对不上也翻不走；过滤在 SQL 里。
   */
  guestOwnerKey?: string;
  /**
   * 轮内检索缓存：同轮同参复用，免得重复打 Vectorize（按维度计费）。
   * 生命周期归调用方；写入记忆的工具要当场清掉。
   */
  cache?: Map<string, MemEntry[]>;
}

/**
 * 来客可读 = visibility=public（排除 topsecret）∪ tag 门（量级 ≤ 门槛）。
 * instr 两头补逗号防子串误命中；topsecret 序 4 > 门槛上限 3，绝密无 tag 门。
 * visibility_hold=0 是第三道闸：显式收回压过自动放行。主人读 listMemories，无门。
 */
export function listPublicMemories(sql: SqlTag, limit = 200): MemEntry[] {
  const rows = sql<MemRow>`
    SELECT * FROM memories WHERE superseded_by = '' AND visibility_hold = 0
    AND ((visibility = 'public' AND memories.sensitivity <> 'topsecret') OR EXISTS (
      SELECT 1 FROM tag_access ta
      WHERE ta.max_level <> ''
        AND instr(',' || memories.tags || ',', ',' || ta.tag || ',') > 0
        AND (CASE memories.sensitivity
             WHEN 'trivial' THEN 0 WHEN 'normal' THEN 1 WHEN 'important' THEN 2
             WHEN 'secret' THEN 3 WHEN 'topsecret' THEN 4 ELSE 1 END)
        <= (CASE ta.max_level
             WHEN 'trivial' THEN 0 WHEN 'normal' THEN 1 WHEN 'important' THEN 2
             WHEN 'secret' THEN 3 ELSE 0 END)
    ))
    ORDER BY weight DESC LIMIT ${limit}`;
  return rows.map(rowToEntry);
}

/**
 * 会话记忆列表与筛选（关键词/时间/情感/场次）。
 * 单开直白 SQL 而不复用 searchMemories：不想再给它叠布尔开关；语义检索那条路照旧。
 */
export interface SessionMemoryQuery {
  sessionId?: string;
  sentiment?: string;
  /** ISO，含 */
  from?: string;
  /** ISO，不含 */
  to?: string;
  /** 关键词：正文或标签里包含即可 */
  q?: string;
  limit?: number;
}

export function listSessionMemories(
  sql: SqlTag,
  opts: SessionMemoryQuery = {},
): MemEntry[] {
  const limit = opts.limit ?? 200;
  const sessionId = opts.sessionId || "";
  const sentiment = opts.sentiment || "";
  const from = opts.from || "";
  const to = opts.to || "";
  const q = opts.q || "";
  const like = `%${q}%`;
  const rows = sql<MemRow>`
    SELECT * FROM memories
    WHERE shelf = 'sessions' AND superseded_by = ''
      AND (${sessionId} = '' OR session_id = ${sessionId})
      AND (${sentiment} = '' OR sentiment = ${sentiment})
      AND (${from} = '' OR learned >= ${from})
      AND (${to} = '' OR learned < ${to})
      AND (${q} = '' OR content LIKE ${like} OR tags LIKE ${like})
    ORDER BY learned DESC LIMIT ${limit}`;
  return rows.map(rowToEntry);
}

/** 每个会话攒了多少条回想、最后一次是什么时候。回想页左栏分组用它。 */
export function sessionMemoryCounts(
  sql: SqlTag,
): Array<{ sessionId: string; n: number; last: string }> {
  return sql<{ sessionId: string; n: number; last: string }>`
    SELECT session_id AS sessionId, COUNT(*) AS n, MAX(learned) AS last
    FROM memories WHERE shelf = 'sessions' AND session_id <> '' AND superseded_by = ''
    GROUP BY session_id ORDER BY last DESC`;
}

/**
 * 公开/收回（管理员动作，模型不该代做）。
 * 收回必须落 visibility_hold=1：只改 private 挡不住 tag 门；再点「公开」才落 0。
 * 绝密直接拒绝公开——先降量级；「先公开后改绝密」由 listPublicMemories 查询层挡。
 */
export function setVisibility(
  sql: SqlTag,
  id: string,
  visibility: "private" | "public",
): MemEntry | null {
  const old = getMemory(sql, id);
  if (!old) return null;
  if (visibility === "public" && old.sensitivity === "topsecret")
    throw new Error("绝密没有出门的路：想公开，先把量级降下来");
  const hold = visibility === "private" ? 1 : 0;
  sql`UPDATE memories SET visibility = ${visibility}, visibility_hold = ${hold} WHERE id = ${id}`;
  return { ...old, visibility, hold: hold === 1 };
}

/**
 * 改量级。五档都能设，绝密只在这把锁里（模型工具枚举没有它，tag 门也放不了）。
 * 设绝密时 score 钉 10（人拍的板）；设别的档不动 score（AI 留的依据，抹了没法对账）。
 */
export function setSensitivity(
  sql: SqlTag,
  id: string,
  sensitivity: Sensitivity,
): MemEntry | null {
  const old = getMemory(sql, id);
  if (!old) return null;
  const score = sensitivity === "topsecret" ? 10 : old.score;
  sql`UPDATE memories SET sensitivity = ${sensitivity}, score = ${score} WHERE id = ${id}`;
  return { ...old, sensitivity, score };
}

// ── tag 公开门槛：一类一类地放行 ──────────────────────────
// 判定在 SQL（listPublicMemories / searchMemories），这里只管账本。

/** 开着的一道门：带这个 tag、量级不超过 maxLevel 的记忆，来客读得到。 */
export interface TagGate {
  tag: string;
  maxLevel: string;
}

/** 门槛账本：现在开着哪几道门。关着的（''）在账上不存在 —— 关门就是删行。 */
export function listTagAccess(sql: SqlTag): TagGate[] {
  return sql<{ tag: string; maxLevel: string }>`
    SELECT tag, max_level AS maxLevel FROM tag_access ORDER BY tag ASC`;
}

/**
 * 开/关一道门：maxLevel 传 '' 或认不出的值都算关门。
 * 档位只认到 secret；topsecret 落成关门——绝密没有出门的路，不是疏漏。
 */
export function setTagAccess(sql: SqlTag, tag: string, maxLevel: string): void {
  const t = tag.trim().slice(0, 60);
  if (!t) return;
  const level = (TAG_GATE_LEVELS as readonly string[]).includes(maxLevel)
    ? maxLevel
    : "";
  if (!level) {
    sql`DELETE FROM tag_access WHERE tag = ${t}`;
    return;
  }
  sql`INSERT OR REPLACE INTO tag_access (tag, max_level) VALUES (${t}, ${level})`;
}

/** 一个 tag 的分布：几条、各量级多少。管理员决定开不开这扇门时，看的就是它。 */
export interface TagStat {
  tag: string;
  n: number;
  trivial: number;
  normal: number;
  important: number;
  secret: number;
  topsecret: number;
}

/** 全部 tag 的分布（各量级计数）；拆逗号在 JS 做，不值得为 split 写递归 CTE。 */
export function tagStats(sql: SqlTag): TagStat[] {
  const rows = sql<{ tags: string; sensitivity: string }>`
    SELECT tags, sensitivity FROM memories WHERE superseded_by = '' AND tags <> ''`;
  const map = new Map<string, TagStat>();
  for (const r of rows) {
    const level = (SENSITIVITIES as readonly string[]).includes(r.sensitivity)
      ? r.sensitivity
      : "normal";
    for (const raw of r.tags.split(",")) {
      const tag = raw.trim();
      if (!tag) continue;
      let s = map.get(tag);
      if (!s) {
        s = {
          tag,
          n: 0,
          trivial: 0,
          normal: 0,
          important: 0,
          secret: 0,
          topsecret: 0,
        };
        map.set(tag, s);
      }
      s.n++;
      s[level as keyof TagStat]++;
    }
  }
  return [...map.values()].sort(
    (a, b) => b.n - a.n || a.tag.localeCompare(b.tag),
  );
}

export function listMemories(
  sql: SqlTag,
  shelf?: string,
  limit = 200,
  opts: MemQuery = {},
): MemEntry[] {
  const all = !!opts.includeSuperseded;
  const rows = all
    ? shelf
      ? sql<MemRow>`SELECT * FROM memories WHERE shelf = ${shelf} ORDER BY weight DESC LIMIT ${limit}`
      : sql<MemRow>`SELECT * FROM memories ORDER BY weight DESC LIMIT ${limit}`
    : shelf
      ? sql<MemRow>`SELECT * FROM memories WHERE shelf = ${shelf} AND superseded_by = '' ORDER BY weight DESC LIMIT ${limit}`
      : sql<MemRow>`SELECT * FROM memories WHERE superseded_by = '' ORDER BY weight DESC LIMIT ${limit}`;
  return rows.map(rowToEntry);
}

/** 只列已作废的那些 —— 记忆的「历史版本」，供人回看和解释「我为什么改了口」。 */
export function listSuperseded(sql: SqlTag, limit = 100): MemEntry[] {
  const rows = sql<MemRow>`
    SELECT * FROM memories WHERE superseded_by <> '' ORDER BY learned DESC, id DESC LIMIT ${limit}`;
  return rows.map(rowToEntry);
}

export function listMemoriesByPerson(
  sql: SqlTag,
  person: string,
  limit = 200,
  opts: MemQuery = {},
): MemEntry[] {
  const rows = opts.includeSuperseded
    ? sql<MemRow>`SELECT * FROM memories WHERE person = ${person} ORDER BY weight DESC LIMIT ${limit}`
    : sql<MemRow>`SELECT * FROM memories WHERE person = ${person} AND superseded_by = '' ORDER BY weight DESC LIMIT ${limit}`;
  return rows.map(rowToEntry);
}

/** 人脉视图的顶层：出现过的人物 + 各自名下的记忆条数。 */
export function listPersons(sql: SqlTag): Array<{ person: string; n: number }> {
  return sql<{ person: string; n: number }>`
    SELECT person, COUNT(*) AS n FROM memories
    WHERE person <> '' AND superseded_by = '' GROUP BY person ORDER BY n DESC, person ASC`;
}

function countSuperseded(sql: SqlTag): number {
  const rows = sql<{
    n: number;
  }>`SELECT COUNT(*) AS n FROM memories WHERE superseded_by <> ''`;
  return rows[0]?.n ?? 0;
}

/** 记忆库的一次性盘点。stats 工具要的那几项全在这儿算齐。 */
export interface MemoryStats {
  /** 表里一共多少条（含已作废的） */
  total: number;
  /** 已被新说法作废的条数 */
  gone: number;
  /** 还算数的，按书架分组，多的在前 */
  shelves: Array<{ shelf: string; n: number }>;
  /** 该复核的条数（说的是现状、又有一阵没确认） */
  due: number;
  /** 和别的说法对不上的条数 */
  unsettled: number;
}

/** 盘一次记忆库；本地盘与跨间盘共用，免得两边指标悄悄漂开。 */
export function memoryStats(sql: SqlTag): MemoryStats {
  const shelves = sql<{ shelf: string; n: number }>`
    SELECT shelf, COUNT(*) AS n FROM memories WHERE superseded_by = '' GROUP BY shelf ORDER BY n DESC`;
  return {
    total: countMemories(sql),
    gone: countSuperseded(sql),
    shelves,
    due: listDueForReview(sql, 200).length,
    unsettled: countConflicted(sql),
  };
}

export function getMemory(sql: SqlTag, id: string): MemEntry | null {
  const rows = sql<MemRow>`SELECT * FROM memories WHERE id = ${id}`;
  return rows[0] ? rowToEntry(rows[0]) : null;
}

export interface NewMemory {
  type: string;
  content: string;
  shelf?: string;
  tags?: string[];
  weight?: number;
  /** 归属人物，人脉视图按这个分组 */
  person?: string;
  /** 能不能给来客看。不传就是 private —— 公开必须是人主动做的决定。 */
  visibility?: "private" | "public";
  /** 迁移旧数据时保留原 id / 日期 / 访问计数 */
  id?: string;
  date?: string;
  accessed?: number;
  /** 学到的时刻（ISO）。不传就是现在 —— 写入时刻就是学到时刻。 */
  learned?: string;
  /** 迁移用：保留原有的作废标记 */
  supersededBy?: string;
  /** 会变（关于现状）还是稳定（关于他是谁）。不传按稳定处理。 */
  volatility?: Volatility;
  /** 迁移用：保留原有的复核时刻 */
  verified?: string;
  /** 这件事从什么时候开始成立（ISO）。不传就等于 learned。 */
  validAt?: string;
  /** 迁移用：保留原有的失效时刻 */
  invalidAt?: string;
  /** 写入时发现「像在说同一件事」的旧记忆 id */
  conflictsWith?: string[];
  /** 书册的标题。type=book 时该填；条目和图像没有标题 */
  title?: string;
  /** 图像原件在云盘里的 key。type=image 时该填 */
  fileKey?: string;
  /** 这条属于哪一场会话。会话记忆（shelf='sessions'）该填 */
  sessionId?: string;
  /** 那一段的语气。认不出的值落空串 —— 标签宁缺勿编 */
  sentiment?: string;
  /** 量级：AI 按评分公式标（工具枚举无 topsecret，那把锁只在面板）；缺省/认不出落 normal。 */
  sensitivity?: Sensitivity;
  /** 量级的评分依据（0-9）。不传落 0 */
  score?: number;
  /** 归属键 room:<房间名>：跨房受限读只认它；空串 = 未核实，不开放名下读取。person 仅供展示。 */
  ownerKey?: string;
  /** 回想幂等键：同键只落第一次并返回已有条目，兜「写了记忆、游标没推进」的重跑。 */
  dedupeKey?: string;
}

export function insertMemory(sql: SqlTag, input: NewMemory): MemEntry {
  const id =
    input.id ||
    "m" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const date = input.date || new Date().toISOString().slice(0, 10);
  const shelf = input.shelf || "knowledge";
  const person = (input.person || "").trim().slice(0, 40);
  const visibility = input.visibility === "public" ? "public" : "private";
  const sentiment = normalizeSentiment(input.sentiment || "");
  // 情感也进 tags，关键词检索才找得到；标签按 `,tag,` 匹配，逗号必须剥掉——
  // 否则来客交「自定义,已开放标签」进来，存库后就像真的开了那道门。
  const tags = [
    ...new Set([
      input.type,
      ...(input.tags || []),
      ...(sentiment ? [sentiment] : []),
    ]),
  ]
    .map((t) => String(t).replace(/[，,]/g, "").trim())
    .filter(Boolean)
    .join(",");
  // 书册 / 会话回想 / 条目三个正文尺寸钉死在这层
  const cap =
    input.type === "book"
      ? BOOK_CAP
      : input.type === "recap"
        ? RECAP_CAP
        : ENTRY_CAP;
  const content = input.content.slice(0, cap);
  const title = (input.title || "").trim().slice(0, 120);
  const fileKey = (input.fileKey || "").trim();
  const sessionId = (input.sessionId || "").trim().slice(0, 40);
  const weight = input.weight ?? 0.5;
  const accessed = input.accessed ?? 0;
  const lastAccessedAt = 0;
  const learned = input.learned || new Date().toISOString();
  const supersededBy = input.supersededBy || "";
  const volatility: Volatility =
    input.volatility === "volatile" ? "volatile" : "stable";
  const verified = input.verified || "";
  const validAt = input.validAt || learned;
  const invalidAt = input.invalidAt || "";
  const conflictsWith = input.conflictsWith || [];
  const sensitivity: Sensitivity = (
    SENSITIVITIES as readonly string[]
  ).includes(input.sensitivity || "")
    ? input.sensitivity!
    : "normal";
  const score = Math.max(0, Math.min(10, Math.round(input.score ?? 0)));
  // 归属键只认 room: 前缀且限长；写歪了落空串（= 不对来客开放），不存可疑值
  const ownerKey = /^room:.{1,80}$/.test(input.ownerKey || "")
    ? input.ownerKey!
    : "";
  // 收回记号只听「公开/收回」按钮；AI 重写算新一版，与 visibility 一样归零，等管理员重新过目。
  const visibilityHold: number = 0;
  // 幂等键限长 160（超长宁可不存）；非空先查重，同键只落第一次并返回已有条目。
  const dedupeKey = (input.dedupeKey || "").slice(0, 160);
  if (dedupeKey) {
    const dup = sql<MemRow>`
      SELECT * FROM memories WHERE dedupe_key = ${dedupeKey} LIMIT 1`;
    if (dup[0]) return rowToEntry(dup[0]);
  }
  sql`
    INSERT OR REPLACE INTO memories (id, date, type, tags, weight, shelf, person, visibility, content, accessed, learned, superseded_by, volatility, verified, valid_at, invalid_at, conflicts_with, title, file_key, session_id, sentiment, sensitivity, score, owner_key, visibility_hold, dedupe_key, last_accessed_at)
    VALUES (${id}, ${date}, ${input.type}, ${tags}, ${weight}, ${shelf}, ${person}, ${visibility}, ${content}, ${accessed}, ${learned}, ${supersededBy}, ${volatility}, ${verified}, ${validAt}, ${invalidAt}, ${conflictsWith.join(",")}, ${title}, ${fileKey}, ${sessionId}, ${sentiment}, ${sensitivity}, ${score}, ${ownerKey}, ${visibilityHold}, ${dedupeKey}, ${lastAccessedAt})
  `;
  return {
    id,
    date,
    type: input.type,
    tags: tags.split(","),
    weight,
    shelf,
    person,
    visibility,
    hold: visibilityHold === 1,
    content,
    accessed,
    learned,
    supersededBy,
    volatility,
    verified,
    validAt,
    invalidAt,
    conflictsWith,
    title,
    fileKey,
    sessionId,
    sentiment,
    sensitivity,
    score,
  };
}

/**
 * 快照整行落库——场屋并账的收账口。
 * insertMemory 是「记新的」（生成 id/learned、归一化），这里照抄那边的状态（作废/疑问/确认）。
 * 幂等：同 id 反复寄，后到覆盖先到（队列重试安全）；owner_key/dedupe_key 不在快照里。
 */
export function upsertMemorySnapshot(sql: SqlTag, e: MemEntry): void {
  ensureMemorySchema(sql);
  sql`
    INSERT OR REPLACE INTO memories (id, date, type, tags, weight, shelf, person, visibility, content, accessed, learned, superseded_by, volatility, verified, valid_at, invalid_at, conflicts_with, title, file_key, session_id, sentiment, sensitivity, score, owner_key, visibility_hold, dedupe_key, last_accessed_at)
    VALUES (${e.id}, ${e.date}, ${e.type}, ${e.tags.join(",")}, ${e.weight}, ${e.shelf}, ${e.person}, ${e.visibility}, ${e.content}, ${e.accessed}, ${e.learned}, ${e.supersededBy}, ${e.volatility}, ${e.verified}, ${e.validAt}, ${e.invalidAt}, ${e.conflictsWith.join(",")}, ${e.title}, ${e.fileKey}, ${e.sessionId}, ${e.sentiment}, ${e.sensitivity}, ${e.score}, "", ${e.hold ? 1 : 0}, "", 0)
  `;
}

/** 按回想幂等键找已落条目；重复时整段跳过——否则会拿旧 id 喂新正文向量，向量与 SQLite 脱节。 */
export function getMemoryByDedupeKey(
  sql: SqlTag,
  dedupeKey: string,
): MemEntry | null {
  if (!dedupeKey) return null;
  const rows = sql<MemRow>`SELECT * FROM memories WHERE dedupe_key = ${dedupeKey} LIMIT 1`;
  return rows[0] ? rowToEntry(rows[0]) : null;
}

/**
 * 结构性作废：旧说法标记不删（「原来以为…后来知道…」本身有用）。
 * 模型只指出被替代的 id，谁作数由代码按 id 执行——不靠相似度阈值，也不让模型比时间戳。
 */
export function supersedeMemory(
  sql: SqlTag,
  oldId: string,
  newId?: string,
  when?: string,
): MemEntry | null {
  const old = getMemory(sql, oldId);
  if (!old) return null;
  const mark = newId || RETIRED;
  // 失效时刻取「替代它的那条是什么时候学到的」：旧说法不是今天才不成立的，
  // 是从听说新说法那一刻起就不成立了。找不到替代者（retired）才退到此刻。
  const at =
    when ||
    (newId ? getMemory(sql, newId)?.learned || "" : "") ||
    new Date().toISOString();
  sql`UPDATE memories SET superseded_by = ${mark}, invalid_at = ${at} WHERE id = ${oldId}`;
  // 对错已经分出来了，挂在它身上的疑问自然消解
  settleConflicts(sql, oldId);
  return { ...old, supersededBy: mark, invalidAt: at };
}

/** 撤销作废：模型判断错了，或者当事人说「其实还是原来那样」。 */
export function restoreMemory(sql: SqlTag, id: string): MemEntry | null {
  const old = getMemory(sql, id);
  if (!old) return null;
  sql`UPDATE memories SET superseded_by = '', invalid_at = '' WHERE id = ${id}`;
  return { ...old, supersededBy: "", invalidAt: "" };
}

// ── 疑问账本：只记不判 ──────────────────────────────
// 两把尺子挑候选（findConflicts），是否同一件事由模型判；哪条更新绝不让模型猜，按 id 由代码作废。

/**
 * 了结关于这条的所有疑问：自己的清单清空，别人清单里提到它的也抹掉。
 * 四种情况（作废/删除/说清不冲突/恢复）共用；只清一边会留下指向已不存在疑问的账。
 */
export function settleConflicts(sql: SqlTag, id: string): number {
  const rows = sql<MemRow>`SELECT * FROM memories WHERE conflicts_with <> ''`;
  let n = 0;
  for (const r of rows) {
    const ids = r.conflicts_with.split(",").filter(Boolean);
    const left = r.id === id ? [] : ids.filter((x) => x !== id);
    if (left.length === ids.length) continue;
    sql`UPDATE memories SET conflicts_with = ${left.join(",")} WHERE id = ${r.id}`;
    n++;
  }
  return n;
}

/** 记下「这几条和它对不上，还没弄明白」。 */
export function setConflicts(
  sql: SqlTag,
  id: string,
  ids: string[],
): MemEntry | null {
  const old = getMemory(sql, id);
  if (!old) return null;
  const uniq = [...new Set(ids.filter((x) => x && x !== id))];
  sql`UPDATE memories SET conflicts_with = ${uniq.join(",")} WHERE id = ${id}`;
  return { ...old, conflictsWith: uniq };
}

/** 还挂着疑问的那些（新的在前 —— 刚写下的疑问最该被看见）。 */
export function listConflicted(sql: SqlTag, limit = 100): MemEntry[] {
  const rows = sql<MemRow>`
    SELECT * FROM memories WHERE conflicts_with <> '' AND superseded_by = ''
    ORDER BY learned DESC, id DESC LIMIT ${limit}`;
  return rows.map(rowToEntry);
}

function countConflicted(sql: SqlTag): number {
  const rows = sql<{
    n: number;
  }>`SELECT COUNT(*) AS n FROM memories WHERE conflicts_with <> '' AND superseded_by = ''`;
  return rows[0]?.n ?? 0;
}

/**
 * 字符二元组重合度（Dice）：比整句像不像，无需词典，对「同句改细节」灵；
 * 换说法抓不到（那是向量那把尺子）。与 memoryKeywords 的单词命中不是一回事。
 */
export function textOverlap(a: string, b: string): number {
  const grams = (s: string): Set<string> => {
    const t = s
      .toLowerCase()
      .replace(/[\s,，。、！？!?：:；;（）()【】「」“”"'’·]+/g, "");
    const out = new Set<string>();
    for (let i = 0; i + 1 < t.length; i++) out.add(t.slice(i, i + 2));
    return out;
  };
  const A = grams(a);
  const B = grams(b);
  if (!A.size || !B.size) return 0;
  let hit = 0;
  for (const g of A) if (B.has(g)) hit++;
  return (2 * hit) / (A.size + B.size);
}

interface ConflictCandidate {
  entry: MemEntry;
  /** 为什么觉得像：给模型看的理由，也让我自己知道该不该信 */
  why: string;
  score: number;
}

/**
 * 找「可能和这条说的是同一件事」的旧记忆。写入时当场跑（人事后不会专门回头比对）。
 * 只挑候选不下结论：挑错只多问一句，漏掉是两条矛盾的话同时躺在库里。
 */
export async function findConflicts(
  sql: SqlTag,
  env: Env,
  entry: MemEntry,
  topK = 3,
): Promise<ConflictCandidate[]> {
  const rows = sql<MemRow>`
    SELECT * FROM memories WHERE superseded_by = '' AND id <> ${entry.id}
    ORDER BY weight DESC LIMIT ${SCAN_LIMIT}`;
  if (!rows.length) return [];
  const pool = rows.map(rowToEntry);
  const found = new Map<string, ConflictCandidate>();

  for (const m of pool) {
    const dice = textOverlap(entry.content, m.content);
    const bar =
      m.person && m.person === entry.person
        ? CONFLICT_DICE_SAME_PERSON
        : CONFLICT_DICE;
    if (dice >= bar)
      found.set(m.id, { entry: m, why: "措辞几乎一样", score: dice });
  }

  // 向量层不可用（或挂了）就只剩措辞那把尺子：少问一句，好过乱问一句。
  let vec: Array<{ id: string; score: number }> = [];
  try {
    vec = await vectorScores(env, entry.content, topK);
  } catch {
    // 向量层故障不该影响记东西
  }
  for (const v of vec) {
    if (v.score < CONFLICT_VECTOR || found.has(v.id)) continue;
    const m = pool.find((p) => p.id === v.id);
    if (m)
      found.set(m.id, {
        entry: m,
        why: "换了个说法，意思贴着",
        score: v.score,
      });
  }

  return [...found.values()].sort((a, b) => b.score - a.score).slice(0, topK);
}

/** 挂进提示词的新鲜疑问（只提 CONFLICT_TTL_DAYS 内写下的），过期的不再反复念。 */
export function conflictBlock(sql: SqlTag, now = Date.now(), max = 3): string {
  const fresh = listConflicted(sql, 50).filter((e) => {
    const t = new Date(e.learned || 0).getTime();
    return Number.isFinite(t) && now - t <= CONFLICT_TTL_DAYS * 86400000;
  });
  if (!fresh.length) return "";
  const lines: string[] = [];
  for (const e of fresh.slice(0, max)) {
    const others = e.conflictsWith
      .map((id) => getMemory(sql, id))
      .filter((x): x is MemEntry => !!x);
    if (!others.length) continue;
    lines.push(`- [${e.id} · 学到${ageLabel(e.learned, now)}] ${e.content}`);
    for (const o of others) {
      lines.push(
        `  ↔ [${o.id} · 学到${ageLabel(o.learned, now)}] ${o.content}`,
      );
    }
  }
  if (!lines.length) return "";
  const more =
    fresh.length > max
      ? `\n（另外还有 ${fresh.length - max} 条，memory conflicts 能看全）`
      : "";
  return (
    "\n\n## 有两句话我还没对上（记下来的时候觉得像，一直没弄明白）\n" +
    lines.join("\n") +
    more +
    "\n聊到相关的事时顺口确认一句；是同一件事的新说法，就把旧的 id 填进 memory add 的 replaces（或直接 supersede），" +
    "确实不是一回事就用 memory coexist 把疑问销掉。别放着不管 —— 放着的话我下次检索到哪条全看运气。"
  );
}

/** 迁移用：按 id 稳定分页，重建向量期间权重变动不会让游标错位。 */
export function pageMemories(
  sql: SqlTag,
  offset: number,
  limit: number,
): MemEntry[] {
  const rows = sql<MemRow>`SELECT * FROM memories ORDER BY id LIMIT ${limit} OFFSET ${offset}`;
  return rows.map(rowToEntry);
}

export function deleteMemory(sql: SqlTag, id: string): MemEntry | null {
  const entry = getMemory(sql, id);
  if (!entry) return null;
  sql`DELETE FROM memories WHERE id = ${id}`;
  // 这条都没了，别人挂在它身上的疑问也就没意义了（不清的话会指向一个不存在的 id）
  settleConflicts(sql, id);
  return entry;
}

// ── 向量层 ───────────────────────────────────────────────

export async function embed(env: Env, text: string): Promise<number[] | null> {
  if (!env.AI) return null;
  const ai = env.AI as unknown as AiRunner;
  const out = (await ai.run(EMBED_MODEL, { text: [text] })) as {
    data?: number[][];
  };
  const v = out?.data?.[0];
  if (!v || !v.length) return null;
  usage.noteEmbed(text);
  return v;
}

export async function upsertVector(
  env: Env,
  entry: {
    id: string;
    content: string;
    type: string;
    shelf: string;
    tags: string[];
  },
): Promise<boolean> {
  if (!env.AI || !env.VECTORIZE_INDEX) return false;
  const values = await embed(env, entry.content);
  if (!values) return false;
  const index = env.VECTORIZE_INDEX as unknown as VectorIndex;
  await index.upsert([
    {
      id: entry.id,
      values,
      metadata: {
        type: entry.type,
        shelf: entry.shelf,
        tags: entry.tags.join(","),
        date: new Date().toISOString().slice(0, 10),
      },
    },
  ]);
  usage.noteVecUpsert(1);
  return true;
}

export async function deleteVector(env: Env, id: string): Promise<void> {
  if (!env.VECTORIZE_INDEX) return;
  const index = env.VECTORIZE_INDEX as unknown as VectorIndex;
  await index.deleteByIds?.([id]);
  usage.noteVecDelete(1);
}

/** 向量检索的原始结果（带相似度）。挑冲突候选要用分数，光有 id 不够。 */
async function vectorScores(
  env: Env,
  query: string,
  topK: number,
): Promise<Array<{ id: string; score: number }>> {
  if (!env.AI || !env.VECTORIZE_INDEX) return [];
  const values = await embed(env, query);
  if (!values) return [];
  const index = env.VECTORIZE_INDEX as unknown as VectorIndex;
  const res = await index.query(values, { topK, returnMetadata: "none" });
  usage.noteVecQuery(topK);
  return (res.matches || [])
    .filter((m) => !!m?.id)
    .map((m) => ({ id: m.id, score: m.score }));
}

// ── 混合检索（关键词 + 向量） ─────────────────────────────

/**
 * 中日韩整字之间没有空格，得另切一刀；用码点区间便于 diff 阅读。
 */
function isCjk(ch: string): boolean {
  const c = ch.codePointAt(0) ?? 0;
  return (
    (c >= 0x3400 && c <= 0x4dbf) ||
    (c >= 0x4e00 && c <= 0x9fff) ||
    (c >= 0xf900 && c <= 0xfaff)
  );
}

/** 空白与中英文标点：非中文段按它们再切一次。 */
const KW_SEP = /[\s,，。？！?、;；:：.]+/;

/**
 * 检索词切关键词：中文按二字组切（无空格，整句逐字匹配几乎不命中，长句就全压向量层），
 * 非中文按空白/标点切，单字丢弃（「的」「了」命中一切等于没命中）。
 */
export function memoryKeywords(query: string): string[] {
  const out = new Set<string>();
  const q = query.toLowerCase();
  let i = 0;
  while (i < q.length) {
    // 按「中文段 / 非中文段」拆：中英夹在一块时（"AI模型"）两边都要留下，
    // 整段当一个词会两头都不命中
    const cjk = isCjk(q[i]);
    let j = i;
    while (j < q.length && isCjk(q[j]) === cjk) j++;
    const run = q.slice(i, j);
    if (cjk) {
      for (let k = 0; k + 1 < run.length; k++) out.add(run.slice(k, k + 2));
    } else {
      for (const w of run.split(KW_SEP)) if (w.length > 1) out.add(w);
    }
    i = j;
  }
  return [...out];
}

function ageInDays(date: string, now: number): number {
  const d = Math.max(0, (now - new Date(date || 0).getTime()) / 86400000);
  return Number.isFinite(d) ? d : 0;
}

/** 衰减按「学到的时刻」算：三年前的事今天才听说，不该因事老先掉权重。 */
function learnedAt(entry: MemEntry): string {
  return entry.learned || entry.date;
}

/** 单条记忆的关键词得分：命中 tag / 正文 / 书架 / 标题分别加权，再按天数衰减。 */
export function scoreMemory(
  entry: MemEntry,
  keywords: string[],
  now = Date.now(),
): number {
  let score = entry.weight || 0.5;
  const content = entry.content.toLowerCase();
  const title = (entry.title || "").toLowerCase();
  for (const kw of keywords) {
    if (entry.tags.some((t) => t.includes(kw))) score += 0.3;
    if (title.includes(kw)) score += 0.25;
    if (content.includes(kw)) score += 0.15;
    if ((entry.shelf || "").includes(kw)) score += 0.1;
  }
  return (
    score *
    Math.max(0.5, 1 - Math.min(ageInDays(learnedAt(entry), now), 365) / 90)
  );
}

/**
 * 关键词打分 + 向量命中加权；向量层不可用时静默退化为纯关键词。
 * 已作废的不进扫描池，旧向量即使还在也命中不了。
 */
export async function searchMemories(
  sql: SqlTag,
  env: Env,
  query: string,
  limit = 5,
  opts: MemQuery = {},
): Promise<MemEntry[]> {
  // 缓存键带分支标志：来客受限读/公开读/带作废是三条 SQL，同词不同答案。
  const key = JSON.stringify([
    query,
    limit,
    opts.guestOwnerKey ?? "",
    opts.onlyPublic ?? false,
    opts.includeSuperseded ?? false,
  ]);
  if (opts.cache?.has(key)) return opts.cache.get(key)!;
  const hits = await searchMemoriesFresh(sql, env, query, limit, opts);
  opts.cache?.set(key, hits);
  return hits;
}

/** searchMemories 的本体（无缓存）。 */
async function searchMemoriesFresh(
  sql: SqlTag,
  env: Env,
  query: string,
  limit = 5,
  opts: MemQuery = {},
): Promise<MemEntry[]> {
  // 公开检索/来客受限读是「别人来问」，不记权重。EXISTS 子查询与 listPublicMemories 同一扇门，改要一起改。
  // 来客分支里 owner_key 命中不受 hold 挡：收回挡的是自动放行，不是「他翻自己的账」。
  const rows = opts.guestOwnerKey
    ? sql<MemRow>`
    SELECT * FROM memories WHERE superseded_by = ''
    AND (owner_key = ${opts.guestOwnerKey} OR (visibility_hold = 0 AND (
      (visibility = 'public' AND memories.sensitivity <> 'topsecret') OR EXISTS (
      SELECT 1 FROM tag_access ta
      WHERE ta.max_level <> ''
        AND instr(',' || memories.tags || ',', ',' || ta.tag || ',') > 0
        AND (CASE memories.sensitivity
             WHEN 'trivial' THEN 0 WHEN 'normal' THEN 1 WHEN 'important' THEN 2
             WHEN 'secret' THEN 3 WHEN 'topsecret' THEN 4 ELSE 1 END)
        <= (CASE ta.max_level
             WHEN 'trivial' THEN 0 WHEN 'normal' THEN 1 WHEN 'important' THEN 2
             WHEN 'secret' THEN 3 ELSE 0 END)
    ))))
    ORDER BY weight DESC LIMIT ${SCAN_LIMIT}`
    : opts.onlyPublic
      ? sql<MemRow>`
    SELECT * FROM memories WHERE superseded_by = '' AND visibility_hold = 0
    AND ((visibility = 'public' AND memories.sensitivity <> 'topsecret') OR EXISTS (
      SELECT 1 FROM tag_access ta
      WHERE ta.max_level <> ''
        AND instr(',' || memories.tags || ',', ',' || ta.tag || ',') > 0
        AND (CASE memories.sensitivity
             WHEN 'trivial' THEN 0 WHEN 'normal' THEN 1 WHEN 'important' THEN 2
             WHEN 'secret' THEN 3 WHEN 'topsecret' THEN 4 ELSE 1 END)
        <= (CASE ta.max_level
             WHEN 'trivial' THEN 0 WHEN 'normal' THEN 1 WHEN 'important' THEN 2
             WHEN 'secret' THEN 3 ELSE 0 END)
    ))
    ORDER BY weight DESC LIMIT ${SCAN_LIMIT}`
      : opts.includeSuperseded
        ? sql<MemRow>`SELECT * FROM memories ORDER BY weight DESC LIMIT ${SCAN_LIMIT}`
        : sql<MemRow>`SELECT * FROM memories WHERE superseded_by = '' ORDER BY weight DESC LIMIT ${SCAN_LIMIT}`;
  if (!rows.length) return [];
  const entries = rows.map(rowToEntry);

  const keywords = memoryKeywords(query);
  // 打分与量基线必须同一个 now：各取各的，几毫秒衰减差就能把零命中条目顶过门槛。
  const now = Date.now();
  const scored = entries.map((entry) => ({
    entry,
    score: scoreMemory(entry, keywords, now),
  }));

  const hits = new Map<string, number>();
  try {
    for (const m of await vectorScores(env, query, limit))
      if (!hits.has(m.id)) hits.set(m.id, m.score);
  } catch {
    // 向量层故障不应影响对话
  }

  const merged = scored.map(({ entry, score }) => ({
    entry,
    // 加分用余弦本身，不用固定加分：固定加分让 0.86 与 0.55 同分，还会压过关键词的 0.15/0.3。
    score: score + (hits.get(entry.id) ?? 0),
    vec: hits.get(entry.id) ?? 0,
    // kw 单独留原值：用总分减向量分还原会有浮点噪声，零命中就不该过门槛。
    kw: score,
  }));
  merged.sort((a, b) => b.score - a.score);
  // 有明确关键词时，关键词命中（去掉向量分仍高于基线）或余弦达门槛才进结果；
  // 两条都不沾的不占名额。纯问句没有关键词，不设这道门。
  const kept = keywords.length
    ? merged.filter(
        ({ entry, kw, vec }) =>
          vec >= RECALL_MIN_VECTOR || kw > scoreMemory(entry, [], now),
      )
    : merged;
  const selected = kept.slice(0, limit);
  if (!opts.onlyPublic && !opts.guestOwnerKey)
    touchWeights(sql, new Set(selected.map((s) => s.entry.id)), entries);
  return selected.map((s) => s.entry);
}

/**
 * 命中 → 权重 +0.05（封顶 1），未命中一行都不写（每次检索最多写 limit 行）。
 * 旧版每次检索 UPDATE 全部扫描行，烧穿 DO 写入行配额后整表连读都失败
 * （Exceeded allowed rows written）；衰减已由 scoreMemory 的时间项算过，不必落库。
 */
export function touchWeights(
  sql: SqlTag,
  hitIds: Set<string>,
  all: MemEntry[],
): void {
  for (const e of all) {
    if (!hitIds.has(e.id)) continue;
    const w = Math.min(1, (e.weight || 0.5) + 0.05);
    if (w === e.weight) continue; // 已经到顶，再写一次只是白花配额
    // last_accessed_at 跟着记：裁剪的「近期用过就别动」认的是时刻，不是次数
    sql`UPDATE memories SET weight = ${w}, accessed = accessed + 1, last_accessed_at = ${Date.now()} WHERE id = ${e.id}`;
  }
}
