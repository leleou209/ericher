// 主题（管理员装点全局门面）的前端侧：类型、引用解析、注入引擎、弹页触发判定。
//
// 与后端 src/agent/themeConfig.ts 保持同形 —— 主题从 /api/theme 免鉴权下发，
// 谁走到门口（Gate）都先看到门面，所以前端不能要求登录才拿得到它。
//
// 素材引用统一是 `asset:<文件名>`（R2 公开区）或 http(s) 外链；
// resolveAsset 负责把 asset: 翻成免鉴权的 /api/theme-asset/<文件名>。

import { createContext, useContext } from "react";

export type ThemeMode = "paper" | "dawn" | "dark";
export type ThemeMotion = "default" | "gentle" | "off";
export type ThemeMessageStyle = "bubble" | "card" | "minimal";

/** 基调色（三级调色器）：色相 0~360、浓度 0~100、深浅 0~100 */
export interface ThemeTint {
  h: number;
  s: number;
  l: number;
}
export type BackgroundScope =
  | "global"
  | "chat"
  | "notes"
  | "settings"
  | "gate"
  | "login";
export type PopupTrigger = "load" | "first" | "daily" | "delay";

export const BACKGROUND_SCOPES: BackgroundScope[] = [
  "global",
  "chat",
  "notes",
  "settings",
  "gate",
  "login",
];

export const SCOPE_LABELS: Record<BackgroundScope, string> = {
  global: "全局桌面",
  chat: "会话",
  notes: "笔记本",
  settings: "设置",
  gate: "门口",
  login: "登录",
};

export interface ThemeBackground {
  /** asset:<文件名> / https 外链 / 空串=不铺 */
  src: string;
  /** 压暗层的不透明度 0~1 */
  dim: number;
  /** 模糊像素 0~40 */
  blur: number;
  /** background-position */
  position: string;
  /** background-size */
  size: string;
}

/** 弹页上的动作按钮：一条口信配一个去处 */
export interface ThemePopupAction {
  /** 按钮文字 */
  label: string;
  /** 站内路径 `/x` 或 http(s) 外链 */
  to: string;
}

export interface ThemePopup {
  id: string;
  enabled: boolean;
  title: string;
  body: string;
  /** 弹页插图：asset:/https */
  image: string;
  trigger: PopupTrigger;
  /** trigger=delay 时的延迟秒数 */
  delaySeconds: number;
  /** 动作按钮（最多 2 个） */
  actions: ThemePopupAction[];
}

export interface ThemeConfig {
  /**
   * 来客能不能改自己的纸色。true = 关门：来客的纸色/黎明/暗色选择被 base 接管；
   * false = 放开来客本地换纸色（只影响他自己）。管理员始终可以自己换。
   * 存储字段仍叫 locked（历史上是「锁定全局美术」，语义已收窄成这一件事）。
   */
  locked: boolean;
  base: ThemeMode;
  /** 自定义基调色；null = 用 paper/dawn/dark 三档预设 */
  tint: ThemeTint | null;
  agentName: string;
  /** asset:/https */
  agentAvatar: string;
  backgrounds: Record<BackgroundScope, ThemeBackground>;
  /** 功能块背景：一段 CSS background 值（颜色或 url(...)） */
  panelBg: string;
  /** 按钮花纹：asset:/https 图片，平铺在按钮底色上 */
  buttonPattern: string;
  /** 图标名 → asset:/https，覆盖 ICONS 里的字形 */
  iconOverrides: Record<string, string>;
  motion: ThemeMotion;
  messageStyle: ThemeMessageStyle;
  customCss: string;
  popups: ThemePopup[];
}

export interface ThemeConfigPatch {
  locked?: boolean;
  base?: ThemeMode;
  /** null = 清掉自定义色回预设 */
  tint?: ThemeTint | null;
  agentName?: string | null;
  agentAvatar?: string | null;
  backgrounds?: Partial<Record<BackgroundScope, Partial<ThemeBackground>>>;
  panelBg?: string | null;
  buttonPattern?: string | null;
  iconOverrides?: Record<string, string | null>;
  motion?: ThemeMotion;
  messageStyle?: ThemeMessageStyle;
  customCss?: string | null;
  popups?: ThemePopup[];
}

/**
 * 自定义主题存档：一整份美术配置（含素材的整包）在云端的一个档。
 * 服务端存的是一份自包含的主题包 zip，所以哪怕素材被换被删，这份档翻出来照样装得上。
 */
export interface ThemeSet {
  id: string;
  name: string;
  /** 归档 zip 在云盘的 key（f/public/betpag/…） */
  packKey: string;
  /** 存下来的时间（毫秒） */
  created: number;
  /** 包体字节数，给人看个大小 */
  bytes: number;
}

export const emptyBackground = (): ThemeBackground => ({
  src: "",
  dim: 0,
  blur: 0,
  position: "center",
  size: "cover",
});

export const defaultTheme = (): ThemeConfig => ({
  locked: false,
  base: "paper",
  tint: null,
  agentName: "",
  agentAvatar: "",
  backgrounds: {
    global: emptyBackground(),
    chat: emptyBackground(),
    notes: emptyBackground(),
    settings: emptyBackground(),
    gate: emptyBackground(),
    login: emptyBackground(),
  },
  panelBg: "",
  buttonPattern: "",
  iconOverrides: {},
  motion: "default",
  messageStyle: "bubble",
  customCss: "",
  popups: [],
});

/** `asset:x` → 免鉴权素材地址；http(s) 原样；其余（空串/脏值）当没有 */
export function resolveAsset(ref: string): string {
  const v = (ref || "").trim();
  if (!v) return "";
  if (v.startsWith("asset:")) {
    const name = v.slice("asset:".length);
    if (!name || name.includes("/") || name.includes("\\") || name.includes(".."))
      return "";
    return `/api/theme-asset/${encodeURIComponent(name)}`;
  }
  if (/^https?:\/\//i.test(v)) return v;
  return "";
}

/** 某处的背景：自己的没铺就用全局桌面的兜底 */
export function backgroundFor(
  theme: ThemeConfig,
  scope: BackgroundScope,
): ThemeBackground {
  const own = theme.backgrounds?.[scope];
  if (own && own.src) return own;
  return theme.backgrounds?.global ?? emptyBackground();
}

/**
 * 背景层的两份样式：图层（铺图 + 模糊）和压暗层。
 * 落点只需塞进一个「撑满容器的绝对定位层」，不用动自己布局。
 */
export function backgroundLayerStyles(
  theme: ThemeConfig,
  scope: BackgroundScope,
): { image: Record<string, string>; dim: Record<string, string> } {
  const bg = backgroundFor(theme, scope);
  const url = resolveAsset(bg.src);
  return {
    image: {
      position: "absolute",
      inset: "0",
      backgroundImage: url ? `url(${url})` : "",
      backgroundPosition: bg.position || "center",
      backgroundSize: bg.size || "cover",
      backgroundRepeat: "no-repeat",
      filter: bg.blur > 0 ? `blur(${bg.blur}px)` : "",
      transform: bg.blur > 0 ? "scale(1.08)" : "",
      pointerEvents: "none",
    },
    dim: {
      position: "absolute",
      inset: "0",
      background: `rgba(14, 16, 20, ${bg.dim})`,
      pointerEvents: "none",
    },
  };
}

/** 头像 + 名字的展示值：主题没给就用出厂默认（ericher） */
export function agentDisplay(
  theme: ThemeConfig,
  fallbackName = "ericher",
): { name: string; avatar: string } {
  return {
    name: (theme.agentName || "").trim() || fallbackName,
    avatar: resolveAsset(theme.agentAvatar),
  };
}

/** 图标覆盖：返回可当 <img src> 的地址，没有覆盖就空串（调用方走原字形） */
export function iconOverride(theme: ThemeConfig, name: string): string {
  return resolveAsset(theme.iconOverrides?.[name] ?? "");
}

// ── 弹页触发判定（纯函数，给单测用）────────────────────────────────
//
// 触发语义：
//   load  —— 每次进站弹一次（本次会话内不重复，会话去重由调用方记）
//   first —— 只在「从没弹过」时弹一次
//   daily —— 每天第一次进站弹一次
//   delay —— 进站后等 delaySeconds 秒弹一次（会话去重同 load）

export interface PopupRecord {
  /** 累计弹过几次 */
  count: number;
  /** 最近一次弹出的日期 YYYY-MM-DD */
  lastDate: string;
}

export function dateKey(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 这条弹页此刻该不该弹（不看会话去重，那由调用方用内存集合挡） */
export function popupDue(
  popup: ThemePopup,
  record: PopupRecord | undefined,
  today: string,
): boolean {
  if (!popup.enabled) return false;
  if (popup.trigger === "first") return !record || record.count === 0;
  if (popup.trigger === "daily") return !record || record.lastDate !== today;
  return true; // load / delay
}

/** 弹过之后记一笔（调用方存 localStorage） */
export function popupShown(
  record: PopupRecord | undefined,
  today: string,
): PopupRecord {
  return { count: (record?.count ?? 0) + 1, lastDate: today };
}

/** 弹页延迟秒数收口：不给或给歪了就当 0 */
export function popupDelaySeconds(popup: ThemePopup): number {
  const n = Number(popup.delaySeconds);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 3600) : 0;
}

// ── 注入引擎 ─────────────────────────────────────────────────────

export const THEME_STYLE_ID = "ericher-theme-style";

const clampN = (n: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, n));

/** HSL 拼成 CSS 颜色（modern 语法）。只用于生成变量，不进存储 */
function hslCss(h: number, s: number, l: number): string {
  return `hsl(${Math.round(clampN(h, 0, 360))} ${clampN(s, 0, 100).toFixed(1)}% ${clampN(l, 0, 100).toFixed(1)}%)`;
}

function hslaCss(h: number, s: number, l: number, a: number): string {
  return `hsla(${Math.round(clampN(h, 0, 360))} ${clampN(s, 0, 100).toFixed(1)}% ${clampN(l, 0, 100).toFixed(1)}% / ${a})`;
}

/**
 * 三级调色器的染色配方：基调说到底就是一个颜色 —— 和晨曦微蓝同一句话，
 * 「同一张纸泡进一个颜色里」，只给灰阶染色相，版式/字/圆角全不动。
 * 签名块（--yuzhe-black）就是用户调出来的那个色。
 * dark=true 时按夜墨的结构（暗底亮墨、签名块翻白）。
 */
export function tintPalette(tint: ThemeTint, dark: boolean): Record<string, string> {
  const h = clampN(Number(tint.h) || 0, 0, 360);
  const s = clampN(Number(tint.s) || 0, 0, 100);
  const l = clampN(Number(tint.l) || 0, 0, 100);
  if (dark) {
    return {
      "--yuzhe-bg": hslCss(h, s * 0.15, 10),
      "--yuzhe-bg-soft": hslCss(h, s * 0.18, 13),
      "--yuzhe-bg-hover": hslCss(h, s * 0.22, 18),
      "--yuzhe-surface": hslCss(h, s * 0.2, 15),
      "--yuzhe-ink": hslCss(h, s * 0.18, 84),
      "--yuzhe-ink-strong": hslCss(h, s * 0.22, 93),
      "--yuzhe-ink-dim": hslCss(h, s * 0.16, 63),
      "--yuzhe-ink-faint": hslCss(h, s * 0.14, 44),
      "--yuzhe-line": hslCss(h, s * 0.2, 22),
      "--yuzhe-line-soft": hslCss(h, s * 0.18, 17),
      "--yuzhe-line-strong": hslCss(h, s * 0.35, 88),
      // 签名块翻白：选的色越深，翻出来的白章越亮
      "--yuzhe-black": hslCss(h, s * 0.45, 96 - l * 0.25),
      "--yuzhe-on-black": hslCss(h, s * 0.25, 10),
      "--yuzhe-shadow": `0 6px 12px ${hslaCss(h, s * 0.3, 0, 0.35)}`,
      "--yuzhe-shadow-pop": `0 12px 32px ${hslaCss(h, s * 0.3, 0, 0.5)}`,
    };
  }
  return {
    "--yuzhe-bg": hslCss(h, s * 0.12, 99),
    "--yuzhe-bg-soft": hslCss(h, s * 0.3, 96),
    "--yuzhe-bg-hover": hslCss(h, s * 0.4, 93),
    "--yuzhe-surface": "#ffffff",
    "--yuzhe-ink": hslCss(h, s * 0.45, 17),
    "--yuzhe-ink-strong": hslCss(h, s * 0.5, 12),
    "--yuzhe-ink-dim": hslCss(h, s * 0.35, 43),
    "--yuzhe-ink-faint": hslCss(h, s * 0.28, 63),
    "--yuzhe-line": hslCss(h, s * 0.35, 87),
    "--yuzhe-line-soft": hslCss(h, s * 0.3, 92),
    "--yuzhe-line-strong": hslCss(h, s * 0.8, l),
    "--yuzhe-black": hslCss(h, s, l),
    "--yuzhe-on-black": hslCss(h, s * 0.25, 96),
    "--yuzhe-shadow": `0 6px 12px ${hslaCss(h, s * 0.3, 20, 0.07)}`,
    "--yuzhe-shadow-pop": `0 12px 32px ${hslaCss(h, s * 0.3, 18, 0.15)}`,
  };
}

/** 染色配方拼成一条 `:root` 规则（垫在主题样式表里，后者压前者） */
export function tintCssVars(tint: ThemeTint, dark: boolean): string {
  const vars = tintPalette(tint, dark);
  const decls = Object.entries(vars)
    .map(([k, v]) => `${k}: ${v};`)
    .join(" ");
  return `:root { color-scheme: ${dark ? "dark" : "light"}; ${decls} }`;
}

/** 纯函数：拼出主题样式表内容。自定义 CSS 原样放在最后（人话：后者压前者） */
export function buildThemeCss(theme: ThemeConfig): string {
  const rules: string[] = [];

  // 基调调色器：有自定义色调且整体风格锁定时，按这一个颜色染整套灰阶。
  // 跟着 locked 走，和 base 接管 data-theme 同一条语义线（未锁定 = 用户说了算）。
  if (theme.tint && theme.locked) {
    rules.push(tintCssVars(theme.tint, theme.base === "dark"));
  }

  // 功能块背景：只挂变量 + 一个通用类，落点用 .theme-panel 拿
  if (theme.panelBg && theme.panelBg.trim()) {
    rules.push(`:root { --theme-panel-bg: ${theme.panelBg.trim()}; }`);
    rules.push(
      `.theme-panel { background: var(--theme-panel-bg); background-color: transparent; }`,
    );
  }

  // 按钮花纹：只写 background-image，不动底层背景色
  const pattern = resolveAsset(theme.buttonPattern);
  if (pattern) {
    rules.push(
      `.btn, .icon-btn, .chip { background-image: url(${pattern}); background-size: 140px auto; background-repeat: repeat; }`,
    );
  }

  // 消息栏风格：由 data-message-style 开关，落点给消息泡加 .theme-msg
  rules.push(
    `[data-message-style="bubble"] .theme-msg { border-radius: 18px; }`,
    `[data-message-style="card"] .theme-msg { border-radius: 12px; border: 1px solid var(--yuzhe-line); box-shadow: 0 6px 20px rgba(17, 22, 26, 0.08); }`,
    `[data-message-style="minimal"] .theme-msg { background: transparent !important; border: none !important; border-radius: 0 !important; box-shadow: none !important; }`,
    `[data-message-style="minimal"] .theme-msg::before { display: none !important; }`,
  );

  // 壁纸上的文段块：素排的正文直接压在画上看不清，垫一层半透明纸底。
  // 不上 backdrop-filter —— 全局毛玻璃是换场卡顿的老根（styles.css 有注），
  // 半透明纸就是便宜的「毛玻璃感」。minimal 档用户点名不要块，正文让路；
  // 名签不是正文块，哪个档都得让人看清他是谁。
  rules.push(
    `html[data-wallpaper~="chat"] .msg-label { background: color-mix(in srgb, var(--yuzhe-surface) 85%, transparent); padding: 3px 10px 4px; border-radius: 999px; width: fit-content; }`,
  );
  if (theme.messageStyle !== "minimal") {
    rules.push(
      `html[data-wallpaper~="chat"] .msg.assistant .theme-msg { background: color-mix(in srgb, var(--yuzhe-surface) 88%, transparent); padding: 10px 14px; }`,
    );
  }

  // 动画档：gentle 拉长节奏，off 全停（body[data-motion="off"] 已有的停法照旧兜底）
  rules.push(
    `[data-theme-motion="gentle"] *, [data-theme-motion="gentle"] *::before, [data-theme-motion="gentle"] *::after { animation-duration: 1.8s !important; transition-duration: 0.55s !important; }`,
    `[data-theme-motion="off"] *, [data-theme-motion="off"] *::before, [data-theme-motion="off"] *::after { animation: none !important; transition: none !important; }`,
  );

  const css = rules.join("\n");
  const custom = theme.customCss || "";
  return custom ? `${css}\n${custom}` : css;
}

let currentTheme: ThemeConfig = defaultTheme();

/** 当前生效主题的快照（图标覆盖等零散查询用） */
export function themeSnapshot(): ThemeConfig {
  return currentTheme;
}

/**
 * 把主题落到文档上：注入样式表 + 写 <html> 属性。
 * 锁定（locked）时把 data-theme 接管成 base —— 普通用户的纸色选择就翻不动了。
 */
export function applyThemeToDocument(theme: ThemeConfig): void {
  currentTheme = theme;
  const root = document.documentElement;

  let style = document.getElementById(THEME_STYLE_ID) as HTMLStyleElement | null;
  if (!style) {
    style = document.createElement("style");
    style.id = THEME_STYLE_ID;
    document.head.appendChild(style);
  }
  style.textContent = buildThemeCss(theme);

  root.dataset.themeMotion = theme.motion;
  root.dataset.messageStyle = theme.messageStyle;
  root.dataset.themeLocked = theme.locked ? "on" : "off";
  // 哪些背景位铺上了壁纸（含回落到全局的）：铺了的视图把自己的纸底让出来，
  // 具体让位规则见 styles.css 的 [data-wallpaper~=…] 段
  root.dataset.wallpaper = BACKGROUND_SCOPES.filter(
    (s) => !!resolveAsset(backgroundFor(theme, s).src),
  ).join(" ");
  if (theme.motion === "off") {
    document.body.dataset.motion = "off";
  }
  if (theme.locked) {
    root.dataset.theme = theme.base;
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute("content", theme.base === "dark" ? "#17191c" : "#ffffff");
  }
}

// ── React 侧：主题状态的上下文 ───────────────────────────────────

export interface ThemeState {
  theme: ThemeConfig;
  /** 重新从服务器拉一次（管理员改完主题后刷新用） */
  reload: () => void;
}

export const ThemeContext = createContext<ThemeState>({
  theme: defaultTheme(),
  reload: () => {},
});

export function useTheme(): ThemeState {
  return useContext(ThemeContext);
}
