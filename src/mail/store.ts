// mail_config：邮件通道的配置（单行表，id 恒为 'main'）。
//
// src/mail/smtp.ts 那台内核只管「连上加密服务器、把一封发出去」，它不知道这台机器
// 该用哪个服务器、哪把钥匙、每天最多寄几封 —— 那些是这台机器的属性，归这张表。
// 红线同 model/tts/search 几套配置目录：表里只存 secret 的**变量名**（keySecret），
// 口令本体既不入库、也不回显。
//
// 默认值一律 fail-closed：enabled=0、dailyCap 给个保守数。
// 新部署没配好之前一封都寄不出去，比「按某个来历不明的配置悄悄往外灌邮件」好收拾得多。
//
// 每日额度的账（sent_day / sent_count）和 lastSend 也挂在这张表上：
// 测试发送和（下一轮的）主动消息邮件副本走的是同一个 reserveMailSlot，
// 两条路各记各的账，就会有一封谁都没记、上限形同虚设。

import type { SqlTag } from "../agent/state";
import { HttpError } from "../shared/httpInput";
import { assertSafeAddress } from "./smtp";

/** lastSend 的形状：面板上那行「上一次是几点、成没成、说到哪儿去了」 */
export interface MailLastSend {
  at: string;
  ok: boolean;
  error: string;
  to: string;
}

/** 面板读的可写字段（口令不在其中，永远不在） */
export interface MailConfigStored {
  enabled: boolean;
  hostname: string;
  port: number;
  secure: boolean;
  username: string;
  /** Worker secret 的变量名，不是口令本身 */
  keySecret: string;
  from: string;
  /** 默认收件地址表：一行一个（也认逗号/分号），读出来用 toList 那个数组 */
  to: string;
  dailyCap: number;
  /** 提醒/盯梢的离线邮件副本：人不在界面前才寄，默认关 */
  sayMail: boolean;
  /** 收信落库：没接上 Cloudflare 的 MX 之前就该关着，默认关 */
  inboxEnabled: boolean;
}

/** 面板读的完整视图：可写字段 + 后端算出来的几件只读东西 */
export interface MailConfigView extends MailConfigStored {
  /** keySecret 指的那个变量在这台机器上到底配没配（只看存不存在，不看值） */
  keyAvailable: boolean;
  lastSend: MailLastSend | null;
  /** `to` 那格的数组形态：界面只管地址表，不碰分隔符 */
  toList: string[];
}

/** 保存时接受的字段：全部可选，没给的不动 */
export type MailConfigPatch = Partial<MailConfigStored>;

/**
 * 出厂默认。
 *
 * enabled 关、额度 20：一台没配过邮件的机器就该是这样 —— 想发的人得自己动手开。
 * port/secure 给的是 465 隐式 TLS：那是各家服务商里唯一不需要 STARTTLS 协商
 * 也能保证加密的一档，新手照着填不容易错。
 */
export const DEFAULT_MAIL_CONFIG: MailConfigStored = {
  enabled: false,
  hostname: "",
  port: 465,
  secure: true,
  username: "",
  keySecret: "",
  from: "",
  to: "",
  dailyCap: 20,
  sayMail: false,
  inboxEnabled: false,
};

/** 每日上限的天花板：面板上填一百万不等于能发一百万，只是把闸形同虚设 */
export const MAX_DAILY_CAP = 1000;

/** 默认收件地址表的条数上限：一封信抄送二十个人已经够像一个公告了 */
export const MAX_MAIL_RECIPIENTS = 20;

const HOST_MAX = 253;
const USER_MAX = 200;
const SECRET_NAME_MAX = 80;
const ADDR_MAX = 254;
/** 地址表整格的长度上限（20 条各 254 会超出一格该有的体积，实际远用不到） */
const TO_TEXT_MAX = 4000;

/** 与 smtp.ts 同一把尺：主机名只认字母数字和 . - ，其余一律别存 */
const HOSTNAME_RE = /^[A-Za-z0-9.-]+$/;
/** 变量名认不出就会「配了却读不到」，所以只认合法标识符 */
const SECRET_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

interface MailRow {
  enabled: number | boolean;
  hostname: string;
  port: number | null;
  secure: number | boolean;
  username: string;
  key_secret: string;
  from_addr: string;
  to_addr: string;
  daily_cap: number | null;
  sent_day: string | null;
  sent_count: number | null;
  last_send: string | null;
  say_mail: number | boolean;
  inbox_enabled: number | boolean;
}

/** SQLite 存 1/0，假库可能直接给 true/false：认不出的算关（fail-closed） */
function toBool(v: unknown): boolean {
  return v === 1 || v === true;
}

function toBit(v: boolean): number {
  return v ? 1 : 0;
}

/** 读不出的整数一律落回默认值，不能让它带着 NaN 去和上限比大小（NaN 比较恒 false） */
function toInt(v: unknown, fallback: number): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function asStr(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/**
 * 地址表文本 → 地址数组。
 *
 * 换行、逗号、分号都算分隔（人在面板上敲哪一种都该得到同一张表）；去空、
 * 按小写去重但保留原写法（本地部分区分大小写，不该被我们改成另一个人）。
 * 这里**不判形状** —— 形状是 assertAddressList 的事，拆成两步是因为
 * 视图要能如实显示半填的表，而保存必须拦下坏值。
 */
export function parseAddressList(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of (text || "").split(/[\n,;]+/)) {
    const a = raw.trim();
    if (!a) continue;
    const k = a.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(a);
  }
  return out;
}

/** 整格文本的核形：逐条过 smtp.ts 那把尺，任一条不对就点名是第几条 */
export function assertAddressList(text: string, what = "收件地址"): void {
  const list = parseAddressList(text);
  if (list.length > MAX_MAIL_RECIPIENTS)
    throw new Error(`${what}超过 ${MAX_MAIL_RECIPIENTS} 条（现在是 ${list.length} 条）`);
  list.forEach((email, i) => {
    try {
      assertSafeAddress({ email }, what);
    } catch (e) {
      throw new Error(`${what}第 ${i + 1} 条：${(e as Error).message}`);
    }
  });
}

export function ensureMailConfigSchema(sql: SqlTag): void {
  sql`CREATE TABLE IF NOT EXISTS mail_config (
       id          TEXT PRIMARY KEY,
       enabled     INTEGER NOT NULL DEFAULT 0,
       hostname    TEXT NOT NULL DEFAULT '',
       port        INTEGER NOT NULL DEFAULT 465,
       secure      INTEGER NOT NULL DEFAULT 1,
       username    TEXT NOT NULL DEFAULT '',
       key_secret  TEXT NOT NULL DEFAULT '',
       from_addr   TEXT NOT NULL DEFAULT '',
       to_addr     TEXT NOT NULL DEFAULT '',
       daily_cap   INTEGER NOT NULL DEFAULT 20,
       sent_day    TEXT NOT NULL DEFAULT '',
       sent_count  INTEGER NOT NULL DEFAULT 0,
       last_send   TEXT NOT NULL DEFAULT '',
       say_mail    INTEGER NOT NULL DEFAULT 0,
       inbox_enabled INTEGER NOT NULL DEFAULT 0
     )`;
  // 记账与 lastSend 三列是「先有配置、后加额度」那类演进最可能落成的地方，
  // 老库里可能没有：ADD COLUMN 撞上已有的列会抛，报错就当已经有了。
  // 补列必须带 DEFAULT —— 不写默认值 SQLite 会给老行填 NULL，
  // 而 NULL 在「今天寄了几封」这里既可能是没寄过、也可能是没这一列，读的人分不清。
  try {
    sql`ALTER TABLE mail_config ADD COLUMN sent_day TEXT NOT NULL DEFAULT ''`;
  } catch {
    /* 已有该列 */
  }
  try {
    sql`ALTER TABLE mail_config ADD COLUMN sent_count INTEGER NOT NULL DEFAULT 0`;
  } catch {
    /* 已有该列 */
  }
  try {
    sql`ALTER TABLE mail_config ADD COLUMN last_send TEXT NOT NULL DEFAULT ''`;
  } catch {
    /* 已有该列 */
  }
  // 这两闸都是后加的：老库里没有就得补上，而补出来的默认值必须是「关」——
  // 升级本身不该顺手把离线副本或收信落库打开。
  try {
    sql`ALTER TABLE mail_config ADD COLUMN say_mail INTEGER NOT NULL DEFAULT 0`;
  } catch {
    /* 已有该列 */
  }
  try {
    sql`ALTER TABLE mail_config ADD COLUMN inbox_enabled INTEGER NOT NULL DEFAULT 0`;
  } catch {
    /* 已有该列 */
  }
  // 种那唯一一行：ON CONFLICT DO NOTHING，管理员改过的配置不会被下一次建表洗回默认
  sql`INSERT INTO mail_config (id) VALUES ('main') ON CONFLICT(id) DO NOTHING`;
}

function readRow(sql: SqlTag): MailRow | null {
  ensureMailConfigSchema(sql);
  const rows = sql<MailRow>`
    SELECT enabled, hostname, port, secure, username, key_secret, from_addr,
           to_addr, daily_cap, sent_day, sent_count, last_send,
           say_mail, inbox_enabled
    FROM mail_config WHERE id = 'main'`;
  return rows[0] ?? null;
}

/** 行 → 十一格可写字段；行没了或某格认不出，都落回出厂默认 */
function rowToConfig(r: MailRow | null): MailConfigStored {
  return {
    enabled: toBool(r?.enabled),
    hostname: asStr(r?.hostname),
    port: toInt(r?.port, DEFAULT_MAIL_CONFIG.port),
    secure: toBool(r?.secure),
    username: asStr(r?.username),
    keySecret: asStr(r?.key_secret),
    from: asStr(r?.from_addr),
    to: asStr(r?.to_addr),
    dailyCap: toInt(r?.daily_cap, DEFAULT_MAIL_CONFIG.dailyCap),
    sayMail: toBool(r?.say_mail),
    inboxEnabled: toBool(r?.inbox_enabled),
  };
}

/**
 * 那个变量在这台机器上配了没有。
 *
 * 只报「有没有」，值本体一眼都不看、更不出去 —— 面板要显示的是「这把钥匙在不在」，
 * 不是「这把钥匙是什么」。
 */
export function isSecretConfigured(
  env: Record<string, unknown>,
  name: string,
): boolean {
  if (!name) return false;
  const v = env[name];
  return typeof v === "string" && v.trim() !== "";
}

/** last_send 存的是 JSON 文本；脏数据当「没寄过」，一次写坏不该把整块面板弄崩 */
function parseLastSend(raw: unknown): MailLastSend | null {
  const s = asStr(raw).trim();
  if (!s) return null;
  let v: unknown;
  try {
    v = JSON.parse(s);
  } catch {
    return null;
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  return {
    at: asStr(o.at),
    ok: toBool(o.ok),
    error: asStr(o.error),
    to: asStr(o.to),
  };
}

/** 面板读：十一格可写字段 + keyAvailable + lastSend（口令本体一个字节都不在里面） */
export function getMailConfigView(
  sql: SqlTag,
  env: Record<string, unknown>,
): MailConfigView {
  const r = readRow(sql);
  const cur = rowToConfig(r);
  return {
    ...cur,
    keyAvailable: isSecretConfigured(env, cur.keySecret),
    lastSend: parseLastSend(r?.last_send),
    toList: parseAddressList(cur.to),
  };
}

/**
 * 今天（按他的日子算，不按 UTC —— 与「今天主动开口几次」同一把尺）的日期键。
 * 额度的重置点就是它变了的那一刻。
 */
export function mailDayKey(now: Date = new Date()): string {
  return new Date(now.getTime() + 8 * 3600_000).toISOString().slice(0, 10);
}

/** 今天已经占掉几格：跨天了就从零算 */
function usedToday(r: MailRow | null, day: string): number {
  return asStr(r?.sent_day) === day ? toInt(r?.sent_count, 0) : 0;
}

export type MailQuota = { ok: true } | { ok: false; error: string };

/**
 * 占一格额度。查、判、写三步必须在同一个同步块里跑完。
 *
 * 为什么这么写：这间屋子里两封邮件可以在同一秒并发进来（提醒和测试撞上同一刻）。
 * 中间只要让出一个 tick 去 await，两封读到的都是同一个「今天已寄 N 封」，
 * 于是双双过闸 —— 上限就变成了「同一秒能寄几封看运气」。
 *
 * 占上就不退：sendMail 半路断的时候服务器可能已经收了件，把额度还回去，
 * 同一件事就可能被寄出第二封。宁可少寄一封。
 */
export function reserveMailSlot(sql: SqlTag, now: Date = new Date()): MailQuota {
  const r = readRow(sql);
  const cap = toInt(r?.daily_cap, DEFAULT_MAIL_CONFIG.dailyCap);
  const day = mailDayKey(now);
  const used = usedToday(r, day);
  if (cap <= 0)
    return { ok: false, error: "每日上限是 0，等于不发（要寄就把它调上去）" };
  if (used >= cap)
    return {
      ok: false,
      error: `今天的邮件额度用完了（上限 ${cap} 封/天，北京时间零点重置）`,
    };
  sql`UPDATE mail_config SET sent_day = ${day}, sent_count = ${used + 1}
      WHERE id = 'main'`;
  return { ok: true };
}

/** 记一笔「上一次发送」：成功失败都记，失败那句就是面板上要显示的原因 */
export function recordMailSend(sql: SqlTag, log: MailLastSend): void {
  ensureMailConfigSchema(sql);
  sql`UPDATE mail_config SET last_send = ${JSON.stringify(log)} WHERE id = 'main'`;
}

/**
 * 落库前的最后一道形状关。
 *
 * 空值放过：半填的配置是合法的（管理员先存一半再补），发不出去由 send.ts 拦。
 * 不放过的是「存了也永远发不出去」的错值：端口 25 平台就封、地址里带尖括号换行
 * 就能往协议行里插命令 —— 这些留在表里只会变成将来查半天的悬案。
 */
function assertChannelShape(c: MailConfigStored): void {
  if (c.hostname && !HOSTNAME_RE.test(c.hostname))
    throw new Error(`SMTP 主机名不合法：${c.hostname}`);
  if (c.keySecret && !SECRET_NAME_RE.test(c.keySecret))
    throw new Error(`secret 变量名不合法：${c.keySecret}`);
  if (c.from) assertSafeAddress({ email: c.from }, "发件地址");
  if (c.to) assertAddressList(c.to, "默认收件地址");
}

/**
 * 保存：只认白名单那十一格，其余键（含任何口令字段）连读都不读。
 *
 * 白名单写在这里而不是写在各调用方，是因为调用方会增多：HTTP 路由、将来的
 * 工具/脚本。「忘了过滤」不该变成一个能把口令写进配置的口子。
 */
export function saveMailConfig(sql: SqlTag, patch: MailConfigPatch): void {
  ensureMailConfigSchema(sql);
  const cur = rowToConfig(readRow(sql));
  const p = patch ?? {};
  // 只按名取那十一格（其余键连读都不读），文本一律 String() 兜一层：
  // 从 RPC 直连进来的脏值该被归一，不该以一个 TypeError 的形式冒到面板上
  const txt = (v: unknown, keep: string, max: number): string =>
    v === undefined ? keep : String(v).trim().slice(0, max);
  const next: MailConfigStored = {
    enabled: p.enabled === undefined ? cur.enabled : toBool(p.enabled),
    secure: p.secure === undefined ? cur.secure : toBool(p.secure),
    hostname: txt(p.hostname, cur.hostname, HOST_MAX),
    username: txt(p.username, cur.username, USER_MAX),
    keySecret: txt(p.keySecret, cur.keySecret, SECRET_NAME_MAX),
    from: txt(p.from, cur.from, ADDR_MAX),
    to: txt(p.to, cur.to, TO_TEXT_MAX),
    sayMail: p.sayMail === undefined ? cur.sayMail : toBool(p.sayMail),
    inboxEnabled:
      p.inboxEnabled === undefined ? cur.inboxEnabled : toBool(p.inboxEnabled),
    port: p.port === undefined ? cur.port : toInt(p.port, cur.port),
    dailyCap:
      p.dailyCap === undefined
        ? cur.dailyCap
        : Math.min(Math.max(toInt(p.dailyCap, cur.dailyCap), 0), MAX_DAILY_CAP),
  };
  if (next.port === 25)
    throw new Error("不支持 25 端口（平台禁止出站），请改 465 或 587");
  if (next.port < 1 || next.port > 65535) throw new Error("SMTP 端口不合法");
  assertChannelShape(next);
  sql`UPDATE mail_config SET enabled = ${toBit(next.enabled)},
        hostname = ${next.hostname}, port = ${next.port},
        secure = ${toBit(next.secure)}, username = ${next.username},
        key_secret = ${next.keySecret}, from_addr = ${next.from},
        to_addr = ${next.to}, daily_cap = ${next.dailyCap},
        say_mail = ${toBit(next.sayMail)},
        inbox_enabled = ${toBit(next.inboxEnabled)}
      WHERE id = 'main'`;
}

/**
 * HTTP 边界上的字段闸：白名单挑出十一格，顺手把类型错、端口 25、地址非法
 * 变成 400 和一句人话 —— 状态码在这里还有意义，落库之后就只剩 500 了。
 *
 * 认不出的键（password / pass / smtpPassword / auth 之类）不进 patch。
 * null 和 undefined 当「这一格没给」，不当「清空」：前端表单交空值很常见，
 * 把它当清空会在人没打算改的时候把配置洗掉。
 */
/** 文本那五格：键名写死成联合类型，免得哪天把 port 也当字符串塞进来 */
const STRING_FIELDS = [
  "hostname",
  "username",
  "keySecret",
  "from",
  "to",
] as const;

export function parseMailConfigInput(
  body: Record<string, unknown>,
): MailConfigPatch {
  const src = body ?? {};
  const patch: MailConfigPatch = {};
  const given = (k: string): boolean =>
    k in src && src[k] !== null && src[k] !== undefined;

  const bool = (k: "enabled" | "secure" | "sayMail" | "inboxEnabled"): void => {
    if (!given(k)) return;
    const v = src[k];
    if (typeof v !== "boolean" && v !== 0 && v !== 1)
      throw new HttpError(400, `${k} 得是 true / false`);
    patch[k] = v === true || v === 1;
  };
  const str = (k: (typeof STRING_FIELDS)[number]): void => {
    if (!given(k)) return;
    const v = src[k];
    if (typeof v !== "string") throw new HttpError(400, `${k} 得是一段文本`);
    patch[k] = v.trim();
  };
  const int = (k: "port" | "dailyCap"): number | undefined => {
    if (!given(k)) return undefined;
    const v = src[k];
    // 数字与纯数字字符串都收：表单里那两格常常是文本输入框交上来的
    if (typeof v !== "number" && typeof v !== "string")
      throw new HttpError(400, `${k} 得是一个整数`);
    const n = typeof v === "number" ? v : Number(v);
    if (!Number.isInteger(n)) throw new HttpError(400, `${k} 得是一个整数`);
    return n;
  };

  bool("enabled");
  bool("secure");
  bool("sayMail");
  bool("inboxEnabled");
  str("hostname");
  str("username");
  str("keySecret");
  str("from");
  str("to");

  const port = int("port");
  if (port !== undefined) {
    if (port === 25)
      throw new HttpError(400, "不支持 25 端口（平台禁止出站），请改 465 或 587");
    if (port < 1 || port > 65535)
      throw new HttpError(400, "端口得在 1 到 65535 之间");
    patch.port = port;
  }
  const dailyCap = int("dailyCap");
  if (dailyCap !== undefined) {
    if (dailyCap < 0 || dailyCap > MAX_DAILY_CAP)
      throw new HttpError(400, `每日上限得在 0 到 ${MAX_DAILY_CAP} 之间`);
    patch.dailyCap = dailyCap;
  }

  // 形状就地核一遍：错值落库之后只能等发不出去那天才发现，那时已经没了现场
  try {
    assertChannelShape({ ...DEFAULT_MAIL_CONFIG, ...patch });
  } catch (e) {
    throw new HttpError(400, (e as Error).message);
  }
  return patch;
}
