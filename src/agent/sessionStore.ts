// 会话存储：一个会话 = 一条元信息 + 一列属于它的消息。
//
// 为什么不直接用 AIChatAgent 自带的 cf_ai_chat_agent_messages：那张表只装「当前正在聊的
// 这一场」，换会话就得整表换掉，切回去就没了。会话要能列出来、能切回去、能公开给人看，
// 就必须按 session_id 分片自己存一份。
//
// 消息行按 (session_id, seq) 存，不塞进一个 JSON blob —— 单行有大小上限，
// 一场长对话压成一个字段迟早会撑爆。

import type { UIMessage } from "ai";
import type { SqlTag } from "./state";

export type SessionVisibility = "private" | "public";

/** 会话列表里一条。msgCount 由子查询算出来，前端要拿它判断「这场有没有内容」 */
export interface SessionMeta {
  id: string;
  title: string;
  visibility: SessionVisibility;
  created: string;
  lastActive: string;
  /**
   * 置顶的时刻（ISO）；空串 = 没置顶。
   *
   * 为什么记时刻而不是记一个 0/1：置顶区要按「置顶的先后」排 ——
   * 先顶上的一直在前，后顶上的排它后面。0/1 分不出先后，就只能按别的东西排了。
   */
  pinned: string;
  msgCount: number;
  /** 这场是否已经有过上下文压缩（前端用来标一句「更早的已压缩」） */
  hasDigest: boolean;
  /**
   * 收起来了。归档不是删除：内容一条不少、翻旧账照样搜得到、想聊随时能展开，
   * 只是不再占着会话列表最上面那一段。列表长了以后，真正在聊的几场会被旧对话淹没。
   */
  archived: boolean;
  /**
   * 这个名字是人起的，还是我起过之后就定下来了。
   *
   * 为什么要单独记一笔：起标题是模型干的活，得在开场白出来之后找个时机补上。
   * 光看标题「像不像原先那句截断」判断不出该不该动手 —— 一开始那会儿
   * 会话标题还是「我们的对话」（那时还没有发言可截），等真有开场白了，
   * 它会以为「标题没被动过」而永远不动手。所以直接记个记号。
   */
  named: boolean;
  /**
   * 这一场是我自己开的，他还没看过。
   *
   * 为什么要有它：我能主动开一场会把一件事说清楚，但那场不会自己跳到他眼前 ——
   * 会话列表里多一行「新会话」，跟一次普通刷新长得一模一样，他多半不会注意到。
   * 所以留个记号：侧栏那一行先闪一下把人叫过来，然后退成一个小角标，
   * 直到他真的点进去（切过去时清掉）。闪是招呼，角标是「这里还有一件没看的事」。
   */
  unread: boolean;
  /**
   * 这场上一次「休息态回想」是什么时候（ISO）；空串 = 从没回头看过。
   * 界面上拿它说「上次回头看是几时」，也是「这场我有印象」的证据。
   */
  recapAt: string;
  /**
   * 这一场住在哪间屋。空串 = 本屋宿主的场（老式：切过去靠屋内 loadSessionMessages）；
   * 非空 = 场屋名（room--sessionId，一个会话一间完整运行时，切过去 = 前端换连接）。
   * 只有目录屋（人屋）里的行会带场屋名 —— 那是指路的，不是存储。
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
  // 回想的三样家当：
  //   recap_upto     —— 已回想覆盖到第几条消息（**条数**，不是 seq）。
  //                     用条数而不是消息 id：回想是一段一段往前推的，
  //                     条数单调、好比，也不会因为某条消息被清掉就整段错位。
  //   recap_at       —— 上一次回想是什么时候（界面上「上次回头看是几时」）。
  //   recap_schedule —— 排程句柄。留着它才能在有人又开口时把这一趟取消掉。
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
  // 列本身默认 0：从没回想过的场（包括上线前就存在的老场）一律按「还欠着回想」算。
  // 早年这里回填过一次「老会话直接视为已回想」，那是一次性的历史包袱，
  // 已由 resetLegacyRecapCursors 统一抹掉 —— 回想对所有场一视同仁，不分新老。
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
 * 抹掉「老会话豁免」：当年上线回想时，存量会话的游标被回填成了消息总条数，
 * 等于把它们一律标成「已经回想过了」，老聊天就永远回想不到。
 * 这里把那些**从没真正回想过的**（recap_at 还是空）游标清零，让它们和新建场走同一条路。
 * 条件本身幂等：清零后 recap_upto = 0，再跑一遍什么都不动。
 * 注意只认 recap_at：真回想过的场哪怕游标被推过，也不该再清 —— 那是它自己的进度。
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
 * 会话列表：按**创建时间**倒序，新开的在前、旧的往后 —— 顺序一旦定下就不再变。
 *
 * 从前按 last_active 排，谁刚说过话谁往上浮：一场聊到一半去回另一场，
 * 列表就整个换一次位，找那一场得重扫一遍。位置是要能记住的，
 * 所以「最近聊过」不再参与排序，只留在 lastActive 里供显示与回想调度用。
 * 想常常够着的几场，用置顶 —— 置顶区按置顶的先后排，见前端。
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
 * 该回想的会话：停够久了、而且停之后又添过新话。
 *
 * 「有没有新内容」的判据就是这一条 SQL —— 不靠另记账，
 * 所以「回想完又没新内容」永远不会重复触发。
 *
 * 归档的场也在列：收起来只是不摆在列表最上面，不是「这段过去不算数了」。
 * 回想对新老场、收没收起来一视同仁。
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
 * 改名：管理员手动改，或者我起标题那一步改。
 *
 * 两种都算「这场已经有名字了」，所以一并把 named 立起来 ——
 * 名字定过一次就不再动：起标题是开场那一下的事，之后话题岔开了也不该被改写，
 * 那是管理员记忆里这场对话的名字，不是最新一条消息的摘要。
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
 * 置顶 / 取消置顶。置顶区按这个时刻升序排 —— 先顶上的一直在前，
 * 所以「取消再顶」= 排到置顶区末尾，符合「最后动的那一场靠后」的直觉。
 * 置顶不是归档的反面：两者互不干涉，收起来的场照样可以置着顶（只是先收在归档里）。
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
 * 他看过了。清的是记号，不是内容 —— 那一场的消息一条不少。
 *
 * 清得「早」一点没关系，晚了才出问题：他明明读过了，角标还赖在那儿，
 * 用两次他就学会无视它了，那这个提醒就等于没有。
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
 * 键名排过序的 JSON。
 *
 * 为什么不直接 JSON.stringify：要比的是「这条消息跟库里那条是不是同一份」，
 * 而 JSON.stringify 是认键序的 —— 同一份内容、键序换一下，字符串就不一样，
 * 于是每轮都会以为「全变了」，把两百条全部重写一遍。这个优化就会悄悄失效，
 * 表面上还看不出错。所以干脆按排序后的键写进库，比对就是纯字符串相等。
 * 读回去多一层 JSON.parse，消费方都是按名字取字段，键序无关紧要。
 *
 * 老数据是按原键序存的，所以这一版之后每场会话第一次保存会整体重写一遍，
 * 之后才稳定下来 —— 一次性的，会自愈，不用专门迁移。
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
 * 保存这一场的消息 —— 只写变了的那些。
 *
 * 原来是「先清空再全量写回」：每轮删 N 行、插 N 行，N 最多 200（maxPersistedMessages），
 * 也就是每轮光为了存一份快照就写掉四百来行。可那两百条里，一轮真正动的
 * 通常只有最新的一两条 —— 之前的每一条都跟上一轮一模一样。
 *
 * 读回来逐条比对（读不占写入额度），一样的一个字都不写；会话变短时才删尾巴。
 *
 * 返回「这一趟有没有真动过」。调用方拿它当「这场有新内容」的判据：
 * 光翻列表、点开一场旧的，内容一个字没变，那就不该报成「有新内容」——
 * last_active 只该由真的说过来往记，不能因为点了一下就当成聊过
 * （它现在还管着回想调度：谁停够了、之后又添过新话）。
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
 * 往一场会话尾部追加一条消息（不覆盖）。
 * 用在「提醒到点，那句话属于当初约定它的那一场」——那一场可能不在对话流里，
 * 所以直接写库，等用户切回去就能看到。
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
 * 跨会话回忆检索：按关键词在全部会话消息里找，同时也按会话标题过滤。
 * 用 LIKE 全文扫，不走向量 —— 中文关键词（「上次那个方案」里的实词）不会误命中
 * 内嵌的 uuid / id，命中工具参数也算「她当时在做这件事」，结果够用。
 * 命中按会话活跃时间排序，返回纯文本片段给模型引用。
 */
export function searchMessages(db: SqlTag, q: string, limit = 8): RecallHit[] {
  const rows = db<{
    session_id: string;
    message: string;
    title: string;
    last_active: string;
  }>`
    select m.session_id, m.message, s.title, s.last_active
    from session_messages m
    join sessions s on s.id = m.session_id
    where m.message like ${"%" + q + "%"} or s.title like ${"%" + q + "%"}
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
//
// 场屋的消息存在场屋自己那里，目录屋翻不到。这里给目录屋一张专供搜索的索引表：
// 场屋轮尾把新落的消息（谁说的、说了什么）寄回一行 —— 消息本体不动，
// 这边只是「可搜索的目录页」。行很小（正文截 500 字），只喂 recall 用。

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
 * 收场屋寄回的原话索引。INSERT OR IGNORE 按消息 id 幂等 ——
 * 场屋重启后全量重寄一遍也不会写重，目录页多翻几遍还是同一本。
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
 * 搜场屋寄回的原话索引。join sessions 拿标题与活跃时刻 ——
 * 场屋的目录行（落位登记过的）就在这边表里，join 得上；还没登记的行搜不到，可接受。
 */
export function searchRecallIndex(
  db: SqlTag,
  q: string,
  limit = 8,
): RecallHit[] {
  ensureRecallIndex(db);
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
    where i.text like ${"%" + q + "%"} or s.title like ${"%" + q + "%"}
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
