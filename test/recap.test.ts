/**
 * 休息态回想的测试。
 *
 * 这一趟活跑在闹钟上，跑的时候没人在看 —— 所以它出错的方式都很安静：
 * 排早了一次（他还在说话就开始整理）、写了一半（游标没推到写完之后那条，
 * 下一趟又回想同一段，自己喂自己，能无限循环下去）、失败之后一直重排（烧模型）。
 * 这三样都不会报错，只会让账单和记忆库慢慢不对劲。这里就盯这三样。
 *
 * 假 agent 只带 recap.ts 真正会用到的那几件家当；generateText 和主模型都被替掉 ——
 * 要验的是「什么时候跑、跑完写什么」，不是模型答得好不好。
 *
 * 运行: npx vitest run
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { UIMessage } from "ai";
import { generateText } from "ai";
import {
  DEFAULT_RECAP_PROMPT,
  RECAP_IDLE_MS,
  RECAP_RETRY_MS,
  RECAP_STAGGER_MS,
  RECAP_WINDOW,
  RECAP_TASK,
  buildRecapPrompt,
  freshSegment,
  resyncRecaps,
  runSessionRecap,
  scheduleRecap,
} from "../src/agent/recap";
import {
  ensureSessionSchema,
  listRecapCandidates,
  resetLegacyRecapCursors,
} from "../src/agent/sessionStore";
import { sessionMemoryCounts } from "../src/agent/memory";
import type { SqlTag } from "../src/agent/state";

vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return {
    ...actual,
    generateText: vi.fn(async () => ({ text: "回头看了一眼，就这样。" })),
  };
});

const msg = (text: string): UIMessage =>
  ({
    id: "x" + Math.random().toString(36).slice(2),
    role: "user",
    parts: [{ type: "text", text }],
  }) as UIMessage;

/** 一句话说清「这一场停在哪一刻」。now 之外的都算停够了 */
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

/**
 * 假库：只认 sessionStore 里那几条语句，认不出的直接抛错带原句。
 * 认不出就返回空数组最要命 —— 「查询写错」会长得和「查出来就是没有」一模一样。
 */
function fakeDb(
  seed: Array<{
    id: string;
    lastActive: string;
    upto: number;
    n: number;
    schedule?: string;
    /** 轻场：消息保持三两个字的本来面目，专测判级闸的扫过路径 */
    light?: boolean;
  }> = [],
) {
  const sessions = new Map<
    string,
    { lastActive: string; upto: number; at: string; schedule: string }
  >();
  const msgs = new Map<string, string[]>();
  for (const s of seed) {
    sessions.set(s.id, {
      lastActive: s.lastActive,
      upto: s.upto,
      at: "",
      schedule: s.schedule || "",
    });
    msgs.set(
      s.id,
      Array.from({ length: s.n }, (_, i) =>
        // 非 light 场垫长：到点侧的字数闸（RECAP_MIN_CHARS）之下，
        // 光秃秃的短消息到点只会被扫过 —— 要验「跑了写什么」的用例得够分量
        JSON.stringify(
          msg(s.light ? "第" + i + "句" : "第" + i + "句" + "记".repeat(300)),
        ),
      ),
    );
  }

  const tag = (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): unknown[] => {
    const sql = strings.join("?").replace(/\s+/g, " ").trim().toLowerCase();

    if (
      sql.startsWith(
        "select recap_upto, recap_at, recap_schedule from sessions where id =",
      )
    ) {
      const s = sessions.get(String(values[0]));
      return s
        ? [{ recap_upto: s.upto, recap_at: s.at, recap_schedule: s.schedule }]
        : [];
    }

    if (
      sql.startsWith("select s.id, s.title") &&
      sql.includes("where s.id =")
    ) {
      const id = String(values[0]);
      const s = sessions.get(id);
      return s
        ? [
            {
              id,
              title: "某一场",
              visibility: "private",
              created: "2026-09-01T00:00:00.000Z",
              last_active: s.lastActive,
              digest: "",
              archived: 0,
              named: 1,
              unread: 0,
              recap_at: s.at,
              n: msgs.get(id)?.length ?? 0,
            },
          ]
        : [];
    }

    if (sql.startsWith("select s.id as id, s.last_active as lastactive")) {
      const before = String(values[0]);
      return [...sessions.entries()]
        .filter(
          ([id, s]) =>
            s.lastActive < before && s.upto < (msgs.get(id)?.length ?? 0),
        )
        .map(([id, s]) => ({
          id,
          lastActive: s.lastActive,
          upto: s.upto,
          n: msgs.get(id)?.length ?? 0,
        }))
        .sort((a, b) => (a.lastActive < b.lastActive ? -1 : 1));
    }

    if (sql.startsWith("select count(*) as n from session_messages")) {
      return [{ n: msgs.get(String(values[0]))?.length ?? 0 }];
    }

    if (sql.startsWith("select max(seq) as n from session_messages")) {
      return [{ n: (msgs.get(String(values[0]))?.length ?? 1) - 1 }];
    }

    if (sql.startsWith("select message from session_messages")) {
      return (msgs.get(String(values[0])) ?? []).map((message) => ({
        message,
      }));
    }

    if (sql.startsWith("insert into session_messages")) {
      const [id, , message] = values as [string, number, string];
      if (!msgs.has(id)) msgs.set(id, []);
      msgs.get(id)!.push(message);
      return [];
    }

    if (sql.startsWith("update sessions set recap_schedule =")) {
      const [handle, id] = values as [string, string];
      const s = sessions.get(id);
      if (s) s.schedule = handle;
      return [];
    }

    if (sql.startsWith("update sessions set recap_upto =")) {
      const [upto, at, id] = values as [number, string, string];
      const s = sessions.get(id);
      if (s) {
        s.upto = upto;
        s.at = at;
        s.schedule = ""; // 语句尾部那句 `recap_schedule = ''` 写在这里
      }
      return [];
    }

    throw new Error("假库不认得这条语句：" + sql);
  };

  return {
    sql: tag as unknown as SqlTag,
    session: (id: string) => sessions.get(id)!,
    texts: (id: string) =>
      (msgs.get(id) ?? []).map((m) => JSON.parse(m) as UIMessage),
  };
}

/** 只带 recap.ts 会用到的那几件家当。没被用到的接口不给，用了就会在这里暴露 */
function fakeAgent(
  db: ReturnType<typeof fakeDb>,
  over: Record<string, unknown> = {},
) {
  const scheduled: Array<{
    at: Date;
    name: string;
    payload: unknown;
    idempotent?: boolean;
  }> = [];
  const cancelled: string[] = [];
  const persisted: UIMessage[][] = [];
  const agent = {
    db: db.sql,
    appEnv: {} as Env,
    // 回想走维护模型的口（见 recap.ts）：假的不分辨是谁家的，只认「有一台」
    // 冷唤醒版 —— 闹钟轮靠它去模型目录读，不然目录配的模型白配
    resolveMaintModel: async () => ({ id: "fake-maint" }),
    // 默认按主人房算 —— 绝大多数用例验的是整理本身的机制；
    // 分库（来客屋）的闸在下面单独验
    isOwnerRoom: true,
    state: { activeSession: "" },
    messages: [] as UIMessage[],
    schedule: async (
      at: Date,
      name: string,
      payload: unknown,
      opts?: { idempotent?: boolean },
    ) => {
      scheduled.push({ at, name, payload, idempotent: opts?.idempotent });
      return { id: "h" + scheduled.length };
    },
    cancelSchedule: async (id: string) => {
      cancelled.push(id);
    },
    keepAliveWhile: async (fn: () => Promise<void>) => {
      await fn();
    },
    selfWork: null as Promise<unknown> | null,
    async withSelfWork<T>(fn: () => Promise<T>): Promise<T | null> {
      if (this.selfWork) return null;
      const p = fn().finally(() => {
        this.selfWork = null;
      });
      this.selfWork = p as Promise<unknown>;
      return p;
    },
    toolCtx: () => ({}) as never,
    sessionTranscript: (msgs: UIMessage[]) =>
      msgs.map((m) => "管理员: " + JSON.stringify(m.parts)).join("\n"),
    persistMessages: async (m: UIMessage[]) => {
      persisted.push(m);
    },
    ...over,
  };
  return { agent: agent as never, scheduled, cancelled, persisted };
}

beforeEach(() => {
  vi.mocked(generateText).mockReset();
  vi.mocked(generateText).mockResolvedValue({
    text: "回头看了一眼，就这样。",
  } as never);
});

describe("freshSegment：有没有新内容", () => {
  it("停在库里的那些条数上时，返回 null —— 这一趟不该跑", () => {
    const db = fakeDb([
      { id: "s1", lastActive: iso(RECAP_IDLE_MS * 2), upto: 4, n: 4 },
    ]);
    const { agent } = fakeAgent(db, { state: { activeSession: "s1" } });
    expect(freshSegment(agent, "s1")).toBeNull();
  });

  it("游标之后那几条就是这一段，from 就是游标", () => {
    const db = fakeDb([
      { id: "s1", lastActive: iso(RECAP_IDLE_MS * 2), upto: 2, n: 5 },
    ]);
    const { agent } = fakeAgent(db, { state: { activeSession: "" } });
    const fresh = freshSegment(agent, "s1")!;
    expect(fresh.from).toBe(2);
    expect(fresh.segment).toHaveLength(3);
  });

  it("从没回想过的老场，一趟最多回看 60 条 —— 不吃掉整场历史", () => {
    const db = fakeDb([
      { id: "s1", lastActive: iso(RECAP_IDLE_MS * 2), upto: 0, n: 500 },
    ]);
    const { agent } = fakeAgent(db, { state: { activeSession: "" } });
    const fresh = freshSegment(agent, "s1")!;
    expect(fresh.segment).toHaveLength(RECAP_WINDOW);
    expect(fresh.from).toBe(500 - RECAP_WINDOW);
  });

  it("正开着的那场以内存态为准 —— 库里还差最后一条没落", () => {
    const db = fakeDb([
      { id: "s1", lastActive: iso(RECAP_IDLE_MS * 2), upto: 0, n: 1 },
    ]);
    const live = [msg("一句"), msg("两句")];
    const { agent } = fakeAgent(db, {
      state: { activeSession: "s1" },
      messages: live,
    });
    expect(freshSegment(agent, "s1")!.segment).toHaveLength(2);
  });
});

describe("scheduleRecap：一轮一轮往后推", () => {
  it("排之前先撤掉上一次的句柄，不然一会儿一堆闹钟一起响", async () => {
    const db = fakeDb([{ id: "s1", lastActive: iso(1000), upto: 0, n: 3 }]);
    const { agent, scheduled, cancelled } = fakeAgent(db);
    db.session("s1").schedule = "old-handle";

    await scheduleRecap(agent, "s1");

    expect(cancelled).toEqual(["old-handle"]);
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0].name).toBe(RECAP_TASK);
    expect(scheduled[0].payload).toEqual({ id: "s1" });
    // 每次排的都是新的一次，不让 SDK 那边按 id 去重把它吞掉
    expect(scheduled[0].idempotent).toBe(false);
  });

  it("排的是「最后一条消息之后半小时」，不是「现在加半小时」", async () => {
    const lastActive = iso(10 * 60 * 1000); // 刚停十分钟
    const db = fakeDb([{ id: "s1", lastActive, upto: 0, n: 3 }]);
    const { agent, scheduled } = fakeAgent(db);

    await scheduleRecap(agent, "s1");

    const want = new Date(lastActive).getTime() + RECAP_IDLE_MS;
    expect(Math.abs(scheduled[0].at.getTime() - want)).toBeLessThan(10_000);
  });

  it("句柄落库 —— DO 被驱逐后重排还得靠它撤掉上一个", async () => {
    const db = fakeDb([{ id: "s1", lastActive: iso(1000), upto: 0, n: 3 }]);
    const { agent } = fakeAgent(db);
    await scheduleRecap(agent, "s1");
    expect(db.session("s1").schedule).toBe("h1");
  });

  it("这一场已经不在了就什么都不做", async () => {
    const db = fakeDb([]);
    const { agent, scheduled } = fakeAgent(db);
    await scheduleRecap(agent, "gone");
    expect(scheduled).toHaveLength(0);
  });

  it("分库不排程：来客屋的记忆自己不整理，素材汇进主人那间", async () => {
    const db = fakeDb([{ id: "s1", lastActive: iso(1000), upto: 0, n: 3 }]);
    const { agent, scheduled } = fakeAgent(db, { isOwnerRoom: false });

    await scheduleRecap(agent, "s1");

    // 连句柄都不碰：排程和撤销都没发生，来客屋安安静静
    expect(scheduled).toHaveLength(0);
    expect(db.session("s1").schedule).toBe("");
  });
});

describe("runSessionRecap：到点了要不要真跑", () => {
  it("分库到点也不跑：升级前漏网的旧闹钟，就地睡下", async () => {
    const db = fakeDb([
      { id: "s1", lastActive: iso(RECAP_IDLE_MS * 2), upto: 0, n: 5 },
    ]);
    const { agent, scheduled } = fakeAgent(db, { isOwnerRoom: false });

    await runSessionRecap(agent, { id: "s1", force: true });

    // force 也拦：分库没有「现在就看一眼」这回事
    expect(scheduled).toHaveLength(0);
  });
  it("他后来又说话了：这一趟不跑，重排一次就退下", async () => {
    const db = fakeDb([
      { id: "s1", lastActive: iso(60 * 1000), upto: 0, n: 5 },
    ]);
    const { agent, scheduled } = fakeAgent(db);

    await runSessionRecap(agent, { id: "s1" });

    expect(generateText).not.toHaveBeenCalled();
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0].name).toBe(RECAP_TASK);
  });

  it("停够了但没有新内容：不跑、不写、也不重排 —— 「没新内容就不会再触发」", async () => {
    const db = fakeDb([
      { id: "s1", lastActive: iso(RECAP_IDLE_MS * 2), upto: 5, n: 5 },
    ]);
    const { agent, scheduled, persisted } = fakeAgent(db);

    await runSessionRecap(agent, { id: "s1" });

    expect(generateText).not.toHaveBeenCalled();
    expect(scheduled).toHaveLength(0);
    expect(persisted).toHaveLength(0);
    expect(db.session("s1").at).toBe("");
  });

  it("管理员在面板上按的那一下（force）：不等半小时也跑", async () => {
    const db = fakeDb([
      { id: "s1", lastActive: iso(60 * 1000), upto: 0, n: 3 },
    ]);
    const { agent } = fakeAgent(db);

    await runSessionRecap(agent, { id: "s1", force: true });

    expect(generateText).toHaveBeenCalledTimes(1);
  });

  it("这一场不在、或者没配主模型：静静地什么都不做", async () => {
    const gone = fakeDb([]);
    const a1 = fakeAgent(gone);
    await runSessionRecap(a1.agent, { id: "nope" });
    expect(generateText).not.toHaveBeenCalled();
    expect(a1.scheduled).toHaveLength(0);
  });
});

describe("runSessionRecap：跑完写回什么", () => {
  it("分割线在正文之前，且是个 data part —— 别把它喂回模型", async () => {
    const db = fakeDb([
      { id: "s1", lastActive: iso(RECAP_IDLE_MS * 2), upto: 0, n: 2 },
    ]);
    const { agent, persisted } = fakeAgent(db);

    await runSessionRecap(agent, { id: "s1" });

    // 这一场不是屏幕上开着的那场，所以从库里读她写下的那条（写回形状两条路一样）
    const parts = db.texts("s1").at(-1)!.parts as Array<{
      type: string;
      data?: unknown;
    }>;
    expect(persisted).toHaveLength(0);
    expect(parts[0].type).toBe("data-recap");
    expect(parts[1].type).toBe("text");
    expect((parts[0].data as { sessionId: string }).sessionId).toBe("s1");
  });

  it("游标推到「写完之后实际的条数」，不是「写之前 + 这段长度」", async () => {
    const db = fakeDb([
      { id: "s1", lastActive: iso(RECAP_IDLE_MS * 2), upto: 0, n: 2 },
    ]);
    const { agent } = fakeAgent(db);

    await runSessionRecap(agent, { id: "s1" });

    // 2 条旧话 + 她这一条收尾 = 3。不把她自己这条算进去，下一趟就会再回想一遍刚记过的内容
    expect(db.session("s1").upto).toBe(3);
    expect(db.session("s1").at).not.toBe("");
  });

  it("刚记完之后立刻再判一次：没有新内容，不会再跑第二趟 —— 不会自己喂自己", async () => {
    const db = fakeDb([
      { id: "s1", lastActive: iso(RECAP_IDLE_MS * 2), upto: 0, n: 2 },
    ]);
    const { agent } = fakeAgent(db);

    await runSessionRecap(agent, { id: "s1" });
    expect(generateText).toHaveBeenCalledTimes(1);

    await runSessionRecap(agent, { id: "s1", force: true });
    expect(generateText).toHaveBeenCalledTimes(1);
  });

  it("回想的是别的场：只写库，不灌进屏幕上正开着的那一轮对话", async () => {
    const db = fakeDb([
      { id: "s1", lastActive: iso(RECAP_IDLE_MS * 2), upto: 0, n: 2 },
      { id: "other", lastActive: iso(RECAP_IDLE_MS * 2), upto: 0, n: 1 },
    ]);
    const { agent, persisted } = fakeAgent(db, {
      state: { activeSession: "other" },
      messages: [msg("别人家在聊")],
    });

    await runSessionRecap(agent, { id: "s1" });

    expect(persisted).toHaveLength(0);
    expect(db.texts("s1")).toHaveLength(3);
    expect(db.session("s1").upto).toBe(3);
  });
});

describe("runSessionRecap：失败只重排一次", () => {
  it("模型那一步挂了：游标原地不动，两小时后再来", async () => {
    const db = fakeDb([
      { id: "s1", lastActive: iso(RECAP_IDLE_MS * 2), upto: 0, n: 2 },
    ]);
    const { agent, scheduled } = fakeAgent(db);
    vi.mocked(generateText).mockRejectedValueOnce(new Error("模型那边断了"));

    await runSessionRecap(agent, { id: "s1" });

    expect(db.session("s1").upto).toBe(0); // 那段话还没被记下来，下次还得从这儿接着来
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0].payload).toEqual({ id: "s1", attempt: 1 });
    const delta = scheduled[0].at.getTime() - Date.now();
    expect(Math.abs(delta - RECAP_RETRY_MS)).toBeLessThan(10_000);
  });

  it("第二次还是挂：不再排第三次 —— 一直烧模型没有意义", async () => {
    const db = fakeDb([
      { id: "s1", lastActive: iso(RECAP_IDLE_MS * 2), upto: 0, n: 2 },
    ]);
    const { agent, scheduled } = fakeAgent(db);
    vi.mocked(generateText).mockRejectedValueOnce(new Error("又断了"));

    await runSessionRecap(agent, { id: "s1", attempt: 1 });

    expect(scheduled).toHaveLength(0);
  });

  it("手上正有别的活（夜间整理）：也算没跑成 —— 闹钟是一次性的，醒来之后没有「下次到点」，照样重排", async () => {
    const db = fakeDb([
      { id: "s1", lastActive: iso(RECAP_IDLE_MS * 2), upto: 0, n: 2 },
    ]);
    const { agent, scheduled } = fakeAgent(db);
    (agent as unknown as { selfWork: Promise<unknown> | null }).selfWork =
      new Promise(() => {});

    await runSessionRecap(agent, { id: "s1" });

    expect(generateText).not.toHaveBeenCalled();
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0].payload).toEqual({ id: "s1", attempt: 1 });
  });
});

describe("resyncRecaps：启动时自愈", () => {
  it("还欠着回想、闹钟却没了的，重新排一次", async () => {
    const db = fakeDb([
      { id: "s1", lastActive: iso(RECAP_IDLE_MS * 2), upto: 0, n: 3 },
      { id: "s2", lastActive: iso(RECAP_IDLE_MS * 2), upto: 0, n: 3 },
    ]);
    const { agent, scheduled } = fakeAgent(db);
    db.session("s2").schedule = "still-alive"; // 这条闹钟还在

    await resyncRecaps(agent);

    expect(scheduled).toHaveLength(1);
    expect(scheduled[0].payload).toEqual({ id: "s1" });
  });

  it("刚聊过还没停够半小时的场，不在候选里", async () => {
    const db = fakeDb([
      { id: "s1", lastActive: iso(60 * 1000), upto: 0, n: 3 },
    ]);
    const { agent, scheduled } = fakeAgent(db);
    await resyncRecaps(agent);
    expect(scheduled).toHaveLength(0);
  });

  it("一批欠账的场一场一场错峰排 —— 老会话统一后第一次升级不该几十次模型调用撞在一起", async () => {
    const old = iso(RECAP_IDLE_MS * 2);
    const db = fakeDb([
      { id: "s1", lastActive: old, upto: 0, n: 3 },
      { id: "s2", lastActive: old, upto: 0, n: 3 },
      { id: "s3", lastActive: old, upto: 0, n: 3 },
    ]);
    const { agent, scheduled } = fakeAgent(db);

    await resyncRecaps(agent);

    expect(scheduled).toHaveLength(3);
    const gap = scheduled[2].at.getTime() - scheduled[0].at.getTime();
    expect(gap).toBeGreaterThanOrEqual(RECAP_STAGGER_MS * 2 - 10_000);
    expect(gap).toBeLessThanOrEqual(RECAP_STAGGER_MS * 2 + 10_000);
  });
});

describe("runSessionRecap：句柄消费与重试记账", () => {
  const owed = [
    { id: "s1", lastActive: iso(RECAP_IDLE_MS * 2), upto: 0, n: 2 },
  ];

  it("闹钟响这一次句柄就消费掉 —— 没有新内容的出口不留过期句柄堵自愈", async () => {
    const db = fakeDb([
      {
        id: "s1",
        lastActive: iso(RECAP_IDLE_MS * 2),
        upto: 4,
        n: 4,
        schedule: "h9",
      },
    ]);
    const { agent } = fakeAgent(db);
    await runSessionRecap(agent, { id: "s1" });
    expect(db.session("s1").schedule).toBe("");
  });

  it("失败重试：重试句柄落库 —— 否则这次排程在表里是隐形的", async () => {
    const db = fakeDb(owed);
    vi.mocked(generateText).mockRejectedValueOnce(new Error("模型抽风"));
    const { agent } = fakeAgent(db);
    await runSessionRecap(agent, { id: "s1" });
    expect(db.session("s1").schedule).not.toBe("");
  });

  it("重试也失败（attempt=1）：不再排了，句柄清空 —— 重启自愈能看见这场欠账", async () => {
    const db = fakeDb(owed);
    vi.mocked(generateText).mockRejectedValue(new Error("还是不行"));
    const { agent } = fakeAgent(db);
    await runSessionRecap(agent, { id: "s1", attempt: 1 });
    expect(db.session("s1").schedule).toBe("");
  });

  it("手上有别的活（withSelfWork 被占）也走重排 —— 闹钟一次性，没有「下次到点」", async () => {
    const db = fakeDb(owed);
    const { agent } = fakeAgent(db, { selfWork: Promise.resolve() });
    await runSessionRecap(agent, { id: "s1" });
    expect(db.session("s1").schedule).not.toBe("");
  });
});

/**
 * 回想判级：轻重两道闸。
 *
 * 排程侧看条数（攒不够不醒，防白醒循环），到点侧看字数（没分量不烧模型）。
 * 两道闸的共同目标：回想是记账，账本上没几行字就别动用一次模型调用。
 */
describe("回想判级：轻重两道闸", () => {
  it("排程侧：新话就差一条的场不排程 —— 攒着，等攒够一次想", async () => {
    const db = fakeDb([
      { id: "s1", lastActive: iso(1000), upto: 2, n: 3 }, // 新内容只有 1 条
    ]);
    const { agent, scheduled, cancelled } = fakeAgent(db);

    await scheduleRecap(agent, "s1");

    expect(scheduled).toHaveLength(0);
    // 闸挡下连旧句柄都不碰：它若在，到点那趟自会消费，不会悬空
    expect(cancelled).toHaveLength(0);
  });

  it("到点侧：这一段没几个字，扫过推游标，不烧模型不重排", async () => {
    const db = fakeDb([
      {
        id: "s1",
        lastActive: iso(RECAP_IDLE_MS * 2),
        upto: 0,
        n: 2,
        light: true,
      },
    ]);
    const { agent, scheduled, persisted } = fakeAgent(db);

    await runSessionRecap(agent, { id: "s1" });

    expect(generateText).not.toHaveBeenCalled();
    // 销账：游标推过这一段，记一笔「想过了」—— 不是失败，不进重试
    expect(db.session("s1").upto).toBe(2);
    expect(db.session("s1").at).not.toBe("");
    expect(persisted).toHaveLength(0);
    expect(scheduled).toHaveLength(0);
  });

  it("到点侧的闸拦不住管理员：force 照跑", async () => {
    const db = fakeDb([
      {
        id: "s1",
        lastActive: iso(RECAP_IDLE_MS * 2),
        upto: 0,
        n: 2,
        light: true,
      },
    ]);
    const { agent } = fakeAgent(db);

    await runSessionRecap(agent, { id: "s1", force: true });

    expect(generateText).toHaveBeenCalledTimes(1);
  });

  it("自愈不给轻场排程：不然每场醒来一趟，白醒循环又回来了", async () => {
    const db = fakeDb([
      { id: "s1", lastActive: iso(RECAP_IDLE_MS * 2), upto: 2, n: 3 },
    ]);
    const { agent, scheduled } = fakeAgent(db);

    await resyncRecaps(agent);

    expect(scheduled).toHaveLength(0);
  });
});

/**
 * 「回想对所有场一视同仁」的契约测试。
 *
 * 这几条钉的是语句形状 —— 统一靠的是 SQL 不再做「新老 / 收没收起来」的区分，
 * 假库会照抄语义，所以这里查的是真代码拼出来的那句话本身。
 */
describe("回想统一：不再有老会话豁免", () => {
  /** 只收集语句、不执行的假库（建表 / 幂等清理这类语句没有返回可验） */
  function captureDb(): { sql: SqlTag; stmts: string[] } {
    const stmts: string[] = [];
    const tag = (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join("?").replace(/\s+/g, " ").trim();
      stmts.push(sql + " ⟦" + values.join(",") + "⟧");
      return [];
    };
    return { sql: tag as unknown as SqlTag, stmts };
  }
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ");

  it("建表不再回填「老会话一律视为已回想」", () => {
    const db = captureDb();
    ensureSessionSchema(db.sql);
    const backfill = db.stmts.find((s) =>
      norm(s).includes("update sessions set recap_upto"),
    );
    expect(backfill).toBeUndefined();
  });

  it("一次性清理只动「从没真正回想过的」：recap_at 非空的场不碰", () => {
    const db = captureDb();
    resetLegacyRecapCursors(db.sql);
    expect(db.stmts).toHaveLength(1);
    const stmt = norm(db.stmts[0]);
    expect(stmt).toContain("set recap_upto = 0");
    expect(stmt).toContain("recap_at = ''");
    expect(stmt).toContain("recap_upto > 0");
    // 幂等：条件本身保证清过一次的不再命中，不需要另立标记位
  });

  it("候选查询不再排除归档的场：收起来不是「这段过去不算数了」", () => {
    const db = captureDb();
    listRecapCandidates(db.sql, "2026-09-01T00:00:00.000Z");
    const stmt = norm(db.stmts[0] ?? "");
    expect(stmt).toContain("from sessions");
    expect(stmt).not.toContain("archived");
  });

  it("回想的分组计数只读 memories —— 会话删了，回想记下的东西还在", () => {
    const db = captureDb();
    sessionMemoryCounts(db.sql);
    const stmt = norm(db.stmts[0] ?? "");
    expect(stmt).toContain("from memories");
    expect(stmt).not.toContain("join sessions");
    expect(stmt).not.toContain("from sessions");
  });
});

/**
 * 回想提示词：口径与可覆盖。
 *
 * 早先那句「只输出一两句第一人称的收尾感想」要的是情绪，模型自然往情绪上写 ——
 * 这条线不担负情感化内容，回想的价值全在「把事情记进库」。这里钉两件事：
 * 默认出的是工作纪要（五点），以及「他默认已看到」这句不能少。
 */
describe("回想提示词：工程纪要口径", () => {
  it("默认出工作纪要：发生了什么、做了什么、什么情况、收敛什么、下一步", () => {
    const { system } = buildRecapPrompt("【对话】…");
    for (const k of [
      "发生了什么",
      "我做了什么",
      "现在处于什么情况",
      "需要收敛整理",
      "下一步",
    ]) {
      expect(system).toContain(k);
    }
    // 旧口径要的是感想；换成纪要之后它不该还在
    expect(system).not.toContain("收尾感想");
    expect(system).toContain("不写情绪");
  });

  it("写明「他默认已看到」—— 没接话不是没看到，别写成疑点", () => {
    expect(buildRecapPrompt("x").system).toContain("默认已经看过");
    expect(buildRecapPrompt("x").system).toContain("安静的时段");
  });

  it("对话正文永远接在 user 里，不被覆盖值顶掉", () => {
    expect(buildRecapPrompt("某某说了什么", "自定").user).toContain(
      "某某说了什么",
    );
  });

  it("管理员整段覆盖生效；空覆盖回落默认", () => {
    expect(buildRecapPrompt("x", "   ").system).toBe(DEFAULT_RECAP_PROMPT);
    expect(buildRecapPrompt("x", "只记事实。").system).toBe("只记事实。");
  });
});
