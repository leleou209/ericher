// 「这台设备该从哪一场、哪间屋开始」的判定。
//
// 多端登录的坑：当前连的屋只活在前端内存，一刷新就回人屋默认场，于是 A、B 两端
// 各看各的。还原动作就靠这个纯函数算出来，边界（没记过、已经对上、被删、无 home）
// 全在这里钉住。

import { describe, expect, it } from "vitest";
import {
  newerViewWins,
  resolveStartView,
  type StartViewSession,
} from "../src/agent/lastView";

const BASE = "default";
const sessions: StartViewSession[] = [
  { id: "s-field", title: "场屋里的场", home: "default--s-field" },
  { id: "s-old", title: "宿在人屋的老场", home: "" },
];

describe("resolveStartView：开机该不该还原、还原到哪", () => {
  it("没记过（lastRoom/lastSession 空）→ 不动", () => {
    expect(
      resolveStartView({
        baseRoom: BASE,
        lastRoom: "",
        lastSession: "",
        sessions,
        currentSession: "s-x",
      }),
    ).toEqual({ action: "none", room: BASE, session: "s-x", title: "" });
  });

  it("已经就在那一场 → 不动", () => {
    const d = resolveStartView({
      baseRoom: BASE,
      lastRoom: "default--s-field",
      lastSession: "s-field",
      sessions,
      currentSession: "s-field",
    });
    expect(d.action).toBe("none");
  });

  it("命中且带 home → 切到那间场屋", () => {
    const d = resolveStartView({
      baseRoom: BASE,
      lastRoom: "default--s-field",
      lastSession: "s-field",
      sessions,
      currentSession: "s-other",
    });
    expect(d).toEqual({
      action: "switch",
      room: "default--s-field",
      session: "s-field",
      title: "场屋里的场",
    });
  });

  it("命中但无 home（宿在人屋的老场）→ 切回人屋那一场", () => {
    const d = resolveStartView({
      baseRoom: BASE,
      lastRoom: "default--s-old", // lastRoom 记错了也不怕：以会话的 home 为准
      lastSession: "s-old",
      sessions,
      currentSession: "s-other",
    });
    expect(d).toEqual({
      action: "switch",
      room: BASE,
      session: "s-old",
      title: "宿在人屋的老场",
    });
  });

  it("记的那一场不在清单里（被删）→ 不动，并标 stale", () => {
    const d = resolveStartView({
      baseRoom: BASE,
      lastRoom: "default--gone",
      lastSession: "s-gone",
      sessions,
      currentSession: "s-x",
    });
    expect(d.action).toBe("none");
    expect(d.stale).toBe(true);
  });

  it("只有 lastSession 没 lastRoom 也视为没记过（不许半份记录乱切）", () => {
    const d = resolveStartView({
      baseRoom: BASE,
      lastRoom: "",
      lastSession: "s-field",
      sessions,
      currentSession: "s-x",
    });
    expect(d.action).toBe("none");
    expect(d.stale).toBeUndefined();
  });
});

describe("newerViewWins：多端写回只认最新的一笔", () => {
  it("更新的一笔收下", () => {
    expect(newerViewWins(1000, 2000)).toBe(true);
  });

  it("更旧的一笔（乱序迟到 / 旧设备揣着的时刻）让路", () => {
    expect(newerViewWins(2000, 1000)).toBe(false);
  });

  it("同一毫秒里的后一笔也算数", () => {
    expect(newerViewWins(2000, 2000)).toBe(true);
  });

  it("从没记过（prevAt=0）时，任何一笔都收下", () => {
    expect(newerViewWins(0, 1)).toBe(true);
  });
});
