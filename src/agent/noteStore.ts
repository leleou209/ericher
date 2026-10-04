// 笔记本：管理员和我一起写的本子。
//
// 它和记忆的分工，是这个功能立得住的前提：
//   memory —— 我记住的东西（我的认知，措辞是我定的，他读到的是我的转述）
//   note   —— 他要留下的东西（他的原话，一篇一篇，Markdown 保结构）
// 少的那一格正是 note：以前他想让一件事「留着」，只能塞进记忆里，而记忆是我消化过的东西 ——
// 他要的是原稿，不是我的笔记。
//
// 为什么是「多篇 + 标签」而不是一整篇长文：他打开哪一篇，我这一轮就该知道 ——
// 单篇长文里「我在看哪一段」是说不清的，而「我在看这一篇」是能成立的。
// 见 noteFocusBlock：他翻着的那一篇会被顶到提示词里，省掉他那句「我说的是哪篇」。

import type { SqlTag } from "./state";
import { ageLabel } from "./memory";

/** 谁写的。user = 管理员，assistant = ericher。两人共用一个本子，但笔迹要分得开 */
type Author = "user" | "assistant";

export interface Note {
  id: string;
  title: string;
  /** Markdown 原文。不在这里做任何解析 —— 存原样，渲染是前端的事 */
  body: string;
  tags: string[];
  /** 这篇是谁建的 */
  author: Author;
  /** 最后动它的是谁 */
  updatedBy: Author;
  pinned: boolean;
  created: string;
  updated: string;
}

/** 列表用的轻量视图：不带正文，只带一小段开头，免得把整本子的字都拉进内存 */
export interface NoteMeta {
  id: string;
  title: string;
  tags: string[];
  author: Author;
  updatedBy: Author;
  pinned: boolean;
  created: string;
  updated: string;
  /** 正文开头一小段（去换行），列表里当摘要看 */
  preview: string;
}

export interface NoteRevision {
  noteId: string;
  seq: number;
  title: string;
  body: string;
  savedAt: string;
  by: Author;
}

export interface NoteInput {
  /** 空 = 新建一篇；非空 = 改这一篇（找不到就抛错，不悄悄新建） */
  id?: string;
  title?: string;
  body?: string;
  tags?: string[];
  pinned?: boolean;
  /** 这次是谁在动笔。路由来的算管理员，我调工具来的算我 */
  by: Author;
}

/** 本子上限。一本塞满几百篇之后，真正在写的那几篇他就找不到了 */
export const NOTE_CAP = 300;
/** 单篇正文上限：一行存不下无限长的字，而且每轮注入也要读它 */
export const NOTE_BODY_MAX = 40000;
/** 每篇只留最近这些个版本。回溯是拿来救一次误改的，不是拿来当版本管理用的 */
export const NOTE_REV_KEEP = 10;
/** 列表里的摘要取多长 */
export const NOTE_PREVIEW = 80;
/** 注入提示词的正文最多带这么多字 —— 他「正在看」这件事要说清，但不该把长文整篇顶进每一轮 */
export const NOTE_FOCUS_CHARS = 400;

interface Row {
  id: string;
  title: string;
  body: string;
  tags: string;
  author: string;
  updated_by: string;
  pinned: number;
  created: string;
  updated: string;
}

/** 标签沿用 memories 的约定：逗号分隔存在一个字段里，不做第二张表 */
function parseTags(s: string): string[] {
  return s ? s.split(",").filter(Boolean) : [];
}

function joinTags(a: string[]): string {
  return [...new Set(a.map((t) => t.trim()).filter(Boolean))].join(",");
}

function who(v: string): Author {
  // 旧库中非 user 的作者标记也表示助手；读时归一，不改写存量笔记。
  return v === "user" ? "user" : "assistant";
}

function toNote(r: Row): Note {
  return {
    id: r.id,
    title: r.title,
    body: r.body,
    tags: parseTags(r.tags),
    author: who(r.author),
    updatedBy: who(r.updated_by),
    pinned: !!r.pinned,
    created: r.created,
    updated: r.updated,
  };
}

function toMeta(r: Row): NoteMeta {
  const n = toNote(r);
  return {
    id: n.id,
    title: n.title,
    tags: n.tags,
    author: n.author,
    updatedBy: n.updatedBy,
    pinned: n.pinned,
    created: n.created,
    updated: n.updated,
    preview: n.body.replace(/\s+/g, " ").trim().slice(0, NOTE_PREVIEW),
  };
}

export function ensureNoteSchema(sql: SqlTag): void {
  sql`CREATE TABLE IF NOT EXISTS notes (
       id         TEXT PRIMARY KEY,
       title      TEXT NOT NULL DEFAULT '',
       body       TEXT NOT NULL DEFAULT '',
       tags       TEXT NOT NULL DEFAULT '',
       author     TEXT NOT NULL DEFAULT 'user',
       updated_by TEXT NOT NULL DEFAULT 'user',
       pinned     INTEGER NOT NULL DEFAULT 0,
       created    TEXT NOT NULL,
       updated    TEXT NOT NULL
     )`;
  sql`CREATE INDEX IF NOT EXISTS idx_notes_order ON notes(pinned DESC, updated DESC)`;
  // 覆盖式改写的后悔药：正文真变了才压一份改前的样子进来（见 saveNote）
  sql`CREATE TABLE IF NOT EXISTS note_revisions (
       note_id  TEXT NOT NULL,
       seq      INTEGER NOT NULL,
       title    TEXT NOT NULL DEFAULT '',
       body     TEXT NOT NULL DEFAULT '',
       saved_at TEXT NOT NULL,
       by       TEXT NOT NULL DEFAULT 'user',
       PRIMARY KEY (note_id, seq)
     )`;
}

/** 短 id：工具回话里要把它印出来给我自己看，uuid 那种长度既占地方又没法认 */
export function newNoteId(): string {
  return "n" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

/**
 * 标题留空时从正文第一行取一句。
 * 因为「没名字的一篇」在列表里就是一坨，他下次根本认不出哪篇是哪篇；
 * 而他写正文时第一行多半就是标题，取它比我编一个准。
 */
export function deriveTitle(body: string): string {
  const first = body
    .split("\n")
    .map((l) => l.replace(/^#+\s*/, "").trim())
    .find(Boolean);
  return first ? first.slice(0, 40) : "未命名";
}

function countNotes(sql: SqlTag): number {
  const rows = sql<{ n: number }>`SELECT COUNT(*) AS n FROM notes`;
  return rows[0]?.n ?? 0;
}

export function getNote(sql: SqlTag, id: string): Note | null {
  const rows = sql<Row>`SELECT id, title, body, tags, author, updated_by, pinned, created, updated
       FROM notes WHERE id = ${id}`;
  return rows.length ? toNote(rows[0]) : null;
}

/**
 * 列表。q 命中标题或正文，tag 精确命中标签。
 * 排序固定是「钉住的在前、然后按最近动过」—— 因为本子的第一屏该是他手上那几篇，
 * 而不是按创建时间排的考古层。
 */
export function listNotes(
  sql: SqlTag,
  opts: { q?: string; tag?: string; limit?: number } = {},
): NoteMeta[] {
  const limit = opts.limit ?? NOTE_CAP;
  const q = (opts.q || "").trim();
  const tag = (opts.tag || "").trim();
  // 四种条件各写一条固定 SQL，不在运行时拼语句。
  // 因为 sql 模板标签里的插值一律是「绑定参数」，只能出现在值的位置上：
  // 把 where 或者 ORDER BY 拼进去，拼出来的会变成一个参数占位符 —— 轻则语法错误，重则静默匹配错行。
  // 条件就这么四种，写死反而看得清。
  // LIKE 的 % 加在值上；标签则「前后补逗号再匹配」—— 免得到「写作」把「写作练习」也算命中。
  if (q && tag) {
    const like = `%${q}%`;
    const t = `%,${tag},%`;
    return sql<Row>`SELECT id, title, body, tags, author, updated_by, pinned, created, updated FROM notes
      WHERE (title LIKE ${like} OR body LIKE ${like}) AND (',' || tags || ',') LIKE ${t}
      ORDER BY pinned DESC, updated DESC LIMIT ${limit}`.map(toMeta);
  }
  if (q) {
    const like = `%${q}%`;
    return sql<Row>`SELECT id, title, body, tags, author, updated_by, pinned, created, updated FROM notes
      WHERE (title LIKE ${like} OR body LIKE ${like})
      ORDER BY pinned DESC, updated DESC LIMIT ${limit}`.map(toMeta);
  }
  if (tag) {
    const t = `%,${tag},%`;
    return sql<Row>`SELECT id, title, body, tags, author, updated_by, pinned, created, updated FROM notes
      WHERE (',' || tags || ',') LIKE ${t}
      ORDER BY pinned DESC, updated DESC LIMIT ${limit}`.map(toMeta);
  }
  return sql<Row>`SELECT id, title, body, tags, author, updated_by, pinned, created, updated FROM notes
    ORDER BY pinned DESC, updated DESC LIMIT ${limit}`.map(toMeta);
}

function lastSeq(sql: SqlTag, noteId: string): number {
  const rows = sql<{
    s: number | null;
  }>`SELECT MAX(seq) AS s FROM note_revisions WHERE note_id = ${noteId}`;
  return rows[0]?.s ?? 0;
}

function pushRevision(sql: SqlTag, old: Note, by: Author, at: string): void {
  const seq = lastSeq(sql, old.id) + 1;
  sql`INSERT INTO note_revisions (note_id, seq, title, body, saved_at, by)
     VALUES (${old.id}, ${seq}, ${old.title}, ${old.body}, ${at}, ${by})`;
  // 裁掉太老的：回溯是拿来救一次误改的，攒到几十个版本只会让面板变成考古现场
  const cut = seq - NOTE_REV_KEEP;
  if (cut > 0)
    sql`DELETE FROM note_revisions WHERE note_id = ${old.id} AND seq <= ${cut}`;
}

/**
 * 落库。新建与改写走同一条路。
 *
 * 为什么改写前一定要压一份旧版：管理员点头让我自由改写正文，也就是说我手一滑就能抹掉他写的字。
 * 覆盖没有后悔药，而「我以为是这么写的」这种账，事后是查不清的 —— 所以版本留着，他一句「退回去」就够了。
 * 只有正文或标题真的变了才压，避免「只是钉了一下」也留下一个一模一样的版本。
 */
export function saveNote(sql: SqlTag, input: NoteInput): Note {
  const now = new Date().toISOString();
  const id = (input.id || "").trim();

  if (!id) {
    if (countNotes(sql) >= NOTE_CAP)
      throw new Error(`本子上限 ${NOTE_CAP} 篇，先删掉几篇再新建`);
    const body = (input.body ?? "").slice(0, NOTE_BODY_MAX);
    const note: Note = {
      id: newNoteId(),
      title: (input.title || "").trim().slice(0, 120) || deriveTitle(body),
      body,
      tags: input.tags ? parseTags(joinTags(input.tags)) : [],
      author: input.by,
      updatedBy: input.by,
      pinned: !!input.pinned,
      created: now,
      updated: now,
    };
    sql`INSERT INTO notes (id, title, body, tags, author, updated_by, pinned, created, updated)
       VALUES (${note.id}, ${note.title}, ${note.body}, ${joinTags(note.tags)}, ${note.author},
               ${note.updatedBy}, ${note.pinned ? 1 : 0}, ${note.created}, ${note.updated})`;
    return note;
  }

  const old = getNote(sql, id);
  if (!old) throw new Error(`没有 id 为 ${id} 的那一篇，先用 list 看一眼`);

  const body = (input.body ?? old.body).slice(0, NOTE_BODY_MAX);
  const title =
    input.title !== undefined
      ? input.title.trim().slice(0, 120) || deriveTitle(body)
      : old.title;
  if (body !== old.body || title !== old.title)
    pushRevision(sql, old, input.by, now);

  const next: Note = {
    ...old,
    title,
    body,
    tags: input.tags ? parseTags(joinTags(input.tags)) : old.tags,
    pinned: input.pinned === undefined ? old.pinned : !!input.pinned,
    updatedBy: input.by,
    updated: now,
  };
  sql`UPDATE notes SET title = ${next.title}, body = ${next.body}, tags = ${joinTags(next.tags)},
       updated_by = ${next.updatedBy}, pinned = ${next.pinned ? 1 : 0}, updated = ${next.updated}
       WHERE id = ${id}`;
  return next;
}

/** 删掉一篇，连同它的历史版本 —— 留着一个孤儿版本，下次同 id 撞上就是脏数据 */
export function deleteNote(sql: SqlTag, id: string): boolean {
  const old = getNote(sql, id);
  if (!old) return false;
  sql`DELETE FROM note_revisions WHERE note_id = ${id}`;
  sql`DELETE FROM notes WHERE id = ${id}`;
  return true;
}

export function listRevisions(
  sql: SqlTag,
  noteId: string,
  limit = NOTE_REV_KEEP,
): NoteRevision[] {
  const rows = sql<{
    note_id: string;
    seq: number;
    title: string;
    body: string;
    saved_at: string;
    by: string;
  }>`
    SELECT note_id, seq, title, body, saved_at, by FROM note_revisions
    WHERE note_id = ${noteId} ORDER BY seq DESC LIMIT ${limit}`;
  return rows.map((r) => ({
    noteId: r.note_id,
    seq: r.seq,
    title: r.title,
    body: r.body,
    savedAt: r.saved_at,
    by: who(r.by),
  }));
}

/**
 * 退回某一版。
 * 关键是「退回」本身也走 saveNote —— 所以退错了还能再退回来，
 * 而他按的那一下不会变成又一次不可逆的覆盖。
 */
export function restoreRevision(
  sql: SqlTag,
  id: string,
  seq: number,
  by: Author,
): Note | null {
  const rows = sql<{ title: string; body: string }>`
    SELECT title, body FROM note_revisions WHERE note_id = ${id} AND seq = ${seq}`;
  if (!rows.length) return null;
  return saveNote(sql, { id, title: rows[0].title, body: rows[0].body, by });
}

/** 工具与面板共用同一句措辞，免得两边各写一份慢慢走偏 */
export function describeNote(
  n: Pick<NoteMeta, "id" | "title" | "tags" | "updated" | "updatedBy">,
  now = Date.now(),
): string {
  const tags = n.tags.length ? `｜标签：${n.tags.join("、")}` : "";
  const by = n.updatedBy === "assistant" ? "我改的" : "他改的";
  return `${n.id}｜《${n.title}》${tags}（${ageLabel(n.updated, now)}${by}）`;
}

/**
 * 注入系统提示词的那一段：他此刻翻着的那一篇。
 *
 * 为什么只带开头几百字：他要的是「我知道你在说哪篇」，不是「我把这篇抄进脑子」。
 * 全文顶进来，长笔记每一轮都在烧 token，而真正要用全文的时候我本来就会 read。
 * 只在那一篇还真的存在时出现 —— 他删了它、提示词里却还留着，我下一句就会去说一篇不存在的东西。
 */
export function noteFocusBlock(
  sql: SqlTag,
  focusId: string,
  now = Date.now(),
): string {
  const id = (focusId || "").trim();
  if (!id) return "";
  const n = getNote(sql, id);
  if (!n) return "";
  const body = n.body.trim();
  const head = body.slice(0, NOTE_FOCUS_CHARS);
  const cut =
    body.length > NOTE_FOCUS_CHARS
      ? "\n…（后面还有，要看全用 note 的 read）"
      : "";
  return (
    "\n\n## 用户正在看的笔记（他此刻翻着的那一篇）\n" +
    `《${n.title}》${n.tags.length ? `｜标签：${n.tags.join("、")}` : ""}｜${ageLabel(n.updated, now)}${n.updatedBy === "assistant" ? "我改的" : "他改的"}\n` +
    (head ? head + cut + "\n" : "（这篇还空着）\n") +
    "他嘴里的「这里」「这段」「这篇」指的多半就是它；要细看或要改，我用 note 的 read 拿全文再动笔。"
  );
}
