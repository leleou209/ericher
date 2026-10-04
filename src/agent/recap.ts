// 会话回想：没人说话满半小时之后，我自己回头把刚才那一段读一遍，记下来。
//
// 和咀嚼（context.ts）的分工 —— 这是本文件存在的理由：
//   咀嚼是每轮都可能发生的上下文压缩，产物只喂模型、界面上一点痕迹不留，
//   回答的是「我下一轮还接得上吗」。
//   回想是休息态的整理，产物进记忆库、留在对话里、挂在栏目上，
//   回答的是「这场聊过什么、我该记住什么」。
// 两者都会「压缩对话」，但一个是给窗口用的，一个是给记忆用的。混在一起做，
// 结果就是既没压好窗口，也没记住东西。

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
 * 排程侧粗闸：上次回想之后新话不足这个条数的场，不排程。
 * 就差一两句话的场醒来一趟，多半只买回一句干瘪的记录 —— 先攒着，攒出分量再想。
 * 闸挡下时不排新闹钟；若还留着旧句柄，到点那趟自会把它消费掉，不会悬空。
 */
const RECAP_MIN_NEW = 2;
/**
 * 到点侧精闸：这一段拢共没多少字的，不值得专门烧一趟模型。
 * 扫过是裁决不是失败 —— 游标直接推过去销账，不进重试；等下一段攒出分量再说。
 * 只有到点自动回想吃这道闸，管理员 force 不受它管。
 */
export const RECAP_MIN_CHARS = 400;
/**
 * 启动自愈时，一批欠着回想的场之间的间隔。
 * 老会话统一之后，第一次升级会一下子冒出几十场「欠回想」——
 * 挤在同一起跑线上就是几十次主模型调用撞在一起。错开十分钟一场，
 * 一个下午慢慢收完，账单平摊，也不会和当时的对话抢资源。
 */
export const RECAP_STAGGER_MS = 10 * 60 * 1000;
/** 排程余量：卡在整毫秒边界上容易抖动，往后让一点 */
const SCHEDULE_MARGIN_MS = 5000;

/**
 * 这一场到什么时候才算「停够久」。
 *
 * 唯一的参照是「最后一条消息是什么时候」，不是「现在 + 半小时」——
 * 闹钟可能排早、也可能排晚，只有最后发言的时刻是稳的。
 * 取 max(..., now) 是兜住一种情况：这场的时间戳在将来（时钟被调过），
 * 那也该是「从此刻起再等半小时」，而不是一直不触发。
 */
function dueAt(lastActive: string, now = Date.now()): number {
  const t = new Date(lastActive || 0).getTime();
  const base = Number.isFinite(t) && t > 0 ? t : now;
  return Math.max(base + RECAP_IDLE_MS, now);
}

/**
 * 给这一场排一次回想。
 *
 * 每轮答完都重排一次，而不是「只在第一次排上」—— 一轮一轮往后推，
 * 推的正是「最后一次发言之后半小时」这个概念本身。
 * 旧的那次先撤掉：不撤的话一场对话会攒下十几个闹钟，到点全响。
 *
 * 并非每场都值得排：新话攒不够 RECAP_MIN_NEW 条的轻场不排（见该常量）。
 *
 * 只有主人那间排：长期来客是对接者，ericher 在他面前是接待员。
 * 来客屋的记忆是分库 —— 分库自己不整理，素材走 receiveGuestMemory
 * 汇进主人那间的整理。不然每间来客屋半小时空闲就烧一次主模型，
 * 而主人翻回想时翻到的却是别人屋里的心绪。
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
 * onStart 自愈：表里还欠着回想、闹钟却没了的，重新排一次。
 *
 * 闹钟本身是持久的（句柄已落库），这一步兜的是另一类：排程那一下正好失败、
 * 或者句柄在写回前就断了。和 resyncReminders / resyncWatches 是同一笔账。
 *
 * 一场一场往后错开 RECAP_STAGGER_MS：老会话统一之后，第一次升级会一口气冒出
 * 几十场欠回想的，全挤在启动那一下就是几十次主模型调用撞车。
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
 * 到点回想。
 *
 * 到点不等于就该回想 —— 排完之后他又说过话、或者恰好我正在做别的整理，
 * 这一趟就不该跑。所以这里把条件重新判一遍，宁可白醒一次。
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
  const model = agent.maintModel();
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

  // 跑成（true）就收工。没跑成的两种都走同一条重排路：
  //   false = 模型或写回炸了；null = 手上有别的活。
  // 闹钟是一次性的 —— 醒来这一次之后就没有「下次到点」了，
  // 不重排的话这场就悬在半空，只能等重启自愈来接。
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
 * 该回想的那一段。返回 null 表示「没有新内容，这趟不用跑」。
 *
 * 「有没有新内容」只看一个数：这一场存了多少条消息、上次已回想到第几条。
 * 不另立账本 —— 一条 SQL 就能算出来的事，多一份记录就多一处会对不上的地方。
 *
 * 消息取哪一份：正开着的那场以内存态为准（它才是最新的原话），
 * 别的场读库 —— 屏幕上这一场跟被回想的那一场常常不是同一场。
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
 * 写回：一条分割线 + 她那两句收尾感想，游标推到「写完之后实际的条数」。
 *
 * 游标为什么不取「写之前的条数 + 这一段的长度」：她那句收尾感想本身就是一条
 * 新消息，不把它算进去，下一趟到点会再回想一遍刚刚记过的内容 —— 自己喂自己，
 * 一场对话能无限循环下去。
 */
async function writeBack(
  agent: CoworkAgent,
  sessionId: string,
  upto: number,
  text: string,
): Promise<void> {
  const isActive = sessionId === agent.state.activeSession;
  // part 顺序是 [分割标记, 正文]：标记渲染在她的字上面，
  // 「↑ 以上已记」指的才是**上一条**之前的内容，而不是包含她自己这段话。
  // 它是个 data part —— 主循环的 convertToModelMessages 没配 convertDataPart，
  // 所以这道线只在界面上存在，不会被当成上下文喂回去。
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
 * 回想那一轮的默认提示词。管理员可在设置页「回想守则」里整段改掉。
 *
 * 为什么不带完整人设：这一轮是记账，不是对话。把 basePrompt 全文（含工具说明）
 * 带进来，token 全花在让她演一遍自己上。这条与咀嚼用的 digestPrompt 一脉相承。
 *
 * 「现在没人在说话」必须写明白 —— 不写的话她会照着聊天惯性提问、等回复，
 * 那两句就会变成一条没人回答的问题，挂在对话尾巴上。
 *
 * 口径是工程纪要，不是感想：这条线上 ericher 不担负情感化内容 —— 回想的价值
 * 全在「把事情记进库」，心情既检索不到、也用不上。早先那句「只输出一两句
 * 第一人称的收尾感想」要的就是情绪，模型自然往情绪上写；改成按五点出纪要。
 * 「他默认已看到」也要写明白：不给这句，她就会把「没人接话」当成「他可能
 * 没看到」，要么自作主张重发，要么在记录里写一句没根据的猜测。
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
