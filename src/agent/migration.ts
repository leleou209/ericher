// 一次性数据迁移：旧 state.longMemory → memories 表，并全量重建 Vectorize 向量。
//
// 分两步的原因：向量重建要逐条跑 bge-m3 embedding，几百条远超 DO 单次 invocation
// 的 CPU 预算（约 30s），必须切块 + schedule 交还控制权续跑（见 runtime.ts D4）。
//
// 幂等性：insertMemory 走 INSERT OR REPLACE，同一 id 重复导入结果一致；
// migrated_v2 标记在全部落库之后才写，中途失败可安全重跑。

import {
  countMemories,
  insertMemory,
  listMemories,
  pageMemories,
  upsertVector,
} from "./memory";
import { registerChunkedTask, runChunked, type ChunkStep } from "./runtime";
import type { CoworkAgent } from "./cowork";
import type { MemEntry, SqlTag } from "./state";

const MIGRATED_FLAG = "migrated_v2";
const VECTORS_FLAG = "vectors_rebuilt_v2";
const REBUILD_TASK = "rebuildVectors";
/** 每个 CPU 块最多处理多少条记忆 */
const REBUILD_BATCH = 25;

export interface MigrationReport {
  /** 已迁移过则不再重复导入 */
  skipped: boolean;
  imported: number;
  total: number;
  /** 是否已启动向量重建（本地 dev 无 Vectorize 时为 false） */
  rebuildStarted: boolean;
  flags: Record<string, string>;
}

function ensureMigrationSchema(sql: SqlTag): void {
  sql`CREATE TABLE IF NOT EXISTS migration_flags (
       name    TEXT PRIMARY KEY,
       value   TEXT NOT NULL,
       updated TEXT NOT NULL
     )`;
}

function readFlag(sql: SqlTag, name: string): string | null {
  const rows = sql<{
    value: string;
  }>`SELECT value FROM migration_flags WHERE name = ${name}`;
  return rows[0]?.value ?? null;
}

function writeFlag(sql: SqlTag, name: string, value: string): void {
  sql`INSERT INTO migration_flags (name, value, updated) VALUES (${name}, ${value}, ${new Date().toISOString()})
     ON CONFLICT(name) DO UPDATE SET value = excluded.value, updated = excluded.updated`;
}

function migrationFlags(sql: SqlTag): Record<string, string> {
  const rows = sql<{
    name: string;
    value: string;
  }>`SELECT name, value FROM migration_flags`;
  return Object.fromEntries(rows.map((r) => [r.name, r.value]));
}

/** 旧 state blob 里的 longMemory 数组（类型未在 ChatState 中声明，只能这样读） */
function legacyMemories(agent: CoworkAgent): MemEntry[] {
  const raw = (agent.state as unknown as { longMemory?: unknown }).longMemory;
  return Array.isArray(raw) ? (raw as MemEntry[]) : [];
}

// ── 向量重建（分块续跑） ───────────────────────────────

/** 游标 = 已处理条数。按 id 排序分页，避免重建期间权重变动导致游标错位。 */
function rebuildStep(agent: CoworkAgent): ChunkStep {
  return async (cursor) => {
    const batch = pageMemories(agent.db, cursor, REBUILD_BATCH);
    if (!batch.length) {
      // 游标正好落在末尾（总数为 0，或正好是批大小的整数倍）：没有
      // 「不满一批」可依，完成标记也得在这儿写 —— 不然重建永远差最后
      // 一趟，每次启动都从头再来一遍
      writeFlag(agent.db, VECTORS_FLAG, new Date().toISOString());
      return -1;
    }

    for (const e of batch) {
      try {
        const ok = await upsertVector(agent.appEnv, {
          id: e.id,
          content: e.content,
          type: e.type,
          shelf: e.shelf,
          tags: e.tags,
        });
        if (!ok) throw new Error("embedding 或 Vectorize 不可用");
      } catch (err) {
        // 任一条失败就中止本轮且不写完成标记：下次调用从头重试。
        // upsert 幂等，重试安全；否则失败一次就会被永久标记为「已重建」。
        console.warn(
          `[migration] 向量重建中止于 ${e.id}: ${(err as Error).message}`,
        );
        return -1;
      }
    }

    if (batch.length < REBUILD_BATCH) {
      writeFlag(agent.db, VECTORS_FLAG, new Date().toISOString());
      return -1;
    }
    return cursor + batch.length;
  };
}

/** onStart 调用：建表 + 重新注册分步任务（DO 驱逐后内存态注册表会丢）。 */
export function installMigration(agent: CoworkAgent): void {
  ensureMigrationSchema(agent.db);
  registerChunkedTask(agent, REBUILD_TASK, rebuildStep(agent));
}

// ── 迁移入口 ───────────────────────────────────────────

export async function runMigration(
  agent: CoworkAgent,
): Promise<MigrationReport> {
  ensureMigrationSchema(agent.db);

  if (readFlag(agent.db, MIGRATED_FLAG)) {
    // 数据已迁完，但向量重建可能因中途失败 / DO 驱逐而没跑完 —— 续跑（游标在 task_cursor 里）
    const rebuildStarted = await startRebuild(agent);
    return {
      skipped: true,
      imported: 0,
      total: countMemories(agent.db),
      rebuildStarted,
      flags: migrationFlags(agent.db),
    };
  }

  let imported = 0;
  // 若 DO 在此之前已唤醒过，onConnect 的播种会先写入同内容的种子记忆（id 不同），
  // 按内容去重可让两种执行顺序收敛到同一结果。
  // 去重也要算上已作废的：一条被作废的话如果重新当新的导进来，等于自己把自己推翻过一次又忘了
  const seen = new Set(
    listMemories(agent.db, undefined, 1000, { includeSuperseded: true }).map(
      (e) => e.content,
    ),
  );
  for (const m of legacyMemories(agent)) {
    if (!m || typeof m.content !== "string" || !m.content.trim()) continue;
    if (seen.has(m.content)) continue;
    seen.add(m.content);
    insertMemory(agent.db, {
      id: m.id,
      date: m.date,
      type: m.type || "fact",
      content: m.content,
      shelf: m.shelf,
      tags: m.tags,
      weight: m.weight,
      accessed: m.accessed,
    });
    imported++;
  }

  const total = countMemories(agent.db);
  // 落库完成后才置标记并摘掉旧 blob
  writeFlag(agent.db, MIGRATED_FLAG, new Date().toISOString());
  agent.dropLegacyLongMemory();

  const rebuildStarted = await startRebuild(agent);
  return {
    skipped: false,
    imported,
    total,
    rebuildStarted,
    flags: migrationFlags(agent.db),
  };
}

/**
 * 启动（或从游标续跑）向量重建。全部跑完才写 vectors_rebuilt_v2，
 * 因此中途失败后再次调用本函数即可继续，不会重复劳动。
 */
async function startRebuild(agent: CoworkAgent): Promise<boolean> {
  if (readFlag(agent.db, VECTORS_FLAG)) return false;
  // 本地 dev 没有可用的 Vectorize / AI，跳过而不是无限重试
  if (!agent.appEnv.AI || !agent.appEnv.VECTORIZE_INDEX) return false;
  registerChunkedTask(agent, REBUILD_TASK, rebuildStep(agent));
  await runChunked(agent, REBUILD_TASK);
  return true;
}
