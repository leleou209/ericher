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

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../lib/api";
import { type R2File, type ThemeKey } from "../lib/types";
import {
  BACKGROUND_SCOPES,
  SCOPE_LABELS,
  defaultTheme,
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
  type ThemePopupAction,
  type ThemeSet,
  type ThemeTint,
} from "../lib/theme";
import { Icon, type IconName } from "./Icons";
import "./ThemePanel.css";

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

/** 存档大小给人看：KB 起步，超过 1MB 走 MB */
function humanBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}MB`;
  return `${Math.max(1, Math.round(n / 1024))}KB`;
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

const TRIGGER_LABELS: Record<PopupTrigger, string> = {
  load: "每次进站",
  first: "仅首次",
  daily: "每天一次",
  delay: "进站后延时",
};

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
  const [setName, setSetName] = useState("");

  const onTheme = page === "appearance-theme";
  const onColor = page === "appearance-color";
  const onFace = page === "appearance-face";
  const onMotion = page === "appearance-motion";

  const [iconName, setIconName] = useState<IconName>("home");
  const [iconRef, setIconRef] = useState("");

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
   */
  const save = async (
    patch: ThemeConfigPatch,
    keys: (keyof ThemeConfig)[],
    label: string,
  ) => {
    if (busy) return;
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
    } catch (e) {
      setErr((e as Error).message);
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

  const pickBg = async (scope: BackgroundScope, file: File) => {
    const ref = await uploadFile(file);
    if (ref) setBgSrc(scope, ref);
  };

  // ── 功能块背景 / 按钮花纹 ─────────────────────────────────
  //
  // 两者的存储形态不一样，是被消费方式决定的：
  //   panelBg      —— buildThemeCss 原样塞进 `--theme-panel-bg`，所以它必须是完整 CSS
  //                   background 值，图片要写成 `url("/api/theme-asset/x.png")`；
  //                   resolveAsset 只认纯引用，直接塞 `asset:x` 反而渲染不出来。
  //   buttonPattern —— buildThemeCss 会先过 resolveAsset 再拼进 `url(...)`，所以存纯
  //                   引用（asset:/https）；多包一层 url() 会被 resolveAsset 判成脏值丢掉。

  const pickPanelBg = async (file: File) => {
    const ref = await uploadFile(file);
    if (ref) update((d) => ({ ...d, panelBg: `url("${resolveAsset(ref)}")` }));
  };

  const pickPattern = async (file: File) => {
    const ref = await uploadFile(file);
    if (ref) update((d) => ({ ...d, buttonPattern: ref }));
  };

  // ── 图标覆盖 ────────────────────────────────────────────

  const addIcon = () => {
    const ref = iconRef.trim();
    if (!ref) return;
    update((d) => ({
      ...d,
      iconOverrides: { ...d.iconOverrides, [iconName]: ref },
    }));
    setIconRef("");
  };

  const removeIcon = (name: string) =>
    update((d) => {
      const next = { ...d.iconOverrides };
      delete next[name];
      return { ...d, iconOverrides: next };
    });

  // ── 弹页 ────────────────────────────────────────────────

  const setPopup = (idx: number, patch: Partial<ThemePopup>) =>
    update((d) => ({
      ...d,
      popups: d.popups.map((p, i) => (i === idx ? { ...p, ...patch } : p)),
    }));

  const addPopup = () =>
    update((d) => {
      let n = 1;
      while (d.popups.some((p) => p.id === `popup-${n}`)) n++;
      return {
        ...d,
        popups: [
          ...d.popups,
          {
            id: `popup-${n}`,
            enabled: true,
            title: "",
            body: "",
            image: "",
            trigger: "load" as PopupTrigger,
            delaySeconds: 0,
            actions: [],
          },
        ],
      };
    });

  const removePopup = (idx: number) =>
    update((d) => ({ ...d, popups: d.popups.filter((_, i) => i !== idx) }));

  const setPopupAction = (
    idx: number,
    ai: number,
    patch: Partial<ThemePopupAction>,
  ) =>
    update((d) => ({
      ...d,
      popups: d.popups.map((p, i) =>
        i === idx
          ? {
              ...p,
              actions: p.actions.map((a, j) => (j === ai ? { ...a, ...patch } : a)),
            }
          : p,
      ),
    }));

  const addPopupAction = (idx: number) =>
    update((d) => ({
      ...d,
      popups: d.popups.map((p, i) =>
        i === idx ? { ...p, actions: [...p.actions, { label: "", to: "" }] } : p,
      ),
    }));

  const removePopupAction = (idx: number, ai: number) =>
    update((d) => ({
      ...d,
      popups: d.popups.map((p, i) =>
        i === idx
          ? { ...p, actions: p.actions.filter((_, j) => j !== ai) }
          : p,
      ),
    }));

  const pickPopupImage = async (idx: number, file: File) => {
    const ref = await uploadFile(file);
    if (ref) setPopup(idx, { image: ref });
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

  /** 把当前整份配置存成一份带名字的档 */
  const saveAsSet = async () => {
    if (busy) return;
    const name = setName.trim();
    if (!name) return;
    setBusy("存档主题");
    setErr("");
    setSaved("");
    try {
      const r = await api.themeSaveSet(name);
      setSets(r.sets);
      setSetName("");
      setSaved(`已把当前配置存成「${r.set.name}」`);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy("");
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

            <div className="tp-field">
              <div className="form-label">自定义主题</div>
              {sets.length === 0 ? (
                <p className="empty-sm">
                  {isAdmin
                    ? "还没存过自定义主题 —— 下面给现在这套配置起个名字就存一份"
                    : "还没有自定义主题"}
                </p>
              ) : (
                <ul className="tp-sets">
                  {sets.map((s) => (
                    <li key={s.id} className="tp-set">
                      <div className="tp-set-main">
                        <span className="tp-set-name">{s.name}</span>
                        <span className="tp-set-meta">
                          {new Date(s.created).toLocaleString("zh-CN")} ·{" "}
                          {humanBytes(s.bytes)}
                        </span>
                      </div>
                      {isAdmin && (
                        <div className="tp-set-actions">
                          <button
                            className="btn btn-sm btn-primary"
                            disabled={!!busy}
                            onClick={() => void applySet(s)}
                          >
                            换装
                          </button>
                          <button
                            className="btn btn-sm"
                            disabled={!!busy}
                            onClick={() => void removeSet(s)}
                          >
                            删掉
                          </button>
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {isAdmin && (
              <div className="tp-field">
                <div className="form-label">把现在这套配置存档</div>
                <div className="inline-form">
                  <input
                    className="field"
                    placeholder="给这套配置起个名字（如「青花瓷」）"
                    maxLength={60}
                    value={setName}
                    disabled={!canEdit}
                    onChange={(e) => setSetName(e.target.value)}
                  />
                  <button
                    className="btn btn-primary"
                    disabled={!canEdit || !setName.trim()}
                    onClick={() => void saveAsSet()}
                  >
                    {busy === "存档主题" ? "存档中…" : "存为自定义主题"}
                  </button>
                </div>
                <p className="tp-note">
                  存档会把当前整份配置连同素材打成一份包留在云端，随时能换回来；
                  换装与删除都会先问一句。
                </p>
              </div>
            )}
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
          </p>
        </div>
        {BACKGROUND_SCOPES.map((scope) => {
          const bg = draft.backgrounds[scope];
          return (
            <div className="tp-scope" key={scope}>
              <div className="tp-scope-head">
                <span className="tp-scope-name">{SCOPE_LABELS[scope]}</span>
                <span className="tp-scope-src">
                  {bg.src ? resolveAsset(bg.src) || bg.src : "未铺图（走全局桌面）"}
                </span>
              </div>
              <div className="tp-scope-body">
                <PreviewBrick
                  src={bg.src}
                  dim={bg.dim}
                  blur={bg.blur}
                  position={bg.position}
                  size={bg.size}
                />
                <div className="tp-scope-fields">
                  <ImageField
                    value={bg.src}
                    onChange={(v) => setBgSrc(scope, v)}
                    onFile={(f) => pickBg(scope, f)}
                    onDrive={() => pickFromDrive((ref) => setBgSrc(scope, ref))}
                    disabled={!canEdit}
                    busy={busy.startsWith("上传")}
                    placeholder="https:// 外链图片地址"
                    uploadLabel="上传图/动图"
                  />
                  <div className="tp-sliders">
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
                  <div className="inline-form">
                    <input
                      className="field"
                      placeholder="位置（如 center、top）"
                      maxLength={40}
                      value={bg.position}
                      disabled={!canEdit}
                      onChange={(e) =>
                        setBg(scope, { position: e.target.value })
                      }
                    />
                    <select
                      className="field"
                      value={bg.size}
                      disabled={!canEdit}
                      onChange={(e) => setBg(scope, { size: e.target.value })}
                    >
                      <option value="cover">cover 铺满</option>
                      <option value="contain">contain 全景</option>
                      <option value="auto">auto 原图</option>
                    </select>
                    {isAdmin && (
                      <button
                        className="btn btn-sm"
                        disabled={!canEdit || !bg.src}
                        onClick={() => setBgSrc(scope, "")}
                      >
                        清除这位
                      </button>
                    )}
                  </div>
                </div>
              </div>
            </div>
          );
        })}
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
      </div>
      )}

      {/* ── 子页：壁纸与配色（三）：功能块与按钮花纹 ── */}
      {onColor && (
      <div className="settings-card">
        <div className="card-header">
          <h3 className="card-title">功能块背景与按钮花纹</h3>
          <p className="card-desc">
            两个都是一段 CSS background：功能块背景铺在面板/卡片上，按钮花纹是平铺在按钮底色上的花纹图。
          </p>
        </div>
        <div className="tp-field">
          <div className="form-label">功能块背景 panelBg</div>
          <ImageField
            value={draft.panelBg}
            onChange={(v) => update((d) => ({ ...d, panelBg: v }))}
            onFile={pickPanelBg}
            onDrive={() =>
              pickFromDrive((ref) =>
                update((d) => ({ ...d, panelBg: `url("${resolveAsset(ref)}")` })),
              )
            }
            disabled={!canEdit}
            busy={busy.startsWith("上传")}
            placeholder='一段 CSS background 值：url("/api/theme-asset/x.png")、#f7f4ec、linear-gradient(...)'
            uploadLabel="上传图片"
          />
          <div className="tp-swatch-row">
            <div
              className="tp-swatch"
              style={draft.panelBg.trim() ? { background: draft.panelBg.trim() } : undefined}
            >
              {!draft.panelBg.trim() && <span>出厂底色</span>}
            </div>
            <p className="tp-note">
              这里存的是完整 CSS 值（图片上传后自动填成 url(...)）——
              它会被原样注入 --theme-panel-bg，不是素材引用。
            </p>
          </div>
        </div>
        <div className="tp-field">
          <div className="form-label">按钮花纹 buttonPattern</div>
          <ImageField
            value={draft.buttonPattern}
            onChange={(v) => update((d) => ({ ...d, buttonPattern: v }))}
            onFile={pickPattern}
            onDrive={() =>
              pickFromDrive((ref) =>
                update((d) => ({ ...d, buttonPattern: ref })),
              )
            }
            disabled={!canEdit}
            busy={busy.startsWith("上传")}
            placeholder="asset: 引用或 https 图片地址（上传会自动填）"
            uploadLabel="上传花纹"
          />
          <div className="tp-swatch-row">
            <div
              className="tp-swatch tp-swatch-tile"
              style={
                resolveAsset(draft.buttonPattern)
                  ? {
                      backgroundImage: `url(${resolveAsset(draft.buttonPattern)})`,
                    }
                  : undefined
              }
            >
              {!resolveAsset(draft.buttonPattern) && <span>无花纹</span>}
            </div>
            <p className="tp-note">
              存纯引用（asset:/https）—— 注入时才拼进 url(...) 并按 140px 平铺；
              这里别手写 url(...)，那会被当成脏值丢掉。
            </p>
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
                    panelBg: draft.panelBg,
                    buttonPattern: draft.buttonPattern || null,
                  },
                  ["panelBg", "buttonPattern"],
                  "功能块与按钮",
                )
              }
            >
              {busy === "保存功能块与按钮" ? "保存中…" : "保存"}
            </button>
          </div>
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
          <div className="inline-form">
            <select
              className="field"
              value={iconName}
              disabled={!canEdit}
              onChange={(e) => setIconName(e.target.value as IconName)}
            >
              {ICON_NAMES.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
            <input
              className="field"
              placeholder="https:// 图片地址"
              value={iconRef}
              disabled={!canEdit}
              onChange={(e) => setIconRef(e.target.value)}
            />
            <label className="upload tp-upload">
              <input
                type="file"
                accept="image/*"
                hidden
                disabled={!canEdit || !!busy}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  e.target.value = "";
                  if (f)
                    void uploadFile(f).then((ref) => {
                      if (ref) setIconRef(ref);
                    });
                }}
              />
              {busy.startsWith("上传") ? "上传中…" : "上传图片"}
            </label>
            <button
              type="button"
              className="btn btn-sm tp-drive-btn"
              disabled={!canEdit || !!busy}
              onClick={() => pickFromDrive((ref) => setIconRef(ref))}
            >
              云盘选图
            </button>
            <button
              className="btn btn-primary btn-sm"
              disabled={!canEdit || !iconRef.trim()}
              onClick={addIcon}
            >
              加上
            </button>
          </div>
        )}
        {Object.keys(draft.iconOverrides).length > 0 ? (
          <ul className="tp-icon-list">
            {Object.entries(draft.iconOverrides).map(([name, ref]) => (
              <li key={name}>
                <span className="tp-icon-thumb">
                  {resolveAsset(ref) ? (
                    <img src={resolveAsset(ref)} alt={name} />
                  ) : (
                    <Icon name="image" size={15} />
                  )}
                </span>
                <code className="tp-icon-name">{name}</code>
                <span className="tp-icon-src">{resolveAsset(ref) || ref}</span>
                {isAdmin && (
                  <button
                    className="btn btn-sm"
                    disabled={!canEdit}
                    onClick={() => removeIcon(name)}
                  >
                    删掉
                  </button>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="empty-sm">还没有覆盖任何图标</p>
        )}
        {isAdmin && (
          <div className="row-actions">
            <button
              className="btn btn-primary"
              disabled={!canEdit || !dirty}
              onClick={() => {
                // 已在服务器上的条目如果从列表里删了，要显式发 null 才会被清掉
                const overrides: Record<string, string | null> = {};
                for (const [k, v] of Object.entries(draft.iconOverrides))
                  overrides[k] = v;
                for (const k of Object.keys(theme.iconOverrides))
                  if (!(k in draft.iconOverrides)) overrides[k] = null;
                void save({ iconOverrides: overrides }, ["iconOverrides"], "图标覆盖");
              }}
            >
              {busy === "保存图标覆盖" ? "保存中…" : "保存"}
            </button>
          </div>
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
        {draft.popups.length === 0 && (
          <p className="empty-sm">还没有弹页，点下面「加一条」开一条</p>
        )}
        {draft.popups.map((p, i) => (
          <div className="tp-popup" key={p.id}>
            <div className="tp-popup-head">
              <label className="check-line">
                <input
                  type="checkbox"
                  checked={p.enabled}
                  disabled={!canEdit}
                  onChange={(e) => setPopup(i, { enabled: e.target.checked })}
                />
                启用
              </label>
              <code className="tp-id">{p.id}</code>
              {isAdmin && (
                <button
                  className="btn btn-sm"
                  disabled={!canEdit}
                  onClick={() => removePopup(i)}
                >
                  删掉
                </button>
              )}
            </div>
            <input
              className="field"
              placeholder="标题"
              maxLength={200}
              value={p.title}
              disabled={!canEdit}
              onChange={(e) => setPopup(i, { title: e.target.value })}
            />
            <textarea
              className="field tp-textarea"
              placeholder="正文（可多行）"
              maxLength={5000}
              value={p.body}
              disabled={!canEdit}
              onChange={(e) => setPopup(i, { body: e.target.value })}
            />
            <div className="inline-form">
              <select
                className="field"
                value={p.trigger}
                disabled={!canEdit}
                onChange={(e) =>
                  setPopup(i, { trigger: e.target.value as PopupTrigger })
                }
              >
                {(Object.keys(TRIGGER_LABELS) as PopupTrigger[]).map((t) => (
                  <option key={t} value={t}>
                    {TRIGGER_LABELS[t]}
                  </option>
                ))}
              </select>
              {p.trigger === "delay" && (
                <input
                  className="field tp-num"
                  type="number"
                  min={0}
                  max={3600}
                  value={p.delaySeconds}
                  disabled={!canEdit}
                  onChange={(e) =>
                    setPopup(i, {
                      delaySeconds: Math.min(
                        3600,
                        Math.max(0, Number(e.target.value) || 0),
                      ),
                    })
                  }
                />
              )}
              {p.trigger === "delay" && (
                <span className="tp-note">秒后弹出（0~3600）</span>
              )}
            </div>
            <ImageField
              value={p.image}
              onChange={(v) => setPopup(i, { image: v })}
              onFile={(f) => pickPopupImage(i, f)}
              onDrive={() => pickFromDrive((ref) => setPopup(i, { image: ref }))}
              disabled={!canEdit}
              busy={busy.startsWith("上传")}
              placeholder="插图：https 外链（可留空）"
              uploadLabel="上传插图"
            />
            <div className="tp-actions">
              <div className="tp-actions-head">
                <span className="tp-note">
                  动作按钮（最多 2 个）：访客点一下就跳过去
                </span>
                {isAdmin && p.actions.length < 2 && (
                  <button
                    className="btn btn-sm"
                    disabled={!canEdit}
                    onClick={() => addPopupAction(i)}
                  >
                    加按钮
                  </button>
                )}
              </div>
              {p.actions.map((a, ai) => (
                <div className="tp-action-row" key={ai}>
                  <input
                    className="field tp-action-label"
                    placeholder="按钮文字"
                    maxLength={20}
                    value={a.label}
                    disabled={!canEdit}
                    onChange={(e) =>
                      setPopupAction(i, ai, { label: e.target.value })
                    }
                  />
                  <input
                    className="field tp-action-to"
                    placeholder="去向：/show 或 https://…"
                    maxLength={400}
                    value={a.to}
                    disabled={!canEdit}
                    onChange={(e) => setPopupAction(i, ai, { to: e.target.value })}
                  />
                  <button
                    className="btn btn-sm"
                    disabled={!canEdit}
                    onClick={() => removePopupAction(i, ai)}
                  >
                    删
                  </button>
                </div>
              ))}
              {p.actions.length > 0 && (
                <span className="tp-note">
                  去向只认 / 开头的站内路径或 http(s) 链接，其它会被忽略。
                </span>
              )}
            </div>
          </div>
        ))}
        {isAdmin && (
          <div className="row-actions">
            <button
              className="btn"
              disabled={!canEdit}
              onClick={addPopup}
            >
              加一条
            </button>
            <button
              className="btn btn-primary"
              disabled={!canEdit || !dirty}
              onClick={() => void save({ popups: draft.popups }, ["popups"], "弹页")}
            >
              {busy === "保存弹页" ? "保存中…" : "保存弹页"}
            </button>
          </div>
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
