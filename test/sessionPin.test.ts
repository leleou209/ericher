/**
 * 会话置顶与排序契约测试。
 *
 * 只钉两件容易被改回去的事：
 *   1. 会话列表按**创建时间**倒序 —— 不再按 last_active（谁刚说过话谁上浮）。
 *      位置要能记住，发消息不该让列表换位。
 *   2. pinned 会一路透出到 SessionMeta，供前端分「置顶区」；
 *      置顶写的是时刻、取消写空串，前端才能按置顶的先后排。
 *
 * 真排序由 SQL 干，这里只认语句长什么样、字段有没有透出来。
 *
 * 运行: npx vitest run
 */

import { describe, it, expect } from "vitest";
import { listSessions, setSessionPinned } from "../src/agent/sessionStore";
import type { SqlTag } from "../src/agent/state";

function makeDb(rows: Array<Record<string, unknown>>) {
  const selects: string[] = [];
  const updates: Array<{ sql: string; values: unknown[] }> = [];

  const db = (<T>(strings: TemplateStringsArray, ...values: unknown[]): T[] => {
    const sql = strings.join("?").replace(/\s+/g, " ").trim().toLowerCase();
    if (sql.startsWith("update sessions set pinned")) {
      updates.push({ sql, values });
      return [] as T[];
    }
    if (sql.startsWith("select s.id")) {
      selects.push(sql);
      return rows as unknown as T[];
    }
    throw new Error("假库不认得这条语句：" + sql);
  }) as unknown as SqlTag;

  return { db, selects, updates };
}

const row = (over: Record<string, unknown>): Record<string, unknown> => ({
  id: "s1",
  title: "甲",
  visibility: "private",
  created: "2026-10-01T00:00:00.000Z",
  last_active: "2026-10-05T09:00:00.000Z",
  pinned: "",
  digest: "",
  archived: 0,
  named: 1,
  unread: 0,
  recap_at: "",
  home: "",
  n: 3,
  ...over,
});

describe("listSessions 的排序与置顶字段", () => {
  it("按创建时间倒序 —— 最近说过话不再影响位置", () => {
    const { db, selects } = makeDb([row({})]);
    listSessions(db);
    expect(selects[0]).toContain("order by s.created desc");
    expect(selects[0]).not.toContain("last_active desc");
  });

  it("pinned 透出到 SessionMeta：前端靠它分置顶区", () => {
    const at = "2026-10-05T08:00:00.000Z";
    const { db } = makeDb([row({ pinned: at })]);
    expect(listSessions(db)[0].pinned).toBe(at);
  });

  it("没置顶的场：pinned 是空串，不是 undefined", () => {
    const { db } = makeDb([row({ pinned: undefined as unknown as string })]);
    expect(listSessions(db)[0].pinned).toBe("");
  });
});

describe("setSessionPinned", () => {
  it("置顶：写下一个时刻，前端据此排到置顶区末尾", () => {
    const { db, updates } = makeDb([row({})]);
    setSessionPinned(db, "s1", true);
    const written = String(updates[0].values[0]);
    expect(written).not.toBe("");
    expect(Number.isNaN(Date.parse(written))).toBe(false);
  });

  it("取消置顶：写回空串", () => {
    const { db, updates } = makeDb([
      row({ pinned: "2026-10-05T08:00:00.000Z" }),
    ]);
    setSessionPinned(db, "s1", false);
    expect(updates[0].values[0]).toBe("");
  });
});
