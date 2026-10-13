// 浮窗拖拽：把一枚浮在页面上的小窗拖到哪儿，就记在哪儿。
//
// 预览面是整屏的一页，浮在它上面的小地图与导航胶囊都可能压住正文 —— 所以让人
// 能拖开，落点按 key 存进本地，下次进来还是自己挪到的位置。
//
// 两种位置分得清：**没拖过 = 位置交给 CSS**（`pos` 是 null，CSS 里那套「让开顶栏
// 与左栏」的规则照常生效），**拖过之后 = 内联 px 说了算**。不然一上来就被内联
// 坐标钉死，CSS 里那套让位规则就成了摆设。

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";

export interface DragPos {
  x: number;
  y: number;
}

/** 拖动前先得挪出这么多像素，才认作「在拖」而不是「点了一下」 */
const THRESHOLD = 3;

function read(key: string): DragPos | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const v = JSON.parse(raw) as DragPos;
    if (Number.isFinite(v?.x) && Number.isFinite(v?.y)) return { x: v.x, y: v.y };
  } catch {
    /* 读不出来就当没拖过 */
  }
  return null;
}

export function useDragPos(key: string) {
  const [pos, setPos] = useState<DragPos | null>(() => read(key));
  const [dragging, setDragging] = useState(false);
  /** 元素本身：夹回视口要量它的宽高 */
  const elRef = useRef<HTMLElement | null>(null);
  /** 按下那一刻的落点差与起点坐标 */
  const grabRef = useRef<{ dx: number; dy: number; sx: number; sy: number } | null>(
    null,
  );
  /** 这一轮按下的挪动量过没过阈值。松手后点击才跟着来，所以它得活到下一次按下 */
  const movedRef = useRef(false);

  /** 夹回视口：留 4px 边，别让人拖到屏幕外抓不回来 */
  const clamp = useCallback((p: DragPos): DragPos => {
    const el = elRef.current;
    const maxX = Math.max(4, window.innerWidth - (el?.offsetWidth || 0) - 4);
    const maxY = Math.max(4, window.innerHeight - (el?.offsetHeight || 0) - 4);
    return {
      x: Math.min(maxX, Math.max(4, p.x)),
      y: Math.min(maxY, Math.max(4, p.y)),
    };
  }, []);

  const bind = useCallback((el: HTMLElement | null) => {
    elRef.current = el;
  }, []);

  const onPointerDown = useCallback((e: ReactPointerEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    elRef.current = e.currentTarget as HTMLElement;
    movedRef.current = false;
    grabRef.current = {
      dx: e.clientX - r.left,
      dy: e.clientY - r.top,
      sx: e.clientX,
      sy: e.clientY,
    };
    setDragging(true);
  }, []);

  useEffect(() => {
    if (!dragging) return;
    const move = (e: PointerEvent) => {
      const g = grabRef.current;
      if (!g) return;
      if (!movedRef.current) {
        // 先挪够阈值：不然点一下也成了拖动，里面的按钮就点不动了
        if (
          Math.abs(e.clientX - g.sx) < THRESHOLD &&
          Math.abs(e.clientY - g.sy) < THRESHOLD
        )
          return;
        movedRef.current = true;
      }
      setPos(clamp({ x: e.clientX - g.dx, y: e.clientY - g.dy }));
    };
    const up = () => {
      grabRef.current = null;
      setDragging(false);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    // 触屏手势被系统接管 / 指针丢捕获时收不到 pointerup：不跟上这一下，
    // dragging 会一直挂着，之后随便挪一下鼠标浮窗就自己跟着走
    window.addEventListener("pointercancel", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
  }, [clamp, dragging]);

  // 窗口一缩，浮窗可能就悬到屏幕外了：拉回可见范围
  useEffect(() => {
    const onResize = () => setPos((p) => (p ? clamp(p) : p));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [clamp]);

  // 落定才记：拖的过程里每一帧都写本地太吵
  useEffect(() => {
    if (dragging || !pos) return;
    try {
      localStorage.setItem(key, JSON.stringify(pos));
    } catch {
      /* 隐私模式下写不了就不记 */
    }
  }, [dragging, key, pos]);

  /** 刚拖完的那一下不算点击：否则拖开浮窗会顺手把它自己的按钮按了 */
  const click = useCallback(
    (fn: () => void) => () => {
      if (movedRef.current) return;
      fn();
    },
    [],
  );

  /**
   * 挂在容器的**捕获**阶段：这一枚浮窗里可能全是可点的东西（小地图的每扇门都是
   * 一个 onClick），只靠上面那个 click 包不住 —— 从门上下手拖走，松手时浏览器
   * 还会补一次 click，人就莫名其妙跳走了。捕获阶段一刀切掉，比逐个包干净。
   */
  const guardCapture = useCallback((e: ReactMouseEvent) => {
    if (!movedRef.current) return;
    e.stopPropagation();
    e.preventDefault();
  }, []);

  return { pos, dragging, bind, onPointerDown, click, guardCapture };
}
