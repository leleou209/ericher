// 内核 / 自我要求归主屋收着 —— 场屋里改完不能只在那一场算数。
//
// 起因：一个会话一间场屋之后，管理员聊天是在场屋里。内核原先只写在「当前这间屋」
// 的 state 上：场屋里更新完，设置页（读主屋）和下一场（另一间屋）看到的还是旧的，
// 表现就是「说保存了，回来又没了」。这里盯住两条：
//   · 主屋本尊：就地读写自己的 state；
//   · 场屋：读主屋那份缓存，写转交主屋，本地 state 不动。

import { describe, it, expect, vi } from "vitest";
import { CoworkAgent } from "../src/agent/cowork";

// 这两个包的底层拖着 cloudflare: 协议模块，vitest 的 ESM loader 加载不了。
// 只用假 this 上的家当，不碰基类 —— 空壳替掉就行（同 draftSession.test.ts）
vi.mock("@cloudflare/ai-chat", () => ({ AIChatAgent: class {} }));
vi.mock("agents", () => ({
  getCurrentAgent: () => ({ agent: undefined }),
}));

type SelfState = {
  selfModel: string;
  selfModelVer: number;
  selfLog: string[];
  selfDemand: string;
  selfDemandVer: number;
  selfDemandLog: string[];
};

function seedState(over: Partial<SelfState> = {}): SelfState {
  return {
    selfModel: "",
    selfModelVer: 0,
    selfLog: [],
    selfDemand: "",
    selfDemandVer: 0,
    selfDemandLog: [],
    ...over,
  };
}

function harness(
  name: string,
  state: SelfState,
  ownerStub?: { patchConfig: (p: Record<string, unknown>) => Promise<unknown> },
) {
  const self = Object.create(CoworkAgent.prototype) as Record<string, unknown> & {
    state: SelfState;
  };
  Object.defineProperty(self, "name", { value: name, configurable: true });
  Object.defineProperty(self, "state", {
    value: state,
    writable: true,
    configurable: true,
  });
  Object.defineProperty(self, "env", {
    value: ownerStub
      ? {
          COWORK_AGENT: {
            idFromName: (n: string) => n,
            get: () => ownerStub,
          },
        }
      : {},
    configurable: true,
  });
  self.patchState = (p: Record<string, unknown>) =>
    Object.assign(self.state, p);
  // Object.create 不跑构造器，类字段 selfCache 的初始化要手动补上（同真实实例）
  self.selfCache = {
    core: "",
    coreVer: 0,
    coreLog: [],
    demand: "",
    demandVer: 0,
    demandLog: [],
  };
  const call = <T>(method: string, ...args: unknown[]): T =>
    (
      CoworkAgent.prototype as unknown as Record<string, (...a: unknown[]) => T>
    )[method].apply(self, args) as T;
  return { self, call };
}

describe("内核/自我要求：主屋本尊就地读写", () => {
  it("readSelf 读的就是自己的 state", () => {
    const { call } = harness("default", seedState({ selfModel: "我知道什么" }));
    expect(call<{ core: string }>("readSelf").core).toBe("我知道什么");
  });

  it("writeSelfCore 就地写、版本 +1、日志留痕", async () => {
    const { self, call } = harness("default", seedState());
    const ver = await call<Promise<number>>("writeSelfCore", "新的认知");
    expect(ver).toBe(1);
    expect(self.state.selfModel).toBe("新的认知");
    expect(self.state.selfModelVer).toBe(1);
    expect(self.state.selfLog.at(-1)).toContain("新的认知");
  });

  it("content 空 = 清除", async () => {
    const { self, call } = harness("default", seedState({ selfModel: "旧" }));
    await call<Promise<number>>("writeSelfCore", "");
    expect(self.state.selfModel).toBe("");
    expect(self.state.selfLog.at(-1)).toContain("已清除");
  });
});

describe("内核/自我要求：场屋读主屋、写转交主屋", () => {
  it("初始缓存为空 → readSelf 报空，而不是悄悄读本地那份", () => {
    const { call } = harness(
      "default--s1",
      seedState({ selfModel: "场屋本地的旧值" }),
    );
    expect(call<{ core: string }>("readSelf").core).toBe("");
  });

  it("writeSelfCore 转交主屋，本地 state 不动，缓存立刻跟上", async () => {
    const owner = {
      selfModel: "主屋旧值",
      selfModelVer: 3,
      selfLog: [] as string[],
      selfDemand: "",
      selfDemandVer: 0,
      selfDemandLog: [] as string[],
    };
    const patches: Array<Record<string, unknown>> = [];
    const ownerStub = {
      getConfig: async () => owner,
      patchConfig: async (p: Record<string, unknown>) => {
        patches.push(p);
        Object.assign(owner, p);
        return owner;
      },
    };
    const { self, call } = harness("default--s1", seedState(), ownerStub);
    await call<Promise<void>>("refreshPersona"); // 连上来时抄一份主屋那份

    const ver = await call<Promise<number>>("writeSelfCore", "场屋里学到的");
    expect(ver).toBe(4); // 按主屋那份 3 算，不是场屋本地的 0
    expect(patches).toHaveLength(1);
    expect(owner.selfModel).toBe("场屋里学到的");
    // 本地那份不该被动 —— 标准件在主屋
    expect(self.state.selfModel).toBe("");
    // 同一轮里 reflect 立刻读得到
    expect(call<{ core: string }>("readSelf").core).toBe("场屋里学到的");
  });

  it("writeSelfDemand 同样转交主屋", async () => {
    const owner = {
      selfModel: "",
      selfModelVer: 0,
      selfLog: [] as string[],
      selfDemand: "旧要求",
      selfDemandVer: 1,
      selfDemandLog: [] as string[],
    };
    let seen = 0;
    const ownerStub = {
      getConfig: async () => owner,
      patchConfig: async (p: Record<string, unknown>) => {
        seen += 1;
        Object.assign(owner, p);
        return owner;
      },
    };
    const { call } = harness("default--s1", seedState(), ownerStub);
    await call<Promise<void>>("refreshPersona");
    const ver = await call<Promise<number>>("writeSelfDemand", "我要求自己…");
    expect(seen).toBe(1);
    expect(ver).toBe(2);
    expect(owner.selfDemand).toBe("我要求自己…");
    expect(call<{ demand: string }>("readSelf").demand).toBe("我要求自己…");
  });
});
