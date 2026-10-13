import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { RoomRing } from "./RoomRing";
import { useDragPos } from "../lib/dragPos";
import type { MatrixLink, MatrixPage } from "../lib/types";

/**
 * 页面预览 —— 把这一页当编辑器打开。
 *
 * 分两层：页面本体铺满整个浏览器视口，是**下层**（无视顶栏与左导航，整屏都给它）；
 * 工作台的顶栏与左导航照常显示，是**上层**，压在页面上 —— 不躲不避，盖住就盖住。
 * 导航一收，上层全退场，剩下光溜溜的一页。
 *
 * 房间环看的是这一页的门，可按钮到底落在页面的哪个角落，只有把页面本身摆出来
 * 才看得见。所以这一屏把真身按宽铺满视口 —— 页面长了就在视口里往下滚，跟逛一个
 * 正常网页一样；底下是这一页（带矩阵已注入的按钮），左上角留一枚房间环当小地图 ——
 * 上层收干净之后，就靠这枚小地图连续跳转：点它上面的门就走过去，跟站在大图里
 * 点门是一个意思。
 *
 * 小地图与左下角那枚导航浮标都能拖 —— 整屏的页面上，总有一处正被它们压着。
 * 拖开了记在本地，下次进来还在自己挪到的位置。
 *
 * 按钮的落点是拖出来的：手柄浮在真实按钮上面，拖到哪松手就存哪 —— 存的是
 * 自由坐标 point（百分比），不做锚点吸附。落点信息本来就归矩阵配置，不进正文。
 * 手柄由 editing 开关管着：只想看页面时就关掉，整页清清爽爽。
 *
 * 量位置靠同源读 iframe 里的 DOM：按钮都带 data-mx-from / data-mx-to，
 * 按这对键找回元素、量出它此刻的实际边界。沙箱页（不透明源）读不到 DOM，
 * 降级成「只按已存的坐标摆点」。
 */

/** 虚拟视口宽：页面按这个宽度排版，再整体缩放到铺满视口 */
const VW = 1180;
/** 量页面时的初始视口高（含 100vh 用的那档），量完按真实内容高重设 */
const VH = 900;
/** 缩放下限：视口窄得离谱时兜一下，免得页面缩没了 */
const MIN_SCALE = 0.22;
/** 吸附：落点离参考线这么近（屏幕像素）就贴上去 */
const SNAP_PX = 8;
/** 小地图的尺寸范围：拖右下角那枚手柄在里头调 */
const MIN_MINI = 120;
const MAX_MINI = 560;
/** 页高喂回 iframe 后最多再量几轮：正常页一两轮就稳，vh 页会一直追高，得有个头 */
const MEASURE_MAX = 5;

/** 一个可拖的手柄：对应这一页某条出边在页面里的那块按钮 */
interface Handle {
  key: string;
  from: string;
  to: string;
  label: string;
  /** 按钮中心，占整页宽 / 高的百分比（0-100） */
  x: number;
  y: number;
}

/** 拖动前先得挪出这么多像素，才认作「在拖」而不是「点了一下」 */
const THRESHOLD = 3;

/**
 * 拖动中的那一笔。整个拖的过程都不进 React state —— 每帧只改被拖手柄的
 * style，松手才提交一次。这样跟指针时不会整屏重渲染（连小地图都跟着重建）。
 */
interface DragState {
  key: string;
  from: string;
  to: string;
  /** 落点（百分比），跟指针走 */
  x: number;
  y: number;
  /** 起手那一刻的画布矩形：拖的过程里不再量，省掉每帧强制布局 */
  rect: DOMRect;
  /** 被拖的那枚手柄本身：直接改它的 style */
  el: HTMLElement;
  pointerId: number;
  /** 按下那一点（client px） */
  sx: number;
  sy: number;
  /** 最新指针位置（client px）：rAF 与松手都从这里换算 */
  cx: number;
  cy: number;
  /** 挪动量过没过阈值 */
  moved: boolean;
  /** 按住 Shift：不服帖参考线，想精确摆哪就摆哪 */
  free: boolean;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

/** 同源读 iframe 的文档；沙箱页（不透明源）读不到就返回 null */
function frameDoc(ifr: HTMLIFrameElement | null): Document | null {
  if (!ifr) return null;
  try {
    const d = ifr.contentDocument;
    void d?.body;
    return d && d.body ? d : null;
  } catch {
    return null;
  }
}

/** 按 (from,to) 这对键收集按钮元素 —— 一次扫全，省得转义属性选择器 */
function collectButtons(doc: Document): Map<string, HTMLElement> {
  const found = new Map<string, HTMLElement>();
  doc.querySelectorAll<HTMLElement>("[data-mx-from][data-mx-to]").forEach((el) => {
    const f = el.getAttribute("data-mx-from") || "";
    const t = el.getAttribute("data-mx-to") || "";
    if (f && t) found.set(`${f}:${t}`, el);
  });
  return found;
}

export function MatrixPreview({
  pages,
  links,
  currentId,
  busy,
  version,
  editing,
  onWalk,
  onMove,
}: {
  pages: MatrixPage[];
  links: MatrixLink[];
  currentId: string;
  busy: boolean;
  /** 变一次就整页重挂一次（连线改动后重取真实渲染） */
  version: string;
  /** 落点编辑开着没有：关了就不铺手柄，纯看页面 */
  editing: boolean;
  /** 小地图上点一扇门：走到对面那间（跟大图里点门同一个动作） */
  onWalk: (id: string) => void;
  /** 松手：把这条出边的落点改成拖到的坐标 */
  onMove: (from: string, to: string, x: number, y: number) => void;
}) {
  /** 小地图的落点：拖过就记本地，没拖过交给 CSS 去躲顶层那两栏 */
  const mini = useDragPos("matrix:preview:mini");
  const me = pages.find((p) => p.id === currentId);
  const outLinks = useMemo(
    () =>
      links
        .filter((l) => l.from === currentId)
        .sort((a, b) => a.order - b.order || a.label.localeCompare(b.label)),
    [links, currentId],
  );

  const viewportRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [frameW, setFrameW] = useState(760);
  const [pageH, setPageH] = useState(VH);
  const [handles, setHandles] = useState<Handle[]>([]);
  const [note, setNote] = useState("");
  /** 沙箱页（读不到 DOM）改不了真身，只能整页重挂：拿它加一档 key */
  const [reloadKey, setReloadKey] = useState(0);

  /** 正在拖的那一笔只存 ref：跟指针时不进 state，也就不会整屏重渲染 */
  const dragRef = useRef<DragState | null>(null);
  /** 亮着的那枚手柄（起手 / 松手各变一次，全程只两次渲染） */
  const [dragKey, setDragKey] = useState<string | null>(null);
  /** 拖动中的坐标读数：直接写 textContent，同样绕开 React */
  const readoutRef = useRef<HTMLSpanElement>(null);
  /** 贴住参考线时亮起的那两条细线（同样是拖动中直接改 style） */
  const guideXRef = useRef<HTMLSpanElement>(null);
  const guideYRef = useRef<HTMLSpanElement>(null);

  /** 小地图的尺寸：拖右下角改，记本地；没拖过就按 CSS 的 180（窄屏 142） */
  const [miniW, setMiniW] = useState<number | null>(() => {
    try {
      const v = Number(localStorage.getItem("matrix:preview:mini:size"));
      if (Number.isFinite(v) && v > 0) return v;
    } catch {
      /* 读不出来就用默认 */
    }
    return null;
  });
  const miniRef = useRef<HTMLDivElement | null>(null);
  const resizeRef = useRef<{ sx: number; w: number; max: number } | null>(null);
  const [resizing, setResizing] = useState(false);

  // 视口宽 → 缩放。只认宽：窗口一变重算一次缩放，不用重量页面。
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const read = () => setFrameW(el.clientWidth);
    const ro = new ResizeObserver(read);
    ro.observe(el);
    read();
    return () => ro.disconnect();
  }, []);

  // 只按**宽**缩：页面宽度铺满视口，纵向长出来就在视口里滚 —— 跟逛一个正常网页
  // 一样。早先是「整页（连整页高）一起塞进视口」，页面一长就被高度压扁，宽度跟着
  // 缩成一条窄柱、按钮糊成一粒沙。「一张图看全整页」那种活交给小地图和矩阵图谱。
  // 上限 1：不放大，免得把页面拉虚。
  const scale = Math.min(1, Math.max(MIN_SCALE, frameW / VW));
  const canvasW = Math.round(VW * scale);
  const canvasH = Math.round(pageH * scale);

  /** 在 iframe 里量出每个按钮此刻的位置，顺带把整页真实高度量回来 */
  const measure = useCallback(() => {
    const doc = frameDoc(iframeRef.current);
    if (!doc) {
      setNote(
        "这一页是沙箱页，读不到页面内部结构：只有已经固定位置的按钮能在这儿拖动。",
      );
      setHandles(
        outLinks
          .filter((l) => l.place.kind === "point")
          .map((l) => ({
            key: `${l.from}:${l.to}`,
            from: l.from,
            to: l.to,
            label: l.label,
            x: l.place.kind === "point" ? l.place.x : 50,
            y: l.place.kind === "point" ? l.place.y : 50,
          })),
      );
      return;
    }
    setNote("");

    const full = Math.max(
      doc.documentElement.scrollHeight,
      doc.body.scrollHeight,
      VH,
    );

    // 按钮按 (from,to) 这对键认领：一次扫全，省得转义属性选择器
    const found = collectButtons(doc);

    const next: Handle[] = [];
    for (const l of outLinks) {
      const key = `${l.from}:${l.to}`;
      const el = found.get(key);
      if (el) {
        const r = el.getBoundingClientRect();
        next.push({
          key,
          from: l.from,
          to: l.to,
          label: l.label,
          x: ((r.left + r.width / 2) / VW) * 100,
          y: ((r.top + r.height / 2) / full) * 100,
        });
      } else if (l.place.kind === "point") {
        // 页面上没找到（比如目标不可见），但存过坐标：先按存的摆
        next.push({
          key,
          from: l.from,
          to: l.to,
          label: l.label,
          x: l.place.x,
          y: l.place.y,
        });
      }
    }
    setHandles(next);
    setPageH(full);
  }, [outLinks]);

  /**
   * 量回来的页高要喂回 iframe，iframe 一高，vh 布局的页又量出更高的页高 ——
   * 正常页一两轮就稳（页高 ≥ 内容高即停），vh 页却会一轮轮往上追。给几轮收敛
   * 机会，追不出来就此打住，免得 setPageH ↔ measure 互相顶着把页面无限撑长。
   */
  const measurePass = useRef(0);
  // 换了页面 / 连线 / 重挂：收敛机会重置
  useEffect(() => {
    measurePass.current = 0;
  }, [measure, version, reloadKey]);

  // 页面加载完、或整页重挂后量一次；页面高度一变再量一次收敛（限几轮，见上）
  useEffect(() => {
    // 外站页压根没铺 iframe：frameDoc 读回来是 null，measure 会把它当成沙箱页
    // 报错。这儿直接不量，说明条留给页首那句「外站页没有本地正文」。
    if (me?.external) return;
    if (measurePass.current >= MEASURE_MAX) return;
    measurePass.current += 1;
    const raf = requestAnimationFrame(() => measure());
    return () => cancelAnimationFrame(raf);
  }, [me?.external, measure, pageH, version, reloadKey]);

  /**
   * 落点就地改到真身：同源页把那个按钮的 left/top 直接抹过去 —— 零网络、瞬时
   * 所见即所得，省掉一次整页重载。沙箱页读不到 DOM、或这按钮还不是绝对定位的
   * （锚点 / 兜底栏），返回 false，交给整页重挂兜底。
   */
  const patchPoint = useCallback(
    (from: string, to: string, x: number, y: number): boolean => {
      const doc = frameDoc(iframeRef.current);
      if (!doc) return false;
      const el = collectButtons(doc).get(`${from}:${to}`);
      if (!el || !el.classList.contains("mx-point")) return false;
      el.style.left = `${x}%`;
      el.style.top = `${y}%`;
      return true;
    },
    [],
  );

  /**
   * 吸附参考线：中线与四分位，外加同页别的按钮已经在用的那条线。
   * 拖的那一枚自己不参与 —— 不然它会一直贴回自己原来的位置。
   */
  const guides = useMemo(() => {
    const xs = [25, 50, 75];
    const ys = [25, 50, 75];
    for (const h of handles) {
      if (h.key === dragKey) continue;
      xs.push(round1(h.x));
      ys.push(round1(h.y));
    }
    return { xs, ys };
  }, [handles, dragKey]);
  /** 拖动中现读参考线：挂进 ref，免得它一变就把跟指针的监听重挂一遍 */
  const guidesRef = useRef(guides);
  useEffect(() => {
    guidesRef.current = guides;
  }, [guides]);

  /** 小地图右下角那枚缩放手柄：拖它改宽度（环等比放大，字跟着一起大） */
  const onGripDown = (e: ReactPointerEvent) => {
    e.preventDefault();
    e.stopPropagation(); // 别让容器把手势当成「把整块拖走」
    const el = miniRef.current;
    if (!el) return;
    const grip = e.currentTarget as HTMLElement;
    try {
      grip.setPointerCapture(e.pointerId);
    } catch {
      /* 捕获不住就退回 window 跟指针 */
    }
    // 上限按当前位置算：放大了也不该顶出屏幕
    const l = mini.pos?.x ?? 8;
    const t = mini.pos?.y ?? 8;
    const byW = window.innerWidth - l - 8;
    const byH = (window.innerHeight - t - 30) / (380 / 560);
    resizeRef.current = {
      sx: e.clientX,
      w: el.offsetWidth,
      max: Math.min(MAX_MINI, Math.max(MIN_MINI, Math.min(byW, byH))),
    };
    setResizing(true);
  };

  useEffect(() => {
    if (!resizing) return;
    const move = (e: PointerEvent) => {
      const r = resizeRef.current;
      const el = miniRef.current;
      if (!r || !el) return;
      el.style.width = `${Math.round(clamp(r.w + (e.clientX - r.sx), MIN_MINI, r.max))}px`;
    };
    const up = () => {
      const el = miniRef.current;
      resizeRef.current = null;
      setResizing(false);
      if (!el) return;
      const w = el.offsetWidth;
      setMiniW(w);
      try {
        localStorage.setItem("matrix:preview:mini:size", String(w));
      } catch {
        /* 隐私模式下写不了就不记 */
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
  }, [resizing]);

  // 拖拽：按下起手，window 上跟指针，松手写回。
  // 依赖只认「拖没拖」这个开关 —— 跟指针时全程只改 DOM、不进 state，
  // 所以这里不会每一帧拆一遍监听再挂回去。当前那笔从 dragRef 现读。
  const dragging = dragKey !== null;
  useEffect(() => {
    if (!dragging) return;
    document.body.classList.add("mx-dragging");
    let raf = 0;

    /** 指针位置 → 整页百分比（画布矩形是起手时存的，不在这里量） */
    const pct = (d: DragState) => {
      const r = d.rect;
      if (r.width <= 0 || r.height <= 0) return { x: d.x, y: d.y };
      return {
        x: clamp(((d.cx - r.left) / r.width) * 100, 0, 100),
        y: clamp(((d.cy - r.top) / r.height) * 100, 0, 100),
      };
    };

    /** 8px 换算到这一轴上的百分比（两轴尺度不同，得各算各的） */
    const tolPct = (size: number) => (size > 0 ? (SNAP_PX / size) * 100 : 0);

    /** 贴到最近的那条参考线；够不着就原样交回，顺便说明贴到了哪条 */
    const stick = (v: number, lines: number[], tol: number) => {
      let best = v;
      let hit: number | null = null;
      let bestD = tol;
      for (const g of lines) {
        const gap = Math.abs(v - g);
        if (gap <= bestD) {
          bestD = gap;
          best = g;
          hit = g;
        }
      }
      return { v: best, hit };
    };

    /** 落点定案：按住 Shift 就不吸附，否则贴参考线 */
    const resolve = (d: DragState) => {
      const raw = pct(d);
      if (d.free) return { x: raw.x, y: raw.y, hx: null, hy: null };
      const g = guidesRef.current;
      const rx = stick(raw.x, g.xs, tolPct(d.rect.width));
      const ry = stick(raw.y, g.ys, tolPct(d.rect.height));
      return { x: rx.v, y: ry.v, hx: rx.hit, hy: ry.hit };
    };

    // 一帧只落一次位：pointermove 在高刷屏 / 触控笔下一帧可能来好几发
    const paint = () => {
      raf = 0;
      const d = dragRef.current;
      if (!d) return;
      const p = resolve(d);
      d.x = p.x;
      d.y = p.y;
      d.el.style.left = `${(p.x / 100) * d.rect.width}px`;
      d.el.style.top = `${(p.y / 100) * d.rect.height}px`;
      if (readoutRef.current) {
        readoutRef.current.textContent = `${round1(p.x)}% ，${round1(p.y)}%`;
      }
      // 贴住的那条线亮起来（没贴就藏）—— 落点为什么「跳」一下就看得懂了
      const gx = guideXRef.current;
      if (gx) {
        gx.style.display = p.hx === null ? "none" : "block";
        if (p.hx !== null) gx.style.left = `${(p.hx / 100) * d.rect.width}px`;
      }
      const gy = guideYRef.current;
      if (gy) {
        gy.style.display = p.hy === null ? "none" : "block";
        if (p.hy !== null) gy.style.top = `${(p.hy / 100) * d.rect.height}px`;
      }
    };

    const move = (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      d.cx = e.clientX;
      d.cy = e.clientY;
      d.free = e.shiftKey;
      if (!d.moved) {
        // 先挪够阈值：不然点一下也成了拖动，白写一次落点
        if (
          Math.abs(e.clientX - d.sx) < THRESHOLD &&
          Math.abs(e.clientY - d.sy) < THRESHOLD
        )
          return;
        d.moved = true;
      }
      if (!raf) raf = requestAnimationFrame(paint);
    };

    const up = (e: PointerEvent) => {
      const d = dragRef.current;
      dragRef.current = null;
      if (raf) {
        cancelAnimationFrame(raf);
        raf = 0;
      }
      if (!d) {
        setDragKey(null);
        return;
      }
      try {
        d.el.releasePointerCapture(d.pointerId);
      } catch {
        /* 起手没捕获住也无妨，指针照样收在 window 上 */
      }
      if (!d.moved) {
        // 只是点了一下：不提交、不重载 —— 手柄本来就没动过，页面纹丝不动
        setDragKey(null);
        return;
      }
      d.free = e.shiftKey;
      const p = resolve(d);
      const x = round1(clamp(p.x, 0, 100));
      const y = round1(clamp(p.y, 0, 100));
      // 真身先就位（瞬时），再让手柄停在落点；measure 随后按真身校正
      if (!patchPoint(d.from, d.to, x, y)) setReloadKey((k) => k + 1);
      setHandles((prev) =>
        prev.map((h) => (h.key === d.key ? { ...h, x, y } : h)),
      );
      setDragKey(null);
      onMove(d.from, d.to, x, y);
    };

    /**
     * 画布矩形是起手时存下的，为的是不在每帧里量一次。可它一旦动了就不作数了：
     * 拖动中还能滚滚轮（指针捕获不挡滚轮），窗口也可能被拽着改大小 —— 那时
     * 百分比会整体偏掉。这种时候重取一下，代价只在真动的那几下。
     */
    const refreshRect = () => {
      const el = canvasRef.current;
      const d = dragRef.current;
      if (el && d) d.rect = el.getBoundingClientRect();
    };

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    // scroll 不冒泡，得在捕获阶段听，才收得到视口自己滚的那几下
    window.addEventListener("scroll", refreshRect, true);
    window.addEventListener("resize", refreshRect);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      window.removeEventListener("scroll", refreshRect, true);
      window.removeEventListener("resize", refreshRect);
      if (raf) cancelAnimationFrame(raf);
      document.body.classList.remove("mx-dragging");
    };
  }, [dragging, onMove, patchPoint]);

  const beginDrag = (h: Handle, e: ReactPointerEvent) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) return;
    e.preventDefault();
    const el = e.currentTarget as HTMLElement;
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      /* 捕获不住就退回 window 跟指针 */
    }
    dragRef.current = {
      key: h.key,
      from: h.from,
      to: h.to,
      x: h.x,
      y: h.y,
      rect,
      el,
      pointerId: e.pointerId,
      sx: e.clientX,
      sy: e.clientY,
      cx: e.clientX,
      cy: e.clientY,
      moved: false,
      free: e.shiftKey,
    };
    setDragKey(h.key);
  };

  if (!me) {
    return <p className="empty-sm">这一页已经不在矩阵里了。</p>;
  }

  return (
    <div className="mp-wrap">
      {/* 页面本体铺满整屏（下层），工作台的顶栏与左导航浮在它上面（上层）。
          这一层不再自带工具条 —— 它没有「全屏 / 退出」，进来就是整屏这一页。 */}
      <div className="mp-stage">
        <div className="mp-viewport" ref={viewportRef}>
          {me.external ? (
            <p className="empty-sm">
              外站页没有本地正文，摆不进这个画框 —— 它的按钮在别的站点上。
            </p>
          ) : (
            <div
              className="mp-canvas"
              ref={canvasRef}
              style={{ width: canvasW, height: canvasH }}
            >
              <iframe
                key={`${version}:${reloadKey}`}
                ref={iframeRef}
                className="mp-frame"
                title={`预览 /${me.path}`}
                src={`/${me.path}`}
                onLoad={() => requestAnimationFrame(() => measure())}
                style={{
                  width: VW,
                  height: pageH,
                  transform: `scale(${scale})`,
                }}
              />

              {/* 手柄层：不跟着画布缩放，于是手柄大小恒定、好抓。
                  编辑关着就整层不铺 —— 看页面的时候不该有一堆浮块压在上面 */}
              {editing && (
                <div className="mp-handles">
                  {/* 吸附参考线：贴在底下，贴着哪条就露哪条（由 paint 直接开合） */}
                  {dragKey !== null && (
                    <>
                      <span className="mp-guide mp-guide-x" ref={guideXRef} />
                      <span className="mp-guide mp-guide-y" ref={guideYRef} />
                    </>
                  )}
                  {handles.map((h) => (
                    <button
                      key={h.key}
                      type="button"
                      className={`mp-handle${dragKey === h.key ? " on" : ""}`}
                      style={{
                        left: (h.x / 100) * canvasW,
                        top: (h.y / 100) * canvasH,
                      }}
                      title={`拖到新位置：${h.label}`}
                      onPointerDown={(e) => beginDrag(h, e)}
                    >
                      <span className="mp-handle-dot" />
                      <span className="mp-handle-label">{h.label}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {/* 左上角的小地图：就是这间房的环，缩成一枚徽章。它不只是个摆件 ——
            点环上的门就走到那间（上层收干净后，它是唯一的连续跳转口）。
            整枚能拖：拖过了记本地，没拖过就按 CSS 让开顶栏与左栏 */}
        <div
          className={`mp-mini${mini.dragging ? " dragging" : ""}`}
          ref={(el) => {
            mini.bind(el);
            miniRef.current = el;
          }}
          style={{
            // 记下的尺寸可能是在宽屏上调的：到窄屏上得让一让，别顶出界
            ...(miniW ? { width: `min(${miniW}px, calc(100vw - 24px))` } : null),
            ...(mini.pos
              ? {
                  left: mini.pos.x,
                  top: mini.pos.y,
                  right: "auto",
                  bottom: "auto",
                }
              : null),
          }}
          title="点门就走；按住可挪开，右下角可缩放"
          onPointerDown={mini.onPointerDown}
          onClickCapture={mini.guardCapture}
        >
          {/* 不接 onOpen：预览里中心那块正好在手边，一抬手就点着，
              白白把人推进编辑器 —— 这儿只要「点门就走」 */}
          <RoomRing
            pages={pages}
            links={links}
            currentId={currentId}
            onWalk={onWalk}
            className="mp-mini-ring"
          />
          <span className="mp-mini-tag">小地图</span>
          {/* 右下角：拖它改大小。环等比放大，门上的字跟着一起大 —— 180px 时
              那些字只有三四个像素，想看清就得把它放大 */}
          <span
            className="mp-mini-grip"
            title="拖动缩放"
            onPointerDown={onGripDown}
          />
        </div>

        {/* 拖动中的落点读数：内容由 paint 直接写 textContent，不经过 React */}
        {dragKey !== null && <span className="mp-coord" ref={readoutRef} />}
      </div>

      {/* 页面铺满整屏，说明文字没处安放，就做成一枚浮在底边的小条。
          外站页没有手柄可拖，别拿「拖浮块」这句话去糊它 */}
      {(busy || note || (editing && !me.external)) && (
        <p className="dim mp-note">
          {busy ? "保存中…" : note || "拖动浮块改按钮落点，松手即存"}
        </p>
      )}
    </div>
  );
}
