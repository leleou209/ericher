// 外观面「列表 + 详情弹页」的纯规则：自定义主题存档、图标覆盖、触发式弹页这三处
// 记录型列表，加上个人信息那两格 —— 必填校验、草稿与提交的互转、列表行摘要。
// 六个壁纸落点与功能块底色/按钮花纹是固定枚举（不是可增删的列表），外提的是
// 行摘要的措辞、src 的来源判别，以及按下保存前对位置/尺寸做的归一。
//
// 为什么要外提：这些判断决定「按下保存到底给后端发什么」，而主题的提交口径有坑 ——
// 图标覆盖删一条必须显式发 null（空对象等于什么都不动，清不掉）、弹页的动作按钮
// 只填一半会被后端整条丢掉、存档名字超限后端按 60 字静默截。写在 JSX 里改一句措辞
// 就可能顺手碰坏，抽成不依赖 React 的函数才拿得住回归。
// 这里只有规则：不碰接口、不碰 DOM，主题读写与缓存口径仍在 lib/theme 与面板里。

import {
  resolveAsset,
  type BackgroundScope,
  type PopupTrigger,
  type ThemeBackground,
  type ThemePopup,
  type ThemeSet,
} from "./theme";

/** 触发方式怎么说：列表摘要与弹页里的下拉共用这一份措辞（原来散在 ThemePanel 里） */
export const TRIGGER_LABELS: Record<PopupTrigger, string> = {
  load: "每次进站",
  first: "仅首次",
  daily: "每天一次",
  delay: "进站后延时",
};

/** 下面这些上限对齐后端 src/agent/themeConfig.ts：超限它要么当场抛、要么静默截，界面先把话说在前面 */
export const MAX_POPUP_TITLE = 200;
export const MAX_POPUP_BODY = 5000;
export const MAX_POPUP_ACTIONS = 2;
export const MAX_ACTION_LABEL = 20;
export const MAX_ACTION_TO = 400;
/** 存档名：后端 (name).trim().slice(0, 60)，静默截断，所以这里也按 60 收 */
export const MAX_SET_NAME = 60;
/** 延迟秒数：与后端 num(v,0,3600,0) 同一把尺（只有 parseDelaySeconds 用，不外露） */
const MAX_DELAY_SECONDS = 3600;

/** 缺哪几项：field 让调用方知道该往哪一格上指，message 是可以直接给人看的一句话 */
export interface FieldError {
  field: "title" | "body" | "action" | "name" | "ref" | "image";
  message: string;
}

/** 摘要里给正文留的字数：行只用来认「这是哪一条」，读全文请进弹页 */
const SUMMARY_SNIPPET = 34;

/** 超长就截住并补省略号：摘要不是阅读器，窄屏也不该被一句话撑破 */
export const snippet = (raw: string, max = SUMMARY_SNIPPET): string => {
  const s = (raw || "").trim().replace(/\s+/g, " ");
  return s.length > max ? `${s.slice(0, max)}…` : s;
};

// ── 触发式弹页 ────────────────────────────────────────

/** 弹页上的动作按钮草稿：两格都是字符串，收口在 popupOf 里做 */
export interface PopupActionDraft {
  label: string;
  to: string;
}

/**
 * 弹页草稿：id 与 enabled 带过来（换触发方式、改标题都不该把这两样弄丢），
 * 延迟秒数按字符串存 —— 人在框里打的是字，清空那一格不算填 0。
 */
export interface PopupFormDraft {
  id: string;
  enabled: boolean;
  title: string;
  body: string;
  image: string;
  trigger: PopupTrigger;
  delaySeconds: string;
  actions: PopupActionDraft[];
}

/** 新增一条的起手草稿：与旧版「加一条」给的对象一致（启用、每次进站、没按钮） */
export const blankPopupDraft = (id: string): PopupFormDraft => ({
  id,
  enabled: true,
  title: "",
  body: "",
  image: "",
  trigger: "load",
  delaySeconds: "",
  actions: [],
});

/** 打开弹页时拍的快照：0 秒也照原样写回框里，不假装「没填」 */
export const popupDraftOf = (p: ThemePopup): PopupFormDraft => ({
  id: p.id,
  enabled: p.enabled,
  title: p.title,
  body: p.body,
  image: p.image,
  trigger: p.trigger,
  delaySeconds: String(p.delaySeconds),
  actions: p.actions.map((a) => ({ label: a.label, to: a.to })),
});

/**
 * 新条目的 id：popup-1、popup-2… 避开已有的。
 * 后端读路径会按序号补 id，但整组替换是按前端给的这份存的 —— 撞号会被 dedupe 掉一条。
 */
export const nextPopupId = (taken: string[]): string => {
  let n = 1;
  while (taken.includes(`popup-${n}`)) n += 1;
  return `popup-${n}`;
};

/** 延迟秒数收口：留空 / 不像数字 / 负数都当 0，小数往下取，超上限封顶 */
export const parseDelaySeconds = (raw: string): number => {
  const t = raw.trim();
  if (!t) return 0;
  const n = Math.floor(Number(t));
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(MAX_DELAY_SECONDS, n);
};

/**
 * 去向能不能跳：站内路径以 / 开头，或 http(s) 外链。
 * 协议相对 //host/x 与 /\host 都会跳到站外，后端也不认 —— 别让人以为存进去了。
 * 只有这一处消费方（popupMissingFields），所以不对外导出。
 */
const isNavigableTarget = (to: string): boolean => {
  const s = (to || "").trim();
  if (s.startsWith("//") || s.startsWith("/\\")) return false;
  return s.startsWith("/") || /^https?:\/\//i.test(s);
};

/**
 * 弹页缺项：
 *   1) 标题与正文都空 —— 弹出来是张白纸，拦下来；
 *   2) 动作按钮填了一半 —— 后端把 label 或 to 为空的条目整条丢掉，
 *      不拦就是「我明明加了按钮」；两格全空当作没打算加，提交时丢掉，不报错。
 */
export const popupMissingFields = (d: PopupFormDraft): FieldError[] => {
  const out: FieldError[] = [];
  if (!d.title.trim() && !d.body.trim())
    out.push({
      field: "title",
      message: "标题或正文至少填一个 —— 两个都空的弹页，弹出来是张白纸",
    });
  d.actions.forEach((a, i) => {
    const label = a.label.trim();
    const to = a.to.trim();
    if (!label && !to) return;
    if (!label)
      out.push({ field: "action", message: `第 ${i + 1} 个按钮没写文字` });
    if (!to)
      out.push({ field: "action", message: `第 ${i + 1} 个按钮没写去向` });
    else if (!isNavigableTarget(to))
      out.push({
        field: "action",
        message: `第 ${i + 1} 个按钮的去向要么以 / 开头，要么填 http(s) 链接`,
      });
  });
  return out;
};

/** 草稿 → 要提交的那条：两格全空的动作按钮丢掉，剩下封顶 2 个（后端同样只留 2 个） */
export const popupOf = (d: PopupFormDraft): ThemePopup => ({
  id: d.id,
  enabled: d.enabled,
  title: d.title.trim(),
  body: d.body.trim(),
  image: d.image.trim(),
  trigger: d.trigger,
  delaySeconds: parseDelaySeconds(d.delaySeconds),
  actions: d.actions
    .filter((a) => a.label.trim() && a.to.trim())
    .slice(0, MAX_POPUP_ACTIONS)
    .map((a) => ({ label: a.label.trim(), to: a.to.trim() })),
});

/** 行标题：没填标题的存量条目也得有个名字可点 */
export const popupRowTitle = (title: string): string =>
  title.trim() || "未命名告示";

/**
 * 行摘要：一行看清什么时候弹、写了几句话、有没有配图、几个按钮。
 * 正文摘句放最后 —— 它是这行里最长的东西，窄屏该被省略号切掉的是它，不是触发方式。
 */
export const popupSummary = (p: ThemePopup): string => {
  const parts: string[] = [];
  if (!p.enabled) parts.push("已停用");
  parts.push(
    p.trigger === "delay"
      ? `${TRIGGER_LABELS.delay} ${p.delaySeconds} 秒`
      : TRIGGER_LABELS[p.trigger] ?? p.trigger,
  );
  parts.push(p.image ? "带插图" : "没配图");
  parts.push(
    p.actions.length ? `${p.actions.length} 个按钮` : "没有按钮",
  );
  const body = snippet(p.body);
  parts.push(body ? `「${body}」` : "只有标题");
  return parts.join(" · ");
};

// ── 图标覆盖 ──────────────────────────────────────────

/** 图标覆盖缺项：名字（选出来的）与图片地址都必填，纯空格不算填了 */
export const iconMissingFields = (d: {
  name: string;
  ref: string;
}): FieldError[] => {
  const out: FieldError[] = [];
  if (!d.name.trim())
    out.push({ field: "name", message: "请选择要替换哪个图标" });
  if (!d.ref.trim())
    out.push({
      field: "ref",
      message: "请给出替换用的图片（上传、云盘选图，或填 asset:/https 地址）",
    });
  return out;
};

/**
 * 增量提交：后端对 iconOverrides 的语义是「值传 null 删掉这条，没提到的键不动」，
 * 空对象等于什么都不动 —— 所以删掉/改名过的键必须显式发 null 才清得掉。
 * 这条口径是整套外观里最容易写坏的一处，单独拎出来测。
 */
export const iconOverridePatchOf = (
  next: Record<string, string>,
  server: Record<string, string>,
): Record<string, string | null> => {
  const overrides: Record<string, string | null> = {};
  for (const [k, v] of Object.entries(next)) overrides[k] = v;
  for (const k of Object.keys(server))
    if (!(k in next)) overrides[k] = null;
  return overrides;
};

/** 新增时的起手图标：挑第一个还没被覆盖过的，免得开窗就撞上一条 */
export const firstUnusedIconName = (
  all: string[],
  taken: Record<string, string>,
): string => all.find((n) => !(n in taken)) ?? "";

/** 图标行摘要：能解析就显示实际地址，脏引用原样给出来（后端会判空，别在这里替它藏） */
export const iconOverrideSummary = (ref: string): string => {
  const url = resolveAsset(ref);
  if (url) return snippet(url, 60);
  const raw = (ref || "").trim();
  return raw ? `存的是「${snippet(raw, 60)}」，不是可显示的图片地址` : "没有图片地址";
};

/**
 * 详情窗保存一条图标覆盖 → 新的整份覆盖表。
 * editing 是被改的那一格的旧名字，空串 = 新增。改名时旧名字必须从表里消失 ——
 * 不然它会被 iconOverridePatchOf 当成「还在」，两份图叠在同一个图标上。
 */
export const iconOverrideEdited = (
  current: Record<string, string>,
  editing: string,
  next: { name: string; ref: string },
): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(current))
    if (k !== editing) out[k] = v;
  out[next.name.trim()] = next.ref.trim();
  return out;
};

/** 删掉一条图标覆盖 → 新的整份覆盖表 */
export const iconOverrideRemoved = (
  current: Record<string, string>,
  name: string,
): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(current)) if (k !== name) out[k] = v;
  return out;
};

// ── 自定义主题存档 ────────────────────────────────────

/**
 * 弹页保存一条 → 新的整组弹页。
 * editing 是被改那条的 id，空串 = 新增（追加到队尾：多条同时到点时按这个顺序排队）。
 * 后端对 popups 是整组替换，所以「改一条」也得把整组交出去，顺序就是来客看到顺序。
 */
export const popupListEdited = (
  list: ThemePopup[],
  editing: string,
  record: ThemePopup,
): ThemePopup[] =>
  editing
    ? list.map((p) => (p.id === editing ? record : p))
    : [...list, record];

/** 删掉一条 → 新的整组（后端只认整组替换，没有单条删除这条路） */
export const popupListRemoved = (
  list: ThemePopup[],
  id: string,
): ThemePopup[] => list.filter((p) => p.id !== id);

/** 行上的启停 → 新的整组：只翻 enabled，其余原样，别把正文弄丢 */
export const popupListToggled = (
  list: ThemePopup[],
  id: string,
): ThemePopup[] =>
  list.map((p) => (p.id === id ? { ...p, enabled: !p.enabled } : p));

/** 存档缺项：名字必填（旧界面是「没起名就不给按」，收到弹页里改成说清楚缺哪一格） */
export const archiveMissingFields = (d: {
  name: string;
}): FieldError[] =>
  d.name.trim()
    ? []
    : [{ field: "name", message: "给这套配置起个名字（如「青花瓷」）" }];

/** 存档大小给人看：KB 起步，超过 1MB 走 MB；0 字节也说「1KB」而不是「0KB」 */
export const humanBytes = (n: number): string => {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}MB`;
  return `${Math.max(1, Math.round(n / 1024))}KB`;
};

/** 行摘要：什么时候存的、多大一份 */
export const themeSetSummary = (
  s: Pick<ThemeSet, "created" | "bytes">,
): string =>
  `${new Date(s.created).toLocaleString("zh-CN")} · ${humanBytes(s.bytes)}`;

// ── 个人信息（设置页第一张卡）──────────────────────────

export const IDENTITY_NAME_MAX = 20;
export const IDENTITY_BIO_MAX = 80;

export interface IdentityDraft {
  guestName: string;
  adminBio: string;
}

/** 开窗快照：拿的是屋里的现值，原样进框（没保存的改动只在草稿里走） */
export const identityDraftOf = (
  guestName: string,
  adminBio: string,
): IdentityDraft => ({ guestName, adminBio });

/** 提交形态：trim 后按各自上限收 —— 与改造前那把刀一致 */
export const identityPayloadOf = (d: IdentityDraft) => ({
  guestName: d.guestName.trim().slice(0, IDENTITY_NAME_MAX),
  adminBio: d.adminBio.trim().slice(0, IDENTITY_BIO_MAX),
});

/** 只读行的两格：空着的那格要说清是「没填」，不是「显示坏了」 */
export const identityNameTitle = (name: string): string =>
  name.trim() || "称呼还没填";

export const identityBioSummary = (bio: string): string => {
  const s = snippet(bio, IDENTITY_BIO_MAX);
  return s ? `签名「${s}」` : "还没写签名（左下角那句 ericher 的自我介绍）";
};

// ── 六个壁纸落点（固定枚举，不是可增删的列表）──────────────

/** 行摘要里给地址留的宽度：它是这行里最长的东西，窄屏该被省略号切掉的是它 */
const BG_SRC_SUMMARY_MAX = 48;

/** 位置那格的上限：输入框的 maxLength 与归一用的是同一把尺 */
export const MAX_BG_POSITION = 40;

/** 尺寸只给这三档（沿用改造前下拉里的三个选项与措辞）；只有 backgroundSizeChoices 消费它 */
const BACKGROUND_SIZE_PRESETS: { value: string; label: string }[] = [
  { value: "cover", label: "cover 铺满" },
  { value: "contain", label: "contain 全景" },
  { value: "auto", label: "auto 原图" },
];

/** src 的来路：没铺 / 云盘引用 / 外链 / 填歪了 —— 行摘要与弹页的话术都按这一刀分派 */
export type BackgroundSourceKind = "none" | "asset" | "link" | "other";

/** 判别口径跟 resolveAsset 一致：只认 asset: 前缀与 http(s) 外链，其余都铺不出来 */
export const backgroundSourceKind = (src: string): BackgroundSourceKind => {
  const raw = (src || "").trim();
  if (!raw) return "none";
  if (raw.startsWith("asset:")) return "asset";
  if (/^https?:\/\//i.test(raw)) return "link";
  return "other";
};

/** 来源怎么说：global 那一格没铺是「谁都没图可退」，别的落点才是「退回全局那张」 */
export const backgroundSourceSummary = (
  src: string,
  scope: BackgroundScope,
): string => {
  const raw = (src || "").trim();
  const shown = snippet(raw, BG_SRC_SUMMARY_MAX);
  switch (backgroundSourceKind(raw)) {
    case "none":
      return scope === "global" ? "没铺，各界面退回出厂纸底" : "没铺，退回全局那张";
    case "link":
      return `外链 ${shown}`;
    case "asset":
      return resolveAsset(raw)
        ? `云盘 ${shown}`
        : `云盘引用「${shown}」的名字不合法，铺不出来`;
    default:
      return `填的是「${shown}」，既不是 asset: 引用也不是 http(s) 外链，铺不出来`;
  }
};

/** 压暗百分比措辞：0 说「不压暗」，脏值也按 0 —— 行上不该冒出 NaN% */
export const backgroundDimLabel = (dim: number): string => {
  const n = Number(dim);
  const pct = Number.isFinite(n) ? Math.round(Math.min(1, Math.max(0, n)) * 100) : 0;
  return pct > 0 ? `压暗 ${pct}%` : "不压暗";
};

/** 位置归一：多余空白压成一个空格、封顶，空的按 center —— 与 backgroundLayerStyles 的兜底同一口径 */
export const normalizeBackgroundPosition = (raw: string): string =>
  (raw || "").trim().replace(/\s+/g, " ").slice(0, MAX_BG_POSITION) || "center";

/** 尺寸归一：只 trim，空的按 cover；三档之外的手写值原样留着，别替它改写法 */
export const normalizeBackgroundSize = (raw: string): string =>
  (raw || "").trim() || "cover";

/** 尺寸下拉的选项：存量是不在三档里的手写值时也列一条，免得点一下保存就把原来那行 CSS 弄丢了 */
export const backgroundSizeChoices = (
  current: string,
): { value: string; label: string }[] => {
  const value = normalizeBackgroundSize(current);
  const presets = BACKGROUND_SIZE_PRESETS.map((o) => ({ ...o }));
  return presets.some((o) => o.value === value)
    ? presets
    : [...presets, { value, label: `自定义：${snippet(value, 30)}` }];
};

/**
 * 弹页草稿只带图与铺法这三格。
 * 压暗/模糊不住在这儿 —— 它们是行上的常驻预览，收进弹页就看不到效果了。
 */
export interface BackgroundFormDraft {
  src: string;
  position: string;
  size: string;
}

/** 开窗快照：按字符串原样进框（没保存的改动只在草稿里走） */
export const backgroundDraftOf = (
  bg: ThemeBackground | undefined,
): BackgroundFormDraft => ({
  src: bg?.src ?? "",
  position: bg?.position ?? "",
  size: bg?.size ?? "",
});

/** 弹页按下保存 → 这一格的新值：dim/blur 原样留着（那是行上刚调出来的），只换图与铺法 */
export const backgroundWithDraft = (
  bg: ThemeBackground | undefined,
  d: BackgroundFormDraft,
): ThemeBackground => ({
  src: d.src.trim(),
  dim: bg?.dim ?? 0,
  blur: bg?.blur ?? 0,
  position: normalizeBackgroundPosition(d.position),
  size: normalizeBackgroundSize(d.size),
});

/** 行摘要：一行看清这格铺了什么、怎么铺、压暗多少 */
export const backgroundRowSummary = (
  scope: BackgroundScope,
  bg: ThemeBackground | undefined,
): string =>
  [
    backgroundSourceSummary(bg?.src ?? "", scope),
    `位置 ${normalizeBackgroundPosition(bg?.position ?? "")}`,
    backgroundDimLabel(bg?.dim ?? 0),
  ].join(" · ");

// ── 功能块底色与按钮花纹（一域两格）────────────────────

/** 功能块底色存的是一整段 CSS 值、原样注入，所以照字说，别假装它是素材引用 */
export const panelBgSummary = (value: string): string => {
  const raw = (value || "").trim();
  return raw ? `铺的是「${snippet(raw, 60)}」` : "出厂底色（功能块没改过背景）";
};

/** 按钮花纹只存纯引用：手写一层 url(...) 会被 resolveAsset 判成脏值丢掉，话得说在前面 */
export const buttonPatternSummary = (value: string): string => {
  const raw = (value || "").trim();
  if (!raw) return "没铺花纹，按钮只有底色";
  const url = resolveAsset(raw);
  if (url) return `花纹 ${snippet(url, 60)}`;
  return raw.startsWith("url(")
    ? `存的是「${snippet(raw, 60)}」—— 这格要填纯引用，包一层 url(...) 会被丢掉`
    : `存的是「${snippet(raw, 60)}」，不是 asset:/https 引用，铺不出来`;
};

/**
 * 整域提交：后端收的是 panelBg + buttonPattern 这一整域，改哪一格都得把两格的现在值一起发。
 * 空花纹发 null 才清得掉（空串等于「什么都别动」）—— 口径与改造前那一刀一致。
 */
export const panelStylePatchOf = (v: {
  panelBg: string;
  buttonPattern: string;
}): { panelBg: string; buttonPattern: string | null } => ({
  panelBg: v.panelBg,
  buttonPattern: v.buttonPattern || null,
});
