/**
 * 事件台账测试。
 *
 * 验的都是「一条动静该怎么报」这件小事：
 * - local 账按会话隔离 —— 别场取不到（串场就是这么防的）
 * - 报过就划掉 —— 同一条不会报第二次
 * - global 账不分会话，但同一屋同一类动静有去重窗口（重连不刷屏）
 * - 裁账：已投递且过期的清掉，剩下的按条数封顶
 *
 * 用最小假 SQL 引擎，只认得 events.ts 会发的那几条语句。
 *
 * 运行: npx vitest run
 */

import { describe, it, expect } from "vitest";
import {
  formatEventAt,
  hasRecentEvent,
  insertEvent,
  listPendingEvents,
  markEventsDelivered,
  pruneEvents,
  shanghaiIso,
} from "../src/agent/events";
import type { SqlTag } from "../src/agent/state";

type Row = Record<string, unknown>;

function fakeDb() {
  let rows: Row[] = [];
  const db = (<T>(strings: TemplateStringsArray, ...values: unknown[]): T[] => {
    const sql = strings.join("?").replace(/\s+/g, " ").trim().toLowerCase();
    if (sql.startsWith("create")) return [] as T[];

    if (sql.startsWith("insert into events")) {
      const [id, scope, session_id, ref, kind, at, text, created] = values;
      rows.push({
        id,
        scope,
        session_id,
        ref,
        kind,
        at,
        text,
        status: "pending",
        created,
      });
      return [] as T[];
    }

    if (sql.startsWith("update events set status")) {
      const [id] = values;
      rows = rows.map((r) => (r.id === id ? { ...r, status: "delivered" } : r));
      return [] as T[];
    }

    if (sql.includes("count(*) as n")) {
      const [scope, ref, kind, since] = values;
      const n = rows.filter(
        (r) =>
          r.scope === scope &&
          r.ref === ref &&
          r.kind === kind &&
          String(r.created) > String(since),
      ).length;
      return [{ n }] as T[];
    }

    if (sql.startsWith("select id, scope")) {
      const isLocal = sql.includes("'local'");
      let out = rows.filter((r) => r.status === "pending");
      let limit: unknown;
      if (isLocal) {
        const [sessionId, lim] = values;
        limit = lim;
        out = out.filter(
          (r) => r.scope === "local" && r.session_id === sessionId,
        );
      } else {
        const [lim] = values;
        limit = lim;
        out = out.filter((r) => r.scope === "global");
      }
      out = [...out].sort((a, b) => String(a.at).localeCompare(String(b.at)));
      return out.slice(0, Number(limit)) as T[];
    }

    if (sql.startsWith("delete from events where status")) {
      const [cutoff] = values;
      rows = rows.filter(
        (r) =>
          !(r.status === "delivered" && String(r.created) < String(cutoff)),
      );
      return [] as T[];
    }

    if (sql.startsWith("delete from events where id not in")) {
      const [cap] = values;
      const keep = new Set(
        [...rows]
          .sort((a, b) => String(b.created).localeCompare(String(a.created)))
          .slice(0, Number(cap))
          .map((r) => r.id),
      );
      rows = rows.filter((r) => keep.has(r.id));
      return [] as T[];
    }

    throw new Error("unexpected sql: " + sql);
  }) as unknown as SqlTag;
  return { db, rows: () => rows };
}

describe("事件台账：时刻格式化", () => {
  it("shanghaiIso 转成带 +08:00 的北京时间", () => {
    expect(shanghaiIso(new Date("2026-10-05T06:30:00Z"))).toBe(
      "2026-10-05T14:30:00+08:00",
    );
  });

  it("formatEventAt 只留到分钟，好读", () => {
    expect(formatEventAt("2026-10-05T14:30:00+08:00")).toBe("2026-10-05 14:30");
  });
});

describe("事件台账：local 账按会话隔离、报过即划", () => {
  it("只取本会话的待报账，别场取不到", () => {
    const { db } = fakeDb();
    insertEvent(db, {
      scope: "local",
      sessionId: "s1",
      kind: "comment",
      text: "s1 的评论",
    });
    insertEvent(db, {
      scope: "local",
      sessionId: "s2",
      kind: "comment",
      text: "s2 的评论",
    });
    const s1 = listPendingEvents(db, "local", "s1");
    expect(s1.map((e) => e.text)).toEqual(["s1 的评论"]);
    expect(listPendingEvents(db, "local", "s3")).toEqual([]);
  });

  it("说过就划掉，不再报第二次", () => {
    const { db } = fakeDb();
    const row = insertEvent(db, {
      scope: "local",
      sessionId: "s1",
      kind: "comment",
      text: "一条评论",
    });
    expect(listPendingEvents(db, "local", "s1")).toHaveLength(1);
    markEventsDelivered(db, [row.id]);
    expect(listPendingEvents(db, "local", "s1")).toEqual([]);
  });

  it("按发生时刻排序", () => {
    const { db } = fakeDb();
    insertEvent(db, {
      scope: "local",
      sessionId: "s1",
      kind: "comment",
      at: "2026-10-05T15:00:00+08:00",
      text: "后",
    });
    insertEvent(db, {
      scope: "local",
      sessionId: "s1",
      kind: "comment",
      at: "2026-10-05T14:00:00+08:00",
      text: "先",
    });
    expect(listPendingEvents(db, "local", "s1").map((e) => e.text)).toEqual([
      "先",
      "后",
    ]);
  });
});

describe("事件台账：global 账与去重", () => {
  it("global 账不分会话，谁都取得到一份待报的", () => {
    const { db } = fakeDb();
    insertEvent(db, {
      scope: "global",
      ref: "guest-a",
      kind: "visitor-join",
      text: "到了",
    });
    expect(listPendingEvents(db, "global", "")).toHaveLength(1);
    // 取 global 时即便点名了会话，也不该被会话过滤掉
    expect(listPendingEvents(db, "global", "s1")).toHaveLength(1);
  });

  it("同一屋同一类动静在窗口内只认一条", () => {
    const { db } = fakeDb();
    insertEvent(db, {
      scope: "global",
      ref: "guest-a",
      kind: "visitor-join",
      text: "到了",
    });
    expect(
      hasRecentEvent(db, "global", "guest-a", "visitor-join", 3600_000),
    ).toBe(true);
    expect(
      hasRecentEvent(db, "global", "guest-b", "visitor-join", 3600_000),
    ).toBe(false);
    expect(
      hasRecentEvent(db, "global", "guest-a", "visitor-message", 3600_000),
    ).toBe(false);
    // 窗口为 0 = 不设窗口：刚写的这条不算「窗口内」（调用方本来也会短路掉这一问）
    expect(hasRecentEvent(db, "global", "guest-a", "visitor-join", 0)).toBe(
      false,
    );
  });
});

describe("事件台账：裁账", () => {
  it("按条数封顶，只留最近的几笔", () => {
    const { db, rows } = fakeDb();
    for (let i = 0; i < 6; i++)
      insertEvent(db, {
        scope: "local",
        sessionId: "s1",
        kind: "comment",
        text: "c" + i,
      });
    pruneEvents(db, 3);
    expect(rows()).toHaveLength(3);
  });
});
