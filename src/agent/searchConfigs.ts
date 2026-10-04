// search_config：联网搜索的通道配置。
//
// 以前搜索只有一条写死的路：env 里配了 TAVILY_API_KEY 就走 Tavily，
// 没配就退 DuckDuckGo 免费通道 —— 想换一家（Brave 之类）得改代码重新部署。
// 这张表把「搜索走哪家、用哪把钥匙」变成数据，和 draw_configs 同一套思路。
// 搜索只有一条主通道，单行表，id 恒为 'main'。
//
// 表只建在主人那间；来客房搜索时隔着 DO RPC 读配置（getSearchConfig），
// 取不到回落内置默认。红线同前：keySecret 存 secret 的变量名，不落 key 本体。

import type { SqlTag } from "./state";

/** 两种搜索协议，对应 search.ts 里的调用路径 */
export type SearchFormat = "tavily" | "brave";

const SEARCH_FORMATS: SearchFormat[] = ["tavily", "brave"];

export interface SearchConfig {
  format: SearchFormat;
  /** Worker secret 的变量名（如 "TAVILY_API_KEY"）；空串 = 没配 key，走免费通道 */
  keySecret: string;
}

/** 内置默认：就是配置化之前写死的那套（env.TAVILY_API_KEY），行为完全兼容 */
export const DEFAULT_SEARCH_CONFIG: SearchConfig = {
  format: "tavily",
  keySecret: "TAVILY_API_KEY",
};

interface SearchRow {
  format: string;
  key_secret: string;
}

export function ensureSearchConfigSchema(sql: SqlTag): void {
  sql`CREATE TABLE IF NOT EXISTS search_config (
       id         TEXT PRIMARY KEY,
       format     TEXT NOT NULL,
       key_secret TEXT NOT NULL DEFAULT ''
     )`;
  // 表空就种入内置默认：没配置过的机器，行为和配置化之前一字不差；
  // 种过之后这里不再动 —— 管理员改过的通道不能被默认值洗回去
  const count = sql<{ n: number }>`SELECT COUNT(*) AS n FROM search_config`;
  if (Number(count[0]?.n ?? 0) > 0) return;
  sql`INSERT INTO search_config (id, format, key_secret)
      VALUES ('main', ${DEFAULT_SEARCH_CONFIG.format}, ${DEFAULT_SEARCH_CONFIG.keySecret})`;
}

/** 当前生效的搜索配置。行缺失或格式不认识，回落内置默认 */
export function getSearchConfig(sql: SqlTag): SearchConfig {
  ensureSearchConfigSchema(sql);
  const rows = sql<SearchRow>`
    SELECT format, key_secret FROM search_config WHERE id = 'main'`;
  const r = rows[0];
  if (!r || !SEARCH_FORMATS.includes(r.format as SearchFormat))
    return DEFAULT_SEARCH_CONFIG;
  return { format: r.format as SearchFormat, keySecret: r.key_secret };
}

/** 改配置。字段缺省（undefined）不动；keySecret 存变量名，key 本体永不入库 */
export function updateSearchConfig(
  sql: SqlTag,
  patch: { format?: string; keySecret?: string },
): SearchConfig {
  ensureSearchConfigSchema(sql);
  const cur = getSearchConfig(sql);
  const format =
    patch.format === undefined
      ? cur.format
      : (String(patch.format).trim() as SearchFormat);
  if (!SEARCH_FORMATS.includes(format))
    throw new Error(`不认识这种搜索通道：${format}（只支持 tavily / brave）`);
  const keySecret =
    patch.keySecret === undefined
      ? cur.keySecret
      : String(patch.keySecret).trim().slice(0, 80);
  sql`UPDATE search_config SET format = ${format}, key_secret = ${keySecret}
      WHERE id = 'main'`;
  return getSearchConfig(sql);
}
