/**
 * 长期使用者身份卡（user_cards）测试。
 *
 * 卡是「你是谁、回到哪间屋」的凭据，验的是这件事的四面：
 * - 领卡：昵称全局唯一、目的必填、密码够长且不撞两个门禁码、摘要入库；
 * - 登卡：昵称+密码对上才给卡，「没这人」和「密码错」同一种返回，不给试探者报点；
 * - 房间绑定：room 记领卡那一刻的屋子 —— 临时聊着聊着升级长期，历史一条不搬；
 * - 快照与维护：对外剥摘要、touchCard 刷 last_seen、删卡干净。
 *
 * 名册用最小假 SQL 引擎，只认得 userCards.ts 会发的那几条语句。
 *
 * 运行: npx vitest run test/userCards.test.ts
 */

import { describe, it, expect } from "vitest";
import {
  COMMON_TYPE_ID,
  createUserCard,
  getUserCard,
  listUserCards,
  removeUserCard,
  toUserCardPublic,
  touchCard,
  verifyCardLogin,
} from "../src/agent/userCards";
import type { SqlTag } from "../src/agent/state";

const ENV_PW = { adminPw: "guanli", gatePw: "qiantai" };
const BASE = {
  name: "陈客",
  purpose: "谈入职接待",
  password: "card-pw-123",
  typeId: "hr",
  room: "guest-ab12cd34",
  ...ENV_PW,
};

/** 最小假 SQL 引擎：行存成 snake_case，语句按前缀认 */
function fakeDb() {
  const rows: Array<{
    id: string;
    name: string;
    purpose: string;
    email: string;
    password_hash: string;
    type_id: string;
    room: string;
    created: string;
    last_seen: string;
  }> = [];

  const db = (<T>(strings: TemplateStringsArray, ...values: unknown[]): T[] => {
    const sql = strings.join("?").replace(/\s+/g, " ").trim().toLowerCase();

    if (sql.startsWith("create table")) return [] as T[];

    if (sql.startsWith("insert into user_cards")) {
      const [
        id,
        name,
        purpose,
        email,
        password_hash,
        type_id,
        room,
        created,
        last_seen,
      ] = values as [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
      ];
      rows.push({
        id,
        name,
        purpose,
        email,
        password_hash,
        type_id,
        room,
        created,
        last_seen,
      });
      return [] as T[];
    }

    if (sql.startsWith("update user_cards set")) {
      // 登卡命中旧格式时的就地升级：只写 password_hash 一格
      if (sql.startsWith("update user_cards set password_hash =")) {
        const [passwordHash, id] = values as [string, string];
        const row = rows.find((r) => r.id === id);
        if (!row) throw new Error("假库：升级密码没找到行");
        row.password_hash = passwordHash;
        return [] as T[];
      }
      const [last_seen, id] = values as [string, string];
      const row = rows.find((r) => r.id === id);
      if (!row) throw new Error("假库：update 没找到行");
      row.last_seen = last_seen;
      return [] as T[];
    }

    if (sql.startsWith("delete from user_cards")) {
      const [id] = values as [string];
      const i = rows.findIndex((r) => r.id === id);
      if (i >= 0) rows.splice(i, 1);
      return [] as T[];
    }

    if (sql.startsWith("select id from user_cards")) {
      if (sql.includes("where name")) {
        const [name] = values as [string];
        return rows
          .filter((r) => r.name === name)
          .map((r) => ({ id: r.id })) as T[];
      }
      const [id] = values as [string];
      return rows.filter((r) => r.id === id).map((r) => ({ id: r.id })) as T[];
    }

    if (sql.startsWith("select id, name")) {
      if (sql.includes("where name")) {
        const [name] = values as [string];
        return rows.filter((r) => r.name === name) as T[];
      }
      if (sql.includes("where id")) {
        const [id] = values as [string];
        return rows.filter((r) => r.id === id) as T[];
      }
      return [...rows] as T[];
    }

    throw new Error("假库不认得这条语句：" + sql);
  }) as unknown as SqlTag;

  return { db, rows };
}

describe("领卡", () => {
  it("建卡读得回来：id 8 位 hex、密码是摘要、typeId/room 都记着", async () => {
    const { db } = fakeDb();
    const card = await createUserCard(db, BASE);
    expect(card.id).toMatch(/^[0-9a-f]{8}$/);
    expect(card.name).toBe("陈客");
    expect(card.passwordHash).toMatch(/^v2\$[0-9a-f]{32}\$[0-9a-f]{64}$/);
    expect(card.typeId).toBe("hr");
    expect(card.room).toBe("guest-ab12cd34");
    expect(card.created).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(card.lastSeen).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(getUserCard(db, card.id)?.name).toBe("陈客");
    expect(listUserCards(db)).toHaveLength(1);
  });

  it("昵称全局唯一：重了抛，且提醒可以直接登卡", async () => {
    const { db } = fakeDb();
    await createUserCard(db, BASE);
    await expect(
      createUserCard(db, { ...BASE, password: "another-pw" }),
    ).rejects.toThrow(/已经有人用了.*登卡/);
  });

  it("昵称按 trim 后比对唯一；空昵称抛", async () => {
    const { db } = fakeDb();
    await createUserCard(db, BASE);
    // 「 陈客 」trim 之后和已占用的「陈客」是同一个人
    await expect(
      createUserCard(db, { ...BASE, name: " 陈客 " }),
    ).rejects.toThrow(/已经有人用了/);
    await expect(createUserCard(db, { ...BASE, name: "   " })).rejects.toThrow(
      /昵称不能为空/,
    );
  });

  it("目的必填：长期身份不说来意不给卡", async () => {
    const { db } = fakeDb();
    await expect(
      createUserCard(db, { ...BASE, purpose: "   " }),
    ).rejects.toThrow(/来意/);
  });

  it("密码至少 6 位；和管理员、门禁两个口令撞了都抛", async () => {
    const { db } = fakeDb();
    await expect(
      createUserCard(db, { ...BASE, password: "12345" }),
    ).rejects.toThrow(/至少 6 位/);
    await expect(
      createUserCard(db, { ...BASE, password: "guanli" }),
    ).rejects.toThrow(/管理员口令/);
    await expect(
      createUserCard(db, { ...BASE, password: "qiantai" }),
    ).rejects.toThrow(/门禁口令/);
  });

  it("email 可选：登记的 trim 收进卡里，没给就是空串", async () => {
    const { db } = fakeDb();
    const withMail = await createUserCard(db, {
      ...BASE,
      email: " hr@example.com ",
    });
    expect(withMail.email).toBe("hr@example.com");
    const noMail = await createUserCard(db, { ...BASE, name: "李客" });
    expect(noMail.email).toBe("");
  });

  it("typeId 没给：归内置通用档", async () => {
    const { db } = fakeDb();
    const card = await createUserCard(db, { ...BASE, typeId: "" });
    expect(card.typeId).toBe(COMMON_TYPE_ID);
  });
});

describe("登卡", () => {
  it("昵称+密码对上：返回那张卡，房间就是绑定那间", async () => {
    const { db } = fakeDb();
    const made = await createUserCard(db, BASE);
    const hit = await verifyCardLogin(db, "陈客", "card-pw-123");
    expect(hit?.id).toBe(made.id);
    expect(hit?.room).toBe("guest-ab12cd34");
    expect(hit?.purpose).toBe("谈入职接待");
  });

  it("密码错、查无此人、空参数：一律 null —— 不区分哪种错，不给试探者报点", async () => {
    const { db } = fakeDb();
    await createUserCard(db, BASE);
    expect(await verifyCardLogin(db, "陈客", "wrong-pw")).toBeNull();
    expect(await verifyCardLogin(db, "没这人", "card-pw-123")).toBeNull();
    expect(await verifyCardLogin(db, "", "card-pw-123")).toBeNull();
    expect(await verifyCardLogin(db, "陈客", "")).toBeNull();
  });

  it("登卡昵称也走 trim：带空格照样进", async () => {
    const { db } = fakeDb();
    await createUserCard(db, BASE);
    expect(await verifyCardLogin(db, " 陈客 ", "card-pw-123")).not.toBeNull();
  });
});

describe("口令胡椒（PASSWORD_PEPPER）", () => {
  const PEPPER = "pepper-for-tests";

  it("配了胡椒：卡摘要落 v2p，原密码照验", async () => {
    const { db } = fakeDb();
    const made = await createUserCard(db, BASE, PEPPER);
    expect(made.passwordHash).toMatch(/^v2p\$[0-9a-f]{32}\$[0-9a-f]{64}$/);
    const hit = await verifyCardLogin(db, "陈客", "card-pw-123", PEPPER);
    expect(hit?.id).toBe(made.id);
  });

  it("胡椒不对或没配：登不进去 —— 只拿到库的人撞不出明文", async () => {
    const { db } = fakeDb();
    await createUserCard(db, BASE, PEPPER);
    expect(
      await verifyCardLogin(db, "陈客", "card-pw-123", "wrong-pepper"),
    ).toBeNull();
    expect(await verifyCardLogin(db, "陈客", "card-pw-123")).toBeNull();
  });

  it("先无胡椒领卡、后配胡椒：登一次就升级成 v2p", async () => {
    const { db, rows } = fakeDb();
    const made = await createUserCard(db, BASE);
    expect(rows.find((r) => r.id === made.id)!.password_hash).toMatch(/^v2\$/);
    expect(await verifyCardLogin(db, "陈客", "card-pw-123", PEPPER)).not.toBeNull();
    expect(rows.find((r) => r.id === made.id)!.password_hash).toMatch(/^v2p\$/);
  });
});

describe("维护与快照", () => {
  it("touchCard 刷 last_seen，其他字段不动", async () => {
    const { db, rows } = fakeDb();
    const card = await createUserCard(db, BASE);
    const before = rows[0].last_seen;
    await new Promise((r) => setTimeout(r, 5));
    touchCard(db, card.id);
    expect(rows[0].last_seen >= before).toBe(true);
    const after = getUserCard(db, card.id)!;
    expect(after.name).toBe("陈客");
    expect(after.created).toBe(card.created);
  });

  it("对外快照剥摘要；库里躺着的是摘要不是明文", async () => {
    const { db } = fakeDb();
    const card = await createUserCard(db, BASE);
    const pub = toUserCardPublic(getUserCard(db, card.id)!);
    expect(pub).not.toHaveProperty("passwordHash");
    expect(JSON.stringify(pub)).not.toContain("card-pw-123");
    expect(pub.name).toBe("陈客");
  });

  it("删卡：在了返回 true，没了返回 false；删完登卡不再命中", async () => {
    const { db } = fakeDb();
    const card = await createUserCard(db, BASE);
    expect(removeUserCard(db, card.id)).toBe(true);
    expect(removeUserCard(db, card.id)).toBe(false);
    expect(await verifyCardLogin(db, "陈客", "card-pw-123")).toBeNull();
  });
});
