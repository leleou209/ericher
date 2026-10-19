/**
 * 信箱的两本账：发件流水（mail_out）与收件（mail_in）。
 *
 * 为什么不塞进 store.ts：那张表是「这台机器的发信通道长什么样」，一格一格有闸；
 * 这两张是**流水**，只追加、只裁剪，读法也完全不同（面板上是列表+详情，
 * 工具里是「最近几封」）。混在一张文件里，两边规矩都会糊。
 *
 * 三条一起立的规矩：
 *   1. 发出去的每一封都要落一行，**失败也落** —— 只记成功的那本账等于没账，
 *      管理员看不见「她试过了但被服务器拒了」这件事；
 *   2. 裁剪时要能把挂在 R2 上的原件一起删掉（见 onEvict）：只裁行不删件，
 *      字节就会永远长在那儿，而没人看得见 —— 那是静默的存储泄漏；
 *   3. 收进来的每一封按内容去重：Cloudflare 会重投，面板上的「喂一封」也是
 *      同一封报文可能按两次，重复行会让他以为真来了两封信。
 */

import type { SqlTag } from "../agent/state";
import type { MailInRow, MailOutRow, MailSource } from "./mailboxTypes";

/** 发件流水留几行：够看完「这个周末她替我寄了什么」，又不至于把面板拖成一本账簿 */
export const MAIL_OUT_KEEP = 200;
/** 收件行数上限（正文在 R2，这里只是行）：到数就丢最旧的那一封，连同它的原件 */
export const MAIL_IN_KEEP = 500;
/** 随列表回的那段摘要有多长 */
export const MAIL_PREVIEW_MAX = 300;
/** 原件超过这个字节数就不往 R2 落了，只在行里留大小 —— 收件箱不是网盘 */
export const EML_MAX_BYTES = 2 * 1024 * 1024;
/**
 * 肯收下来的整封上限。Cloudflare 那边给到 25 MiB，那是它的管道上限，不是我们的义务：
 * 解析一封 20 MiB 的信要把它的 CPU 时间花光，而这一入口是公网任何人都能敲的。
 */
export const INGEST_MAX_BYTES = 4 * 1024 * 1024;
/** /api/mail/inbox/feed 的「喂一封」体积闸，按字符数算（DO 那边还有一道按字节的） */
export const EML_FEED_MAX = 4 * 1024 * 1024;

const SOURCES: readonly string[] = ["panel", "tool", "say"];

/** 认不出的来源一律按 `tool` 记：账本上的这一格不能因为哪天改了名字就变成空 */
function toSource(v: unknown): MailSource {
  const s = typeof v === "string" ? v : "";
  return (SOURCES.includes(s) ? s : "tool") as MailSource;
}

function toBit(v: boolean): number {
  return v ? 1 : 0;
}

function fromBit(v: unknown): boolean {
  return v === 1 || v === true;
}

function asStr(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function toInt(v: unknown, fallback: number): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

/** 一行里最多记几个附件名：外站可以塞一百个，那不该把这一格撑爆 */
export const MAX_ATTACH_ITEMS = 12;
const ATTACH_NAME_MAX = 200;

/**
 * 附件清单存成一格 JSON 文本（只存名字与大小，内容一概不落这里 —— 原件在 R2，
 * 而这一格是给人一眼看清"这封带了什么"用的）。
 * 认不出的条目丢掉，不让一个坏条目把整封信的清单作废。
 */
export function serializeAttachments(
  list: { name: string; bytes: number }[],
): string {
  const clean = (list ?? [])
    .map((a) => ({
      n: asStr(a?.name).trim().slice(0, ATTACH_NAME_MAX),
      b: Math.max(0, toInt(a?.bytes, 0)),
    }))
    .filter((a) => a.n)
    .slice(0, MAX_ATTACH_ITEMS);
  return JSON.stringify(clean);
}

/** 读回来：脏文本、半截 JSON、不是数组的，一律当"没有清单"，不抛 */
export function parseAttachments(
  text: string,
): { name: string; bytes: number }[] {
  const t = asStr(text).trim();
  if (!t) return [];
  let v: unknown;
  try {
    v = JSON.parse(t);
  } catch {
    return [];
  }
  if (!Array.isArray(v)) return [];
  return v
    .map((x) => ({
      name: asStr((x as Record<string, unknown>)?.n),
      bytes: toInt((x as Record<string, unknown>)?.b, 0),
    }))
    .filter((x) => x.name);
}

export function ensureMailboxSchema(sql: SqlTag): void {
  sql`CREATE TABLE IF NOT EXISTS mail_out (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        at        TEXT    NOT NULL,
        to_addrs  TEXT    NOT NULL DEFAULT '',
        subject   TEXT    NOT NULL DEFAULT '',
        ok        INTEGER NOT NULL DEFAULT 0,
        error     TEXT    NOT NULL DEFAULT '',
        source    TEXT    NOT NULL DEFAULT 'tool'
      )`;
  sql`CREATE TABLE IF NOT EXISTS mail_in (
        id          TEXT    PRIMARY KEY,
        hash        TEXT    NOT NULL DEFAULT '',
        at          TEXT    NOT NULL,
        from_addr   TEXT    NOT NULL DEFAULT '',
        from_name   TEXT    NOT NULL DEFAULT '',
        to_addr     TEXT    NOT NULL DEFAULT '',
        subject     TEXT    NOT NULL DEFAULT '',
        bytes       INTEGER NOT NULL DEFAULT 0,
        read_flag   INTEGER NOT NULL DEFAULT 0,
        has_attach  INTEGER NOT NULL DEFAULT 0,
        attach      TEXT    NOT NULL DEFAULT '',
        preview     TEXT    NOT NULL DEFAULT '',
        eml_key     TEXT    NOT NULL DEFAULT ''
      )`;
  // 附件那一列是后加的：本地库里可能已经有今天早些时候建的 mail_in。
  // 补列必须带 DEFAULT，否则老行读出来是 NULL，界面得替它猜"是没附件还是没这一列"
  try {
    sql`ALTER TABLE mail_in ADD COLUMN attach TEXT NOT NULL DEFAULT ''`;
  } catch {
    /* 已有该列 */
  }
  // AUTOINCREMENT 在 DO 的 SQLite 上是可选项，老库缺索引也一样能长：
  // 这两条只是把「按时间倒序取最近若干行」变成索引扫，失败就当没建
  try {
    sql`CREATE INDEX IF NOT EXISTS mail_in_at ON mail_in (at)`;
  } catch {
    /* 已建或不支持 */
  }
}

interface MailOutDbRow {
  at: string;
  to_addrs: string;
  subject: string;
  ok: number | boolean;
  error: string;
  source: string;
}

/** 收件人存的是逗号连接的文本；读回来还是数组（写的时候已经去过重） */
function splitAddrs(s: string): string[] {
  return s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

/**
 * 记一笔发件流水（成功失败都记），顺手把超出保留数的旧行剪掉。
 *
 * 剪的时候把被剪那几行的 eml 交出去？不 —— mail_out 不挂原件，
 * 只有 mail_in 才在 R2 上有东西，所以 onEvict 只长在收件那侧。
 */
export function recordMailOut(
  sql: SqlTag,
  e: {
    at: string;
    to: string[];
    subject: string;
    ok: boolean;
    error: string;
    source: MailSource;
  },
): void {
  ensureMailboxSchema(sql);
  sql`INSERT INTO mail_out (at, to_addrs, subject, ok, error, source)
      VALUES (${e.at}, ${e.to.join(",")}, ${e.subject.slice(0, 500)},
              ${toBit(e.ok)}, ${e.error.slice(0, 500)}, ${toSource(e.source)})`;
  // 保留数按「最新 N 行」算，不按 id 区间：删过之后 id 会断号，按区间会一刀切多
  sql`DELETE FROM mail_out WHERE id NOT IN (
        SELECT id FROM mail_out ORDER BY id DESC LIMIT ${MAIL_OUT_KEEP})`;
}

export function listMailOut(sql: SqlTag, limit = MAIL_OUT_KEEP): MailOutRow[] {
  ensureMailboxSchema(sql);
  const rows = sql<MailOutDbRow>`
    SELECT at, to_addrs, subject, ok, error, source
    FROM mail_out ORDER BY id DESC LIMIT ${Math.max(1, toInt(limit, 50))}`;
  return rows.map((r) => ({
    at: asStr(r.at),
    to: splitAddrs(asStr(r.to_addrs)),
    subject: asStr(r.subject),
    ok: fromBit(r.ok),
    error: asStr(r.error),
    source: toSource(r.source) as MailSource,
  }));
}

interface MailInDbRow {
  id: string;
  at: string;
  from_addr: string;
  from_name: string;
  to_addr: string;
  subject: string;
  bytes: number | null;
  read_flag: number | boolean;
  has_attach: number | boolean;
  attach: string;
  preview: string;
  eml_key: string;
}

function rowToIn(r: MailInDbRow): MailInRow {
  return {
    id: asStr(r.id),
    at: asStr(r.at),
    from: asStr(r.from_addr),
    fromName: asStr(r.from_name),
    to: asStr(r.to_addr),
    subject: asStr(r.subject),
    bytes: toInt(r.bytes, 0),
    read: fromBit(r.read_flag),
    hasAttachment: fromBit(r.has_attach),
    attachments: parseAttachments(r.attach),
    preview: asStr(r.preview),
    emlKey: asStr(r.eml_key),
  };
}

/**
 * 收一封进来。`onEvict` 拿到的是**被挤出保留数的那些行**的 R2 键（已裁掉的原件），
 * 调用方负责真去删 —— 只有它手上有桶。
 *
 * 返回 null = 这一封库里已经有了（同一份报文重投/重喂），不新增行。
 */
export function insertMailIn(
  sql: SqlTag,
  row: MailInRow,
  hash: string,
  onEvict: (emlKey: string) => void = () => {},
): MailInRow | null {
  ensureMailboxSchema(sql);
  const h = hash.slice(0, 64);
  if (h) {
    const dup = sql<{ id: string }>`SELECT id FROM mail_in WHERE hash = ${h}`;
    if (dup.length) return null;
  }
  sql`INSERT INTO mail_in (id, hash, at, from_addr, from_name, to_addr, subject,
        bytes, read_flag, has_attach, attach, preview, eml_key)
      VALUES (${row.id}, ${h}, ${row.at}, ${row.from.slice(0, 254)},
              ${row.fromName.slice(0, 120)}, ${row.to.slice(0, 254)},
              ${row.subject.slice(0, 500)}, ${Math.max(0, row.bytes)},
              ${toBit(row.read)}, ${toBit(row.hasAttachment)},
              ${serializeAttachments(row.attachments ?? [])},
              ${row.preview.slice(0, MAIL_PREVIEW_MAX)}, ${row.emlKey.slice(0, 200)})`;
  // 超保留数的旧行连同它们的原件一起走 —— 只删行不删件就是静默攒字节
  const evicted = sql<{ eml_key: string }>`
    SELECT eml_key FROM mail_in WHERE id NOT IN (
      SELECT id FROM mail_in ORDER BY at DESC LIMIT ${MAIL_IN_KEEP})`;
  for (const e of evicted) {
    const key = asStr(e.eml_key);
    if (key) onEvict(key);
  }
  sql`DELETE FROM mail_in WHERE id NOT IN (
        SELECT id FROM mail_in ORDER BY at DESC LIMIT ${MAIL_IN_KEEP})`;
  return row;
}

export function listMailIn(sql: SqlTag, limit = 50): MailInRow[] {
  ensureMailboxSchema(sql);
  const rows = sql<MailInDbRow>`
    SELECT id, at, from_addr, from_name, to_addr, subject, bytes,
           read_flag, has_attach, attach, preview, eml_key
    FROM mail_in ORDER BY at DESC
    LIMIT ${Math.max(1, toInt(limit, 20))}`;
  return rows.map(rowToIn);
}

export function mailInUnread(sql: SqlTag): number {
  ensureMailboxSchema(sql);
  const rows = sql<{ n: number | null }>`SELECT COUNT(*) AS n FROM mail_in WHERE read_flag = 0`;
  return toInt(rows[0]?.n, 0);
}

/** 单封：认 id，也认「第 n 封（按时间倒序）」里的那个 id；读不到就是 null */
export function findMailIn(sql: SqlTag, id: string): MailInRow | null {
  ensureMailboxSchema(sql);
  const rows = sql<MailInDbRow>`
    SELECT id, at, from_addr, from_name, to_addr, subject, bytes,
           read_flag, has_attach, attach, preview, eml_key
    FROM mail_in WHERE id = ${id}`;
  return rows[0] ? rowToIn(rows[0]) : null;
}

/** 标已读/未读。返回改完那一行的样子；行不在就 null（调用方按「没这条」报） */
export function setMailInRead(
  sql: SqlTag,
  id: string,
  read: boolean,
): MailInRow | null {
  ensureMailboxSchema(sql);
  sql`UPDATE mail_in SET read_flag = ${toBit(read)} WHERE id = ${id}`;
  return findMailIn(sql, id);
}

/** 正文所在的键：按天分目录，一天翻旧信时能一眼看出是哪天的 */
export function emlKeyFor(at: string, id: string): string {
  const day = /^\d{4}-\d{2}-\d{2}/.test(at) ? at.slice(0, 10) : "unknown";
  return `mail/in/${day}/${id}.eml`;
}

/** 只用到 R2 桶的这点形状：抽出来才能拿一个 Map 假件把这条路测穿 */
export interface EmlStore {
  put(key: string, data: Uint8Array): Promise<unknown>;
  get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>;
  delete(key: string): Promise<unknown>;
}

/**
 * 原件落 R2。返回真正该写进行里的那个键：
 * 太大（>EML_MAX_BYTES）或这台机器没配桶时返回空串 —— 行照记，只留摘要，
 * 界面上会显示「只有摘要」，不能假装点得开全文。
 */
export async function putEml(
  bucket: EmlStore | null | undefined,
  at: string,
  id: string,
  raw: Uint8Array,
): Promise<string> {
  if (!bucket || raw.byteLength > EML_MAX_BYTES) return "";
  const key = emlKeyFor(at, id);
  await bucket.put(key, raw);
  return key;
}

/** 读原件：没有键、没有桶、对象已丢，都回 null（调用方回退到 preview 并说明白） */
export async function getEml(
  bucket: EmlStore | null | undefined,
  key: string,
): Promise<Uint8Array | null> {
  if (!bucket || !key) return null;
  const obj = await bucket.get(key);
  if (!obj) return null;
  return new Uint8Array(await obj.arrayBuffer());
}

/** 把 sha-256 的 ArrayBuffer 写成十六进制；同一份报文必须算出同一个串 */
export function toHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
