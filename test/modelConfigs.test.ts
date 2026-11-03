/**
 * 模型目录（供应商 + 模型条目两级）测试。
 *
 * 验的是这本目录靠不靠得住：
 * - 供应商与条目增删改查全路径，字段缺省不动；
 * - 必填与 format 三值校验：不对就拒，拒的话要听得懂；
 * - 生效唯一性：activate / update(active) 都是先全清再置一，全库永远最多一条生效；
 * - 删掉生效条目（或整家供应商）时，最新的另一条自动顶上 —— 目录不能空转；
 * - 首个条目自动生效（不然建完还得手动点一下，是段没人需要的死循环）；
 * - 老单表（model_configs）惰性迁移：一行拆成一家供应商 + 一条条目，
 *   条目 id 沿用老配置 id（深度思考槽位的指向不能断）。
 * - 思考配置：供应商的 thinkingDialect（参数怎么写）与条目的 thinking / thinkingBudget
 *   （强度多高、anthropic 预算）存得进读得回、脏值归一成默认；老表迁出来是
 *   auto / "" / 0，行为跟升级前一字不差。
 *
 * 表用最小假 SQL 引擎，只认得 modelConfigs.ts 会发的那几条语句。
 *
 * 运行: npx vitest run test/modelConfigs.test.ts
 */

import { describe, it, expect } from "vitest";
import {
  activateModelEntry,
  createModelEntry,
  createModelProvider,
  ensureModelCatalogSchema,
  getActiveCatalog,
  getActiveModelEntry,
  getCatalogById,
  listModelEntries,
  listModelProviders,
  removeModelEntry,
  removeModelProvider,
  toContextWindow,
  toMaxOutput,
  updateModelEntry,
  updateModelProvider,
} from "../src/agent/modelConfigs";
import type { SqlTag } from "../src/agent/state";

interface PRow {
  id: string;
  name: string;
  format: string;
  base_url: string;
  key_secret: string;
  maint_key_secret: string;
  maint_model: string;
  thinking_dialect: string;
  created: string;
}

interface ERow {
  id: string;
  provider_id: string;
  model: string;
  max_output: number;
  context_window: number;
  thinking: string;
  thinking_budget: number;
  active: number;
  created: string;
}

interface LRow {
  id: string;
  name: string;
  format: string;
  base_url: string;
  key_secret: string;
  model: string;
  max_output: number;
  maint_key_secret: string;
  maint_model: string;
  active: number;
  created: string;
}

/**
 * 最小假 SQL 引擎：行存成 snake_case，语句按前缀认。
 * legacy 模拟存量老表：放着 model_configs 的旧行，迁移后清空并标记改名。
 */
function fakeDb(legacy: LRow[] = []) {
  const providers: PRow[] = [];
  const entries: ERow[] = [];
  let oldConfigs = [...legacy];
  let migrated = false;

  const db = (<T>(strings: TemplateStringsArray, ...values: unknown[]): T[] => {
    const sql = strings.join("?").replace(/\s+/g, " ").trim().toLowerCase();

    if (sql.startsWith("create table")) return [] as T[];

    if (sql.includes("from sqlite_master")) {
      return (
        migrated ? [] : oldConfigs.length ? [{ name: "model_configs" }] : []
      ) as T[];
    }

    if (sql.startsWith("alter table model_configs")) {
      migrated = true;
      return [] as T[];
    }

    // 老表补列（context_window / thinking / thinking_dialect）：真库上列已存在会抛错被吞，
    // 假库直接当成功 —— 这里只需要它别打断后续语句
    if (sql.startsWith("alter table model_entries")) return [] as T[];
    if (sql.startsWith("alter table model_providers")) return [] as T[];

    if (
      sql.startsWith("select id, name, format, base_url, key_secret, model")
    ) {
      return oldConfigs as T[];
    }

    if (sql.startsWith("insert into model_providers")) {
      const [
        id,
        name,
        format,
        base_url,
        key_secret,
        maint_key_secret,
        maint_model,
        thinking_dialect,
        created,
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
      providers.push({
        id,
        name,
        format,
        base_url,
        key_secret,
        maint_key_secret,
        maint_model,
        thinking_dialect,
        created,
      });
      return [] as T[];
    }

    if (sql.startsWith("insert into model_entries")) {
      const [
        id,
        provider_id,
        model,
        max_output,
        context_window,
        thinking,
        thinking_budget,
        active,
        created,
      ] = values as [
        string,
        string,
        string,
        number,
        number,
        string,
        number,
        number,
        string,
      ];
      entries.push({
        id,
        provider_id,
        model,
        max_output: Number(max_output),
        context_window: Number(context_window),
        thinking,
        thinking_budget: Number(thinking_budget),
        active: Number(active),
        created,
      });
      return [] as T[];
    }

    if (sql.startsWith("update model_entries set active = 0")) {
      for (const r of entries) r.active = 0;
      return [] as T[];
    }

    if (sql.startsWith("update model_entries set active = 1")) {
      const [id] = values as [string];
      const row = entries.find((r) => r.id === id);
      if (!row) throw new Error("假库：activate 没找到行");
      row.active = 1;
      return [] as T[];
    }

    if (sql.startsWith("update model_entries set")) {
      const [
        model,
        max_output,
        context_window,
        thinking,
        thinking_budget,
        active,
        id,
      ] = values as [string, number, number, string, number, number, string];
      const row = entries.find((r) => r.id === id);
      if (!row) throw new Error("假库：update 没找到行");
      Object.assign(row, {
        model,
        max_output: Number(max_output),
        context_window: Number(context_window),
        thinking,
        thinking_budget: Number(thinking_budget),
        active: Number(active),
      });
      return [] as T[];
    }

    if (sql.startsWith("delete from model_entries")) {
      const [id] = values as [string];
      const i = entries.findIndex((r) => r.id === id);
      if (i >= 0) entries.splice(i, 1);
      return [] as T[];
    }

    if (sql.startsWith("update model_providers set")) {
      const [
        name,
        format,
        base_url,
        key_secret,
        maint_key_secret,
        maint_model,
        thinking_dialect,
        id,
      ] = values as [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
      ];
      const row = providers.find((r) => r.id === id);
      if (!row) throw new Error("假库：update 没找到行");
      Object.assign(row, {
        name,
        format,
        base_url,
        key_secret,
        maint_key_secret,
        maint_model,
        thinking_dialect,
      });
      return [] as T[];
    }

    if (sql.startsWith("delete from model_entries where provider_id")) {
      const [pid] = values as [string];
      for (let i = entries.length - 1; i >= 0; i--)
        if (entries[i].provider_id === pid) entries.splice(i, 1);
      return [] as T[];
    }

    if (sql.startsWith("delete from model_providers")) {
      const [id] = values as [string];
      const i = providers.findIndex((r) => r.id === id);
      if (i >= 0) providers.splice(i, 1);
      return [] as T[];
    }

    if (sql.startsWith("select active from model_entries")) {
      const [id] = values as [string];
      return entries
        .filter((r) => r.id === id)
        .map((r) => ({ id: r.id, active: r.active })) as T[];
    }

    if (sql.startsWith("select id from model_providers")) {
      const [id] = values as [string];
      return providers
        .filter((r) => r.id === id)
        .map((r) => ({ id: r.id })) as T[];
    }

    if (sql.startsWith("select id, provider_id, model")) {
      if (sql.includes("provider_id = ? and active = 1")) {
        const [pid] = values as [string];
        return entries.filter(
          (r) => r.provider_id === pid && r.active === 1,
        ) as T[];
      }
      if (sql.includes("where active = 1"))
        return entries.filter((r) => r.active === 1) as T[];
      if (sql.includes("where id =")) {
        const [id] = values as [string];
        return entries.filter((r) => r.id === id) as T[];
      }
      return [...entries] as T[];
    }

    if (sql.startsWith("select id, name, format")) {
      if (sql.includes("where id =")) {
        const [id] = values as [string];
        return providers.filter((r) => r.id === id) as T[];
      }
      return [...providers] as T[];
    }

    throw new Error("假库不认得这条语句：" + sql);
  }) as unknown as SqlTag;

  return {
    db,
    providers,
    entries,
    legacy: () => oldConfigs,
    isMigrated: () => migrated,
  };
}

const ok = {
  name: "DeepSeek",
  format: "anthropic",
  baseUrl: "https://api.deepseek.com/anthropic",
  keySecret: "DEEPSEEK_KEY",
};

describe("供应商增删改查", () => {
  it("建一家读得回来：id 是 8 位 hex，维护字段缺省为空", () => {
    const { db } = fakeDb();
    const r = createModelProvider(db, ok);
    expect(r.provider.id).toMatch(/^[0-9a-f]{8}$/);
    expect(r.provider.name).toBe("DeepSeek");
    expect(r.provider.format).toBe("anthropic");
    expect(r.provider.maintKeySecret).toBe("");
    expect(r.provider.maintModel).toBe("");
    // 没给 firstModel：只建供应商，不挂条目
    expect(r.entry).toBeNull();
    expect(listModelProviders(db).map((x) => x.name)).toEqual(["DeepSeek"]);
  });

  it("firstModel 给了就顺手挂上首个条目；全库无生效条目时它自动生效", () => {
    const { db } = fakeDb();
    const r = createModelProvider(db, { ...ok, firstModel: "deepseek-v4-pro" });
    expect(r.entry).not.toBeNull();
    expect(r.entry?.model).toBe("deepseek-v4-pro");
    expect(r.entry?.active).toBe(true);
    expect(r.entry?.providerId).toBe(r.provider.id);
  });

  it("改一家：字段缺省不动，名称不能改成空", () => {
    const { db } = fakeDb();
    const { provider } = createModelProvider(db, ok);
    const up = updateModelProvider(db, provider.id, {
      name: "改名",
      maintModel: "deepseek-flash",
    });
    expect(up?.name).toBe("改名");
    expect(up?.maintModel).toBe("deepseek-flash");
    expect(up?.format).toBe("anthropic");
    expect(up?.keySecret).toBe("DEEPSEEK_KEY");
    expect(() => updateModelProvider(db, provider.id, { name: " " })).toThrow(
      /供应商名称/,
    );
  });

  it("没这家：改返回 null、删返回 false", () => {
    const { db } = fakeDb();
    expect(updateModelProvider(db, "nope", { name: "x" })).toBeNull();
    expect(removeModelProvider(db, "nope")).toBe(false);
  });

  it("思考写法：新建默认 auto，显式传能存回，改缺省不动", () => {
    const { db } = fakeDb();
    // 没给 = 跟格式挑默认写法，存量行为不变
    expect(createModelProvider(db, ok).provider.thinkingDialect).toBe("auto");
    const { provider } = createModelProvider(db, {
      ...ok,
      name: "GLM",
      thinkingDialect: "thinking-object",
    });
    expect(provider.thinkingDialect).toBe("thinking-object");
    expect(listModelProviders(db).map((x) => x.thinkingDialect)).toEqual([
      "auto",
      "thinking-object",
    ]);
    // 缺省不动：只改名称，写法保持原样（漏写这一列就会被静默重置成 auto）
    expect(
      updateModelProvider(db, provider.id, { name: "GLM 2" })?.thinkingDialect,
    ).toBe("thinking-object");
    // 给了就换
    expect(
      updateModelProvider(db, provider.id, { thinkingDialect: "anthropic" })
        ?.thinkingDialect,
    ).toBe("anthropic");
  });

  it("思考写法脏值一律回 auto：认不出的字符串、数字、手改的旧值", () => {
    const { db } = fakeDb();
    expect(
      createModelProvider(db, { ...ok, thinkingDialect: "LOUD" }).provider
        .thinkingDialect,
    ).toBe("auto");
    expect(
      createModelProvider(db, {
        ...ok,
        name: "数字",
        thinkingDialect: 123 as unknown as string,
      }).provider.thinkingDialect,
    ).toBe("auto");
    const { provider } = createModelProvider(db, ok);
    expect(
      updateModelProvider(db, provider.id, { thinkingDialect: "LOUD" })
        ?.thinkingDialect,
    ).toBe("auto");
    expect(
      updateModelProvider(db, provider.id, {
        thinkingDialect: 123 as unknown as string,
      })?.thinkingDialect,
    ).toBe("auto");
  });

  it("删一家连同名下条目；名下有生效条目时最新的一条顶上", () => {
    const { db } = fakeDb();
    const a = createModelProvider(db, { ...ok, name: "A", firstModel: "a-1" });
    const b = createModelProvider(db, { ...ok, name: "B", firstModel: "b-1" });
    expect(a.entry).not.toBeNull();
    expect(b.entry).not.toBeNull();
    // a 的条目是最早建的、自动生效
    expect(removeModelProvider(db, a.provider.id)).toBe(true);
    expect(listModelProviders(db).map((x) => x.name)).toEqual(["B"]);
    // 生效条目跟着 a 被删了：b 的条目顶上，目录不空转
    const active = getActiveModelEntry(db);
    expect(active?.model).toBe("b-1");
  });
});

describe("模型条目增删改查", () => {
  it("建条目：供应商必须先在，模型名不能空", () => {
    const { db } = fakeDb();
    expect(() =>
      createModelEntry(db, { providerId: "nope", model: "x" }),
    ).toThrow(/供应商不存在/);
    const { provider } = createModelProvider(db, ok);
    expect(() =>
      createModelEntry(db, { providerId: provider.id, model: "  " }),
    ).toThrow(/模型名/);
  });

  it("一家挂几个条目就存几个；activate 点名生效且全库唯一", () => {
    const { db } = fakeDb();
    const { provider } = createModelProvider(db, {
      ...ok,
      firstModel: "m-1",
    });
    const e2 = createModelEntry(db, { providerId: provider.id, model: "m-2" });
    const e3 = createModelEntry(db, { providerId: provider.id, model: "m-3" });
    expect(listModelEntries(db)).toHaveLength(3);
    const hit = activateModelEntry(db, e3.id);
    expect(hit?.active).toBe(true);
    expect(getActiveModelEntry(db)?.id).toBe(e3.id);
    expect(listModelEntries(db).filter((x) => x.active)).toHaveLength(1);
    expect(e2.active).toBe(false);
  });

  it("改条目：模型名与输出上限，缺省不动", () => {
    const { db } = fakeDb();
    const { provider } = createModelProvider(db, {
      ...ok,
      firstModel: "m-1",
      maxOutput: 8192,
    });
    const e = listModelEntries(db).find((x) => x.providerId === provider.id)!;
    const up = updateModelEntry(db, e.id, { model: "m-1b", maxOutput: 16384 });
    expect(up?.model).toBe("m-1b");
    expect(up?.maxOutput).toBe(16384);
    expect(() => updateModelEntry(db, e.id, { model: "" })).toThrow(/模型名/);
  });

  it("改条目设为生效 = 先全清再置一：全库唯一，换得动（只改自己会弹回）", () => {
    const { db } = fakeDb();
    const { provider } = createModelProvider(db, { ...ok, firstModel: "m-1" });
    const e2 = createModelEntry(db, { providerId: provider.id, model: "m-2" });
    // m-1 先建、自动生效；把 m-2 设为生效后，生效的必须只剩 m-2 ——
    // 两条都挂 active 的话 getActiveModelEntry 取最早那条，面板上就是「选了又弹回」
    expect(updateModelEntry(db, e2.id, { active: true })?.active).toBe(true);
    expect(getActiveModelEntry(db)?.id).toBe(e2.id);
    expect(listModelEntries(db).filter((x) => x.active)).toHaveLength(1);
    // 反向：取消生效后全库无生效，不留暗桩
    updateModelEntry(db, e2.id, { active: false });
    expect(getActiveModelEntry(db)).toBeNull();
    expect(listModelEntries(db).filter((x) => x.active)).toHaveLength(0);
  });

  it("删普通条目：生效条目不受影响；删的是生效条目时最新的顶上", () => {
    const { db } = fakeDb();
    const { provider } = createModelProvider(db, {
      ...ok,
      firstModel: "m-1",
    });
    createModelEntry(db, { providerId: provider.id, model: "m-2" });
    const [m1, m2] = listModelEntries(db);
    expect(removeModelEntry(db, m2.id)).toBe(true);
    expect(getActiveModelEntry(db)?.id).toBe(m1.id);
    expect(listModelEntries(db)).toHaveLength(1);
    expect(removeModelEntry(db, m1.id)).toBe(true);
    expect(getActiveModelEntry(db)).toBeNull();
  });

  it("max_output 只认正整数，其余一律回 131072", () => {
    expect(toMaxOutput(8192)).toBe(8192);
    expect(toMaxOutput(0)).toBe(131072);
    expect(toMaxOutput(-1)).toBe(131072);
    expect(toMaxOutput(1.5)).toBe(131072);
    expect(toMaxOutput(undefined)).toBe(131072);
  });

  it("context_window 建了读得回、改缺省不动；0 = 没设（用默认档）", () => {
    const { db } = fakeDb();
    const { provider } = createModelProvider(db, {
      ...ok,
      firstModel: "m-1",
      // 建供应商挂首条时不带 contextWindow：落库 0（= 未设）
    });
    const e1 = listModelEntries(db)[0];
    expect(e1.contextWindow).toBe(0);

    const e2 = createModelEntry(db, {
      providerId: provider.id,
      model: "m-2",
      contextWindow: 200_000,
    });
    expect(e2.contextWindow).toBe(200_000);
    // 缺省不动：只改模型名，窗口保持原样
    const up = updateModelEntry(db, e2.id, { model: "m-2b" });
    expect(up?.contextWindow).toBe(200_000);
    // 给了就换；0 回到「未设」而不是把窗口掐成零宽
    const up2 = updateModelEntry(db, e2.id, { contextWindow: 1_000_000 });
    expect(up2?.contextWindow).toBe(1_000_000);
    expect(
      updateModelEntry(db, e2.id, { contextWindow: 0 })?.contextWindow,
    ).toBe(0);
  });

  it("context_window 只认正整数，其余一律回 0（没设是合法状态）", () => {
    expect(toContextWindow(200_000)).toBe(200_000);
    expect(toContextWindow(0)).toBe(0);
    expect(toContextWindow(-5)).toBe(0);
    expect(toContextWindow(1.5)).toBe(0);
    expect(toContextWindow(undefined)).toBe(0);
    expect(toContextWindow("128000")).toBe(128_000);
  });

  it("思考强度与预算：建了读得回、patch 能改、缺省不动", () => {
    const { db } = fakeDb();
    const { provider } = createModelProvider(db, { ...ok, firstModel: "m-1" });
    // 首条没给：落 "" 与 0（= 没设，一个字都不发）
    const e1 = listModelEntries(db)[0];
    expect(e1.thinking).toBe("");
    expect(e1.thinkingBudget).toBe(0);

    const e2 = createModelEntry(db, {
      providerId: provider.id,
      model: "m-2",
      thinking: "high",
      thinkingBudget: 8192,
    });
    expect(e2.thinking).toBe("high");
    expect(e2.thinkingBudget).toBe(8192);
    expect(listModelEntries(db).find((x) => x.id === e2.id)).toMatchObject({
      thinking: "high",
      thinkingBudget: 8192,
    });

    // 缺省不动：只改模型名，思考和预算都保持原样
    const same = updateModelEntry(db, e2.id, { model: "m-2b" });
    expect(same?.thinking).toBe("high");
    expect(same?.thinkingBudget).toBe(8192);
    // 给了就换
    const changed = updateModelEntry(db, e2.id, {
      thinking: "max",
      thinkingBudget: 32768,
    });
    expect(changed?.thinking).toBe("max");
    expect(changed?.thinkingBudget).toBe(32768);
    // "" 与 0 是「清成没设」的合法值，不是脏值
    const cleared = updateModelEntry(db, e2.id, {
      thinking: "",
      thinkingBudget: 0,
    });
    expect(cleared?.thinking).toBe("");
    expect(cleared?.thinkingBudget).toBe(0);
  });

  it("思考脏值归一：档位认不出就当没设，预算只认正整数", () => {
    const { db } = fakeDb();
    const { provider } = createModelProvider(db, ok);
    // 带尾空格 / 大小写不对 / 根本不是字符串：宁可不发，也不要发厂商看不懂的值
    const badLevels = ["high ", "LOUD", 123 as unknown as string];
    for (const [i, level] of badLevels.entries()) {
      const e = createModelEntry(db, {
        providerId: provider.id,
        model: `level-${i}`,
        thinking: level,
      });
      expect(e.thinking).toBe("");
    }
    const e = createModelEntry(db, {
      providerId: provider.id,
      model: "m-1",
      thinking: "high",
    });
    // 改的时候同样归一：存不进去的值不该留下来
    expect(updateModelEntry(db, e.id, { thinking: "LOUD" })?.thinking).toBe("");
    expect(updateModelEntry(db, e.id, { thinking: "high " })?.thinking).toBe("");

    // 预算只认正整数：0 / 负数 / 小数 / 非数字 / null 都表示「没填，按档位换算」
    const badBudgets = [
      -1,
      1.5,
      "abc" as unknown as number,
      null as unknown as number,
    ];
    for (const [i, budget] of badBudgets.entries()) {
      const row = createModelEntry(db, {
        providerId: provider.id,
        model: `budget-${i}`,
        thinkingBudget: budget,
      });
      expect(row.thinkingBudget).toBe(0);
    }
    const withBudget = createModelEntry(db, {
      providerId: provider.id,
      model: "m-2",
      thinkingBudget: 4096,
    });
    expect(withBudget.thinkingBudget).toBe(4096);
    expect(
      updateModelEntry(db, withBudget.id, { thinkingBudget: -1 })
        ?.thinkingBudget,
    ).toBe(0);
  });
});

describe("生效一组（条目 + 供应商）", () => {
  it("getActiveCatalog / getCatalogById：拼得出完整一组，缺了哪家算失效", () => {
    const { db } = fakeDb();
    const { provider } = createModelProvider(db, {
      ...ok,
      firstModel: "m-1",
      maintKeySecret: "SK_MAINT",
      maintModel: "m-flash",
    });
    const cat = getActiveCatalog(db);
    expect(cat?.provider.id).toBe(provider.id);
    expect(cat?.entry.model).toBe("m-1");
    expect(cat?.provider.maintModel).toBe("m-flash");

    const byId = getCatalogById(db, cat!.entry.id);
    expect(byId?.entry.id).toBe(cat!.entry.id);
    expect(getCatalogById(db, "nope")).toBeNull();
  });

  it("供应商校验：format 三值、必填逐项拒", () => {
    const { db } = fakeDb();
    expect(() => createModelProvider(db, { ...ok, format: "gemini" })).toThrow(
      /接口格式/,
    );
    expect(() => createModelProvider(db, { ...ok, format: "" })).toThrow(
      /format/,
    );
    expect(() => createModelProvider(db, { ...ok, name: "  " })).toThrow(
      /供应商名称/,
    );
    expect(() => createModelProvider(db, { ...ok, baseUrl: "" })).toThrow(
      /baseUrl/,
    );
    expect(() => createModelProvider(db, { ...ok, keySecret: "" })).toThrow(
      /keySecret/,
    );
  });
});

describe("老单表惰性迁移", () => {
  const legacyRow: LRow = {
    id: "abcd1234",
    name: "DeepSeek 主线",
    format: "anthropic",
    base_url: "https://api.deepseek.com/anthropic",
    key_secret: "DEEPSEEK_KEY",
    model: "deepseek-v4-pro",
    max_output: 16384,
    maint_key_secret: "SK_MAINT",
    maint_model: "deepseek-flash",
    active: 1,
    created: "2026-01-01T00:00:00.000Z",
  };

  it("一行老配置拆成一家供应商 + 一条条目；条目 id 沿用老配置 id", () => {
    const { db } = fakeDb([legacyRow]);
    ensureModelCatalogSchema(db);
    const providers = listModelProviders(db);
    expect(providers).toHaveLength(1);
    expect(providers[0]).toMatchObject({
      name: "DeepSeek 主线",
      format: "anthropic",
      baseUrl: "https://api.deepseek.com/anthropic",
      keySecret: "DEEPSEEK_KEY",
      maintKeySecret: "SK_MAINT",
      maintModel: "deepseek-flash",
      // 老表没有思考配置：新供应商按 auto 落，行为跟升级前一致
      thinkingDialect: "auto",
    });
    const entries = listModelEntries(db);
    expect(entries).toHaveLength(1);
    // 条目 id 沿用老 config id：state.deepConfigId 指着它，不能断
    expect(entries[0].id).toBe("abcd1234");
    expect(entries[0].providerId).toBe(providers[0].id);
    expect(entries[0].model).toBe("deepseek-v4-pro");
    expect(entries[0].maxOutput).toBe(16384);
    expect(entries[0].active).toBe(true);
    // 思考强度/预算也按「没设」落：存量条目继续跟厂商默认走
    expect(entries[0].thinking).toBe("");
    expect(entries[0].thinkingBudget).toBe(0);
    // 迁移只跑一次：老表改名后下一次启动不再触发
    expect(getCatalogById(db, "abcd1234")).not.toBeNull();
    ensureModelCatalogSchema(db);
    expect(listModelProviders(db)).toHaveLength(1);
  });

  it("active 是 1/0 数值也认；没有老表时迁移什么都不做", () => {
    const { db } = fakeDb([{ ...legacyRow, active: 0 }]);
    ensureModelCatalogSchema(db);
    expect(listModelEntries(db)[0].active).toBe(false);
    // 没有生效条目：新条目自动生效的语义还等着顶上
    const { provider } = createModelProvider(db, { ...ok, name: "新家" });
    const e = createModelEntry(db, {
      providerId: provider.id,
      model: "m-1",
    });
    expect(e.active).toBe(true);

    const empty = fakeDb();
    ensureModelCatalogSchema(empty.db);
    expect(listModelProviders(empty.db)).toHaveLength(0);
  });
});
