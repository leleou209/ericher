// 会话回想：没人说话满半小时后，回头把刚才那一段读一遍并记下来。
// 与咀嚼（context.ts）分工：咀嚼是上下文压缩，只喂模型；回想进记忆库、留在对话里。
// 混做会既没压好窗口，也没记住东西。

import type { UIMessage } from "ai";
import { generateText, stepCountIs } from "ai";
import { memoryTools } from "../tools/memory";
import { sessionMemoTools } from "../tools/sessionMemo";
import type { CoworkAgent } from "./cowork";
import {
  appendSessionMessage,
  countSessionMessages,
  getSession,
  getSessionRecap,
  listRecapCandidates,
  loadSessionMessages,
  setSessionRecap,
  setSessionRecapSchedule,
} from "./sessionStore";

/** 停多久算「休息态」。半小时：够短到当天就能收，够长到不像还没说完。 */
export const RECAP_IDLE_MS = 30 * 60 * 1000;
/** 排程任务名。约定派发到 agent.recapSession(payload)。 */
export const RECAP_TASK = "recapSession";
/** 一次回想最多回看多少条。首次回想（游标为 0）时防它吃掉整场历史。 */
export const RECAP_WINDOW = 60;
/** 失败重排的间隔。重排一次就够 —— 第三次还失败说明是模型那边的事，不该一直烧。 */
export const RECAP_RETRY_MS = 2 * 60 * 60 * 1000;
/**
 * 排程侧粗闸：新话不足 RECAP_MIN_NEW 条不排程，先攒着。闸挡下时不排新闹钟；
 * 旧句柄若还在，到点那趟会消费掉，不会悬空。
 */
const RECAP_MIN_NEW = 2;
/**
 * 到点侧精闸：这一段总字数不足就不烧模型；游标直接推过去销账，不进重试。
 * 只有到点自动回想吃这道闸，管理员 force 不受它管。
 */
export const RECAP_MIN_CHARS = 400;
/**
 * 启动自愈时一批欠回想场的错峰间隔：升级后几十场一起醒就是几十次主模型调用撞车，
 * 错开十分钟一场，账单平摊，也不和当时对话抢资源。
 */
export const RECAP_STAGGER_MS = 10 * 60 * 1000;
/** 排程余量：卡在整毫秒边界上容易抖动，往后让一点 */
const SCHEDULE_MARGIN_MS = 5000;

/**
 * 「停够久」的参照是最后一条消息的时刻，不是 now+半小时：闹钟可能排早排晚。
 * 取 max(..., now) 兜住时间戳在将来的情况（时钟被调过），从此刻起再等半小时。
 */
function dueAt(lastActive: string, now = Date.now()): number {
  const t = new Date(lastActive || 0).getTime();
  const base = Number.isFinite(t) && t > 0 ? t : now;
  return Math.max(base + RECAP_IDLE_MS, now);
}

/**
 * 给本场排一次回想：每轮答完重排（推的正是「最后一次发言后半小时」），先撤旧闹钟，
 * 否则一场会攒下十几个闹钟一起响；新话不足 RECAP_MIN_NEW 的轻场不排。
 * 只有主人那间排：来客屋记忆是分库，由 receiveGuestMemory 汇进主人那间整理。
 */
export async function scheduleRecap(
  agent: CoworkAgent,
  sessionId: string,
  /** 最早不早于这个时刻（毫秒）。启动自愈拿它给一批场错峰，正常重排不传 */
  notBefore = 0,
): Promise<void> {
  if (agent.isOwnerRoom !== true) return;
  const s = getSession(agent.db, sessionId);
  if (!s) return;

  const { upto, schedule } = getSessionRecap(agent.db, sessionId);
  // 排程侧粗闸：轻场攒着，不醒这一趟（见 RECAP_MIN_NEW）
  if (s.msgCount - upto < RECAP_MIN_NEW) return;
  if (schedule) await agent.cancelSchedule(schedule).catch(() => {});

  const at = new Date(
    Math.max(dueAt(s.lastActive), notBefore) + SCHEDULE_MARGIN_MS,
  );
  const handle = await agent.schedule(
    at,
    RECAP_TASK,
    { id: sessionId },
    { idempotent: false },
  );
  // 句柄落库：DO 被驱逐之后闹钟照样会醒，但表里得留个记号，
  // 否则下次重排撤不掉上一次那个，两个闹钟一起响
  setSessionRecapSchedule(agent.db, sessionId, handle.id);
}

/**
 * onStart 自愈：表里还欠回想、闹钟却没了的，重新排一次（排程那一下失败或句柄没落库）。
 * 一场一场错开 RECAP_STAGGER_MS，避免升级后几十场主模型调用同时启动。
 */
export async function resyncRecaps(agent: CoworkAgent): Promise<void> {
  const idleBefore = new Date(Date.now() - RECAP_IDLE_MS).toISOString();
  const now = Date.now();
  let i = 0;
  for (const c of listRecapCandidates(agent.db, idleBefore)) {
    const { schedule } = getSessionRecap(agent.db, c.id);
    if (schedule) continue; // 已经排上了
    await scheduleRecap(agent, c.id, now + i * RECAP_STAGGER_MS).catch(
      () => {},
    );
    i += 1;
  }
}

/**
 * 到点回想。到点不等于该回想：排完之后他又说过话、或我正在做别的整理，就白醒一次重判。
 */
export async function runSessionRecap(
  agent: CoworkAgent,
  payload: { id: string; attempt?: number; force?: boolean },
): Promise<void> {
  // 分库不整理（见 scheduleRecap）。这一道挡的是升级前排上的旧闹钟：
  // 排程那道闸上了之后，来客屋不该再有新的；已经在路上那几个，到点就地睡下
  if (agent.isOwnerRoom !== true) return;
  const s = getSession(agent.db, payload.id);
  if (!s) return;

  // 闹钟响这一次，句柄就算消费掉了：它是一次性的，留着只会骗 resyncRecaps
  // 把「这场还排着」当真 —— 没模型、正忙着这些没跑成的出口，从此等不到自愈。
  // 要续排的分支（还没聊够、失败重试）会各自把新句柄写回来。
  setSessionRecapSchedule(agent.db, payload.id, "");

  // 他后来又说话了：这一场重新进计时，现在还不是回头看的时候。
  // force 是管理员在面板上亲自按的那一下 —— 他叫我这会儿看，那就这会儿看
  if (!payload.force && Date.now() < dueAt(s.lastActive)) {
    await scheduleRecap(agent, payload.id).catch(() => {});
    return;
  }

  const fresh = freshSegment(agent, payload.id);
  if (!fresh) return; // 没有新内容：不跑、不写、游标不动

  const { segment, from } = fresh;

  // 到点侧精闸：这一段拢共没几个字，专门烧一趟模型记它不划算。
  // 扫过是裁决不是失败 —— 游标推过去就销账，不进重试；force 是管理员
  // 亲自按的那一下，他说看就看
  if (!payload.force && segmentChars(segment) < RECAP_MIN_CHARS) {
    setSessionRecap(
      agent.db,
      payload.id,
      from + segment.length,
      new Date().toISOString(),
    );
    return;
  }

  // 回想走维护模型的口（与夜间整理同源）：它是后台记账，不值得动用主线那台
  // 按量计费的 —— 管理员给维护配了更便宜的，这里自动跟上；没配则回落主模型
  // 闹钟轮是冷唤醒：要 resolveMaintModel 才会去模型目录读，不然目录配的模型白配
  const model = await agent.resolveMaintModel();
  if (!model) return; // 一个模型都没配：什么都没发生，下次到点还有机会

  // 这一趟回想的幂等键：她写下的每条记忆都带着它。写回失败、游标没推进时，
  // 重跑的这一趟再写同键的记忆会被写入层跳过 —— 同一段不该记两遍
  const dedupe = `${payload.id}:${from}`;
  const recapCtx = {
    ...agent.toolCtx(),
    // 回想是独立的闹钟轮，不吃主轮留下的检索缓存 —— 那是上一个对话轮的账
    recallCache: new Map(),
    recapSessionId: payload.id,
    recapDedupe: dedupe,
  };

  // 与夜间整理共用一道闸：撞在一起不会脏数据，但同一段时间的话被整理两遍，
  // 两次模型调用只买回一个结果
  const ran = await agent
    .withSelfWork(async () => {
      await agent.keepAliveWhile(async () => {
        const { system, user } = buildRecapPrompt(
          agent.sessionTranscript(segment),
          agent.state.recapPrompt,
        );
        const r = await generateText({
          model,
          system,
          prompt: user,
          // 只挂她自己写东西要用的那两件：翻长期记忆、记这一段对话。
          // 不挂完整工具集 —— 她此刻没在替谁办事，发邮件、定提醒的手没有意义
          tools: {
            ...memoryTools(recapCtx),
            ...sessionMemoTools(recapCtx),
          },
          stopWhen: stepCountIs(6),
          // 这是记账，不是写文章。给个闸，别让它在这里展开成长篇
          maxOutputTokens: 2048,
          abortSignal: AbortSignal.timeout(60_000),
        });
        const text =
          r.text.trim() || "（这一趟回头看下来，没什么要特意记的。）";
        await writeBack(agent, payload.id, from + segment.length, text);
      });
      return true;
    })
    .catch((e: unknown) => {
      // 回想失败没什么可报给用户的，但一声不吭会让「功能一直没生效」查不出原因
      console.error("[recap] 这一趟回想没跑成：", e);
      return false;
    });

  // 跑成收工；false = 模型或写回炸了，null = 手上有别的活。闹钟一次性，不重排就悬着等重启自愈。
  if (ran !== true && (payload.attempt ?? 0) < 1) {
    // 失败不动游标：那段话还没被记下来，下次还得从这儿接着来。
    // 只重排一次 —— 第三次还失败说明是模型那边的事，一直烧没有意义
    try {
      const handle = await agent.schedule(
        new Date(Date.now() + RECAP_RETRY_MS),
        RECAP_TASK,
        { id: payload.id, attempt: (payload.attempt ?? 0) + 1 },
        { idempotent: false },
      );
      // 重试句柄也落库：不落的话这次排程在表里是隐形的，
      // 下次重排撤不掉它，重启自愈也看不见它
      setSessionRecapSchedule(agent.db, payload.id, handle.id);
    } catch {
      // 排不上就算了：句柄已经清掉，重启自愈会接手
    }
  }
}

/**
 * 该回想的那一段；null = 没有新内容。
 * 「有没有新内容」只看消息总数与游标，不另立账本。正开着的场以内存为准（最新原话），别的场读库。
 */
export function freshSegment(
  agent: CoworkAgent,
  sessionId: string,
): { segment: UIMessage[]; from: number } | null {
  const isActive = sessionId === agent.state.activeSession;
  const msgs = isActive
    ? agent.messages
    : loadSessionMessages(agent.db, sessionId);
  const { upto } = getSessionRecap(agent.db, sessionId);
  // 游标之外，再套一道窗：游标为 0（从没回想过的老场）时不至于一口气吃掉整场历史
  const from = Math.max(upto, msgs.length - RECAP_WINDOW);
  if (msgs.length <= from) return null;
  return { segment: msgs.slice(from), from };
}

/** 这一段有多大（字符近似）：只数正文文字，id、时间戳那些外壳不算数 */
function segmentChars(segment: UIMessage[]): number {
  let n = 0;
  for (const m of segment)
    for (const p of m.parts) if (p.type === "text") n += p.text.length;
  return n;
}

/**
 * 写回：分割线 + 收尾纪要，游标推到写完之后实际的条数（收尾本身也是一条新消息，
 * 不计进去下一趟会再回想刚记过的内容，自己喂自己无限循环）。
 */
async function writeBack(
  agent: CoworkAgent,
  sessionId: string,
  upto: number,
  text: string,
): Promise<void> {
  const isActive = sessionId === agent.state.activeSession;
  // part 顺序 [分割标记, 正文]：分割标记要渲染在字上面，「以上已记」才指向上一条。
  // data part 没配 convertDataPart，只在界面存在，不进上下文。
  const msg: UIMessage = {
    id: crypto.randomUUID(),
    role: "assistant",
    parts: [
      {
        type: "data-recap",
        data: { at: new Date().toISOString(), upto, sessionId },
      },
      { type: "text", text },
    ],
  };

  if (isActive) {
    // 当前这场：必须连内存态一起推进去。只写库的话，下一轮 snapshotSession
    // 会把多出来的这条当「多余的尾巴」删掉（saveSessionMessages 的 stale 分支
    // 会删掉 seq >= messages.length 的所有行）
    await agent.persistMessages([...agent.messages, msg]);
    setSessionRecap(
      agent.db,
      sessionId,
      agent.messages.length,
      new Date().toISOString(),
    );
  } else {
    // 别的场：只写库。persistMessages 会把消息灌进「当前正开着的那一轮对话」，
    // 那是别人家的屋子
    appendSessionMessage(agent.db, sessionId, msg);
    setSessionRecap(
      agent.db,
      sessionId,
      countSessionMessages(agent.db, sessionId),
      new Date().toISOString(),
    );
  }
}

/**
 * 回想默认提示词（管理员可在设置页整段改）。不带完整人设：这是记账不是对话。
 * 「现在没人在说话」必须写明，否则她会按聊天惯性提问；「他默认已看到」也要写，否则会重发或瞎猜。
 * 口径是工程纪要，不写情绪/感想——心情检索不到也用不上。
 */
export const DEFAULT_RECAP_PROMPT = `你是 ericher。
现在是安静的时段，你现在准备写工作纪要。
我们默认已经看过这一段里的每条消息。
下面是你和用户刚过去的一段对话。
读一遍，然后做记忆储存工作，目的是将信息最大化保留和整理其中经验，具体为两条：
一是用 session_memo 把这一段记下来，按工程口径写全五点：发生了什么、我做了什么、现在处于什么情况、有什么需要收敛整理的、下一步大概做什么；sentiment 照实标（那是检索标签）。
二是如果这一段里出现了值得长期记住的事（他的偏好、定下来的规矩、提到的人、还没了结的事），用 memory 再记一条。
约束：不写情绪、不写感想、不做价值评判，不扯新话题，不提问，不要求回复，不复述对话原文。最后附加一段概要。`;

export function buildRecapPrompt(
  transcript: string,
  custom?: string,
): { system: string; user: string } {
  const body = (custom || "").trim();
  return {
    system: body || DEFAULT_RECAP_PROMPT,
    user: "【刚过去的这一段】\n" + transcript,
  };
}
