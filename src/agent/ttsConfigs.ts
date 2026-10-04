// tts_configs：读音（TTS）配置目录。
//
// 以前可选的嗓子是一份写死的清单（三家内置供应商 + 各自几个音色），
// 换音色、换 key、走转发站都得改代码。这张表把「这台机器用哪家读音服务」变成数据：
// 管理员在面板上按顺序添几条配置，**顺序就是优先级** —— 念的时候
// 从头找第一条 key 配得上的用，没有「生效中」的概念。
//
// 表只建在主人那间；来客那间隔着 DO 读整张表（合成走主人那间也有好处：
// key 的用量都记在一本账上）。同样红线：keySecret 存 secret 变量名，不落 key 本体。

import type { SqlTag } from "./state";

/** 三种读音协议，对应 tts.ts 里三条合成路径 */
export type TtsProtocol = "mimo-chat" | "doubao" | "glm-speech";

const TTS_PROTOCOLS: TtsProtocol[] = [
  "mimo-chat",
  "doubao",
  "glm-speech",
];

export interface TtsConfig {
  id: string;
  name: string;
  protocol: TtsProtocol;
  /** 空 = 用该协议的官方默认地址（第三方转发站才需要填） */
  baseUrl: string;
  /** Worker secret 的变量名（如 "MIMO_API_KEY"），不是 key 本体 */
  keySecret: string;
  /** 空 = 该协议的默认模型名 */
  model: string;
  /** 音色 / speaker；空 = 各家默认 */
  voice: string;
  /** 语气指令，只有 mimo-chat 认；空 = 原默认那句 */
  style: string;
}

interface TtsRow {
  id: string;
  name: string;
  protocol: string;
  base_url: string;
  key_secret: string;
  model: string;
  voice: string;
  style: string;
  active: number | boolean;
  created: string;
}

export interface TtsConfigInput {
  name: string;
  protocol: string;
  baseUrl?: string;
  keySecret: string;
  model?: string;
  voice?: string;
  style?: string;
}

/** 改配置的入参：字段缺省（undefined）不动 */
export interface TtsConfigPatch {
  name?: string;
  protocol?: string;
  baseUrl?: string;
  keySecret?: string;
  model?: string;
  voice?: string;
  style?: string;
}

export function ensureTtsConfigsSchema(sql: SqlTag): void {
  sql`CREATE TABLE IF NOT EXISTS tts_configs (
       id         TEXT PRIMARY KEY,
       name       TEXT NOT NULL,
       protocol   TEXT NOT NULL,
       base_url   TEXT DEFAULT '',
       key_secret TEXT NOT NULL,
       model      TEXT DEFAULT '',
       voice      TEXT DEFAULT '',
       style      TEXT DEFAULT '',
       active     INTEGER DEFAULT 0,
       created    TEXT
     )`;
}

function rowToConfig(r: TtsRow): TtsConfig {
  return {
    id: r.id,
    name: r.name,
    protocol: r.protocol as TtsProtocol,
    baseUrl: r.base_url,
    keySecret: r.key_secret,
    model: r.model,
    voice: r.voice,
    style: r.style,
  };
}

function assertProtocol(protocol: string): void {
  if (!TTS_PROTOCOLS.includes(protocol as TtsProtocol))
    throw new Error(
      `不认识这种读音协议：${protocol}（只支持 mimo-chat / doubao / glm-speech）`,
    );
}

/** 全部配置，created 序 —— 前面那条优先级高，合成时从头找第一条 key 可用的 */
export function listTtsConfigs(sql: SqlTag): TtsConfig[] {
  ensureTtsConfigsSchema(sql);
  return sql<TtsRow>`
    SELECT id, name, protocol, base_url, key_secret, model, voice, style,
           active, created
    FROM tts_configs ORDER BY created`.map(rowToConfig);
}

function configById(sql: SqlTag, id: string): TtsConfig | null {
  const rows = sql<TtsRow>`
    SELECT id, name, protocol, base_url, key_secret, model, voice, style,
           active, created
    FROM tts_configs WHERE id = ${id}`;
  return rows.length ? rowToConfig(rows[0]) : null;
}

export function createTtsConfig(sql: SqlTag, input: TtsConfigInput): TtsConfig {
  ensureTtsConfigsSchema(sql);
  const name = (input.name || "").trim().slice(0, 60);
  const protocol = (input.protocol || "").trim();
  const keySecret = (input.keySecret || "").trim().slice(0, 80);
  if (!name) throw new Error("读音配置的名称不能为空");
  if (!protocol) throw new Error("读音协议（protocol）不能为空");
  assertProtocol(protocol);
  if (!keySecret) throw new Error("存 key 的 secret 名（keySecret）不能为空");
  const row: TtsRow = {
    id: crypto.randomUUID().slice(0, 8),
    name,
    protocol,
    base_url: (input.baseUrl || "").trim().slice(0, 300),
    key_secret: keySecret,
    model: (input.model || "").trim().slice(0, 120),
    voice: (input.voice || "").trim().slice(0, 120),
    style: (input.style || "").trim().slice(0, 300),
    active: 0,
    created: new Date().toISOString(),
  };
  sql`INSERT INTO tts_configs (id, name, protocol, base_url, key_secret,
            model, voice, style, active, created)
      VALUES (${row.id}, ${row.name}, ${row.protocol}, ${row.base_url},
              ${row.key_secret}, ${row.model}, ${row.voice}, ${row.style},
              ${row.active}, ${row.created})`;
  return rowToConfig(row);
}

export function updateTtsConfig(
  sql: SqlTag,
  id: string,
  patch: TtsConfigPatch,
): TtsConfig | null {
  ensureTtsConfigsSchema(sql);
  const cur = configById(sql, id);
  if (!cur) return null;
  const name =
    patch.name === undefined
      ? cur.name
      : String(patch.name).trim().slice(0, 60);
  if (!name) throw new Error("读音配置的名称不能为空");
  let protocol: string = cur.protocol;
  if (patch.protocol !== undefined) {
    protocol = String(patch.protocol).trim();
    if (!protocol) throw new Error("读音协议（protocol）不能为空");
    assertProtocol(protocol);
  }
  const keySecret =
    patch.keySecret === undefined
      ? cur.keySecret
      : String(patch.keySecret).trim().slice(0, 80);
  if (!keySecret) throw new Error("存 key 的 secret 名（keySecret）不能为空");
  const opt = (v: string | undefined, curV: string, max: number) =>
    v === undefined ? curV : String(v).trim().slice(0, max);
  const row: TtsRow = {
    id: cur.id,
    name,
    protocol,
    base_url: opt(patch.baseUrl, cur.baseUrl, 300),
    key_secret: keySecret,
    model: opt(patch.model, cur.model, 120),
    voice: opt(patch.voice, cur.voice, 120),
    style: opt(patch.style, cur.style, 300),
    active: 0,
    created: "",
  };
  sql`UPDATE tts_configs SET name = ${row.name}, protocol = ${row.protocol},
        base_url = ${row.base_url}, key_secret = ${row.key_secret},
        model = ${row.model}, voice = ${row.voice}, style = ${row.style}
      WHERE id = ${id}`;
  return configById(sql, id);
}

export function removeTtsConfig(sql: SqlTag, id: string): boolean {
  ensureTtsConfigsSchema(sql);
  const rows = sql<{ id: string }>`SELECT id FROM tts_configs WHERE id = ${id}`;
  if (!rows.length) return false;
  sql`DELETE FROM tts_configs WHERE id = ${id}`;
  return true;
}
