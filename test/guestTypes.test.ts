/**
 * 多档来客类型（guest_types）测试。
 *
 * 验的是「分档靠不靠得住」这件事的三面：
 * - 名册本身的增删改查：perm 开关按档位存取，字段缺省不动；
 * - 密码查重：和两个内置口令、和已有各档都不许重 —— 重了「分档」就分不出人；
 * - 门口验密码：内置口令直接排除，停用的档不开门，命中才给行。
 * 另有一组用例盯着 buildTools：档位关掉的工具组必须真的不注册（工具没到手，
 * 比「到手了再拦」可靠），visitor_log 恒在，主人那间不受档位影响。
 *
 * 名册用最小假 SQL 引擎，只认得 guestTypes.ts 会发的那几条语句。
 *
 * 运行: npx vitest run test/guestTypes.test.ts
 */

import { describe, it, expect } from "vitest";
import {
  cardPermFallback,
  COMMON_TYPE_ID,
  createGuestType,
  defaultCommonGuestTypeInfo,
  disabledGuestTypeInfo,
  findGuestTypeByPassword,
  getGuestType,
  listGuestTypes,
  removeGuestType,
  toGuestTypeInfo,
  updateGuestType,
} from "../src/agent/guestTypes";
import { INITIAL_STATE, type SqlTag } from "../src/agent/state";
import { GUEST_TOGGLABLE_TOOLS } from "../src/agent/toolGroups";
import { buildTools } from "../src/tools";
import type { ToolCtx } from "../src/tools/types";

const ENV_PW = { adminPw: "guanli", gatePw: "qiantai" };

/** 最小假 SQL 引擎：行存成 snake_case，语句按前缀认 */
function fakeDb() {
  const rows: Array<{
    id: string;
    name: string;
    password: string;
    note: string;
    tools: string;
    perm_search: number;
    perm_draw: number;
    perm_memory: number;
    perm_notes: number;
    perm_files: number;
    perm_public: number;
    perm_matrix: number;
    active: number;
    created: string;
  }> = [];

  const db = (<T>(strings: TemplateStringsArray, ...values: unknown[]): T[] => {
    const sql = strings.join("?").replace(/\s+/g, " ").trim().toLowerCase();

    if (sql.startsWith("create table")) return [] as T[];

    // 老库补列的 ALTER：真库靠 try/catch 容错，假库直接当跑成了
    if (sql.startsWith("alter table")) return [] as T[];

    if (sql.startsWith("insert into guest_types")) {
      const [
        id,
        name,
        password,
        note,
        tools,
        ps,
        pd,
        pm,
        pn,
        pf,
        pp,
        pmx,
        active,
        created,
      ] = values as [
        string,
        string,
        string,
        string,
        string,
        number,
        number,
        number,
        number,
        number,
        number,
        number,
        number,
        string,
      ];
      // 真库里 id 是主键、内置档那条语句带 ON CONFLICT DO NOTHING：
      // 同一个 id 再插一次什么都不做（种入是幂等的）
      if (rows.some((r) => r.id === id)) return [] as T[];
      rows.push({
        id,
        name,
        password,
        note,
        tools,
        perm_search: Number(ps),
        perm_draw: Number(pd),
        perm_memory: Number(pm),
        perm_notes: Number(pn),
        perm_files: Number(pf),
        perm_public: Number(pp),
        perm_matrix: Number(pmx),
        active: Number(active),
        created,
      });
      return [] as T[];
    }

    if (sql.startsWith("update guest_types set")) {
      if (values.some(v => typeof v === "boolean")) throw new Error("SQL boolean binding is not allowed");
      const [name, password, note, tools, ps, pd, pm, pn, pf, pp, pmx, active, id] =
        values as [
          string,
          string,
          string,
          string,
          number,
          number,
          number,
          number,
          number,
          number,
          number,
          number,
          string,
        ];
      const row = rows.find((r) => r.id === id);
      if (!row) throw new Error("假库：update 没找到行");
      Object.assign(row, {
        name,
        password,
        note,
        tools,
        perm_search: Number(ps),
        perm_draw: Number(pd),
        perm_memory: Number(pm),
        perm_notes: Number(pn),
        perm_files: Number(pf),
        perm_public: Number(pp),
        perm_matrix: Number(pmx),
        active: Number(active),
      });
      return [] as T[];
    }

    if (sql.startsWith("delete from guest_types")) {
      const [id] = values as [string];
      const i = rows.findIndex((r) => r.id === id);
      if (i >= 0) rows.splice(i, 1);
      return [] as T[];
    }

    if (sql.startsWith("select id from guest_types")) {
      const [id] = values as [string];
      return rows.filter((r) => r.id === id).map((r) => ({ id: r.id })) as T[];
    }

    if (sql.startsWith("select id, name, password")) {
      // 三种查询：按 id（权益核实）、按 active（门口验密码）、按 id+active（同前者，
      // 但停用的档连「按 id 查」也要当查无此档 —— 旧票旧卡的权益核实走的就是它）
      const byId = sql.includes("where id =")
        ? rows.filter((r) => r.id === (values[0] as string))
        : [...rows];
      return (
        sql.includes("active = 1") ? byId.filter((r) => r.active === 1) : byId
      ) as T[];
    }

    throw new Error("假库不认得这条语句：" + sql);
  }) as unknown as SqlTag;

  return { db, rows };
}

describe("guest_types 增删改查", () => {
  it("建一档读得回来：perm 缺省全开、id 是 8 位 hex、active 默认启用", async () => {
    const { db } = fakeDb();
    const t = await createGuestType(db, {
      name: "合作方",
      password: "hz-2026",
      ...ENV_PW,
    });
    expect(t.id).toMatch(/^[0-9a-f]{8}$/);
    expect(t.name).toBe("合作方");
    expect(t.password).toMatch(/^[0-9a-f]{64}$/);
    expect(t.permSearch).toBe(true);
    expect(t.permDraw).toBe(true);
    expect(t.permMemory).toBe(true);
    expect(t.active).toBe(true);
    expect(t.created).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // 名册第一行恒是内置通用档（见下面那组用例），自定义档排在它后面
    expect(listGuestTypes(db).map((x) => x.name)).toEqual([
      "通用来客",
      "合作方",
    ]);
  });

  it("perm 明确关掉就是关掉，没提的仍全开", async () => {
    const { db } = fakeDb();
    const t = await createGuestType(db, {
      name: "受限档",
      password: "p1",
      permSearch: false,
      permMemory: false,
      ...ENV_PW,
    });
    expect(t.permSearch).toBe(false);
    expect(t.permDraw).toBe(true);
    expect(t.permMemory).toBe(false);
  });

  it("逐工具清单：给了 tools 就整份用它，空数组是「显式全关」，老开关跟着反推", async () => {
    const { db } = fakeDb();
    const t = await createGuestType(db, {
      name: "只画画",
      password: "p1",
      tools: ["draw"],
      ...ENV_PW,
    });
    expect(t.tools).toEqual(["draw"]);
    // 老开关不再是权威，但保持自洽（别的调用方还在读）
    expect(t.permSearch).toBe(false);
    expect(t.permDraw).toBe(true);
    const off = await updateGuestType(db, t.id, { tools: [], ...ENV_PW });
    expect(off?.tools).toEqual([]);
    expect(off?.permDraw).toBe(false);
  });

  it("老行（tools 空串）按三个老开关推平一次 —— 不把「没设过」当成全关", async () => {
    const { db, rows } = fakeDb();
    const t = await createGuestType(db, {
      name: "老档",
      password: "p1",
      ...ENV_PW,
    });
    // 模拟逐工具化之前的存量行：没有 tools，只有老开关
    // （按 id 找这一行 —— rows[0] 是内置通用档）
    const legacyRow = rows.find((r) => r.id === t.id)!;
    legacyRow.tools = "";
    legacyRow.perm_search = 0;
    const back = listGuestTypes(db).find((x) => x.id === t.id)!;
    expect(back.tools).not.toContain("search");
    expect(back.tools).toContain("draw");
    expect(back.tools).toContain("memory");
  });

  it("改一档：字段缺省不动，active 能停用，名称与说明能改", async () => {
    const { db } = fakeDb();
    const t = await createGuestType(db, {
      name: "旧名",
      password: "p1",
      note: "旧说明",
      ...ENV_PW,
    });
    const up = await updateGuestType(db, t.id, {
      name: "新名",
      note: "新说明",
      active: false,
      ...ENV_PW,
    });
    expect(up?.name).toBe("新名");
    expect(up?.note).toBe("新说明");
    expect(up?.active).toBe(false);
    expect(up?.password).toMatch(/^[0-9a-f]{64}$/);
    expect(up?.permSearch).toBe(true);
  });

  it("没有这一档：改返回 null，删返回 false", async () => {
    const { db } = fakeDb();
    expect(await updateGuestType(db, "nope", { ...ENV_PW })).toBeNull();
    expect(removeGuestType(db, "nope")).toBe(false);
  });

  it("删一档", async () => {
    const { db } = fakeDb();
    const t = await createGuestType(db, {
      name: "临时档",
      password: "p1",
      ...ENV_PW,
    });
    expect(removeGuestType(db, t.id)).toBe(true);
    expect(listGuestTypes(db).map((x) => x.id)).toEqual(["common"]);
  });
});

/**
 * 内置通用档：拿前台门禁口令进来的人都归这一档。
 *
 * 它从前钉死在代码里、权限恒全开，管理面板上看不见。现在它是名册里真实的
 * 一行：能按件关工具、能写接待说明，但口令取自 env（表里那格留空）、
 * 不能停用也不能删 —— 它是门口最后一把钥匙。
 */
describe("内置通用档", () => {
  it("随建表种入：id=common、缺省全开、排在最前、种几次都只一行", () => {
    const { db, rows } = fakeDb();
    // 反复读名册（每次都过一遍 ensureGuestTypesSchema）不该重复种
    listGuestTypes(db);
    listGuestTypes(db);
    expect(rows.filter((r) => r.id === "common")).toHaveLength(1);

    const common = getGuestType(db, "common")!;
    expect(common.name).toBe("通用来客");
    expect(common.active).toBe(true);
    expect(common.tools).toEqual([...GUEST_TOGGLABLE_TOOLS]);
    expect(common.permNotes).toBe(true);
    expect(common.permFiles).toBe(true);
    expect(common.permPublic).toBe(true);
    // 唯独矩阵权种成关：这一档的门禁口令是对外发的前台口令，白送整面网页不成
    expect(common.permMatrix).toBe(false);
    // 表里那格口令是空的：进门验的是 env 里的前台口令，不走这张表
    expect(common.password).toBe("");
    // 名册第一行（created 钉在最早）
    expect(listGuestTypes(db)[0].id).toBe("common");
  });

  it("能改工具与说明 —— 收紧自定义之外，通用档也能收", async () => {
    const { db } = fakeDb();
    const up = await updateGuestType(db, "common", {
      note: "只做接待，不外发",
      tools: ["memory"],
      permPublic: false,
      ...ENV_PW,
    });
    expect(up?.note).toBe("只做接待，不外发");
    expect(up?.tools).toEqual(["memory"]);
    expect(up?.permPublic).toBe(false);
    expect(up?.name).toBe("通用来客");
    // 改完再读一遍：改动没被下一次建表冲掉
    expect(getGuestType(db, "common")!.tools).toEqual(["memory"]);
  });

  it("口令改不得（它就是前台门禁口令）、停用不得、删除不得", async () => {
    const { db } = fakeDb();
    await expect(
      updateGuestType(db, "common", { password: "x1", ...ENV_PW }),
    ).rejects.toThrow(/前台门禁口令/);
    await expect(
      updateGuestType(db, "common", { active: false, ...ENV_PW }),
    ).rejects.toThrow(/不能停用/);
    expect(() => removeGuestType(db, "common")).toThrow(/删不得/);
    // 上面几次都没能把这一档弄没
    expect(getGuestType(db, "common")).not.toBeNull();
  });

  it("门口验密码不会命中它：空口令那格永远撞不上谁", async () => {
    const { db } = fakeDb();
    for (const pw of ["common", "通用来客", " ", ""]) {
      expect(
        await findGuestTypeByPassword(db, pw, ENV_PW.adminPw, ENV_PW.gatePw),
      ).toBeNull();
    }
    // 也不占用查重名额：自定义档照常能建
    const t = await createGuestType(db, {
      name: "合作方",
      password: "hz",
      ...ENV_PW,
    });
    expect(t.name).toBe("合作方");
  });
});

/**
 * 长期权益第四档：网页矩阵的全量管理权（permMatrix）。
 *
 * 这一档给出去就是整面网页（页面、连线、外观、外站认定表、打包/装备），
 * 一次误操作能覆盖现网所有页面 —— 所以它的底线是「默认关 + 认不出就算关」：
 * 建档不带就是关、内置通用档种入就是关、老库补列前的 null 也算关、
 * PATCH 没提这一格就一律不动它（既不顺手开、也不顺手关）。
 */
describe("矩阵权（permMatrix）默认关、按件改", () => {
  it("建一档不带这个字段就是关；显式给 true 才开", async () => {
    const { db } = fakeDb();
    const off = await createGuestType(db, {
      name: "新档",
      password: "p1",
      ...ENV_PW,
    });
    expect(off.permMatrix).toBe(false);
    expect(getGuestType(db, off.id)!.permMatrix).toBe(false);
    const on = await createGuestType(db, {
      name: "协作档",
      password: "p2",
      permMatrix: true,
      ...ENV_PW,
    });
    expect(on.permMatrix).toBe(true);
    expect(getGuestType(db, on.id)!.permMatrix).toBe(true);
  });

  it("PATCH 开→关→读回：每一趟都落库，不是只在返回值里改了", async () => {
    const { db } = fakeDb();
    const t = await createGuestType(db, {
      name: "矩阵档",
      password: "p1",
      ...ENV_PW,
    });
    const on = await updateGuestType(db, t.id, {
      permMatrix: true,
      ...ENV_PW,
    });
    expect(on?.permMatrix).toBe(true);
    expect(getGuestType(db, t.id)!.permMatrix).toBe(true);
    const off = await updateGuestType(db, t.id, {
      permMatrix: false,
      ...ENV_PW,
    });
    expect(off?.permMatrix).toBe(false);
    expect(getGuestType(db, t.id)!.permMatrix).toBe(false);
  });

  it("PATCH 没提这一格就不动它：开着改别的仍开着，关着改别的仍关着", async () => {
    const { db } = fakeDb();
    const t = await createGuestType(db, {
      name: "手滑测试",
      password: "p1",
      ...ENV_PW,
    });
    await updateGuestType(db, t.id, { permMatrix: true, ...ENV_PW });
    const keptOn = await updateGuestType(db, t.id, {
      name: "改了名",
      permNotes: true,
      ...ENV_PW,
    });
    expect(keptOn?.name).toBe("改了名");
    expect(keptOn?.permNotes).toBe(true);
    expect(keptOn?.permMatrix).toBe(true);
    expect(getGuestType(db, t.id)!.permMatrix).toBe(true);
    // 反过来：关着的也不会被「只改名字」顺手打开
    await updateGuestType(db, t.id, { permMatrix: false, ...ENV_PW });
    const keptOff = await updateGuestType(db, t.id, {
      note: "只加一句说明",
      ...ENV_PW,
    });
    expect(keptOff?.note).toBe("只加一句说明");
    expect(keptOff?.permMatrix).toBe(false);
  });

  it("其它三项长期权益改不动它：四格各管各的", async () => {
    const { db } = fakeDb();
    const t = await createGuestType(db, {
      name: "分面测试",
      password: "p1",
      ...ENV_PW,
    });
    await updateGuestType(db, t.id, {
      permNotes: true,
      permFiles: true,
      permPublic: true,
      ...ENV_PW,
    });
    const back = getGuestType(db, t.id)!;
    expect(back).toMatchObject({
      permNotes: true,
      permFiles: true,
      permPublic: true,
      permMatrix: false,
    });
  });

  it("库里读不出这一列的值（老库/写坏）：一律按没有矩阵权算", async () => {
    const { db, rows } = fakeDb();
    const t = await createGuestType(db, {
      name: "补列前",
      password: "p1",
      permMatrix: true,
      ...ENV_PW,
    });
    // 模拟「这一格读上来是 null」：补列前的存量行、或值被写坏了
    for (const bad of [null, undefined, "1", 2, "true"]) {
      rows.find((r) => r.id === t.id)!.perm_matrix = bad as unknown as number;
      expect(getGuestType(db, t.id)!.permMatrix).toBe(false);
    }
    rows.find((r) => r.id === t.id)!.perm_matrix = 1;
    expect(getGuestType(db, t.id)!.permMatrix).toBe(true);
  });

  it("两份兜底快照都不带矩阵权：核实失败不等于把整面网页交出去", () => {
    expect(defaultCommonGuestTypeInfo().permMatrix).toBe(false);
    // 全开兜底那份照旧是工具全开 —— 只把矩阵权这一格钉在关
    expect(defaultCommonGuestTypeInfo().tools).toEqual([
      ...GUEST_TOGGLABLE_TOOLS,
    ]);
    expect(disabledGuestTypeInfo("x").permMatrix).toBe(false);
  });
});

/**
 * DO 隔着间回答「这张卡有没有这项权益」时，名册上查不到那一档的兜底口径
 * （cowork.ts 的 cardPerm 走的就是这一把尺子）。
 */
describe("查无此档的兜底口径", () => {
  it("内置通用档的老三项：行读不出来仍按全开 —— 那是门口最后一把钥匙", () => {
    for (const perm of ["permNotes", "permFiles", "permPublic"] as const)
      expect(cardPermFallback(COMMON_TYPE_ID, perm)).toBe(true);
  });

  it("矩阵权：任何档都不从兜底里拿到，包括内置通用档", () => {
    expect(cardPermFallback(COMMON_TYPE_ID, "permMatrix")).toBe(false);
    expect(cardPermFallback("t-vip", "permMatrix")).toBe(false);
  });

  it("别的档：四项全按没有算 —— 核实失败不能当成「没有约定」放行", () => {
    for (const perm of [
      "permNotes",
      "permFiles",
      "permPublic",
      "permMatrix",
    ] as const)
      expect(cardPermFallback("t-gone", perm)).toBe(false);
  });
});

describe("停用的档：新登录不开门，按 id 查也当查无此档", () => {
  it("getGuestType 对停用的档返回 null —— 旧票旧卡的权益核实走这条，null 由上层回落全关", async () => {
    const { db } = fakeDb();
    const t = await createGuestType(db, {
      name: "停用档",
      password: "ty-2026",
      ...ENV_PW,
    });
    // 启用时按 id 查得到
    expect(getGuestType(db, t.id)!.id).toBe(t.id);
    await updateGuestType(db, t.id, { active: false, ...ENV_PW });
    // 停用后按 id 查就是查无此档：30 天的旧票、名下的旧卡都拿不到这一档的权益，
    // 「收回」不再只剩删档一条路
    expect(getGuestType(db, t.id)).toBeNull();
    // 面板看名册不受影响：停用的档还在列表里（列表也含内置通用档）
    expect(listGuestTypes(db).map((x) => x.name)).toEqual([
      "通用来客",
      "停用档",
    ]);
  });

  it("停用的档能改名并重新启用：改档查档不过滤 active，停用不是单行道", async () => {
    const { db } = fakeDb();
    const t = await createGuestType(db, {
      name: "待重生",
      password: "p1",
      ...ENV_PW,
    });
    await updateGuestType(db, t.id, { active: false, ...ENV_PW });
    // 权益核实对停用档返回 null（上面验过），但改档路径必须还认得它 ——
    // 要不然停用的档在面板上看得见、删得掉，唯独改不动也启用不回来
    const up = await updateGuestType(db, t.id, {
      name: "复名",
      note: "回来接待",
      active: true,
      ...ENV_PW,
    });
    expect(up?.name).toBe("复名");
    expect(up?.note).toBe("回来接待");
    expect(up?.active).toBe(true);
    // 转正后权益核实查得回来，门口验密码也重新放行
    expect(getGuestType(db, t.id)?.name).toBe("复名");
    const hit = await findGuestTypeByPassword(
      db,
      "p1",
      ENV_PW.adminPw,
      ENV_PW.gatePw,
    );
    expect(hit?.id).toBe(t.id);
  });
});

describe("密码查重", () => {
  it("与管理员口令撞了：抛", async () => {
    const { db } = fakeDb();
    await expect(
      createGuestType(db, { name: "x", password: "guanli", ...ENV_PW }),
    ).rejects.toThrow(/管理员口令/);
  });

  it("与前台口令撞了：抛", async () => {
    const { db } = fakeDb();
    await expect(
      createGuestType(db, { name: "x", password: "qiantai", ...ENV_PW }),
    ).rejects.toThrow(/前台口令/);
  });

  it("与已有档位撞了：抛；只改名不碰密码不查重", async () => {
    const { db } = fakeDb();
    await createGuestType(db, { name: "a", password: "p1", ...ENV_PW });
    await expect(
      createGuestType(db, { name: "b", password: "p1", ...ENV_PW }),
    ).rejects.toThrow(/在用/);
    const b = await createGuestType(db, {
      name: "b",
      password: "p2",
      ...ENV_PW,
    });
    expect(
      (await updateGuestType(db, b.id, { name: "b2", ...ENV_PW }))?.name,
    ).toBe("b2");
  });

  it("改成别人的密码：抛；原样保留自己的密码：不算撞", async () => {
    const { db } = fakeDb();
    await createGuestType(db, { name: "a", password: "p1", ...ENV_PW });
    const b = await createGuestType(db, {
      name: "b",
      password: "p2",
      ...ENV_PW,
    });
    await expect(
      updateGuestType(db, b.id, { password: "p1", ...ENV_PW }),
    ).rejects.toThrow(/在用/);
    const kept = await updateGuestType(db, b.id, { password: "p2", ...ENV_PW });
    // 同一个口令重交一遍：内容不变（同一个摘要），只是存法保证还是摘要代
    expect(kept?.password).toMatch(/^[0-9a-f]{64}$/);
  });

  it("名称或密码为空：抛", async () => {
    const { db } = fakeDb();
    await expect(
      createGuestType(db, { name: "   ", password: "p1", ...ENV_PW }),
    ).rejects.toThrow(/名称/);
    await expect(
      createGuestType(db, { name: "x", password: "", ...ENV_PW }),
    ).rejects.toThrow(/密码/);
  });
});

describe("门口验密码", () => {
  it("命中已启用的档：返回那一档的完整行", async () => {
    const { db } = fakeDb();
    const t = await createGuestType(db, {
      name: "合作方",
      password: "hz",
      note: "对客客气一点",
      permSearch: false,
      ...ENV_PW,
    });
    const hit = await findGuestTypeByPassword(
      db,
      "hz",
      ENV_PW.adminPw,
      ENV_PW.gatePw,
    );
    expect(hit?.id).toBe(t.id);
    expect(hit?.name).toBe("合作方");
    expect(hit?.note).toBe("对客客气一点");
    expect(hit?.permSearch).toBe(false);
  });

  it("两个内置口令不算任何一档：直接排除", async () => {
    const { db } = fakeDb();
    await createGuestType(db, { name: "合作方", password: "hz", ...ENV_PW });
    expect(
      await findGuestTypeByPassword(
        db,
        "guanli",
        ENV_PW.adminPw,
        ENV_PW.gatePw,
      ),
    ).toBeNull();
    expect(
      await findGuestTypeByPassword(
        db,
        "qiantai",
        ENV_PW.adminPw,
        ENV_PW.gatePw,
      ),
    ).toBeNull();
  });

  it("没这密码、停用的档、空口令，都不命中", async () => {
    const { db } = fakeDb();
    const t = await createGuestType(db, {
      name: "停用档",
      password: "p1",
      ...ENV_PW,
    });
    await updateGuestType(db, t.id, { active: false, ...ENV_PW });
    expect(
      await findGuestTypeByPassword(db, "p1", ENV_PW.adminPw, ENV_PW.gatePw),
    ).toBeNull();
    expect(
      await findGuestTypeByPassword(db, "nope", ENV_PW.adminPw, ENV_PW.gatePw),
    ).toBeNull();
    expect(
      await findGuestTypeByPassword(db, "", ENV_PW.adminPw, ENV_PW.gatePw),
    ).toBeNull();
  });

  it("对外快照不带密码", async () => {
    const { db } = fakeDb();
    const t = await createGuestType(db, {
      name: "合作方",
      password: "hz",
      ...ENV_PW,
    });
    const info = toGuestTypeInfo(getGuestType(db, t.id)!);
    expect(info).toEqual({
      id: t.id,
      name: "合作方",
      note: "",
      // 三个老开关缺省全开 → 推平成可开关的来客工具全选（恒开的那些不在这里）
      tools: [...GUEST_TOGGLABLE_TOOLS],
      // 三项长期权益建档时缺省关：没有持久身份谈不上私人空间
      permNotes: false,
      permFiles: false,
      permPublic: false,
      permMatrix: false,
    });
    expect(JSON.stringify(info)).not.toContain("hz");
  });
});

describe("摘要存储与两代兼容", () => {
  it("建档后库里是摘要不是明文，门口用原口令照样进", async () => {
    const { db, rows } = fakeDb();
    const t = await createGuestType(db, {
      name: "a",
      password: "秘密口令",
      ...ENV_PW,
    });
    const row = rows.find((r) => r.id === t.id)!;
    expect(row.password).toMatch(/^[0-9a-f]{64}$/);
    expect(row.password).not.toContain("秘密口令");
    const hit = await findGuestTypeByPassword(
      db,
      "秘密口令",
      ENV_PW.adminPw,
      ENV_PW.gatePw,
    );
    expect(hit?.name).toBe("a");
  });

  it("老条目还是明文：门口照样验得过", async () => {
    const { db, rows } = fakeDb();
    const t = await createGuestType(db, {
      name: "老档",
      password: "old-pw",
      ...ENV_PW,
    });
    rows.find((r) => r.id === t.id)!.password = "old-pw"; // 模拟摘要化之前的存量条目
    const hit = await findGuestTypeByPassword(
      db,
      "old-pw",
      ENV_PW.adminPw,
      ENV_PW.gatePw,
    );
    expect(hit?.name).toBe("老档");
  });

  it("老明文条目原样重交同一口令：就地升级成摘要", async () => {
    const { db, rows } = fakeDb();
    const t = await createGuestType(db, {
      name: "老档",
      password: "old-pw",
      ...ENV_PW,
    });
    rows.find((r) => r.id === t.id)!.password = "old-pw";
    const up = await updateGuestType(db, t.id, {
      password: "old-pw",
      ...ENV_PW,
    });
    expect(up?.password).toMatch(/^[0-9a-f]{64}$/);
    expect(
      await findGuestTypeByPassword(
        db,
        "old-pw",
        ENV_PW.adminPw,
        ENV_PW.gatePw,
      ),
    ).not.toBeNull();
  });
});

/** buildTools 用的最小假 ctx：只搭工具组注册需要的几样，execute 不会被调 */
function toolCtx(guestType: ToolCtx["guestType"], guest = true): ToolCtx {
  const { db } = fakeDb();
  return {
    env: {},
    sql: db,
    room: "guest-test",
    guest,
    guestType,
    state: { ...INITIAL_STATE, guestType },
    patchState: () => {},
  } as unknown as ToolCtx;
}

const namesOf = (ctx: ToolCtx) => Object.keys(buildTools(ctx));

describe("按档位过滤工具", () => {
  it("没带档位：全开 —— 缺省不能反着解释成全关", () => {
    const names = namesOf(toolCtx(undefined));
    expect(names).toContain("search");
    expect(names).toContain("draw");
    expect(names).toContain("memory");
    expect(names).toContain("visitor_log");
  });

  it("可开关的工具全关：对应工具消失，visitor_log 与不设开关的 weather/view_image 还在", () => {
    const names = namesOf(
      toolCtx({
        id: "t1",
        name: "受限档",
        note: "",
        tools: [],
        permNotes: false,
        permFiles: false,
        permPublic: false,
        permMatrix: false,
      }),
    );
    expect(names).not.toContain("search");
    expect(names).not.toContain("read_url");
    expect(names).not.toContain("draw");
    expect(names).not.toContain("diagram");
    expect(names).not.toContain("memory");
    expect(names).toContain("visitor_log");
    expect(names).toContain("weather");
    expect(names).toContain("view_image");
  });

  it("失效兜底快照（票上的档位查不到/查询失败时落的这份）：工具清单一律全关，工具层跟着收干净", () => {
    const stub = disabledGuestTypeInfo("t-gone");
    // 兜底本身就该是全关 —— 核实不了的一档不能当成「没有约定」放行
    expect(stub.tools).toEqual([]);
    expect(stub.permNotes).toBe(false);
    expect(stub.permFiles).toBe(false);
    expect(stub.permPublic).toBe(false);
    // 矩阵权是整面网页：兜底这份绝不能替管理员把它发出去
    expect(stub.permMatrix).toBe(false);
    // 经工具注册层：对外工具组一个不留，留痕的还在
    const names = namesOf(toolCtx(stub));
    expect(names).not.toContain("search");
    expect(names).not.toContain("draw");
    expect(names).not.toContain("memory");
    expect(names).toContain("visitor_log");
  });

  it("只关检索：画画和记忆照常", () => {
    const names = namesOf(
      toolCtx({
        id: "t2",
        name: "只禁网",
        note: "",
        tools: ["draw", "diagram", "send_image", "memory"],
        permNotes: false,
        permFiles: false,
        permPublic: false,
        permMatrix: false,
      }),
    );
    expect(names).not.toContain("search");
    expect(names).toContain("draw");
    expect(names).toContain("memory");
  });

  it("主人那间不受档位影响：开关关了工具也全在", () => {
    const names = namesOf(
      toolCtx(
        {
          id: "t3",
          name: "x",
          note: "",
          tools: [],
          permNotes: false,
          permFiles: false,
          permPublic: false,
          permMatrix: false,
        },
        false,
      ),
    );
    expect(names).toContain("search");
    expect(names).toContain("draw");
    expect(names).toContain("memory");
  });
});
