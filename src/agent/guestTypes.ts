// guest_types：多档来客类型的名册。
//
// 门口原来只有两把钥匙（管理员 / 前台），来客进了门能用的东西也就只有一种组合。
// 这张表把「能进门的密码」拆成若干档：管理员给每一档起名、设密码、
// 勾上它能用哪些对外工具（检索 / 画画 / 记忆），再写一句接待说明 ——
// 谁拿哪把钥匙进门，进门就被按哪一档待。
//
// 密码存 SHA-256 摘要（hex），不存明文。验法是把来的人口令也过一遍摘要再比：
// 摘要不可逆，所以库里泄了也撞不回原口令。老条目还是明文的照常能验
// （verifyStoredPassword 兼容两代），管理员下次改那一档的密码时就地升级成摘要。
//
// 表只建在主人那间：类型是这张台子的配置，不是哪位来客的私物；
// 来客那间只在连接鉴权时拿到一份去掉密码的快照（见 cowork.ts 的 onConnect）。

import { timingSafeEqual } from "../auth";
import type { SqlTag } from "./state";
import { GUEST_ALWAYS_ON, GUEST_TOGGLABLE_TOOLS } from "./toolGroups";

/**
 * 内置通用档的档位 id：走前台门禁口令（env.GATE_PASSWORD）进来的来客都归这一档。
 *
 * 它从前只活在代码里（cowork.ts 就地给一份全开快照），面板上看不见、也就调不了。
 * 现在它是名册里真实的一行（见 ensureCommonGuestType），管理员能像别的档一样
 * 按件关它的工具。身份卡也拿它当默认档。
 */
export const COMMON_TYPE_ID = "common";

/** 内置通用档的名字 */
export const COMMON_TYPE_NAME = "通用来客";

/**
 * 内置档的建档时刻钉在最早：名册按 created 排，它永远排第一 ——
 * 它是底板，不是众多档位里的一档。
 */
const COMMON_TYPE_CREATED = "1970-01-01T00:00:00.000Z";

export interface GuestTypeRow {
  id: string;
  name: string;
  /** SHA-256 摘要（hex）；老条目可能是明文，验密码时两代都认 */
  password: string;
  /** 接待说明：进提示词，告诉 ericher 这一档该怎么待 */
  note: string;
  /**
   * 这一档开着的对外工具名（见 toolGroups.ts 的 GUEST_TOGGLABLE_TOOLS）。
   * 恒开的那些（天气/识图/卡片/留痕）不在这里 —— 它们没有关掉的路。
   */
  tools: string[];
  /**
   * 上面三个老开关：逐工具化之前，检索/画画/记忆各是一个开关。
   * 现在运行时只认 tools，它们退成**迁移依据** —— 只有 tools 还是空串
   * （这一档从没被新面板写过）时才拿它们推一次（见 rowToType）。
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
  active: boolean;
  created: string;
}

/**
 * 对外回显的行：剥掉密码，也剥掉三个老开关（前端只认 tools）。
 * 摘要也不给 —— 管理员忘了口令就重设，没有「查回来看」这条路。
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
  active?: boolean;
}

/** SQLite 的 1/0 和假库里的 true/false 都归一成布尔 */
function toBool(v: number | boolean): boolean {
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
 * 解析库里的 tools 列。空串 = 这一档从没被新面板写过（老行），
 * 交回 null 让调用方按老开关推一次 —— 不能把「没设过」当成「全关」。
 * 值是一段 JSON 数组；脏数据（写坏了）同样当没设过处理，宁可推一次。
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

/** 摘要的形状：64 位 hex。存进去的值长得像这个就是摘要代 */
const HEX64 = /^[0-9a-f]{64}$/;

/** 口令 → SHA-256 摘要（小写 hex）。入库存这个，明文不落表 */
export async function hashPassword(pw: string): Promise<string> {
  const buf = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(pw),
  );
  return [...new Uint8Array(buf)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * 存储形态的密码和来的人口令比对，两代都认：
 * - 存的是摘要（64 位 hex）：把口令的摘要（调用方预算好传入）和它比；
 * - 存的是明文（老条目）：直接逐字比。
 * 摘要代算一次哈希要 await，所以比对本身吃现成结果，不在这里算。
 */
function verifyStoredPassword(
  stored: string,
  pw: string,
  pwHash?: string,
): boolean {
  if (HEX64.test(stored)) return !!pwHash && timingSafeEqual(stored, pwHash);
  return timingSafeEqual(pw, stored);
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
    active: toBool(r.active),
    created: r.created,
  };
}

/**
 * 种入内置通用档。
 *
 * 为什么要落成真实的一行：从前它钉死在代码里、权限恒全开，管理面板上根本
 * 没有这一档，想收一收「拿前台口令进来的人」能做些什么就无从下手。落成一行
 * 之后，它出现在来客类型名册和权限矩阵里，可以按件关工具、能写接待说明。
 *
 * 口令列留空：进门验的是 env 里的前台门禁口令，不走这张表（findGuestTypeByPassword
 * 跳过这一行，免得空口令被谁撞上）。权益缺省全开 —— 与它历史上的行为一致，
 * 种入不改任何人的既得权限；收紧是管理员后来的事。
 * created 钉在最早，名册里它排第一。
 * ON CONFLICT DO NOTHING：种一次就够，管理员后来的改动不会被下一次建表冲掉。
 */
export function ensureCommonGuestType(sql: SqlTag): void {
  const tools = serializeTools([...GUEST_TOGGLABLE_TOOLS]);
  sql`INSERT INTO guest_types (id, name, password, note, tools, perm_search,
            perm_draw, perm_memory, perm_notes, perm_files, perm_public,
            active, created)
      VALUES (${COMMON_TYPE_ID}, ${COMMON_TYPE_NAME}, ${""}, ${""}, ${tools},
              ${1}, ${1}, ${1}, ${1}, ${1}, ${1}, ${1}, ${COMMON_TYPE_CREATED})
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
       active      INTEGER NOT NULL DEFAULT 1,
       created     TEXT NOT NULL
     )`;
  // 老库补列：逐工具化之后新增的 tools 列（空串 = 老行，读时按老开关推一次）。
  try {
    sql`ALTER TABLE guest_types ADD COLUMN tools TEXT NOT NULL DEFAULT ''`;
  } catch {
    /* 已有该列 */
  }
  // 长期使用者的三项专属权益是更早加的，旧表没有这三列。
  // ADD COLUMN 遇到已存在的列会抛错 —— 一条一条试，报错就当「已经有了」。
  // 列名没法走绑定参数（插值一律是值绑定），只能三条字面量各写各的
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
  // 建表补齐之后就种上内置通用档：它是名册的底板，任何读名册的路都该看见它
  ensureCommonGuestType(sql);
}

export function listGuestTypes(sql: SqlTag): GuestTypeRow[] {
  ensureGuestTypesSchema(sql);
  return sql<TypeRow>`
    SELECT id, name, password, note, tools, perm_search, perm_draw, perm_memory,
           perm_notes, perm_files, perm_public, active, created
    FROM guest_types ORDER BY created`.map(rowToType);
}

/**
 * 按 id 查档，停用（active = 0）的按查无此档算。
 *
 * 管权益核实的全走这条：旧票（30 天有效期）和名下旧卡不会因为管理员点了
 * 停用就失效，这里不过滤的话，停用只挡得住新登录，收回权益的唯一手段
 * 就只剩破坏性的删档。面板看档位走 listGuestTypes（不过滤），改档走
 * typeByIdAnyState（不过滤 —— 停用的档要能改回来），权益核实独享这把过滤的尺。
 */
function typeById(sql: SqlTag, id: string): GuestTypeRow | null {
  const rows = sql<TypeRow>`
    SELECT id, name, password, note, tools, perm_search, perm_draw, perm_memory,
           perm_notes, perm_files, perm_public, active, created
    FROM guest_types WHERE id = ${id} AND active = 1`;
  return rows.length ? rowToType(rows[0]) : null;
}

/**
 * 按 id 查档，停用的也查得到：管「改档」的路径专用。
 *
 * updateGuestType 不能用上面那把过滤 active 的尺 —— 停用的档在面板上看得见
 * （listGuestTypes 不过滤）、删得掉（removeGuestType 不过滤），唯独改档查不到的
 * 话就永远动不了：改个名要查档，重新启用（PATCH active:true）更要先拿到停用档
 * 本身，否则「停用」成了单行道，想收回只能删档重来。
 */
function typeByIdAnyState(sql: SqlTag, id: string): GuestTypeRow | null {
  const rows = sql<TypeRow>`
    SELECT id, name, password, note, tools, perm_search, perm_draw, perm_memory,
           perm_notes, perm_files, perm_public, active, created
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
}

/** 这一档能不能用某件来客工具：档位清单里开着的，或恒开的那些（天气/识图/卡片/留痕） */
export function guestHasTool(t: GuestTypeInfo, name: string): boolean {
  return t.tools.includes(name) || GUEST_ALWAYS_ON.includes(name);
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
  };
}

/**
 * 内置通用档的全开快照：主人那间读不到名册时拿它兜底。
 *
 * 别的档核实不了要全关（见下面 disabledGuestTypeInfo），这一档反过来：
 * 它是门口最后一把钥匙（前台口令），不能因为一次 DO 抖动把所有进门的人
 * 锁在门外。缺省语义本来就是全开，兜底也就落在全开。
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
  };
}

/**
 * 档位失效时的兜底快照：票里声称的那一档查不到 / 停用了 / 查询失败，
 * 就按这一份接待 —— 能关的一律全关。
 *
 * 权益的语义是「明确关掉才生效」，而这里必须反着来：票上的档位对不上号，
 * 说明管理员已经收回（或我们核实不了）这一档的约定，宁可全关也不能
 * 把「核实失败」当成「没有约定」放行 —— 那等于删一档类型就把所有来客放成全开。
 * 名字照实说，接待说明里会写「这一档出了问题」，不至于让来客一头雾水。
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
  };
}

/** 密码查重：两个内置口令和表里已有的每一档都不许重 —— 重了，「分档」就分不出人 */
async function assertPasswordFree(
  sql: SqlTag,
  pw: string,
  adminPw: string,
  gatePw: string,
): Promise<void> {
  if (adminPw && timingSafeEqual(pw, adminPw))
    throw new Error("这档密码和管理员口令撞了，换一个");
  if (gatePw && timingSafeEqual(pw, gatePw))
    throw new Error("这档密码和前台口令撞了，换一个");
  const pwHash = await hashPassword(pw);
  for (const t of listGuestTypes(sql)) {
    // 内置档的口令就是前台门禁口令，表里那一格是空的，不参与查重
    if (t.id === COMMON_TYPE_ID) continue;
    if (verifyStoredPassword(t.password, pw, pwHash))
      throw new Error(`这档密码已经「${t.name}」在用，换一个`);
  }
}

export async function createGuestType(
  sql: SqlTag,
  input: GuestTypeInput & { adminPw: string; gatePw: string },
): Promise<GuestTypeRow> {
  ensureGuestTypesSchema(sql);
  const name = (input.name || "").trim().slice(0, 40);
  const password = input.password || "";
  if (!name) throw new Error("来客类型的名称不能为空");
  if (!password) throw new Error("来客类型的密码不能为空");
  await assertPasswordFree(sql, password, input.adminPw, input.gatePw);
  const tools = toolsFromInput(input);
  const row: TypeRow = {
    id: crypto.randomUUID().slice(0, 8),
    name,
    password: await hashPassword(password),
    note: (input.note || "").trim().slice(0, 300),
    tools: serializeTools(tools),
    ...legacyCols(tools),
    perm_notes: input.permNotes ? 1 : 0,
    perm_files: input.permFiles ? 1 : 0,
    perm_public: input.permPublic ? 1 : 0,
    active: 1,
    created: new Date().toISOString(),
  };
  sql`INSERT INTO guest_types (id, name, password, note, tools, perm_search,
            perm_draw, perm_memory, perm_notes, perm_files, perm_public,
            active, created)
      VALUES (${row.id}, ${row.name}, ${row.password}, ${row.note},
              ${row.tools}, ${row.perm_search}, ${row.perm_draw},
              ${row.perm_memory}, ${row.perm_notes}, ${row.perm_files},
              ${row.perm_public}, ${row.active}, ${row.created})`;
  return rowToType(row);
}

export async function updateGuestType(
  sql: SqlTag,
  id: string,
  patch: GuestTypePatch & { adminPw: string; gatePw: string },
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
    const nextHash = await hashPassword(next);
    if (!verifyStoredPassword(cur.password, next, nextHash)) {
      await assertPasswordFree(sql, next, patch.adminPw, patch.gatePw);
      password = nextHash;
    } else if (!HEX64.test(cur.password)) {
      // 口令没换，但旧条目还是明文：顺手就地升级成摘要
      password = nextHash;
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
    perm_notes:
      patch.permNotes === undefined ? cur.permNotes : patch.permNotes ? 1 : 0,
    perm_files:
      patch.permFiles === undefined ? cur.permFiles : patch.permFiles ? 1 : 0,
    perm_public:
      patch.permPublic === undefined
        ? cur.permPublic
        : patch.permPublic
          ? 1
          : 0,
    active: patch.active === undefined ? cur.active : patch.active ? 1 : 0,
    created: cur.created,
  };
  sql`UPDATE guest_types SET name = ${row.name}, password = ${row.password},
        note = ${row.note}, tools = ${row.tools},
        perm_search = ${row.perm_search},
        perm_draw = ${row.perm_draw}, perm_memory = ${row.perm_memory},
        perm_notes = ${row.perm_notes}, perm_files = ${row.perm_files},
        perm_public = ${row.perm_public}, active = ${row.active}
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
 * 门口验密码：先比两个内置口令（那是另一条路，直接排除，不该被当成某一档），
 * 再逐档比已启用的类型密码。命中返回那一档的完整行，没命中返回 null。
 */
export async function findGuestTypeByPassword(
  sql: SqlTag,
  pw: string,
  adminPw: string,
  gatePw: string,
): Promise<GuestTypeRow | null> {
  if (!pw) return null;
  if (adminPw && timingSafeEqual(pw, adminPw)) return null;
  if (gatePw && timingSafeEqual(pw, gatePw)) return null;
  ensureGuestTypesSchema(sql);
  const rows = sql<TypeRow>`
    SELECT id, name, password, note, tools, perm_search, perm_draw, perm_memory,
           perm_notes, perm_files, perm_public, active, created
    FROM guest_types WHERE active = 1 ORDER BY created`;
  const pwHash = await hashPassword(pw);
  for (const r of rows) {
    // 内置档走的是 env 里的前台口令（上面已早退排除），表里那一格是空的：
    // 跳过它，免得哪个来客拿空口令或撞上这一行
    if (r.id === COMMON_TYPE_ID) continue;
    if (verifyStoredPassword(r.password, pw, pwHash)) return rowToType(r);
  }
  return null;
}
