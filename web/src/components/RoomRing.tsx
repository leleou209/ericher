import type { MatrixAccess, MatrixLink, MatrixPage } from "../lib/types";

/**
 * 房间环 —— 站在某间房里看它周围一圈门。
 *
 * 这是「房间视角」那张图的纯展示件：环形均布的门、从中心卡片拉出去的连线、
 * 门上的文字与虚实。抽出来是为了两处共用同一份：右边的大预览（房间视图），
 * 以及页面预览模式左上角那枚迷你图（当小地图用，点它回房间）。
 *
 * 摆门规则：门先按「双向 → 只出 → 只回」分组，组内按标题排，从正上方顺时针
 * 摆开 —— 同一间房每次进来摆法都一样，位置记住了就能当路标。这里只画与当前
 * 房间有关的这一圈，门与门之间不连线（那是全景图的活）。
 */
export const W = 560;
export const H = 380;
export const CX = W / 2;
export const CY = H / 2;
/** 环半径：够大，又给门的卡片留出上下边距 */
const RING = 148;
/** 中心卡片 = 当前房间 */
const CARD_W = 128;
const CARD_H = 48;
/** 门卡片的最大尺寸；门多了会按弦长收窄，见 dw */
const DOOR_W = 112;
const DOOR_H = 40;
/** 「开一扇门」虚位：钉在画布右下角，不参与环形排队 —— 环上有门经过就会压成一团 */
const GHOST_W = 96;
const GHOST_H = 34;
const GHOST_PAD = 12;

export const ACCESS_LABEL: Record<MatrixAccess, string> = {
  public: "公开",
  visitor: "持票来客",
  admin: "管理员",
  types: "指定档位",
};

/** 一间房在环上的门：对面那一页，加上两个方向的按钮 */
export interface Door {
  page: MatrixPage;
  /** 我这页里的那个按钮（我 → 它）。没有 = 只能来、出不去 */
  out?: MatrixLink;
  /** 它那页里指回我的按钮（它 → 我）。可能不止一个；空 = 出得去、它回不来 */
  back: MatrixLink[];
}

/** 站在 me 这页看它与谁相邻：出边、入边按对面那一页合并成一扇门 */
export function doorsOf(
  me: string,
  links: MatrixLink[],
  byId: Map<string, MatrixPage>,
): Door[] {
  const map = new Map<string, Door>();
  const at = (p: MatrixPage): Door => {
    let d = map.get(p.id);
    if (!d) {
      d = { page: p, back: [] };
      map.set(p.id, d);
    }
    return d;
  };
  for (const l of links) {
    if (l.from === me) {
      const p = byId.get(l.to);
      if (p) at(p).out = l;
    } else if (l.to === me) {
      const p = byId.get(l.from);
      if (p) at(p).back.push(l);
    }
  }
  // 双向的门信息最全，排前面；只出的次之，只回的收尾。组内按标题定序
  const rank = (d: Door) => (d.out && d.back.length ? 0 : d.out ? 1 : 2);
  const name = (d: Door) => d.page.title || d.page.path;
  return [...map.values()].sort(
    (a, b) => rank(a) - rank(b) || name(a).localeCompare(name(b)),
  );
}

/**
 * 从矩形中心沿单位方向 (ux,uy) 走到矩形边界的距离 —— 连线两端靠它贴到卡片边，
 * 而不是穿进卡片里。传单位向量才得到真正的距离。
 */
function edgeDist(ux: number, uy: number, w: number, h: number): number {
  const ax = Math.abs(ux);
  const ay = Math.abs(uy);
  const tx = ax > 1e-6 ? w / 2 / ax : Infinity;
  const ty = ay > 1e-6 ? h / 2 / ay : Infinity;
  return Math.min(tx, ty);
}

/**
 * 估宽截断：SVG 没有 text-overflow，只能自己算。中日韩按 1em、其余按 0.56em 估，
 * 超了就砍到能放下再缀一个省略号。
 */
export function fit(text: string, maxPx: number, fontPx: number): string {
  const wide = (s: string) =>
    [...s].reduce((w, c) => w + (/[\u2e80-\uffef]/.test(c) ? 1 : 0.56), 0) *
    fontPx;
  if (wide(text) <= maxPx) return text;
  let out = "";
  for (const c of text) {
    if (wide(out + c) > maxPx - fontPx) break;
    out += c;
  }
  return out + "…";
}

export function RoomRing({
  pages,
  links,
  currentId,
  onWalk,
  onOpen,
  onGhost,
  interactive = true,
  className = "mr-room",
}: {
  pages: MatrixPage[];
  links: MatrixLink[];
  currentId: string;
  /** 点一扇门：走到对面那间 */
  onWalk: (id: string) => void;
  /** 点中心卡片：打开当前这间的编辑器 */
  onOpen: (p: MatrixPage) => void;
  /** 点右下角虚位。不传就不画虚位（迷你图用不上） */
  onGhost?: () => void;
  /** false = 纯展示（迷你图），不吃鼠标事件 */
  interactive?: boolean;
  className?: string;
}) {
  const byId = new Map(pages.map((p) => [p.id, p]));
  const me = byId.get(currentId);
  const doors = doorsOf(currentId, links, byId);
  const n = doors.length;
  const angles = doors.map((_, i) => -Math.PI / 2 + (i * 2 * Math.PI) / n);
  // 门多了环上会挤：按弦长收一收宽度，宁可窄一点，也不叠在一起
  const chord = n > 1 ? 2 * RING * Math.sin(Math.PI / n) : DOOR_W;
  const dw = Math.round(Math.min(DOOR_W, Math.max(74, chord * 0.88)));
  const ghost = !!onGhost;
  const openableCount = pages.filter(
    (p) => p.id !== currentId && !doors.some((d) => d.page.id === p.id),
  ).length;

  if (!me) return null;

  return (
    <svg
      className={className}
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-label="这间房与它的门"
      style={interactive ? undefined : { pointerEvents: "none" }}
    >
      <defs>
        {/* 出得去的门用实心箭头，来路用浅色箭头；auto-start-reverse 让同一个
            图形在末尾朝外、在开头也朝外 */}
        <marker
          id="mr-arrow-out"
          viewBox="0 0 8 8"
          refX="7.5"
          refY="4"
          markerWidth="7"
          markerHeight="7"
          orient="auto-start-reverse"
        >
          <path d="M0,0 L8,4 L0,8 z" fill="var(--yuzhe-ink-strong)" />
        </marker>
        <marker
          id="mr-arrow-back"
          viewBox="0 0 8 8"
          refX="7.5"
          refY="4"
          markerWidth="6"
          markerHeight="6"
          orient="auto-start-reverse"
        >
          <path d="M0,0 L8,4 L0,8 z" fill="var(--yuzhe-line-strong)" />
        </marker>
      </defs>

      {doors.map((d, i) => {
        const a = angles[i];
        const x = CX + Math.cos(a) * RING;
        const y = CY + Math.sin(a) * RING;
        const dx = x - CX;
        const dy = y - CY;
        const dist = Math.hypot(dx, dy) || 1;
        const ux = dx / dist;
        const uy = dy / dist;
        const x1 = CX + ux * edgeDist(ux, uy, CARD_W, CARD_H);
        const y1 = CY + uy * edgeDist(ux, uy, CARD_W, CARD_H);
        const x2 = x - ux * edgeDist(ux, uy, dw, DOOR_H);
        const y2 = y - uy * edgeDist(ux, uy, dw, DOOR_H);
        const glyph = d.out && d.back.length ? "↔" : d.out ? "→" : "←";
        const title = fit(
          d.out?.label || d.back[0]?.label || d.page.title || d.page.path,
          dw - 12,
          11.5,
        );
        const cls = ["mr-door"];
        // 只进不出：虚线边框 —— 这扇门的另一头没有回头路
        if (!d.out) cls.push("noreturn");
        if (d.page.entry) cls.push("entry");
        return (
          <g key={d.page.id}>
            <line
              className={`mr-link${d.out ? "" : " back"}`}
              x1={x1}
              y1={y1}
              x2={x2}
              y2={y2}
              markerEnd={d.out ? "url(#mr-arrow-out)" : undefined}
              markerStart={d.back.length ? "url(#mr-arrow-back)" : undefined}
            />
            <g className="mr-door-hit" onClick={() => onWalk(d.page.id)}>
              <title>走进 /{d.page.path}</title>
              <rect
                className={cls.join(" ")}
                x={x - dw / 2}
                y={y - DOOR_H / 2}
                width={dw}
                height={DOOR_H}
                rx={8}
              />
              <text
                className="mr-door-title"
                x={x}
                y={y - 5}
                textAnchor="middle"
                dominantBaseline="central"
              >
                {title}
              </text>
              <text
                className="mr-door-sub"
                x={x}
                y={y + 10}
                textAnchor="middle"
                dominantBaseline="central"
              >
                {glyph} /{fit(d.page.path || "", dw - 12, 9.5)}
              </text>
            </g>
          </g>
        );
      })}

      {/* 还有没连上的页 → 右下角钉一个虚位。早先它排在环上「最大的那段空档」里，
          可空档是按角度量的、门是按矩形画的，门一多就压到旁边的门上；角落永远空着 */}
      {ghost && openableCount > 0 && (
        <g className="mr-door-hit" onClick={() => onGhost?.()}>
          <title>在这儿开一扇门</title>
          <rect
            className="mr-ghost"
            x={W - GHOST_PAD - GHOST_W}
            y={H - GHOST_PAD - GHOST_H}
            width={GHOST_W}
            height={GHOST_H}
            rx={8}
          />
          <text
            className="mr-ghost-text"
            x={W - GHOST_PAD - GHOST_W / 2}
            y={H - GHOST_PAD - GHOST_H / 2}
            textAnchor="middle"
            dominantBaseline="central"
          >
            ＋ 开一扇门
          </text>
        </g>
      )}

      {/* 中心：你现在站着的这间房 */}
      <g className="mr-door-hit" onClick={() => onOpen(me)}>
        <title>点开编辑器</title>
        <rect
          className={`mr-card${me.entry ? " entry" : ""}`}
          x={CX - CARD_W / 2}
          y={CY - CARD_H / 2}
          width={CARD_W}
          height={CARD_H}
          rx={10}
        />
        <text
          className="mr-card-title"
          x={CX}
          y={CY - 6}
          textAnchor="middle"
          dominantBaseline="central"
        >
          {fit(me.title || me.path || "首页", CARD_W - 14, 12)}
        </text>
        <text
          className="mr-card-sub"
          x={CX}
          y={CY + 10}
          textAnchor="middle"
          dominantBaseline="central"
        >
          {fit(`/${me.path || ""} · ${ACCESS_LABEL[me.access]}`, CARD_W - 10, 9.5)}
        </text>
      </g>
    </svg>
  );
}
