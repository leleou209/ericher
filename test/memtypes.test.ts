/**
 * 书册 / 图像两类记忆的测试。
 *
 * 多样化记忆类型这件事，最容易碎的是边界：
 *   · 书册的正文上限和条目不一样（条目 500 字，书册 2 万字）—— 上限写错，
 *     要么长文被悄悄腰斩，要么一句话的条目把记忆库撑成博客；
 *   · title / fileKey 存进去要原样读得回来 —— 这两列是「锦上添花」的写法，
 *     忘了进 INSERT 或忘了进 rowToEntry 都不会报错，只会让面板上所有书都没标题；
 *   · 检索打分里标题该有份量 —— 「这篇讲什么」一半写在标题里。
 *
 * fake sql 只认这一层真会发的那几条语句，认不出的直接抛错带原句：
 * 悄悄返回空数组最危险，那会让「查询写错」长得和「查出来就是没有」一模一样。
 *
 * 运行: npx vitest run
 */

import { describe, it, expect } from "vitest";
import {
  insertMemory,
  scoreMemory,
  type MemoryStats,
  type NewMemory,
} from "../src/agent/memory";
import { memoryTools } from "../src/tools/memory";
import type { ToolCtx } from "../src/tools/types";
import type { MemEntry, SqlTag } from "../src/agent/state";

/** INSERT 的列序（和 memory.ts 里的 INSERT OR REPLACE 一一对应），解析绑定值要靠它 */
const COLS = [
  "id",
  "date",
  "type",
  "tags",
  "weight",
  "shelf",
  "person",
  "visibility",
  "content",
  "accessed",
  "learned",
  "superseded_by",
  "volatility",
  "verified",
  "valid_at",
  "invalid_at",
  "conflicts_with",
  "title",
  "file_key",
  "session_id",
  "sentiment",
  "sensitivity",
  "score",
  "owner_key",
  "visibility_hold",
  "dedupe_key",
  "last_accessed_at",
] as const;

function makeDb(seed: Record<string, unknown>[] = []) {
  const rows = seed.map((r) => ({ ...r }));
  const tag = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const q = strings.join("?").replace(/\s+/g, " ").trim();

    if (q.startsWith("CREATE")) return [] as never;

    if (q.startsWith("INSERT OR REPLACE INTO memories")) {
      const rec: Record<string, unknown> = {};
      COLS.forEach((c, i) => (rec[c] = values[i]));
      const i = rows.findIndex((r) => r.id === rec.id);
      if (i >= 0) rows[i] = rec;
      else rows.push(rec);
      return [] as never;
    }

    if (q.startsWith("SELECT * FROM memories WHERE id")) {
      return rows
        .filter((r) => r.id === values[0])
        .map((r) => ({ ...r })) as never;
    }

    // insertMemory 的幂等查重：同键只落第一次
    if (q.startsWith("SELECT * FROM memories WHERE dedupe_key")) {
      return rows
        .filter((r) => r.dedupe_key === values[0])
        .map((r) => ({ ...r })) as never;
    }

    // listMemories 按书架列：只认这一条（过滤 + 限流），够测「退回本地」那条路
    if (q.startsWith("SELECT * FROM memories WHERE shelf")) {
      return rows
        .filter((r) => r.shelf === values[0] && r.superseded_by === "")
        .slice(0, values[1] as number) as never;
    }

    throw new Error(`假的 sql 没认出这条语句：${q}`);
  };
  return { sql: tag as unknown as SqlTag, rows };
}

const base = (over: Partial<NewMemory> = {}): NewMemory => ({
  type: "insight",
  content: "一句话的事",
  ...over,
});

const entryOf = (over: Partial<MemEntry> = {}): MemEntry => ({
  id: "m1",
  date: "2026-09-22",
  type: "insight",
  tags: ["insight"],
  weight: 0.5,
  shelf: "knowledge",
  person: "",
  visibility: "private",
  content: "正文",
  accessed: 0,
  learned: "2026-09-22T00:00:00.000Z",
  supersededBy: "",
  volatility: "stable",
  verified: "",
  validAt: "2026-09-22T00:00:00.000Z",
  invalidAt: "",
  conflictsWith: [],
  title: "",
  fileKey: "",
  sessionId: "",
  sentiment: "",
  // 量级：没标过的按「一般」算 —— 老数据也落这一档
  sensitivity: "normal" as const,
  score: 0,
  ...over,
  // hold 必填：over 里没给就落 false（spread 的可选属性会把类型放宽成 boolean | undefined）
  hold: over.hold ?? false,
});

describe("insertMemory：书册与图像的存取", () => {
  it("书册的标题和长正文原样落库、原样读回", () => {
    const { sql } = makeDb();
    const body = "# 示例项目改造\n\n先拆柜子，再换地板。".repeat(40);
    const entry = insertMemory(
      sql,
      base({ type: "book", title: "示例项目改造手册", content: body }),
    );
    expect(entry.title).toBe("示例项目改造手册");
    const back =
      sql`SELECT * FROM memories WHERE id = ${entry.id}`[0] as unknown as {
        title: string;
        content: string;
      };
    expect(back.title).toBe("示例项目改造手册");
    expect(back.content).toBe(body);
  });

  it("书册能装两万字，条目 500 字就到头 —— 上限不分家就全乱", () => {
    const long = "甲乙丙丁".repeat(8000); // 32000 字
    const db1 = makeDb();
    insertMemory(db1.sql, base({ type: "book", title: "长文", content: long }));
    const db2 = makeDb();
    insertMemory(db2.sql, base({ content: long }));
    expect(String(db1.rows[0].content).length).toBe(20000);
    expect(String(db2.rows[0].content).length).toBe(500);
  });

  it("图像记忆带上云盘 key，条目两列都是空串", () => {
    const db = makeDb();
    insertMemory(
      db.sql,
      base({
        type: "image",
        content: "示例项目的装修效果图",
        fileKey: "draw-1.png",
      }),
    );
    expect(db.rows[0].file_key).toBe("draw-1.png");
    expect(db.rows[0].title).toBe("");
    const plain = makeDb();
    insertMemory(plain.sql, base());
    expect(plain.rows[0].title).toBe("");
    expect(plain.rows[0].file_key).toBe("");
  });

  it("标题过长被截到 120 字，首尾空格裁掉", () => {
    const db = makeDb();
    insertMemory(
      db.sql,
      base({ type: "book", title: `  ${"书".repeat(130)}  `, content: "正文" }),
    );
    expect(String(db.rows[0].title).length).toBe(120);
    expect(String(db.rows[0].title).startsWith("书")).toBe(true);
  });

  it("回想的正文上限是 1200 字 —— 比条目宽、比书册窄", () => {
    const long = "甲乙丙丁".repeat(8000); // 32000 字
    const db = makeDb();
    insertMemory(
      db.sql,
      base({ type: "recap", shelf: "sessions", content: long }),
    );
    expect(String(db.rows[0].content).length).toBe(1200);
    // 它不是书册：书册那条路要 title，回想这条不该顺手把正文放宽到两万字
    expect(String(db.rows[0].content).length).toBeLessThan(20000);
  });
});

describe("insertMemory：会话记忆的两列", () => {
  it("session_id 和 sentiment 原样落库、原样读回", () => {
    const db = makeDb();
    const entry = insertMemory(
      db.sql,
      base({
        type: "recap",
        shelf: "sessions",
        content: "他今天在纠结要不要接那件事。",
        sessionId: "s1abc",
        sentiment: "low",
      }),
    );
    expect(entry.sessionId).toBe("s1abc");
    expect(entry.sentiment).toBe("low");
    expect(db.rows[0].session_id).toBe("s1abc");
    expect(db.rows[0].sentiment).toBe("low");
  });

  it("语气认不出来就落空串 —— 宁可没有标签，也不编一个", () => {
    const db = makeDb();
    const entry = insertMemory(db.sql, base({ sentiment: "有点说不上来" }));
    expect(entry.sentiment).toBe("");
    expect(db.rows[0].sentiment).toBe("");
  });

  it("语气大小写和空白都归一，落库的是那六个小写词", () => {
    const db = makeDb();
    expect(insertMemory(db.sql, base({ sentiment: "  WARM " })).sentiment).toBe(
      "warm",
    );
  });

  it("session_id 过长时截到 40 字 —— 它是会话主键的副本，不该撑出行宽", () => {
    const db = makeDb();
    const entry = insertMemory(db.sql, base({ sessionId: "s".repeat(80) }));
    expect(entry.sessionId.length).toBe(40);
  });

  it("普通条目这两列都是空串，不必填", () => {
    const db = makeDb();
    insertMemory(db.sql, base());
    expect(db.rows[0].session_id).toBe("");
    expect(db.rows[0].sentiment).toBe("");
  });
});

describe("insertMemory：带语气时标签里也留一份", () => {
  it("sentiment 进 tags，按标签检索才搜得到", () => {
    const db = makeDb();
    const entry = insertMemory(db.sql, base({ sentiment: "warm" }));
    expect(entry.tags).toContain("warm");
  });

  it("没有语气就不往标签里塞空串", () => {
    const db = makeDb();
    const entry = insertMemory(db.sql, base());
    expect(entry.tags).not.toContain("");
  });
});

describe("scoreMemory：标题参与检索", () => {
  it("标题命中比正文命中分高 —— 「这篇讲什么」一半写在标题里", () => {
    const kw = ["装修"];
    const byTitle = scoreMemory(
      entryOf({ type: "book", title: "装修手册", content: "别的事" }),
      kw,
    );
    const byBody = scoreMemory(
      entryOf({ type: "book", title: "手册", content: "装修的事" }),
      kw,
    );
    expect(byTitle).toBeGreaterThan(byBody);
  });

  it("老式的条目没有标题也照常打分，不炸", () => {
    expect(
      scoreMemory(entryOf({ title: "", content: "提到装修" }), ["装修"]),
    ).toBeGreaterThan(0.5);
  });
});

describe("insertMemory：标签里的逗号清洗", () => {
  it("带逗号的标签剥掉分隔符再落库 —— 伪装不开别人的门", () => {
    const db = makeDb();
    const entry = insertMemory(db.sql, base({ tags: ["自定义,工作周报"] }));
    // tag 门按 `,tag,` 匹配：标签串里混进一个带逗号的成员，
    // 存库后就长得像真开了「工作周报」那道门 —— 来客能借它把内容放出去
    const stored = String(db.rows[0].tags);
    expect(stored.split(",")).not.toContain("工作周报");
    expect(entry.tags).toEqual(["insight", "自定义工作周报"]);
  });

  it("全角逗号一样剥掉 —— 来客的输入法不该成为绕过的工具", () => {
    const db = makeDb();
    insertMemory(db.sql, base({ tags: ["自定义，工作周报"] }));
    expect(String(db.rows[0].tags).split(",")).not.toContain("工作周报");
  });
});

describe("insertMemory 的回想幂等键", () => {
  it("同键的第二次写入返回第一次那条，库里只有一行 —— 同一段不该记两遍", () => {
    const db = makeDb();
    const first = insertMemory(
      db.sql,
      base({ content: "第一遍记下的", dedupeKey: "s1:10:recap" }),
    );
    const second = insertMemory(
      db.sql,
      base({ content: "重跑时又写了一遍", dedupeKey: "s1:10:recap" }),
    );
    expect(second.id).toBe(first.id);
    expect(second.content).toBe("第一遍记下的");
    expect(db.rows.length).toBe(1);
  });

  it("不同键（不同场次或不同起点）各写各的，不互相挡", () => {
    const db = makeDb();
    insertMemory(db.sql, base({ dedupeKey: "s1:10:recap" }));
    insertMemory(db.sql, base({ dedupeKey: "s1:40:recap" }));
    insertMemory(db.sql, base({ dedupeKey: "s2:10:recap" }));
    expect(db.rows.length).toBe(3);
  });

  it("不带幂等键的写入照常落库 —— 幂等是回想的专属约定", () => {
    const db = makeDb();
    insertMemory(db.sql, base({ content: "A" }));
    insertMemory(db.sql, base({ content: "B" }));
    expect(db.rows.length).toBe(2);
    expect(db.rows.every((r) => r.dedupe_key === "")).toBe(true);
  });

  it("新条目 last_accessed_at 落 0 —— 没人用过它，不装作近期活跃", () => {
    const db = makeDb();
    insertMemory(db.sql, base());
    expect(db.rows[0].last_accessed_at).toBe(0);
  });
});

describe("memory 工具：幂等重跑不再喂向量", () => {
  const makeCtx = (
    db: ReturnType<typeof makeDb>,
    vectors: unknown[],
  ): ToolCtx =>
    ({
      sql: db.sql,
      env: {},
      state: { activeSession: "s1" },
      enqueueVector: (v: unknown) => vectors.push(v),
      recapSessionId: "s1",
      recapDedupe: "s1:10",
    }) as unknown as ToolCtx;
  const run = (ctx: ToolCtx, content: string) =>
    (
      memoryTools(ctx).memory as unknown as {
        execute: (input: unknown) => Promise<string>;
      }
    ).execute({ action: "add", type: "fact", content });

  it("同键重跑且内容变了：不重复入库，也不拿新正文喂旧 id 的向量", async () => {
    const db = makeDb();
    const vectors: unknown[] = [];
    const ctx = makeCtx(db, vectors);
    await run(ctx, "第一遍记下的");
    const again = await run(ctx, "重跑时说法变了");
    expect(db.rows).toHaveLength(1);
    expect(db.rows[0].content).toBe("第一遍记下的");
    // 向量层要是收了新正文，检索排序从此和 SQLite 里存的旧版对不上
    expect(vectors).toHaveLength(1);
    expect(again).toContain("已经记过");
  });

  it("常规写入（无幂等键）照常入库喂向量 —— 幂等保护不挡正常生意", async () => {
    const db = makeDb();
    const vectors: unknown[] = [];
    const ctx = makeCtx(db, vectors);
    delete (ctx as { recapDedupe?: string }).recapDedupe;
    await run(ctx, "普通一条");
    expect(db.rows).toHaveLength(1);
    expect(vectors).toHaveLength(1);
  });
});

describe("memory 工具：stats / list 走跨间合并入口（场屋不再误报空）", () => {
  // 场屋的本地表只装这一场写过的，光看本地必然报「空」，而 search 明明查得到。
  // 这条测试钉住那个口径：stub 一个「一碰就炸」的本地表，证明 stats/list 真走了合并入口。
  const boom = (() => {
    throw new Error("stats/list 不该再碰本地表这条读路");
  }) as unknown as SqlTag;

  const fieldStats: MemoryStats = {
    total: 12,
    gone: 1,
    shelves: [
      { shelf: "identity", n: 5 },
      { shelf: "projects", n: 6 },
    ],
    due: 2,
    unsettled: 0,
  };
  const fieldList: MemEntry[] = [
    entryOf({
      id: "m-identity",
      shelf: "identity",
      type: "fact",
      content: "他叫 ericher",
    }),
  ];

  const ctx = {
    sql: boom,
    env: {},
    state: {},
    statsMemories: async () => fieldStats,
    listMemoriesMerged: async (shelf: string | undefined) =>
      shelf === "identity" ? fieldList : [],
  } as unknown as ToolCtx;

  const exec = memoryTools(ctx).memory as unknown as {
    execute: (input: unknown) => Promise<string>;
  };

  it("stats：用合并后的全局盘点，说得清每个书架各有多少", async () => {
    const out = await exec.execute({ action: "stats" });
    expect(out).not.toContain("记忆库为空");
    expect(out).toContain("还算数的 11 条");
    expect(out).toContain("[identity] 5 条");
    expect(out).toContain("[projects] 6 条");
  });

  it("list：按书架取合并结果，本地那本空账不影响", async () => {
    const out = await exec.execute({ action: "list", shelf: "identity" });
    expect(out).toContain("[identity] 1 条");
    expect(out).toContain("m-identity");
  });

  it("ctx 没配合并入口：退回本地直读（场外房间与测试仍走得通）", async () => {
    // 假表存的是「列已落库」的形状：tags 是逗号串、bool 是 0/1，不是 MemEntry 的数组
    const local = makeDb([
      {
        id: "m-local",
        date: "2026-09-22",
        type: "insight",
        tags: "insight",
        weight: 0.5,
        shelf: "knowledge",
        person: "",
        visibility: "private",
        content: "本地一条",
        accessed: 0,
        learned: "2026-09-22T00:00:00.000Z",
        superseded_by: "",
        volatility: "stable",
        verified: "",
        valid_at: "",
        invalid_at: "",
        conflicts_with: "",
        title: "",
        file_key: "",
        session_id: "",
        sentiment: "",
        sensitivity: "normal",
        score: 0,
        visibility_hold: 0,
      },
    ]);
    const plain = {
      sql: local.sql,
      env: {},
      state: {},
    } as unknown as ToolCtx;
    const plainExec = memoryTools(plain).memory as unknown as {
      execute: (input: unknown) => Promise<string>;
    };
    await expect(
      plainExec.execute({ action: "list", shelf: "knowledge" }),
    ).resolves.toContain("本地一条");
  });
});
