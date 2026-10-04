// draw_configs：绘图（文生图）配置目录。
//
// 以前出图的三条路（Workers AI 的 FLUX / 硅基流动 / 智谱）端点、模型名、降级链
// 全是写死的常量 —— 换厂商、换模型、接口改版都得改代码重新部署，面板上无解。
// 这张表把「每一档用哪家、哪个模型、哪把钥匙」变成数据，和 model_configs、
// tts_configs 同一套思路。三档（fast 主力 / high 高质量 / fallback 兜底）
// 各一条，tier 就是主键，天然唯一。
//
// 表只建在主人那间；来客那间画图时隔着 DO 读三档配置（TTS 清单同一套理由，
// 不带守卫 —— 里面本来就没有 key 本体）。红线同前：keySecret 存 secret 的
// 变量名，不落 key 本体。
//
// workers-ai 格式走 Workers AI 绑定（env.AI），计费在平台的 neurons 里，
// 不烧外部 key —— 所以那档的 keySecret 留空是合法状态。

import type { SqlTag } from "./state";

/** 三种出图协议，对应 draw.ts 里的调用路径 */
export type DrawFormat = "workers-ai" | "siliconflow" | "zhipu";

const DRAW_FORMATS: DrawFormat[] = [
  "workers-ai",
  "siliconflow",
  "zhipu",
];

/** 绘图的三个档位。tier 就是配置的主键 —— 每档同时只有一条在生效 */
export type DrawTier = "fast" | "high" | "fallback";

const DRAW_TIERS: DrawTier[] = ["fast", "high", "fallback"];

/** 一档的完整配置。降级时 models 按顺序逐个试，谁出图用谁 */
export interface DrawConfig {
  tier: DrawTier;
  format: DrawFormat;
  /** 出图端点；workers-ai 格式不用（走 AI 绑定） */
  endpoint: string;
  /** 模型名列表，降级有序 */
  models: string[];
  /** Worker secret 的变量名（如 "SILICONFLOW_API_KEY"）；workers-ai 档留空 */
  keySecret: string;
  /** 结果标注里的供应商名（「FLUX.2 klein」「硅基流动」），和模型名一起画在 meta 里 */
  label: string;
}

/** 内置默认：就是配置化之前写死在 draw.ts 里的那三条，行为完全兼容 */
export const DEFAULT_DRAW_CONFIGS: Record<DrawTier, DrawConfig> = {
  fast: {
    tier: "fast",
    format: "workers-ai",
    endpoint: "",
    models: ["@cf/black-forest-labs/flux-2-klein-4b"],
    keySecret: "",
    label: "FLUX.2 klein",
  },
  high: {
    tier: "high",
    format: "siliconflow",
    endpoint: "https://api.siliconflow.cn/v1/images/generations",
    models: ["Tongyi-MAI/Z-Image-Turbo", "Kwai-Kolors/Kolors"],
    keySecret: "SILICONFLOW_API_KEY",
    label: "硅基流动",
  },
  fallback: {
    tier: "fallback",
    format: "zhipu",
    endpoint: "https://open.bigmodel.cn/api/paas/v4/images/generations",
    models: ["cogview-4-250304", "cogview-3-flash"],
    keySecret: "ZHIPU_KEY",
    label: "智谱",
  },
};

export type DrawTierConfigs = Record<DrawTier, DrawConfig>;

interface DrawRow {
  tier: string;
  format: string;
  endpoint: string;
  models: string;
  key_secret: string;
  label: string;
}

export interface DrawConfigPatch {
  format?: string;
  endpoint?: string;
  models?: string[];
  keySecret?: string;
  label?: string;
}

function assertFormat(format: string): void {
  if (!DRAW_FORMATS.includes(format as DrawFormat))
    throw new Error(
      `不认识这种出图协议：${format}（只支持 workers-ai / siliconflow / zhipu）`,
    );
}

function rowToConfig(r: DrawRow): DrawConfig {
  return {
    tier: r.tier as DrawTier,
    format: r.format as DrawFormat,
    endpoint: r.endpoint,
    models: r.models
      .split(",")
      .map((m) => m.trim())
      .filter(Boolean),
    keySecret: r.key_secret,
    label: r.label,
  };
}

function insertDefault(sql: SqlTag, cfg: DrawConfig): void {
  sql`INSERT INTO draw_configs (tier, format, endpoint, models, key_secret, label)
      VALUES (${cfg.tier}, ${cfg.format}, ${cfg.endpoint},
              ${cfg.models.join(",")}, ${cfg.keySecret}, ${cfg.label})`;
}

export function ensureDrawConfigsSchema(sql: SqlTag): void {
  sql`CREATE TABLE IF NOT EXISTS draw_configs (
       tier       TEXT PRIMARY KEY,
       format     TEXT NOT NULL,
       endpoint   TEXT NOT NULL DEFAULT '',
       models     TEXT NOT NULL DEFAULT '',
       key_secret TEXT NOT NULL DEFAULT '',
       label      TEXT NOT NULL DEFAULT ''
     )`;
  // 表空就种入内置默认：没配置过的机器，行为和配置化之前一字不差；
  // 种过之后这里不再动 —— 管理员改过的档位不能被默认值洗回去
  const count = sql<{ n: number }>`SELECT COUNT(*) AS n FROM draw_configs`;
  if (Number(count[0]?.n ?? 0) > 0) return;
  for (const tier of DRAW_TIERS) insertDefault(sql, DEFAULT_DRAW_CONFIGS[tier]);
}

/** 三档配置全量。哪档的行缺失或格式不认识，回落那档的内置默认 */
export function listDrawConfigs(sql: SqlTag): DrawConfig[] {
  ensureDrawConfigsSchema(sql);
  const rows = sql<DrawRow>`SELECT tier, format, endpoint, models,
         key_secret, label FROM draw_configs`;
  const byTier = new Map(rows.map((r) => [r.tier, r]));
  return DRAW_TIERS.map((tier) => {
    const row = byTier.get(tier);
    if (!row || !DRAW_FORMATS.includes(row.format as DrawFormat))
      return DEFAULT_DRAW_CONFIGS[tier];
    return rowToConfig(row);
  });
}

/** 三档按 tier 索引 —— draw 工具运行时吃这个形状 */
export function resolveDrawTiers(sql: SqlTag): DrawTierConfigs {
  return Object.fromEntries(
    listDrawConfigs(sql).map((c) => [c.tier, c]),
  ) as DrawTierConfigs;
}

/** 改一档。字段缺省（undefined）不动；models 传数组，存库时折成逗号串 */
export function updateDrawConfig(
  sql: SqlTag,
  tier: string,
  patch: DrawConfigPatch,
): DrawConfig | null {
  ensureDrawConfigsSchema(sql);
  if (!DRAW_TIERS.includes(tier as DrawTier)) return null;
  const cur = listDrawConfigs(sql).find((c) => c.tier === tier)!;
  let format = cur.format;
  if (patch.format !== undefined) {
    format = String(patch.format).trim() as DrawFormat;
    assertFormat(format);
  }
  const models =
    patch.models === undefined
      ? cur.models
      : patch.models.map((m) => String(m).trim()).filter(Boolean);
  if (!models.length) throw new Error("至少要留一个模型名");
  const opt = (v: string | undefined, curV: string, max: number) =>
    v === undefined ? curV : String(v).trim().slice(0, max);
  const endpoint = opt(patch.endpoint, cur.endpoint, 300);
  const keySecret = opt(patch.keySecret, cur.keySecret, 80);
  const label = opt(patch.label, cur.label, 60);
  sql`UPDATE draw_configs SET format = ${format}, endpoint = ${endpoint},
        models = ${models.join(",")}, key_secret = ${keySecret}, label = ${label}
      WHERE tier = ${tier}`;
  return listDrawConfigs(sql).find((c) => c.tier === tier)!;
}
