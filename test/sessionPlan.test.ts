// 本场计划（第三层）：会话内的目标与步骤。
//
// 钉住三件事，都是容易被顺手改坏、又不该改的：
//   1. session_tasks 的**整表替换**语义：删该场全部再按 seq 重插，读写往返一致、有序、封顶 20 条；
//   2. 是按 session_id **分场**的 —— 一间屋能装好几场，串了场就等于把 A 场的步骤摆给 B 场；
//   3. sessionPlanBlock 的分支：全空返回空串、只出有内容的那一段、来客那间一律不出。
//
// 运行: npx vitest run

import { describe, it, expect, vi } from "vitest";
import {
  SESSION_TASK_CAP,
  listSessionTasks,
  saveSessionTasks,
  type SessionTask,
} from "../src/agent/sessionStore";
import type { SqlTag } from "../src/agent/state";
import { CoworkAgent } from "../src/agent/cowork";

// 这两个包的底层拖着 cloudflare: 协议模块，vitest 的 ESM loader 加载不了。
// 只用假 this 上的家当，不碰基类 —— 空壳替掉就行（同 selfCore.test.ts）
vi.mock("@cloudflare/ai-chat", () => ({ AIChatAgent: class {} }));
vi.mock("agents", () => ({
  getCurrentAgent: () => ({ agent: undefined }),
}));

type Row = {
  session_id: string;
  seq: number;
  title: string;
  desc: string;
  status: string;
  created: string;
};

function norm(strings: TemplateStringsArray): string {
  return strings.join("?").replace(/\s+/g, " ").trim().toLowerCase();
}

/** 认得 session_tasks 三条语句的假库：删 / 插 / 查。查按 seq 升序回。 */
function tasksDb() {
  let rows: Row[] = [];
  const db = (<T>(strings: TemplateStringsArray, ...values: unknown[]): T[] => {
    const sql = norm(strings);
    if (sql.startsWith("delete from session_tasks where session_id")) {
      rows = rows.filter((r) => r.session_id !== values[0]);
      return [] as T[];
    }
    if (sql.startsWith("insert into session_tasks")) {
      const [session_id, seq, title, desc, status, created] = values as [
        string,
        number,
        string,
        string,
        string,
        string,
      ];
      rows.push({ session_id, seq, title, desc, status, created });
      return [] as T[];
    }
    if (
      sql.startsWith("select title, desc, status, created from session_tasks")
    ) {
      const sid = values[0];
      return rows
        .filter((r) => r.session_id === sid)
        .sort((a, b) => a.seq - b.seq) as unknown as T[];
    }
    throw new Error("假库不认得这条语句：" + sql);
  }) as unknown as SqlTag;
  return db;
}

const task = (over: Partial<SessionTask> = {}): SessionTask => ({
  title: "第一步",
  desc: "",
  status: "todo",
  created: "2026-10-09T00:00:00.000Z",
  ...over,
});

describe("session_tasks：整体替换 + 往返一致", () => {
  it("存进去再读回来，顺序与状态原样", () => {
    const db = tasksDb();
    const list = [
      task({ title: "先看清需求", status: "done" }),
      task({ title: "写方案", status: "doing", desc: "两页就够" }),
      task({ title: "落成代码", status: "todo" }),
    ];
    saveSessionTasks(db, "s1", list);
    const back = listSessionTasks(db, "s1");
    expect(back.map((t) => t.title)).toEqual([
      "先看清需求",
      "写方案",
      "落成代码",
    ]);
    expect(back.map((t) => t.status)).toEqual(["done", "doing", "todo"]);
    expect(back[1].desc).toBe("两页就够");
  });

  it("再存一次是整表替换：旧的被清掉，不是叠加", () => {
    const db = tasksDb();
    saveSessionTasks(db, "s1", [
      task({ title: "旧一" }),
      task({ title: "旧二" }),
    ]);
    saveSessionTasks(db, "s1", [task({ title: "新一" })]);
    expect(listSessionTasks(db, "s1").map((t) => t.title)).toEqual(["新一"]);
  });

  it("超过 20 条截断：只留前 20 条", () => {
    const db = tasksDb();
    const many = Array.from({ length: SESSION_TASK_CAP + 5 }, (_, i) =>
      task({ title: `第 ${i} 步` }),
    );
    saveSessionTasks(db, "s1", many);
    const back = listSessionTasks(db, "s1");
    expect(back).toHaveLength(SESSION_TASK_CAP);
    expect(back[0].title).toBe("第 0 步");
    expect(back.at(-1)!.title).toBe(`第 ${SESSION_TASK_CAP - 1} 步`);
  });

  it("按 session_id 分场：存了 A 场不影响 B 场", () => {
    const db = tasksDb();
    saveSessionTasks(db, "s1", [task({ title: "A 场的活" })]);
    saveSessionTasks(db, "s2", [task({ title: "B 场的活" })]);
    expect(listSessionTasks(db, "s1").map((t) => t.title)).toEqual([
      "A 场的活",
    ]);
    expect(listSessionTasks(db, "s2").map((t) => t.title)).toEqual([
      "B 场的活",
    ]);
  });

  it("认不得的状态回落 todo，缺 desc/created 补空串", () => {
    const db = (<T>(strings: TemplateStringsArray): T[] => {
      const sql = norm(strings);
      if (sql.startsWith("select title, desc, status, created"))
        return [
          {
            title: "野状态",
            desc: null,
            status: "weird",
            created: null,
          },
        ] as unknown as T[];
      throw new Error("假库不认得这条语句：" + sql);
    }) as unknown as SqlTag;
    const back = listSessionTasks(db, "s1");
    expect(back[0].status).toBe("todo");
    expect(back[0].desc).toBe("");
    expect(back[0].created).toBe("");
  });
});

/** sessionPlanBlock 要用到的东西：名字（判主/客）、state.activeSession、db。 */
function planHarness(
  name: string,
  activeSession: string,
  goal: string,
  rows: Array<{
    title: string;
    desc?: string;
    status: string;
    created?: string;
  }>,
) {
  const self = Object.create(CoworkAgent.prototype) as Record<
    string,
    unknown
  > & {
    state: { activeSession: string };
  };
  Object.defineProperty(self, "name", { value: name, configurable: true });
  Object.defineProperty(self, "state", {
    value: { activeSession },
    writable: true,
    configurable: true,
  });
  Object.defineProperty(self, "db", {
    value: (<T>(strings: TemplateStringsArray): T[] => {
      const sql = norm(strings);
      if (sql.includes("select goal from sessions"))
        return (goal ? [{ goal }] : []) as unknown as T[];
      if (sql.includes("from session_tasks"))
        return rows.map((r) => ({
          title: r.title,
          desc: r.desc ?? "",
          status: r.status,
          created: r.created ?? "",
        })) as unknown as T[];
      throw new Error("假库不认得这条语句：" + sql);
    }) as unknown as SqlTag,
    configurable: true,
  });
  // ensureSessions 只管建表，测试里不需要
  self.ensureSessions = () => {};
  const block = (): string =>
    (
      CoworkAgent.prototype as unknown as {
        sessionPlanBlock: () => string;
      }
    ).sessionPlanBlock.apply(self) as string;
  return { self, block };
}

describe("sessionPlanBlock：只出有内容的那一段", () => {
  it("目标与步骤都空 → 整块不出", () => {
    const { block } = planHarness("default", "s1", "", []);
    expect(block()).toBe("");
  });

  it("只有目标 → 出目标段，不出步骤段", () => {
    const { block } = planHarness("default", "s1", "把这一场的话理清楚", []);
    const out = block();
    expect(out).toContain("## 本场目标");
    expect(out).toContain("把这一场的话理清楚");
    expect(out).not.toContain("## 本场步骤");
  });

  it("只有步骤 → 出步骤段，按状态配图标", () => {
    const { block } = planHarness("default", "s1", "", [
      { title: "看需求", status: "done" },
      { title: "写方案", status: "doing" },
      { title: "写代码", status: "todo" },
    ]);
    const out = block();
    expect(out).toContain("## 本场步骤（3）");
    expect(out).toContain("✅ 看需求");
    expect(out).toContain("🔄 写方案");
    expect(out).toContain("📋 写代码");
    expect(out).not.toContain("## 本场目标");
  });

  it("两样都有 → 目标在前、步骤在后", () => {
    const { block } = planHarness("default", "s1", "上线这一版", [
      { title: "自测", status: "todo" },
    ]);
    const out = block();
    expect(out.indexOf("## 本场目标")).toBeLessThan(out.indexOf("## 本场步骤"));
  });

  it("还没在正经一场里（activeSession 空）→ 不出", () => {
    const { block } = planHarness("default", "", "有目标", [
      { title: "有步骤", status: "todo" },
    ]);
    expect(block()).toBe("");
  });

  it("来客那间一律不出 —— 没有「这一场要办成什么」", () => {
    const { block } = planHarness("guest-room-1", "s1", "目标", [
      { title: "步骤", status: "todo" },
    ]);
    expect(block()).toBe("");
  });

  it("表没补好（查表抛错）→ 吞掉，不拖垮这一轮", () => {
    const self = Object.create(CoworkAgent.prototype) as Record<
      string,
      unknown
    > & {
      state: { activeSession: string };
    };
    Object.defineProperty(self, "name", {
      value: "default",
      configurable: true,
    });
    Object.defineProperty(self, "state", {
      value: { activeSession: "s1" },
      writable: true,
      configurable: true,
    });
    Object.defineProperty(self, "db", {
      value: (() => {
        throw new Error("no such table: session_tasks");
      }) as unknown as SqlTag,
      configurable: true,
    });
    self.ensureSessions = () => {};
    const out = (
      CoworkAgent.prototype as unknown as {
        sessionPlanBlock: () => string;
      }
    ).sessionPlanBlock.apply(self) as string;
    expect(out).toBe("");
  });
});
