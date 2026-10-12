/**
 * 主题前端侧（web/src/lib/theme.ts）测试。
 *
 * 测试环境是 node、没有 DOM，所以只测纯函数（applyThemeToDocument 这种碰
 * document 的不在单测范围）：
 * - resolveAsset：asset: 引用翻成免鉴权地址，路径穿越/脏值一律当没有；
 * - backgroundFor / backgroundLayerStyles：区块背景兜底与图层样式拼装；
 * - agentDisplay / iconOverride：展示值回落出厂、图标覆盖命中/未命中；
 * - popupDue / popupShown / popupDelaySeconds / dateKey：弹页触发语义；
 * - buildThemeCss：主题样式表拼装，customCss 压在最后（后者压前者）。
 *
 * 运行: npx vitest run web/src/lib/theme.test.ts
 */

import { describe, expect, it } from "vitest";
import {
  agentDisplay,
  backgroundFor,
  backgroundLayerStyles,
  buildThemeCss,
  dateKey,
  defaultTheme,
  emptyBackground,
  iconOverride,
  popupDelaySeconds,
  popupDue,
  popupShown,
  resolveAsset,
  tintPalette,
  type ThemeConfig,
  type ThemePopup,
} from "./theme";

function makeTheme(over: Partial<ThemeConfig> = {}): ThemeConfig {
  return { ...defaultTheme(), ...over };
}

function makePopup(over: Partial<ThemePopup> = {}): ThemePopup {
  return {
    id: "p",
    enabled: true,
    title: "标题",
    body: "正文",
    image: "",
    trigger: "load",
    delaySeconds: 0,
    actions: [],
    ...over,
  };
}

describe("resolveAsset（素材引用解析）", () => {
  it("asset: 引用翻成免鉴权素材地址", () => {
    expect(resolveAsset("asset:bg.png")).toBe("/api/theme-asset/bg.png");
    // 文件名里有怪字符就编码，URL 才不会断
    expect(resolveAsset("asset:图 案.png")).toBe(
      `/api/theme-asset/${encodeURIComponent("图 案.png")}`,
    );
  });

  it("路径穿越、空文件名一律当没有", () => {
    for (const bad of [
      "asset:../x.png",
      "asset:a/b.png",
      "asset:a\\b.png",
      "asset:..",
      "asset:",
    ]) {
      expect(resolveAsset(bad), bad).toBe("");
    }
  });

  it("http(s) 外链原样返回", () => {
    expect(resolveAsset("https://cdn.example.com/a.png")).toBe(
      "https://cdn.example.com/a.png",
    );
    expect(resolveAsset("http://cdn.example.com/a.png")).toBe(
      "http://cdn.example.com/a.png",
    );
  });

  it("空值、脏值（怪协议/裸文件名）都是空串", () => {
    for (const bad of ["", "   ", "bg.png", "javascript:alert(1)", "ftp://x/y.png"]) {
      expect(resolveAsset(bad), bad).toBe("");
    }
  });
});

describe("backgroundFor / backgroundLayerStyles（区块背景）", () => {
  const theme = makeTheme({
    backgrounds: {
      ...defaultTheme().backgrounds,
      global: { src: "asset:global.png", dim: 0.3, blur: 4, position: "top", size: "contain" },
      chat: { src: "asset:chat.png", dim: 0.1, blur: 0, position: "center", size: "cover" },
    },
  });

  it("自己的背景优先，没铺就兜到全局桌面", () => {
    expect(backgroundFor(theme, "chat").src).toBe("asset:chat.png");
    expect(backgroundFor(theme, "notes").src).toBe("asset:global.png");
  });

  it("全局也没有就空背景（不铺图）", () => {
    const bare = makeTheme({ backgrounds: {} as ThemeConfig["backgrounds"] });
    expect(backgroundFor(bare, "gate")).toEqual(emptyBackground());
  });

  it("有图时图层样式对：铺图 + 模糊 + 压暗层", () => {
    const { image, dim } = backgroundLayerStyles(theme, "chat");
    expect(image.backgroundImage).toBe("url(/api/theme-asset/chat.png)");
    expect(image.backgroundPosition).toBe("center");
    expect(image.backgroundSize).toBe("cover");
    expect(dim.background).toBe("rgba(14, 16, 20, 0.1)");

    // 兜底到全局时用全局的模糊/压暗参数
    const fallback = backgroundLayerStyles(theme, "notes");
    expect(fallback.image.backgroundImage).toBe("url(/api/theme-asset/global.png)");
    expect(fallback.image.filter).toBe("blur(4px)");
    expect(fallback.image.transform).toBe("scale(1.08)");
    expect(fallback.dim.background).toBe("rgba(14, 16, 20, 0.3)");
  });

  it("blur=0 不加 filter/transform（别白白糊一层）", () => {
    const { image } = backgroundLayerStyles(theme, "chat");
    expect(image.filter).toBe("");
    expect(image.transform).toBe("");
  });

  it("没图时 backgroundImage 是空的，但压暗层照常给", () => {
    const { image, dim } = backgroundLayerStyles(defaultTheme(), "gate");
    expect(image.backgroundImage).toBe("");
    expect(dim.background).toBe("rgba(14, 16, 20, 0)");
  });
});

describe("agentDisplay / iconOverride（展示值）", () => {
  it("主题没给名字回落 ericher，给了用主题的", () => {
    expect(agentDisplay(defaultTheme()).name).toBe("ericher");
    expect(agentDisplay(makeTheme({ agentName: "小艾" })).name).toBe("小艾");
    // 空白名字也算没给
    expect(agentDisplay(makeTheme({ agentName: "   " })).name).toBe("ericher");
  });

  it("头像过 resolveAsset 解析", () => {
    expect(agentDisplay(makeTheme({ agentAvatar: "asset:face.png" })).avatar).toBe(
      "/api/theme-asset/face.png",
    );
    expect(agentDisplay(defaultTheme()).avatar).toBe("");
  });

  it("图标覆盖：命中返回地址，未命中空串走原字形", () => {
    const theme = makeTheme({ iconOverrides: { home: "asset:home.png" } });
    expect(iconOverride(theme, "home")).toBe("/api/theme-asset/home.png");
    expect(iconOverride(theme, "save")).toBe("");
    expect(iconOverride(defaultTheme(), "home")).toBe("");
  });
});

describe("弹页触发判定", () => {
  const today = "2026-10-11";

  it("load：不管弹没弹过都弹（会话去重由调用方挡）", () => {
    expect(popupDue(makePopup(), undefined, today)).toBe(true);
    expect(popupDue(makePopup(), { count: 9, lastDate: today }, today)).toBe(true);
  });

  it("first：只在从没弹过时弹", () => {
    const p = makePopup({ trigger: "first" });
    expect(popupDue(p, undefined, today)).toBe(true);
    expect(popupDue(p, { count: 0, lastDate: "" }, today)).toBe(true);
    expect(popupDue(p, { count: 1, lastDate: today }, today)).toBe(false);
  });

  it("daily：今天没弹过才弹", () => {
    const p = makePopup({ trigger: "daily" });
    expect(popupDue(p, undefined, today)).toBe(true);
    expect(popupDue(p, { count: 3, lastDate: "2026-10-10" }, today)).toBe(true);
    expect(popupDue(p, { count: 3, lastDate: today }, today)).toBe(false);
  });

  it("delay：和 load 一样每次都弹，具体等多久另算", () => {
    const p = makePopup({ trigger: "delay", delaySeconds: 30 });
    expect(popupDue(p, undefined, today)).toBe(true);
    expect(popupDue(p, { count: 2, lastDate: today }, today)).toBe(true);
  });

  it("enabled=false 一律不弹", () => {
    for (const trigger of ["load", "first", "daily", "delay"] as const) {
      expect(popupDue(makePopup({ trigger, enabled: false }), undefined, today)).toBe(
        false,
      );
    }
  });

  it("popupShown 计数累加并记下最近一次的日期", () => {
    expect(popupShown(undefined, today)).toEqual({ count: 1, lastDate: today });
    expect(popupShown({ count: 3, lastDate: "2026-10-10" }, today)).toEqual({
      count: 4,
      lastDate: today,
    });
  });

  it("popupDelaySeconds 收口：歪的当 0，太长封顶 3600", () => {
    expect(popupDelaySeconds(makePopup({ delaySeconds: 30 }))).toBe(30);
    expect(popupDelaySeconds(makePopup({ delaySeconds: 0 }))).toBe(0);
    expect(popupDelaySeconds(makePopup({ delaySeconds: -5 }))).toBe(0);
    expect(popupDelaySeconds(makePopup({ delaySeconds: Number.NaN }))).toBe(0);
    expect(popupDelaySeconds(makePopup({ delaySeconds: 99999 }))).toBe(3600);
  });

  it("dateKey：本地日期折成 YYYY-MM-DD", () => {
    expect(dateKey(new Date(2026, 0, 5))).toBe("2026-01-05");
    expect(dateKey(new Date(2026, 11, 31))).toBe("2026-12-31");
  });
});

describe("buildThemeCss（主题样式表拼装）", () => {
  it("panelBg 出变量 + 通用类", () => {
    const css = buildThemeCss(makeTheme({ panelBg: "linear-gradient(#fff, #eee)" }));
    expect(css).toContain(":root { --theme-panel-bg: linear-gradient(#fff, #eee); }");
    expect(css).toContain(".theme-panel { background: var(--theme-panel-bg);");
    // 没配就不出这条规则
    expect(buildThemeCss(defaultTheme())).not.toContain("--theme-panel-bg");
  });

  it("buttonPattern 解析成 background-image，不动底层背景色", () => {
    const css = buildThemeCss(makeTheme({ buttonPattern: "asset:pat.png" }));
    expect(css).toContain("background-image: url(/api/theme-asset/pat.png)");
    expect(css).toContain(".btn, .icon-btn, .chip");
  });

  it("消息栏三种风格、动画两档的规则都在", () => {
    const css = buildThemeCss(defaultTheme());
    expect(css).toContain('[data-message-style="bubble"]');
    expect(css).toContain('[data-message-style="card"]');
    expect(css).toContain('[data-message-style="minimal"]');
    expect(css).toContain('[data-theme-motion="gentle"]');
    expect(css).toContain('[data-theme-motion="off"]');
  });

  it("壁纸上的文段块：正文垫纸底，名签哪个档都垫，minimal 正文让路", () => {
    const card = buildThemeCss(makeTheme({ messageStyle: "card" }));
    expect(card).toContain(
      'html[data-wallpaper~="chat"] .msg.assistant .theme-msg',
    );
    expect(card).toContain("color-mix");
    const mini = buildThemeCss(makeTheme({ messageStyle: "minimal" }));
    expect(mini).not.toContain(".msg.assistant .theme-msg");
    // 名签不是正文块：minimal 下也得让人看清他是谁
    expect(mini).toContain('html[data-wallpaper~="chat"] .msg-label');
  });

  it("customCss 拼在最后：后者压前者", () => {
    const custom = ".x { color: red; }";
    const css = buildThemeCss(makeTheme({ customCss: custom }));
    expect(css.endsWith(custom)).toBe(true);
    expect(css.indexOf(custom)).toBeGreaterThan(css.indexOf('[data-message-style="bubble"]'));
  });

  it("基调调色器：锁定时才按自定义色染灰阶", () => {
    const tint = { h: 214, s: 50, l: 24 };
    const css = buildThemeCss(makeTheme({ tint, locked: true }));
    expect(css).toContain("--yuzhe-black: hsl(214 50.0% 24.0%)");
    // 未锁定 = 用户说了算，不染
    expect(buildThemeCss(makeTheme({ tint, locked: false }))).not.toContain("--yuzhe-black:");
    // 没自定义色走 paper/dawn/dark 三档预设
    expect(buildThemeCss(makeTheme({ tint: null, locked: true }))).not.toContain("--yuzhe-black:");
  });

  it("夜墨叠调色器 = 暗底染色，签名块翻白", () => {
    const css = buildThemeCss(
      makeTheme({ tint: { h: 214, s: 50, l: 24 }, base: "dark", locked: true }),
    );
    expect(css).toContain("color-scheme: dark");
    // 亮结构里签名块是选的色，暗结构里翻成亮章
    expect(css).toContain("--yuzhe-black: hsl(214 22.5% 90.0%)");
  });

  it("tintPalette：签名块就是选的那个色，功能色不动", () => {
    const vars = tintPalette({ h: 214, s: 50, l: 24 }, false);
    expect(vars["--yuzhe-black"]).toBe("hsl(214 50.0% 24.0%)");
    expect(vars["--yuzhe-surface"]).toBe("#ffffff");
    expect(vars["--yuzhe-ok"]).toBeUndefined();
    expect(vars["--yuzhe-danger"]).toBeUndefined();
  });

  it("啥都没配就只有出厂规则", () => {
    const css = buildThemeCss(defaultTheme());
    expect(css).not.toContain("--theme-panel-bg");
    expect(css).not.toContain("background-image: url(");
  });
});

describe("全功能展示主题（图片加载一览）", () => {
  // 全字段铺满的展示主题：每个图片位都指向素材，notes 留空看全局兜底
  const theme = makeTheme({
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
      notes: emptyBackground(),
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
    popups: [makePopup({ id: "hello", image: "asset:popup-hello.png" })],
  });

  it("每个图片位都解析成免鉴权素材地址，notes 兜底全局", () => {
    for (const scope of ["global", "chat", "settings", "gate", "login"] as const) {
      const { image } = backgroundLayerStyles(theme, scope);
      expect(image.backgroundImage, scope).toBe(
        `url(/api/theme-asset/wall-${scope}.png)`,
      );
    }
    // notes 自己没铺 → 兜底到全局桌面（模糊/压暗参数一起跟过去）
    expect(backgroundFor(theme, "notes").src).toBe("asset:wall-global.png");
    const notes = backgroundLayerStyles(theme, "notes");
    expect(notes.image.backgroundImage).toBe("url(/api/theme-asset/wall-global.png)");
    expect(notes.image.filter).toBe("blur(8px)");

    expect(agentDisplay(theme).avatar).toBe("/api/theme-asset/avatar.png");
    expect(iconOverride(theme, "home")).toBe("/api/theme-asset/icon-home.png");
    expect(iconOverride(theme, "chat")).toBe("/api/theme-asset/icon-chat.png");
    expect(iconOverride(theme, "save")).toBe("https://cdn.example.com/save.png");
    expect(resolveAsset(theme.buttonPattern)).toBe("/api/theme-asset/pattern.png");
    expect(resolveAsset(theme.popups[0].image)).toBe(
      "/api/theme-asset/popup-hello.png",
    );
  });

  it("buildThemeCss 把功能块背景整段注入、按钮花纹翻成平铺背景图", () => {
    const css = buildThemeCss(theme);
    expect(css).toContain(
      ':root { --theme-panel-bg: url("/api/theme-asset/panel.png"); }',
    );
    expect(css).toContain(
      ".btn, .icon-btn, .chip { background-image: url(/api/theme-asset/pattern.png); background-size: 140px auto; background-repeat: repeat; }",
    );
  });
});
