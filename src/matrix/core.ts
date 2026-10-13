// 网页矩阵（原独立副包 webback-ericher，现已并回主包）。
//
// 定位：主包 ericher-app 的一个功能模块。它跟主包同进程、同一只 R2 桶
// （MEMORY_BUCKET）：矩阵的配置（matrix/config.json）与页面正文
// （matrix/page/<id>.html）都落那里。合并前它是个独立 Worker，主包靠
// MATRIX_ORIGIN + HMAC 内部头把请求转过去；现在这些跨进程的东西全没了 ——
// 访客身份由主包直接算好传进来，认领不了就返回 null 交回主包。
//
// 职责：
//   1. 认领主域名下的非保留路径，按层级路径找到页面 → 四档身份校验 → 直吐正文；
//   2. 页面级沙箱（可选）与「外挂层」注入（回助手 / 层级导航 / 管理员入口）；
//   3. 根路径 `/` 在入口页落后时 302 到入口页（公开访客），管理员与登录用户照常回接待台；
//   4. 管理面 CRUD（/api/matrix/*）：主包只做「管理员」这道闸，真正的活在这儿；
//   5. 矩阵包：整套矩阵与一个 zip 互转（/api/matrix/pack），装备即**整体替换**。
//      矩阵是本地照包准则做熟、一次装上的东西 —— 云端那套编辑面是补充，不是唯一入口。

import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";

/** 访客身份：主包验过 cookie 之后算好的东西（public = 没带票的过路人） */
export type MatrixViewer = {
  role: "admin" | "user" | "public";
  type?: string;
  card?: string;
};

/** 矩阵这一块只用到云盘桶；主包的 Env 结构上天然满足 */
export interface MatrixEnv {
  MEMORY_BUCKET: R2Bucket;
}

/** 四档身份：公开 / 持票来客 / 管理员 / 指定来客档位白名单 */
type Access = "public" | "visitor" | "admin" | "types";

/**
 * 节点类型：矩阵里的一个点是什么东西。
 * 点是网页、是门卫、还是助手本体，决定「站到它会发生什么」——
 * 有了它，那张图才说得清方向：入口 → 展示页 → 门卫 → 内区 → 助手 / 功能块。
 */
export type MatrixNodeKind =
  | "page" // 一页网页（默认）：带正文，或引用云盘文件，或是一条外站链接
  | "gate" // 门卫：自己不出正文，站到它就把人送去验票，验完去它的第一条出边
  | "assistant" // 助手：站到它就把人送去接待台本体
  | "app"; // 功能块：由内建的处理单元出内容（还没接，先占这一格）

export interface MatrixPage {
  /** 随机码，正文存 matrix/page/<id>.html */
  id: string;
  /** 层级路径，无首尾斜杠（如 "thisme/foryou"；"" 表示根） */
  path: string;
  title: string;
  access: Access;
  /** 节点类型；缺省 = page。老配置里没有这一格，读的时候一律按网页算 */
  kind?: MatrixNodeKind;
  /** access === "types" 时的档位白名单（来客类型 id） */
  types?: string[];
  /** 页面级沙箱，默认关 */
  sandbox?: boolean;
  /** 入口页（最多一个）：公开访客访问根路径时 302 到它 */
  entry?: boolean;
  /** 外站链接：有值则不出本地正文，只作导航里的外链 */
  external?: string;
  /**
   * 页面级自由 CSS：只在这一页生效，排在矩阵默认样式之后（能覆盖默认）。
   * 写它 = 这页的样式自己钉住，不跟全局换肤走。过 parseCss 收口后才存。
   */
  css?: string;
  /**
   * 正文改为「引用云盘里的一个文件」时记的 key。有它就不出本页正文，
   * 实时去读那只文件 —— 云盘那边改了，页面跟着变；那只文件因此不能删/搬
   * （见 src/tools/files.ts 的引用保护）。与正文二选一。
   */
  driveKey?: string;
  updatedAt: number;
}

/** 按钮摆在页面里的哪里 */
type LinkPlace =
  | { kind: "auto" } // 兜底：注入到页面末尾的「通路」栏
  | { kind: "anchor"; name: string } // 填进页面里名为 name 的命名锚点
  | { kind: "point"; x: number; y: number }; // 拖拽落点（百分比 0-100）

/** 矩阵里的一条通路：A 页里的一个按钮，指向 B 页 */
export interface MatrixLink {
  /** 起点页面 id（不是 path —— 页面改路径时连线不能断） */
  from: string;
  /** 终点页面 id */
  to: string;
  /** 按钮文字 */
  label: string;
  place: LinkPlace;
  /** 同一处的排序 */
  order: number;
}

/**
 * 外站认定：只有列在这张表里的域名才允许从内站过去。
 * 门卫页是唯一出口，它拿目标域名来这张表上比对 —— 表外的地址一律拦下，
 * 顺带也就挡住了「伪造 to 参数往外跳」的开放重定向。
 */
export interface ApprovedSite {
  /** 域名（小写，不含协议与路径）。它也放行自己的子域，如 example.com 认 acme.example.com */
  host: string;
  /** 为什么放行：给自己下次看得懂用的备注 */
  note?: string;
  /** 免提示：认定过、信得过，从内站过去直接跳，不再停门卫页 */
  skip?: boolean;
}

interface MatrixConfig {
  rev: number;
  pages: MatrixPage[];
  /** 页面之间的连线。旧配置没有这个字段，loadConfig 会补空数组 */
  links: MatrixLink[];
  /** 全局悬浮菜单。旧配置没有这个字段，loadConfig 会补默认（开） */
  nav?: NavConfig;
  /** 全局外观（注入物的主色与按钮形态）。旧配置没有，loadConfig 会补默认 */
  theme?: MatrixTheme;
  /** 外站认定表。旧配置没有，loadConfig 会补空数组（= 一个外站都不放行） */
  sites?: ApprovedSite[];
}

/**
 * 全局悬浮菜单：所有页面统一在左上角挂一个半透明浮窗，列出当前身份能去的页面。
 * 全局一个开关，而不是每页各设一道 —— 新增页面自动带上，不必逐页记着配。
 * 位置固定在左上：不让人拖（拖了就得记住它拖到哪，反而多出一件要维护的事）。
 */
interface NavConfig {
  on: boolean;
}

const DEFAULT_NAV: NavConfig = { on: true };

const CONFIG_KEY = "matrix/config.json";
const PAGE_PREFIX = "matrix/page/";
/** 正文体积上限：矩阵页是给人看的整页 HTML，2MB 足够，也挡住误传大文件 */
const MAX_BODY_BYTES = 2 * 1024 * 1024;
/** 通路总量上限：够了就够用，也是对外可写接口的一道闸 */
const MAX_LINKS = 500;
/** 配置在 isolate 内的短缓存：读路径不必每请求都打 R2，写路径当场刷新 */
const CONFIG_TTL_MS = 5_000;
/** 外站认定表的条目上限：够了就够用，也是对外可写接口的一道闸 */
const MAX_SITES = 200;
/** 门卫页（去外站前的那道闸）的固定落点：保留路径，不做页面 */
const GATE_PATH = "_gate";
/** 验票页（进内区前的那道闸）的固定落点：保留路径，不做页面 */
const TICKET_PATH = "_ticket";
/** 保留字：这些首段归主包（应用、静态资源、助手固定落点），矩阵不认领 */
const RESERVED_FIRST = new Set([
  "api",
  "agents",
  "assets",
  "index",
  "assistant",
  // 两道闸的固定落点：它们得独占，不能被某个矩阵页面占去 —— 占去就等于把闸门交给页面
  GATE_PATH,
  TICKET_PATH,
]);
/** 助手（接待台本体）的固定落点：外挂层的「回助手」与各静态页的回头链接都指它 */
const ASSISTANT_PATH = "/assistant";
const SEG = "[a-z0-9_-]+";
const PATH_RE = new RegExp(`^${SEG}(?:/${SEG}){0,2}$`);

let configCache: { cfg: MatrixConfig; at: number } | null = null;

// ── 矩阵包（成熟体直接部署）──────────────────────────────
//
// 一个 zip 装一次就成形。为什么要有它：矩阵是一批自建网页 + 连线 + 外观 + 外站认定，
// 在工作台里一页一页配只适合零星改动；真正的成熟体是在本地照包准则做好、一次装上来的
// —— 云端的编辑面是补充，不是唯一入口。
//
// 装备语义是**整体替换**，不是合并：装上的就是那个包的样子。这条是包准则的一部分，
// 也是它跟美化包一致的地方（结果可预期、来回可复现）。删掉矩阵配置，矩阵自然一并消失。
//
// 包体（zip）：
//   matrix.json        清单：{ format, version, exportedAt, config }
//   pages/<id>.html    页面正文（外站页与引用云盘文件的页不带正文）
//
// 边界：包只装成品矩阵，不含工作台本身 —— 工作台是「读配置的程序」，随主包走；
// 它保证的是「同一套云盘里可复现」，不是「可移植到任意环境」（云盘引用页换个桶就读不到）。
const PACK_FORMAT = "ericher-matrix";
const PACK_VERSION = 1;
const PACK_MANIFEST = "matrix.json";
const PACK_PAGE_DIR = "pages/";
/** 装备前的留底槽：每次装备先把当前这套压在这里，只留最近一次 */
const PACK_SNAPSHOT_KEY = "matrix/snapshot/prev.zip";
/** 条目总数 / 单文件 / 总量 / 清单上限：与主题包同一把尺 */
const MAX_PACK_ENTRIES = 1000;
const MAX_PACK_FILE_BYTES = 50 * 1024 * 1024;
const MAX_PACK_TOTAL_BYTES = 200 * 1024 * 1024;
const MAX_PACK_MANIFEST_BYTES = 256 * 1024;
/**
 * 页面 id 的收口：它要直接拼进 R2 key（matrix/page/<id>.html）。
 * 放开等于把路径交给包作者 —— `../config` 这种 id 能写到桶里别处去。
 */
const PACK_ID_RE = /^[a-z0-9]{1,32}$/;

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

function html(
  body: string,
  extra: Record<string, string> = {},
  status = 200,
): Response {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-store",
      ...extra,
    },
  });
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** 去掉首尾斜杠："/" → ""，"thisme/foryou/" → "thisme/foryou" */
function normPath(pathname: string): string {
  return pathname.replace(/^\/+/, "").replace(/\/+$/, "");
}

function parentOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i);
}

function newId(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 16);
}

// ── 配置读写 ────────────────────────────────────────────

function emptyConfig(): MatrixConfig {
  return {
    rev: 0,
    pages: [],
    links: [],
    nav: { ...DEFAULT_NAV },
    theme: { ...DEFAULT_THEME },
    sites: [],
  };
}

async function loadConfig(env: MatrixEnv): Promise<MatrixConfig> {
  if (configCache && Date.now() - configCache.at < CONFIG_TTL_MS)
    return configCache.cfg;
  let cfg = emptyConfig();
  try {
    const obj = await env.MEMORY_BUCKET.get(CONFIG_KEY);
    if (obj) {
      const parsed = JSON.parse(await obj.text()) as MatrixConfig;
      if (parsed && Array.isArray(parsed.pages)) {
        cfg = parsed;
        // 旧配置没有 links：补个空数组，免得后面每次读都判空；顺带挡住
        // 手工改坏的 config（links 不是数组时按没有处理，不炸整包）
        if (!Array.isArray(cfg.links)) cfg.links = [];
        // 旧配置没有 nav：默认开着 —— 悬浮菜单本来就是「配好了就该在」的东西
        if (!cfg.nav || typeof cfg.nav.on !== "boolean")
          cfg.nav = { ...DEFAULT_NAV };
        // 旧配置没有 theme：补默认，且过一遍解析（挡住手工改坏的色值）
        cfg.theme = parseTheme(cfg.theme);
        // 旧配置没有 sites：补空数组 —— 空表 = 一个外站都不放行，是安全的那一侧
        if (!Array.isArray(cfg.sites)) cfg.sites = [];
      }
    }
  } catch {
    // 读路径不抛：配置坏了就按空处理，页面请求自然回 miss，不炸整个包
    cfg = emptyConfig();
  }
  configCache = { cfg, at: Date.now() };
  return cfg;
}

async function saveConfig(env: MatrixEnv, cfg: MatrixConfig): Promise<void> {
  cfg.rev = (cfg.rev || 0) + 1;
  await env.MEMORY_BUCKET.put(CONFIG_KEY, JSON.stringify(cfg));
  configCache = { cfg, at: Date.now() };
}

function bodyKey(id: string): string {
  return `${PAGE_PREFIX}${id}.html`;
}

// ── 身份校验 ────────────────────────────────────────────

/** admin 无往不利；来客看公开/持票/档位白名单；没有票的只能看公开 */
function allowed(page: MatrixPage, viewer: MatrixViewer): boolean {
  if (viewer.role === "admin") return true;
  switch (page.access) {
    case "public":
      return true;
    case "visitor":
      return viewer.role === "user";
    case "types":
      return (
        viewer.role === "user" &&
        !!viewer.type &&
        !!page.types &&
        page.types.includes(viewer.type)
      );
    case "admin":
    default:
      return false;
  }
}

// ── 静态页（拒绝 / 缺正文）────────────────────────────────

const PAGE_SHELL_STYLE =
  "margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;" +
  "background:#f6f6f7;color:#111;font:16px/1.7 system-ui,-apple-system,'Segoe UI',sans-serif;";
const PAGE_CARD_STYLE =
  "max-width:420px;padding:28px 32px;background:#fff;border:1px solid #e3e3e6;" +
  "border-radius:14px;text-align:center;";

function staticPage(title: string, msg: string): string {
  return (
    `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>${esc(title)}</title></head>` +
    `<body style="${PAGE_SHELL_STYLE}"><main style="${PAGE_CARD_STYLE}">` +
    `<h1 style="margin:0 0 10px;font-size:18px;">${esc(title)}</h1>` +
    `<p style="margin:0 0 18px;color:#555;">${esc(msg)}</p>` +
    `<a href="${ASSISTANT_PATH}" style="color:#0b6bcb;text-decoration:none;">回助手</a>` +
    `</main></body></html>`
  );
}

// ── 全局外观：注入物长什么样 ────────────────────────────
//
// 注入进页面的按钮与悬浮菜单不是页面内容，是矩阵的「外挂层」—— 它长什么样由
// 矩阵统一说了算，不散在各页的手写样式里。一处 token、一段 <style>，改一次全站变。

/** 按钮形态：文字链接 / 描边 / 实底 */
type ButtonShape = "text" | "outline" | "solid";

/** 矩阵外观：注入物的主色与按钮形态（页面自己的 CSS 是另一回事，见页面级 css） */
export interface MatrixTheme {
  /** 主色：链接与按钮的强调色，六个十六进制位 */
  accent: string;
  button: ButtonShape;
}

const DEFAULT_THEME: MatrixTheme = { accent: "#0b6bcb", button: "text" };
const ACCENT_RE = /^#[0-9a-fA-F]{6}$/;

/** 外观解析：主色不合规就回落默认，形态不认识就当文字链 —— 脏数据不许让整站变样 */
function parseTheme(v: unknown): MatrixTheme {
  const o = (v && typeof v === "object" ? v : {}) as {
    accent?: unknown;
    button?: unknown;
  };
  const accent =
    typeof o.accent === "string" && ACCENT_RE.test(o.accent.trim())
      ? o.accent.trim().toLowerCase()
      : DEFAULT_THEME.accent;
  const button: ButtonShape =
    o.button === "outline" || o.button === "solid" ? o.button : "text";
  return { accent, button };
}

/** 按钮形态的三套皮：同一副骨架，换填充与边框 */
const BUTTON_CSS: Record<ButtonShape, string> = {
  text:
    ".mx-btn,.mx-btn:visited{padding:2px 4px;border:none;background:transparent;" +
    "text-decoration:underline;text-underline-offset:3px;}",
  outline:
    ".mx-btn,.mx-btn:visited{padding:5px 14px;border:1px solid var(--mx-accent);" +
    "border-radius:var(--mx-radius);background:transparent;}",
  solid:
    ".mx-btn,.mx-btn:visited{padding:5px 14px;border:1px solid var(--mx-accent);" +
    "border-radius:var(--mx-radius);background:var(--mx-accent);color:#fff;}",
};

/**
 * 页面级自由 CSS 的收口：它会被塞进 <style> 里直吐给访客，是一段可写内容，
 * 所以在这儿把能闯祸的写法挡掉，剩下的原样存：
 *   - `</style`：闭合标签逃逸，能把后面变成正文 HTML；
 *   - `@import`：从别的地址拉样式表，绕过本页作用域；
 *   - `url()` 指到外站：探针式加载 / 泄 IP，只放行 data: 与同源相对路径。
 * 超过体积上限也拒 —— 一页样式不该长到拖垮吐页。
 */
const MAX_CSS_BYTES = 64 * 1024;
const EXTERNAL_URL_RE = /url\(\s*['"]?(?:https?:)?\/\//i;

function parseCss(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const css = v.replace(/\r\n/g, "\n").trim();
  if (!css) return undefined;
  if (css.length > MAX_CSS_BYTES) throw new Error("本页 CSS 过大（上限 64KB）");
  if (/<\/style/i.test(css)) throw new Error("本页 CSS 不能含 </style>");
  if (/@import/i.test(css)) throw new Error("本页 CSS 不能用 @import");
  if (EXTERNAL_URL_RE.test(css)) throw new Error("本页 CSS 的 url() 不能用外站地址");
  return css;
}

/**
 * 外挂层那一整段样式：token（主色/圆角/字色/字族）加各类注入物的默认长相。
 * 弹进每一页的 <head>，一处改全站变。页面自己的 CSS 排在它后面（见页面级 css），
 * 于是页面能覆盖这里的默认值，却不会外溢到别的页。
 */
function buildStyle(t: MatrixTheme): string {
  return (
    `<style id="mx-style">` +
    `:root{--mx-accent:${t.accent};--mx-radius:8px;--mx-ink:#111;` +
    `--mx-line:rgba(0,0,0,.14);--mx-font:14px/1.6 system-ui,-apple-system,'Segoe UI',sans-serif;}` +
    // 白纸黑字兜个底：页面自己不写背景时，画布会交给浏览器 —— 开着自动深色的
    // 那边把画布涂黑，而正文颜色还是默认的黑，于是黑底黑字、整页像空白。
    // 底色与字色成对写死就翻不出这种局面（真被自动深色反相，也是一对一起反）。
    // color-scheme:light 顺带把表单控件按浅色画。页面自己的 CSS 排在这段之后，
    // 想换深色主题照样盖得住。
    `html{background:#fff;color:var(--mx-ink);color-scheme:light;}` +
    `a.mx-link,a.mx-link:visited{color:var(--mx-accent);text-decoration:none;}` +
    `a.mx-link:hover{text-decoration:underline;}` +
    `.mx-btn,.mx-btn:visited{display:inline-flex;align-items:center;color:var(--mx-accent);` +
    `font:var(--mx-font);text-decoration:none;}` +
    `.mx-btn:hover{text-decoration:none;}` +
    BUTTON_CSS[t.button] +
    // 悬浮菜单：默认钉在左上角、半透明，不抢正文的视线，也不跟着滚动跑。
    // 但它是能拖的（见 buildNavDrag）—— 正文里被它压住的那块，挪开就是了
    `.mx-nav{position:fixed;left:12px;top:12px;z-index:2147483646;max-width:264px;` +
    `background:rgba(255,255,255,.78);color:var(--mx-ink);border:1px solid var(--mx-line);` +
    `border-radius:10px;padding:6px 10px;box-shadow:0 2px 12px rgba(0,0,0,.14);font:var(--mx-font);}` +
    // 折叠开关：真身藏起来（别占位、别挡点击），键盘 Tab 过去还能按空格开合
    `.mx-nav-cb{position:absolute;width:1px;height:1px;opacity:0;pointer-events:none;}` +
    // 摘要那行既是开合的开关，也是整块菜单的抓手 —— 光标给「抓」
    `.mx-nav-sum{display:block;cursor:grab;font-weight:600;user-select:none;}` +
    `.mx-nav.mx-drag{opacity:.92;}` +
    `.mx-nav.mx-drag .mx-nav-sum{cursor:grabbing;}` +
    `.mx-nav-sum::after{content:"▾";margin-left:6px;color:#999;font-size:11px;}` +
    `.mx-nav-body{display:none;}` +
    `.mx-nav-cb:checked~.mx-nav .mx-nav-body{display:block;}` +
    `.mx-nav-cb:checked~.mx-nav .mx-nav-sum::after{content:"▴";}` +
    `.mx-nav-list{display:flex;flex-direction:column;gap:2px;margin-top:4px;` +
    `max-height:52vh;overflow:auto;}` +
    `.mx-nav-foot{padding-top:6px;}` +
    // 外站那一小截注记：不是本地页，点了会开到别的站点去
    `.mx-ext{color:#888;margin-left:4px;font-size:12px;}` +
    // 通路兜底栏：没处安放的按钮统一落在页面末尾这一栏
    `.mx-fallback-nav{margin:24px auto;max-width:640px;padding:10px 14px;background:#fff;` +
    `color:var(--mx-ink);border:1px solid #e3e3e6;border-radius:12px;font:var(--mx-font);}` +
    `.mx-fallback-label{color:#888;}` +
    `.mx-fallback-group{display:flex;flex-wrap:wrap;align-items:center;gap:8px 14px;padding-top:6px;}` +
    // 拖拽落点：绝对定位到整页坐标（left/top 由行内给，其余在这儿）
    `.mx-point{position:absolute;transform:translate(-50%,-50%);z-index:2147483000;}` +
    // 地址不被允许（伪协议之类）：给一截说明，不是可点的链接
    `.mx-dead{color:#999;cursor:default;text-decoration:line-through;}` +
    // 手机窄屏：菜单默认只占一行摘要（展开态由下面那两段 @media 分工决定），
    // 宽度铺满一整条 —— 375px 的屏上 264px 就是七成，那就是块挡板了；字号也收一档。
    // 只改这一处：所有矩阵页共用这段样式，谁做的包都不用自己再写一遍
    `@media(max-width:640px){` +
    `.mx-nav{left:10px;right:10px;max-width:none;padding:6px 12px;font-size:13px;}` +
    `.mx-nav-list{max-height:40vh;}` +
    `}` +
    // 宽屏：默认摊开（跟从前一样），想腾地方点摘要那行折起来。
    // 同一个复选框，两段 @media 里语义正好相反 —— 窄屏是「点开」，宽屏是「收起」，
    // 这样不写一行脚本也能让菜单在手机上先收着
    `@media(min-width:641px){` +
    `.mx-nav-body{display:block;}` +
    `.mx-nav-cb:checked~.mx-nav .mx-nav-body{display:none;}` +
    `.mx-nav-sum::after{content:"▴";}` +
    `.mx-nav-cb:checked~.mx-nav .mx-nav-sum::after{content:"▾";}` +
    `}` +
    `</style>`
  );
}

/**
 * 悬浮菜单的拖拽：按住摘要那行，整块菜单跟着手走，落点记在本地。
 *
 * 菜单默认还是钉在左上角，只是终于挪得动了 —— 正文里被它压住的那块，从前只能
 * 靠折叠让开，现在直接拖走。落点按浏览器记（localStorage），下次进来还在原处。
 *
 * 一小段自足的内联脚本：不外链、不依赖任何东西（矩阵页要能断网打开）。
 * 摘要那行本来就是开合的开关，所以拖过之后紧跟的那一下 click 得吞掉 ——
 * 不然松手时顺手就把菜单开合了（跟工作台里那些浮窗一个道理）。
 * 沙箱页的源是不透明的，localStorage 会抛：读写都裹了 try，抛了就退成「不记」。
 */
function buildNavDrag(): string {
  return (
    `<script>(function(){` +
    `var n=document.querySelector('.mx-nav'),` +
    `s=n&&n.querySelector('.mx-nav-sum');` +
    `if(!s)return;` +
    `var K='matrix:nav:pos',T=3,d=null,mv=0,w=0,h=0,sx=0,sy=0,ox=0,oy=0;` +
    `function size(){w=n.offsetWidth;h=n.offsetHeight;}` +
    `function place(x,y){` +
    `n.style.left=Math.max(4,Math.min(innerWidth-w-4,x))+'px';` +
    `n.style.top=Math.max(4,Math.min(innerHeight-h-4,y))+'px';` +
    `n.style.right='auto';n.style.bottom='auto';` +
    `n.style.maxWidth=Math.min(264,innerWidth-24)+'px';}` +
    // 恢复上次挪到的地方；读不出来（没拖过 / 沙箱页）就保持 CSS 的左上角
    `try{var p=JSON.parse(localStorage.getItem(K)||'null');` +
    `if(p&&isFinite(p.x)&&isFinite(p.y)){size();place(p.x,p.y);}}catch(e){}` +
    `s.style.touchAction='none';` +
    `s.addEventListener('pointerdown',function(e){` +
    `if(e.button)return;` +
    `var r=n.getBoundingClientRect();` +
    `size();d=e.pointerId;mv=0;sx=e.clientX;sy=e.clientY;ox=r.left;oy=r.top;` +
    `try{s.setPointerCapture(e.pointerId);}catch(x){}});` +
    `s.addEventListener('pointermove',function(e){` +
    `if(d===null)return;` +
    // 先挪够阈值才认作「在拖」：点一下是开合，不是拖
    `if(!mv){if(Math.abs(e.clientX-sx)<T&&Math.abs(e.clientY-sy)<T)return;` +
    `mv=1;n.className+=' mx-drag';}` +
    `place(ox+e.clientX-sx,oy+e.clientY-sy);});` +
    `function end(){` +
    `if(d===null)return;` +
    `try{s.releasePointerCapture(d);}catch(x){}` +
    `d=null;n.className=n.className.replace(' mx-drag','');` +
    `if(mv){try{localStorage.setItem(K,JSON.stringify({` +
    `x:parseFloat(n.style.left),y:parseFloat(n.style.top)}));}catch(x){}}}` +
    `s.addEventListener('pointerup',end);` +
    `s.addEventListener('pointercancel',end);` +
    // mv 留到下一次按下才复位：这一下 click 正是「刚拖完」的那一下
    `s.addEventListener('click',function(e){` +
    `if(mv){e.preventDefault();e.stopPropagation();}},true);` +
    `addEventListener('resize',function(){` +
    `size();if(n.style.left)place(parseFloat(n.style.left),` +
    `parseFloat(n.style.top));});` +
    `})();</script>`
  );
}

/**
 * 全局悬浮菜单：站在哪一页都能看到「我还能去哪儿」。
 *
 * 列的是当前身份**能访问的全部页面**（外站也列，标一下），当前这页不重复列 ——
 * 它在折起来的那一行摘要里（「菜单 · 大厅」），一眼知道自己站在哪。
 *
 * 开合用一个藏起来的复选框配摘要那行的 <label>，零脚本。默认开还是合按屏宽分工：
 * 宽屏摊开（页面留白得自己让开它），窄屏先收成一行摘要 —— 手机上摊开的菜单
 * 铺满一整条，等于在正文顶上压了块挡板，而访客第一眼要看的是页而不是菜单。
 *
 * 唯一那段脚本在 buildNavDrag：按住摘要那行能把它整块挪开（从前只能折叠让位）。
 */
function buildNav(
  viewer: MatrixViewer,
  cfg: MatrixConfig,
  currentPath: string,
): string {
  if (!cfg.nav?.on) return "";
  const mine = cfg.pages.find((p) => p.path === currentPath);
  const reachable = cfg.pages
    .filter((p) => allowed(p, viewer) && p.path && p.path !== currentPath)
    .sort((a, b) => a.path.localeCompare(b.path));

  const rows = reachable.map((p) => {
    const label = esc(p.title || p.path);
    const ext = p.external ? `<span class="mx-ext">外站</span>` : "";
    // 外站一律经门卫页出去：认定表就在那儿把关，导航里不放过任何直连的口子
    return p.external
      ? `<a class="mx-link" href="${esc(gateHref(p.external, currentPath))}">${label}</a>${ext}`
      : `<a class="mx-link" href="/${esc(p.path)}">${label}</a>${ext}`;
  });

  return (
    // 折叠靠一个藏起来的复选框 + 摘要那行 <label>：零脚本，键盘也能开合。
    // 默认是开是合交给 CSS（窄屏收着、宽屏摊开），见 buildStyle 里那两段 @media
    `<input type="checkbox" class="mx-nav-cb" id="mx-nav-cb" aria-label="展开或收起导航菜单">` +
    `<div class="mx-nav">` +
    `<label class="mx-nav-sum" for="mx-nav-cb">菜单 · ${esc(
      mine?.title || mine?.path || "首页",
    )}</label>` +
    `<div class="mx-nav-body">` +
    `<div class="mx-nav-list">` +
    (rows.length ? rows.join("") : `<span class="mx-ext">没有别的页面</span>`) +
    `</div>` +
    `<div class="mx-nav-foot"><a class="mx-link" href="${ASSISTANT_PATH}">回助手</a></div>` +
    `</div>` +
    `</div>` +
    // 拖拽脚本紧跟着菜单：就在同一段里，解析到这儿菜单已经在了
    buildNavDrag()
  );
}

/** 把一段 HTML 插进 <head> 末尾；没有 head 就退到 <html> 之后，再不然贴最前 */
function injectIntoHead(htmlText: string, snippet: string): string {
  if (!snippet) return htmlText;
  const close = /<\/head\s*>/i.exec(htmlText);
  if (close)
    return htmlText.slice(0, close.index) + snippet + htmlText.slice(close.index);
  const open = /<html[^>]*>/i.exec(htmlText);
  if (open) {
    const at = open.index + open[0].length;
    return htmlText.slice(0, at) + snippet + htmlText.slice(at);
  }
  return snippet + htmlText;
}

/** 把一段 HTML 插进正文第一个 <body ...> 之后；没有 body 标签就贴到最前面 */
function injectAfterBody(htmlText: string, snippet: string): string {
  if (!snippet) return htmlText;
  const m = /<body[^>]*>/i.exec(htmlText);
  if (m) {
    const at = m.index + m[0].length;
    return htmlText.slice(0, at) + snippet + htmlText.slice(at);
  }
  return snippet + htmlText;
}

// ── 门卫：从内站往站外去的那道闸 ──────────────────────────
//
// 「往站外去」这件事只开一个口：/_gate。绑定的外站链接、注入的按钮、正文里手写的
// 绝对外链，全都先落到门卫页；门卫拿目标域名去认定表比对，表才放行 —— 于是
//   1. 表外的地址一律拦下，包括有人伪造 ?to= 想往外跳（挡开放重定向）；
//   2. javascript: / data: / blob: 这类协议任何落点都不放行；
//   3. http: 明文放行但门卫页加倍提示；免提示的认定域则直接跳过门卫页。
// 沙箱页是硬例外：它的正文由管理员自持、沙箱已隔离，不再二次改写（见 injectLinks）。

/** 一律不许作为出行目标的协议：伪协议能借链接执行脚本或塞内联内容 */
const BLOCKED_SCHEME_RE = /^[\s\u0000-\u001f]*(javascript|data|blob|vbscript|file)\s*:/i;
/** 绝对地址：http(s) 或协议相对的 //；相对路径不出站，门卫不管 */
const ABS_URL_RE = /^(?:https?:)?\/\//i;

/** 认定表里的域名归一化：吃下整条 URL 也认，只留小写域名；认不出来返回 "" */
function normalizeHost(raw: string): string {
  let s = raw.trim().toLowerCase();
  if (!s) return "";
  if (!/^(?:[a-z][\w+.-]*:\/\/|\/\/)/.test(s)) s = `http://${s}`;
  try {
    const h = new URL(s).hostname.toLowerCase();
    return /^[a-z0-9.-]+$/.test(h) ? h : "";
  } catch {
    return "";
  }
}

/** 目标域名是否被认定：表里写了它本身或它的某个上级域都算 */
function approvedSite(cfg: MatrixConfig, host: string): ApprovedSite | undefined {
  return (cfg.sites ?? []).find(
    (s) => host === s.host || host.endsWith(`.${s.host}`),
  );
}

/** 把一个外站地址包进门卫页：目标与来路都带上，门卫据此查表、也据此写「回哪去」 */
function gateHref(target: string, from: string): string {
  const f = from ? `&from=${encodeURIComponent(from)}` : "";
  return `/${GATE_PATH}?to=${encodeURIComponent(target)}${f}`;
}

/** 认定表收口：域名归一化、去重、截断；脏条目丢掉而不是整份拒（表是渐进长起来的） */
function parseSites(v: unknown): ApprovedSite[] {
  if (!Array.isArray(v)) return [];
  const out: ApprovedSite[] = [];
  const seen = new Set<string>();
  for (const raw of v.slice(0, MAX_SITES)) {
    const o = (raw && typeof raw === "object" ? raw : {}) as {
      host?: unknown;
      note?: unknown;
      skip?: unknown;
    };
    const host = normalizeHost(String(o.host ?? ""));
    if (!host || seen.has(host)) continue;
    seen.add(host);
    const note = String(o.note ?? "").trim().slice(0, 120);
    out.push({ host, note: note || undefined, skip: o.skip === true });
  }
  return out;
}

/** 门卫页的样式：就一页说明，内联进去，不引外部表 */
const GATE_STYLE =
  ".gate-msg{margin:0 0 14px;color:#555;}" +
  ".gate-row{display:flex;gap:8px;text-align:left;font-size:13px;padding:3px 0;}" +
  ".gate-k{flex:0 0 62px;color:#999;}" +
  ".gate-v{flex:1;min-width:0;word-break:break-all;}" +
  ".gate-url{font-family:ui-monospace,Consolas,monospace;font-size:12px;}" +
  ".gate-warn{margin:12px 0 0;color:#c9362c;font-size:12.5px;}" +
  ".gate-go{display:inline-block;padding:7px 18px;background:#111;color:#fff;" +
  "border-radius:8px;text-decoration:none;font-size:14px;}";

/** 门卫页：一页零脚本的说明 + 继续 / 回头两个口子。blocked 有值就是不打算放行 */
function gatePage(opts: {
  to?: string;
  host?: string;
  note?: string;
  from?: string;
  blocked?: string;
}): string {
  const back = opts.from ? `/${opts.from}` : ASSISTANT_PATH;
  const head = opts.blocked ? "这里过不去" : "要离开接待台了";
  const rows = [
    opts.blocked
      ? `<p class="gate-msg">${esc(opts.blocked)}</p>`
      : `<p class="gate-msg">你正要去的是站外地址，它不受接待台管辖。</p>`,
    opts.host
      ? `<div class="gate-row"><span class="gate-k">目标</span>` +
        `<span class="gate-v">${esc(opts.host)}</span></div>`
      : "",
    opts.to
      ? `<div class="gate-row"><span class="gate-k">完整地址</span>` +
        `<span class="gate-v gate-url">${esc(opts.to)}</span></div>`
      : "",
    opts.note
      ? `<div class="gate-row"><span class="gate-k">认定备注</span>` +
        `<span class="gate-v">${esc(opts.note)}</span></div>`
      : "",
    /^http:\/\//i.test(opts.to ?? "")
      ? `<p class="gate-warn">这条是明文 http 连接，内容在路上可能被人看见或改动。</p>`
      : "",
  ].join("");
  const go =
    !opts.blocked && opts.to
      ? `<a class="gate-go" href="${esc(opts.to)}" rel="noopener">继续前往</a>`
      : "";
  return (
    `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>${esc(head)}</title><style>${GATE_STYLE}</style></head>` +
    `<body style="${PAGE_SHELL_STYLE}"><main style="${PAGE_CARD_STYLE}">` +
    `<h1 style="margin:0 0 10px;font-size:18px;">${esc(head)}</h1>` +
    rows +
    `<div style="display:flex;gap:10px;justify-content:center;margin-top:18px;flex-wrap:wrap;">` +
    go +
    `<a href="${esc(back)}" style="color:#555;text-decoration:none;align-self:center;">回到来处</a>` +
    `</div></main></body></html>`
  );
}

/**
 * 门卫页本体：解析 ?to= 与 ?from=，依次过协议闸与认定表，再决定放行方式。
 * 这里也是「目标必须落在认定白名单内」的唯一执行点 —— 白名单之外不生产任何
 * 指向该地址的可点链接，于是伪造 to 也无处可去。
 */
async function serveGate(
  req: Request,
  env: MatrixEnv,
): Promise<Response> {
  const cfg = await loadConfig(env);
  const q = new URL(req.url).searchParams;
  const to = (q.get("to") || "").trim();
  const fromRaw = (q.get("from") || "").trim();
  // 来路只用来写「回到来处」：必须是矩阵路径，否则退回助手（防被拿来当跳板）
  const from = validPath(normPath(`/${fromRaw}`)) ? normPath(`/${fromRaw}`) : "";
  const noStore = { "Cache-Control": "no-store" };

  if (BLOCKED_SCHEME_RE.test(to))
    return html(
      gatePage({
        from,
        blocked: "这个地址用的协议不被允许（javascript / data / blob 之类）。",
      }),
      noStore,
      400,
    );

  const host = normalizeHost(to);
  if (!host || !ABS_URL_RE.test(to))
    return html(
      gatePage({
        from,
        blocked: "只认识 http / https 的完整站外地址，这个看不懂。",
      }),
      noStore,
      400,
    );

  const site = approvedSite(cfg, host);
  if (!site)
    return html(
      gatePage({
        from,
        host,
        to,
        blocked: "这个外站还没被认定，先拦下。要放行就在面板的「外站认定」里加上它。",
      }),
      noStore,
      403,
    );

  // 认定且免提示：不打扰，直接过去
  if (site.skip)
    return new Response(null, {
      status: 302,
      headers: { Location: to, ...noStore },
    });

  return html(gatePage({ from, host, to, note: site.note }), noStore);
}

// ── 验票：进内区前的那道闸 ──────────────────────────────
//
// 矩阵页自己不认身份，只有 access 那四档决定「给不给看」。所以没票的人在门口
// 只会撞上一句「不对你开放」，而矩阵里原本没有任何能拿到票的地方 —— 票是接待台
// 那边发的（见 index.ts 的 /api/auth 与 /api/card/login）。
//
// 这一页把那两个口子搬进矩阵来：验过之后照着 next 原路回去，票就是进门时那张
// cookie，跟从接待台进来完全一样。于是「公开展示区 → 验票 → 内区」这条链才走得通。

/** 验票页的样式：借门卫页那一套（按钮、说明那几笔现成的），再补表单自己的 */
const TICKET_STYLE =
  GATE_STYLE +
  ".tk-r{position:absolute;width:1px;height:1px;opacity:0;pointer-events:none;}" +
  ".tk-tab{display:flex;gap:6px;justify-content:center;margin:0 0 16px;}" +
  ".tk-tab label{padding:5px 12px;border:1px solid #e3e3e6;border-radius:999px;" +
  "font-size:12.5px;color:#555;cursor:pointer;}" +
  "#tk-m1:checked~.tk-tab label[for=tk-m1]," +
  "#tk-m2:checked~.tk-tab label[for=tk-m2]{border-color:#111;color:#111;}" +
  ".tk-in{display:block;width:100%;box-sizing:border-box;margin:0 0 10px;" +
  "padding:9px 12px;border:1px solid #d9d9de;border-radius:8px;font-size:14px;" +
  "background:#fff;color:#111;}" +
  ".tk-in:focus{outline:none;border-color:#111;}" +
  // 昵称那一格只在「身份卡」模式下露出来：两个口子要的东西不一样
  ".tk-name{display:none;}" +
  "#tk-m2:checked~form .tk-name{display:block;}" +
  ".tk-go{display:block;width:100%;padding:9px 0;border:none;border-radius:8px;" +
  "background:#111;color:#fff;font-size:14px;cursor:pointer;}" +
  ".tk-go:disabled{opacity:.55;cursor:default;}" +
  ".tk-err{margin:10px 0 0;color:#c9362c;font-size:12.5px;min-height:17px;}";

/**
 * 验票页：一张白卡片，两个口子（门禁密码 / 身份卡），验过跳 next。
 * 一小段内联脚本，不外链任何东西 —— 跟矩阵页一样，除了验票那一下本身，别的都能离线。
 */
function ticketPage(next: string): string {
  // 嵌进脚本里，所以按 JSON 编码再把 < 挑掉，免得路径里带出 </script>
  const nextJson = JSON.stringify(next).replace(/</g, "\\u003c");
  const script =
    "(function(){var f=document.getElementById('tk-form')," +
    "p=document.getElementById('tk-pw'),n=document.getElementById('tk-name')," +
    "b=document.getElementById('tk-go'),e=document.getElementById('tk-err')," +
    `m1=document.getElementById('tk-m1'),NEXT=${nextJson};` +
    "function post(u,d){return fetch(u,{method:'POST'," +
    "headers:{'Content-Type':'application/json'},body:JSON.stringify(d)})" +
    ".then(function(r){return r.json().catch(function(){return {};});});}" +
    "function rest(){b.disabled=false;b.textContent='进去';}" +
    "f.addEventListener('submit',function(ev){ev.preventDefault();" +
    "e.textContent='';b.disabled=true;b.textContent='验票中…';" +
    "var card=!m1.checked;" +
    "post(card?'/api/card/login':'/api/auth'," +
    "card?{name:n.value,password:p.value}:{pw:p.value})" +
    ".then(function(j){if(j&&j.ok){location.href=NEXT;return;}" +
    "e.textContent=(j&&j.error)||'没验过去，再试一次。';rest();})" +
    ".catch(function(){e.textContent='连不上，检查网络再试。';rest();});});})();";

  return (
    `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>验票</title><style>${TICKET_STYLE}</style></head>` +
    `<body style="${PAGE_SHELL_STYLE}"><main style="${PAGE_CARD_STYLE}">` +
    `<h1 style="margin:0 0 10px;font-size:18px;">验个票再进去</h1>` +
    `<p class="gate-msg">里面那几页要先认一下人。验过之后照原路回去。</p>` +
    `<input class="tk-r" type="radio" name="tk-m" id="tk-m1" checked>` +
    `<input class="tk-r" type="radio" name="tk-m" id="tk-m2">` +
    `<div class="tk-tab">` +
    `<label for="tk-m1">门禁密码</label><label for="tk-m2">身份卡</label>` +
    `</div>` +
    `<form id="tk-form">` +
    `<input class="tk-in tk-name" id="tk-name" autocomplete="username" ` +
    `placeholder="昵称（身份卡上写着的）">` +
    `<input class="tk-in" id="tk-pw" type="password" ` +
    `autocomplete="current-password" placeholder="密码">` +
    `<button class="tk-go" id="tk-go" type="submit">进去</button>` +
    `<p class="tk-err" id="tk-err"></p>` +
    `</form>` +
    `<p style="margin:14px 0 0;font-size:13px;">` +
    `<a href="${ASSISTANT_PATH}" style="color:#555;text-decoration:none;">回助手</a>` +
    `</p></main>` +
    `<script>${script}</script>` +
    `</body></html>`
  );
}

/**
 * 不验票时该去哪：矩阵的**能出正文的**入口页，没有就回助手。
 * 入口页也可能是门卫/助手/功能块这几类 —— 它们自己不出正文、站上去还会再把人
 * 送去 /_ticket。要是照旧返回它，验完票落到它头上又被弹回验票页，来回死循环。
 * 所以只认 kind=page 的入口页（老配置缺 kind 一律按 page 算）。
 */
function defaultNextPath(cfg: MatrixConfig): string {
  const entry = cfg.pages.find(
    (p) => p.entry && !p.external && p.path && parseKind(p.kind) === "page",
  );
  return entry ? `/${entry.path}` : ASSISTANT_PATH;
}

/**
 * 门卫验完去哪：它的第一条出边指向的那一页（按 order 排）。
 * 只挑「网页」那一类：指向另一个门卫等于让人再验一次，转圈；
 * 指向外站页也不行 —— 那条路径本身不出正文。挑不出来就交给调用方兜底。
 */
function firstTargetPath(cfg: MatrixConfig, gate: MatrixPage): string | null {
  const outs = cfg.links
    .filter((l) => l.from === gate.id)
    .sort((a, b) => a.order - b.order || a.label.localeCompare(b.label));
  for (const l of outs) {
    const t = cfg.pages.find((p) => p.id === l.to);
    if (t && t.kind !== "gate" && !t.external && t.path) return t.path;
  }
  return null;
}

/**
 * 验票页本体。next 只收矩阵自己的路径（validPath 那套文法：站内相对、合法段、
 * 不占保留字）—— 不这样收，这一页就成了一条开放跳转。
 */
async function serveTicket(
  req: Request,
  env: MatrixEnv,
  viewer: MatrixViewer,
): Promise<Response> {
  const cfg = await loadConfig(env);
  const raw = (new URL(req.url).searchParams.get("next") || "").trim();
  const clean = normPath(`/${raw}`);
  const next = validPath(clean) ? `/${clean}` : defaultNextPath(cfg);
  const noStore = { "Cache-Control": "no-store" };

  // 已经有票了就别再拦：他点两次「去验票」不该卡在这儿来回转
  if (viewer.role !== "public")
    return new Response(null, {
      status: 302,
      headers: { Location: next, ...noStore },
    });

  return html(ticketPage(next), noStore);
}

/**
 * 没票的人撞上「不开放」的那一页：给他一条路，而不是一堵墙。
 * 有票但档位不够的别再引他去验票 —— 他已经有票了，再验一次只会原地转圈。
 */
function closedPage(viewer: MatrixViewer, path: string): string {
  if (viewer.role !== "public")
    return staticPage(
      "这一页不向你开放",
      "当前身份进不去这一页。换个入口，或回接待台继续。",
    );
  const to = `/${TICKET_PATH}?next=${encodeURIComponent(path)}`;
  return (
    `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>先验票</title><style>${GATE_STYLE}</style></head>` +
    `<body style="${PAGE_SHELL_STYLE}"><main style="${PAGE_CARD_STYLE}">` +
    `<h1 style="margin:0 0 10px;font-size:18px;">这一页要验票</h1>` +
    `<p style="margin:0 0 18px;color:#555;">认一下人，这一页才开给你。</p>` +
    `<a class="gate-go" href="${esc(to)}">去验票</a>` +
    `<p style="margin:16px 0 0;font-size:13px;">` +
    `<a href="${ASSISTANT_PATH}" style="color:#0b6bcb;text-decoration:none;">回助手</a>` +
    `</p></main></body></html>`
  );
}

// ── 通路注入 ────────────────────────────────────────────

/** 正则字面量转义：锚点名是管理员填的，可能带正则元字符 */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 把一个命名锚点（正文里形如 <div id="north"></div> 的空元素）替换成
 * 带内容的同名元素。找不到返回 null，交给调用方降级到兜底栏。
 * 只认空元素：已有内容的 id 元素不碰，免得把正文占位符覆盖掉。
 */
function fillAnchor(htmlText: string, name: string, content: string): string | null {
  // \s 锚定 id 前必有空白，避开 data-id 这类同后缀属性的误命中；
  // \2 回指标签名，保证闭合标签与开标签同名
  const re = new RegExp(
    `(<([a-zA-Z][\\w-]*)\\b[^>]*\\sid\\s*=\\s*["']${escapeRe(name)}["'][^>]*>)\\s*</\\2>`,
    "i",
  );
  const m = re.exec(htmlText);
  if (!m) return null;
  return (
    htmlText.slice(0, m.index) +
    m[1] +
    content +
    `</${m[2]}>` +
    htmlText.slice(m.index + m[0].length)
  );
}

/** 把一段 HTML 贴在 </body> 前；没有 body 就贴到末尾 */
function injectBeforeBodyEnd(htmlText: string, snippet: string): string {
  if (!snippet) return htmlText;
  const m = /<\/body\s*>/i.exec(htmlText);
  if (m) return htmlText.slice(0, m.index) + snippet + htmlText.slice(m.index);
  return htmlText + snippet;
}

/**
 * 兜底栏：贴在 </body> 前；没有 body 就贴到末尾。零脚本，只有链接。
 * 带 id 是为了让设计器在页面里认得出这撮按钮。
 */
function injectFallbackNav(htmlText: string, items: string[]): string {
  if (!items.length) return htmlText;
  const nav =
    `<nav id="mx-fallback-nav" class="mx-fallback-nav">` +
    `<div class="mx-fallback-label">通路</div>` +
    `<div class="mx-fallback-group">${items.join("")}</div>` +
    `</nav>`;
  return injectBeforeBodyEnd(htmlText, nav);
}

/**
 * 把这一页的出边渲染成按钮注入正文。
 * 按钮是「矩阵的功能」不是页面内容，所以连线存在矩阵配置里，渲染时才拼进去。
 * 落点三选一：命名锚点填进正文、兜底栏贴在末尾、拖拽点绝对定位到整页坐标。
 * 每个按钮都带 data-mx-from / data-mx-to —— 设计器的预览器据此在页面里找到它、
 * 量出它此刻落在哪，才好在同一张图上拖着改。没出边原样返回，也从不因脏数据抛错。
 */
function injectLinks(
  htmlText: string,
  page: MatrixPage,
  cfg: MatrixConfig,
  viewer: MatrixViewer,
): string {
  // 同一处按 order 升序、再按 label 排，保证每次渲染顺序稳定
  const out = cfg.links
    .filter((l) => l.from === page.id)
    .sort((a, b) => a.order - b.order || a.label.localeCompare(b.label));
  if (!out.length) return htmlText;

  // 绝对定位的百分比按最近定位祖先解析。正文里没有 body 就没有可用的画布，
  // 拖拽落点只能降级进兜底栏 —— 先判定一次，好按它决定按钮怎么写。
  const hasBody = /<body[^>]*>/i.test(htmlText);

  // 只渲染访客有权进入的目标：跟外挂层一个口径，别在大厅里就把管理员房间抖出来
  const rendered: { link: MatrixLink; isPoint: boolean; html: string }[] = [];
  for (const l of out) {
    const t = cfg.pages.find((p) => p.id === l.to);
    if (!t || !allowed(t, viewer)) continue;
    const label = esc(l.label);
    const tag = ` data-mx-from="${esc(l.from)}" data-mx-to="${esc(l.to)}"`;
    // 外站目标一律经门卫页；伪协议（javascript: 之类）连链接都不给 —— 只留一截说明
    const isBad = !!t.external && BLOCKED_SCHEME_RE.test(t.external);
    const href = isBad
      ? ``
      : t.external
        ? `href="${esc(gateHref(t.external, page.path))}"`
        : `href="/${esc(t.path)}"`;
    const isPoint = l.place.kind === "point" && hasBody;
    // 定位只剩 left/top 两个数（落点数据本身），其余长相都归 .mx-point / .mx-btn
    const style = isPoint
      ? ` style="left:${l.place.kind === "point" ? l.place.x : 50}%;` +
        `top:${l.place.kind === "point" ? l.place.y : 50}%"`
      : "";
    const html = isBad
      ? `<span class="mx-btn mx-dead"${tag}>${label}（地址不被允许）</span>`
      : `<a class="${isPoint ? "mx-btn mx-point" : "mx-btn"}"${tag} ${href}${style}>${label}</a>`;
    rendered.push({ link: l, isPoint, html });
  }
  if (!rendered.length) return htmlText;

  // 按落点分组：命名锚点各自一组待填，其余进兜底
  const anchorGroups = new Map<string, string[]>();
  for (const { link, html, isPoint } of rendered)
    if (!isPoint && link.place.kind === "anchor") {
      const arr = anchorGroups.get(link.place.name) ?? [];
      arr.push(html);
      anchorGroups.set(link.place.name, arr);
    }

  let result = htmlText;
  const missed = new Set<string>(); // 正文里找不到的锚点名 → 其按钮降级到兜底栏
  for (const [name, items] of anchorGroups) {
    const filled = fillAnchor(result, name, items.join(""));
    if (filled === null) missed.add(name);
    else result = filled;
  }

  // 兜底按钮保持出边本来的排序：命中的锚点不重复出现，没命中的降级进来
  const fallback = rendered
    .filter(
      ({ link, isPoint }) =>
        !isPoint &&
        (link.place.kind === "anchor" ? missed.has(link.place.name) : true),
    )
    .map(({ html }) => html);

  let out2 = injectFallbackNav(result, fallback);

  // 拖拽落点：把这撮按钮绝对定位到整页坐标（百分比）。
  // 定位祖先得是「铺满整页」的那一层，且原点在页顶 —— 于是选 html，给它一屏的
  // 最小高：短页也撑到一屏，长页本来就是内容高。
  // 不用 body：它是内容高（短页只有几十像素），百分比会被压进顶部一小条；它还
  // 自带 8px 外边距，原点对不上。不用初始包含块（视口）：长页面全挤在首屏。
  // 没有 body 时 isPoint 已是 false，它们自然落进上面的兜底栏，无处安放就算了。
  const points = rendered.filter((r) => r.isPoint);
  if (points.length) {
    out2 = injectAfterBody(
      out2,
      "<style>html{position:relative;min-height:100vh;}</style>",
    );
    out2 = injectBeforeBodyEnd(out2, points.map((p) => p.html).join(""));
  }
  return out2;
}

/**
 * 正文里手写的绝对外链：扫出来改写成经门卫页，相对路径 / 锚点 / 站内链接不碰。
 * 只认 <a href="…">，不碰 <img>/<script>/<iframe> —— 门卫管的是「人往站外走」这件事。
 * 沙箱页是硬例外，调用方按 page.sandbox 跳过（沙箱已隔离，再改写会动到页面自己的逻辑）。
 */
const A_HREF_RE = /(<a\b[^>]*?\shref\s*=\s*)"([^"]*)"|(<a\b[^>]*?\shref\s*=\s*)'([^']*)'/gi;

function rewriteOutboundLinks(htmlText: string, fromPath: string): string {
  return htmlText.replace(
    A_HREF_RE,
    (_m, lead1: string | undefined, dq: string | undefined, lead2: string | undefined, sq: string | undefined) => {
      const lead = lead1 ?? lead2 ?? "";
      const url = (dq ?? sq ?? "").trim();
      // 相对路径不出站；伪协议不由门卫管，原样交回页面
      if (!ABS_URL_RE.test(url) || BLOCKED_SCHEME_RE.test(url))
        return lead + (lead1 !== undefined ? `"${dq}"` : `'${sq}'`);
      return `${lead}"${esc(gateHref(url, fromPath))}"`;
    },
  );
}

// ── 页面直吐 ────────────────────────────────────────────

const SANDBOX_CSP =
  "sandbox allow-scripts allow-forms allow-popups allow-top-navigation-by-user-activation";

async function servePage(
  req: Request,
  env: MatrixEnv,
  viewer: MatrixViewer,
  pathname: string,
): Promise<Response | null> {
  const cfg = await loadConfig(env);
  const path = normPath(pathname);

  // 根路径：公开访客去入口页（没有入口页就回落接待台）；登录用户与管理员照常回接待台
  if (path === "") {
    if (viewer.role === "public") {
      const entry = cfg.pages.find((p) => p.entry && !p.external && p.path);
      // Location 用相对路径：由浏览器按访客真正访问的主域名解析，才是该去的地方
      if (entry)
        return new Response(null, {
          status: 302,
          headers: { Location: `/${entry.path}`, "Cache-Control": "no-store" },
        });
    }
    return null;
  }

  const page = cfg.pages.find((p) => !p.external && p.path === path);
  if (!page) return null;

  // 进不去：没票的人给一条「去验票」的路，有票但档位不够的如实说
  if (!allowed(page, viewer))
    return html(closedPage(viewer, path), { "Cache-Control": "no-store" });

  // 门卫：自己不出正文，站到它就把人送去验票 —— 验完去它的第一条出边。
  // 挑不出出边就不带 next，让验票页自己兜底（落到入口页 / 助手）
  if (page.kind === "gate") {
    const to = firstTargetPath(cfg, page);
    return new Response(null, {
      status: 302,
      headers: {
        Location: `/${TICKET_PATH}${to ? `?next=${encodeURIComponent(to)}` : ""}`,
        "Cache-Control": "no-store",
      },
    });
  }

  // 助手：这一格就是接待台本体，把人送过去
  if (page.kind === "assistant")
    return new Response(null, {
      status: 302,
      headers: { Location: ASSISTANT_PATH, "Cache-Control": "no-store" },
    });

  // 功能块：内建处理单元还没接上，如实说一句，别装作有内容
  if (page.kind === "app")
    return html(
      staticPage(
        "这一格还没接上",
        "功能块还没实作。先在面板里把它改成网页或门卫。",
      ),
      { "Cache-Control": "no-store" },
    );

  // 正文：引用云盘文件就实时去读它（那边改了页面跟着变），否则读本页那份
  const obj = env.MEMORY_BUCKET
    ? await env.MEMORY_BUCKET.get(page.driveKey || bodyKey(page.id))
    : null;
  if (!obj)
    return html(
      staticPage(
        page.driveKey ? "引用的文件不见了" : "页面正文缺失",
        page.driveKey
          ? "这一页引用的云盘文件已被删除或移动，页面暂时没有正文。"
          : "这一页还没有正文，或正文已被移除。",
      ),
      { "Cache-Control": "no-store" },
    );
  // 引用的文件体积不受本页约束：超上限就不吐，免得把一整个大文件拉进内存
  if (obj.size > MAX_BODY_BYTES)
    return html(
      staticPage("正文过大", "这一页的正文超过 2MB 上限，先用别的来源。"),
      { "Cache-Control": "no-store" },
    );

  // 外挂层的样式先进 <head>：注入物全是 class，长相靠这一段 token 说话
  let source = await obj.text();
  // 正文里手写的绝对外链先改道门卫页（沙箱页是硬例外，不改写）
  if (!page.sandbox) source = rewriteOutboundLinks(source, page.path);
  let withStyle = injectIntoHead(source, buildStyle(cfg.theme ?? DEFAULT_THEME));
  // 本页 CSS 紧跟其后：同在后段，天然压过默认值；且只注这一页，不越界。
  if (page.css)
    withStyle = injectIntoHead(withStyle, `<style id="mx-page-css">${page.css}</style>`);
  // 再注通路、最后注悬浮菜单：菜单插在 <body> 后，通路栏贴在 </body> 前，
  // 各管一头互不干扰；通路注入早做，锚点搜索也就扫不到菜单自己
  const withLinks = injectLinks(withStyle, page, cfg, viewer);
  const body = injectAfterBody(withLinks, buildNav(viewer, cfg, page.path));
  return html(body, page.sandbox ? { "Content-Security-Policy": SANDBOX_CSP } : {});
}

// ── 管理 API（管理员经主包转发）───────────────────────────

function badRequest(msg: string): Response {
  return json({ ok: false, error: msg }, 400);
}

function validPath(path: string): boolean {
  if (!PATH_RE.test(path)) return false;
  const first = path.split("/")[0];
  return !RESERVED_FIRST.has(first) && !first.includes(".");
}

interface SaveMeta {
  id?: unknown;
  path?: unknown;
  title?: unknown;
  kind?: unknown;
  access?: unknown;
  types?: unknown;
  sandbox?: unknown;
  entry?: unknown;
  external?: unknown;
  css?: unknown;
}

function parseAccess(v: unknown): Access {
  return v === "visitor" || v === "admin" || v === "types" ? v : "public";
}

/** 节点类型收口：认不出来的（含老配置的 undefined）一律当普通网页 */
function parseKind(v: unknown): MatrixNodeKind {
  return v === "gate" || v === "assistant" || v === "app" ? v : "page";
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/**
 * 落点解析：只认三种 kind，其余一律降级成兜底栏。
 * 对外可写接口，脏数据不能让它抛错，也不能把按钮送到不可预期的地方。
 */
function parsePlace(v: unknown): LinkPlace {
  if (v && typeof v === "object") {
    const o = v as { kind?: unknown; name?: unknown; x?: unknown; y?: unknown };
    if (o.kind === "anchor" && typeof o.name === "string" && o.name.trim())
      return { kind: "anchor", name: o.name.trim().slice(0, 80) };
    if (o.kind === "point") {
      const x = Number(o.x);
      const y = Number(o.y);
      // 坐标非数字当没填，降级兜底；是数字就夹进百分比区间
      if (Number.isFinite(x) && Number.isFinite(y))
        return { kind: "point", x: clamp(x, 0, 100), y: clamp(y, 0, 100) };
    }
  }
  return { kind: "auto" };
}

/** 保存一页的入参：正文三选一（file / text / key），外站页则填 external */
export interface MatrixSaveInput {
  id?: string;
  path?: string;
  title?: string;
  /** 节点类型，缺省 page */
  kind?: string;
  access?: string;
  types?: unknown;
  sandbox?: boolean;
  entry?: boolean;
  external?: string;
  css?: unknown;
  /** 正文来源三选一 */
  file?: File;
  text?: string;
  key?: string;
}

/** 入参不合规：抛出后由调用方翻成 400 / 一句人话 */
export class MatrixInputError extends Error {}

/**
 * 保存一页（新建或整页覆盖）。管理面 FormData 与 AI 工具共用这一份逻辑 ——
 * 两边同一套收口，不存在「走工具就能绕过校验」的口子。
 */
export async function savePageCore(
  env: MatrixEnv,
  input: MatrixSaveInput,
): Promise<MatrixPage> {
  const path = normPath(String(input.path ?? ""));
  if (!validPath(path))
    throw new MatrixInputError(
      "路径不合法：最多 3 段，每段只含小写字母/数字/-/_，且不能占用 api、agents、assets、index、assistant",
    );
  const title = String(input.title ?? "").slice(0, 80);
  const external = String(input.external ?? "").trim();
  const cfg = await loadConfig(env);

  const id = typeof input.id === "string" && input.id ? input.id : newId();
  // id 要直接拼进 R2 key（matrix/page/<id>.html），跟解包同一把尺：只认小写字母与数字。
  // 不卡的话，管理面带个 `/` 的 id 就能把正文写到桶里别处，导出的包还会因「嵌套
  // 目录」被解包丢掉正文 —— 存得进、却装不回来
  if (!PACK_ID_RE.test(id))
    throw new MatrixInputError("页面 id 不合法（只认小写字母与数字，最长 32 位）");
  const existing = cfg.pages.find((p) => p.id === id);
  // 路径唯一：别的页占了这条路径就不给（外站链接也占位，避免导航里两条同名）
  if (cfg.pages.some((p) => p.id !== id && p.path === path))
    throw new MatrixInputError(`路径 /${path} 已被占用`);

  // 改一页时不带 kind 就沿用旧的：免得只改了标题，门卫悄悄变回网页
  const kind = parseKind(input.kind ?? existing?.kind);
  const access = parseAccess(input.access);
  const sandbox = input.sandbox === true;
  const entry = input.entry === true;
  // 只有「网页」这一种才谈得上正文、外链、页级 CSS —— 门卫/助手/功能块自己不出内容
  const isPage = kind === "page";

  // 本页 CSS：过收口，脏写法当场打回，不写进记录
  const css = parseCss(input.css);

  const page: MatrixPage = {
    id,
    path,
    title,
    kind,
    access: entry ? "public" : access,
    types:
      access === "types" && Array.isArray(input.types)
        ? input.types.map((t) => String(t)).filter(Boolean).slice(0, 50)
        : undefined,
    // 入口页必须公开且不许勾沙箱：它是所有人的门面，不能自己把自己挡在门外。
    // 非网页类型也没有可沙箱的正文
    sandbox: entry || !isPage ? false : sandbox,
    entry,
    external: isPage ? external || undefined : undefined,
    css: isPage ? css : undefined,
    updatedAt: Date.now(),
  };

  // 正文：外站链接不出正文；否则按 上传文件 / 粘贴文本 / 引用云盘文件 三选一。
  // 「引用云盘文件」不拷贝正文，只记下 key —— 那边改了页面跟着变（见 servePage）。
  // 门卫/助手/功能块不进这一段：它们本来就没有正文
  if (isPage && !page.external) {
    const file = input.file;
    const text = input.text;
    const driveKey = input.key;
    if (file instanceof File) {
      if (file.size > MAX_BODY_BYTES)
        throw new MatrixInputError("正文过大（上限 2MB）");
      await env.MEMORY_BUCKET.put(bodyKey(id), await file.text(), {
        httpMetadata: { contentType: "text/html; charset=utf-8" },
      });
      page.driveKey = undefined;
    } else if (typeof text === "string" && text) {
      if (text.length > MAX_BODY_BYTES)
        throw new MatrixInputError("正文过大（上限 2MB）");
      await env.MEMORY_BUCKET.put(bodyKey(id), text, {
        httpMetadata: { contentType: "text/html; charset=utf-8" },
      });
      page.driveKey = undefined;
    } else if (typeof driveKey === "string" && driveKey) {
      const src = await env.MEMORY_BUCKET.head(driveKey);
      if (!src) throw new MatrixInputError("云盘里找不到这个文件");
      if (src.size > MAX_BODY_BYTES)
        throw new MatrixInputError("引用的文件过大（上限 2MB）");
      // 改成引用之后本页原来那份正文就没用了：清掉，免得留下没人认领的副本
      try {
        await env.MEMORY_BUCKET.delete(bodyKey(id));
      } catch {
        // 孤儿正文不影响使用，留给后续清理
      }
      page.driveKey = driveKey;
    } else if (existing) {
      // 没有新正文，沿用旧的：正文与引用关系原样带过来
      page.driveKey = existing.driveKey;
    } else {
      throw new MatrixInputError("缺少页面正文（上传 / 粘贴 / 引用云盘文件 / 填外链）");
    }
  } else if (!isPage && existing) {
    // 从网页改成门卫/助手/功能块：原来那份正文没人认了，顺手清掉
    try {
      await env.MEMORY_BUCKET.delete(bodyKey(id));
    } catch {
      // 孤儿正文不影响使用，留给后续清理
    }
  }

  // 入口唯一：这篇当了入口，别的都不再是
  if (entry) for (const p of cfg.pages) if (p.id !== id) p.entry = false;

  const idx = cfg.pages.findIndex((p) => p.id === id);
  if (idx >= 0) cfg.pages[idx] = page;
  else cfg.pages.push(page);
  await saveConfig(env, cfg);
  return page;
}

async function handleSave(req: Request, env: MatrixEnv): Promise<Response> {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return badRequest("请求格式错误");
  }
  const metaRaw = form.get("meta");
  if (typeof metaRaw !== "string") return badRequest("缺少 meta");
  let meta: SaveMeta;
  try {
    meta = JSON.parse(metaRaw) as SaveMeta;
  } catch {
    return badRequest("meta 不是合法 JSON");
  }

  const file = form.get("file");
  const text = form.get("text");
  const key = form.get("key");
  try {
    const page = await savePageCore(env, {
      id: typeof meta.id === "string" ? meta.id : undefined,
      path: String(meta.path ?? ""),
      title: String(meta.title ?? ""),
      kind: typeof meta.kind === "string" ? meta.kind : undefined,
      access: typeof meta.access === "string" ? meta.access : undefined,
      types: meta.types,
      sandbox: meta.sandbox === true,
      entry: meta.entry === true,
      external: String(meta.external ?? ""),
      css: meta.css,
      file: file instanceof File ? file : undefined,
      text: typeof text === "string" ? text : undefined,
      key: typeof key === "string" ? key : undefined,
    });
    return json({ ok: true, data: { page } });
  } catch (e) {
    if (e instanceof MatrixInputError) return badRequest(e.message);
    throw e;
  }
}

async function handleDelete(req: Request, env: MatrixEnv): Promise<Response> {
  let body: { id?: unknown };
  try {
    body = (await req.json()) as { id?: unknown };
  } catch {
    return badRequest("请求格式错误");
  }
  const id = typeof body.id === "string" ? body.id : "";
  if (!id) return badRequest("缺少 id");
  const cfg = await loadConfig(env);
  const idx = cfg.pages.findIndex((p) => p.id === id);
  if (idx < 0) return badRequest("找不到这一页");
  cfg.pages.splice(idx, 1);
  // 页面没了，指进/指出它的通路也一并清掉，别留下指不到任何页的断头边
  cfg.links = cfg.links.filter((l) => l.from !== id && l.to !== id);
  // 先删记录再删正文：正文删失败顶多留个孤儿对象，不会出现「有记录没正文」
  await saveConfig(env, cfg);
  try {
    await env.MEMORY_BUCKET.delete(bodyKey(id));
  } catch {
    // 孤儿正文不影响使用，留给后续清理
  }
  return json({ ok: true, data: { id } });
}

/**
 * 建/改一条通路（按 (from,to) 这对 upsert，同一对只留一条）。
 * 管理面与工具共用这一份逻辑；参数不合规抛 MatrixInputError。
 */
export async function matrixSaveLink(
  env: MatrixEnv,
  input: {
    from: string;
    to: string;
    label?: unknown;
    place?: unknown;
    order?: unknown;
  },
): Promise<MatrixLink> {
  const { from, to } = input;
  const cfg = await loadConfig(env);
  const fromPage = cfg.pages.find((p) => p.id === from);
  const toPage = cfg.pages.find((p) => p.id === to);
  if (!fromPage) throw new MatrixInputError("起点页面不存在");
  if (!toPage) throw new MatrixInputError("终点页面不存在");
  if (from === to) throw new MatrixInputError("不允许自环（起点与终点不能是同一页）");
  // 外链页没有本地正文，挂不了按钮：它只能当终点，不能当起点
  if (fromPage.external) throw new MatrixInputError("外链页没有本地正文，挂不了按钮");

  const existing = cfg.links.find((l) => l.from === from && l.to === to);
  // 上限只在新建时卡：改已有的一条不该被总量挡住
  if (!existing && cfg.links.length >= MAX_LINKS)
    throw new MatrixInputError(`通路数量已达上限（${MAX_LINKS} 条）`);

  // 文字去空白截断；空则回落到目标页标题，再空回落到目标页路径
  const label =
    String(input.label ?? "").trim().slice(0, 40) || toPage.title || toPage.path;
  const orderRaw = Number(input.order);
  const link: MatrixLink = {
    from,
    to,
    label,
    place: parsePlace(input.place),
    order: Number.isFinite(orderRaw) ? orderRaw : 0,
  };

  if (existing) Object.assign(existing, link);
  else cfg.links.push(link);
  await saveConfig(env, cfg);
  return link;
}

/** 建/改一条通路：管理面的薄壳，把不合规翻成 400 */
async function handleLink(req: Request, env: MatrixEnv): Promise<Response> {
  let body: {
    from?: unknown;
    to?: unknown;
    label?: unknown;
    place?: unknown;
    order?: unknown;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return badRequest("请求格式错误");
  }
  try {
    const link = await matrixSaveLink(env, {
      from: typeof body.from === "string" ? body.from : "",
      to: typeof body.to === "string" ? body.to : "",
      label: body.label,
      place: body.place,
      order: body.order,
    });
    return json({ ok: true, data: { link } });
  } catch (e) {
    if (e instanceof MatrixInputError) return badRequest(e.message);
    throw e;
  }
}

/** 删一条通路：按 (from,to) 这对删，不存在也算成功（幂等） */
async function handleUnlink(req: Request, env: MatrixEnv): Promise<Response> {
  let body: { from?: unknown; to?: unknown };
  try {
    body = (await req.json()) as { from?: unknown; to?: unknown };
  } catch {
    return badRequest("请求格式错误");
  }
  const from = typeof body.from === "string" ? body.from : "";
  const to = typeof body.to === "string" ? body.to : "";
  const cfg = await loadConfig(env);
  const before = cfg.links.length;
  cfg.links = cfg.links.filter((l) => !(l.from === from && l.to === to));
  if (cfg.links.length !== before) await saveConfig(env, cfg);
  return json({ ok: true });
}

// ── 矩阵包：封包 / 解包 / 装备 ────────────────────────────

function packError(msg: string): Error {
  return new Error(`矩阵包不对：${msg}`);
}

/**
 * 把包里那份配置收口成可信的 MatrixConfig。
 * 包来自外部，每个字段都得重新过尺 —— 保存一页用哪套规矩，这里就用哪套。
 */
function cleanPackedConfig(raw: unknown): {
  cfg: MatrixConfig;
  droppedLinks: number;
  droppedSites: number;
} {
  const o = (raw ?? {}) as {
    pages?: unknown;
    links?: unknown;
    nav?: unknown;
    theme?: unknown;
    sites?: unknown;
  };
  if (!Array.isArray(o.pages)) throw packError("清单里没有 pages");

  const pages: MatrixPage[] = [];
  const seenId = new Set<string>();
  const seenPath = new Set<string>();
  for (const rawPage of o.pages) {
    const p = (rawPage ?? {}) as Record<string, unknown>;
    const id = String(p.id ?? "");
    if (!PACK_ID_RE.test(id))
      throw packError(`页面 id 不合法：${id || "(空)"}（只认小写字母与数字）`);
    if (seenId.has(id)) throw packError(`页面 id 重复：${id}`);
    const path = normPath(String(p.path ?? ""));
    if (!validPath(path))
      throw packError(`页面 ${id} 的路径不合法：${path || "(空)"}`);
    if (seenPath.has(path)) throw packError(`路径重复：/${path}`);
    seenId.add(id);
    seenPath.add(path);

    let css: string | undefined;
    try {
      css = parseCss(p.css);
    } catch (e) {
      throw packError(`页面 ${id} 的样式有问题：${(e as Error).message}`);
    }

    const entry = p.entry === true;
    const access = parseAccess(p.access);
    const kind = parseKind(p.kind);
    pages.push({
      id,
      path,
      title: String(p.title ?? "").slice(0, 80),
      kind,
      access: entry ? "public" : access,
      types:
        access === "types" && Array.isArray(p.types)
          ? p.types.map((t) => String(t)).filter(Boolean).slice(0, 50)
          : undefined,
      // 入口页必须公开且不勾沙箱：它是所有人的门面（与保存一页同一套规矩）；
      // 非网页类型没有正文，也就没有外链 / 页级 CSS / 沙箱可言
      sandbox: entry || kind !== "page" ? false : p.sandbox === true,
      entry,
      external:
        kind === "page"
          ? String(p.external ?? "").trim() || undefined
          : undefined,
      css: kind === "page" ? css : undefined,
      // 引用云盘文件的页照旧引用：矩阵复用云盘那只桶，装到别处这套引用仍然读得到
      driveKey:
        typeof p.driveKey === "string" && p.driveKey ? p.driveKey : undefined,
      updatedAt: Date.now(),
    });
  }
  if (pages.filter((p) => p.entry).length > 1)
    throw packError("包里有不止一个入口页，最多只能有一个");

  // 连线：指向不在包里的页面就丢掉 —— 悬空的连线只会把图撕裂。丢了几条如实报上去
  const ids = new Set(pages.map((p) => p.id));
  const links: MatrixLink[] = [];
  let droppedLinks = 0;
  for (const rawLink of Array.isArray(o.links) ? o.links : []) {
    const l = (rawLink ?? {}) as Record<string, unknown>;
    const from = String(l.from ?? "");
    const to = String(l.to ?? "");
    if (!ids.has(from) || !ids.has(to) || links.length >= MAX_LINKS) {
      droppedLinks++;
      continue;
    }
    links.push({
      from,
      to,
      label: String(l.label ?? "").slice(0, 40),
      place: parsePlace(l.place),
      order: Number(l.order) || 0,
    });
  }

  const nav = o.nav as NavConfig | undefined;
  // 外站认定超限也如实报（和连线一个口径：丢了多少说多少，不静默截断）
  const sites = parseSites(o.sites);
  return {
    cfg: {
      rev: 0,
      pages,
      links,
      nav:
        nav && typeof nav.on === "boolean" ? { on: nav.on } : { ...DEFAULT_NAV },
      theme: parseTheme(o.theme),
      sites: sites.slice(0, MAX_SITES),
    },
    droppedLinks,
    droppedSites: Math.max(0, sites.length - MAX_SITES),
  };
}

/** zip 字节 -> 配置 + 正文。任何不合规当场抛人话错误，一个字节都还没落 */
function unpackMatrixPack(bytes: Uint8Array): {
  cfg: MatrixConfig;
  bodies: Map<string, Uint8Array>;
  droppedLinks: number;
  droppedSites: number;
} {
  let entries: Record<string, Uint8Array>;
  // unzipSync 是先全量解压进内存的：高压缩比的包等解完再查大小就晚了。
  // filter 回调拿得到 zip 目录里声明的原始大小，解压前先按声明值拦一道
  // （声明值可能谎报，所以下面正文那步仍按解出来的实际字节再兜一道）
  let over: string | null = null;
  let count = 0;
  let declaredTotal = 0;
  try {
    entries = unzipSync(bytes, {
      filter: (file) => {
        count += 1;
        if (count > MAX_PACK_ENTRIES) {
          over ??= `包里条目数超过上限（${MAX_PACK_ENTRIES} 个），包不老实`;
          return false;
        }
        const isManifest =
          file.name === PACK_MANIFEST ||
          file.name.endsWith("/" + PACK_MANIFEST);
        const single = isManifest
          ? MAX_PACK_MANIFEST_BYTES
          : MAX_PACK_FILE_BYTES;
        if (file.originalSize > single) {
          over ??= isManifest
            ? `清单超过单条上限（${MAX_PACK_MANIFEST_BYTES >> 10}KB），包不老实`
            : `条目 ${file.name} 超过单文件上限（${MAX_PACK_FILE_BYTES >> 20}MB），包不老实`;
          return false;
        }
        declaredTotal += file.originalSize;
        if (declaredTotal > MAX_PACK_TOTAL_BYTES) {
          over ??= `条目解出来超过总量上限（${MAX_PACK_TOTAL_BYTES >> 20}MB），包不老实`;
          return false;
        }
        return true;
      },
    });
  } catch {
    throw packError("这不是一个能解开的 zip 压缩包");
  }
  // 拦下的条目不让它解出来，理由在这里补抛 —— filter 只能回 true/false
  if (over) throw packError(over);

  const manifestKey = Object.keys(entries).find(
    (k) => k === PACK_MANIFEST || k.endsWith("/" + PACK_MANIFEST),
  );
  if (!manifestKey) throw packError(`包里没有 ${PACK_MANIFEST} 清单`);
  let raw: { format?: unknown; version?: unknown; config?: unknown };
  try {
    raw = JSON.parse(strFromU8(entries[manifestKey])) as typeof raw;
  } catch {
    throw packError(`${PACK_MANIFEST} 不是合法的 JSON`);
  }
  if (raw.format !== PACK_FORMAT)
    throw packError(`不是矩阵包（format 要是 ${PACK_FORMAT}）`);
  const version = Number(raw.version);
  if (!Number.isFinite(version) || version > PACK_VERSION)
    throw packError(`版本太新（本机只认 v${PACK_VERSION} 及以下）`);

  const { cfg, droppedLinks, droppedSites } = cleanPackedConfig(raw.config);

  // 正文：只认 pages/ 一层，id 还得对得上清单里的页面
  const bodies = new Map<string, Uint8Array>();
  const known = new Set(cfg.pages.map((p) => p.id));
  for (const [path, data] of Object.entries(entries)) {
    if (!path.startsWith(PACK_PAGE_DIR)) continue;
    const name = path.slice(PACK_PAGE_DIR.length);
    if (name.includes("/") || name.includes("\\")) continue; // 不许再往下一层
    const id = name.replace(/\.html$/i, "");
    if (!known.has(id)) continue; // 清单里没有这一页，正文不认领
    if (data.byteLength > MAX_BODY_BYTES)
      throw packError(`页面 ${id} 的正文超过上限（2MB）`);
    bodies.set(id, data);
  }

  // 有页无文：外站页与引用云盘文件的页本就不带正文，其余缺了就是残包
  const missing = cfg.pages
    .filter((p) => !p.external && !p.driveKey && !bodies.has(p.id))
    .map((p) => `/${p.path}`);
  if (missing.length)
    throw packError(
      `包里缺这些页面的正文：${missing.slice(0, 8).join("、")}${missing.length > 8 ? " 等" : ""}`,
    );

  return { cfg, bodies, droppedLinks, droppedSites };
}

/**
 * 把当前这套矩阵导出成 zip（导出与装备前留底共用）。
 * missing 是「有页、正文却没进包」的页面路径：装备那边遇到这种页会整包拒绝，
 * 所以缺了必须如实报出来 —— 不然导出看着成功，实际上是个装不回来的假成品。
 */
async function exportMatrixPack(
  env: MatrixEnv,
): Promise<{ zip: Uint8Array; missing: string[] }> {
  const cfg = await loadConfig(env);
  const files: Record<string, Uint8Array> = {};
  const missing: string[] = [];
  for (const p of cfg.pages) {
    // 外站页没有正文；引用云盘文件的页正文在云盘那边，不进包
    // （同一只桶，装到别处那套引用照样读得到）—— 这两类不算「缺」
    if (p.external || p.driveKey) continue;
    const obj = await env.MEMORY_BUCKET.get(bodyKey(p.id));
    if (!obj) {
      missing.push(`/${p.path}`);
      continue;
    }
    const buf = new Uint8Array(await obj.arrayBuffer());
    if (buf.byteLength > MAX_BODY_BYTES) {
      missing.push(`/${p.path}`);
      continue;
    }
    files[`${PACK_PAGE_DIR}${p.id}.html`] = buf;
  }
  files[PACK_MANIFEST] = strToU8(
    JSON.stringify(
      {
        format: PACK_FORMAT,
        version: PACK_VERSION,
        exportedAt: Date.now(),
        config: {
          rev: cfg.rev,
          pages: cfg.pages,
          links: cfg.links,
          nav: cfg.nav ?? DEFAULT_NAV,
          theme: cfg.theme ?? DEFAULT_THEME,
          sites: cfg.sites ?? [],
        },
      },
      null,
      2,
    ),
  );
  return { zip: zipSync(files), missing };
}

/**
 * 装备一个矩阵包：**整体替换** —— 旧的正文全清、旧配置整个换掉。
 * 动手之前先把当前这套压进留底槽，装错了还能捞回来。
 */
async function equipMatrixPack(
  env: MatrixEnv,
  bytes: Uint8Array,
): Promise<{
  pages: number;
  links: number;
  sites: number;
  droppedLinks: number;
  droppedSites: number;
  bodyBytes: number;
  snapshot: boolean;
}> {
  // 先验后动：unpack 抛错的话，线上一个字节都还没动
  const { cfg, bodies, droppedLinks, droppedSites } = unpackMatrixPack(bytes);

  // 引用云盘文件的页：与「保存一页」同一道收口 —— 那只文件得真在桶里、且不超上限。
  // 不核的话，包里写个不存在的 key 也能装上线，那一页当场变成「引用的文件不见了」，
  // 而保存一页走的头一道 head() 明明会把它拦下 —— 两条路同一套规矩
  for (const p of cfg.pages) {
    if (!p.driveKey) continue;
    const src = await env.MEMORY_BUCKET.head(p.driveKey);
    if (!src) throw packError(`页面 /${p.path} 引用的云盘文件不存在：${p.driveKey}`);
    if (src.size > MAX_BODY_BYTES)
      throw packError(`页面 /${p.path} 引用的云盘文件过大（上限 2MB）`);
  }

  // 留底：当前这套导出压进快照槽（空矩阵没什么好留的）
  const current = await loadConfig(env);
  let snapshot = false;
  if (current.pages.length) {
    await env.MEMORY_BUCKET.put(
      PACK_SNAPSHOT_KEY,
      (await exportMatrixPack(env)).zip,
    );
    snapshot = true;
  }

  // 清掉现有正文：整体替换，上一版留下的正文一个都不留。
  // 外站页与引用云盘文件的页本来就没有正文，不受影响。
  // 必须翻页删到 list_complete —— 只删第一页的话，正文超过 1000 个对象时
  // 旧页会残留在桶里，那就只是「半个替换」，与整体替换的承诺不符
  let cursor: string | undefined;
  do {
    const listed = await env.MEMORY_BUCKET.list({
      prefix: PAGE_PREFIX,
      limit: 1000,
      cursor,
    });
    for (const o of listed.objects) await env.MEMORY_BUCKET.delete(o.key);
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);

  let bodyBytes = 0;
  for (const [id, data] of bodies) {
    await env.MEMORY_BUCKET.put(bodyKey(id), data, {
      httpMetadata: { contentType: "text/html; charset=utf-8" },
    });
    bodyBytes += data.byteLength;
  }
  await saveConfig(env, cfg);

  return {
    pages: cfg.pages.length,
    links: cfg.links.length,
    sites: (cfg.sites ?? []).length,
    droppedLinks,
    droppedSites,
    bodyBytes,
    snapshot,
  };
}

/**
 * 管理面（/api/matrix/*）。viewer 由主包算好传进来 —— 主包那边已经做过
 * 「必须是管理员」这道闸，这里再核一遍（推送入口同样以 admin 身份进来）。
 */
export async function handleMatrixApi(
  req: Request,
  env: MatrixEnv,
  pathname: string,
  viewer: MatrixViewer,
): Promise<Response> {
  if (viewer.role !== "admin")
    return json({ ok: false, error: "无权访问" }, 403);

  const cfg = await loadConfig(env);
  // 工作台/设置页状态卡用的一次性总览：版本 + 矩阵规模 + 外观开关。
  // 只读、只汇总，不改任何东西；要细看页面去 /api/matrix/pages。
  if (pathname === "/api/matrix/stat") {
    const lastAt = cfg.pages.reduce((m, p) => Math.max(m, p.updatedAt || 0), 0);
    return json({
      ok: true,
      data: {
        version: PKG_VERSION,
        build: PKG_BUILD,
        r2: !!env.MEMORY_BUCKET,
        rev: cfg.rev,
        pages: cfg.pages.length,
        links: cfg.links.length,
        entries: cfg.pages.filter((p) => p.entry).length,
        external: cfg.pages.filter((p) => p.external).length,
        sandbox: cfg.pages.filter((p) => p.sandbox).length,
        sites: (cfg.sites ?? []).length,
        nav: cfg.nav ?? DEFAULT_NAV,
        theme: cfg.theme ?? DEFAULT_THEME,
        /** 最近一次改动页面配置的时刻（毫秒），0 = 还没动过 */
        updatedAt: lastAt,
      },
    });
  }
  if (pathname === "/api/matrix/pages")
    return json({
      ok: true,
      data: {
        rev: cfg.rev,
        pages: cfg.pages,
        nav: cfg.nav ?? DEFAULT_NAV,
        theme: cfg.theme ?? DEFAULT_THEME,
      },
    });
  // 全局外观：注入物的主色与按钮形态。GET 读、POST 写
  if (pathname === "/api/matrix/theme") {
    if (req.method === "POST") {
      const body = (await req.json().catch(() => ({}))) as unknown;
      cfg.theme = parseTheme(body);
      await saveConfig(env, cfg);
    }
    return json({ ok: true, data: { theme: cfg.theme ?? DEFAULT_THEME } });
  }
  // 全局悬浮菜单开关：GET 读、POST 写（写了顺手刷一下内存缓存里的配置）
  if (pathname === "/api/matrix/nav") {
    if (req.method === "POST") {
      const body = (await req.json().catch(() => ({}))) as { on?: unknown };
      cfg.nav = { on: body.on !== false };
      await saveConfig(env, cfg);
    }
    return json({ ok: true, data: { nav: cfg.nav ?? DEFAULT_NAV } });
  }
  // 外站认定表：GET 读、POST 整份覆盖（面板那边维护一版列表再交上来）
  if (pathname === "/api/matrix/sites") {
    if (req.method === "POST") {
      const body = (await req.json().catch(() => ({}))) as { sites?: unknown };
      cfg.sites = parseSites(body.sites);
      await saveConfig(env, cfg);
    }
    return json({ ok: true, data: { sites: cfg.sites ?? [] } });
  }
  // 矩阵包：GET 导出当前这套（下载一个 zip），POST 装备一个包（**整体替换**）。
  // 包体格式与用法见文件上半部分的说明。管理员专属（上面那道闸已经拦过）
  if (pathname === "/api/matrix/pack") {
    if (req.method === "POST") {
      // 先看声明的大小：真想拦的是「读完才发现太大」—— 那时整包已经躺在内存里了
      const declared = Number(req.headers.get("content-length") || 0);
      if (declared > MAX_PACK_TOTAL_BYTES)
        return badRequest(`包体超过上限（${MAX_PACK_TOTAL_BYTES >> 20}MB）`);
      const bytes = new Uint8Array(await req.arrayBuffer());
      if (!bytes.byteLength) return badRequest("没收到包体");
      if (bytes.byteLength > MAX_PACK_TOTAL_BYTES)
        return badRequest(`包体超过上限（${MAX_PACK_TOTAL_BYTES >> 20}MB）`);
      try {
        return json({ ok: true, data: await equipMatrixPack(env, bytes) });
      } catch (e) {
        return badRequest((e as Error).message);
      }
    }
    const { zip, missing } = await exportMatrixPack(env);
    const headers: Record<string, string> = {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="matrix-${Date.now()}.zip"`,
      "Cache-Control": "no-store",
    };
    // 正文没进包的页如实报出去（回执头）—— 静默的包会骗人：
    // 这种包装不回来，得让导出的人当场知道
    if (missing.length) {
      headers["X-Matrix-Pack-Missing"] = String(missing.length);
      headers["X-Matrix-Pack-Missing-Paths"] = encodeURIComponent(
        missing.slice(0, 20).join(","),
      );
    }
    return new Response(zip, { headers });
  }
  // 回滚：把上一次装备前的留底再装回去
  if (pathname === "/api/matrix/pack/rollback" && req.method === "POST") {
    const snap = await env.MEMORY_BUCKET.get(PACK_SNAPSHOT_KEY);
    if (!snap) return badRequest("还没有留底可回 —— 装过一次之后才有");
    try {
      const data = await equipMatrixPack(
        env,
        new Uint8Array(await snap.arrayBuffer()),
      );
      return json({ ok: true, data });
    } catch (e) {
      return badRequest((e as Error).message);
    }
  }
  if (pathname === "/api/matrix/page") {
    const id = new URL(req.url).searchParams.get("id") || "";
    const page = cfg.pages.find((p) => p.id === id);
    if (!page) return json({ ok: false, error: "找不到这一页" }, 404);
    let body = "";
    if (!page.external) {
      // 引用云盘文件的页面：读到的是那只文件的当下内容（编辑器照它显示）
      const obj = await env.MEMORY_BUCKET.get(page.driveKey || bodyKey(page.id));
      if (obj) body = await obj.text();
    }
    return json({ ok: true, data: { page, body } });
  }
  if (pathname === "/api/matrix/save" && req.method === "POST")
    return handleSave(req, env);
  if (pathname === "/api/matrix/delete" && req.method === "POST")
    return handleDelete(req, env);
  if (pathname === "/api/matrix/links")
    return json({ ok: true, data: { links: cfg.links } });
  if (pathname === "/api/matrix/link" && req.method === "POST")
    return handleLink(req, env);
  if (pathname === "/api/matrix/unlink" && req.method === "POST")
    return handleUnlink(req, env);
  return json({ ok: false, error: "not found" }, 404);
}

/**
 * 主包的构建信息：版本号 + 构建号（与主包同一对值，见 vite.config.ts 的 define）。
 *
 * 打包时它们被内联成字面量；裸 `wrangler dev`（不走 vite）里那两个标识符压根
 * 不存在 —— 直接引用会把这个模块整个炸掉。所以这里探一下：探不到就留空，
 * 由前端退回它自己那份构建信息显示，界面不空着。
 */
const PKG_VERSION: string = (() => {
  try {
    return __APP_VERSION__;
  } catch {
    return "";
  }
})();
const PKG_BUILD: string = (() => {
  try {
    return __GIT_HASH__;
  } catch {
    return "";
  }
})();

// ── 主包调用的入口 ──────────────────────────────────────

/**
 * 页面直吐：认领这条路径就返回响应，认领不了返回 null（由主包回落应用）。
 * viewer 由主包算好传进来 —— 主包那边验过 cookie，这次请求是谁由它说了算。
 */
export async function serveMatrixPage(
  req: Request,
  env: MatrixEnv,
  viewer: MatrixViewer,
  pathname: string,
): Promise<Response | null> {
  // 只有 GET/HEAD 走页面直吐；其它方法交还主包
  if (req.method !== "GET" && req.method !== "HEAD") return null;

  // 门卫页：往站外去的那道闸，自己不是一个页面
  if (normPath(pathname) === GATE_PATH) return serveGate(req, env);

  // 验票页：进内区前的那道闸，自己不是一个页面
  if (normPath(pathname) === TICKET_PATH) return serveTicket(req, env, viewer);

  return servePage(req, env, viewer, pathname);
}

// ── 给助手工具直接用的一组域函数 ──────────────────────────
// 工具跑在主包进程里，直接读同一份配置、写同一只桶 —— 不再绕 HTTP、不再签名。

export interface MatrixPagesData {
  rev: number;
  pages: MatrixPage[];
  nav: NavConfig;
  theme: MatrixTheme;
}

export async function matrixListPages(env: MatrixEnv): Promise<MatrixPagesData> {
  const cfg = await loadConfig(env);
  return {
    rev: cfg.rev,
    pages: cfg.pages,
    nav: cfg.nav ?? DEFAULT_NAV,
    theme: cfg.theme ?? DEFAULT_THEME,
  };
}

export async function matrixListLinks(env: MatrixEnv): Promise<MatrixLink[]> {
  return (await loadConfig(env)).links;
}

export async function matrixListSites(env: MatrixEnv): Promise<ApprovedSite[]> {
  return (await loadConfig(env)).sites ?? [];
}

/** 读一页（含正文）；找不到返回 null */
export async function matrixReadPage(
  env: MatrixEnv,
  id: string,
): Promise<{ page: MatrixPage; body: string } | null> {
  const cfg = await loadConfig(env);
  const page = cfg.pages.find((p) => p.id === id);
  if (!page) return null;
  let body = "";
  if (!page.external) {
    // 引用云盘文件的页面：读到的是那只文件的当下内容（编辑器照它显示）
    const obj = await env.MEMORY_BUCKET.get(page.driveKey || bodyKey(page.id));
    if (obj) body = await obj.text();
  }
  return { page, body };
}

/** 改全站外观（工具用） */
export async function matrixSaveTheme(
  env: MatrixEnv,
  theme: unknown,
): Promise<MatrixTheme> {
  const cfg = await loadConfig(env);
  cfg.theme = parseTheme(theme);
  await saveConfig(env, cfg);
  return cfg.theme;
}
