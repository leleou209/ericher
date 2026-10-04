// 记忆库：memories 表（SQLite） + bge-m3 embedding + Vectorize 语义检索。
//
// 为什么不用 state.longMemory：记忆会长到上千条，塞在单个 JSON blob 里
// 每次改动都要整体重写（写放大 + 并发丢更新）。

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

/**
 * 会变的记忆隔多久没复核就该提醒一次。
 * 30 天是个粗数，但复核提醒本来就不该精确 —— 它是「该问一句了」，不是「今天必须问」。
 */
export const REVIEW_DAYS = 30;

/**
 * 悬着的疑问挂过这么久还没对上，就不再往提示词里放了。
 * 一个疑问反复出现在每一轮里，很快就不再是疑问，而变成背景噪音 ——
 * 那样我下次真的撞上冲突时也不会当回事。账本不清，面板上照样看得见。
 */
const CONFLICT_TTL_DAYS = 7;

/** 措辞几乎一样（字符二元组重合度）——「同一句话改了个细节」这种。 */
const CONFLICT_DICE = 0.5;
/** 同一个人身上，尺子放松一点：他身上的两句话像，更值得多看一眼。 */
const CONFLICT_DICE_SAME_PERSON = 0.35;
/** 换了说法但意思贴着（向量余弦）。 */
const CONFLICT_VECTOR = 0.72;

/**
 * 检索向量路的最低相关门槛（余弦）。
 * bge-m3 的余弦 0.35 以下基本是「同一个领域但不相干」—— 那种命中不配占名额。
 * 和 CONFLICT_VECTOR 是两把不同的尺子：那边问「是不是在说同一件事」，这边问「相不相关」。
 */
const RECALL_MIN_VECTOR = 0.35;

/** 这条说的是「他是谁 / 什么一直成立」，还是「他现在怎么样」。 */
export type Volatility = "stable" | "volatile";

/** 条目的正文上限：一句话说得清的，硬写长反而是没想清 */
const ENTRY_CAP = 500;
/** 书册的正文上限：成体系的一篇文章值得上万字，但记忆库不是无限仓库 */
const BOOK_CAP = 20000;
/**
 * 会话回想的正文上限。
 * 它要塞下「这一段聊了什么」加「怎么聊的」，500 字装不住；
 * 但它也不是书册 —— 一场对话的一次回头，一千来字已经是把话说尽了。
 */
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
    // 只在刚刚补上这一列时回填一次：老数据只知道日期不知道具体时刻，
    // 用当天零点顶上 —— 宁可粗一点，也不编一个精确时刻。
    sql`UPDATE memories SET learned = date || 'T00:00:00.000Z' WHERE learned = '' AND date <> ''`;
  } catch {
    // 列已存在，不回填
  }
  try {
    sql`ALTER TABLE memories ADD COLUMN superseded_by TEXT NOT NULL DEFAULT ''`;
  } catch {
    // 列已存在
  }
  // 老记忆一律落在 stable 上：不是因为它真的不变，而是「我不知道它会不会变」
  // 这件事不该被我编成「它会变」——那会让复核清单一次涌进几十条，把提醒变成噪音。
  // 要改就改那一条：我确认的时候顺手改，管理员也能在面板上点。
  try {
    sql`ALTER TABLE memories ADD COLUMN volatility TEXT NOT NULL DEFAULT 'stable'`;
  } catch {
    // 列已存在
  }
  // 空串 = 从没复核过。老数据就该是这个值，不能拿 learned 顶上，
  // 那等于替管理员宣布「这条我核对过了」。
  try {
    sql`ALTER TABLE memories ADD COLUMN verified TEXT NOT NULL DEFAULT ''`;
  } catch {
    // 列已存在
  }
  sql`CREATE INDEX IF NOT EXISTS idx_memories_person ON memories(person)`;
  // 公开标记：默认 private。老数据一律落 private —— 它们是在「能不能给外人看」
  // 这件事存在之前写的，当时没人同意过什么，所以不能替谁做主公开。
  try {
    sql`ALTER TABLE memories ADD COLUMN visibility TEXT NOT NULL DEFAULT 'private'`;
  } catch {
    // 列已存在
  }
  sql`CREATE INDEX IF NOT EXISTS idx_memories_visibility ON memories(visibility)`;
  sql`CREATE INDEX IF NOT EXISTS idx_memories_superseded ON memories(superseded_by)`;
  sql`CREATE INDEX IF NOT EXISTS idx_memories_volatility ON memories(volatility)`;

  // 这件事从什么时候开始成立。老数据只知道「我什么时候学到的」，
  // 那就先用 learned 顶上 —— 这是它唯一能有的答案，不是我编的。
  try {
    sql`ALTER TABLE memories ADD COLUMN valid_at TEXT NOT NULL DEFAULT ''`;
    sql`UPDATE memories SET valid_at = learned WHERE valid_at = '' AND learned <> ''`;
  } catch {
    // 列已存在，不回填
  }
  // 到什么时候不再成立。老数据里已经作废的那些，我们只知道「作废了」，
  // 不知道是哪天失效的 —— 空着，界面上会说「失效时间不明」，不编一个时刻出来。
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

  // 书册 / 图像两类记忆的栖身之所：
  //   title    —— 书册的标题（成体系的文章没标题，等于藏在无字天书里）
  //   file_key —— 图像原件在云盘里的 key（记忆里存说明和指针，原件存云盘）
  // 老数据一律空串：它们写下的时候还没有这两种类型，不能替它们补一个没起过的标题。
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

  // 会话记忆的两把钥匙：
  //   session_id —— 这条是哪一场聊出来的（空串 = 和会话无关的普通记忆）
  //   sentiment  —— 那一段说话的语气。它是个标签不是判断，所以只许从固定几个里挑
  // 老数据一律空串：它们写下的时候还没有「哪一场」这个说法，不能替它们认领一场。
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

  // 记忆的量级：这条事知道的人该有多少。AI 写入时按评分公式标，管理员可在面板改。
  // 老数据一律落「一般」—— 它们写下的时候还没有量级这回事，
  // 不能替谁宣布这条重要、更不能替谁宣布它机密。
  try {
    sql`ALTER TABLE memories ADD COLUMN sensitivity TEXT NOT NULL DEFAULT 'normal'`;
  } catch {
    // 列已存在
  }
  // 量级的评分依据（0-9）：AI 打分留下依据，面板上「重要 · 6分」的 6 就是它。
  // 10 不在这个范围里 —— 那是管理员亲手设绝密时才钉上去的记号。
  try {
    sql`ALTER TABLE memories ADD COLUMN score INTEGER NOT NULL DEFAULT 0`;
  } catch {
    // 列已存在
  }
  sql`CREATE INDEX IF NOT EXISTS idx_memories_sensitivity ON memories(sensitivity)`;

  // 归属键：这条记忆经核实属于谁。只认「room:<来客房间名>」——
  // 房间名是 Worker 按签名票（或卡绑定）派生的，客人自己报什么不算数。
  // 从前的归属是 person = 来客·自报称呼：谁报同一个称呼就能翻走别人名下的私事，
  // 所以授权改跟验证键走，person 退成纯展示。老数据一律空串 =
  // 归属无法核实，就不再对任何来客的「名下读取」开放（管理员面板照常可见）。
  try {
    sql`ALTER TABLE memories ADD COLUMN owner_key TEXT NOT NULL DEFAULT ''`;
  } catch {
    // 列已存在
  }
  sql`CREATE INDEX IF NOT EXISTS idx_memories_owner_key ON memories(owner_key)`;

  // 显式收回：管理员亲手点过「不公开」的记号。它压过 tag 门 ——
  // 点收回的承诺是「之后来客再也读不到」，而 tag 门开着的话，
  // 只把 visibility 改回 private 根本收不回来。所以收回要单独落一格：
  //   1 = 管理员最后一次手动决定是「不公开」，tag 门再开也不出门；
  //   0 = 没收回过（或收回后又亲手点过「公开」）。
  // 默认 0：AI 写入、面板改档都不动它 —— 它只听「公开 / 收回」这个按钮的。
  try {
    sql`ALTER TABLE memories ADD COLUMN visibility_hold INTEGER NOT NULL DEFAULT 0`;
  } catch {
    // 列已存在
  }

  // 回想的幂等键：`${sessionId}:${起点}:${记忆用途}`。同键的写入只落第一次 ——
  // 回想把记忆写下了、游标却没推进（写回那一步失败）时，下一趟重跑不该
  // 把同一段再记一遍。空串 = 没有幂等要求，写入照常。
  try {
    sql`ALTER TABLE memories ADD COLUMN dedupe_key TEXT NOT NULL DEFAULT ''`;
  } catch {
    // 列已存在
  }
  sql`CREATE INDEX IF NOT EXISTS idx_memories_dedupe ON memories(dedupe_key)`;

  // 最近一次真的用上这条的时刻（epoch 毫秒）。accessed 是次数不是时间 ——
  // 拿次数去比时间阈值，「最近用过就别裁」的保护形同虚设：次数永远小于毫秒数。
  // 老数据一律 0 = 没记过，不算近期活跃，不挡裁剪。
  try {
    sql`ALTER TABLE memories ADD COLUMN last_accessed_at INTEGER NOT NULL DEFAULT 0`;
  } catch {
    // 列已存在
  }

  // tag 公开门槛：带某个 tag 的记忆，按量级放行给来客 —— 一类一类地开，
  // 不用一条条点公开。表跟着记忆库走（都在主人那间）。
  //   tag       —— 记忆标签，主键
  //   max_level —— 允许出门的最高量级；'' 或没有行 = 这道门没开。
  //                枚举只到 secret：绝密在门槛之外，它没有出门这条路。
  // 公开判定在 SQL 里完成（见 listPublicMemories / searchMemories）——
  // 数据层关上的门，提示词开不了。
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

/**
 * 「学到多久了」的人话版本。
 * 只用来提示新旧，不追求精确 —— 说「3 天前」比说时间戳更接近人怎么想事情。
 */
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

/**
 * 复核参照时刻：确认过就以确认为准，没确认过就退到学到的时候。
 * 不用 date —— date 是事情发生的日子，我什么时候知道它才是关键。
 */
export function reviewRef(
  e: Pick<MemEntry, "verified" | "learned" | "date">,
): string {
  return e.verified || e.learned || e.date;
}

/**
 * 该复核了：会变 + 还算数 + 距上次确认超过 REVIEW_DAYS。
 *
 * 为什么「会不会变」不由书架决定：identity 里既躺着「管理员20岁」（会过期）
 * 又躺着「他喜欢从哲学高度想事情」（不会过期）。决定过期的是这句话在说
 * 「他是谁」还是「他现在怎么样」—— 这是语义判断，该由模型做；
 * 而「多久没确认就该提醒」是确定性计算，该由代码做。分工和作废那套一致。
 */
export function needsReview(e: MemEntry, now = Date.now()): boolean {
  if (e.volatility !== "volatile" || e.supersededBy) return false;
  const t = new Date(reviewRef(e)).getTime();
  if (!Number.isFinite(t) || t <= 0) return true;
  return now - t > REVIEW_DAYS * 86400000;
}

/**
 * 注入系统提示词的那几行记忆。
 *
 * ⚠️ 只挂在命中项上：该不该复核，取决于这条现在有没有被用到 ——
 * 给每条旧记忆都挂标记，等于把提醒稀释成背景噪音，我下次就真的当没看见了。
 */
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
  // 比较用字符串比：ISO 时刻按字典序排就是按时间排，不需要 SQLite 的日期函数。
  // 空串（时间不明）也落在 cutoff 之前，正好该被拎出来。
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

/**
 * 默认只给「还算数」的记忆。
 * 被作废的那些不会消失（历史可查），但不参与检索、不参与人脉计数 ——
 * 因为一条已经被推翻的话，还留在检索池里，就等于我下次可能又把它当事实讲出去。
 */
interface MemQuery {
  includeSuperseded?: boolean;
  /** 只要公开的。来客那间问「管理员公开过什么」时用 —— 别的一律不出这间屋子。 */
  onlyPublic?: boolean;
  /**
   * 来客受限读：public 加上「他名下的」，其余一概不出。
   * 「他名下」按归属键（owner_key = room:<来客房间名>）对——房间名是 Worker
   * 按签名票派生的，客人自己报的称呼进不了这道判断。称呼对得上、屋子对不上，
   * 也翻不走别人的记录。
   * 过滤发生在 SQL 里，不靠提示词自觉 —— 数据层关上的门，提示词开不了。
   */
  guestOwnerKey?: string;
  /**
   * 轮内检索缓存：同轮同参的搜索直接复用，不再打一遍 Vectorize（按维度计费）。
   * 生命周期归调用方管 —— 一轮一清，写入记忆的工具有责任当场清掉。
   */
  cache?: Map<string, MemEntry[]>;
}

/**
 * 只列「来客读得到」的那些 —— 这是两扇门的并集：
 *   ① visibility = 'public'：管理员一条条亲手点过头的；
 *   ② tag 公开门槛：带某个 tag 的、量级不超过门槛的记忆，一类一类放行。
 * 量级比较用 CASE 落成数字（枚举的字典序和轻重不是一回事）；
 * instr 的两头都补了逗号 —— 「ai」不该命中「email」这种子串。
 * topsecret 的序是 4，而门槛最高只到 secret（3），所以 4 <= 3 永假：
 * 绝密不走 tag 这扇门，哪怕管理员手滑把门槛开到最高。
 * visibility = 'public' 那半边也补了同样的排除：记忆可以先点公开、
 * 后被改成绝密 —— 量级是人后改的，公开标记不该替新量级做主。
 * visibility_hold = 0 是第三道闸：管理员点过「不公开」的（显式收回），
 * tag 门再开也不出门 —— 收回的承诺压过一切自动放行。
 *
 * 只给来客的记忆检索用。主人自己看的是 listMemories —— 那边没有门。
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
 * 会话记忆的列表与三种筛选：关键词 / 时间 / 情感，外加「只看某一场」。
 *
 * 为什么不复用 searchMemories：那边 SQL 已经是四路嵌套，再叠书架、情感、
 * 时间窗会变成八路，而这里要的本来就是一串等值的 AND 条件 ——
 * 为它单开一条直白的长语句，比让公共检索长出一堆布尔开关划算。
 * 语义那一半不丢：她在对话里翻记忆走的是 searchMemories + 向量，这条路照旧。
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
 * 公开 / 收回。管理员在面板上点一下就是这个动作，模型不该替他做这个决定。
 *
 * 收回不是「改回 private」就完事：tag 门开着的话，private 挡不住门那半边。
 * 所以收回要单独落一格 visibility_hold = 1 —— 之后 tag 门再开它也不出门，
 * 除非管理员亲手再点一次「公开」（hold 落 0）。这就是「显式收回压过 tag 门」。
 *
 * 绝密没有公开这条路：直接拒绝。想公开，先把量级降下来 —— 这个次序不能反。
 * 例外兜不住的情形是「先公开、后被改成绝密」：那种在查询层挡（见 listPublicMemories
 * 的 sensitivity <> 'topsecret'），这里挡的是动作本身。
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
 * 改一条记忆的量级。五档都设得动 —— 只有这里有绝密（topsecret）：
 * 模型的工具枚举里没有它，公开门槛也放不了它，这把锁只在管理员手里。
 * 亲手设绝密时把 score 钉在 10 —— 10 不是算出来的分，是「人拍的板」的记号；
 * 设别的档不动 score，那是 AI 留的依据，抹了就没法对账。
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
//
// visibility 是一条条点，tag 门槛是一类类开：带某个 tag 的记忆，
// 量级不超过门槛的都出门。判定发生在 SQL 里（listPublicMemories / searchMemories），
// 这里只管账本本身。

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
 * 开 / 关一道门。maxLevel 传 '' 或认不出的值都算关门 —— 关门要关得干脆。
 * 档位只认到 secret：topsecret 不在 TAG_GATE_LEVELS 里，就算有人硬递进来
 * 也落成关门 —— 绝密没有出门这条路，这是设计好的，不是疏漏。
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

/**
 * 全部 tag 的分布。拆逗号在 JS 里做 —— SQLite 没有现成的 split，
 * 为它写递归 CTE 是把直白的事做绕；一列一档两张小表，全扫也扫不疼。
 */
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

/**
 * 盘一次记忆库。
 *
 * 抽出来是为了让「本地盘」和「跨间盘」共用同一把尺子 —— 场屋要把主屋的数并进来时，
 * 两边各算一份最容易悄悄漂开（一侧加了新指标、另一侧忘了跟）。
 */
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
  /**
   * 量级：AI 写入时按评分公式标（工具枚举里没有 topsecret —— 绝密那把锁
   * 只在管理员面板上）。不传落 normal，认不出的值也落 normal。
   */
  sensitivity?: Sensitivity;
  /** 量级的评分依据（0-9）。不传落 0 */
  score?: number;
  /**
   * 归属键（room:<来客房间名>）：经核实的归属，跨房受限读只认它。
   * 只在主人房的来客镜像行上有意义；不传落空串 = 归属未核实，
   * 不对任何「名下读取」开放。person 保留为展示用的称呼。
   */
  ownerKey?: string;
  /**
   * 回想的幂等键：同键的写入只落第一次，第二次直接返回已有的那条。
   * 用于「回想写了记忆、游标却没推进」的重跑场景 —— 同一段不该记两遍。
   */
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
  // 情感也进 tags：这样「关键词」那一路也找得到它，
  // 不用为了「翻一翻最近哪些时候是低落的」专门写一条 SQL
  // 标签是逗号分隔存储的（SQL 里的 tag 门按 `,tag,` 匹配），所以逗号必须剥掉：
  // 不剥的话，来客交一个「自定义,已开放标签」进来，存库后看起来就像真的开了那道门
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
  // 书册装的是成体系的文章，会话回想装的是「刚才那一段」，条目只装一句话说得清的事
  // —— 三个尺寸都钉死在这层
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
  // 归属键只认 room: 前缀且限长 —— 写歪了宁可落空串（= 不对来客开放），也不存一个
  // 将来可能被当成别家归属的值
  const ownerKey = /^room:.{1,80}$/.test(input.ownerKey || "")
    ? input.ownerKey!
    : "";
  // 收回记号只听「公开 / 收回」按钮，AI 写入不碰它：重写的内容算新一版，
  // 和 visibility 一样归零重来，等管理员重新过目。
  const visibilityHold: number = 0;
  // 幂等键：限长 160，超长宁可丢掉幂等保护也不存一个脏值。
  // 非空时先查重 —— 同键只落第一次，重跑的写入原样返回已有条目。
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
 * 快照整行落库 —— 场屋寄回主屋并账的收账口。
 *
 * 和 insertMemory 的分工：insertMemory 是「记一条新的」（生成 id、learned、归一化），
 * 这个是「这一条在那边长什么样，照着抄」—— 作废、疑问、确认时刻这些状态都以快照为准。
 * 幂等：同 id 反复寄，后到的覆盖先到的（durable queue 重试安全）。
 * owner_key / dedupe_key 不在快照里：主人的记忆没有来客归属键，重跑保护是写入侧的事。
 */
export function upsertMemorySnapshot(sql: SqlTag, e: MemEntry): void {
  ensureMemorySchema(sql);
  sql`
    INSERT OR REPLACE INTO memories (id, date, type, tags, weight, shelf, person, visibility, content, accessed, learned, superseded_by, volatility, verified, valid_at, invalid_at, conflicts_with, title, file_key, session_id, sentiment, sensitivity, score, owner_key, visibility_hold, dedupe_key, last_accessed_at)
    VALUES (${e.id}, ${e.date}, ${e.type}, ${e.tags.join(",")}, ${e.weight}, ${e.shelf}, ${e.person}, ${e.visibility}, ${e.content}, ${e.accessed}, ${e.learned}, ${e.supersededBy}, ${e.volatility}, ${e.verified}, ${e.validAt}, ${e.invalidAt}, ${e.conflictsWith.join(",")}, ${e.title}, ${e.fileKey}, ${e.sessionId}, ${e.sentiment}, ${e.sensitivity}, ${e.score}, "", ${e.hold ? 1 : 0}, "", 0)
  `;
}

/**
 * 按回想幂等键找已落的条目。给工具层判「这一段是不是上一趟已经记过」用：
 * 判出重复就整段跳过 —— insertMemory 虽然自己也会挡住重复落库，但它挡不住
 * 调用方拿着返回的旧条目 id 去喂新正文向量，那会让向量层和 SQLite 说两套话。
 * 空键恒返回 null。
 */
export function getMemoryByDedupeKey(
  sql: SqlTag,
  dedupeKey: string,
): MemEntry | null {
  if (!dedupeKey) return null;
  const rows = sql<MemRow>`SELECT * FROM memories WHERE dedupe_key = ${dedupeKey} LIMIT 1`;
  return rows[0] ? rowToEntry(rows[0]) : null;
}

/**
 * 结构性作废：同一件事有了新说法，把旧的标掉，不删除。
 *
 * 为什么不用相似度阈值、也不问模型「哪条更新」：模型擅长的是发现「这两条在说同一件事」，
 * 不擅长比时间戳。所以分工是 —— 模型指出被替代的 id，谁作数由代码说了算。
 * 保留而不删除，是因为「我原来以为…后来才知道…」本身就是有用的信息。
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

// ── 疑问账本：哪几条还没对上 ──────────────────────────────
//
// 只记不判。谁和谁像由两把尺子挑候选（见 findConflicts），
// 「到底算不算同一件事」留给模型 —— 那是语义判断；
// 而「哪条更新」绝不让模型猜（这是踩过的坑），作废一律按 id 由代码执行。

/**
 * 了结关于这条的所有疑问：它自己挂着的清单清空，别人清单里提到它的也一并抹掉。
 *
 * 一个函数管四种情况（作废、删除、说清不冲突、恢复），因为结果都是同一件事：
 * 这条身上没什么可对的了。两边的清单要一起清 —— 只清一边的话，
 * 另一边会一直挂着一个已经不存在的疑问，下次还得再问一遍。
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
 * 字符二元组重合度（Dice 系数）。
 *
 * 为什么这儿用二元组集合而不是复用 memoryKeywords：这两件事不一样。memoryKeywords
 * 切的是「一个词命中不命中正文」，这里比的是「两句完整的话像不像」，要的是整句重合度。
 * 二元组不需要词典，且对「同一句话改了个细节」特别灵：
 * 「管理员在一家小公司工作」vs「管理员在一家小公司工作，做后端」相似度较高，
 * 「管理员喜欢喝咖啡」vs「管理员喜欢喝茶」也有重合，但不能当作同一事实。
 * 它抓不到「换了个说法」的那种（那正是向量那把尺子的活）。
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
 * 找「可能和这条说的是一件事」的旧记忆。
 *
 * 时机是关键：人在听到一句新话的那一刻会想起「你上次不是说…」，
 * 事后专门回头比对是不会发生的。所以这里在写入时当场跑，而不是定期扫。
 *
 * 只挑候选、不下结论 —— 是不是同一件事是语义判断，交给模型；
 * 挑错的代价只是多问一句，漏掉的代价是两条矛盾的话同时躺在记忆库里。
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

/**
 * 挂进系统提示词的那一小段：还没对上、又还新鲜的疑问。
 *
 * 只提「新写下的那条还在 CONFLICT_TTL_DAYS 之内」的：疑问是写下来那天产生的，
 * 过了这么久还没对上，多半是当事人没回应或者本来就不重要 —— 那时候继续提，
 * 就从「我记得有个疑问」变成了「我在反复念同一句话」。
 */
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
 * 中日韩整字：这些字符之间没有空格，得另切一刀。
 * 用码点区间而不是正则转义，是为了让这一行在 diff 里还是人话。
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
 * 把检索词切成关键词。
 *
 * 中文没有空格：只按空白和标点切，「我喜欢喝茶」会变成一个要求逐字出现的词，
 * 于是关键词这条路在中文里几乎从不命中 —— 长句检索全压在向量层上，
 * 向量层一坏就什么都检索不到。所以中文段按二字组切：
 * 二字组盖得住绝大多数中文词，又不必引分词词典。
 * 单字整段丢弃：「的」「了」这种命中所有记忆，等于没有命中。
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

/**
 * 衰减按「学到的时刻」算，不按「事情发生的日期」算。
 * 因为一条三年前的事、今天才听说的记忆，不该因为事老就先掉一半权重。
 */
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
 * 关键词打分 + 向量命中加权。向量层不可用时静默退化为纯关键词检索。
 *
 * 已作废的记忆不进扫描池：向量层可能还留着它们的向量，但扫描时已经不在名单里，
 * 命中加分自然落空 —— 这是有意的，被推翻的话不该再被我检索到。
 */
export async function searchMemories(
  sql: SqlTag,
  env: Env,
  query: string,
  limit = 5,
  opts: MemQuery = {},
): Promise<MemEntry[]> {
  // 缓存键带上分支标志：来客受限读 / 公开读 / 带作废是三条不同的 SQL，
  // 同一个词在不同分支里的答案不同，不能混
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
  // 公开检索 / 来客受限读都是「别人来问」，不进权重：权重记的是我自己用上过多少次，
  // 让一个外人问的话把它顶上去，这池子里的排序就不是我的经历了。
  // 三处 WHERE 里的 EXISTS 子查询和 listPublicMemories 是同一扇 tag 门，改要一起改。
  // 来客分支里 owner_key 命中不受 hold 挡：那是他自己名下的记录，收回挡的是
  // 「自动放行」，不是「他翻自己的账」。hold 只压 visibility / tag 门这两条出路。
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
  // 同一时刻打分、同一时刻量基线：下面门槛的比较是「去掉向量分还高于基线吗」，
  // 两边必须拿同一个 now。各取各的 Date.now() 的话，隔几毫秒衰减就掉了一点点，
  // 零关键词命中的条目会靠时间漂移替它付门槛，混进结果还说不清缘由。
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
    // 加分用余弦本身，不是「进了向量前几名就 +0.5」。固定加分是把两种完全不同的
    // 判断压成一个数：相关度 0.86 和 0.55 拿同样的分，而 0.5 相对关键词那点
    // 0.15/0.3 的加权是压倒性的 —— 结果向量层一可用，关键词命中就基本不作数了。
    score: score + (hits.get(entry.id) ?? 0),
    vec: hits.get(entry.id) ?? 0,
    // 关键词路的原始分单独留一份：门槛若用「总分减向量分」还原它，
    // 浮点里 (X + 0.1) - 0.1 不严格等于 X，±1 ULP 的舍入噪声就能把
    // 零命中的条目抬过门槛 —— 用原值比，零命中就精确等于基线，一步都进不来。
    kw: score,
  }));
  merged.sort((a, b) => b.score - a.score);
  // 检索的门槛：有明确关键词时，一条记忆至少得沾上一点相关性才进结果 ——
  //   关键词路：把向量分拿掉仍高于基线（weight × 时间衰减），说明关键词命中了；
  //   向量路：余弦到达门槛（bge-m3 的余弦 0.35 以下基本是「同领域但不相干」）。
  // 两条路都不沾的不占名额 —— 宁可少带几条，也不把不相干的塞进上下文，
  // 挤掉真正有用的记忆。没有关键词时（纯问句）向量是唯一信号，不设这道门。
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
 * 命中 → 权重 +0.05（上限 1）。**未命中的一行都不写。**
 *
 * 这里原来是「命中上调、未命中按天衰减」，每次检索把扫描到的每一行都 UPDATE 一遍。
 * 改掉它是因为真的出过事：DO 的「写入行数」是配额项，一次检索写几十上百行，
 * 攒够配额之后整张记忆表连**读**都会失败（`Exceeded allowed rows written`），
 * 记忆功能当场全瘫。而这种写还几乎没有意义 ——
 * 衰减在 scoreMemory 的分数里已经按天数算过一遍了，存一份等于同一件事算两遍。
 *
 * 现在 weight 只记「这条被用上过多少次」，新旧由分数里的时间项管；
 * 每次检索最多写 limit（默认 5）行，而且到顶的连写都不写。
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
    // last_accessed_at 跟着记一笔：裁剪的「近期用过就别动」认的是时刻，不是次数
    sql`UPDATE memories SET weight = ${w}, accessed = accessed + 1, last_accessed_at = ${Date.now()} WHERE id = ${e.id}`;
  }
}
