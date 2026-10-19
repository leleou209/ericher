/**
 * DO 那一侧的现查（cardPerm）：一张卡隔着间问「我这一档有没有矩阵权」。
 *
 * 这一层今天全被 HTTP 测试用假 agent 顶掉了，所以它自己最可能出的那种错
 * （读错列、把 permPublic 当成 permMatrix、停用档还照发）没人盯得住。
 * 这里不起运行时：拿真 SQLite 建真表，用 prototype.call 顶着假 this 把 DO 方法跑起来
 * —— 名册、卡、四档权益都是真模块写进去的真行。
 *
 * 运行: npx vitest run test/permMatrixCardPerm.test.ts
 */

import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import {
  COMMON_TYPE_ID,
  createGuestType,
  listGuestTypes,
  updateGuestType,
  type GuestCardPerm,
} from "../src/agent/guestTypes";
import { createUserCard } from "../src/agent/userCards";
import { CoworkAgent } from "../src/agent/cowork";
import type { SqlTag } from "../src/agent/state";

vi.mock("@cloudflare/ai-chat", () => ({ AIChatAgent: class {} }));
vi.mock("agents", () => ({ getCurrentAgent: () => ({ agent: undefined }) }));

const PW = { adminPw: "guanli", gatePw: "qiantai" };

/** DO 方法只吃 this.db：顶着假 this  call 出来就是真实现 */
const cardPerm = (
  CoworkAgent.prototype as unknown as {
    cardPerm: (
      this: { db: SqlTag },
      cardId: string,
      perm: GuestCardPerm,
    ) => Promise<boolean>;
  }
).cardPerm;

function database() {
  const db = new DatabaseSync(":memory:");
  const sql = ((
    strings: TemplateStringsArray,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ...values: any[]
  ): unknown[] => db.prepare(strings.join("?")).all(...values)) as SqlTag;
  return { db, sql };
}

async function cardAndType(sql: SqlTag, typeId?: string) {
  const type = typeId
    ? { id: typeId }
    : await createGuestType(sql, {
        name: "协作档",
        password: "hz-card-pw",
        ...PW,
      });
  const card = await createUserCard(sql, {
    name: "陈客",
    purpose: "谈合作",
    password: "card-pw-123",
    typeId: type.id,
    room: "guest-ab12cd34",
    ...PW,
  });
  return { type, card };
}

it("档位开不开这一档，隔间问答的就是什么；别的权益不算数", async () => {
  const { db, sql } = database();
  try {
    const { type, card } = await cardAndType(sql);
    const ask = (perm: GuestCardPerm) => cardPerm.call({ db: sql }, card.id, perm);

    // 建档缺省：四项全没有
    expect(await ask("permMatrix")).toBe(false);
    // 老三项开着不许顶替矩阵权 —— 读错列这类错位错就在这条上红
    await updateGuestType(sql, type.id, {
      permNotes: true,
      permFiles: true,
      permPublic: true,
      ...PW,
    });
    expect(await ask("permNotes")).toBe(true);
    expect(await ask("permFiles")).toBe(true);
    expect(await ask("permPublic")).toBe(true);
    expect(await ask("permMatrix")).toBe(false);
    // 打开矩阵权：只动这一格，其余三项不受影响
    await updateGuestType(sql, type.id, { permMatrix: true, ...PW });
    expect(await ask("permMatrix")).toBe(true);
    expect(await ask("permNotes")).toBe(true);
    // 收回
    await updateGuestType(sql, type.id, { permMatrix: false, ...PW });
    expect(await ask("permMatrix")).toBe(false);
  } finally {
    db.close();
  }
});

it("没这张卡、档位停用、档位被删：矩阵权一律按没有算", async () => {
  const { db, sql } = database();
  try {
    const { type, card } = await cardAndType(sql);
    await updateGuestType(sql, type.id, { permMatrix: true, ...PW });
    expect(await cardPerm.call({ db: sql }, card.id, "permMatrix")).toBe(true);
    expect(await cardPerm.call({ db: sql }, "nobody", "permMatrix")).toBe(false);
    // 停用不是删除：名册里还在，但权益核实的尺过滤 active —— 收回当场生效
    await updateGuestType(sql, type.id, { active: false, ...PW });
    expect(await cardPerm.call({ db: sql }, card.id, "permMatrix")).toBe(false);
    // 老三项在停用档上同样按没有算（这条是既有口径，别被这轮改动放开）
    expect(await cardPerm.call({ db: sql }, card.id, "permNotes")).toBe(false);
  } finally {
    db.close();
  }
});

it("内置通用档：名册里那一行关着就是关着；行没了重种回来也带着关", async () => {
  const { db, sql } = database();
  try {
    listGuestTypes(sql); // 种入内置通用档
    const { card } = await cardAndType(sql, COMMON_TYPE_ID);
    const ask = (perm: GuestCardPerm) =>
      cardPerm.call({ db: sql }, card.id, perm);
    expect(await ask("permNotes")).toBe(true);
    expect(await ask("permMatrix")).toBe(false);
    // 管理员逐件放行通用档：走的是名册上真实的那一行
    await updateGuestType(sql, COMMON_TYPE_ID, { permMatrix: true, ...PW });
    expect(await ask("permMatrix")).toBe(true);
    await updateGuestType(sql, COMMON_TYPE_ID, { permMatrix: false, ...PW });
    expect(await ask("permMatrix")).toBe(false);
    // 行整个没了（被删 / 建表跑歪）：下一次核实现场会重种内置档 ——
    // 种回来的这份老三项维持历史全开，矩阵权照旧是关
    db.exec("DELETE FROM guest_types WHERE id='common'");
    expect(await ask("permNotes")).toBe(true);
    expect(await ask("permMatrix")).toBe(false);
  } finally {
    db.close();
  }
});
