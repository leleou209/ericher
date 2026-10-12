/**
 * 全局主题（theme_config）测试。
 *
 * 主题是整份文档（弹页还是嵌套列表），表只有一行（id=1）、data 列存 JSON，
 * 出入都过 normalizeTheme 收口。这里验四件事：
 * - normalizeTheme：脏输入/空输入回落出厂全形状；数字钳进区间；枚举不认识回落出厂；
 *   素材引用只认 `asset:<文件名>` 或 http(s)，路径穿越、怪协议统统变空串；
 * - applyThemePatch：字段缺省不动、背景局部合并（只改 dim 不动 src）、
 *   图标覆盖增删与上限、非法枚举抛人话错误、弹页整组替换；
 * - referencedAssets：所有 asset: 引用收齐去重，外链不算；
 * - loadTheme/saveTheme/patchTheme：单行表往返，空表/坏 JSON 回落出厂（读路径不许抛）。
 *
 * 表用最小假 SQL 引擎，只认得 themeConfig.ts 会发的那几条语句。
 *
 * 运行: npx vitest run test/themeConfig.test.ts
 */

import { describe, it, expect } from "vitest";
import {
  applyThemePatch,
  defaultTheme,
  deleteThemeSet,
  ensureThemeSchema,
  getThemeSet,
  insertThemeSet,
  listThemeSets,
  loadTheme,
  MAX_THEME_SETS,
  normalizeTheme,
  patchTheme,
  referencedAssets,
  saveTheme,
} from "../src/agent/themeConfig";
import type { SqlTag } from "../src/agent/state";

interface Row {
  data: string;
}

/** 最小假 SQL 引擎：theme_config 单行表（id=1），语句按前缀认 */
function fakeDb() {
  let row: Row | undefined;

  const db = (<T>(strings: TemplateStringsArray, ...values: unknown[]): T[] => {
    const sql = strings.join("?").replace(/\s+/g, " ").trim().toLowerCase();

    if (sql.startsWith("create table")) return [] as T[];

    if (sql.startsWith("select data from theme_config")) {
      return (row ? [row] : []) as T[];
    }

    if (sql.startsWith("insert into theme_config")) {
      row = { data: String(values[0]) };
      return [] as T[];
    }

    throw new Error("假库不认得这条语句：" + sql);
  }) as unknown as SqlTag;

  return {
    db,
    /** 落库的原始 JSON（想塞坏行也从这里塞） */
    raw: () => row?.data,
    corrupt: (bad: string) => {
      row = { data: bad };
    },
  };
}

describe("normalizeTheme（任意输入收口成全形状）", () => {
  it("空输入/脏输入回落出厂全形状，一个字段都不缺", () => {
    for (const raw of [undefined, null, "我是一段字符串", 42, {}, { nonsense: 1 }]) {
      expect(normalizeTheme(raw)).toEqual(defaultTheme());
    }
  });

  it("数字钳进区间：dim 0~1、blur 0~40、delaySeconds 0~3600", () => {
    const t = normalizeTheme({
      backgrounds: { global: { dim: 5, blur: -3 }, chat: { dim: "x", blur: 999 } },
      popups: [{ delaySeconds: 99999 }, { delaySeconds: -5 }, { delaySeconds: "x" }],
    });
    expect(t.backgrounds.global).toMatchObject({ dim: 1, blur: 0 });
    expect(t.backgrounds.chat).toMatchObject({ dim: 0, blur: 40 });
    expect(t.popups.map((p) => p.delaySeconds)).toEqual([3600, 0, 0]);
  });

  it("枚举不认识就回落出厂值：base / motion / messageStyle / trigger", () => {
    const t = normalizeTheme({
      base: "alien",
      motion: "hyper",
      messageStyle: "flat",
      popups: [{ trigger: "click" }],
    });
    expect(t.base).toBe("paper");
    expect(t.motion).toBe("default");
    expect(t.messageStyle).toBe("bubble");
    expect(t.popups[0].trigger).toBe("load");
    // 认识的枚举原样留着
    const ok = normalizeTheme({
      base: "dark",
      motion: "gentle",
      messageStyle: "card",
      popups: [{ trigger: "daily" }],
    });
    expect(ok).toMatchObject({ base: "dark", motion: "gentle", messageStyle: "card" });
    expect(ok.popups[0].trigger).toBe("daily");
  });

  it("基调色收口：三个数不齐当没有，越界夹回范围", () => {
    expect(normalizeTheme({ tint: "红" }).tint).toBeNull();
    expect(normalizeTheme({ tint: { h: 200, s: 50 } }).tint).toBeNull();
    expect(normalizeTheme({ tint: { h: 999, s: -20, l: 250 } }).tint).toEqual({
      h: 360,
      s: 0,
      l: 100,
    });
    expect(normalizeTheme({ tint: { h: 214, s: 50, l: 24 } }).tint).toEqual({
      h: 214,
      s: 50,
      l: 24,
    });
  });

  it("基调色脏值当没有：字符串数字/布尔/数组都不算数，整组置 null", () => {
    // Number() 的隐式转换（""→0、true→1、[5]→5）会把说不清来路的值悄悄放进来，
    // 只认本来就是个有限数 —— 写坏了宁可回预设，不能拿个莫名的 0 去染整套灰阶
    expect(normalizeTheme({ tint: { h: "214", s: "50", l: "24" } }).tint).toBeNull();
    expect(normalizeTheme({ tint: { h: "", s: 50, l: 24 } }).tint).toBeNull();
    expect(normalizeTheme({ tint: { h: true, s: 50, l: 24 } }).tint).toBeNull();
    expect(normalizeTheme({ tint: { h: [5], s: 50, l: 24 } }).tint).toBeNull();
    expect(normalizeTheme({ tint: { h: NaN, s: 50, l: 24 } }).tint).toBeNull();
  });

  it("素材引用收口：路径穿越、怪协议统统变空串", () => {
    const t = normalizeTheme({
      agentAvatar: "asset:../x.png",
      backgrounds: {
        global: { src: "asset:a/b.png" },
        chat: { src: "asset:a\\b.png" },
        notes: { src: "asset:.." },
        settings: { src: "asset:" },
        gate: { src: "javascript:alert(1)" },
        login: { src: "ftp://x/y.png" },
      },
    });
    expect(t.agentAvatar).toBe("");
    for (const bg of Object.values(t.backgrounds)) expect(bg.src).toBe("");
  });

  it("http(s) 外链和干净的 asset: 引用原样留着", () => {
    const t = normalizeTheme({
      agentAvatar: "asset:face.png",
      backgrounds: {
        global: { src: "https://cdn.example.com/bg.png" },
        chat: { src: "http://cdn.example.com/bg2.png" },
      },
    });
    expect(t.agentAvatar).toBe("asset:face.png");
    expect(t.backgrounds.global.src).toBe("https://cdn.example.com/bg.png");
    expect(t.backgrounds.chat.src).toBe("http://cdn.example.com/bg2.png");
  });

  it("外链协议头大小写不敏感（跟前端同一把尺），规范成小写再存", () => {
    // 前端 resolveAsset 认 HTTPS://，后端不认的话：预览正常、保存被静默清空
    const t = normalizeTheme({
      agentAvatar: "HTTPS://cdn.example.com/face.png",
      backgrounds: { global: { src: "Http://cdn.example.com/bg.png" } },
    });
    expect(t.agentAvatar).toBe("https://cdn.example.com/face.png");
    expect(t.backgrounds.global.src).toBe("http://cdn.example.com/bg.png");
  });

  it("popups 去重、封顶 20 条，没给 id 的自动补", () => {
    const dup = normalizeTheme({ popups: [{ id: "a" }, { id: "a" }, { id: "b" }] });
    expect(dup.popups.map((p) => p.id)).toEqual(["a", "b"]);

    const many = normalizeTheme({
      popups: Array.from({ length: 25 }, (_, i) => ({ id: `p${i}` })),
    });
    expect(many.popups).toHaveLength(20);
    expect(many.popups[0].id).toBe("p0");

    const auto = normalizeTheme({ popups: [{ title: "甲" }, { title: "乙" }] });
    expect(auto.popups.map((p) => p.id)).toEqual(["popup-1", "popup-2"]);
  });

  it("弹页 enabled 缺省是开的，只有显式 false 才关", () => {
    const t = normalizeTheme({ popups: [{}, { enabled: false }] });
    expect(t.popups[0].enabled).toBe(true);
    expect(t.popups[1].enabled).toBe(false);
  });

  it("弹页动作按钮：站内路径与 http(s) 外链放行，协议头规范成小写", () => {
    const t = normalizeTheme({
      popups: [
        {
          actions: [
            { label: "看公告", to: "/show" },
            { label: "去官网", to: "HTTPS://Example.com/x" },
          ],
        },
      ],
    });
    expect(t.popups[0].actions).toEqual([
      { label: "看公告", to: "/show" },
      { label: "去官网", to: "https://Example.com/x" },
    ]);
  });

  it("弹页动作按钮：脏 to / 空 label 整条丢，label 截 20 字", () => {
    const t = normalizeTheme({
      popups: [
        {
          actions: [
            { label: "坏协议", to: "javascript:alert(1)" },
            { label: "相对路径", to: "show" },
            { label: "协议相对", to: "//evil.com/x" },
            { label: "空的", to: "" },
            { label: "  ", to: "/x" },
            { label: "字".repeat(30), to: "/ok" },
          ],
        },
      ],
    });
    expect(t.popups[0].actions).toEqual([{ label: "字".repeat(20), to: "/ok" }]);
  });

  it("弹页动作按钮封顶 2 条，脏类型/缺省回落空数组", () => {
    const many = normalizeTheme({
      popups: [
        {
          actions: [
            { label: "一", to: "/a" },
            { label: "二", to: "/b" },
            { label: "三", to: "/c" },
          ],
        },
      ],
    });
    expect(many.popups[0].actions.map((a) => a.label)).toEqual(["一", "二"]);

    // 没给 / 给了非数组都回落成空
    expect(normalizeTheme({ popups: [{}] }).popups[0].actions).toEqual([]);
    expect(normalizeTheme({ popups: [{ actions: "x" }] }).popups[0].actions).toEqual(
      [],
    );
  });

  it("iconOverrides 封顶 100 条，脏引用/空键直接丢掉", () => {
    const icons: Record<string, string> = {};
    for (let i = 0; i < 105; i++) icons[`i${i}`] = "asset:a.png";
    icons["脏的"] = "asset:../x.png";
    const t = normalizeTheme({ iconOverrides: icons });
    expect(Object.keys(t.iconOverrides)).toHaveLength(100);
    expect(t.iconOverrides["脏的"]).toBeUndefined();
    expect(t.iconOverrides["i0"]).toBe("asset:a.png");
  });
});

describe("applyThemePatch（局部补丁语义）", () => {
  const cur = normalizeTheme({
    base: "dark",
    agentName: "小艾",
    backgrounds: {
      global: { src: "asset:bg.png", dim: 0.3, blur: 6 },
      chat: { src: "asset:chat.png", dim: 0.1, blur: 0 },
    },
    iconOverrides: { home: "asset:home.png" },
    popups: [{ id: "a" }, { id: "b" }],
  });

  it("空补丁什么都不动", () => {
    expect(applyThemePatch(cur, {})).toEqual(normalizeTheme(cur));
  });

  it("backgrounds 局部合并：只改 dim 不动 src，别的区块不碰", () => {
    const out = applyThemePatch(cur, { backgrounds: { global: { dim: 0.8 } } });
    expect(out.backgrounds.global).toMatchObject({
      src: "asset:bg.png",
      dim: 0.8,
      blur: 6,
    });
    expect(out.backgrounds.chat).toEqual(normalizeTheme(cur).backgrounds.chat);
  });

  it("不认识的区块名直接忽略，不进主题", () => {
    const out = applyThemePatch(cur, { backgrounds: { alien: { dim: 1 } } });
    expect(out).toEqual(normalizeTheme(cur));
  });

  it("iconOverrides 传 null 删掉这条，传新值增/改", () => {
    const out = applyThemePatch(cur, {
      iconOverrides: { home: null, save: "asset:save.png" },
    });
    expect(out.iconOverrides).toEqual({ save: "asset:save.png" });

    const upd = applyThemePatch(cur, { iconOverrides: { home: "asset:new.png" } });
    expect(upd.iconOverrides.home).toBe("asset:new.png");
  });

  it("iconOverrides 超过 100 条抛人话错误（改老的不算新增）", () => {
    const icons: Record<string, string> = {};
    for (let i = 0; i < 100; i++) icons[`i${i}`] = "asset:a.png";
    const full = normalizeTheme({ iconOverrides: icons });
    expect(() =>
      applyThemePatch(full, { iconOverrides: { newbie: "asset:x.png" } }),
    ).toThrow(/图标覆盖最多 100 条/);
    // 满了以后改已有的那条照样放行
    expect(() =>
      applyThemePatch(full, { iconOverrides: { i0: "asset:x.png" } }),
    ).not.toThrow();
  });

  it("iconOverrides 引用不对抛人话错误", () => {
    expect(() =>
      applyThemePatch(cur, { iconOverrides: { bad: "asset:../x.png" } }),
    ).toThrow(/图片地址不对/);
    expect(() =>
      applyThemePatch(cur, { iconOverrides: { bad: "javascript:alert(1)" } }),
    ).toThrow(/图片地址不对/);
  });

  it("写路径超长当场抛：URL 400、CSS 2000、customCss 10000，读路径仍静默截断", () => {
    // 截一半的链接是坏链接 —— 预览好好的图保存完就 404，比拒绝保存更糊涂
    const longUrl = `https://x.io/${"a".repeat(400)}`;
    expect(() => applyThemePatch(cur, { agentAvatar: longUrl })).toThrow(
      /头像图片地址/,
    );
    expect(() =>
      applyThemePatch(cur, { backgrounds: { global: { src: longUrl } } }),
    ).toThrow(/背景图片地址/);
    expect(() =>
      applyThemePatch(cur, { iconOverrides: { home: `asset:${"a".repeat(400)}` } }),
    ).toThrow(/图片地址/);
    expect(() => applyThemePatch(cur, { panelBg: "x".repeat(2001) })).toThrow(
      /功能块背景/,
    );
    expect(() => applyThemePatch(cur, { customCss: "x".repeat(10001) })).toThrow(
      /自定义 CSS/,
    );
    // 读路径面对的是库里的存量脏数据，不能抛：照旧收口截断
    expect(normalizeTheme({ panelBg: "x".repeat(3000) }).panelBg).toHaveLength(2000);
    // 卡着上限的写路径照常放行
    expect(() => applyThemePatch(cur, { panelBg: "x".repeat(2000) })).not.toThrow();
  });

  it("base/motion/messageStyle 不认识抛人话错误", () => {
    expect(() => applyThemePatch(cur, { base: "alien" })).toThrow(/不认识这种基调/);
    expect(() => applyThemePatch(cur, { motion: "hyper" })).toThrow(/不认识这种动画档/);
    expect(() => applyThemePatch(cur, { messageStyle: "flat" })).toThrow(
      /不认识这种消息栏风格/,
    );
  });

  it("基调色：传 {h,s,l} 覆盖，传 null 清掉回预设，给歪了当场抛", () => {
    const out = applyThemePatch(cur, { tint: { h: 214, s: 50, l: 24 } });
    expect(out.tint).toEqual({ h: 214, s: 50, l: 24 });

    const cleared = applyThemePatch(out, { tint: null });
    expect(cleared.tint).toBeNull();

    // 没带 tint 的补丁不碰它
    expect(applyThemePatch(out, { agentName: "乙" }).tint).toEqual({
      h: 214,
      s: 50,
      l: 24,
    });

    expect(() => applyThemePatch(cur, { tint: { h: 1 } as never })).toThrow(
      /色相\/浓度\/深浅/,
    );
    expect(() => applyThemePatch(cur, { tint: "红" as never })).toThrow(
      /色相\/浓度\/深浅/,
    );
  });

  it("popups 整组替换，不做逐条 diff", () => {
    const out = applyThemePatch(cur, { popups: [{ id: "only" }] });
    expect(out.popups.map((p) => p.id)).toEqual(["only"]);
  });
});

describe("referencedAssets（主题引用了哪些素材）", () => {
  it("从背景/头像/图标覆盖/弹页收集 asset: 引用、去重，外链不算", () => {
    const theme = normalizeTheme({
      backgrounds: {
        global: { src: "asset:bg.png" },
        chat: { src: "https://example.com/x.png" },
      },
      agentAvatar: "asset:face.png",
      iconOverrides: { home: "asset:bg.png", save: "https://example.com/i.png" },
      popups: [{ image: "asset:pop.png" }, { image: "asset:face.png" }],
    });
    expect(referencedAssets(theme).sort()).toEqual(["bg.png", "face.png", "pop.png"]);
  });

  it("按钮花纹的 asset: 引用、功能块背景 url() 里的素材也追踪（导出别漏图）", () => {
    const theme = normalizeTheme({
      agentAvatar: "asset:face.png",
      buttonPattern: "asset:pattern.png",
      panelBg: 'url("/api/theme-asset/panel.png")',
    });
    expect(referencedAssets(theme).sort()).toEqual([
      "face.png",
      "panel.png",
      "pattern.png",
    ]);
  });

  it("功能块背景里的外链图不算素材", () => {
    const theme = normalizeTheme({
      panelBg: 'url("https://cdn.example.com/p.png")',
      buttonPattern: "https://cdn.example.com/b.png",
    });
    expect(referencedAssets(theme)).toEqual([]);
  });

  it("customCss 里嵌的素材引用也追踪（导出别漏图）", () => {
    // customCss 同样是原样注入的整段 CSS，漏扫的话导出的包缺图、导入不校验悬空
    const theme = normalizeTheme({
      customCss:
        '.hero { background: url("/api/theme-asset/hero.png"); }\n' +
        ".mark::before { content: url(asset:mark.png); }",
    });
    expect(referencedAssets(theme).sort()).toEqual(["hero.png", "mark.png"]);
  });

  it("什么都没引用就是空名单", () => {
    expect(referencedAssets(defaultTheme())).toEqual([]);
  });
});

describe("loadTheme / saveTheme / patchTheme（单行表往返）", () => {
  it("表是空的回落出厂主题", () => {
    const { db } = fakeDb();
    expect(loadTheme(db)).toEqual(defaultTheme());
  });

  it("行里 JSON 坏了也回落出厂主题：读路径不许抛", () => {
    const { db, corrupt } = fakeDb();
    corrupt("{这不是 JSON");
    expect(loadTheme(db)).toEqual(defaultTheme());
  });

  it("save 后 load 往返一致，脏输入先收口再落库", () => {
    const { db, raw } = fakeDb();
    const saved = saveTheme(db, {
      locked: true,
      base: "dawn",
      agentName: "  小艾  ",
      agentAvatar: "asset:face.png",
      backgrounds: { global: { src: "asset:bg.png", dim: 0.4, blur: 8 } },
      popups: [{ id: "a", title: "公告", trigger: "daily" }],
    });
    expect(saved.agentName).toBe("小艾");
    expect(loadTheme(db)).toEqual(saved);
    // 落库的是收口后的全形状 JSON
    expect(JSON.parse(raw()!)).toEqual(saved);
  });

  it("patch 只改点名的字段，改完落库，再 load 看得见", () => {
    const { db } = fakeDb();
    saveTheme(db, { agentName: "小艾", base: "paper" });
    const out = patchTheme(db, { base: "dark", backgrounds: { chat: { dim: 0.5 } } });
    expect(out).toMatchObject({ base: "dark", agentName: "小艾" });
    expect(loadTheme(db)).toEqual(out);
    expect(loadTheme(db).backgrounds.chat.dim).toBe(0.5);
  });

  it("patch 非法枚举抛错时不动库里已有的主题", () => {
    const { db } = fakeDb();
    saveTheme(db, { agentName: "小艾" });
    expect(() => patchTheme(db, { base: "alien" })).toThrow(/不认识这种基调/);
    expect(loadTheme(db)).toMatchObject({ agentName: "小艾", base: "paper" });
  });

  it("ensureThemeSchema 幂等：连跑两次不炸", () => {
    const { db } = fakeDb();
    ensureThemeSchema(db);
    ensureThemeSchema(db);
    expect(loadTheme(db)).toEqual(defaultTheme());
  });
});

interface SetRow {
  id: string;
  name: string;
  pack_key: string;
  created: number;
  bytes: number;
}

/** 最小假 SQL 引擎：theme_sets 表（增删查） */
function fakeSetDb() {
  const rows: SetRow[] = [];

  const db = (<T>(strings: TemplateStringsArray, ...values: unknown[]): T[] => {
    const sql = strings.join("?").replace(/\s+/g, " ").trim().toLowerCase();

    if (sql.startsWith("create table")) return [] as T[];
    if (sql.startsWith("select count(*) as n from theme_sets"))
      return [{ n: rows.length }] as T[];
    if (
      sql.startsWith(
        "select id, name, pack_key, created, bytes from theme_sets where id =",
      )
    ) {
      const id = String(values[0]);
      return rows.filter((r) => r.id === id) as unknown as T[];
    }
    if (
      sql.startsWith(
        "select id, name, pack_key, created, bytes from theme_sets order by",
      )
    ) {
      return [...rows].sort((a, b) => b.created - a.created) as unknown as T[];
    }
    if (sql.startsWith("insert into theme_sets")) {
      rows.push({
        id: String(values[0]),
        name: String(values[1]),
        pack_key: String(values[2]),
        created: Number(values[3]),
        bytes: Number(values[4]),
      });
      return [] as T[];
    }
    if (sql.startsWith("delete from theme_sets")) {
      const id = String(values[0]);
      const i = rows.findIndex((r) => r.id === id);
      if (i >= 0) rows.splice(i, 1);
      return [] as T[];
    }

    throw new Error("假库不认得这条语句：" + sql);
  }) as unknown as SqlTag;

  return { db, rows };
}

describe("theme_sets（自定义主题存档的增删查）", () => {
  it("存一份再列出来，字段原样往返", () => {
    const { db } = fakeSetDb();
    const s = insertThemeSet(db, {
      name: "青花瓷",
      packKey: "f/public/betpag/a.zip",
      bytes: 2048,
    });
    expect(s.name).toBe("青花瓷");
    expect(s.packKey).toBe("f/public/betpag/a.zip");
    expect(s.bytes).toBe(2048);
    expect(s.id).toHaveLength(8);
    expect(listThemeSets(db)).toEqual([s]);
    expect(getThemeSet(db, s.id)).toEqual(s);
  });

  it("名字首尾空格修掉、超长截到 60；空名当场报", () => {
    const { db } = fakeSetDb();
    expect(insertThemeSet(db, { name: "  夜墨  ", packKey: "k", bytes: 1 }).name).toBe(
      "夜墨",
    );
    expect(
      insertThemeSet(db, { name: "字".repeat(80), packKey: "k", bytes: 1 }).name,
    ).toHaveLength(60);
    expect(() =>
      insertThemeSet(db, { name: "   ", packKey: "k", bytes: 1 }),
    ).toThrow(/名字不能为空/);
  });

  it("没给包体位置当场报（不然存进去也装不回来）", () => {
    const { db } = fakeSetDb();
    expect(() => insertThemeSet(db, { name: "x", packKey: "", bytes: 1 })).toThrow(
      /缺少包体位置/,
    );
  });

  it("列表新的在前", () => {
    const { db, rows } = fakeSetDb();
    rows.push(
      { id: "old", name: "旧", pack_key: "k1", created: 100, bytes: 1 },
      { id: "new", name: "新", pack_key: "k2", created: 200, bytes: 1 },
    );
    expect(listThemeSets(db).map((s) => s.id)).toEqual(["new", "old"]);
  });

  it("封顶 40 份，满了当场报，已存的还在", () => {
    const { db, rows } = fakeSetDb();
    for (let i = 0; i < MAX_THEME_SETS; i++)
      rows.push({ id: `s${i}`, name: `n${i}`, pack_key: "k", created: i, bytes: 1 });
    expect(() =>
      insertThemeSet(db, { name: "再来一份", packKey: "k", bytes: 1 }),
    ).toThrow(/最多 40 份/);
    expect(listThemeSets(db)).toHaveLength(MAX_THEME_SETS);
  });

  it("删一份回来被删的那条（调用方拿 packKey 去清云盘）；删不存在的回 null", () => {
    const { db } = fakeSetDb();
    const s = insertThemeSet(db, {
      name: "甲",
      packKey: "f/public/betpag/a.zip",
      bytes: 1,
    });
    expect(deleteThemeSet(db, s.id)?.packKey).toBe("f/public/betpag/a.zip");
    expect(listThemeSets(db)).toEqual([]);
    expect(deleteThemeSet(db, "nope")).toBeNull();
  });
});
