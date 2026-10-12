import { useCallback, useEffect, useMemo } from "react";
import {
  Background,
  BackgroundVariant,
  BaseEdge,
  Controls,
  EdgeLabelRenderer,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  getStraightPath,
  useEdgesState,
  useNodesState,
  type Connection,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeMouseHandler,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { LinkPlace, MatrixLink, MatrixPage } from "../lib/types";

/**
 * 网页矩阵的全景图（可编辑）。
 *
 * 页面 = 节点，通路 = 有向边：A 页里的一个按钮就是一条 A→B 的线。允许回头
 * （B→A），也允许一页有复数条出边，所以画的是一张普通的**有向图**，不是树 ——
 * 树只是路径的前缀关系，跟「谁能到谁」是两回事。
 *
 * 图画在 React Flow 上：从节点右侧的小圆点拖到另一节点即可连线（后端按
 * (from,to) 落库），连线上的 × 断开一条，点节点打开编辑器。节点位置只存在
 * 本地 state 里，不进库 —— 布局是给人看关系的，不是页面的属性。
 */

/** 节点尺寸：CSS 里 .mx-node 的宽度要跟这里对上 */
const NODE_W = 168;
const NODE_H = 64;
/** 布局画布：力导向收敛后再裁进这个范围，React Flow 的 fitView 会自己缩放到容器 */
const CANVAS_W = 1120;
const CANVAS_H = 720;

interface PageNodeData extends Record<string, unknown> {
  page: MatrixPage;
  out: number;
  inn: number;
}
type PageNode = Node<PageNodeData, "page">;

interface LinkEdgeData extends Record<string, unknown> {
  place: LinkPlace;
  /** 反向也有一条（互相指）：两条直线会重在一起，标签得各偏一点让开 */
  mutual: boolean;
  /** 断开这条通路 —— 由面板注入，边自己不碰接口 */
  onCut: () => void;
}
type LinkEdge = Edge<LinkEdgeData, "link">;

/**
 * 力导向布局：先按索引一条圆环撒点（确定性、可复现），再迭代 —— 所有点两两
 * 相斥，有边相连的两点相吸，逐步降温收敛。矩阵页是位数量级，手算足够快。
 * 返回每个页面节点的左上角坐标（React Flow 的 position 就是左上角）。
 */
function layoutPages(
  pages: MatrixPage[],
  links: MatrixLink[],
): Map<string, { x: number; y: number }> {
  const pos = new Map<string, { x: number; y: number }>();
  const n = pages.length;
  if (!n) return pos;

  const at = new Map(pages.map((p, i) => [p.id, i]));
  const px: number[] = [];
  const py: number[] = [];
  pages.forEach((_, i) => {
    const a = (i / n) * Math.PI * 2 - Math.PI / 2;
    px.push(CANVAS_W / 2 + Math.cos(a) * CANVAS_W * 0.28);
    py.push(CANVAS_H / 2 + Math.sin(a) * CANVAS_H * 0.3);
  });

  const edges = links
    .map((l) => [at.get(l.from), at.get(l.to)] as const)
    .filter(([a, b]) => a !== undefined && b !== undefined && a !== b) as [
    number,
    number,
  ][];

  const k = Math.sqrt((CANVAS_W * CANVAS_H) / n) * 1.15;
  let temp = CANVAS_W * 0.1;
  for (let it = 0; it < 300; it++) {
    const dx: number[] = new Array(n).fill(0);
    const dy: number[] = new Array(n).fill(0);

    for (let i = 0; i < n; i++)
      for (let j = i + 1; j < n; j++) {
        let vx = px[i] - px[j];
        let vy = py[i] - py[j];
        const d = Math.hypot(vx, vy) || 0.01;
        const f = (k * k) / d;
        vx = (vx / d) * f;
        vy = (vy / d) * f;
        dx[i] += vx;
        dy[i] += vy;
        dx[j] -= vx;
        dy[j] -= vy;
      }

    for (const [a, b] of edges) {
      let vx = px[a] - px[b];
      let vy = py[a] - py[b];
      const d = Math.hypot(vx, vy) || 0.01;
      const f = (d * d) / k;
      vx = (vx / d) * f;
      vy = (vy / d) * f;
      dx[a] -= vx;
      dy[a] -= vy;
      dx[b] += vx;
      dy[b] += vy;
    }

    for (let i = 0; i < n; i++) {
      const d = Math.hypot(dx[i], dy[i]) || 0.01;
      const step = Math.min(d, temp);
      px[i] += (dx[i] / d) * step;
      py[i] += (dy[i] / d) * step;
    }
    temp *= 0.985;
  }

  pages.forEach((p, i) => {
    pos.set(p.id, {
      x: Math.min(CANVAS_W - NODE_W, Math.max(0, px[i] - NODE_W / 2)),
      y: Math.min(CANVAS_H - NODE_H, Math.max(0, py[i] - NODE_H / 2)),
    });
  });
  return pos;
}

/** 建节点：位置优先沿用已有（用户拖过的别跳回去），没有才用布局算的 */
function buildNodes(
  pages: MatrixPage[],
  links: MatrixLink[],
  prev: PageNode[] = [],
): PageNode[] {
  const known = new Map(prev.map((n) => [n.id, n.position]));
  const pos = layoutPages(pages, links);

  const deg = new Map<string, { out: number; inn: number }>();
  for (const p of pages) deg.set(p.id, { out: 0, inn: 0 });
  for (const l of links) {
    const a = deg.get(l.from);
    const b = deg.get(l.to);
    if (a) a.out++;
    if (b) b.inn++;
  }

  return pages.map((p) => ({
    id: p.id,
    type: "page" as const,
    position: known.get(p.id) ?? pos.get(p.id) ?? { x: 0, y: 0 },
    data: {
      page: p,
      out: deg.get(p.id)?.out ?? 0,
      inn: deg.get(p.id)?.inn ?? 0,
    },
    // 删节点意味着删页面 —— 那是编辑器的事，图上不许误删
    deletable: false,
  }));
}

/** 建边：两端页面都在才画（悬空连线不渲染，等页面回来再说） */
function buildEdges(
  links: MatrixLink[],
  ids: Set<string>,
  onUnlink: (from: string, to: string) => void,
): LinkEdge[] {
  const pairs = new Set(links.map((l) => `${l.from}|${l.to}`));
  return links
    .filter((l) => ids.has(l.from) && ids.has(l.to))
    .map((l) => ({
      id: `${l.from}|${l.to}`,
      type: "link" as const,
      source: l.from,
      target: l.to,
      label: l.label,
      data: {
        place: l.place,
        mutual: pairs.has(`${l.to}|${l.from}`),
        onCut: () => onUnlink(l.from, l.to),
      },
      markerEnd: {
        type: MarkerType.ArrowClosed,
        color: "var(--yuzhe-line-strong)",
      },
    }));
}

/** 节点：一小张卡片；入口页实心黑（跟面板里「公开」同一个签名用法） */
function PageNodeView({ data, selected }: NodeProps<PageNode>) {
  const p = data.page;
  const cls = ["mx-node"];
  if (p.entry) cls.push("entry");
  if (p.access === "admin") cls.push("admin");
  else if (p.access === "types") cls.push("types");
  if (p.external) cls.push("ext");
  if (selected) cls.push("sel");
  return (
    <>
      <Handle type="target" position={Position.Left} className="mx-handle" />
      <div className={cls.join(" ")}>
        <div className="mx-node-title">
          {p.title || p.path || "首页"}
          {p.external && <span className="mx-node-ext">↗</span>}
        </div>
        <div className="mx-node-path">/{p.path || ""}</div>
        <div className="mx-node-deg">
          出 {data.out} · 入 {data.inn}
        </div>
      </div>
      <Handle type="source" position={Position.Right} className="mx-handle" />
    </>
  );
}

/** 边：两点之间一条直线 + 箭头 + 按钮文字；文字旁边挂一个 × 用来断开 */
function LinkEdgeView({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  label,
  selected,
  markerEnd,
  data,
}: EdgeProps<LinkEdge>) {
  const [path, labelX, labelY] = getStraightPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
  });

  // 互相指的两条是两条方向相反的直线，中点重合 —— 标签沿法线各偏一边让开
  const dx = targetX - sourceX;
  const dy = targetY - sourceY;
  const len = Math.hypot(dx, dy) || 1;
  const off = data?.mutual ? 13 : 0;
  const lx = labelX + (-dy / len) * off;
  const ly = labelY + (dx / len) * off;

  return (
    <>
      <BaseEdge id={id} path={path} markerEnd={markerEnd} />
      <EdgeLabelRenderer>
        <div
          className={`mx-edge${selected ? " sel" : ""}`}
          style={{
            // 标签是挂在视口上的绝对定位层，得显式放开指针事件才点得到
            pointerEvents: "all",
            transform: `translate(-50%, -50%) translate(${lx}px,${ly}px)`,
          }}
        >
          <span className="mx-edge-label">{label}</span>
          <button
            type="button"
            className="mx-edge-cut nodrag nopan"
            title="断开这条通路"
            onClick={(e) => {
              e.stopPropagation();
              data?.onCut();
            }}
          >
            ×
          </button>
        </div>
      </EdgeLabelRenderer>
    </>
  );
}

const nodeTypes = { page: PageNodeView };
const edgeTypes = { link: LinkEdgeView };

export function MatrixFlow({
  pages,
  links,
  onOpen,
  onLink,
  onUnlink,
}: {
  pages: MatrixPage[];
  links: MatrixLink[];
  onOpen: (p: MatrixPage) => void;
  /** 图上拖出的一条 A→B：交给面板落库 */
  onLink: (from: string, to: string) => void;
  /** 断开一条 A→B */
  onUnlink: (from: string, to: string) => void;
}) {
  const ids = useMemo(() => new Set(pages.map((p) => p.id)), [pages]);

  const [nodes, setNodes, onNodesChange] = useNodesState<PageNode>(
    buildNodes(pages, links),
  );
  const [edges, setEdges, onEdgesChange] = useEdgesState<LinkEdge>(
    buildEdges(links, ids, onUnlink),
  );

  /** 面板数据变了就重铺一遍：已有节点的位置留着，用户拖过的不该跳回去 */
  useEffect(() => {
    setNodes((cur) => buildNodes(pages, links, cur));
  }, [pages, links, setNodes]);

  useEffect(() => {
    setEdges(buildEdges(links, ids, onUnlink));
  }, [links, ids, onUnlink, setEdges]);

  /** 拖出一根线：先画上再落库（落库失败会由下一次刷新的真实数据纠正） */
  const onConnect = useCallback(
    (c: Connection) => {
      const { source, target } = c;
      if (!source || !target || source === target) return;
      setEdges((eds) =>
        buildEdges(
          [{ from: source, to: target, label: "", place: { kind: "auto" }, order: 0 }],
          new Set([source, target]),
          onUnlink,
        ).concat(eds.filter((e) => e.id !== `${source}|${target}`)),
      );
      onLink(source, target);
    },
    [onLink, onUnlink, setEdges],
  );

  /** 键盘删边（点线选中后按 Delete / Backspace）也要落库 */
  const onEdgesDelete = useCallback(
    (gone: LinkEdge[]) => {
      for (const e of gone) onUnlink(e.source, e.target);
    },
    [onUnlink],
  );

  const onNodeClick: NodeMouseHandler<PageNode> = useCallback(
    (_, n) => onOpen(n.data.page),
    [onOpen],
  );

  return (
    <div className="mx-flow">
      <ReactFlow<PageNode, LinkEdge>
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onEdgesDelete={onEdgesDelete}
        onNodeClick={onNodeClick}
        isValidConnection={(c) => c.source !== c.target}
        // 落点比默认的 20px 宽松些：拖到节点左缘附近就算接上了
        connectionRadius={44}
        deleteKeyCode={["Backspace", "Delete"]}
        fitView
        fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
        minZoom={0.25}
        maxZoom={1.8}
      >
        <Background
          variant={BackgroundVariant.Dots}
          gap={18}
          size={1}
          color="var(--yuzhe-line-soft)"
        />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}
