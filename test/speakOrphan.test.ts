// speak 的三条投递路：提醒/盯梢到点说的话，究竟落在哪儿。
//
// 起因：这句话本该回「当初约定它的那一场」。那一场被删之后，旧代码把它塞进
// 当前对话 —— 一句本属于别场的话凭空冒出来，就是串场。这里盯住三条路：
//   那场正开着      → 进当前对话流
//   那场还在、没开  → 只写进它的历史
//   那场已经删了    → 哪一场都不进（连 notice 也不发）
//
// 用假 this：Object.create(CoworkAgent.prototype) 绕开构造器，只摆上 speak 要用的家当。
// sessionStore 整块替掉，好让「那场在不在」由测试说了算。

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@cloudflare/ai-chat", () => ({ AIChatAgent: class {} }));
vi.mock("agents", () => ({ getCurrentAgent: () => ({ agent: undefined }) }));
vi.mock("../src/agent/sessionStore", () => ({
  getSession: vi.fn(),
  appendSessionMessage: vi.fn(),
  touchSession: vi.fn(),
}));

import { CoworkAgent } from "../src/agent/cowork";
import * as sessionStore from "../src/agent/sessionStore";

const getSession = vi.mocked(sessionStore.getSession);
const appendSessionMessage = vi.mocked(sessionStore.appendSessionMessage);
const touchSession = vi.mocked(sessionStore.touchSession);

interface Harness {
  /** 返回值就是「他此刻在不在跟前」那条判据：邮件副本按它决定寄不寄 */
  speak: (sessionId: string, line: string) => Promise<string>;
  persisted: unknown[][];
  notices: string[];
}

function harness(activeSession: string): Harness {
  const self = Object.create(CoworkAgent.prototype) as Record<string, unknown>;
  const persisted: unknown[][] = [];
  const notices: string[] = [];
  // db / state / messages 在原型上是 getter，直接赋值会被挡下 —— 一律就地 define
  const define = (k: string, v: unknown) =>
    Object.defineProperty(self, k, {
      value: v,
      writable: true,
      configurable: true,
    });
  define("db", {});
  define("messages", []);
  define("state", { activeSession });
  define("persistMessages", async (m: unknown[]) => {
    persisted.push(m);
  });
  define("notify", (s: string) => {
    notices.push(s);
  });
  const proto = CoworkAgent.prototype as unknown as {
    speak: (this: unknown, sessionId: string, line: string) => Promise<string>;
  };
  return {
    speak: (sessionId, line) => proto.speak.call(self, sessionId, line),
    persisted,
    notices,
  };
}

beforeEach(() => {
  getSession.mockReset();
  appendSessionMessage.mockReset();
  touchSession.mockReset();
  // 丢话那条会打一行 warn，测试输出里没必要看它
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("speak：提醒落在哪儿", () => {
  it("那场正开着 → 进当前对话流，并广播 notice", async () => {
    getSession.mockReturnValue({ id: "s1" } as never);
    const h = harness("s1");
    expect(await h.speak("s1", "到点了")).toBe("live");
    expect(h.persisted).toHaveLength(1);
    expect(appendSessionMessage).not.toHaveBeenCalled();
    expect(h.notices).toEqual(["到点了"]);
  });

  it("那场还在、只是没开 → 只写进它的历史，不打断当前场", async () => {
    getSession.mockReturnValue({ id: "s1" } as never);
    const h = harness("s2");
    // 他在界面前但在别一场：这句话只进了历史 —— 对邮件副本来说这算「没当场听到」
    expect(await h.speak("s1", "到点了")).toBe("history");
    expect(appendSessionMessage).toHaveBeenCalledTimes(1);
    expect(touchSession).toHaveBeenCalledTimes(1);
    expect(h.persisted).toHaveLength(0);
  });

  it("那场已经删了 → 哪一场都不进，也不发 notice（不串场）", async () => {
    getSession.mockReturnValue(null);
    const h = harness("s2");
    await h.speak("s1", "到点了");
    expect(h.persisted).toHaveLength(0);
    expect(appendSessionMessage).not.toHaveBeenCalled();
    expect(touchSession).not.toHaveBeenCalled();
    expect(h.notices).toEqual([]);
  });
});
