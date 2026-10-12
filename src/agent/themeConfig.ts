// theme_config：全局美术主题（皮肤）配置。
//
// 前端美术表现的总开关：背景（可以是动图）、ericher 的名字与头像、功能块背景、
// 按钮花纹、图标覆盖、动画效果、消息栏风格、触发式弹页 —— 全部落在这张表里。
// 语义与 draw_configs 同一套思路，但主题是一整份文档（弹页是嵌套列表，拆列存
// 没有意义），所以表只有一行，data 列存 JSON，出入都过 normalizeTheme 收口。
//
// 可见性语义（和别的配置不同）：主题**全局可见**，来客那间、未登录门口都读得到
// —— 所以读路径走 fetchTheme（跨 DO / 免鉴权路由），写路径只有管理员
// （路由层总闸 + isOwnerRoom 守卫）。locked=true 时整体风格锁定，普通用户
// 连纸色/黎明/暗色都换不了，全按主题走。
//
// 素材不进 JSON：图片/动图上传进 R2 公开区（f/public/theme/），主题里只存
// `asset:<文件名>` 引用；外链图存完整 https URL 也行。前端把 asset: 解析成
// 免鉴权的 /api/theme-asset/<文件名>。

import type { SqlTag } from "./state";

/** 基调：锁定后整体走哪套底色（对应前端 data-theme） */
export type ThemeMode = "paper" | "dawn" | "dark";

/**
 * 基调色（三级调色器）：基调说到底就是一个颜色 —— 色相 0~360、
 * 浓度 0~100、深浅 0~100。null = 不自定义，走 paper/dawn/dark 三档预设。
 */
export interface ThemeTint {
  h: number;
  s: number;
  l: number;
}

const THEME_MODES: ThemeMode[] = ["paper", "dawn", "dark"];

/** 动画效果档 */
export type ThemeMotion = "default" | "gentle" | "off";

const THEME_MOTIONS: ThemeMotion[] = ["default", "gentle", "off"];

/** 对话框消息栏风格 */
export type ThemeMessageStyle = "bubble" | "card" | "minimal";

const THEME_MESSAGE_STYLES: ThemeMessageStyle[] = ["bubble", "card", "minimal"];

/** 有独立背景位的界面区块 */
export type BackgroundScope =
  | "global"
  | "chat"
  | "notes"
  | "settings"
  | "gate"
  | "login";

const BACKGROUND_SCOPES: BackgroundScope[] = [
  "global",
  "chat",
  "notes",
  "settings",
  "gate",
  "login",
];

/** 一块背景：src 为空 = 出厂纯色（过 dim/blur 无意义） */
export interface ThemeBackground {
  /** `asset:<文件名>`（R2 公开区素材）或完整 https URL；空串 = 不铺图 */
  src: string;
  /** 蒙层暗度 0~1：压住图让文字看得清 */
  dim: number;
  /** 背景模糊 px 0~40 */
  blur: number;
  /** CSS background-position，如 "center" */
  position: string;
  /** CSS background-size，如 "cover" / "contain" */
  size: string;
}

/** 触发式弹页 */
export type PopupTrigger = "load" | "first" | "daily" | "delay";

const POPUP_TRIGGERS: PopupTrigger[] = ["load", "first", "daily", "delay"];

/**
 * 弹页上的动作按钮：一条口信配一个去处。
 * to 只认站内路径（以 `/` 开头）或 http(s) 外链，别的（javascript:、相对路径、
 * 协议相对 `//host`）一律当脏值丢掉 —— 这个地址会被拼进跳转，不能由着人乱填。
 */
export interface ThemePopupAction {
  /** 按钮文字，最多 20 字 */
  label: string;
  /** 站内路径 `/x` 或 http(s) 外链 */
  to: string;
}

export interface ThemePopup {
  id: string;
  enabled: boolean;
  title: string;
  /** 正文，纯文本 + 换行 */
  body: string;
  /** 配图：`asset:<文件名>` / https URL / 空串 */
  image: string;
  /** load=每次进入弹 / first=首次 / daily=每天一次 / delay=进入后延时 */
  trigger: PopupTrigger;
  /** trigger=delay 时的延时秒数 0~3600 */
  delaySeconds: number;
  /** 动作按钮（最多 2 个）：本期当作「引流口信」，公告正文将来落在矩阵静态页 */
  actions: ThemePopupAction[];
}

/** 一整份主题。所有字段都有出厂值，normalizeTheme 保证读出来的永远是全形状 */
export interface ThemeConfig {
  /**
   * 来客能不能改自己的纸色：true = 关门（来客纸色被 base 接管），
   * false = 放开来客本地换纸色（只影响他自己）。字段名沿用 locked。
   */
  locked: boolean;
  /** 关门时接管来客纸色的基调；不锁时只是默认基调 */
  base: ThemeMode;
  /** 自定义基调色；null = 用三档预设。非空时按它染整套灰阶（亮/暗结构看 base） */
  tint: ThemeTint | null;
  /** ericher 的称呼 */
  agentName: string;
  /** ericher 的头像：`asset:<文件名>` / https URL / 空串 = 出厂字标 */
  agentAvatar: string;
  backgrounds: Record<BackgroundScope, ThemeBackground>;
  /** 功能块（面板/卡片）背景：任意 CSS background 值（颜色、url() 等），空串 = 出厂 */
  panelBg: string;
  /** 按钮花纹：任意 CSS background 值，空串 = 出厂 */
  buttonPattern: string;
  /** 图标覆盖：图标名 -> 图片地址（asset: / https），前端有这名字就用图替线稿 */
  iconOverrides: Record<string, string>;
  motion: ThemeMotion;
  messageStyle: ThemeMessageStyle;
  /** 追加的自定义 CSS，直接注入页面，空串 = 无 */
  customCss: string;
  popups: ThemePopup[];
}

/** 字符串上限：背景/花纹这类 CSS 值给宽些，弹页正文再宽些 */
const MAX_CSS = 2000;
const MAX_TEXT = 200;
const MAX_POPUP_BODY = 5000;
const MAX_ICON_OVERRIDES = 100;
const MAX_POPUPS = 20;
/** 一条弹页最多挂两个动作按钮：多了排不下，也失去「一个口信」的克制 */
const MAX_POPUP_ACTIONS = 2;
/** 动作数组的扫描上限：封顶的是有效条数，遍历长度得另设闸 */
const MAX_ACTION_SCAN = 50;
/** 按钮文字上限 */
const MAX_ACTION_LABEL = 20;
/** 素材引用（外链 / asset:）的地址上限：和前端 resolveAsset 的容忍度同一口径 */
const MAX_URL = 400;
/** 自定义 CSS 单独给宽些：是一整段样式表，不是单个值 */
const MAX_CUSTOM_CSS = 10000;

function emptyBackground(): ThemeBackground {
  return { src: "", dim: 0, blur: 0, position: "center", size: "cover" };
}

export function defaultTheme(): ThemeConfig {
  return {
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
  };
}

function str(v: unknown, max: number): string {
  return String(v ?? "")
    .trim()
    .slice(0, max);
}

/**
 * 写路径的长度校验：超限当场抛人话错误，不走 str() 的静默截断。
 * 截一半的链接/样式是坏数据 —— 预览好好的东西保存完就变样，比拒绝保存更糊涂。
 * 读路径（normalizeTheme）管的是库里的存量脏数据，不能抛，继续回落截断。
 */
function assertLen(v: unknown, max: number, label: string): void {
  if (String(v ?? "").trim().length > max)
    throw new Error(`${label}超过上限（最多 ${max} 字）`);
}

function num(v: unknown, min: number, max: number, fallback: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** 基调色收口：不是对象 / 三个数不齐就当没有（读路径不许抛，脏值一律回落） */
function normalizeTint(raw: unknown): ThemeTint | null {
  const r = (raw && typeof raw === "object" ? raw : null) as Record<
    string,
    unknown
  > | null;
  if (!r) return null;
  // 只认真数：Number() 的隐式转换太宽厚，""→0、true→1、[5]→5 都能混进来，
  // 一个说不清来路的 0 会把整组配色悄悄染歪 —— 三个数必须本来就是个有限数
  if (
    ![r.h, r.s, r.l].every(
      (v) => typeof v === "number" && Number.isFinite(v),
    )
  )
    return null;
  return {
    h: num(r.h, 0, 360, 0),
    s: num(r.s, 0, 100, 0),
    l: num(r.l, 0, 100, 0),
  };
}

/**
 * 素材引用收口：只认 `asset:<文件名>` 或 http(s) 外链（大小写不敏感），别的统统当空。
 * 文件名不许带路径分隔符和 `..` —— 引用是要拼进 R2 key 和 URL 的。
 */
function assetRef(v: unknown): string {
  const s = str(v, MAX_URL);
  if (s.startsWith("asset:")) {
    const name = s.slice("asset:".length);
    if (!name || name.includes("/") || name.includes("\\") || name.includes(".."))
      return "";
    return `asset:${name}`;
  }
  // 大小写不敏感地认外链（跟前端 resolveAsset 的 /^https?:\/\//i 同一把尺）：
  // 不然用户粘个 HTTPS:// 预览正常、保存却被当脏值清空，没人知道图去哪了。
  // 命中后把协议头规范成小写再存，两边存储形状一致。
  const m = /^(https?):\/\//i.exec(s);
  return m ? m[1].toLowerCase() + s.slice(m[1].length) : "";
}

function normalizeBackground(raw: unknown): ThemeBackground {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    src: assetRef(r.src),
    dim: num(r.dim, 0, 1, 0),
    blur: num(r.blur, 0, 40, 0),
    position: str(r.position, 40) || "center",
    size: str(r.size, 40) || "cover",
  };
}

function normalizePopup(raw: unknown, i: number): ThemePopup | null {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const id = str(r.id, 60) || `popup-${i + 1}`;
  const trigger = str(r.trigger, 20);
  return {
    id,
    enabled: r.enabled !== false,
    title: str(r.title, MAX_TEXT),
    body: str(r.body, MAX_POPUP_BODY),
    image: assetRef(r.image),
    trigger: POPUP_TRIGGERS.includes(trigger as PopupTrigger)
      ? (trigger as PopupTrigger)
      : "load",
    delaySeconds: num(r.delaySeconds, 0, 3600, 0),
    actions: normalizePopupActions(r.actions),
  };
}

/** 动作目标收口：只认站内路径（`/x`）或 http(s) 外链，其余统统当空 */
function popupActionTo(v: unknown): string {
  const s = str(v, MAX_URL);
  if (!s) return "";
  // 协议相对 `//host/x` 会跳到站外，不是「站内路径」，先挡掉
  if (s.startsWith("/") && !s.startsWith("//") && !s.startsWith("/\\")) return s;
  const m = /^(https?):\/\//i.exec(s);
  return m ? m[1].toLowerCase() + s.slice(m[1].length) : "";
}

/** 动作按钮收口：先滤脏再封顶 2 条（脏条目不该白占配额），label 超出按 20 字截 */
function normalizePopupActions(raw: unknown): ThemePopupAction[] {
  if (!Array.isArray(raw)) return [];
  const out: ThemePopupAction[] = [];
  // 扫描量单独设上限：封顶的是「有效条数」，不能拿它当遍历长度
  for (const a of raw.slice(0, MAX_ACTION_SCAN)) {
    const r = (a && typeof a === "object" ? a : {}) as Record<string, unknown>;
    const label = str(r.label, MAX_ACTION_LABEL);
    const to = popupActionTo(r.to);
    if (!label || !to) continue;
    out.push({ label, to });
    if (out.length >= MAX_POPUP_ACTIONS) break;
  }
  return out;
}

/** 任意输入（库里读出的 JSON / 主题包清单）收口成全形状主题 */
export function normalizeTheme(raw: unknown): ThemeConfig {
  const t = defaultTheme();
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  t.locked = r.locked === true;
  const base = str(r.base, 10);
  if (THEME_MODES.includes(base as ThemeMode)) t.base = base as ThemeMode;
  t.tint = normalizeTint(r.tint);
  t.agentName = str(r.agentName, MAX_TEXT);
  t.agentAvatar = assetRef(r.agentAvatar);
  const bgs = (
    r.backgrounds && typeof r.backgrounds === "object" ? r.backgrounds : {}
  ) as Record<string, unknown>;
  for (const scope of BACKGROUND_SCOPES) {
    if (bgs[scope] !== undefined) t.backgrounds[scope] = normalizeBackground(bgs[scope]);
  }
  t.panelBg = str(r.panelBg, MAX_CSS);
  t.buttonPattern = str(r.buttonPattern, MAX_CSS);
  const icons = (
    r.iconOverrides && typeof r.iconOverrides === "object" ? r.iconOverrides : {}
  ) as Record<string, unknown>;
  for (const [name, val] of Object.entries(icons).slice(0, MAX_ICON_OVERRIDES)) {
    const key = str(name, 60);
    const ref = assetRef(val);
    if (key && ref) t.iconOverrides[key] = ref;
  }
  const motion = str(r.motion, 20);
  if (THEME_MOTIONS.includes(motion as ThemeMotion)) t.motion = motion as ThemeMotion;
  const ms = str(r.messageStyle, 20);
  if (THEME_MESSAGE_STYLES.includes(ms as ThemeMessageStyle))
    t.messageStyle = ms as ThemeMessageStyle;
  t.customCss = str(r.customCss, MAX_CUSTOM_CSS);
  if (Array.isArray(r.popups)) {
    const seen = new Set<string>();
    for (const [i, p] of r.popups.slice(0, MAX_POPUPS).entries()) {
      const popup = normalizePopup(p, i);
      if (!popup || seen.has(popup.id)) continue;
      seen.add(popup.id);
      t.popups.push(popup);
    }
  }
  return t;
}

export interface ThemeConfigPatch {
  locked?: boolean;
  base?: string;
  /** 基调色：传 null 清掉回预设，传 {h,s,l} 覆盖 */
  tint?: ThemeTint | null;
  agentName?: string;
  agentAvatar?: string;
  /** 按区块局部改背景；字段缺省不动 */
  backgrounds?: Record<string, Partial<ThemeBackground>>;
  panelBg?: string;
  buttonPattern?: string;
  /** 图标覆盖增改；值传 null 删掉这条 */
  iconOverrides?: Record<string, string | null>;
  motion?: string;
  messageStyle?: string;
  customCss?: string;
  /** 整组替换（面板里整组编辑，不做逐条 diff） */
  popups?: unknown[];
}

/** 改主题。字段缺省（undefined）不动 —— 和 updateDrawConfig 同一套语义 */
export function applyThemePatch(
  cur: ThemeConfig,
  patch: ThemeConfigPatch,
): ThemeConfig {
  const t = normalizeTheme(cur);
  if (patch.locked !== undefined) t.locked = patch.locked === true;
  if (patch.base !== undefined) {
    const base = str(patch.base, 10);
    if (!THEME_MODES.includes(base as ThemeMode))
      throw new Error(`不认识这种基调：${base}（只支持 paper / dawn / dark）`);
    t.base = base as ThemeMode;
  }
  if (patch.tint !== undefined) {
    if (patch.tint === null) t.tint = null;
    else {
      const v = normalizeTint(patch.tint);
      // 和别的枚举字段一个脾气：写路径给歪了当场说，不静悄悄吞
      if (!v)
        throw new Error("基调色要给色相/浓度/深浅三个数（0~360 / 0~100 / 0~100）");
      t.tint = v;
    }
  }
  if (patch.agentName !== undefined) t.agentName = str(patch.agentName, MAX_TEXT);
  if (patch.agentAvatar !== undefined) {
    // URL 型字段超限当场抛：str() 截一半的链接是坏链接，图说没就没
    assertLen(patch.agentAvatar, MAX_URL, "头像图片地址");
    t.agentAvatar = assetRef(patch.agentAvatar);
  }
  if (patch.backgrounds) {
    for (const [scope, bg] of Object.entries(patch.backgrounds)) {
      if (!BACKGROUND_SCOPES.includes(scope as BackgroundScope)) continue;
      if (bg && bg.src !== undefined) assertLen(bg.src, MAX_URL, "背景图片地址");
      const merged = { ...t.backgrounds[scope as BackgroundScope], ...(bg ?? {}) };
      t.backgrounds[scope as BackgroundScope] = normalizeBackground(merged);
    }
  }
  if (patch.panelBg !== undefined) {
    assertLen(patch.panelBg, MAX_CSS, "功能块背景");
    t.panelBg = str(patch.panelBg, MAX_CSS);
  }
  if (patch.buttonPattern !== undefined) {
    assertLen(patch.buttonPattern, MAX_CSS, "按钮花纹");
    t.buttonPattern = str(patch.buttonPattern, MAX_CSS);
  }
  if (patch.iconOverrides) {
    for (const [name, val] of Object.entries(patch.iconOverrides)) {
      const key = str(name, 60);
      if (!key) continue;
      if (val === null) delete t.iconOverrides[key];
      else {
        assertLen(val, MAX_URL, `图标「${key}」的图片地址`);
        const ref = assetRef(val);
        if (!ref) throw new Error(`图标「${key}」的图片地址不对（要 asset: 引用或 http(s) 链接）`);
        if (!t.iconOverrides[key] && Object.keys(t.iconOverrides).length >= MAX_ICON_OVERRIDES)
          throw new Error(`图标覆盖最多 ${MAX_ICON_OVERRIDES} 条`);
        t.iconOverrides[key] = ref;
      }
    }
  }
  if (patch.motion !== undefined) {
    const motion = str(patch.motion, 20);
    if (!THEME_MOTIONS.includes(motion as ThemeMotion))
      throw new Error(`不认识这种动画档：${motion}（只支持 default / gentle / off）`);
    t.motion = motion as ThemeMotion;
  }
  if (patch.messageStyle !== undefined) {
    const ms = str(patch.messageStyle, 20);
    if (!THEME_MESSAGE_STYLES.includes(ms as ThemeMessageStyle))
      throw new Error(`不认识这种消息栏风格：${ms}（只支持 bubble / card / minimal）`);
    t.messageStyle = ms as ThemeMessageStyle;
  }
  if (patch.customCss !== undefined) {
    assertLen(patch.customCss, MAX_CUSTOM_CSS, "自定义 CSS");
    t.customCss = str(patch.customCss, MAX_CUSTOM_CSS);
  }
  if (patch.popups !== undefined) t.popups = normalizeTheme({ popups: patch.popups }).popups;
  return t;
}

// ── 持久化：单行表（id=1），data 列存 JSON ──────────────────────

interface ThemeRow {
  data: string;
}

export function ensureThemeSchema(sql: SqlTag): void {
  sql`CREATE TABLE IF NOT EXISTS theme_config (
       id   INTEGER PRIMARY KEY,
       data TEXT NOT NULL
     )`;
}

/** 读主题。表空 / JSON 坏了都回落出厂主题 —— 读路径永远不许抛 */
export function loadTheme(sql: SqlTag): ThemeConfig {
  ensureThemeSchema(sql);
  const rows = sql<ThemeRow>`SELECT data FROM theme_config WHERE id = 1`;
  const raw = rows[0]?.data;
  if (!raw) return defaultTheme();
  try {
    return normalizeTheme(JSON.parse(raw));
  } catch {
    return defaultTheme();
  }
}

/** 整份写回（normalize 收口后落库）。装备主题包也走这里 */
export function saveTheme(sql: SqlTag, raw: unknown): ThemeConfig {
  ensureThemeSchema(sql);
  const theme = normalizeTheme(raw);
  sql`INSERT INTO theme_config (id, data) VALUES (1, ${JSON.stringify(theme)})
      ON CONFLICT(id) DO UPDATE SET data = excluded.data`;
  return theme;
}

/** 局部改。字段缺省不动 */
export function patchTheme(sql: SqlTag, patch: ThemeConfigPatch): ThemeConfig {
  const cur = loadTheme(sql);
  return saveTheme(sql, applyThemePatch(cur, patch));
}

/** 主题里所有被引用的素材文件名（去重、只认 asset: 引用） */
export function referencedAssets(theme: ThemeConfig): string[] {
  const names = new Set<string>();
  // 和 assetRef 同一把尺：脏文件名（带路径分隔符/..）不收 —— 这名字是要拼进
  // R2 key 和包内路径的
  const add = (name: string) => {
    if (!name || name.includes("/") || name.includes("\\") || name.includes(".."))
      return;
    names.add(name);
  };
  const take = (ref: string) => {
    if (ref.startsWith("asset:")) add(ref.slice("asset:".length));
  };
  // panelBg 是整段原样注入的 CSS（上传后是 `url("/api/theme-asset/x.png")`），
  // buttonPattern 和 customCss 也可能被人写成 CSS —— 把嵌在里面的素材名捞出来。
  // 漏了这步，导出的包不带这几处的图（装上就是空底），导入也不校验悬空。
  const takeCss = (css: string) => {
    for (const m of css.matchAll(/asset:([^\s"'()]+)/g)) add(m[1]);
    for (const m of css.matchAll(/\/api\/theme-asset\/([^"')\s]+)/g)) {
      try {
        add(decodeURIComponent(m[1]));
      } catch {
        add(m[1]);
      }
    }
  };
  for (const bg of Object.values(theme.backgrounds)) take(bg.src);
  take(theme.agentAvatar);
  for (const ref of Object.values(theme.iconOverrides)) take(ref);
  for (const p of theme.popups) take(p.image);
  take(theme.buttonPattern);
  takeCss(theme.buttonPattern);
  takeCss(theme.panelBg);
  // customCss 同样是原样注入的整段 CSS（上限 10000 字符），一样捞
  takeCss(theme.customCss);
  return [...names];
}

// ── 自定义主题存档（theme_sets）：把当前整份配置存成一份带名字的档 ────────
//
// 存的不是 JSON，而是**一份完整主题包 zip**（清单 + assets/）在云盘的 key ——
// 这样一份档是自包含的：素材跟着包走，哪怕后来主题素材被换掉、被删掉，翻出
// 旧档照样装得上（assets/ 里的本体就是当时的原件）。换装走 unpackThemePack
// 那条老路，和「装备主题包」共用同一把刀。
//
// 表存在主人房库里，跟着主题一起是全屋一份的东西；写路径同样只有管理员。

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

interface ThemeSetRow {
  id: string;
  name: string;
  pack_key: string;
  created: number;
  bytes: number;
}

const MAX_SET_NAME = 60;
/** 存档上限：一个人不会留几十份主题，给个明确的天花板免得表无限长 */
export const MAX_THEME_SETS = 40;

export function ensureThemeSetSchema(sql: SqlTag): void {
  sql`CREATE TABLE IF NOT EXISTS theme_sets (
       id       TEXT PRIMARY KEY,
       name     TEXT NOT NULL,
       pack_key TEXT NOT NULL,
       created  INTEGER NOT NULL,
       bytes    INTEGER NOT NULL
     )`;
}

function rowToSet(r: ThemeSetRow): ThemeSet {
  return {
    id: r.id,
    name: r.name,
    packKey: r.pack_key,
    created: Number(r.created) || 0,
    bytes: Number(r.bytes) || 0,
  };
}

/** 全部存档，新的在前 */
export function listThemeSets(sql: SqlTag): ThemeSet[] {
  ensureThemeSetSchema(sql);
  return sql<ThemeSetRow>`
    SELECT id, name, pack_key, created, bytes
    FROM theme_sets ORDER BY created DESC`.map(rowToSet);
}

export function getThemeSet(sql: SqlTag, id: string): ThemeSet | null {
  ensureThemeSetSchema(sql);
  const rows = sql<ThemeSetRow>`
    SELECT id, name, pack_key, created, bytes
    FROM theme_sets WHERE id = ${id}`;
  return rows.length ? rowToSet(rows[0]) : null;
}

/** 存一份新档。名子收口在 60 字，空名当场报 */
export function insertThemeSet(
  sql: SqlTag,
  input: { name: string; packKey: string; bytes: number },
): ThemeSet {
  ensureThemeSetSchema(sql);
  const name = (input.name || "").trim().slice(0, MAX_SET_NAME);
  if (!name) throw new Error("自定义主题的名字不能为空");
  if (!input.packKey) throw new Error("存档缺少包体位置");
  const count = sql<{ n: number }>`SELECT COUNT(*) AS n FROM theme_sets`;
  if ((Number(count[0]?.n) || 0) >= MAX_THEME_SETS)
    throw new Error(`自定义主题最多 ${MAX_THEME_SETS} 份，先删几份再存`);
  const row: ThemeSetRow = {
    id: crypto.randomUUID().slice(0, 8),
    name,
    pack_key: input.packKey,
    created: Date.now(),
    bytes: Math.max(0, Math.floor(input.bytes) || 0),
  };
  sql`INSERT INTO theme_sets (id, name, pack_key, created, bytes)
      VALUES (${row.id}, ${row.name}, ${row.pack_key}, ${row.created}, ${row.bytes})`;
  return rowToSet(row);
}

/** 删一份档，回来被删的那条（没有就 null）—— 调用方拿 packKey 去清云盘 */
export function deleteThemeSet(sql: SqlTag, id: string): ThemeSet | null {
  ensureThemeSetSchema(sql);
  const cur = getThemeSet(sql, id);
  if (!cur) return null;
  sql`DELETE FROM theme_sets WHERE id = ${id}`;
  return cur;
}
