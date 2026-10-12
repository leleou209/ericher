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
  created: string;
}

interface ERow {
  id: string;
  provider_id: string;
  model: string;
  max_output: number;
  context_window: number;
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

    // 老表补列（context_window）：真库上列已存在会抛错被吞，假库直接当成功
    if (sql.startsWith("alter table model_entries")) return [] as T[];

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
      ];
      providers.push({
        id,
        name,
        format,
        base_url,
        key_secret,
        maint_key_secret,
        maint_model,
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
        active,
        created,
      ] = values as [string, string, string, number, number, number, string];
      entries.push({
        id,
        provider_id,
        model,
        max_output: Number(max_output),
        context_window: Number(context_window),
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
      const [model, max_output, context_window, active, id] = values as [
        string,
        number,
        number,
        number,
        string,
      ];
      const row = entries.find((r) => r.id === id);
      if (!row) throw new Error("假库：update 没找到行");
      Object.assign(row, {
        model,
        max_output: Number(max_output),
        context_window: Number(context_window),
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
        id,
      ] = values as [string, string, string, string, string, string, string];
      const row = providers.find((r) => r.id === id);
      if (!row) throw new Error("假库：update 没找到行");
      Object.assign(row, {
        name,
        format,
        base_url,
        key_secret,
        maint_key_secret,
        maint_model,
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
    });
    const entries = listModelEntries(db);
    expect(entries).toHaveLength(1);
    // 条目 id 沿用老 config id：state.deepConfigId 指着它，不能断
    expect(entries[0].id).toBe("abcd1234");
    expect(entries[0].providerId).toBe(providers[0].id);
    expect(entries[0].model).toBe("deepseek-v4-pro");
    expect(entries[0].maxOutput).toBe(16384);
    expect(entries[0].active).toBe(true);
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
