// 会话存储：一条元信息 + 一列消息，按 (session_id, seq) 分行存。
// 不用 AIChatAgent 自带的 cf_ai_chat_agent_messages：它只装当前一场，换会话就没了；
// 会话要能列表/切回/公开，且单行有大小上限，长对话压一个 JSON blob 会撑爆。

import type { UIMessage } from "ai";
import type { SqlTag } from "./state";

export type SessionVisibility = "private" | "public";

/**
 * 本场步骤：字段与全局待办（Task）相同，作用域不同——那个跨会话，这个只属于这一场。
 * 分成两个类型，让「这场」和「所有场」在类型上不混。
 */
export interface SessionTask {
  title: string;
  desc: string;
  status: "todo" | "doing" | "done";
  created: string;
}

/** 本场步骤的条数上限：比全局待办的 50 小 —— 这是「这一场」的步骤，不是待办仓库 */
export const SESSION_TASK_CAP = 20;

/**
 * 本场目标上限（会进提示词）；截断在写入层做，谁写都躲不掉。
 */
export const SESSION_GOAL_MAX = 600;

/** 会话列表里一条。msgCount 由子查询算出来，前端要拿它判断「这场有没有内容」 */
export interface SessionMeta {
  id: string;
  title: string;
  visibility: SessionVisibility;
  created: string;
  lastActive: string;
  /**
   * 置顶时刻（ISO）；空串 = 没置顶。记时刻是为了按置顶先后排：0/1 分不出先后。
   */
  pinned: string;
  msgCount: number;
  /** 这场是否已经有过上下文压缩（前端用来标一句「更早的已压缩」） */
  hasDigest: boolean;
  /** 收起（归档）不是删除：内容照搜、能展开，只是不占列表顶部。 */
  archived: boolean;
  /**
   * 名字是人起的还是我起过就定下了。起标题要等开场白出来，光看标题像不像截断判断不出；
   * 记个记号，避免「标题没被动过」导致永远不动手。
   */
  named: boolean;
  /**
   * 我主动开的场、他还没看过：侧栏先闪一下，再退成角标，直到他点进去（切过去时清掉）。
   */
  unread: boolean;
  /**
   * 这场上一次「休息态回想」是什么时候（ISO）；空串 = 从没回头看过。
   * 界面上拿它说「上次回头看是几时」，也是「这场我有印象」的证据。
   */
  recapAt: string;
  /**
   * 这场住哪间屋。空串 = 本屋宿主的场（屋内 loadSessionMessages）；非空 = 场屋名（切过去 = 换连接）。
   * 只有目录屋（人屋）的行带场屋名——那是指路，不是存储。
   */
  home: string;
}

interface SessionRow {
  id: string;
  title: string;
  visibility: string;
  created: string;
  last_active: string;
  pinned: string;
  n: number;
  digest: string;
  archived: number;
  named: number;
  unread: number;
  recap_upto: number;
  recap_at: string;
  home: string;
}

export function ensureSessionSchema(db: SqlTag): void {
  db`create table if not exists sessions (
    id text primary key,
    title text not null,
    visibility text not null default 'private',
    created text not null,
    last_active text not null,
    pinned text not null default '',
    digest text not null default '',
    digest_upto text not null default '',
    goal text not null default '',
    archived integer not null default 0,
    named integer not null default 0,
    unread integer not null default 0,
    recap_upto integer not null default 0,
    recap_at text not null default '',
    recap_schedule text not null default ''
  )`;
  db`create table if not exists session_messages (
    session_id text not null,
    seq integer not null,
    message text not null,
    primary key (session_id, seq)
  )`;
  // 本场步骤按 session_id 存：一间屋能装好几场，只按屋子存会串台。
  // 不塞进 sessions 的 JSON 列：条目要单独排序/改状态，一行一条更省事。
  db`create table if not exists session_tasks (
    session_id text not null,
    seq integer not null,
    title text not null,
    desc text not null default '',
    status text not null default 'todo',
    created text not null,
    primary key (session_id, seq)
  )`;
  // 老表补列：create table if not exists 不会给已存在的表加列
  try {
    db`alter table sessions add column digest text not null default ''`;
  } catch {
    // 列已存在
  }
  try {
    db`alter table sessions add column digest_upto text not null default ''`;
  } catch {
    // 列已存在
  }
  try {
    db`alter table sessions add column goal text not null default ''`;
  } catch {
    // 列已存在
  }
  try {
    db`alter table sessions add column archived integer not null default 0`;
  } catch {
    // 列已存在
  }
  // 老会话默认 named = 1：它们已经聊过了，标题也是当时定下来的，
  // 不该在下次打开时被补一次标题 —— 那等于替管理员回忆一件旧事的名字。
  try {
    db`alter table sessions add column named integer not null default 1`;
  } catch {
    // 列已存在
  }
  // 老会话默认 unread = 0：它们都是管理员自己开的，不该在升级之后突然集体闪起来
  try {
    db`alter table sessions add column unread integer not null default 0`;
  } catch {
    // 列已存在
  }
  // 回想三样家当：recap_upto（已覆盖到第几条消息，用条数不用消息 id，单调好比较）、
  // recap_at（上次回想时间）、recap_schedule（排程句柄，有人开口时靠它取消这趟）。
  try {
    db`alter table sessions add column recap_at text not null default ''`;
  } catch {
    // 列已存在
  }
  try {
    db`alter table sessions add column recap_schedule text not null default ''`;
  } catch {
    // 列已存在
  }
  // recap_upto 默认 0 = 从没回想过的场（含老场）都欠着；
  // 早年的「老会话豁免」已由 resetLegacyRecapCursors 抹掉，回想对新老场一视同仁。
  try {
    db`alter table sessions add column recap_upto integer not null default 0`;
  } catch {
    // 列已存在
  }
  // 场屋指路牌：这一场住在哪间屋。老场一律空串（= 本屋宿主的场），不用迁移 ——
  // 屋为单位的老场照旧在屋里切，新开的场才各自有屋
  try {
    db`alter table sessions add column home text not null default ''`;
  } catch {
    // 列已存在
  }
  // 置顶时刻。老会话一律空串 = 没置顶，升上来之后列表回到按创建时间排的老样子
  try {
    db`alter table sessions add column pinned text not null default ''`;
  } catch {
    // 列已存在
  }
}

/**
 * 抹掉「老会话豁免」：当年把存量游标回填成消息总条数，等于标成已回想，老聊天永远回想不到。
 * 只清 recap_at 为空（从没真回想）的场；条件幂等，真回想过的场不动。
 */
export function resetLegacyRecapCursors(db: SqlTag): void {
  db`update sessions set recap_upto = 0 where recap_at = '' and recap_upto > 0`;
}

export function newSessionId(): string {
  return "s" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

const toMeta = (r: SessionRow): SessionMeta => ({
  id: r.id,
  title: r.title,
  visibility: r.visibility === "public" ? "public" : "private",
  created: r.created,
  lastActive: r.last_active,
  pinned: r.pinned || "",
  msgCount: r.n,
  hasDigest: !!r.digest,
  archived: !!r.archived,
  named: !!r.named,
  unread: !!r.unread,
  recapAt: r.recap_at || "",
  home: r.home || "",
});

/**
 * 会话列表：按创建时间倒序，顺序一旦定下不再变（从前按 last_active 排，一回话就换位）。
 * 「最近聊过」只留在 lastActive 供显示与回想调度；常够着的用置顶。
 */
export function listSessions(db: SqlTag): SessionMeta[] {
  const rows = db<SessionRow>`
    select s.id, s.title, s.visibility, s.created, s.last_active, s.pinned, s.digest, s.archived, s.named, s.unread, s.recap_at, s.home,
      (select count(*) from session_messages m where m.session_id = s.id) as n
    from sessions s
    order by s.created desc, s.id desc`;
  return rows.map(toMeta);
}

/** 来客看到的公开会话。归档过的从公开列表里收起 —— 主人都收起来了，还摆在外面给人读不合常理。 */
export function listPublicSessions(db: SqlTag): SessionMeta[] {
  const rows = db<SessionRow>`
    select s.id, s.title, s.visibility, s.created, s.last_active, s.pinned, s.digest, s.archived, s.named, s.unread, s.recap_at, s.home,
      (select count(*) from session_messages m where m.session_id = s.id) as n
    from sessions s
    where s.visibility = 'public' and s.archived = 0
    order by s.created desc, s.id desc`;
  return rows.map(toMeta);
}

export function getSession(db: SqlTag, id: string): SessionMeta | null {
  const rows = db<SessionRow>`
    select s.id, s.title, s.visibility, s.created, s.last_active, s.pinned, s.digest, s.archived, s.named, s.unread, s.recap_at, s.home,
      (select count(*) from session_messages m where m.session_id = s.id) as n
    from sessions s
    where s.id = ${id}`;
  return rows.length ? toMeta(rows[0]) : null;
}

/** 这场的上下文摘要，以及它已经覆盖到的最后一条消息 id。 */
export function getSessionDigest(
  db: SqlTag,
  id: string,
): { digest: string; upto: string } {
  const rows = db<{ digest: string; digest_upto: string }>`
    select digest, digest_upto from sessions where id = ${id}`;
  return rows.length
    ? { digest: rows[0].digest || "", upto: rows[0].digest_upto || "" }
    : { digest: "", upto: "" };
}

export function setSessionDigest(
  db: SqlTag,
  id: string,
  digest: string,
  upto: string,
): void {
  db`update sessions set digest = ${digest}, digest_upto = ${upto} where id = ${id}`;
}

/**
 * 本场目标（向前看），与 digest（回头看）并排存。
 * 空串 = 没设目标；不替它编——编的目标只是背景噪音。
 */
export function getSessionGoal(db: SqlTag, id: string): string {
  const rows = db<{ goal: string }>`
    select goal from sessions where id = ${id}`;
  return rows.length ? rows[0].goal || "" : "";
}

export function setSessionGoal(db: SqlTag, id: string, goal: string): void {
  const text = goal.trim().slice(0, SESSION_GOAL_MAX);
  db`update sessions set goal = ${text} where id = ${id}`;
}

/** 这场排的步骤，按排定的先后。 */
export function listSessionTasks(db: SqlTag, sessionId: string): SessionTask[] {
  const rows = db<{
    title: string;
    desc: string;
    status: string;
    created: string;
  }>`
    select title, desc, status, created from session_tasks
    where session_id = ${sessionId} order by seq asc`;
  return rows.map((r) => ({
    title: r.title,
    desc: r.desc || "",
    status: r.status === "doing" || r.status === "done" ? r.status : "todo",
    created: r.created || "",
  }));
}

/**
 * 整表替换本场步骤：写入的两条路都落到「一份新完整清单」，没必要维护 add/update/delete。
 * 步骤封顶 20 条，单行重写量可控。
 */
export function saveSessionTasks(
  db: SqlTag,
  sessionId: string,
  tasks: SessionTask[],
): void {
  db`delete from session_tasks where session_id = ${sessionId}`;
  tasks.slice(0, SESSION_TASK_CAP).forEach((t, i) => {
    db`insert into session_tasks (session_id, seq, title, desc, status, created)
       values (${sessionId}, ${i}, ${t.title}, ${t.desc || ""}, ${t.status}, ${t.created || ""})`;
  });
}

/** 这场已回想到第几条、上次几时、排程句柄是谁。 */
export function getSessionRecap(
  db: SqlTag,
  id: string,
): { upto: number; at: string; schedule: string } {
  const rows = db<{
    recap_upto: number;
    recap_at: string;
    recap_schedule: string;
  }>`
    select recap_upto, recap_at, recap_schedule from sessions where id = ${id}`;
  return rows.length
    ? {
        upto: rows[0].recap_upto ?? 0,
        at: rows[0].recap_at || "",
        schedule: rows[0].recap_schedule || "",
      }
    : { upto: 0, at: "", schedule: "" };
}

export function setSessionRecap(
  db: SqlTag,
  id: string,
  upto: number,
  at: string,
): void {
  db`update sessions set recap_upto = ${upto}, recap_at = ${at}, recap_schedule = '' where id = ${id}`;
}

export function setSessionRecapSchedule(
  db: SqlTag,
  id: string,
  schedule: string,
): void {
  db`update sessions set recap_schedule = ${schedule} where id = ${id}`;
}

/**
 * 该回想的场：停够久且之后又添过新话。「有没有新内容」由这条 SQL 现算，不另记账。
 * 归档的场也在列——收起不等于这段过去不算数。
 */
export function listRecapCandidates(
  db: SqlTag,
  idleBeforeIso: string,
): Array<{ id: string; lastActive: string; upto: number; n: number }> {
  return db<{ id: string; lastActive: string; upto: number; n: number }>`
    select s.id as id, s.last_active as lastActive, s.recap_upto as upto,
      (select count(*) from session_messages m where m.session_id = s.id) as n
    from sessions s
    where s.last_active < ${idleBeforeIso}
      and s.recap_upto < (select count(*) from session_messages m where m.session_id = s.id)
    order by s.last_active asc`;
}

/** 这一场存了多少条消息。回想写回后要用它算新游标。 */
export function countSessionMessages(db: SqlTag, id: string): number {
  const rows = db<{ n: number }>`
    select count(*) as n from session_messages where session_id = ${id}`;
  return rows.length ? rows[0].n : 0;
}

export function insertSession(
  db: SqlTag,
  input: {
    id: string;
    title: string;
    visibility: SessionVisibility;
    created: string;
    named?: boolean;
    /** 场屋指路牌（只在目录屋登记场屋时给；本屋自己的场不带） */
    home?: string;
  },
): void {
  // or ignore：场屋落位回报是幂等登记，目录里已有的（点名开的场）不许被顶掉
  db`insert or ignore into sessions (id, title, visibility, created, last_active, named, home)
     values (${input.id}, ${input.title}, ${input.visibility}, ${input.created}, ${input.created}, ${input.named ? 1 : 0}, ${input.home || ""})`;
}

/**
 * 改名（管理员改或我起标题）：一并立 named。名字定过一次就不再动——那是管理员记忆里的名字。
 */
export function renameSession(db: SqlTag, id: string, title: string): boolean {
  db`update sessions set title = ${title}, named = 1 where id = ${id}`;
  return !!getSession(db, id);
}

export function setSessionVisibility(
  db: SqlTag,
  id: string,
  visibility: SessionVisibility,
): boolean {
  db`update sessions set visibility = ${visibility} where id = ${id}`;
  return !!getSession(db, id);
}

/** 收起 / 展开。不动 visibility，所以「展开」之后公开状态原样回来。 */
export function setSessionArchived(
  db: SqlTag,
  id: string,
  archived: boolean,
): boolean {
  db`update sessions set archived = ${archived ? 1 : 0} where id = ${id}`;
  return !!getSession(db, id);
}

/**
 * 置顶/取消。置顶区按时刻升序：取消再顶 = 排到末尾。置顶与归档互不干涉。
 */
export function setSessionPinned(
  db: SqlTag,
  id: string,
  pinned: boolean,
): boolean {
  db`update sessions set pinned = ${pinned ? new Date().toISOString() : ""} where id = ${id}`;
  return !!getSession(db, id);
}

/** 我自己开了一场、他还没看过。闪和角标都以这个记号为据。 */
export function markSessionUnread(db: SqlTag, id: string): void {
  db`update sessions set unread = 1 where id = ${id}`;
}

/**
 * 他看过了：清记号不碰内容。清早一点没关系，晚了角标赖着，用两次就被学会无视。
 */
export function markSessionRead(db: SqlTag, id: string): void {
  db`update sessions set unread = 0 where id = ${id}`;
}

export function touchSession(db: SqlTag, id: string, when: string): void {
  db`update sessions set last_active = ${when} where id = ${id}`;
}

export function removeSession(db: SqlTag, id: string): void {
  db`delete from session_messages where session_id = ${id}`;
  db`delete from sessions where id = ${id}`;
}

/**
 * 键名排过序的 JSON：JSON.stringify 认键序，同内容换键序就被当成变了、每轮全量重写。
 * 老数据按原键序存，本版后每场第一次保存会整体重写一遍，自愈，不用迁移。
 */
function stableJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      out[k] = sortKeys((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return value;
}

/**
 * 保存本场消息，只写变了的那些（先读后比，读不占写入额度）；会话变短才删尾巴。
 * 旧版先清空再全量写回，每轮最多写四百来行，实际通常只动最新一两条。
 * 返回「有没有真动过」：只翻列表/点开旧场不该记成新内容，last_active 管着回想调度。
 */
export function saveSessionMessages(
  db: SqlTag,
  id: string,
  messages: UIMessage[],
): boolean {
  const rows = db<{ seq: number; message: string }>`
    select seq, message from session_messages where session_id = ${id}`;
  const old = new Map<number, string>();
  let stale = false;
  for (const r of rows) {
    old.set(r.seq, r.message);
    if (r.seq >= messages.length) stale = true;
  }

  let changed = false;
  messages.forEach((m, i) => {
    const json = stableJson(m);
    if (old.get(i) === json) return;
    changed = true;
    db`insert into session_messages (session_id, seq, message) values (${id}, ${i}, ${json})
       on conflict(session_id, seq) do update set message = excluded.message`;
  });

  // 库里比现在还长的那些（会话被清短了）才删。没多出来的就别发这条语句 ——
  // 一条「删零行」虽然不吃写入额度，但白占一次往返，账面上也会多一笔
  if (stale) {
    changed = true;
    db`delete from session_messages where session_id = ${id} and seq >= ${messages.length}`;
  }
  return changed;
}

/**
 * 往会话尾部追加一条（不覆盖）：提醒到点时那句属于约定它的场，可能不在对话流里。
 */
export function appendSessionMessage(
  db: SqlTag,
  id: string,
  message: UIMessage,
): void {
  const rows = db<{ n: number | null }>`
    select max(seq) as n from session_messages where session_id = ${id}`;
  const next = (rows[0]?.n ?? -1) + 1;
  db`insert into session_messages (session_id, seq, message) values (${id}, ${next}, ${stableJson(message)})`;
}

export function loadSessionMessages(db: SqlTag, id: string): UIMessage[] {
  const rows = db<{ message: string }>`
    select message from session_messages where session_id = ${id} order by seq asc`;
  const out: UIMessage[] = [];
  for (const r of rows) {
    try {
      out.push(JSON.parse(r.message) as UIMessage);
    } catch {
      // 单条坏了不该让整场对话打不开，跳过
    }
  }
  return out;
}

/** 一条跨会话检索的命中。message 是那段命中的正文文本。 */
export interface RecallHit {
  sessionId: string;
  sessionTitle: string;
  lastActive: string;
  role: string;
  message: string;
}

function plainText(m: UIMessage): string {
  return m.parts
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join(" ")
    .trim();
}

/**
 * LIKE 转义：%、_、\ 转成字面量，并在 SQL 里 ESCAPE '\'，否则搜「100%」会宽出一大片。
 */
function likePattern(q: string): string {
  return "%" + q.replace(/[%_\\]/g, (c) => "\\" + c) + "%";
}

/**
 * 跨会话回忆：LIKE 全文扫，不走向量（中文实词不会误命中内嵌 uuid，够用）。
 * 按会话活跃时间排序，返回纯文本片段。
 */
export function searchMessages(db: SqlTag, q: string, limit = 8): RecallHit[] {
  const pat = likePattern(q);
  const rows = db<{
    session_id: string;
    message: string;
    title: string;
    last_active: string;
  }>`
    select m.session_id, m.message, s.title, s.last_active
    from session_messages m
    join sessions s on s.id = m.session_id
    where m.message like ${pat} escape '\\' or s.title like ${pat} escape '\\'
    order by s.last_active desc
    limit ${limit}`;
  const out: RecallHit[] = [];
  for (const r of rows) {
    let msg: UIMessage | null = null;
    try {
      msg = JSON.parse(r.message) as UIMessage;
    } catch {
      continue;
    }
    const text = plainText(msg);
    if (!text) continue;
    out.push({
      sessionId: r.session_id,
      sessionTitle: r.title,
      lastActive: r.last_active,
      role: msg.role,
      message: text.slice(0, 500),
    });
  }
  return out;
}

// ── 场屋原话索引：recall 的跨场账本 ─────────────────────────
// 场屋消息存在场屋，目录屋翻不到；场屋轮尾把新消息（谁说的、说了什么）寄回一行。
// 消息本体不动，只是可搜索目录页，正文截 500 字。

export interface RecallIndexRow {
  /** 消息 id（UIMessage.id）：幂等键 */
  id: string;
  sessionId: string;
  role: string;
  text: string;
  ts: string;
}

function ensureRecallIndex(db: SqlTag): void {
  db`CREATE TABLE IF NOT EXISTS recall_index (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    role TEXT NOT NULL,
    text TEXT NOT NULL,
    ts TEXT NOT NULL
  )`;
  db`CREATE INDEX IF NOT EXISTS idx_recall_index_session ON recall_index(session_id)`;
}

/**
 * 收场屋寄回的原话索引。INSERT OR IGNORE 按消息 id 幂等，重启全量重寄也不会写重。
 */
export function insertRecallIndexRows(
  db: SqlTag,
  rows: RecallIndexRow[],
): void {
  if (!rows.length) return;
  ensureRecallIndex(db);
  for (const r of rows) {
    if (!r || typeof r.id !== "string" || typeof r.text !== "string") continue;
    if (!r.id || !r.text.trim()) continue;
    db`INSERT OR IGNORE INTO recall_index (id, session_id, role, text, ts)
       VALUES (${r.id}, ${r.sessionId || ""}, ${r.role || ""}, ${r.text}, ${r.ts || ""})`;
  }
}

/**
 * 搜场屋原话索引。join sessions 拿标题/活跃时刻；未登记的行搜不到，可接受。
 */
export function searchRecallIndex(
  db: SqlTag,
  q: string,
  limit = 8,
): RecallHit[] {
  ensureRecallIndex(db);
  const pat = likePattern(q);
  const rows = db<{
    session_id: string;
    text: string;
    title: string;
    last_active: string;
    role: string;
  }>`
    select i.session_id, i.text, i.role, s.title, s.last_active
    from recall_index i
    join sessions s on s.id = i.session_id
    where i.text like ${pat} escape '\\' or s.title like ${pat} escape '\\'
    order by s.last_active desc
    limit ${limit}`;
  return rows.map((r) => ({
    sessionId: r.session_id,
    sessionTitle: r.title,
    lastActive: r.last_active,
    role: r.role,
    message: r.text.slice(0, 500),
  }));
}
