// 外观设置：管理员装点整站门面的编辑台，摊成四个独立子页。
//
//   appearance-theme   主题：内置四套纸色 + 自定义主题存档 + 主题包
//   appearance-color   壁纸与配色：基调配色、六落点壁纸、功能块/按钮花纹、自定义 CSS
//   appearance-face    形象与弹页：名字头像、图标覆盖、触发式弹页
//   appearance-motion  动效与消息：本机动效开关、主题动画档、消息栏风格
//
// 四个子页共用一份草稿（draft）和一个外壳 AppearancePanel —— 草稿住在壳里，
// 切子页只换 page 这个 prop（Pages.tsx 同位置同组件类型），组件不卸载、编辑不丢。
// 所有编辑都落在这份本地 draft 上，按主题域分卡保存（api.themePatch 只发该域的字段），
// 成功后回填服务器回执并 reload() 刷新全局主题 —— 服务器永远是最终事实。
// 非管理员只读：能看不能动（实际上入口只给管理员开，这里只是把话说死）。
//
// 素材一律存纯引用（`asset:<文件名>` / https 外链），渲染时才 resolveAsset ——
// 唯一的例外是 panelBg，它本身就是一段原样注入的 CSS，得带 url(...)（见下方注释）。
//
// 管理形态分两半：「一项一项、有名字、可增可删」的三处记录（自定义主题存档、图标覆盖、
// 触发式弹页）走列表 + 详情弹页 —— 行只读，点行开弹页，按下保存才提交。
// 六个壁纸落点、功能块底色与按钮花纹同样走行 + 弹页，但它们是**固定枚举不是列表**：
// 只有那几行，没有「新增/删除」；压暗与模糊两根滑杆常驻在行上 —— 就地预览是它们的
// 本体，收进弹页就断了「改一下就看到效果」那条线。基调滑杆与自定义 CSS 同理留在原地。
// 派生规则（行摘要、来源判别、位置/尺寸归一）见 ../lib/appearanceForm.ts。

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../lib/api";
import { type R2File, type ThemeKey } from "../lib/types";
import {
  archiveMissingFields,
  backgroundDraftOf,
  backgroundRowSummary,
  backgroundSizeChoices,
  backgroundWithDraft,
  blankPopupDraft,
  buttonPatternSummary,
  firstUnusedIconName,
  iconMissingFields,
  iconOverrideEdited,
  iconOverridePatchOf,
  iconOverrideRemoved,
  iconOverrideSummary,
  MAX_ACTION_LABEL,
  MAX_ACTION_TO,
  MAX_BG_POSITION,
  MAX_POPUP_ACTIONS,
  MAX_POPUP_BODY,
  MAX_POPUP_TITLE,
  MAX_SET_NAME,
  nextPopupId,
  normalizeBackgroundSize,
  panelBgSummary,
  panelStylePatchOf,
  popupDraftOf,
  popupListEdited,
  popupListRemoved,
  popupListToggled,
  popupMissingFields,
  popupOf,
  popupRowTitle,
  popupSummary,
  themeSetSummary,
  TRIGGER_LABELS,
  type BackgroundFormDraft,
  type PopupActionDraft,
  type PopupFormDraft,
} from "../lib/appearanceForm";
import {
  BACKGROUND_SCOPES,
  SCOPE_LABELS,
  defaultTheme,
  emptyBackground,
  resolveAsset,
  tintPalette,
  useTheme,
  type BackgroundScope,
  type PopupTrigger,
  type ThemeConfig,
  type ThemeConfigPatch,
  type ThemeMessageStyle,
  type ThemeMode,
  type ThemeMotion,
  type ThemePopup,
  type ThemeSet,
  type ThemeTint,
} from "../lib/theme";
import {
  EntityAddButton,
  EntityNote,
  EntityRow,
  FormDialog,
  FormRow,
  FormSection,
  useDraft,
} from "./FormDialog";
import { Icon, type IconName } from "./Icons";
import "./ThemePanel.css";
import "./AppearanceDialogs.css";

/** 弹页认的「新增」标记；其余非空值是这一条的 id（编辑），空串 = 弹页关着 */
const NEW_MARK = "__new";

/** 功能块底色与按钮花纹：后端把它们当同一域，弹页按「正在改哪一格」开 */
type PanelField = "panelBg" | "buttonPattern";

/** 图标覆盖的候选名：Icons.tsx 里 ICONS 的全套字面量（漏改会被类型系统抓） */
const ICON_NAMES: IconName[] = [
  "thumbs-up",
  "thumbs-down",
  "comment",
  "copy",
  "share",
  "refresh",
  "bookmark",
  "edit",
  "trash",
  "flag",
  "home",
  "message",
  "compass",
  "book-open",
  "layers",
  "settings",
  "user",
  "search",
  "bell",
  "eye",
  "plus",
  "minus",
  "scissors",
  "clipboard",
  "undo",
  "redo",
  "type",
  "image",
  "paperclip",
  "link",
  "code",
  "mic",
  "play",
  "pause",
  "stop",
  "skip-back",
  "skip-forward",
  "volume",
  "volume-x",
  "download",
  "upload",
  "maximize",
  "check",
  "x",
  "chevron-down",
  "chevron-up",
  "arrow-right",
  "arrow-left",
  "clock",
  "help-circle",
  "alert-circle",
  "more",
  "archive",
  "chevron-right",
  "corner-up-left",
  "pin",
];

const BASE_LABELS: Record<ThemeMode, string> = {
  paper: "白纸黑字",
  dawn: "晨曦微蓝",
  dark: "夜墨",
};

/**
 * 四套内置主题：纸色是设备本地的事（localStorage 的 ThemeKey，不进后端）。
 * 管理员选回来还兼一层「恢复默认外观」——内置主题就是出厂那副门面，
 * 整份美术配置回出厂，基准色跟着这套走。
 */
const BUILTIN_THEMES: { key: ThemeKey; name: string; cls: string }[] = [
  { key: "paper", name: "白纸黑字", cls: "theme-paper" },
  { key: "dawn", name: "晨曦微蓝", cls: "theme-dawn" },
  { key: "dark", name: "夜墨", cls: "theme-dark" },
  { key: "system", name: "跟随系统", cls: "theme-system" },
];

/** 这份主题被装点过吗（只看美术，不看纸色 / 来客权限 / 动效这些开关） */
function artCustomized(t: ThemeConfig): boolean {
  return (
    !!t.agentName ||
    !!t.agentAvatar ||
    !!t.panelBg.trim() ||
    !!t.buttonPattern.trim() ||
    !!t.customCss.trim() ||
    t.popups.length > 0 ||
    Object.keys(t.iconOverrides).length > 0 ||
    BACKGROUND_SCOPES.some((s) => !!t.backgrounds[s].src)
  );
}

/** 三级调色器的起点（≈ 晨曦的蓝），一动滑杆就落成 draft.tint */
const DEFAULT_TINT: ThemeTint = { h: 214, s: 50, l: 24 };

/** 三根滑杆：色相/浓度/深浅。track 是滑杆底下的渐变预览条 */
const TINT_SLIDERS: {
  key: keyof ThemeTint;
  label: string;
  max: number;
  suffix: string;
  track: (t: ThemeTint) => string;
}[] = [
  {
    key: "h",
    label: "色相",
    max: 360,
    suffix: "°",
    track: () =>
      "linear-gradient(to right, #f66, #fc6, #6c6, #6cf, #96f, #f6c, #f66)",
  },
  {
    key: "s",
    label: "浓度",
    max: 100,
    suffix: "%",
    track: (t) =>
      `linear-gradient(to right, hsl(${t.h} 0% ${t.l}%), hsl(${t.h} 100% ${t.l}%))`,
  },
  {
    key: "l",
    label: "深浅",
    max: 100,
    suffix: "%",
    track: (t) =>
      `linear-gradient(to right, hsl(${t.h} ${t.s}% 0%), hsl(${t.h} ${t.s}% 50%), hsl(${t.h} ${t.s}% 100%))`,
  },
];

const MOTION_OPTIONS: { key: ThemeMotion; name: string; desc: string }[] = [
  { key: "default", name: "默认", desc: "正常的动画与过渡节奏" },
  { key: "gentle", name: "轻缓", desc: "拉长动画节奏，慢一点、柔一点" },
  { key: "off", name: "关闭", desc: "全站动画与过渡都停下" },
];

const MESSAGE_OPTIONS: {
  key: ThemeMessageStyle;
  name: string;
  desc: string;
}[] = [
  { key: "bubble", name: "气泡", desc: "圆角消息泡，默认样子" },
  { key: "card", name: "卡片", desc: "方角 + 描边 + 投影，像一张张便签" },
  { key: "minimal", name: "极简", desc: "去掉泡底和尾巴，纯文字排开" },
];

/** 预览砖：把 resolveAsset(src) 当背景图铺一小块，人一眼看到这层铺出来什么样 */
function PreviewBrick({
  src,
  dim = 0,
  blur = 0,
  position = "center",
  size = "cover",
  className = "",
}: {
  src: string;
  dim?: number;
  blur?: number;
  position?: string;
  size?: string;
  className?: string;
}) {
  const url = resolveAsset(src);
  return (
    <div className={`tp-preview ${url ? "" : "empty"} ${className}`}>
      {url && (
        <>
          <div
            className="tp-preview-img"
            style={{
              backgroundImage: `url(${url})`,
              backgroundPosition: position || "center",
              backgroundSize: size || "cover",
              filter: blur > 0 ? `blur(${blur}px)` : "",
              transform: blur > 0 ? "scale(1.08)" : "",
            }}
          />
          {dim > 0 && <div className="tp-preview-dim" style={{ opacity: dim }} />}
        </>
      )}
      {!url && <span>未铺图</span>}
    </div>
  );
}

/** 图片位的共用编辑件：上传 / 从云盘选 / 填外链 / 清除。value 是纯引用，不是可直接当 src 的地址 */
function ImageField({
  value,
  onChange,
  onFile,
  onDrive,
  disabled,
  busy,
  placeholder = "https:// 外链图片地址",
  accept = "image/*",
  uploadLabel = "上传图片",
}: {
  value: string;
  onChange: (v: string) => void;
  onFile: (f: File) => Promise<void>;
  onDrive?: () => void;
  disabled: boolean;
  busy: boolean;
  placeholder?: string;
  accept?: string;
  uploadLabel?: string;
}) {
  return (
    <div className="inline-form tp-image-field">
      <input
        className="field"
        placeholder={placeholder}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      />
      <label className="upload tp-upload">
        <input
          type="file"
          accept={accept}
          hidden
          disabled={disabled || busy}
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (f) void onFile(f);
          }}
        />
        {busy ? "上传中…" : uploadLabel}
      </label>
      {onDrive && (
        <button
          type="button"
          className="btn btn-sm tp-drive-btn"
          disabled={disabled || busy}
          onClick={onDrive}
        >
          云盘选图
        </button>
      )}
      {value && (
        <button
          className="btn btn-sm"
          disabled={disabled}
          onClick={() => onChange("")}
        >
          清除
        </button>
      )}
    </div>
  );
}

/** 云盘里的图片后缀 —— 选图器只列这些，别的文件别来凑热闹 */
const DRIVE_IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|avif|bmp|ico|apng)$/i;

/** 云盘选图器：列云盘里的图片，点一张就导进主题公开区，把 `asset:` 引用交回去 */
function DrivePicker({
  onPick,
  onClose,
}: {
  onPick: (ref: string) => void;
  onClose: () => void;
}) {
  const [files, setFiles] = useState<R2File[] | null>(null);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");

  useEffect(() => {
    api
      .files()
      .then((r) => setFiles(r.files))
      .catch((e) => setErr((e as Error).message));
  }, []);

  const word = q.trim().toLowerCase();
  const images = (files ?? []).filter(
    (f) =>
      DRIVE_IMAGE_EXT.test(f.key) &&
      (!word || f.key.toLowerCase().includes(word)),
  );

  /** 导入 = 服务端复制一份进公开区（原文件不动），回来是 asset: 引用 */
  const importIt = async (f: R2File) => {
    setBusy(f.key);
    setErr("");
    try {
      onPick((await api.themeImportDrive(f.key)).ref);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy("");
    }
  };

  // 显示口径和云盘面板一致：公开空间给个人话名字
  const label = (key: string) => key.replace(/^f\/public\//, "公开空间/");

  return (
    <div className="tp-drive-overlay" onClick={onClose}>
      <div className="tp-drive" onClick={(e) => e.stopPropagation()}>
        <div className="tp-drive-head">
          <h4>从云盘选择</h4>
          <button className="btn btn-sm" onClick={onClose}>
            关闭
          </button>
        </div>
        <p className="tp-note">
          点一张就复制一份进主题公开区（云盘里的原文件不动）——
          主题对所有来客可见，私密图别往这挂。
        </p>
        <input
          className="field"
          placeholder="按文件名过滤"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        {err && <p className="err">{err}</p>}
        {files === null && !err && <p className="empty-sm">云盘清单加载中…</p>}
        {files !== null && images.length === 0 && (
          <p className="empty-sm">云盘里没有找到图片</p>
        )}
        <ul className="tp-drive-list">
          {images.map((f) => (
            <li key={f.key}>
              <button
                type="button"
                className="tp-drive-item"
                disabled={!!busy}
                onClick={() => void importIt(f)}
              >
                <img
                  className="tp-drive-thumb"
                  src={api.fileUrl(f.key)}
                  alt=""
                  loading="lazy"
                />
                <span className="tp-drive-name">{label(f.key)}</span>
                {busy === f.key && <span className="tp-note">导入中…</span>}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/**
 * 圈定区域：立绘的脸很少在正中，圈脸 = 在图上拖一个方框框住脸，确认后按框
 * 裁一张方图当头像。框能拖着走、拽右下角改大小（始终正方，头像本来就是方的）。
 * 坐标全按原图像素存，显示缩放只影响手感不影响裁剪精度。
 */
function AvatarCrop({
  src,
  busy,
  onCrop,
  onWhole,
  onClose,
}: {
  src: string;
  busy: boolean;
  onCrop: (blob: Blob) => Promise<void> | void;
  onWhole: () => Promise<void> | void;
  onClose: () => void;
}) {
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  // 选框：图上原图坐标（正方）
  const [box, setBox] = useState({ x: 0, y: 0, size: 0 });
  const imgRef = useRef<HTMLImageElement>(null);
  const dragRef = useRef<{
    mode: "move" | "size";
    sx: number;
    sy: number;
    scale: number;
    start: { x: number; y: number; size: number };
  } | null>(null);

  useEffect(() => {
    const img = new Image();
    img.onload = () => {
      const w = img.naturalWidth;
      const h = img.naturalHeight;
      if (!w || !h) return;
      // 起手一个居中的半屏方框，脸在哪就往哪拖
      const size = Math.round(Math.min(w, h) * 0.5);
      setNatural({ w, h });
      setBox({ x: Math.round((w - size) / 2), y: Math.round((h - size) / 2), size });
    };
    img.src = src;
    return () => {
      img.onload = null;
    };
  }, [src]);

  const begin = (mode: "move" | "size") => (e: React.PointerEvent) => {
    const rect = imgRef.current?.getBoundingClientRect();
    if (!rect || !natural || !rect.width) return;
    e.preventDefault();
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    dragRef.current = {
      mode,
      sx: e.clientX,
      sy: e.clientY,
      // 显示宽度和原图宽度的比：手挪多少显示像素，换算回原图挪多少
      scale: natural.w / rect.width,
      start: { ...box },
    };
  };

  const moveBox = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d || !natural) return;
    const dx = (e.clientX - d.sx) / d.scale;
    const dy = (e.clientY - d.sy) / d.scale;
    const MAX = Math.min(natural.w, natural.h);
    // 最小边长别让框缩没了：原图短边的 8%，至少 24px
    const MIN = Math.max(24, Math.round(MAX * 0.08));
    if (d.mode === "move") {
      setBox({
        x: Math.min(Math.max(0, d.start.x + dx), natural.w - d.start.size),
        y: Math.min(Math.max(0, d.start.y + dy), natural.h - d.start.size),
        size: d.start.size,
      });
    } else {
      // 拽右下角：左上角钉住，从角上长出方框（两轴合力取平均，保持正方）
      const size = Math.min(
        MAX,
        Math.max(MIN, d.start.size + (dx + dy) / 2),
      );
      setBox({
        x: Math.min(d.start.x, natural.w - size),
        y: Math.min(d.start.y, natural.h - size),
        size,
      });
    }
  };

  const endDrag = () => {
    dragRef.current = null;
  };

  const crop = async () => {
    const img = imgRef.current;
    if (!img || !natural) return;
    // 头像用不上巨图：裁出的方图最长边压到 512，够清晰也够小
    const out = Math.min(Math.round(box.size), 512);
    const canvas = document.createElement("canvas");
    canvas.width = out;
    canvas.height = out;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(img, box.x, box.y, box.size, box.size, 0, 0, out, out);
    const blob = await new Promise<Blob | null>((r) =>
      canvas.toBlob(r, "image/png"),
    );
    if (blob) await onCrop(blob);
  };

  const pct = natural
    ? {
        left: (box.x / natural.w) * 100,
        top: (box.y / natural.h) * 100,
        width: (box.size / natural.w) * 100,
        height: (box.size / natural.h) * 100,
      }
    : null;

  return (
    <div className="tp-drive-overlay" onClick={onClose}>
      <div className="tp-crop" onClick={(e) => e.stopPropagation()}>
        <div className="tp-drive-head">
          <h4>圈定面部区域</h4>
          <button className="btn btn-sm" onClick={onClose}>
            取消
          </button>
        </div>
        <p className="tp-note">
          方框拖到脸上，拽右下角调大小 —— 确认后就按框裁一张方图当头像。
        </p>
        <div className="tp-crop-stage">
          {/* 画布 = 紧贴图片的定位参照，选框百分比才对得上图而不是对舞台 */}
          <div className="tp-crop-canvas">
            <img ref={imgRef} src={src} alt="圈脸原图" draggable={false} />
            {pct && (
              <div
                className="tp-crop-frame"
                style={{
                  left: `${pct.left}%`,
                  top: `${pct.top}%`,
                  width: `${pct.width}%`,
                  height: `${pct.height}%`,
                }}
                onPointerDown={begin("move")}
                onPointerMove={moveBox}
                onPointerUp={endDrag}
                onPointerCancel={endDrag}
              >
                <div
                  className="tp-crop-handle"
                  onPointerDown={(e) => {
                    // 别冒泡到框体：不然「改大小」会被「移动」顶掉
                    e.stopPropagation();
                    begin("size")(e);
                  }}
                  onPointerMove={moveBox}
                  onPointerUp={endDrag}
                  onPointerCancel={endDrag}
                />
              </div>
            )}
          </div>
          {!natural && <p className="empty-sm">图片加载中…</p>}
        </div>
        <div className="tp-crop-actions">
          <button
            className="btn btn-primary"
            disabled={!natural || busy}
            onClick={() => void crop()}
          >
            {busy ? "处理中…" : "圈好了，裁剪"}
          </button>
          <button
            className="btn"
            disabled={busy}
            onClick={() => void onWhole()}
          >
            不裁了，用整张图
          </button>
        </div>
      </div>
    </div>
  );
}

/** 外观设置被摊成四个独立子页 —— 侧栏点谁就渲染谁，草稿住在下面这个外壳里 */
export type AppearancePage =
  | "appearance-theme"
  | "appearance-color"
  | "appearance-face"
  | "appearance-motion";

/**
 * 外观设置的公用外壳。
 *
 * 四个子页共用一份草稿（draft）—— 所以外壳必须比子页活得久：Pages.tsx 里
 * 用**同一个组件类型、同一个位置**条件渲染它，切子页只是换 page 这个 prop，
 * 组件不卸载，没保存的编辑不会在翻页时丢掉。
 */
export function AppearancePanel({
  page,
  isAdmin,
  paperKey,
  setPaperKey,
  motion,
  setMotion,
}: {
  page: AppearancePage;
  isAdmin: boolean;
  /** 本机纸色（应用级 ThemeKey，存 localStorage，不进后端） */
  paperKey: ThemeKey;
  setPaperKey: (t: ThemeKey) => void;
  /** 本机动效开关（同样只在这台机器上） */
  motion: boolean;
  setMotion: (v: boolean) => void;
}) {
  const { theme, reload } = useTheme();
  const [draft, setDraft] = useState<ThemeConfig>(theme);
  // 手上有编辑时不再被 theme 的变化覆盖；保存/放弃后才重新跟手
  const touchedRef = useRef(false);
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const [saved, setSaved] = useState("");

  // 自定义主题存档：一份带名字的整包配置，存在云端
  const [sets, setSets] = useState<ThemeSet[]>([]);

  // 三处记录型列表各自一个弹页：开窗拍草稿，按下保存才提交。
  // hook 一律留在函数体最上面 —— 放到条件分支或早退之后，React 会报
  // "Rendered more hooks than during the previous render"，整页停在半开的状态不动。
  const setForm = useDraft<{ name: string }>({ name: "" });
  const [setDialog, setSetDialog] = useState(false);
  const [setDialogErr, setSetDialogErr] = useState("");
  const [savingSet, setSavingSet] = useState(false);

  const iconForm = useDraft<{ name: string; ref: string }>({ name: "", ref: "" });
  /** 正在编辑的图标名；NEW_MARK = 新增，空串 = 弹页关着 */
  const [iconDialog, setIconDialog] = useState("");
  const [iconErr, setIconErr] = useState("");

  const popupForm = useDraft<PopupFormDraft>(blankPopupDraft(""));
  /** 正在编辑的弹页 id；NEW_MARK = 新增，空串 = 弹页关着 */
  const [popupDialog, setPopupDialog] = useState("");
  const [popupErr, setPopupErr] = useState("");

  // 壁纸落点与功能块底色/花纹是固定枚举：弹页只记「正在编辑哪一格」，没有新增这条路
  const bgForm = useDraft<BackgroundFormDraft>({
    src: "",
    position: "",
    size: "",
  });
  /** 正在编辑的落点；空串 = 弹页关着 */
  const [bgDialog, setBgDialog] = useState<BackgroundScope | "">("");
  const [bgErr, setBgErr] = useState("");

  const panelForm = useDraft<{ value: string }>({ value: "" });
  /** 正在编辑的是哪一格（这两格是一域两格）；空串 = 弹页关着 */
  const [panelDialog, setPanelDialog] = useState<PanelField | "">("");
  const [panelErr, setPanelErr] = useState("");

  const onTheme = page === "appearance-theme";
  const onColor = page === "appearance-color";
  const onFace = page === "appearance-face";
  const onMotion = page === "appearance-motion";

  // 云盘选图器开着时，把「选完这张图往哪落」的回调存在这 —— 谁开的谁接货
  const [drivePick, setDrivePick] = useState<((ref: string) => void) | null>(
    null,
  );
  const pickFromDrive = (apply: (ref: string) => void) =>
    setDrivePick(() => apply);
  const takeDriveRef = (ref: string) => {
    const apply = drivePick;
    setDrivePick(null);
    apply?.(ref);
  };

  // 圈脸器开着时手上的原图：url 给画布显示，whole 是原图本体（「用整张图」直接传它）
  const [avatarCrop, setAvatarCrop] = useState<{
    url: string;
    name: string;
    whole: Blob;
  } | null>(null);
  const openAvatarCrop = (blob: Blob, name: string) => {
    if (avatarCrop) URL.revokeObjectURL(avatarCrop.url);
    setAvatarCrop({ url: URL.createObjectURL(blob), name, whole: blob });
  };
  const closeAvatarCrop = () => {
    if (avatarCrop) URL.revokeObjectURL(avatarCrop.url);
    setAvatarCrop(null);
  };
  // 兜底回收：换图/关闭各有各的 revoke，但人直接离开设置页时没人管 ——
  // 卸载时用函数式更新读手上的最新值（写 effect 镜像会慢半拍），有就收掉。
  // 卸载后状态更新会被丢弃，这里的 set 只是「读」的手段
  useEffect(
    () => () => {
      setAvatarCrop((c) => {
        if (c) URL.revokeObjectURL(c.url);
        return c;
      });
    },
    [],
  );
  /** 圈完/用整张都走这：传上去拿到 asset: 引用，落到草稿的头像位 */
  const finishAvatar = async (blob: Blob, name: string) => {
    closeAvatarCrop();
    const ref = await uploadFile(
      new File([blob], name, { type: blob.type || "image/png" }),
    );
    if (ref) update((d) => ({ ...d, agentAvatar: ref }));
  };

  const canEdit = isAdmin && !busy;

  useEffect(() => {
    if (!touchedRef.current) setDraft(theme);
  }, [theme]);

  // 和服务器上的主题逐字对得上就算干净 —— 免得保存后残留「未保存」的错觉
  const dirty = useMemo(
    () => JSON.stringify(draft) !== JSON.stringify(theme),
    [draft, theme],
  );

  // 调色器：还没自定义色时滑杆显示起点（DEFAULT_TINT），一动就落成 draft.tint。
  // 预览小样跟 base 的明暗结构走（夜墨 = 暗底染色）
  const tint = draft.tint ?? DEFAULT_TINT;
  const tintColors = tintPalette(tint, draft.base === "dark");

  const update = useCallback((fn: (d: ThemeConfig) => ThemeConfig) => {
    touchedRef.current = true;
    setDraft((d) => fn(d));
  }, []);

  const discard = () => {
    touchedRef.current = false;
    setDraft(theme);
    setErr("");
    setSaved("");
  };

  /** 传一张素材，回执是 `asset:<文件名>` 引用；失败回空串，调用方什么都不改 */
  const uploadFile = async (file: File): Promise<string> => {
    setBusy(`上传 ${file.name}`);
    setErr("");
    setSaved("");
    try {
      return (await api.themeUploadAsset(file.name, file)).ref;
    } catch (e) {
      setErr((e as Error).message);
      return "";
    } finally {
      setBusy("");
    }
  };

  /**
   * 按主题域保存：只发这一域的字段，成功后用回执回填该域、刷新全局主题。
   * 只回填 keys 指定的域 —— 别的卡上没保存的编辑还得留在手上。
   *
   * 返回空串 = 成了，非空 = 后端那句话（HTTP 200 里的 ok:false 也由 lib/http 抛成错误）。
   * 卡上的保存按钮不看返回值；弹页要看 —— 没成就留在窗里说清楚，不关窗、不做乐观更新。
   */
  const save = async (
    patch: ThemeConfigPatch,
    keys: (keyof ThemeConfig)[],
    label: string,
  ): Promise<string> => {
    if (busy) {
      const msg = `手上正在「${busy}」，先等它跑完`;
      setErr(msg);
      return msg;
    }
    setBusy(`保存${label}`);
    setErr("");
    setSaved("");
    try {
      const r = await api.themePatch(patch);
      setDraft((d) => {
        const n = { ...d };
        // 按键名逐域拷贝；借道 unknown 是因为 ThemeConfig 没有索引签名。
        // themePatch 的回执就是裸 ThemeConfig（req 已解包 {ok, data}）。
        const from = r as unknown as Record<string, unknown>;
        const to = n as unknown as Record<string, unknown>;
        for (const k of keys) to[k as string] = from[k as string];
        return n;
      });
      setSaved(`${label}已保存`);
      reload();
      return "";
    } catch (e) {
      const msg = (e as Error).message;
      setErr(msg);
      return msg;
    } finally {
      setBusy("");
    }
  };

  // ── 背景位 ──────────────────────────────────────────────

  // 铺图 = 换了门面的风格，顺手把整体风格锁上，免得普通用户换纸色把气氛翻了；
  // 锁定开关就在上面那张卡，想留自由随时手动关。
  const setBgSrc = (scope: BackgroundScope, src: string) =>
    update((d) => ({
      ...d,
      locked: src.trim() ? true : d.locked,
      backgrounds: {
        ...d.backgrounds,
        [scope]: { ...d.backgrounds[scope], src },
      },
    }));

  const setBg = (
    scope: BackgroundScope,
    patch: Partial<ThemeConfig["backgrounds"][BackgroundScope]>,
  ) =>
    update((d) => ({
      ...d,
      backgrounds: {
        ...d.backgrounds,
        [scope]: { ...d.backgrounds[scope], ...patch },
      },
    }));

  const patchBackground = (p: Partial<BackgroundFormDraft>) =>
    bgForm.setDraft((prev) => ({ ...prev, ...p }));

  const openEditBackground = (scope: BackgroundScope) => {
    bgForm.reset(backgroundDraftOf(draft.backgrounds[scope]));
    setBgErr("");
    setBgDialog(scope);
  };

  /** 挑图器还开着时先别拆弹页：Esc 会同时打到这两层，让人把这张图先挑完 */
  const closeBackgroundDialog = () => {
    if (drivePick) return;
    setBgDialog("");
    setBgErr("");
  };

  const pickBackgroundImage = async (file: File) => {
    const ref = await uploadFile(file);
    if (ref) patchBackground({ src: ref });
  };

  /**
   * 弹页按下保存 = 整组提交（后端对背景只有这一把刀，没做单格保存）。
   * 先落进草稿再发：行上的预览当场跟着这张新图走，压暗/模糊还是行上那份 ——
   * 这套「编辑住在草稿、按下保存才发出去」与改造前摊开输入条时是同一条线，
   * 所以提交失败时草稿留着待改（不是假装已经存上：成了才由 save 用回执回填这一域）。
   */
  const saveBackgroundDialog = async () => {
    const scope = bgDialog;
    if (!scope) return;
    const next = backgroundWithDraft(draft.backgrounds[scope], bgForm.draft);
    setBgSrc(scope, next.src);
    setBg(scope, { position: next.position, size: next.size });
    const failed = await save(
      { backgrounds: { ...draft.backgrounds, [scope]: next } },
      ["backgrounds"],
      "背景",
    );
    // 后端说不对：话留在弹页里说，不关窗、不乐观更新
    if (failed) {
      setBgErr(failed);
      return;
    }
    setBgDialog("");
    setBgErr("");
  };

  // ── 功能块背景 / 按钮花纹 ─────────────────────────────────
  //
  // 两者的存储形态不一样，是被消费方式决定的：
  //   panelBg      —— buildThemeCss 原样塞进 `--theme-panel-bg`，所以它必须是完整 CSS
  //                   background 值，图片要写成 `url("/api/theme-asset/x.png")`；
  //                   resolveAsset 只认纯引用，直接塞 `asset:x` 反而渲染不出来。
  //   buttonPattern —— buildThemeCss 会先过 resolveAsset 再拼进 `url(...)`，所以存纯
  //                   引用（asset:/https）；多包一层 url() 会被 resolveAsset 判成脏值丢掉。

  /** 同一张上传/云盘图，落进这两格时拼法不同 —— 差别就是上面那段 */
  const panelValueOf = (which: PanelField, ref: string): string =>
    which === "panelBg" ? `url("${resolveAsset(ref)}")` : ref;

  const patchPanelField = (p: Partial<{ value: string }>) =>
    panelForm.setDraft((prev) => ({ ...prev, ...p }));

  const openEditPanelField = (which: PanelField) => {
    panelForm.reset({
      value: which === "panelBg" ? draft.panelBg : draft.buttonPattern,
    });
    setPanelErr("");
    setPanelDialog(which);
  };

  const closePanelDialog = () => {
    if (drivePick) return;
    setPanelDialog("");
    setPanelErr("");
  };

  const pickPanelImage = async (file: File) => {
    const ref = await uploadFile(file);
    if (ref && panelDialog)
      patchPanelField({ value: panelValueOf(panelDialog, ref) });
  };

  /** 云盘挑回来的也是 asset: 引用，拼法与上传同一套（所以走 panelValueOf） */
  const pickPanelDrive = () => {
    const which = panelDialog;
    if (!which) return;
    pickFromDrive((ref) => patchPanelField({ value: panelValueOf(which, ref) }));
  };

  /** 两格是一域：提交时把另一格现在的值一起发，改完才由回执回填这一域 */
  const savePanelDialog = async () => {
    const which = panelDialog;
    if (!which) return;
    const value = panelForm.draft.value;
    const next =
      which === "panelBg"
        ? { panelBg: value, buttonPattern: draft.buttonPattern }
        : { panelBg: draft.panelBg, buttonPattern: value };
    update((d) => ({ ...d, ...next }));
    const failed = await save(
      panelStylePatchOf(next),
      ["panelBg", "buttonPattern"],
      "功能块与按钮",
    );
    if (failed) {
      setPanelErr(failed);
      return;
    }
    setPanelDialog("");
    setPanelErr("");
  };

  // ── 图标覆盖 ────────────────────────────────────────────
  //
  // 一项 = 「这个图标换成这张图」。行只读、点行开弹页，按下保存才提交；
  // 提交口径还是原来那一刀：整份覆盖表 + 后端增量语义（删掉的键显式发 null 才清得掉，
  // 空对象等于什么都不动）—— 折算都写在 iconOverridePatchOf 里，那条规则单独有测试。

  const submitIcons = (next: Record<string, string>) =>
    save(
      { iconOverrides: iconOverridePatchOf(next, theme.iconOverrides) },
      ["iconOverrides"],
      "图标覆盖",
    );

  const patchIcon = (p: Partial<{ name: string; ref: string }>) =>
    iconForm.setDraft((prev) => ({ ...prev, ...p }));

  const openAddIcon = () => {
    iconForm.reset({
      name: firstUnusedIconName(ICON_NAMES, draft.iconOverrides),
      ref: "",
    });
    setIconErr("");
    setIconDialog(NEW_MARK);
  };

  const openEditIcon = (name: string) => {
    iconForm.reset({ name, ref: draft.iconOverrides[name] ?? "" });
    setIconErr("");
    setIconDialog(name);
  };

  /** 挑图器还开着时先别拆弹页：Esc 会同时打到这两层，让人把这张图先挑完 */
  const closeIconDialog = () => {
    if (drivePick) return;
    setIconDialog("");
    setIconErr("");
  };

  const saveIconDialog = async () => {
    const missing = iconMissingFields(iconForm.draft);
    if (missing.length) {
      setIconErr(missing.map((m) => m.message).join("；"));
      return;
    }
    const failed = await submitIcons(
      iconOverrideEdited(
        draft.iconOverrides,
        iconDialog === NEW_MARK ? "" : iconDialog,
        iconForm.draft,
      ),
    );
    // 后端说不对（地址脏、超出条数…）：留在弹页里讲，不关窗、列表也不改
    if (failed) {
      setIconErr(failed);
      return;
    }
    setIconDialog("");
    setIconErr("");
  };

  const deleteIcon = (name: string) => {
    void submitIcons(iconOverrideRemoved(draft.iconOverrides, name));
  };

  const pickIconImage = async (file: File) => {
    const ref = await uploadFile(file);
    if (ref) patchIcon({ ref });
  };

  // ── 触发式弹页 ──────────────────────────────────────────
  //
  // 一条告示 = 一行。后端对 popups 只有「整组替换」这一把刀，所以启停、删除、编辑
  // 都是就地算出新的整组再发出去：成功才用回执回填列表（save 里那步），失败不关窗。

  const submitPopups = (next: ThemePopup[]) =>
    save({ popups: next }, ["popups"], "弹页");

  const patchPopup = (p: Partial<PopupFormDraft>) =>
    popupForm.setDraft((prev) => ({ ...prev, ...p }));

  const openAddPopup = () => {
    popupForm.reset(
      blankPopupDraft(nextPopupId(draft.popups.map((p) => p.id))),
    );
    setPopupErr("");
    setPopupDialog(NEW_MARK);
  };

  const openEditPopup = (p: ThemePopup) => {
    popupForm.reset(popupDraftOf(p));
    setPopupErr("");
    setPopupDialog(p.id);
  };

  const closePopupDialog = () => {
    if (drivePick) return;
    setPopupDialog("");
    setPopupErr("");
  };

  const savePopupDialog = async () => {
    const missing = popupMissingFields(popupForm.draft);
    if (missing.length) {
      setPopupErr(missing.map((m) => m.message).join("；"));
      return;
    }
    const failed = await submitPopups(
      popupListEdited(
        draft.popups,
        popupDialog === NEW_MARK ? "" : popupDialog,
        popupOf(popupForm.draft),
      ),
    );
    if (failed) {
      setPopupErr(failed);
      return;
    }
    setPopupDialog("");
    setPopupErr("");
  };

  const togglePopup = (id: string) => {
    void submitPopups(popupListToggled(draft.popups, id));
  };

  const deletePopup = (id: string) => {
    void submitPopups(popupListRemoved(draft.popups, id));
  };

  const addPopupAction = () => {
    if (popupForm.draft.actions.length >= MAX_POPUP_ACTIONS) return;
    popupForm.setDraft((prev) => ({
      ...prev,
      actions: [...prev.actions, { label: "", to: "" }],
    }));
  };

  const removePopupAction = (ai: number) =>
    popupForm.setDraft((prev) => ({
      ...prev,
      actions: prev.actions.filter((_, j) => j !== ai),
    }));

  const setPopupAction = (ai: number, patch: Partial<PopupActionDraft>) =>
    popupForm.setDraft((prev) => ({
      ...prev,
      actions: prev.actions.map((a, j) => (j === ai ? { ...a, ...patch } : a)),
    }));

  const pickPopupImage = async (file: File) => {
    const ref = await uploadFile(file);
    if (ref) patchPopup({ image: ref });
  };

  // ── 主题包 ──────────────────────────────────────────────

  const equipPack = async (file: File) => {
    // 整份替换，没得商量之前先问一句
    if (
      !window.confirm(
        "装备主题包会整份替换当前主题（整体风格、背景、形象、弹页…），确定吗？",
      )
    )
      return;
    setBusy("装备主题包");
    setErr("");
    setSaved("");
    try {
      const r = await api.themeEquipPack(file, file.name);
      touchedRef.current = false;
      setDraft(r.theme);
      setSaved(`主题包已装备，装了 ${r.assets} 个素材；包已存进云盘 betpag 文件夹`);
      reload();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy("");
    }
  };

  const exportPack = async () => {
    setBusy("导出主题包");
    setErr("");
    setSaved("");
    try {
      const blob = await api.themeExportPack();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "ericher-theme.zip";
      a.click();
      URL.revokeObjectURL(url);
      setSaved("主题包已导出");
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy("");
    }
  };

  const pickPack = (file: File) => void equipPack(file);

  // ── 自定义主题存档 ──────────────────────────────────────
  //
  // 存的是服务端打出来的一份完整主题包（含素材），所以这份档自包含：
  // 素材后来被换、被删，翻出旧档照样装得上。换装走的是和「装备主题包」同一把刀。
  // 存档列表只有管理员用得上，来客不烧这一趟请求。

  useEffect(() => {
    if (!isAdmin) return;
    api
      .themeSets()
      .then((r) => setSets(r.sets))
      .catch(() => {});
  }, [isAdmin]);

  /**
   * 把当前整份配置存成一份带名字的档：开窗只收一个名字，按下保存才提交。
   * 存档没有「编辑」这条路 —— 后端只有存 / 换装 / 删三个动作，没有改名接口，
   * 所以行上的名字是只读的，想换个名字就重存一份、删掉旧的。
   */
  const openAddSet = () => {
    setForm.reset({ name: "" });
    setSetDialogErr("");
    setSetDialog(true);
  };

  const closeSetDialog = () => {
    setSetDialog(false);
    setSetDialogErr("");
  };

  const submitSet = async () => {
    if (savingSet) return;
    const missing = archiveMissingFields(setForm.draft);
    if (missing.length) {
      setSetDialogErr(missing.map((m) => m.message).join("；"));
      return;
    }
    setSavingSet(true);
    setSetDialogErr("");
    try {
      const r = await api.themeSaveSet(setForm.draft.name.trim());
      // 回执带的就是新清单：列表显示落库后的真值，不往 sets 里塞一份猜测
      setSets(r.sets);
      setSaved(`已把当前配置存成「${r.set.name}」`);
      setSetDialog(false);
    } catch (e) {
      // 存不下来（名字超限、云端写入失败…）留在弹页里说，不关窗
      setSetDialogErr((e as Error).message);
    } finally {
      setSavingSet(false);
    }
  };

  const applySet = async (s: ThemeSet) => {
    if (busy) return;
    if (!window.confirm(`换装「${s.name}」会整份替换当前外观，确定吗？`)) return;
    setBusy("换装存档");
    setErr("");
    setSaved("");
    try {
      const r = await api.themeApplySet(s.id);
      touchedRef.current = false;
      setDraft(r.theme);
      setSaved(`已换装「${s.name}」`);
      reload();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy("");
    }
  };

  const removeSet = async (s: ThemeSet) => {
    if (busy) return;
    if (
      !window.confirm(
        `删掉「${s.name}」这份存档？云盘里那份包体也会一并清走。`,
      )
    )
      return;
    setBusy("删除存档");
    setErr("");
    setSaved("");
    try {
      const r = await api.themeDeleteSet(s.id);
      setSets(r.sets);
      setSaved(`已删掉「${s.name}」`);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy("");
    }
  };

  // ── 内置主题（兼「恢复默认外观」）─────────────────────────

  /**
   * 把整份主题写回出厂。iconOverrides 是增量语义，要在服务器上清干净，
   * 得把现有键逐个显式发 null —— 空对象等于「什么都不动」，清不掉。
   */
  const resetTo = async (factory: ThemeConfig) => {
    if (busy) return;
    setBusy("恢复出厂外观");
    setErr("");
    setSaved("");
    try {
      const iconOverrides: Record<string, string | null> = {};
      for (const k of Object.keys(theme.iconOverrides)) iconOverrides[k] = null;
      const r = await api.themePatch({
        locked: factory.locked,
        base: factory.base,
        tint: factory.tint,
        agentName: factory.agentName || null,
        agentAvatar: factory.agentAvatar || null,
        backgrounds: factory.backgrounds,
        panelBg: factory.panelBg || null,
        buttonPattern: factory.buttonPattern || null,
        iconOverrides,
        motion: factory.motion,
        messageStyle: factory.messageStyle,
        customCss: factory.customCss || null,
        popups: factory.popups,
      });
      touchedRef.current = false;
      setDraft(r);
      setSaved("已恢复出厂外观");
      reload();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy("");
    }
  };

  /**
   * 选一套内置主题：本机纸色跟着翻；管理员再顺手把整份美术恢复出厂 ——
   * 内置主题就是出厂那副门面，选回来等于「恢复默认」。
   * 已经装点过就先问一句（这套配置里可能有他自己攒的壁纸和弹页）。
   */
  const pickBuiltin = (key: ThemeKey) => {
    setPaperKey(key);
    if (!isAdmin) return;
    if (
      artCustomized(theme) &&
      !window.confirm(
        `选「${BUILTIN_THEMES.find((t) => t.key === key)?.name ?? key}」会把当前美术配置恢复出厂（壁纸、形象、图标、弹页、自定义 CSS 全清），确定吗？`,
      )
    )
      return;
    const base: ThemeMode =
      key === "dawn" || key === "dark" || key === "paper" ? key : draft.base;
    void resetTo({ ...defaultTheme(), base });
  };

  // 来客那边「实际生效的纸色」：关门时由主题基调接管，自己选的那个只留在本机
  const effectivePaper: ThemeKey =
    !isAdmin && draft.locked ? draft.base : paperKey;

  return (
    <>
      <div className="tp-status">
        {err && <p className="err">{err}</p>}
        {saved && !err && <p className="meta">{saved}</p>}
        {dirty && (
          <div className="tp-dirty">
            <span>改动还没全部保存，按各张卡的「保存」分别生效。</span>
            {canEdit && (
              <button className="btn btn-sm" onClick={discard}>
                放弃改动
              </button>
            )}
          </div>
        )}
      </div>

      {/* ── 子页：主题 ── */}
      {onTheme && (
        <>
          <div className="settings-card">
            <div className="card-header">
              <h3 className="card-title">主题</h3>
              <p className="card-desc">
                四套内置主题换的是纸色；管理员选内置主题等于把外观恢复默认，
                装点过的东西会清掉，所以会先问一句。
              </p>
            </div>
            <div className="theme-options">
              {BUILTIN_THEMES.map((t) => (
                <label key={t.key} className="theme-option">
                  <input
                    type="radio"
                    name="appearance-paper"
                    checked={effectivePaper === t.key}
                    disabled={!isAdmin && draft.locked}
                    onChange={() => pickBuiltin(t.key)}
                  />
                  <div className={`theme-preview ${t.cls}`}>
                    <span className="theme-ring" />
                  </div>
                  <span className="theme-name">{t.name}</span>
                </label>
              ))}
            </div>
            {!isAdmin && draft.locked && (
              <p className="tp-note">管理员把纸色收在主题基调上了，这里翻不动。</p>
            )}

            {/* 自定义主题存档：行只读（名字 / 存的时间 / 多大一份），
                新增走弹页、按下保存才提交；换装与删除是动作，留在行上常驻。
                这里没有「编辑这一行」：后端只有存 / 换装 / 删三个动作，没有改名接口。 */}
            <div className="tp-field">
              <div className="form-label">自定义主题</div>
              {isAdmin && (
                <EntityAddButton label="存为自定义主题" onClick={openAddSet} />
              )}
              {sets.length === 0 ? (
                <EntityNote>
                  {isAdmin
                    ? "还没存过自定义主题 —— 点上面「存为自定义主题」，给现在这套配置起个名字就存一份"
                    : "还没有自定义主题"}
                </EntityNote>
              ) : (
                <div className="entity-list">
                  {sets.map((s) => (
                    <EntityRow
                      key={s.id}
                      title={s.name}
                      summary={themeSetSummary(s)}
                      right={
                        isAdmin ? (
                          <button
                            className="btn btn-sm btn-primary"
                            disabled={!!busy}
                            onClick={() => void applySet(s)}
                          >
                            换装
                          </button>
                        ) : undefined
                      }
                      onDelete={
                        isAdmin ? () => void removeSet(s) : undefined
                      }
                    />
                  ))}
                </div>
              )}
              {isAdmin && (
                <EntityNote>
                  存档会把当前整份配置连同素材打成一份包留在云端，随时能换回来；
                  换装与删除都会先问一句。
                </EntityNote>
              )}
            </div>
          </div>

          <div className="settings-card">
            <div className="card-header">
              <h3 className="card-title">来客纸色</h3>
              <p className="card-desc">
                来客自己那台机器上的纸色选择，要不要放给他。
              </p>
            </div>
            <div className="toggle-list">
              <div className="toggle-row">
                <div className="toggle-info">
                  <div className="toggle-icon">
                    <Icon name="pin" size={17} />
                  </div>
                  <div className="toggle-text">
                    <div className="toggle-title">允许来客改自己的纸色</div>
                    <div className="toggle-desc">
                      关着的时候来客的纸色跟随主题基调；开着就可以本地换，只影响他自己
                    </div>
                  </div>
                </div>
                <label className="toggle-switch">
                  <input
                    type="checkbox"
                    checked={!draft.locked}
                    disabled={!canEdit}
                    onChange={(e) =>
                      update((d) => ({ ...d, locked: !e.target.checked }))
                    }
                  />
                  <span className="toggle-slider" />
                </label>
              </div>
            </div>
            {isAdmin && (
              <div className="row-actions">
                <button
                  className="btn btn-primary"
                  disabled={!canEdit || !dirty}
                  onClick={() =>
                    void save({ locked: draft.locked }, ["locked"], "来客纸色")
                  }
                >
                  {busy === "保存来客纸色" ? "保存中…" : "保存"}
                </button>
              </div>
            )}
          </div>
        </>
      )}

      {/* ── 子页：壁纸与配色（一）：基调与调色器 ── */}
      {onColor && (
      <div className="settings-card">
        <div className="card-header">
          <h3 className="card-title">整体风格</h3>
          <p className="card-desc">
            基调说到底就是一个颜色：整套灰阶跟着它走。来客纸色放不放，在「主题」那页管。
          </p>
        </div>
        <div className="tp-field">
          <div className="form-label">基调</div>
          <div className="tp-seg">
            {(Object.keys(BASE_LABELS) as ThemeMode[]).map((m) => (
              <label key={m} className="tp-seg-item">
                <input
                  type="radio"
                  name="theme-base"
                  checked={draft.base === m && !draft.tint}
                  disabled={!canEdit}
                  onChange={() => update((d) => ({ ...d, base: m, tint: null }))}
                />
                <span>{BASE_LABELS[m]}</span>
              </label>
            ))}
          </div>
          <p className="tp-note">来客纸色关着时它接管全站；开着时只是默认基调。</p>
          <div className="tp-tint">
            <div className="form-label">
              调色器{draft.tint ? "（自定义色生效中）" : ""}
            </div>
            <p className="tp-note">
              基调说到底就是一个颜色 —— 三根滑杆调出自己的底色，整套灰阶跟着这一个色走。
              调了就盖过上面的预设；想回预设，点一下上面的按钮。夜墨是暗底结构，
              叠上调色器就是暗底染色。
            </p>
            {TINT_SLIDERS.map(({ key, label, max, suffix, track }) => (
              <div className="tp-tint-row" key={key}>
                <span className="tp-tint-label">{label}</span>
                <input
                  type="range"
                  min={0}
                  max={max}
                  value={tint[key]}
                  disabled={!canEdit}
                  style={{ background: track(tint) }}
                  onChange={(e) =>
                    update((d) => {
                      const cur = d.tint ?? DEFAULT_TINT;
                      return {
                        ...d,
                        tint: {
                          ...cur,
                          [key]: Number(e.target.value),
                        } as ThemeTint,
                      };
                    })
                  }
                />
                <span className="tp-tint-val">
                  {Math.round(tint[key])}
                  {suffix}
                </span>
              </div>
            ))}
            <div className="tp-tint-preview">
              <div className="tp-tint-swatch">
                <span>纸面</span>
                <i style={{ background: tintColors["--yuzhe-bg"] }} />
              </div>
              <div className="tp-tint-swatch">
                <span>墨色</span>
                <i style={{ background: tintColors["--yuzhe-ink"] }} />
              </div>
              <div className="tp-tint-swatch">
                <span>签名块</span>
                <i
                  style={{
                    background: tintColors["--yuzhe-black"],
                    color: tintColors["--yuzhe-on-black"],
                  }}
                >
                  Aa
                </i>
              </div>
            </div>
          </div>
        </div>
        {isAdmin && (
          <div className="row-actions">
            <button
              className="btn btn-primary"
              disabled={!canEdit || !dirty}
              onClick={() =>
                void save(
                  { base: draft.base, tint: draft.tint },
                  ["base", "tint"],
                  "整体风格",
                )
              }
            >
              {busy === "保存整体风格" ? "保存中…" : "保存"}
            </button>
          </div>
        )}
      </div>
      )}

      {/* ── 子页：形象与弹页（一）：ericher 形象 ── */}
      {onFace && (
      <div className="settings-card">
        <div className="card-header">
          <h3 className="card-title">ericher 形象</h3>
          <p className="card-desc">
            称呼留空就是出厂的 ericher；头像可以上传，也可以填一张 https 外链图。
            上传或从云盘选图后会进「圈定区域」——立绘的脸不在正中就框出来再裁。
          </p>
        </div>
        <div className="tp-field">
          <div className="form-label">名字</div>
          <input
            className="field"
            placeholder="留空 = 出厂 ericher"
            maxLength={200}
            value={draft.agentName}
            disabled={!canEdit}
            onChange={(e) =>
              update((d) => ({ ...d, agentName: e.target.value }))
            }
          />
        </div>
        <div className="tp-field">
          <div className="form-label">头像</div>
          <div className="tp-avatar-row">
            <div className="tp-avatar">
              {resolveAsset(draft.agentAvatar) ? (
                <img src={resolveAsset(draft.agentAvatar)} alt="头像预览" />
              ) : (
                <Icon name="user" size={20} />
              )}
            </div>
            <ImageField
              value={draft.agentAvatar}
              onChange={(v) => update((d) => ({ ...d, agentAvatar: v }))}
              onFile={async (f) => openAvatarCrop(f, f.name)}
              onDrive={() =>
                pickFromDrive((ref) => {
                  // 云盘件先取回本地再圈脸；取不回来就原样挂上，别挡人办事
                  void (async () => {
                    try {
                      const resp = await fetch(resolveAsset(ref));
                      if (!resp.ok) throw new Error("取不到图");
                      openAvatarCrop(
                        await resp.blob(),
                        ref.replace(/^asset:/, ""),
                      );
                    } catch {
                      update((d) => ({ ...d, agentAvatar: ref }));
                    }
                  })();
                })
              }
              disabled={!canEdit}
              busy={busy.startsWith("上传")}
            />
          </div>
        </div>
        {isAdmin && (
          <div className="row-actions">
            <button
              className="btn btn-primary"
              disabled={!canEdit || !dirty}
              onClick={() =>
                void save(
                  {
                    agentName: draft.agentName,
                    agentAvatar: draft.agentAvatar || null,
                  },
                  ["agentName", "agentAvatar"],
                  "形象",
                )
              }
            >
              {busy === "保存形象" ? "保存中…" : "保存"}
            </button>
          </div>
        )}
      </div>
      )}

      {/* ── 子页：壁纸与配色（二）：六个落点的壁纸 ── */}
      {onColor && (
      <div className="settings-card">
        <div className="card-header">
          <h3 className="card-title">背景</h3>
          <p className="card-desc">
            六个落点各自可铺图（静态图或 gif/webp 动图都行），没铺的落点退回全局桌面那张。
            换图、位置与尺寸点行进弹页填，按下保存才提交；压暗与模糊留在行上就地调。
          </p>
        </div>
        {/* 六格是固定枚举不是列表：只有这六行，没有「新增」入口，也没有删除按钮 ——
            想把某一格退回全局那张，进弹页把图清掉再保存。 */}
        <div className="entity-list">
          {BACKGROUND_SCOPES.map((scope) => {
            // 固定枚举不跟着数据缺漏掉行：万一某格在回执里缺了，按「没铺」这一格摆出来
            const bg = draft.backgrounds[scope] ?? emptyBackground();
            const editing = bgDialog === scope;
            // 弹页里换了图，行上的预览当场跟着这张走（压暗/模糊仍是行上那份）
            const view = editing
              ? {
                  ...bg,
                  src: bgForm.draft.src,
                  position: bgForm.draft.position,
                  size: bgForm.draft.size,
                }
              : bg;
            return (
              <EntityRow
                key={scope}
                title={SCOPE_LABELS[scope]}
                summary={backgroundRowSummary(scope, view)}
                editing={editing}
                onEdit={isAdmin ? () => openEditBackground(scope) : undefined}
                right={
                  <div className="appearance-bg-controls">
                    <PreviewBrick
                      className="appearance-bg-preview"
                      src={view.src}
                      dim={bg.dim}
                      blur={bg.blur}
                      position={view.position}
                      size={view.size}
                    />
                    {/* 压暗与模糊常驻在行上：这两根滑杆就是就地预览的本体，
                        收进弹页就看不见效果了 */}
                    <div className="tp-sliders appearance-bg-sliders">
                      <label className="tp-slider">
                        <span>压暗</span>
                        <input
                          type="range"
                          min={0}
                          max={1}
                          step={0.05}
                          value={bg.dim}
                          disabled={!canEdit}
                          onChange={(e) =>
                            setBg(scope, { dim: Number(e.target.value) })
                          }
                        />
                        <b>{Math.round(bg.dim * 100)}%</b>
                      </label>
                      <label className="tp-slider">
                        <span>模糊</span>
                        <input
                          type="range"
                          min={0}
                          max={40}
                          step={1}
                          value={bg.blur}
                          disabled={!canEdit}
                          onChange={(e) =>
                            setBg(scope, { blur: Number(e.target.value) })
                          }
                        />
                        <b>{bg.blur}px</b>
                      </label>
                    </div>
                  </div>
                }
              />
            );
          })}
        </div>
        {isAdmin && (
          <div className="row-actions">
            <button
              className="btn btn-primary"
              disabled={!canEdit || !dirty}
              onClick={() =>
                void save({ backgrounds: draft.backgrounds }, ["backgrounds"], "背景")
              }
            >
              {busy === "保存背景" ? "保存中…" : "保存背景"}
            </button>
          </div>
        )}
        {isAdmin && (
          <EntityNote>
            弹页里按下保存就是把整组六格发出去；行上这两根滑杆只是就地预览，
            调完还得按「保存背景」才落到服务器 —— 后端对背景只认整组提交，一次生效六格。
          </EntityNote>
        )}
      </div>
      )}

      {/* ── 子页：壁纸与配色（三）：功能块与按钮花纹 ── */}
      {onColor && (
      <div className="settings-card">
        <div className="card-header">
          <h3 className="card-title">功能块背景与按钮花纹</h3>
          <p className="card-desc">
            两个都是一段 CSS background：功能块背景铺在面板/卡片上，按钮花纹是平铺在按钮底色上的花纹图。
            点行进弹页改，按下保存才提交。
          </p>
        </div>
        {/* 两格是固定的，不是可以增删的列表：各一行，行上只留效果小样，值进弹页改 */}
        <div className="entity-list">
          <EntityRow
            title="功能块背景 panelBg"
            summary={panelBgSummary(draft.panelBg)}
            editing={panelDialog === "panelBg"}
            onEdit={isAdmin ? () => openEditPanelField("panelBg") : undefined}
            right={
              <div
                className="tp-swatch appearance-row-swatch"
                style={
                  draft.panelBg.trim()
                    ? { background: draft.panelBg.trim() }
                    : undefined
                }
              />
            }
          />
          <EntityRow
            title="按钮花纹 buttonPattern"
            summary={buttonPatternSummary(draft.buttonPattern)}
            editing={panelDialog === "buttonPattern"}
            onEdit={
              isAdmin ? () => openEditPanelField("buttonPattern") : undefined
            }
            right={
              <div
                className="tp-swatch tp-swatch-tile appearance-row-swatch"
                style={
                  resolveAsset(draft.buttonPattern)
                    ? {
                        backgroundImage: `url(${resolveAsset(draft.buttonPattern)})`,
                      }
                    : undefined
                }
              />
            }
          />
        </div>
        {isAdmin && (
          <EntityNote>
            两格属于同一域：弹页里按下保存，是把两格现在这份一起发给服务器，成了才由回执回填。
          </EntityNote>
        )}
      </div>
      )}

      {/* ── 子页：形象与弹页（二）：图标覆盖 ── */}
      {onFace && (
      <div className="settings-card">
        <div className="card-header">
          <h3 className="card-title">图标覆盖</h3>
          <p className="card-desc">
            用一张图替掉界面里的线稿图标；没覆盖的照旧走原字形。
          </p>
        </div>
        {isAdmin && (
          <EntityAddButton label="新增图标覆盖" onClick={openAddIcon} />
        )}
        {Object.keys(draft.iconOverrides).length > 0 ? (
          <div className="entity-list">
            {Object.entries(draft.iconOverrides).map(([name, ref]) => (
              <EntityRow
                key={name}
                title={name}
                summary={
                  <span className="appearance-icon-summary">
                    <span className="tp-icon-thumb">
                      {resolveAsset(ref) ? (
                        <img src={resolveAsset(ref)} alt="" />
                      ) : (
                        <Icon name="image" size={15} />
                      )}
                    </span>
                    <span className="appearance-icon-text">
                      {iconOverrideSummary(ref)}
                    </span>
                  </span>
                }
                editing={iconDialog === name}
                onEdit={isAdmin ? () => openEditIcon(name) : undefined}
                onDelete={isAdmin ? () => deleteIcon(name) : undefined}
                deleteConfirm={`删掉「${name}」这个图标覆盖？删掉就保存到服务器，界面立刻退回原来的线稿。`}
              />
            ))}
          </div>
        ) : (
          <EntityNote>
            {isAdmin
              ? "还没有覆盖任何图标 —— 点上面「新增图标覆盖」，挑一个图标、给它一张图"
              : "还没有覆盖任何图标"}
          </EntityNote>
        )}
      </div>
      )}

      {/* ── 子页：动效与消息（一）：这台机器上的动效开关 ── */}
      {onMotion && (
        <div className="settings-card">
          <div className="card-header">
            <h3 className="card-title">动画效果</h3>
            <p className="card-desc">
              这台机器上的动效开关；和主题里的动画档是两回事 —— 两边都开才动。
            </p>
          </div>
          <div className="toggle-list">
            <div className="toggle-row">
              <div className="toggle-info">
                <div className="toggle-icon">
                  <Icon name="play" size={17} />
                </div>
                <div className="toggle-text">
                  <div className="toggle-title">动效</div>
                  <div className="toggle-desc">
                    {theme.motion === "off"
                      ? "主题的动画档设成了「关闭」，全站动画都停着"
                      : "背景微晕与界面的过渡动画"}
                  </div>
                </div>
              </div>
              <label className="toggle-switch">
                <input
                  type="checkbox"
                  checked={motion}
                  // 主题说关就关 —— 这个开关说了不算
                  disabled={theme.motion === "off"}
                  onChange={(e) => setMotion(e.target.checked)}
                />
                <span className="toggle-slider" />
              </label>
            </div>
          </div>
        </div>
      )}

      {/* ── 子页：动效与消息（二）：主题级的动画档与消息栏 ── */}
      {onMotion && (
      <div className="settings-card">
        <div className="card-header">
          <h3 className="card-title">动效与消息栏</h3>
          <p className="card-desc">
            动画档是主题级的节奏设定（和每个人自己的动效开关是两回事）；
            消息栏风格改的是消息泡的样子。
          </p>
        </div>
        <div className="tp-field">
          <div className="form-label">动画效果 motion</div>
          <div className="tp-seg">
            {MOTION_OPTIONS.map((o) => (
              <label key={o.key} className="tp-seg-item">
                <input
                  type="radio"
                  name="theme-motion"
                  checked={draft.motion === o.key}
                  disabled={!canEdit}
                  onChange={() => update((d) => ({ ...d, motion: o.key }))}
                />
                <span>{o.name}</span>
              </label>
            ))}
          </div>
          <p className="tp-note">
            {MOTION_OPTIONS.find((o) => o.key === draft.motion)?.desc}
          </p>
        </div>
        <div className="tp-field">
          <div className="form-label">消息栏风格 messageStyle</div>
          <div className="tp-msg-grid">
            {MESSAGE_OPTIONS.map((o) => (
              <label
                key={o.key}
                className={`tp-msg-card ${draft.messageStyle === o.key ? "on" : ""}`}
              >
                <input
                  type="radio"
                  name="theme-msg-style"
                  checked={draft.messageStyle === o.key}
                  disabled={!canEdit}
                  onChange={() => update((d) => ({ ...d, messageStyle: o.key }))}
                />
                <div className={`tp-msg-demo tp-demo-${o.key}`}>
                  <span className="tp-msg them">今天想做点什么？</span>
                  <span className="tp-msg me">把这个排进日程</span>
                </div>
                <div className="tp-msg-meta">
                  <span className="tp-msg-name">{o.name}</span>
                  <span className="tp-note">{o.desc}</span>
                </div>
              </label>
            ))}
          </div>
        </div>
        {isAdmin && (
          <div className="row-actions">
            <button
              className="btn btn-primary"
              disabled={!canEdit || !dirty}
              onClick={() =>
                void save(
                  { motion: draft.motion, messageStyle: draft.messageStyle },
                  ["motion", "messageStyle"],
                  "动效与消息栏",
                )
              }
            >
              {busy === "保存动效与消息栏" ? "保存中…" : "保存"}
            </button>
          </div>
        )}
      </div>
      )}

      {/* ── 子页：壁纸与配色（四）：自定义 CSS ── */}
      {onColor && (
      <div className="settings-card">
        <div className="card-header">
          <h3 className="card-title">自定义 CSS</h3>
          <p className="card-desc">
            原样注入页面，写在主题内置样式之后 —— 后者压前者，这里能翻掉前面所有规则。
          </p>
        </div>
        <textarea
          className="field tp-textarea tp-code"
          placeholder=".btn { border-radius: 999px; }"
          maxLength={10000}
          value={draft.customCss}
          disabled={!canEdit}
          onChange={(e) => update((d) => ({ ...d, customCss: e.target.value }))}
        />
        {isAdmin && (
          <div className="row-actions">
            <button
              className="btn btn-primary"
              disabled={!canEdit || !dirty}
              onClick={() =>
                void save(
                  { customCss: draft.customCss || null },
                  ["customCss"],
                  "自定义 CSS",
                )
              }
            >
              {busy === "保存自定义 CSS" ? "保存中…" : "保存"}
            </button>
          </div>
        )}
      </div>
      )}

      {/* ── 子页：形象与弹页（三）：触发式弹页 ── */}
      {onFace && (
      <div className="settings-card">
        <div className="card-header">
          <h3 className="card-title">触发式弹页</h3>
          <p className="card-desc">
            进站时弹给客人看的告示/活动页，按触发方式出场；保存时整组替换。
          </p>
        </div>
        {/* 一条告示 = 一行：行上只写「什么时候弹、有没有图、几个按钮」，
            点行开弹页填内容，按下保存才提交（后端对 popups 只有整组替换这一把刀）。
            启停是动作，留在行上常驻 —— 巡检一排弹页时不该为此开三次窗。 */}
        {isAdmin && <EntityAddButton label="加一条告示" onClick={openAddPopup} />}
        {draft.popups.length === 0 ? (
          <EntityNote>
            {isAdmin
              ? "还没有弹页 —— 点上面「加一条告示」：写标题正文、挑什么时候弹、给一两个按钮"
              : "还没有弹页"}
          </EntityNote>
        ) : (
          <div className="entity-list">
            {draft.popups.map((p) => (
              <EntityRow
                key={p.id}
                title={popupRowTitle(p.title)}
                summary={popupSummary(p)}
                disabled={!p.enabled}
                editing={popupDialog === p.id}
                onEdit={isAdmin ? () => openEditPopup(p) : undefined}
                onDelete={isAdmin ? () => deletePopup(p.id) : undefined}
                deleteConfirm={`删掉「${popupRowTitle(
                  p.title,
                )}」这条告示？删掉就保存到服务器，来客那边不再弹它。`}
                right={
                  isAdmin ? (
                    <button
                      className="btn btn-ghost btn-sm"
                      disabled={!!busy}
                      title={
                        p.enabled
                          ? "先停一停：来客那边不再弹它"
                          : "让它按触发条件出场"
                      }
                      onClick={() => togglePopup(p.id)}
                    >
                      {p.enabled ? "停用" : "启用"}
                    </button>
                  ) : undefined
                }
              />
            ))}
          </div>
        )}
        {isAdmin && (
          <EntityNote>
            加、改、启停、删除都是当场提交：整组发给服务器，成了才回填列表，
            没成就把话留在弹页里说，不会悄悄少一条。
          </EntityNote>
        )}
      </div>
      )}

      {/* ── 子页：主题（二）：主题包 ── */}
      {onTheme && (
      <div className="settings-card">
        <div className="card-header">
          <h3 className="card-title">主题包</h3>
          <p className="card-desc">
            整份主题打成 zip 带走，或者拿一份主题包一键换装（theme.json 清单 + assets/
            素材）。
          </p>
        </div>
        {isAdmin && (
          <div className="row-actions">
            <label className="upload tp-upload">
              <input
                type="file"
                accept=".zip"
                hidden
                disabled={!canEdit}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  e.target.value = "";
                  if (f) pickPack(f);
                }}
              />
              {busy === "装备主题包" ? "装备中…" : "装备主题包"}
            </label>
            <button
              className="btn"
              disabled={!!busy}
              onClick={() => void exportPack()}
            >
              {busy === "导出主题包" ? "导出中…" : "导出当前主题包"}
            </button>
          </div>
        )}
        <p className="tp-note">
          装备会整份替换当前主题，包会留一份进云盘的 betpag
          文件夹；导出下载为 ericher-theme.zip。
        </p>
      </div>
      )}

      {/* ══ 详情弹页：存档 / 图标覆盖 / 触发式弹页 ══════════════
          列表行只读，新增与编辑共用同一份表单（空草稿即新增），按下保存才提交：
          没成就不关窗，后端那句话原样摆在弹页里（HTTP 200 里的 ok:false 也算失败，
          这一条由 lib/http.ts 保证）。就地预览的那些编辑器不在这儿 —— 见文件头。 */}

      {/* ══ 详情弹页：壁纸落点 / 功能块与花纹 / 存档 / 图标覆盖 / 触发式弹页 ══
          列表行只读，按下保存才提交：没成就不关窗，后端那句话原样摆在弹页里
          （HTTP 200 里的 ok:false 也算失败，这一条由 lib/http.ts 保证）。
          固定枚举的那几格（六个落点、底色与花纹）没有新增态，草稿就是那一格现在的值；
          就地预览的滑杆与自定义 CSS 不在这儿 —— 见文件头。 */}

      {bgDialog && (
        <FormDialog
          wide
          title={`编辑「${SCOPE_LABELS[bgDialog]}」那张壁纸`}
          subtitle="换图与铺法在这儿填，按下保存就把六格现在这份一起提交；压暗与模糊在列表行上调，这里不重复给。"
          busy={busy === "保存背景" || busy.startsWith("上传")}
          error={bgErr}
          dirty={bgForm.dirty(bgForm.draft)}
          onClose={closeBackgroundDialog}
          onSave={() => void saveBackgroundDialog()}
        >
          <FormSection title="图片来源">
            <FormRow
              label="图片"
              hint="上传、从云盘选，或直接填 asset: / https 地址；清掉就是这一格退回全局那张"
              wide
            >
              <ImageField
                value={bgForm.draft.src}
                onChange={(v) => patchBackground({ src: v })}
                onFile={pickBackgroundImage}
                onDrive={() =>
                  pickFromDrive((ref) => patchBackground({ src: ref }))
                }
                // 弹页里上传也要等这一域的保存跑完：两处抢着写 busy，后跑完的会把
                // 前一个的「保存中…」标记抹掉，按钮看着又能按了
                disabled={!!busy}
                busy={busy.startsWith("上传")}
                placeholder="https:// 外链图片地址"
                uploadLabel="上传图/动图"
              />
            </FormRow>
            {/* 预览砖跟着草稿走：换完图当场看到铺出来什么样，不用先保存 */}
            <div className="appearance-dialog-preview">
              <PreviewBrick
                src={bgForm.draft.src}
                dim={draft.backgrounds[bgDialog]?.dim ?? 0}
                blur={draft.backgrounds[bgDialog]?.blur ?? 0}
                position={bgForm.draft.position}
                size={bgForm.draft.size}
              />
              <p className="tp-note">
                这块按行上当前的压暗与模糊显示 —— 保存前就能看出来那张合不合适。
              </p>
            </div>
          </FormSection>

          <FormSection title="怎么铺">
            <FormRow label="位置" hint="background-position，如 center、top、50% 30%">
              <input
                className="field"
                placeholder="位置（如 center、top）"
                maxLength={MAX_BG_POSITION}
                value={bgForm.draft.position}
                onChange={(e) => patchBackground({ position: e.target.value })}
              />
            </FormRow>
            <FormRow label="尺寸" hint="background-size：三档之外的写法（如 100% 100%）也会列在这里">
              <select
                className="field"
                aria-label="尺寸"
                value={normalizeBackgroundSize(bgForm.draft.size)}
                onChange={(e) => patchBackground({ size: e.target.value })}
              >
                {backgroundSizeChoices(bgForm.draft.size).map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </FormRow>
            <EntityNote>
              六个落点是固定的六格（全局桌面、会话、笔记本、设置、门口、登录），
              没有新增也没有删除；位置与尺寸留空按 center / cover 铺。
            </EntityNote>
          </FormSection>
        </FormDialog>
      )}

      {panelDialog && (
        <FormDialog
          wide
          title={
            panelDialog === "panelBg"
              ? "编辑功能块背景 panelBg"
              : "编辑按钮花纹 buttonPattern"
          }
          subtitle={
            panelDialog === "panelBg"
              ? "铺在面板/卡片上的那一层：整段 CSS background 值，原样注入 --theme-panel-bg。"
              : "平铺在按钮底色上的花纹图：只存纯引用，注入时才拼进 url(...)。"
          }
          busy={busy === "保存功能块与按钮" || busy.startsWith("上传")}
          error={panelErr}
          dirty={panelForm.dirty(panelForm.draft)}
          onClose={closePanelDialog}
          onSave={() => void savePanelDialog()}
        >
          <FormSection
            title={panelDialog === "panelBg" ? "底色" : "花纹图"}
          >
            <FormRow label="值" hint="上传或从云盘选都会自动填进这一格" wide>
              <ImageField
                value={panelForm.draft.value}
                onChange={(v) => patchPanelField({ value: v })}
                onFile={pickPanelImage}
                onDrive={pickPanelDrive}
                disabled={!!busy}
                busy={busy.startsWith("上传")}
                placeholder={
                  panelDialog === "panelBg"
                    ? '一段 CSS background 值：url("/api/theme-asset/x.png")、#f7f4ec、linear-gradient(...)'
                    : "asset: 引用或 https 图片地址（上传会自动填）"
                }
                uploadLabel={panelDialog === "panelBg" ? "上传图片" : "上传花纹"}
              />
            </FormRow>
            <div className="tp-swatch-row">
              {panelDialog === "panelBg" ? (
                <div
                  className="tp-swatch"
                  style={
                    panelForm.draft.value.trim()
                      ? { background: panelForm.draft.value.trim() }
                      : undefined
                  }
                >
                  {!panelForm.draft.value.trim() && <span>出厂底色</span>}
                </div>
              ) : (
                <div
                  className="tp-swatch tp-swatch-tile"
                  style={
                    resolveAsset(panelForm.draft.value)
                      ? {
                          backgroundImage: `url(${resolveAsset(panelForm.draft.value)})`,
                        }
                      : undefined
                  }
                >
                  {!resolveAsset(panelForm.draft.value) && <span>无花纹</span>}
                </div>
              )}
              <p className="tp-note">
                {panelDialog === "panelBg"
                  ? "这里存的是完整 CSS 值（图片上传后自动填成 url(...)）—— 它会被原样注入 --theme-panel-bg，不是素材引用。"
                  : "存纯引用（asset:/https）—— 注入时才拼进 url(...) 并按 140px 平铺；这里别手写 url(...)，那会被当成脏值丢掉。"}
              </p>
            </div>
            <EntityNote>
              按下保存把这两格一起提交（后端认的是这一整域），没成功就把话留在弹页里说。
            </EntityNote>
          </FormSection>
        </FormDialog>
      )}

      {setDialog && (
        <FormDialog
          title="存为自定义主题"
          subtitle="给现在这套配置起个名字，打成一份自包含的包留在云端 —— 素材后来被换被删，翻出旧档照样装得上。"
          saveLabel="存档"
          busy={savingSet}
          error={setDialogErr}
          dirty={setForm.dirty(setForm.draft)}
          onClose={closeSetDialog}
          onSave={() => void submitSet()}
        >
          <FormSection title="名字">
            <FormRow label="存档名字" hint="必填，最多 60 字">
              <input
                className="field"
                placeholder="给这套配置起个名字（如「青花瓷」）"
                maxLength={MAX_SET_NAME}
                value={setForm.draft.name}
                onChange={(e) => setForm.setDraft({ name: e.target.value })}
              />
            </FormRow>
            <EntityNote>
              存的是服务器上已经保存的那份配置 —— 卡上还没按「保存」的改动不在里面，
              先把手上的存完再来存档。
            </EntityNote>
          </FormSection>
        </FormDialog>
      )}

      {iconDialog && (
        <FormDialog
          wide
          title={
            iconDialog === NEW_MARK
              ? "新增图标覆盖"
              : `编辑「${iconDialog}」这个图标`
          }
          subtitle="用一张图替掉界面里的线稿图标；没覆盖的照旧走原字形。"
          busy={busy === "保存图标覆盖"}
          error={iconErr}
          dirty={iconForm.dirty(iconForm.draft)}
          onClose={closeIconDialog}
          onSave={() => void saveIconDialog()}
        >
          <FormSection title="换哪个图标">
            <FormRow
              label="图标"
              hint="名字就是图标在代码里的字形名；改了名等于换了一条覆盖"
            >
              <select
                className="field"
                aria-label="图标名"
                value={iconForm.draft.name}
                onChange={(e) => patchIcon({ name: e.target.value })}
              >
                {!iconForm.draft.name && <option value="">挑一个图标…</option>}
                {ICON_NAMES.map((n) => (
                  <option key={n} value={n}>
                    {n}
                    {draft.iconOverrides[n] && n !== iconDialog
                      ? "（已经覆盖过，保存会换掉它的图）"
                      : ""}
                  </option>
                ))}
              </select>
            </FormRow>
          </FormSection>

          <FormSection title="换成哪张图">
            <FormRow
              label="图片"
              hint="上传、从云盘选，或直接填 asset: / https 地址"
              wide
            >
              <ImageField
                value={iconForm.draft.ref}
                onChange={(v) => patchIcon({ ref: v })}
                onFile={pickIconImage}
                onDrive={() => pickFromDrive((ref) => patchIcon({ ref }))}
                // 弹页里上传也要等这一域的保存跑完：两处抢着写 busy，后跑完的会把
                // 前一个的「保存中…」标记抹掉，按钮看着又能按了
                disabled={!!busy}
                busy={busy.startsWith("上传")}
                placeholder="https:// 图片地址"
              />
            </FormRow>
            {/* 预览砖跟着草稿走：填完地址当场就看到替上去长什么样，不用先保存 */}
            <div className="appearance-dialog-preview">
              <PreviewBrick src={iconForm.draft.ref} size="contain" />
              <p className="tp-note">
                替上去就是这个样子 —— 线稿图标是方的一格，横长条的图会被压小。
              </p>
            </div>
            <EntityNote>
              图标覆盖最多 100 条（后端给的额度）；删掉这一条会显式通知服务器清掉，
              不是把名字从列表里抹了就完事。
            </EntityNote>
          </FormSection>
        </FormDialog>
      )}

      {popupDialog && (
        <FormDialog
          wide
          title={
            popupDialog === NEW_MARK
              ? "加一条告示"
              : `编辑「${popupRowTitle(popupForm.draft.title)}」`
          }
          subtitle={`编号 ${popupForm.draft.id} —— 进站时弹给客人看的告示/活动页。`}
          busy={busy === "保存弹页"}
          error={popupErr}
          dirty={popupForm.dirty(popupForm.draft)}
          onClose={closePopupDialog}
          onSave={() => void savePopupDialog()}
        >
          <FormSection title="弹什么">
            <FormRow label="标题">
              <input
                className="field"
                placeholder="标题"
                maxLength={MAX_POPUP_TITLE}
                value={popupForm.draft.title}
                onChange={(e) => patchPopup({ title: e.target.value })}
              />
            </FormRow>
            <FormRow label="正文" hint="可以空着 —— 只有一句标题的告示也弹得出去" wide>
              <textarea
                className="field tp-textarea"
                placeholder="正文（可多行）"
                maxLength={MAX_POPUP_BODY}
                value={popupForm.draft.body}
                onChange={(e) => patchPopup({ body: e.target.value })}
              />
            </FormRow>
          </FormSection>

          <FormSection title="什么时候弹">
            <FormRow label="触发方式" hint="同场到点的几条会排队一条条来，不叠罗汉">
              <select
                className="field"
                aria-label="触发方式"
                value={popupForm.draft.trigger}
                onChange={(e) =>
                  patchPopup({ trigger: e.target.value as PopupTrigger })
                }
              >
                {(Object.keys(TRIGGER_LABELS) as PopupTrigger[]).map((t) => (
                  <option key={t} value={t}>
                    {TRIGGER_LABELS[t]}
                  </option>
                ))}
              </select>
            </FormRow>
            {popupForm.draft.trigger === "delay" && (
              <FormRow label="延时" hint="进站后过这么多秒才弹（0~3600）">
                <input
                  className="field tp-num"
                  type="number"
                  min={0}
                  max={3600}
                  value={popupForm.draft.delaySeconds}
                  onChange={(e) =>
                    patchPopup({ delaySeconds: e.target.value })
                  }
                />
              </FormRow>
            )}
            <EntityNote>
              启停不在这儿改 —— 列表行上那枚按钮常驻，巡检一排告示时不必开窗。
              {popupForm.draft.trigger === "delay"
                ? " 留空或填不像数字的都按 0 秒算。"
                : ""}
            </EntityNote>
          </FormSection>

          <FormSection title="插图">
            <FormRow label="插图" hint="可空；上传或从云盘选都行" wide>
              <ImageField
                value={popupForm.draft.image}
                onChange={(v) => patchPopup({ image: v })}
                onFile={pickPopupImage}
                onDrive={() => pickFromDrive((ref) => patchPopup({ image: ref }))}
                disabled={!!busy}
                busy={busy.startsWith("上传")}
                placeholder="插图：https 外链（可留空）"
                uploadLabel="上传插图"
              />
            </FormRow>
            <div className="appearance-dialog-preview">
              <PreviewBrick src={popupForm.draft.image} />
              <p className="tp-note">
                插图铺在正文上面，来客看到的就是这一块 —— 没配图就只出文字。
              </p>
            </div>
          </FormSection>

          <FormSection title="动作按钮">
            {popupForm.draft.actions.map((a, ai) => (
              <FormRow
                key={ai}
                label={`按钮 ${ai + 1}`}
                hint="访客点一下就跳过去"
              >
                <div className="appearance-action-row">
                  <input
                    className="field tp-action-label"
                    placeholder="按钮文字"
                    maxLength={MAX_ACTION_LABEL}
                    value={a.label}
                    onChange={(e) => setPopupAction(ai, { label: e.target.value })}
                  />
                  <input
                    className="field tp-action-to"
                    placeholder="去向：/show 或 https://…"
                    maxLength={MAX_ACTION_TO}
                    value={a.to}
                    onChange={(e) => setPopupAction(ai, { to: e.target.value })}
                  />
                  <button
                    className="btn btn-sm"
                    type="button"
                    onClick={() => removePopupAction(ai)}
                  >
                    删
                  </button>
                </div>
              </FormRow>
            ))}
            {popupForm.draft.actions.length < MAX_POPUP_ACTIONS && (
              <EntityAddButton label="加按钮" onClick={addPopupAction} />
            )}
            <EntityNote>
              最多 {MAX_POPUP_ACTIONS} 个。文字与去向都得填：只填一半的按钮会被当场拦下来
              —— 后端把那半条整条丢掉，与其存了看不见，不如先说清楚。去向只认 /
              开头的站内路径或 http(s) 链接。
            </EntityNote>
          </FormSection>
        </FormDialog>
      )}

      {drivePick && (
        <DrivePicker onPick={takeDriveRef} onClose={() => setDrivePick(null)} />
      )}
      {avatarCrop && (
        <AvatarCrop
          src={avatarCrop.url}
          busy={busy.startsWith("上传")}
          onCrop={(blob) =>
            // 裁剪件另起名字，别把云盘导入的原图顶掉
            void finishAvatar(
              blob,
              `${avatarCrop.name.replace(/\.[^.]+$/, "")}-圈脸.png`,
            )
          }
          onWhole={() => void finishAvatar(avatarCrop.whole, avatarCrop.name)}
          onClose={closeAvatarCrop}
        />
      )}
    </>
  );
}
