// 模型目录：供应商（model_providers）与模型条目（model_entries）两级。
//
// 以前主线模型只认 Worker secrets 那一套（API_ENDPOINT + API_KEY + API_MODEL），
// 换一家厂商得改配置重新部署。这张目录把「用哪家、什么协议、去哪个门」变成数据：
// 管理员在面板上添供应商（名称、格式、地址、Key 变量名），一家底下挂几个模型条目，
// 点名哪个条目生效（active）—— 同一家供应商的多模型自由切换，不用重复填地址和 Key。
//
// 表只建在主人那间 —— 和 guest_types 一样，这是这张台子的配置，
// 不是哪位来客的私物；来客那间隔着 DO 读得到生效那组（里面本来就没有 key 本体）。
//
// 红线：keySecret 存的是 Worker secret 的**变量名**（如 "DEEPSEEK_KEY"），
// key 本体只活在 secrets 里，绝不落库 —— 所以这两张表可以整表回显给面板。
//
// 「名称」就是供应商名称：一家供应商一条，不再有「配置名 vs 模型名」的二义性。
// 维护用 Key 与维护用模型都挂在供应商级 —— 后台小活走哪家的小模型，是这家的事。

import type { SqlTag } from "./state";

/** 三种接口格式，对应 providers.ts 里三条建模路径 */
export type ModelFormat = "anthropic" | "openai-chat" | "openai-responses";

const MODEL_FORMATS: ModelFormat[] = [
  "anthropic",
  "openai-chat",
  "openai-responses",
];

/** 一家供应商：接哪一家的钥匙串。模型条目挂它底下 */
export interface ModelProvider {
  id: string;
  /** 供应商名称（就是界面上的「名称」） */
  name: string;
  format: ModelFormat;
  baseUrl: string;
  /** Worker secret 的变量名（如 "DEEPSEEK_KEY"），不是 key 本体 */
  keySecret: string;
  /** 维护模型单独走哪把 key；空 = 用本家 keySecret 那把 */
  maintKeySecret: string;
  /** 维护模型用哪个模型名；空 = 复用当前生效的主线模型 */
  maintModel: string;
  created: string;
}

/** 一个模型条目：某家供应商底下的一个可用模型。全库最多一条 active */
export interface ModelEntry {
  id: string;
  providerId: string;
  model: string;
  maxOutput: number;
  /**
   * 最大上下文（token 数）。0 = 没设，界面与工具回落到默认档。
   * 这是「这扇门有多宽」：界面拿它显示当前上下文占用，超过就该靠压缩接住。
   */
  contextWindow: number;
  active: boolean;
  created: string;
}

/** 生效中的一组：条目 + 它挂在哪家底下（建模要两样拼一起才完整） */
export interface ActiveCatalog {
  entry: ModelEntry;
  provider: ModelProvider;
}

interface ProviderRow {
  id: string;
  name: string;
  format: string;
  base_url: string;
  key_secret: string;
  maint_key_secret: string;
  maint_model: string;
  created: string;
}

interface EntryRow {
  id: string;
  provider_id: string;
  model: string;
  max_output: number;
  context_window: number | null;
  active: number | boolean;
  created: string;
}

export interface ModelProviderInput {
  name: string;
  format: string;
  baseUrl: string;
  keySecret: string;
  maintKeySecret?: string;
  maintModel?: string;
  /** 新建供应商时顺手挂的首个模型；空就只建供应商，模型之后再加 */
  firstModel?: string;
  maxOutput?: number;
}

/** 改供应商的入参：字段缺省（undefined）不动 */
export interface ModelProviderPatch {
  name?: string;
  format?: string;
  baseUrl?: string;
  keySecret?: string;
  maintKeySecret?: string;
  maintModel?: string;
}

export interface ModelEntryPatch {
  model?: string;
  maxOutput?: number;
  contextWindow?: number;
  active?: boolean;
}

/** SQLite 的 1/0 和假库里的 true/false 都归一成布尔 */
function toBool(v: number | boolean): boolean {
  return v === 1 || v === true;
}

function rowToProvider(r: ProviderRow): ModelProvider {
  return {
    id: r.id,
    name: r.name,
    format: r.format as ModelFormat,
    baseUrl: r.base_url,
    keySecret: r.key_secret,
    maintKeySecret: r.maint_key_secret,
    maintModel: r.maint_model,
    created: r.created,
  };
}

function rowToEntry(r: EntryRow): ModelEntry {
  return {
    id: r.id,
    providerId: r.provider_id,
    model: r.model,
    maxOutput: Number(r.max_output),
    contextWindow: toContextWindow(r.context_window),
    active: toBool(r.active),
    created: r.created,
  };
}

function assertFormat(format: string): void {
  if (!MODEL_FORMATS.includes(format as ModelFormat))
    throw new Error(
      `不认识这种接口格式：${format}（只支持 anthropic / openai-chat / openai-responses）`,
    );
}

/**
 * max_output 只认正整数，其余一律回到 131072（128K）。
 * 主流可用的模型（DeepSeek V4 384K、GPT/Claude 128K 档）输出上限都在 128K 一带，
 * 默认给够 —— 思考链和大图源码合计吃输出预算，32K 会被「深度思考 + 大图」顶爆。
 * 厂商真有更低的硬上限时按它配到条目里（claude 8K-64K 档记得单独设）。
 */
export function toMaxOutput(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isInteger(n) && n > 0 ? n : 131072;
}

/**
 * context_window 只认正整数，其余一律回到 0（= 未设，用默认档）。
 * 「没设」是合法状态 —— 不是每家都报得上准数，报不上就别瞎填。
 */
export function toContextWindow(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isInteger(n) && n > 0 ? n : 0;
}

// ── 老单表（model_configs）→ 两级的惰性迁移 ─────────────────
// 老结构一条配置 = 一家供应商 + 一个模型，拆不开多模型。启动时瞄一眼：
// 老表还在就逐行搬成「一家供应商 + 一条模型条目」，条目 id 沿用老配置 id
// —— 深度思考槽位（state.deepConfigId）指着这些 id，换了形状不能断了指向。
// 搬完老表改名留底，下一次启动就当它不存在。

interface LegacyRow {
  id: string;
  name: string;
  format: string;
  base_url: string;
  key_secret: string;
  model: string;
  max_output: number;
  maint_key_secret: string;
  maint_model: string;
  active: number | boolean;
  created: string;
}

function migrateLegacyConfigs(sql: SqlTag): void {
  const tables = sql<{ name: string }>`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'model_configs'`;
  if (!tables.length) return;
  const legacy = sql<LegacyRow>`
    SELECT id, name, format, base_url, key_secret, model, max_output,
           maint_key_secret, maint_model, active, created FROM model_configs`;
  for (const row of legacy) {
    const providerId = crypto.randomUUID().slice(0, 8);
    sql`INSERT INTO model_providers (id, name, format, base_url, key_secret,
              maint_key_secret, maint_model, created)
        VALUES (${providerId}, ${row.name}, ${row.format}, ${row.base_url},
                ${row.key_secret}, ${row.maint_key_secret}, ${row.maint_model},
                ${row.created})`;
    sql`INSERT INTO model_entries (id, provider_id, model, max_output, context_window, active, created)
        VALUES (${row.id}, ${providerId}, ${row.model},
                ${toMaxOutput(row.max_output)}, ${0},
                ${toBool(row.active) ? 1 : 0}, ${row.created})`;
  }
  // 历史脏数据兜底：active 理论上最多一条，真有多条就留最早那笔
  const actives = sql<EntryRow>`
    SELECT id, provider_id, model, max_output, active, created
    FROM model_entries WHERE active = 1 ORDER BY created`;
  for (const row of actives.slice(1))
    sql`UPDATE model_entries SET active = 0 WHERE id = ${row.id}`;
  sql`ALTER TABLE model_configs RENAME TO model_configs_migrated`;
}

export function ensureModelCatalogSchema(sql: SqlTag): void {
  sql`CREATE TABLE IF NOT EXISTS model_providers (
       id               TEXT PRIMARY KEY,
       name             TEXT NOT NULL,
       format           TEXT NOT NULL,
       base_url         TEXT NOT NULL,
       key_secret       TEXT NOT NULL,
       maint_key_secret TEXT DEFAULT '',
       maint_model      TEXT DEFAULT '',
       created          TEXT
     )`;
  sql`CREATE TABLE IF NOT EXISTS model_entries (
       id          TEXT PRIMARY KEY,
       provider_id TEXT NOT NULL,
       model       TEXT NOT NULL,
       max_output  INTEGER DEFAULT 32768,
       active      INTEGER DEFAULT 0,
       created     TEXT
     )`;
  // 老表补列：create table if not exists 不会给已存在的表加列（0 = 未设，用默认档）
  try {
    sql`ALTER TABLE model_entries ADD COLUMN context_window INTEGER DEFAULT 0`;
  } catch {
    // 列已存在
  }
  migrateLegacyConfigs(sql);
}

// ── 供应商 ──────────────────────────────────────────────────

function providerById(sql: SqlTag, id: string): ModelProvider | null {
  const rows = sql<ProviderRow>`
    SELECT id, name, format, base_url, key_secret,
           maint_key_secret, maint_model, created
    FROM model_providers WHERE id = ${id}`;
  return rows.length ? rowToProvider(rows[0]) : null;
}

/** 全部供应商，旧的在前（created 序） */
export function listModelProviders(sql: SqlTag): ModelProvider[] {
  ensureModelCatalogSchema(sql);
  return sql<ProviderRow>`
    SELECT id, name, format, base_url, key_secret,
           maint_key_secret, maint_model, created
    FROM model_providers ORDER BY created`.map(rowToProvider);
}

/** 新建一家供应商。firstModel 给了就顺手挂上首个模型条目 */
export function createModelProvider(
  sql: SqlTag,
  input: ModelProviderInput,
): { provider: ModelProvider; entry: ModelEntry | null } {
  ensureModelCatalogSchema(sql);
  const name = (input.name || "").trim().slice(0, 60);
  const format = (input.format || "").trim();
  const baseUrl = (input.baseUrl || "").trim().slice(0, 300);
  const keySecret = (input.keySecret || "").trim().slice(0, 80);
  if (!name) throw new Error("供应商名称不能为空");
  if (!format) throw new Error("接口格式（format）不能为空");
  assertFormat(format);
  if (!baseUrl) throw new Error("接口地址（baseUrl）不能为空");
  if (!keySecret) throw new Error("存 key 的 secret 名（keySecret）不能为空");
  const provider: ModelProvider = {
    id: crypto.randomUUID().slice(0, 8),
    name,
    format: format as ModelFormat,
    baseUrl,
    keySecret,
    maintKeySecret: (input.maintKeySecret || "").trim().slice(0, 80),
    maintModel: (input.maintModel || "").trim().slice(0, 120),
    created: new Date().toISOString(),
  };
  sql`INSERT INTO model_providers (id, name, format, base_url, key_secret,
            maint_key_secret, maint_model, created)
      VALUES (${provider.id}, ${provider.name}, ${provider.format},
              ${provider.baseUrl}, ${provider.keySecret},
              ${provider.maintKeySecret}, ${provider.maintModel},
              ${provider.created})`;
  const firstModel = (input.firstModel || "").trim().slice(0, 120);
  const entry = firstModel
    ? createModelEntry(sql, {
        providerId: provider.id,
        model: firstModel,
        maxOutput: input.maxOutput,
      })
    : null;
  return { provider, entry };
}

export function updateModelProvider(
  sql: SqlTag,
  id: string,
  patch: ModelProviderPatch,
): ModelProvider | null {
  ensureModelCatalogSchema(sql);
  const cur = providerById(sql, id);
  if (!cur) return null;
  const name =
    patch.name === undefined
      ? cur.name
      : String(patch.name).trim().slice(0, 60);
  if (!name) throw new Error("供应商名称不能为空");
  let format: string = cur.format;
  if (patch.format !== undefined) {
    format = String(patch.format).trim();
    if (!format) throw new Error("接口格式（format）不能为空");
    assertFormat(format);
  }
  const baseUrl =
    patch.baseUrl === undefined
      ? cur.baseUrl
      : String(patch.baseUrl).trim().slice(0, 300);
  if (!baseUrl) throw new Error("接口地址（baseUrl）不能为空");
  const keySecret =
    patch.keySecret === undefined
      ? cur.keySecret
      : String(patch.keySecret).trim().slice(0, 80);
  if (!keySecret) throw new Error("存 key 的 secret 名（keySecret）不能为空");
  sql`UPDATE model_providers SET name = ${name}, format = ${format},
        base_url = ${baseUrl}, key_secret = ${keySecret},
        maint_key_secret = ${
          patch.maintKeySecret === undefined
            ? cur.maintKeySecret
            : String(patch.maintKeySecret).trim().slice(0, 80)
        },
        maint_model = ${
          patch.maintModel === undefined
            ? cur.maintModel
            : String(patch.maintModel).trim().slice(0, 120)
        }
      WHERE id = ${id}`;
  return providerById(sql, id);
}

/**
 * 删一家供应商，连同它名下的模型条目。
 * 名下有生效条目时，把剩下最新的另一家的条目顶上来 —— 目录永远要有一个可用项，
 * 否则「删一家旧供应商」这个无害动作会让整台机器退回 secrets 链，没人知道为什么。
 */
export function removeModelProvider(sql: SqlTag, id: string): boolean {
  ensureModelCatalogSchema(sql);
  const rows = sql<{ id: string }>`
    SELECT id FROM model_providers WHERE id = ${id}`;
  if (!rows.length) return false;
  const hadActive = sql<EntryRow>`
    SELECT id, provider_id, model, max_output, active, created
    FROM model_entries WHERE provider_id = ${id} AND active = 1`.some((r) =>
    toBool(r.active),
  );
  sql`DELETE FROM model_entries WHERE provider_id = ${id}`;
  sql`DELETE FROM model_providers WHERE id = ${id}`;
  if (hadActive) promoteLatestEntry(sql);
  return true;
}

// ── 模型条目 ────────────────────────────────────────────────

function entryById(sql: SqlTag, id: string): ModelEntry | null {
  const rows = sql<EntryRow>`
    SELECT id, provider_id, model, max_output, context_window, active, created
    FROM model_entries WHERE id = ${id}`;
  return rows.length ? rowToEntry(rows[0]) : null;
}

/** 全部模型条目，旧的在前。归属哪家看 providerId */
export function listModelEntries(sql: SqlTag): ModelEntry[] {
  ensureModelCatalogSchema(sql);
  return sql<EntryRow>`
    SELECT id, provider_id, model, max_output, context_window, active, created
    FROM model_entries ORDER BY created`.map(rowToEntry);
}

/** 生效中的那条。activateModelEntry 保证了最多只有一条，取最早那笔兜底。 */
export function getActiveModelEntry(sql: SqlTag): ModelEntry | null {
  ensureModelCatalogSchema(sql);
  const rows = sql<EntryRow>`
    SELECT id, provider_id, model, max_output, context_window, active, created
    FROM model_entries WHERE active = 1 ORDER BY created`;
  return rows.length ? rowToEntry(rows[0]) : null;
}

/** 删掉/换掉生效条目后的顶替：把剩下最新的那条顶上，目录不空转 */
function promoteLatestEntry(sql: SqlTag): void {
  const rest = listModelEntries(sql);
  if (rest.length) activateModelEntry(sql, rest[rest.length - 1].id);
}

/**
 * 新建一个模型条目。全库还没有生效条目时自动生效 ——
 * 空目录建出第一条却还得手动点「启用」，是段没人需要的「请先配置配置」死循环。
 */
export function createModelEntry(
  sql: SqlTag,
  input: {
    providerId: string;
    model: string;
    maxOutput?: number;
    contextWindow?: number;
  },
): ModelEntry {
  ensureModelCatalogSchema(sql);
  const model = (input.model || "").trim().slice(0, 120);
  if (!model) throw new Error("模型名（model）不能为空");
  const provider = providerById(sql, input.providerId);
  if (!provider) throw new Error("供应商不存在，先把这家供应商建好");
  const noActive = getActiveModelEntry(sql) === null;
  const row: EntryRow = {
    id: crypto.randomUUID().slice(0, 8),
    provider_id: input.providerId,
    model,
    max_output: toMaxOutput(input.maxOutput),
    context_window: toContextWindow(input.contextWindow),
    active: noActive ? 1 : 0,
    created: new Date().toISOString(),
  };
  sql`INSERT INTO model_entries (id, provider_id, model, max_output, context_window, active, created)
      VALUES (${row.id}, ${row.provider_id}, ${row.model}, ${row.max_output},
              ${row.context_window}, ${row.active}, ${row.created})`;
  return rowToEntry(row);
}

export function updateModelEntry(
  sql: SqlTag,
  id: string,
  patch: ModelEntryPatch,
): ModelEntry | null {
  ensureModelCatalogSchema(sql);
  const cur = entryById(sql, id);
  if (!cur) return null;
  if (patch.model !== undefined) {
    const model = String(patch.model).trim().slice(0, 120);
    if (!model) throw new Error("模型名（model）不能为空");
  }
  const next: ModelEntry = {
    ...cur,
    model:
      patch.model === undefined
        ? cur.model
        : String(patch.model).trim().slice(0, 120),
    maxOutput:
      patch.maxOutput === undefined
        ? cur.maxOutput
        : toMaxOutput(patch.maxOutput),
    contextWindow:
      patch.contextWindow === undefined
        ? cur.contextWindow
        : toContextWindow(patch.contextWindow),
    active: patch.active === undefined ? cur.active : patch.active,
  };
  sql`UPDATE model_entries SET model = ${next.model},
        max_output = ${next.maxOutput}, context_window = ${next.contextWindow},
        active = ${next.active ? 1 : 0}
      WHERE id = ${id}`;
  return entryById(sql, id);
}

export function removeModelEntry(sql: SqlTag, id: string): boolean {
  ensureModelCatalogSchema(sql);
  const rows = sql<{ active: number | boolean }>`
    SELECT active FROM model_entries WHERE id = ${id}`;
  if (!rows.length) return false;
  const wasActive = toBool(rows[0].active);
  sql`DELETE FROM model_entries WHERE id = ${id}`;
  if (wasActive) promoteLatestEntry(sql);
  return true;
}

/**
 * 点名生效，先全清再置一。两条 UPDATE 顺序执行即可 ——
 * DO 单线程处理请求，这两句之间不会插进别的写入，等价于事务。
 */
export function activateModelEntry(sql: SqlTag, id: string): ModelEntry | null {
  ensureModelCatalogSchema(sql);
  if (!entryById(sql, id)) return null;
  sql`UPDATE model_entries SET active = 0`;
  sql`UPDATE model_entries SET active = 1 WHERE id = ${id}`;
  return entryById(sql, id);
}

/** 生效中的一组：条目 + 它挂在哪家底下。没有生效条目或供应商被删干净了返回 null */
export function getActiveCatalog(sql: SqlTag): ActiveCatalog | null {
  ensureModelCatalogSchema(sql);
  const entry = getActiveModelEntry(sql);
  if (!entry) return null;
  const provider = providerById(sql, entry.providerId);
  return provider ? { entry, provider } : null;
}

/** 按 id 取一组（深度思考槽位解析用）。条目或它家的供应商没了都算失效 */
export function getCatalogById(sql: SqlTag, id: string): ActiveCatalog | null {
  ensureModelCatalogSchema(sql);
  const entry = entryById(sql, id);
  if (!entry) return null;
  const provider = providerById(sql, entry.providerId);
  return provider ? { entry, provider } : null;
}
