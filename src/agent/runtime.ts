// 运行时：心跳、夜间维护、长任务分步续跑。
//
// 关键约束（D4）：keepAliveWhile 只防「空闲驱逐」，不延长 CPU 上限。
// DO 单次 invocation 的 CPU 上限约 30s，所以长任务必须切块，
// 块间用 schedule() 交还控制权再续跑，游标落 SQLite。

import type { UIMessage } from "ai";
import { countMemories, deleteMemory, deleteVector } from "./memory";
import type { CoworkAgent } from "./cowork";
import type { SqlTag } from "./state";

const HEARTBEAT_SECONDS = 3600;
const NIGHTLY_CRON = "0 4 * * *";
/** 单个 CPU 块的时间预算，留出余量 */
const CHUNK_BUDGET_MS = 25_000;
/** memories 表超过这个条数就开始裁剪最不重要的 */
const MEMORY_SOFT_CAP = 800;
/**
 * 近期活跃的保护窗：最近这么久里学到过、或被检索用上过的，先不裁。
 * 权重是会衰减的尺子，不是对错的判决 —— 一条刚学到还没被用上的记忆
 * 权重照样低，按权重裁等于专挑新记忆下手。
 */
const PRUNE_PROTECT_MS = 30 * 24 * 60 * 60 * 1000;

export function installRuntime(agent: CoworkAgent): void {
  ensureRuntimeSchema(agent.db);
  // 来客那间不排夜间整理：它没有记忆库也没有经验库，整理只会白烧一次模型调用
  if (!agent.isOwnerRoom) return;
  // scheduleEvery 与 cron 形式的 schedule 都默认幂等，onStart 每次唤醒重复调用是安全的
  void agent.scheduleEvery(HEARTBEAT_SECONDS, "heartbeat").catch(() => {});
  void agent.schedule(NIGHTLY_CRON, "nightlyMaintenance").catch(() => {});
}

function ensureRuntimeSchema(sql: SqlTag): void {
  sql`CREATE TABLE IF NOT EXISTS task_cursor (
       id      TEXT PRIMARY KEY,
       cursor  INTEGER NOT NULL DEFAULT 0,
       updated TEXT NOT NULL
     )`;
}

// ── 心跳 ───────────────────────────────────────────────

/** 每小时醒来做一次轻量自检：记忆表超限时按权重裁剪。 */
export async function runHeartbeat(
  agent: CoworkAgent,
  env: Env,
): Promise<void> {
  await agent.keepAliveWhile(async () => {
    await pruneMemories(agent, env);
  });
}

/**
 * 超过软上限时裁掉最不重要的记忆，返回被裁条目的摘要（空数组 = 没裁）。
 *
 * 裁剪有白名单，不是按权重一刀切：
 *   绝密（topsecret）—— 管理员亲手钉的，自动裁剪无权碰它；
 *   书册（book）—— 成体系的文章，权重再低也是多少万字的心血；
 *   近期活跃 —— 最近一个月里学到过、或被检索用上过的。
 * 会话记忆照旧垫底再裁：那些是「某个晚上聊过什么」的账，每一条都绑着一场对话。
 *
 * 删走 deleteMemory（正门）：挂在被删条目身上的疑问要一并清掉，
 * 直接 DELETE 会留下指向空 id 的悬账。候选不足时宁缺勿删 —— 超限一会儿不致命，
 * 误删一条不该删的不可挽回。
 */
async function pruneMemories(agent: CoworkAgent, env: Env): Promise<string[]> {
  const total = countMemories(agent.db);
  if (total <= MEMORY_SOFT_CAP) return [];
  const excess = total - MEMORY_SOFT_CAP;
  const protectCut = Date.now() - PRUNE_PROTECT_MS;
  const learnedCut = new Date(protectCut).toISOString();
  const rows = agent.db<{ id: string; content: string }>`
    SELECT id, content FROM memories
    WHERE sensitivity <> 'topsecret'
      AND type <> 'book'
      AND learned < ${learnedCut}
      AND last_accessed_at < ${protectCut}
    ORDER BY (session_id <> '') ASC, weight ASC, last_accessed_at ASC LIMIT ${excess}`;
  const dropped: string[] = [];
  for (const r of rows) {
    const entry = deleteMemory(agent.db, r.id);
    await deleteVector(env, r.id).catch(() => {});
    if (entry) dropped.push(entry.content.slice(0, 24));
  }
  return dropped;
}

// ── 夜间维护 ───────────────────────────────────────────

/** 凌晨整理：压缩对话、萃取洞察、裁剪记忆，最后把结论推进会话（不触发 LLM）。 */
export async function runNightlyMaintenance(
  agent: CoworkAgent,
  env: Env,
): Promise<void> {
  await agent.keepAliveWhile(async () => {
    const before = countMemories(agent.db);
    // 走闸门那一版：正好有一场回想在跑时，让回想先跑完（那是他刚聊完的那一段，
    // 比这场定时整理更近）。整理今晚不做，明晚还有 —— 撞着跑才会白烧两次模型。
    const report = await agent.organizeGuarded();
    const pruned = await pruneMemories(agent, env);
    const after = countMemories(agent.db);

    const worthTelling = after > before || pruned.length > 0;
    if (!worthTelling) return;

    const lines = [
      report
        ? `🌙 夜间整理完成：${report}`
        : "🌙 夜间整理这次让位给了回想，没跑。",
    ];
    if (pruned.length) {
      // 裁了什么要让管理员看得见：静默消失的记忆比没记忆更糟 —— 他不知道该补记什么
      const shown = pruned
        .slice(0, 5)
        .map((s) => `「${s}…」`)
        .join(" ");
      lines.push(
        `裁了 ${pruned.length} 条低权重记忆（当前共 ${after} 条）：${shown}${pruned.length > 5 ? " 等" : ""}`,
      );
    }

    // 定时任务推送必须用 persistMessages（只落库 + 广播），
    // 用 saveMessages 会白烧一整轮 LLM 调用。
    const msg: UIMessage = {
      id: crypto.randomUUID(),
      role: "assistant",
      parts: [{ type: "text", text: lines.join("\n") }],
    };
    await agent.persistMessages([...agent.messages, msg]);
  });
}

// ── 长任务分步续跑 ─────────────────────────────────────

/** 每一步接收游标、返回新游标。必须幂等：同一游标重复执行结果应一致。 */
export type ChunkStep = (cursor: number) => Promise<number>;

// 具名任务注册表。内存态，DO 驱逐后由 onStart 重新注册，所以任务定义必须幂等。
// 键必须带上房间名：一个 isolate 里住着好几间屋（主人和来客的 DO 实例），
// 模块级 Map 是大家共用的 —— 只按任务名注册的话，B 屋 onStart 一注册就把
// A 屋的闭包顶掉，A 屋排下的续跑会拿着 B 屋的闭包读写 B 屋的库，数据串门。
const registry = new Map<string, ChunkStep>();

const taskKey = (agent: CoworkAgent, id: string) => `${agent.name}::${id}`;

export function registerChunkedTask(
  agent: CoworkAgent,
  id: string,
  step: ChunkStep,
): void {
  registry.set(taskKey(agent, id), step);
}

function readCursor(sql: SqlTag, taskId: string): number {
  const rows = sql<{
    cursor: number;
  }>`SELECT cursor FROM task_cursor WHERE id = ${taskId}`;
  return rows[0]?.cursor ?? 0;
}

function writeCursor(sql: SqlTag, taskId: string, cursor: number): void {
  sql`INSERT INTO task_cursor (id, cursor, updated) VALUES (${taskId}, ${cursor}, ${new Date().toISOString()})
     ON CONFLICT(id) DO UPDATE SET cursor = excluded.cursor, updated = excluded.updated`;
}

function clearCursor(sql: SqlTag, taskId: string): void {
  sql`DELETE FROM task_cursor WHERE id = ${taskId}`;
}

/**
 * 分步跑一个长任务：每块受 CHUNK_BUDGET_MS 约束，超出预算就 schedule 一秒后继续。
 * 整段用 keepAliveWhile 包住，防止块内被空闲驱逐。
 */
export async function runChunked(
  agent: CoworkAgent,
  taskId: string,
): Promise<void> {
  const step = registry.get(taskKey(agent, taskId));
  if (!step) return;

  await agent.keepAliveWhile(async () => {
    let cursor = readCursor(agent.db, taskId);
    const deadline = Date.now() + CHUNK_BUDGET_MS;
    while (Date.now() < deadline) {
      const next = await step(cursor);
      if (next < 0) {
        clearCursor(agent.db, taskId);
        return;
      }
      cursor = next;
      writeCursor(agent.db, taskId, cursor);
    }
    // 预算用尽，交还控制权，一秒后从游标处续跑
    await agent.schedule(
      new Date(Date.now() + 1000),
      "continueTask",
      { taskId, cursor },
      { idempotent: false },
    );
  });
}

export async function runContinueTask(
  agent: CoworkAgent,
  payload: { taskId: string; cursor: number },
): Promise<void> {
  await runChunked(agent, payload.taskId);
}
