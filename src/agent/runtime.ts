// 运行时：心跳、夜间维护、长任务分步续跑。
//
// 关键约束（D4）：keepAliveWhile 只防「空闲驱逐」，不延长 CPU 上限。
// DO 单次 invocation 的 CPU 上限约 30s，所以长任务必须切块，
// 块间用 schedule() 交还控制权再续跑，游标落 SQLite。

import type { UIMessage } from "ai";
import { OWNER_AGENT } from "../auth";
import { listMailIn, listMailOut } from "../mail/mailbox";
import { countMemories, deleteMemory, deleteVector } from "./memory";
import type { CoworkAgent } from "./cowork";
import { getSession, listSessions, loadSessionMessages } from "./sessionStore";
import type { SqlTag } from "./state";

const HEARTBEAT_SECONDS = 3600;
/** 04:00 Asia/Shanghai；cron-schedule 按运行时 UTC 解释。 */
const NIGHTLY_CRON = "0 20 * * *";
/** 单个 CPU 块的时间预算，留出余量 */
const CHUNK_BUDGET_MS = 25_000;
/** 一次全站整理最多带几场对话、每场几条、每条多长 */
const NIGHTLY_SESSIONS = 8;
export const NIGHTLY_MESSAGES = 8;
export const NIGHTLY_TEXT = 600;
const NIGHTLY_MATERIAL = 12_000;
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
  // 来客那间不排后台整理：它没有记忆库也没有经验库，整理只会白烧一次模型调用
  if (!agent.isOwnerRoom) return;
  // scheduleEvery 与 cron 形式的 schedule 都默认幂等，onStart 每次唤醒重复调用是安全的
  void agent.scheduleEvery(HEARTBEAT_SECONDS, "heartbeat").catch(() => {});
  // 夜间整理只在主屋跑一次，读全站会话与邮箱；场屋不再各自排程。
  // 旧版本曾在每间场屋排过 nightlyMaintenance，这里顺手把旧闹钟撤掉；
  // 主屋也撤掉旧的 04:00 UTC 那条，只留新的 20:00 UTC。
  const cleanup = agent.listSchedules().then((list) =>
    Promise.all(
      list
        .filter(
          (s) =>
            (s as { callback?: string }).callback === "nightlyMaintenance" &&
            (agent.name !== OWNER_AGENT ||
              (s as { cron?: string }).cron !== NIGHTLY_CRON),
        )
        .map((s) => agent.cancelSchedule(s.id)),
    ),
  );
  if (agent.name !== OWNER_AGENT) {
    void cleanup.catch(() => {});
    return;
  }
  void cleanup
    .finally(() => {
      void agent.schedule(NIGHTLY_CRON, "nightlyMaintenance").catch(() => {});
    })
    .catch(() => {});
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
  // 旧场屋可能还留着升级前排下的闹钟；到点也只在主屋做，不白烧模型。
  if (agent.name !== OWNER_AGENT) return;
  // 旧版本的 04:00 UTC 闹钟可能还在；只认新的 20:00 UTC（北京时间 04:00）。
  if (new Date().getUTCHours() !== 20) return;
  await agent.keepAliveWhile(async () => {
    const started = Date.now();
    const prev = readCursor(agent.db, "nightly");
    const since = prev > 0 ? prev : started - 24 * 60 * 60 * 1000;
    const parts: string[] = [];
    let sessions = 0;
    let failed = 0;

    const candidates = listSessions(agent.db)
      .filter((s) => {
        if (s.archived) return false;
        const at = new Date(s.lastActive || 0).getTime();
        return Number.isFinite(at) && at > since;
      })
      .sort(
        (a, b) =>
          new Date(b.lastActive).getTime() - new Date(a.lastActive).getTime(),
      )
      .slice(0, NIGHTLY_SESSIONS);

    for (const s of candidates) {
      try {
        let messages: Array<{ role: string; text: string }>;
        let title = s.title;
        let lastActive = s.lastActive;
        if (s.home) {
          const stub = env.COWORK_AGENT.get(
            env.COWORK_AGENT.idFromName(s.home),
          );
          const digest = await stub.nightlyDigest(since);
          if (!digest) continue;
          messages = digest.messages;
          title = digest.title;
          lastActive = digest.lastActive;
        } else {
          messages = loadSessionMessages(agent.db, s.id)
            .slice(-NIGHTLY_MESSAGES)
            .map((m) => ({
              role: m.role,
              text: textOfMessage(m).slice(0, NIGHTLY_TEXT),
            }))
            .filter((m) => m.text);
        }
        if (!messages.length) continue;
        sessions++;
        parts.push(
          `## 对话：${title} · ${lastActive}\n` +
            messages.map((m) => `${m.role}: ${m.text}`).join("\n"),
        );
      } catch (e) {
        failed++;
        console.warn("[nightly] 读会话失败", s.id, String((e as Error)?.message ?? e));
      }
    }

    // 邮箱与对话一起整理：只取游标之后的新流水，没有就什么都不做。
    let inbox = 0;
    let outbox = 0;
    try {
      const sinceIso = new Date(since).toISOString();
      const mailIn = listMailIn(agent.db, 200)
        .filter((r) => r.at > sinceIso)
        .slice(0, 10);
      const mailOut = listMailOut(agent.db, 200)
        .filter((r) => r.at > sinceIso)
        .slice(0, 10);
      inbox = mailIn.length;
      outbox = mailOut.length;
      for (const r of mailIn) {
        parts.push(
          `## 来信：${r.at} · ${r.fromName || r.from} · ${r.subject}\n${r.preview}`,
        );
      }
      for (const r of mailOut) {
        parts.push(
          `## 寄出：${r.at} · ${r.to.join("、")} · ${r.subject}\n${
            r.ok ? "成功" : r.error || "失败"
          }`,
        );
      }
    } catch {
      // 老实例可能还没有邮件表；没有新邮件可整理
    }

    if (!parts.length) {
      if (!failed) writeCursor(agent.db, "nightly", started);
      return;
    }

    const saved = await agent.globalNightlyOrganize(
      parts.join("\n\n").slice(0, NIGHTLY_MATERIAL),
    );
    writeCursor(agent.db, "nightly", started);
    console.log(
      `[nightly] sessions=${sessions} inbox=${inbox} outbox=${outbox} insights=${saved} failed=${failed}`,
    );
  });
}

/** 会话消息里的纯文本；与分析无关的工具块不进来。 */
function textOfMessage(m: UIMessage): string {
  return m.parts
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join(" ")
    .trim();
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
