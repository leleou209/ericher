// guest_types：多档来客类型的名册（表只建在主人那间）。
// 每档有名字、密码、可用对外工具、接待说明；来客那间只在鉴权时拿去掉密码的快照。
// 密码存加盐摘要（配了 PASSWORD_PEPPER 时是带胡椒的 HMAC），不存明文；
// 老条目（明文 / 无盐 SHA-256 / 无胡椒 v2）照常能验，登录成功时就地升级（见 verifyPassword）。

import { timingSafeEqual } from "../auth";
import type { SqlTag } from "./state";
import { GUEST_ALWAYS_ON, GUEST_TOGGLABLE_TOOLS } from "./toolGroups";

/**
 * 内置通用档 id：走前台门禁口令（env.GATE_PASSWORD）进来的人归这档。
 * 它是名册里真实的一行（ensureCommonGuestType），管理员可按件关工具，身份卡也拿它默认。
 */
export const COMMON_TYPE_ID = "common";

/** 内置通用档的名字 */
export const COMMON_TYPE_NAME = "通用来客";

/** 内置档 created 钉在最早：名册按 created 排，它永远第一——它是底板，不是一档。 */
const COMMON_TYPE_CREATED = "1970-01-01T00:00:00.000Z";

export interface GuestTypeRow {
  id: string;
  name: string;
  /** 加盐摘要（v2 / v2p）；老条目可能是无盐 hex 或明文，验密码时四代都认 */
  password: string;
  /** 接待说明：进提示词，告诉 ericher 这一档该怎么待 */
  note: string;
  /**
   * 这一档开着的对外工具（见 GUEST_TOGGLABLE_TOOLS）。恒开的（天气/识图/卡片/留痕）不在这里。
   */
  tools: string[];
  /**
   * 三个老开关（逐工具化前：检索/画画/记忆）。运行时只认 tools，它们只在 tools 为空串
   * （老行没被新面板写过）时当迁移依据（见 rowToType）。
   */
  permSearch: boolean;
  permDraw: boolean;
  permMemory: boolean;
  /** 记事本（长期使用者的私人草稿本） */
  permNotes: boolean;
  /** 云盘存储（上传/管理自己的文件） */
  permFiles: boolean;
  /** 公开内容与公开文件（往公共区放东西） */
  permPublic: boolean;
  /**
   * 网页矩阵全量管理权：给了就是整面。刻意不拆子权限——发放靠谨慎，不靠分级。
   */
  permMatrix: boolean;
  active: boolean;
  created: string;
}

/**
 * 对外回显：剥掉密码与三个老开关；摘要也不给——忘了口令就重设，没有查回来看的路。
 */
export type GuestTypePublic = Omit<
  GuestTypeRow,
  "password" | "permSearch" | "permDraw" | "permMemory"
>;

interface TypeRow {
  id: string;
  name: string;
  password: string;
  note: string;
  tools: string;
  perm_search: number | boolean;
  perm_draw: number | boolean;
  perm_memory: number | boolean;
  perm_notes: number | boolean;
  perm_files: number | boolean;
  perm_public: number | boolean;
  // 老库里可能压根没有这一列（补列前就读），null 得当「没有这项权益」
  perm_matrix: number | boolean | null;
  active: number | boolean;
  created: string;
}

/** 新建一档的入参；adminPw / gatePw 是 env 两个内置口令，查重用 */
export interface GuestTypeInput {
  name: string;
  password: string;
  note?: string;
  tools?: string[];
  /** 老开关：只有 tools 没给时才拿来推一次（兼容老客户端） */
  permSearch?: boolean;
  permDraw?: boolean;
  permMemory?: boolean;
  permNotes?: boolean;
  permFiles?: boolean;
  permPublic?: boolean;
  permMatrix?: boolean;
}

/** 改一档的入参：字段缺省（undefined）不动。改密码同样要过查重 */
export interface GuestTypePatch {
  name?: string;
  password?: string;
  note?: string;
  tools?: string[];
  permSearch?: boolean;
  permDraw?: boolean;
  permMemory?: boolean;
  permNotes?: boolean;
  permFiles?: boolean;
  permPublic?: boolean;
  permMatrix?: boolean;
  active?: boolean;
}

/**
 * 1/0 与 true/false 归一成布尔；认不出的一律算关（老库 null、写坏的值都落「没有权益」）。
 */
function toBool(v: unknown): boolean {
  return v === 1 || v === true;
}

/** 老开关与新工具的对应：迁移时一次推平（逐工具化之前的三个开关） */
const LEGACY_TOOL_MAP: Array<{
  key: "permSearch" | "permDraw" | "permMemory";
  tools: string[];
}> = [
  { key: "permSearch", tools: ["search", "read_url", "browse"] },
  { key: "permDraw", tools: ["draw", "diagram", "send_image"] },
  { key: "permMemory", tools: ["memory"] },
];

/** 从三个老开关推出工具清单（迁移用） */
function deriveToolsFromPerms(perms: {
  permSearch: boolean;
  permDraw: boolean;
  permMemory: boolean;
}): string[] {
  const out: string[] = [];
  for (const m of LEGACY_TOOL_MAP) if (perms[m.key]) out.push(...m.tools);
  return out;
}

/**
 * 解析 tools 列。空串 / 脏 JSON = 老行没被新面板写过，返回 null 让调用方按老开关推一次，
 * 不能把「没设过」当「全关」。
 */
function parseTools(raw: string): string[] | null {
  const s = (raw || "").trim();
  if (!s) return null;
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : null;
  } catch {
    return null;
  }
}

/** 工具清单一律用 JSON 数组存：空数组是「显式全关」，与「没设过」分得开 */
function serializeTools(tools: string[]): string {
  const seen = new Set<string>();
  const clean = tools.filter((n) => n && !seen.has(n) && seen.add(n));
  return JSON.stringify(clean);
}

/** 入参 → 工具清单：给了 tools 就用它；只有老开关时按老开关推一次 */
function toolsFromInput(input: {
  tools?: string[];
  permSearch?: boolean;
  permDraw?: boolean;
  permMemory?: boolean;
}): string[] {
  if (input.tools !== undefined) return input.tools;
  return deriveToolsFromPerms({
    permSearch: input.permSearch !== false,
    permDraw: input.permDraw !== false,
    permMemory: input.permMemory !== false,
  });
}

/** 三个老列由工具清单反推着写：库里的老列不再是权威，但保持自洽 */
function legacyCols(tools: string[]): {
  perm_search: number;
  perm_draw: number;
  perm_memory: number;
} {
  const has = (n: string) => tools.includes(n);
  return {
    perm_search: has("search") || has("read_url") || has("browse") ? 1 : 0,
    perm_draw: has("draw") || has("diagram") || has("send_image") ? 1 : 0,
    perm_memory: has("memory") ? 1 : 0,
  };
}

/** 摘要的形状：64 位 hex。存进去的值长得像这个就是旧的无盐摘要代 */
const HEX64 = /^[0-9a-f]{64}$/;
const enc = new TextEncoder();

function hex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", enc.encode(input));
  return hex(new Uint8Array(buf));
}

async function hmacHex(key: string, input: string): Promise<string> {
  const k = await crypto.subtle.importKey(
    "raw",
    enc.encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return hex(
    new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(input))),
  );
}

/**
 * 口令 → 加盐摘要。配置了 PASSWORD_PEPPER 时用 HMAC（v2p），否则加盐 SHA-256（v2）。
 * 两者都远快于 PBKDF2；pepper 让「只拿到库、没拿到 env」的离线撞库失效。
 */
export async function hashPassword(pw: string, pepper = ""): Promise<string> {
  const salt = hex(crypto.getRandomValues(new Uint8Array(16)));
  const material = `${salt}|${pw}`;
  const sig = pepper ? await hmacHex(pepper, material) : await sha256Hex(material);
  return `${pepper ? "v2p" : "v2"}$${salt}$${sig}`;
}

/**
 * 比对口令，兼容四代：v2p（pepper）、v2（加盐 SHA-256）、无盐 SHA-256、老明文。
 * 成功且代际落后时返回 needsRehash，由登录成功的那条路就地升级。
 */
export async function verifyPassword(
  pw: string,
  stored: string,
  pepper = "",
): Promise<{ ok: boolean; needsRehash: boolean }> {
  if (stored.startsWith("v2p$")) {
    const [, salt, sig] = stored.split("$");
    if (!pepper || !salt || !sig) return { ok: false, needsRehash: false };
    return {
      ok: timingSafeEqual(await hmacHex(pepper, `${salt}|${pw}`), sig),
      needsRehash: false,
    };
  }
  if (stored.startsWith("v2$")) {
    const [, salt, sig] = stored.split("$");
    if (!salt || !sig) return { ok: false, needsRehash: false };
    const ok = timingSafeEqual(await sha256Hex(`${salt}|${pw}`), sig);
    return { ok, needsRehash: ok && !!pepper };
  }
  if (HEX64.test(stored)) {
    return {
      ok: timingSafeEqual(await sha256Hex(pw), stored),
      needsRehash: true,
    };
  }
  return { ok: timingSafeEqual(pw, stored), needsRehash: true };
}

/** 把一行剥成对外回显的形状（无密码、无三个老开关） */
export function toGuestTypePublic(t: GuestTypeRow): GuestTypePublic {
  const {
    password: _password,
    permSearch: _ps,
    permDraw: _pd,
    permMemory: _pm,
    ...rest
  } = t;
  return rest;
}

function rowToType(r: TypeRow): GuestTypeRow {
  const legacy = {
    permSearch: toBool(r.perm_search),
    permDraw: toBool(r.perm_draw),
    permMemory: toBool(r.perm_memory),
  };
  return {
    id: r.id,
    name: r.name,
    password: r.password,
    note: r.note,
    // 老行（tools 空串）拿三个老开关推一次：迁移只做这一刻，不动库
    tools: parseTools(r.tools) ?? deriveToolsFromPerms(legacy),
    ...legacy,
    permNotes: toBool(r.perm_notes),
    permFiles: toBool(r.perm_files),
    permPublic: toBool(r.perm_public),
    permMatrix: toBool(r.perm_matrix),
    active: toBool(r.active),
    created: r.created,
  };
}

/**
 * 种入内置通用档（真实一行）。口令列留空：进门验 env 前台口令，findGuestTypeByPassword 跳过这行。
 * 权益缺省全开（与历史行为一致），矩阵权例外种成关；created 最早，名册排第一。
 * ON CONFLICT DO NOTHING：只种一次，管理员后续改动不被建表冲掉。
 */
export function ensureCommonGuestType(sql: SqlTag): void {
  const tools = serializeTools([...GUEST_TOGGLABLE_TOOLS]);
  sql`INSERT INTO guest_types (id, name, password, note, tools, perm_search,
            perm_draw, perm_memory, perm_notes, perm_files, perm_public,
            perm_matrix, active, created)
      VALUES (${COMMON_TYPE_ID}, ${COMMON_TYPE_NAME}, ${""}, ${""}, ${tools},
              ${1}, ${1}, ${1}, ${1}, ${1}, ${1}, ${0}, ${1}, ${COMMON_TYPE_CREATED})
      ON CONFLICT(id) DO NOTHING`;
}

export function ensureGuestTypesSchema(sql: SqlTag): void {
  sql`CREATE TABLE IF NOT EXISTS guest_types (
       id          TEXT PRIMARY KEY,
       name        TEXT NOT NULL,
       password    TEXT NOT NULL,
       note        TEXT NOT NULL DEFAULT '',
       tools       TEXT NOT NULL DEFAULT '',
       perm_search INTEGER NOT NULL DEFAULT 1,
       perm_draw   INTEGER NOT NULL DEFAULT 1,
       perm_memory INTEGER NOT NULL DEFAULT 1,
       perm_notes  INTEGER NOT NULL DEFAULT 0,
       perm_files  INTEGER NOT NULL DEFAULT 0,
       perm_public INTEGER NOT NULL DEFAULT 0,
       perm_matrix INTEGER NOT NULL DEFAULT 0,
       active      INTEGER NOT NULL DEFAULT 1,
       created     TEXT NOT NULL
     )`;
  // 老库补列：逐工具化之后新增的 tools 列（空串 = 老行，读时按老开关推一次）。
  try {
    sql`ALTER TABLE guest_types ADD COLUMN tools TEXT NOT NULL DEFAULT ''`;
  } catch {
    /* 已有该列 */
  }
  // 补列一条条试：ADD COLUMN 撞已有列会抛，报错就当已有。
  // 列名不能走绑定参数，只能三条字面量各写各的。
  try {
    sql`ALTER TABLE guest_types ADD COLUMN perm_notes INTEGER NOT NULL DEFAULT 0`;
  } catch {
    /* 已有该列 */
  }
  try {
    sql`ALTER TABLE guest_types ADD COLUMN perm_files INTEGER NOT NULL DEFAULT 0`;
  } catch {
    /* 已有该列 */
  }
  try {
    sql`ALTER TABLE guest_types ADD COLUMN perm_public INTEGER NOT NULL DEFAULT 0`;
  } catch {
    /* 已有该列 */
  }
  // perm_matrix 后加，存量一律落 0：补列必须带 DEFAULT 0，否则老行为 NULL，
  // 而「读不出值」只能按没有这项权算（见 toBool）。
  try {
    sql`ALTER TABLE guest_types ADD COLUMN perm_matrix INTEGER NOT NULL DEFAULT 0`;
  } catch {
    /* 已有该列 */
  }
  // 建表补齐之后就种上内置通用档：它是名册的底板，任何读名册的路都该看见它
  ensureCommonGuestType(sql);
}

export function listGuestTypes(sql: SqlTag): GuestTypeRow[] {
  ensureGuestTypesSchema(sql);
  return sql<TypeRow>`
    SELECT id, name, password, note, tools, perm_search, perm_draw, perm_memory,
           perm_notes, perm_files, perm_public, perm_matrix, active, created
    FROM guest_types ORDER BY created`.map(rowToType);
}

/**
 * 按 id 查档，停用的按查无此档算。权益核实独享这把过滤：旧票（30 天）与旧卡不因停用失效，
 * 不过滤的话停用只挡新登录。面板看档走 listGuestTypes，改档走 typeByIdAnyState（均不过滤）。
 */
function typeById(sql: SqlTag, id: string): GuestTypeRow | null {
  const rows = sql<TypeRow>`
    SELECT id, name, password, note, tools, perm_search, perm_draw, perm_memory,
           perm_notes, perm_files, perm_public, perm_matrix, active, created
    FROM guest_types WHERE id = ${id} AND active = 1`;
  return rows.length ? rowToType(rows[0]) : null;
}

/**
 * 按 id 查档，停用的也查得到：改档专用。
 * 不过滤 active，否则停用的档改不了名、也 PATCH active:true 不回来，「停用」成了单行道。
 */
function typeByIdAnyState(sql: SqlTag, id: string): GuestTypeRow | null {
  const rows = sql<TypeRow>`
    SELECT id, name, password, note, tools, perm_search, perm_draw, perm_memory,
           perm_notes, perm_files, perm_public, perm_matrix, active, created
    FROM guest_types WHERE id = ${id}`;
  return rows.length ? rowToType(rows[0]) : null;
}

/** 按 id 查一档。查无此档返回 null。 */
export function getGuestType(sql: SqlTag, id: string): GuestTypeRow | null {
  ensureGuestTypesSchema(sql);
  return typeById(sql, id);
}

/** 去掉密码的对外快照：进 state / ToolCtx / 提示词的都是这个形状 */
export interface GuestTypeInfo {
  id: string;
  name: string;
  note: string;
  /** 这一档开着的对外工具（恒开的那些不在里面）；运行时只看它 */
  tools: string[];
  permNotes: boolean;
  permFiles: boolean;
  permPublic: boolean;
  /** 网页矩阵的全量管理权（同样只对持卡的长期身份生效） */
  permMatrix: boolean;
}

/** 这一档能不能用某件来客工具：档位清单里开着的，或恒开的那些（天气/识图/卡片/留痕） */
export function guestHasTool(t: GuestTypeInfo, name: string): boolean {
  return t.tools.includes(name) || GUEST_ALWAYS_ON.includes(name);
}

/**
 * 四项凭身份卡的长期权益（对应 guest_types 的 perm_* 列）。
 * 闸（index.ts cardAllows）与 DO 现查（cowork.ts cardPerm）共用这份口径，防 REST/RPC 半开。
 */
export type GuestCardPerm = "permNotes" | "permFiles" | "permPublic" | "permMatrix";

/**
 * 名册查不到这档时算不算有某项权益。
 * 通用档的老三项按全开：门口最后一把钥匙，不能因 DO 抖动锁住在场客人。
 * 矩阵权反之按没有：整面网页不能兜底发出去，否则收回都无从谈起。
 */
export function cardPermFallback(typeId: string, perm: GuestCardPerm): boolean {
  if (perm === "permMatrix") return false;
  return typeId === COMMON_TYPE_ID;
}

export function toGuestTypeInfo(t: GuestTypeRow): GuestTypeInfo {
  return {
    id: t.id,
    name: t.name,
    note: t.note,
    tools: t.tools,
    permNotes: t.permNotes,
    permFiles: t.permFiles,
    permPublic: t.permPublic,
    permMatrix: t.permMatrix,
  };
}

/**
 * 通用档的全开快照：主人那间读不到名册时兜底（别的档核实不了要全关）。
 * 它是前台口令这把最后钥匙，不能因 DO 抖动锁住进门的人；缺省语义本就是全开。
 * 矩阵权不参与全开：它不在前台口令历史权限里，放行只走名册真实行。
 */
export function defaultCommonGuestTypeInfo(): GuestTypeInfo {
  return {
    id: COMMON_TYPE_ID,
    name: COMMON_TYPE_NAME,
    note: "",
    tools: [...GUEST_TOGGLABLE_TOOLS],
    permNotes: true,
    permFiles: true,
    permPublic: true,
    permMatrix: false,
  };
}

/**
 * 档位失效的兜底：票里声称的档查不到/停用/查询失败，按「能关全关」接待。
 * 权益语义是「明确关掉才生效」，这里必须反过来——核实失败不能当「没有约定」放行，
 * 否则删一档类型就把所有来客放成全开。名字照实说，来客不至于一头雾水。
 */
export function disabledGuestTypeInfo(id: string): GuestTypeInfo {
  return {
    id,
    name: "（原类型已失效）",
    note: "",
    tools: [],
    permNotes: false,
    permFiles: false,
    permPublic: false,
    permMatrix: false,
  };
}

/** 密码查重：两个内置口令和表里已有的每一档都不许重 —— 重了，「分档」就分不出人 */
async function assertPasswordFree(
  sql: SqlTag,
  pw: string,
  adminPw: string,
  gatePw: string,
  pepper = "",
): Promise<void> {
  if (adminPw && timingSafeEqual(pw, adminPw))
    throw new Error("这档密码和管理员口令撞了，换一个");
  if (gatePw && timingSafeEqual(pw, gatePw))
    throw new Error("这档密码和前台口令撞了，换一个");
  for (const t of listGuestTypes(sql)) {
    // 内置档的密码就是前台门禁口令，表里那格是空的，不参与查重
    if (t.id === COMMON_TYPE_ID) continue;
    if ((await verifyPassword(pw, t.password, pepper)).ok)
      throw new Error(`这档密码已经「${t.name}」在用，换一个`);
  }
}

export async function createGuestType(
  sql: SqlTag,
  input: GuestTypeInput & { adminPw: string; gatePw: string },
  pepper = "",
): Promise<GuestTypeRow> {
  ensureGuestTypesSchema(sql);
  const name = (input.name || "").trim().slice(0, 40);
  const password = input.password || "";
  if (!name) throw new Error("来客类型的名称不能为空");
  if (!password) throw new Error("来客类型的密码不能为空");
  await assertPasswordFree(sql, password, input.adminPw, input.gatePw, pepper);
  const tools = toolsFromInput(input);
  const row: TypeRow = {
    id: crypto.randomUUID().slice(0, 8),
    name,
    password: await hashPassword(password, pepper),
    note: (input.note || "").trim().slice(0, 300),
    tools: serializeTools(tools),
    ...legacyCols(tools),
    perm_notes: input.permNotes ? 1 : 0,
    perm_files: input.permFiles ? 1 : 0,
    perm_public: input.permPublic ? 1 : 0,
    perm_matrix: input.permMatrix ? 1 : 0,
    active: 1,
    created: new Date().toISOString(),
  };
  sql`INSERT INTO guest_types (id, name, password, note, tools, perm_search,
            perm_draw, perm_memory, perm_notes, perm_files, perm_public,
            perm_matrix, active, created)
      VALUES (${row.id}, ${row.name}, ${row.password}, ${row.note},
              ${row.tools}, ${row.perm_search}, ${row.perm_draw},
              ${row.perm_memory}, ${row.perm_notes}, ${row.perm_files},
              ${row.perm_public}, ${row.perm_matrix}, ${row.active}, ${row.created})`;
  return rowToType(row);
}

export async function updateGuestType(
  sql: SqlTag,
  id: string,
  patch: GuestTypePatch & { adminPw: string; gatePw: string },
  pepper = "",
): Promise<GuestTypeRow | null> {
  ensureGuestTypesSchema(sql);
  // 改档路径用不过滤 active 的查档：停用的档也查得到，PATCH {active:true} 才有路转正
  const cur = typeByIdAnyState(sql, id);
  if (!cur) return null;
  // 内置通用档只开放「叫什么、怎么接待、开哪些工具」：口令就是 env 里的前台
  // 门禁口令，没有重设这一说；也不能停用 —— 它是门口最后一把钥匙，关了这一档
  // 等于整条进门的路断了（要收紧就按件关工具）。
  if (id === COMMON_TYPE_ID) {
    if (patch.password)
      throw new Error("默认来客类型的口令就是前台门禁口令，改不了");
    if (patch.active === false) throw new Error("默认来客类型不能停用");
  }
  const name =
    patch.name === undefined
      ? cur.name
      : String(patch.name).trim().slice(0, 40);
  if (!name) throw new Error("来客类型的名称不能为空");
  let password = cur.password;
  if (patch.password !== undefined) {
    const next = patch.password || "";
    if (!next) throw new Error("来客类型的密码不能为空");
    const checked = await verifyPassword(next, cur.password, pepper);
    if (!checked.ok) {
      await assertPasswordFree(
        sql,
        next,
        patch.adminPw,
        patch.gatePw,
        pepper,
      );
      password = await hashPassword(next, pepper);
    } else if (checked.needsRehash) {
      // 口令没换，但旧条目是明文/无盐/v2：顺手升级到当前格式
      password = await hashPassword(next, pepper);
    }
  }
  // 工具清单：给了 tools 就整份换掉；只有老开关时按老开关重推一遍；
  // 两样都没给，就沿用这一档现在的（老行会先经 rowToType 推平）
  const legacyTouched =
    patch.permSearch !== undefined ||
    patch.permDraw !== undefined ||
    patch.permMemory !== undefined;
  const tools =
    patch.tools !== undefined
      ? patch.tools
      : legacyTouched
        ? deriveToolsFromPerms({
            permSearch: patch.permSearch ?? cur.permSearch,
            permDraw: patch.permDraw ?? cur.permDraw,
            permMemory: patch.permMemory ?? cur.permMemory,
          })
        : cur.tools;
  const row: TypeRow = {
    id: cur.id,
    name,
    password,
    note:
      patch.note === undefined
        ? cur.note
        : String(patch.note).trim().slice(0, 300),
    tools: serializeTools(tools),
    ...legacyCols(tools),
    perm_notes: (patch.permNotes ?? cur.permNotes) ? 1 : 0,
    perm_files: (patch.permFiles ?? cur.permFiles) ? 1 : 0,
    perm_public: (patch.permPublic ?? cur.permPublic) ? 1 : 0,
    perm_matrix: (patch.permMatrix ?? cur.permMatrix) ? 1 : 0,
    // 默认档不能停用；合法更新修复异常状态，但不放开已关闭权限。
    active: id === COMMON_TYPE_ID ? 1 : (patch.active ?? cur.active) ? 1 : 0,
    created: cur.created,
  };
  sql`UPDATE guest_types SET name = ${row.name}, password = ${row.password},
        note = ${row.note}, tools = ${row.tools},
        perm_search = ${row.perm_search},
        perm_draw = ${row.perm_draw}, perm_memory = ${row.perm_memory},
        perm_notes = ${row.perm_notes}, perm_files = ${row.perm_files},
        perm_public = ${row.perm_public}, perm_matrix = ${row.perm_matrix},
        active = ${row.active}
      WHERE id = ${row.id}`;
  return rowToType(row);
}

export function removeGuestType(sql: SqlTag, id: string): boolean {
  // 内置档删不得：删了它就只剩「全开兜底」，管理员收过的权限会集体被放开
  if (id === COMMON_TYPE_ID) throw new Error("默认来客类型是内置的，删不得");
  ensureGuestTypesSchema(sql);
  const rows = sql<{ id: string }>`SELECT id FROM guest_types WHERE id = ${id}`;
  if (!rows.length) return false;
  sql`DELETE FROM guest_types WHERE id = ${id}`;
  return true;
}

/**
 * 门口验密码：先排除两个内置口令（另一条路），再逐档比已启用类型；命中返回整行。
 * 命中一条旧格式（明文 / 无盐 / 无 pepper）的记录时，就地升级成当前格式 ——
 * 登录成功那一刻是唯一能拿到明文的地方，错过这次又要等下一回。
 */
export async function findGuestTypeByPassword(
  sql: SqlTag,
  pw: string,
  adminPw: string,
  gatePw: string,
  pepper = "",
): Promise<GuestTypeRow | null> {
  if (!pw) return null;
  if (adminPw && timingSafeEqual(pw, adminPw)) return null;
  if (gatePw && timingSafeEqual(pw, gatePw)) return null;
  ensureGuestTypesSchema(sql);
  const rows = sql<TypeRow>`
    SELECT id, name, password, note, tools, perm_search, perm_draw, perm_memory,
           perm_notes, perm_files, perm_public, perm_matrix, active, created
    FROM guest_types WHERE active = 1 ORDER BY created`;
  for (const r of rows) {
    // 内置档走的是 env 里的前台口令（上面已早退排除），表里那一格是空的：
    // 跳过它，免得哪个来客拿空口令或撞上这一行
    if (r.id === COMMON_TYPE_ID) continue;
    const checked = await verifyPassword(pw, r.password, pepper);
    if (!checked.ok) continue;
    if (checked.needsRehash) {
      try {
        sql`UPDATE guest_types SET password = ${await hashPassword(pw, pepper)}
            WHERE id = ${r.id}`;
      } catch {
        /* 升级失败下次登录再试，不影响这次进门 */
      }
    }
    return rowToType(r);
  }
  return null;
}
