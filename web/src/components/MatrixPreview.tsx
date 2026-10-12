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
 * 才看得见。所以这一屏把真身整页等比铺满视口：底下是这一页（带矩阵已注入的
 * 按钮），左上角留一枚房间环当小地图 —— 上层收干净之后，就靠这枚小地图连续
 * 跳转：点它上面的门就走过去，跟站在大图里点门是一个意思。
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
/** 视口高的兜底值：只在刚挂上、还没量到真实高度的那一瞬用一下 */
const FRAME_H = 460;
/** 缩放下限：长页面塞不满就让它溢出、视口里滚动，免得按钮缩成一粒沙 */
const MIN_SCALE = 0.22;

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

interface Drag extends Handle {}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

export function MatrixPreview({
  pages,
  links,
  currentId,
  busy,
  version,
  editing,
  onWalk,
  onOpen,
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
  /** 小地图上点中心卡片：打开当前这页的编辑器 */
  onOpen: (p: MatrixPage) => void;
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
  const outKey = outLinks
    .map((l) => `${l.from}:${l.to}:${l.label}:${l.order}:${JSON.stringify(l.place)}`)
    .join("|");

  const viewportRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [frameW, setFrameW] = useState(760);
  /** 可视高：预览铺满整屏，就是量出来的那片视口 */
  const [frameH, setFrameH] = useState(FRAME_H);
  const [pageH, setPageH] = useState(VH);
  const [handles, setHandles] = useState<Handle[]>([]);
  const [note, setNote] = useState("");

  const dragRef = useRef<Drag | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);

  // 视口尺寸 → 缩放；宽高变了只重算缩放，不用重量页面。
  // 窗口一改，量到的新高度直接进缩放比，页面立刻重新铺满。
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const read = () => {
      setFrameW(el.clientWidth);
      setFrameH(el.clientHeight || FRAME_H);
    };
    const ro = new ResizeObserver(read);
    ro.observe(el);
    read();
    return () => ro.disconnect();
  }, []);

  const fit = Math.min(frameW / VW, frameH / pageH);
  const scale = Math.max(MIN_SCALE, fit);
  const canvasW = Math.round(VW * scale);
  const canvasH = Math.round(pageH * scale);

  /** 在 iframe 里量出每个按钮此刻的位置，顺带把整页真实高度量回来 */
  const measure = useCallback(() => {
    const ifr = iframeRef.current;
    if (!ifr) return;
    let doc: Document | null = null;
    try {
      doc = ifr.contentDocument;
      void doc?.body;
    } catch {
      doc = null; // 不透明源（沙箱页）：读不到就算了，下面按存坐标降级
    }
    if (!doc || !doc.body) {
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
    const found = new Map<string, HTMLElement>();
    doc
      .querySelectorAll<HTMLElement>("[data-mx-from][data-mx-to]")
      .forEach((el) => {
        const f = el.getAttribute("data-mx-from") || "";
        const t = el.getAttribute("data-mx-to") || "";
        if (f && t) found.set(`${f}:${t}`, el);
      });

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

  // 页面加载完、或整页重挂后量一次；页面高度变化（vh 页重排）后再量一次收敛
  useEffect(() => {
    const raf = requestAnimationFrame(() => measure());
    return () => cancelAnimationFrame(raf);
  }, [measure, pageH, version]);

  // 拖拽：按下起手，window 上跟指针，松手写回。
  // 依赖只认「拖没拖」这个开关、不认 drag 本身 —— 跟指针时会不停 setDrag，
  // 依赖里挂着 drag 就等于每一帧拆一遍监听再挂回去。当前那笔从 dragRef 现读。
  const dragging = !!drag;
  useEffect(() => {
    if (!dragging) return;
    const move = (e: PointerEvent) => {
      const rect = canvasRef.current?.getBoundingClientRect();
      const d = dragRef.current;
      if (!rect || !d || rect.width <= 0 || rect.height <= 0) return;
      const x = clamp(((e.clientX - rect.left) / rect.width) * 100, 0, 100);
      const y = clamp(((e.clientY - rect.top) / rect.height) * 100, 0, 100);
      const next = { ...d, x, y };
      dragRef.current = next;
      setDrag(next);
    };
    const up = () => {
      const d = dragRef.current;
      dragRef.current = null;
      setDrag(null);
      if (d) onMove(d.from, d.to, round1(d.x), round1(d.y));
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  }, [dragging, onMove]);

  const beginDrag = (h: Handle, e: ReactPointerEvent) => {
    e.preventDefault();
    const d: Drag = { ...h };
    dragRef.current = d;
    setDrag(d);
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
                key={version}
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
                  {handles.map((h) => {
                    const at = drag?.key === h.key ? drag : h;
                    return (
                      <button
                        key={h.key}
                        type="button"
                        className={`mp-handle${drag?.key === h.key ? " on" : ""}`}
                        style={{
                          left: (at.x / 100) * canvasW,
                          top: (at.y / 100) * canvasH,
                        }}
                        title={`拖到新位置：${h.label}`}
                        onPointerDown={(e) => beginDrag(h, e)}
                      >
                        <span className="mp-handle-dot" />
                        <span className="mp-handle-label">{h.label}</span>
                      </button>
                    );
                  })}
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
          ref={mini.bind}
          style={
            mini.pos
              ? {
                  left: mini.pos.x,
                  top: mini.pos.y,
                  right: "auto",
                  bottom: "auto",
                }
              : undefined
          }
          title="点门就走，按住可挪开"
          onPointerDown={mini.onPointerDown}
          onClickCapture={mini.guardCapture}
        >
          <RoomRing
            pages={pages}
            links={links}
            currentId={currentId}
            onWalk={onWalk}
            onOpen={onOpen}
            className="mp-mini-ring"
          />
          <span className="mp-mini-tag">小地图</span>
        </div>
      </div>

      {/* 页面铺满整屏，说明文字没处安放，就做成一枚浮在底边的小条 */}
      {(busy || note || editing) && (
        <p className="dim mp-note">
          {busy ? "保存中…" : note || "拖动浮块改按钮落点，松手即存"}
        </p>
      )}
    </div>
  );
}
