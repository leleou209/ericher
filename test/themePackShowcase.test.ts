/**
 * ericher 美术包「全功能展示」用例集。
 *
 * 把主题功能完全度装进一组用例：全字段 × 全部图片位 × 引用三形态 × 两侧
 * 缺本体防线 × 脏值收口，作为功能展示与回归的底册：
 * - 全功能展示包：背景 6 位、头像、功能块背景、按钮花纹、图标覆盖、动画/
 *   消息栏、自定义 CSS、5 条弹页全铺满，13 张图随包往返不丢不坏；
 * - 图片引用三种形态：asset: 进包、https 不进包、空串不铺，往返原样；
 * - 导出/导入缺本体矩阵：每个图片位引用了没字节的图都当场抛人话错误
 *   （按钮花纹的 asset:、功能块背景的 url() 一并在内，这两处以前会漏）；
 * - 清单脏值在包边界收口：非法基调/名字/头像/触发器/延时全收成安全值。
 *
 * 运行: npx vitest run test/themePackShowcase.test.ts
 */

import { describe, it, expect } from "vitest";
import { strToU8, zipSync } from "fflate";
import { packThemePack, unpackThemePack } from "../src/agent/themePack";
import { normalizeTheme } from "../src/agent/themeConfig";

const MANIFEST_FORMAT = "ericher-theme";

/** 造一张「图」：PNG 魔数 + 名字尾巴，每张字节独立可辨 */
function png(name: string): Uint8Array {
  const magic = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const tail = strToU8(name);
  const out = new Uint8Array(magic.length + tail.length);
  out.set(magic);
  out.set(tail, magic.length);
  return out;
}

/** 造一个包：清单 + 可选素材（键是纯文件名，自动放进 assets/） */
function makePack(
  manifest: unknown,
  assets: Record<string, Uint8Array> = {},
  extra: Record<string, Uint8Array> = {},
): Uint8Array {
  const files: Record<string, Uint8Array> = {
    "theme.json": strToU8(JSON.stringify(manifest)),
    ...Object.fromEntries(
      Object.entries(assets).map(([name, data]) => [`assets/${name}`, data]),
    ),
    ...extra,
  };
  return zipSync(files, { level: 0 });
}

const goodManifest = (theme: unknown = {}, over: Record<string, unknown> = {}) => ({
  format: MANIFEST_FORMAT,
  version: 1,
  theme,
  ...over,
});

/** 全字段铺满的展示主题：覆盖全部图片位（notes 走外链，看三种引用形态） */
function showcaseRaw(): Record<string, unknown> {
  return {
    locked: true,
    base: "dark",
    agentName: "ericher",
    agentAvatar: "asset:avatar.png",
    backgrounds: {
      global: {
        src: "asset:wall-global.png",
        dim: 0.35,
        blur: 8,
        position: "50% 30%",
        size: "cover",
      },
      chat: {
        src: "asset:wall-chat.png",
        dim: 0.2,
        blur: 4,
        position: "center",
        size: "cover",
      },
      notes: {
        src: "https://cdn.example.com/notes.png",
        dim: 0.5,
        blur: 12,
        position: "top",
        size: "contain",
      },
      settings: {
        src: "asset:wall-settings.png",
        dim: 0.1,
        blur: 0,
        position: "left top",
        size: "120% auto",
      },
      gate: {
        src: "asset:wall-gate.png",
        dim: 0.6,
        blur: 20,
        position: "bottom",
        size: "cover",
      },
      login: {
        src: "asset:wall-login.png",
        dim: 0.25,
        blur: 6,
        position: "center",
        size: "cover",
      },
    },
    panelBg: 'url("/api/theme-asset/panel.png")',
    buttonPattern: "asset:pattern.png",
    iconOverrides: {
      home: "asset:icon-home.png",
      chat: "asset:icon-chat.png",
      save: "https://cdn.example.com/save.png",
    },
    motion: "gentle",
    messageStyle: "card",
    customCss: ".x { color: red; }",
    // 5 条弹页：四种触发全占、一条关着、一条无图；hello 图被两条复用（去重）
    popups: [
      {
        id: "hello",
        title: "你好",
        body: "欢迎",
        image: "asset:popup-hello.png",
        trigger: "load",
      },
      {
        id: "first",
        title: "初次见面",
        body: "自我介绍",
        image: "asset:popup-first.png",
        trigger: "first",
      },
      {
        id: "news",
        title: "每日一报",
        body: "今天有新东西",
        image: "asset:popup-later.png",
        trigger: "daily",
      },
      {
        id: "quiet",
        title: "静默",
        body: "关着的",
        image: "asset:popup-hello.png",
        trigger: "load",
        enabled: false,
      },
      {
        id: "later",
        title: "稍后",
        body: "延时弹",
        image: "",
        trigger: "delay",
        delaySeconds: 30,
      },
    ],
  };
}

/** 展示包的 13 张图：头像 1 + 背景 5 + 功能块 1 + 花纹 1 + 图标 2 + 弹页 3 */
function showcaseAssets(): Map<string, Uint8Array> {
  return new Map(
    [
      "avatar.png",
      "wall-global.png",
      "wall-chat.png",
      "wall-settings.png",
      "wall-gate.png",
      "wall-login.png",
      "panel.png",
      "pattern.png",
      "icon-home.png",
      "icon-chat.png",
      "popup-hello.png",
      "popup-first.png",
      "popup-later.png",
    ].map((n) => [n, png(n)]),
  );
}

describe("全功能展示包（全字段 × 全部图片位）", () => {
  const theme = normalizeTheme(showcaseRaw());
  const assets = showcaseAssets();

  it("13 张图随包走一圈：清单全等、字节不坏、再转一圈仍幂等", () => {
    const back = unpackThemePack(packThemePack(theme, assets));
    expect(back.theme).toEqual(theme);
    expect(back.assets.size).toBe(13);
    expect([...back.assets.keys()].sort()).toEqual([...assets.keys()].sort());
    for (const [name, data] of assets) expect(back.assets.get(name)).toEqual(data);

    // 再封再解仍一致（往返幂等）
    const again = unpackThemePack(packThemePack(back.theme, back.assets));
    expect(again.theme).toEqual(back.theme);
    expect([...again.assets.keys()].sort()).toEqual([...assets.keys()].sort());
  });

  it("功能块背景与按钮花纹的图也在包里（这两处以前导出会漏图）", () => {
    const back = unpackThemePack(packThemePack(theme, assets));
    expect(back.assets.has("panel.png")).toBe(true);
    expect(back.assets.has("pattern.png")).toBe(true);
    // 弹页复用同一张图只进一份
    expect(back.assets.has("popup-hello.png")).toBe(true);
    expect(back.assets.size).toBe(13);
  });

  it("字段全铺不走样：弹页触发/开关/延时、背景参数、外链都原样", () => {
    const { theme: back } = unpackThemePack(packThemePack(theme, assets));
    expect(back.locked).toBe(true);
    expect(back.base).toBe("dark");
    expect(back.popups.map((p) => p.trigger)).toEqual([
      "load",
      "first",
      "daily",
      "load",
      "delay",
    ]);
    expect(back.popups[3].enabled).toBe(false);
    expect(back.popups[4].delaySeconds).toBe(30);
    expect(back.popups[4].image).toBe("");
    expect(back.backgrounds.global).toEqual({
      src: "asset:wall-global.png",
      dim: 0.35,
      blur: 8,
      position: "50% 30%",
      size: "cover",
    });
    // 外链图进不了包，但引用原样保留
    expect(back.backgrounds.notes.src).toBe("https://cdn.example.com/notes.png");
    expect(back.iconOverrides.save).toBe("https://cdn.example.com/save.png");
    expect(back.panelBg).toBe('url("/api/theme-asset/panel.png")');
    expect(back.buttonPattern).toBe("asset:pattern.png");
    expect(back.motion).toBe("gentle");
    expect(back.messageStyle).toBe("card");
  });
});

describe("图片引用三种形态", () => {
  it("asset: 进包、https 不进包、空串不铺，往返原样", () => {
    const theme = normalizeTheme({
      backgrounds: {
        global: { src: "asset:in-pack.png" },
        chat: { src: "https://cdn.example.com/remote.png" },
        notes: { src: "" },
      },
      // 同一张图多处引用只进一份
      agentAvatar: "asset:in-pack.png",
    });
    const back = unpackThemePack(
      packThemePack(theme, new Map([["in-pack.png", png("in-pack.png")]])),
    );
    expect(back.theme).toEqual(theme);
    expect([...back.assets.keys()]).toEqual(["in-pack.png"]);
  });
});

describe("导出缺本体矩阵：引用了没字节的图导不出", () => {
  const rows: Array<{
    label: string;
    raw: Record<string, unknown>;
    name: string;
  }> = [
    {
      label: "区块背景",
      raw: { backgrounds: { global: { src: "asset:gone-bg.png" } } },
      name: "gone-bg.png",
    },
    {
      label: "头像",
      raw: { agentAvatar: "asset:gone-face.png" },
      name: "gone-face.png",
    },
    {
      label: "图标覆盖",
      raw: { iconOverrides: { home: "asset:gone-icon.png" } },
      name: "gone-icon.png",
    },
    {
      label: "弹页配图",
      raw: { popups: [{ image: "asset:gone-pop.png" }] },
      name: "gone-pop.png",
    },
    {
      label: "按钮花纹",
      raw: { buttonPattern: "asset:gone-pattern.png" },
      name: "gone-pattern.png",
    },
    {
      label: "功能块背景（url() 形态）",
      raw: { panelBg: 'url("/api/theme-asset/gone-panel.png")' },
      name: "gone-panel.png",
    },
  ];

  it.each(rows)("$label 缺 $name 的字节：导出当场抛", ({ raw, name }) => {
    const theme = normalizeTheme(raw);
    expect(() => packThemePack(theme, new Map())).toThrow(
      `素材 ${name} 没有本体`,
    );
  });
});

describe("导入悬空拒收矩阵：装一半破图不如不装", () => {
  const rows: Array<{
    label: string;
    raw: Record<string, unknown>;
    name: string;
  }> = [
    ["global", "g1.png"],
    ["chat", "g2.png"],
    ["notes", "g3.png"],
    ["settings", "g4.png"],
    ["gate", "g5.png"],
    ["login", "g6.png"],
  ].map(([scope, name]) => ({
    label: `${scope} 背景`,
    raw: { backgrounds: { [scope]: { src: `asset:${name}` } } },
    name,
  }));
  rows.push(
    { label: "头像", raw: { agentAvatar: "asset:g7.png" }, name: "g7.png" },
    {
      label: "图标覆盖",
      raw: { iconOverrides: { home: "asset:g8.png" } },
      name: "g8.png",
    },
    {
      label: "弹页配图",
      raw: { popups: [{ image: "asset:g9.png" }] },
      name: "g9.png",
    },
    {
      label: "按钮花纹",
      raw: { buttonPattern: "asset:g10.png" },
      name: "g10.png",
    },
    {
      label: "功能块背景 url()",
      raw: { panelBg: 'url("/api/theme-asset/g11.png")' },
      name: "g11.png",
    },
  );

  it.each(rows)("$label 引用 $name 而包里没有：当场拒收", ({ raw, name }) => {
    const pack = makePack(goodManifest(raw));
    expect(() => unpackThemePack(pack)).toThrow(
      `清单引用了包里没有的素材：${name}`,
    );
  });

  it("带齐字节就装上：悬空校验只拦『引用了但没有』", () => {
    const pack = makePack(goodManifest({ agentAvatar: "asset:face.png" }), {
      "face.png": png("face.png"),
    });
    const back = unpackThemePack(pack);
    expect(back.theme.agentAvatar).toBe("asset:face.png");
    expect(back.assets.get("face.png")).toEqual(png("face.png"));
  });
});

describe("清单脏值在包边界收口", () => {
  it("非法基调/名字/头像/背景参数/动画/消息栏/弹页全收成安全值", () => {
    const pack = makePack(
      goodManifest({
        base: "neon",
        agentName: "  小艾  ",
        agentAvatar: "javascript:alert(1)",
        backgrounds: {
          global: { dim: 9, blur: 99 },
          // 未知落点不落（也不会凭空冒出悬空引用）
          hack: { src: "asset:x.png" },
        },
        motion: "hyper",
        messageStyle: "flat",
        popups: [
          { id: "a", trigger: "nope", delaySeconds: 999999 },
          { id: "a" },
          { title: "没 id" },
        ],
      }),
    );
    const { theme } = unpackThemePack(pack);
    expect(theme.base).toBe("paper");
    expect(theme.agentName).toBe("小艾");
    expect(theme.agentAvatar).toBe("");
    expect(theme.backgrounds.global.dim).toBe(1);
    expect(theme.backgrounds.global.blur).toBe(40);
    expect(Object.keys(theme.backgrounds).sort()).toEqual([
      "chat",
      "gate",
      "global",
      "login",
      "notes",
      "settings",
    ]);
    expect(theme.motion).toBe("default");
    expect(theme.messageStyle).toBe("bubble");
    // 重复 id 收一条；没 id 的按序补 popup-3（第 3 条）
    expect(theme.popups.map((p) => p.id)).toEqual(["a", "popup-3"]);
    expect(theme.popups[0].trigger).toBe("load");
    expect(theme.popups[0].delaySeconds).toBe(3600);
    expect(theme.popups[1].trigger).toBe("load");
  });
});
