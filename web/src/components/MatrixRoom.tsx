import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { ACCESS_LABEL, RoomRing, doorsOf } from "./RoomRing";
import type {
  LinkPlace,
  MatrixAccess,
  MatrixLink,
  MatrixPage,
} from "../lib/types";

/**
 * 房间视角 —— 使用者这一侧的矩阵。
 *
 * 全景图看的是「谁能到谁」这张结构图：从图的角度它是直观的，从使用的角度
 * 反而不直观。所以补一个站在某间房里的视角：你在房间 A，周围一圈都是它的门，
 * 分别通向 B / C / D；点一扇门就走过去，走过的路串成一串脚印（面包屑），
 * 点前面的一截还能回头 —— 像在迷宫里穿行。
 *
 * 于是：左边是**预览器**（门的方位、文字、虚实一眼可见），右边是**调整器**——
 * 改文字、改落点、断一条、开一扇门、顺手新开一间房。出口的编辑整个收口在这里，
 * 编辑器里不再另配一处。同屏并置，右边一改，左边的门当场变。那张环形图本身在
 * RoomRing 里，与页面预览模式左上角的小地图共用一份。
 */

/** 落点：按钮是「矩阵的功能」不是页面内容，落在哪儿在这儿挑（拖拽落点归预览） */
const PLACE_LABEL: Record<LinkPlace["kind"], string> = {
  auto: "兜底栏",
  anchor: "命名锚点",
  point: "拖的落点",
};

/** 路径的客户端预检，口径跟 core 的 validPath 对齐：不合规就别发请求了 */
const SEG_RE = /^[a-z0-9_-]+(?:\/[a-z0-9_-]+){0,2}$/;
const RESERVED = new Set(["api", "agents", "assets", "index", "assistant"]);
function pathIssue(path: string, taken: Set<string>): string {
  if (!path) return "先填一条路径";
  if (!SEG_RE.test(path)) return "最多 3 段，每段只含小写字母 / 数字 / - / _";
  const first = path.split("/")[0];
  if (RESERVED.has(first)) return `「${first}」是保留字，换一个`;
  if (first.includes(".")) return "首段不能带点";
  if (taken.has(path)) return "这条路径已被占用";
  return "";
}

export function MatrixRoom({
  pages,
  links,
  currentId,
  trail,
  busy,
  onWalk,
  onOpen,
  onLink,
  onRename,
  onPlace,
  onUnlink,
  onCreate,
}: {
  pages: MatrixPage[];
  links: MatrixLink[];
  currentId: string;
  /** 走过的路（页 id，末位是当前这间）—— 面包屑就是它铺出来的 */
  trail: string[];
  busy: boolean;
  /** 走到某一间：点门、点来路、点面包屑都走这里 */
  onWalk: (id: string) => void;
  onOpen: (p: MatrixPage) => void;
  /** 现开一扇门：从当前这间通到选中的那一页，落点一并定下 */
  onLink: (from: string, to: string, label: string, place: LinkPlace) => void;
  /** 改一扇门上的按钮文字 */
  onRename: (l: MatrixLink, label: string) => void;
  /** 改一扇门的落点：兜底栏 ↔ 命名锚点 */
  onPlace: (l: MatrixLink, place: LinkPlace) => void;
  /** 断一扇门 */
  onUnlink: (from: string, to: string) => void;
  /** 新开一间房，并顺手从当前这间开一扇门过去 */
  onCreate: (d: { path: string; title: string; access: MatrixAccess }) => void;
}) {
  const byId = useMemo(() => new Map(pages.map((p) => [p.id, p])), [pages]);
  const me = byId.get(currentId);
  const doors = useMemo(
    () => doorsOf(currentId, links, byId),
    [currentId, links, byId],
  );

  const outDoors = doors.filter((d) => d.out);
  const backRows = doors.flatMap((d) =>
    d.back.map((l) => ({ page: d.page, link: l })),
  );

  /** 指向「开一扇门」那个下拉：图上点虚位就把它拉过来 */
  const pickRef = useRef<HTMLSelectElement>(null);
  const [to, setTo] = useState("");
  const [label, setLabel] = useState("");
  /** 新门的落点：兜底栏 / 命名锚点（拖拽落点只能由页面预览产生） */
  const [kind, setKind] = useState<"auto" | "anchor">("auto");
  const [anchor, setAnchor] = useState("");
  const [np, setNp] = useState<{
    path: string;
    title: string;
    access: MatrixAccess;
  }>({ path: "", title: "", access: "public" });

  // 换了一间房，门上那套草稿不该跟着走
  useEffect(() => {
    setTo("");
    setLabel("");
    setKind("auto");
    setAnchor("");
  }, [currentId]);

  /** 还没连上的页：它们才是「这儿还能开一扇门」的候选 */
  const openable = pages.filter(
    (p) => p.id !== currentId && !doors.some((d) => d.page.id === p.id),
  );

  const takenPaths = new Set(pages.map((p) => p.path));
  const npIssue = pathIssue(np.path, takenPaths);

  if (!me) {
    return <p className="empty-sm">这间房已经不在矩阵里了，换一间看看。</p>;
  }

  return (
    <div className="mr-wrap">
      <div className="mr-stage">
        {/* 走过的路：点前面的一截就跳回去（像浏览器的历史） */}
        <nav className="mr-trail" aria-label="走过的路">
          {trail.map((id, i) => {
            const p = byId.get(id);
            const last = i === trail.length - 1;
            return (
              <Fragment key={id}>
                {i > 0 && <span className="mr-trail-sep">›</span>}
                <button
                  type="button"
                  className={`mr-trail-item${last ? " on" : ""}`}
                  disabled={last}
                  title={last ? "当前所在" : `回到 /${p?.path ?? ""}`}
                  onClick={() => onWalk(id)}
                >
                  {p?.title || p?.path || "（已删）"}
                </button>
              </Fragment>
            );
          })}
        </nav>

        <RoomRing
          pages={pages}
          links={links}
          currentId={currentId}
          onWalk={onWalk}
          onOpen={onOpen}
          onGhost={() => pickRef.current?.focus()}
        />
      </div>

      <aside className="mr-side">
        {/* 这一间 */}
        <div className="mr-box">
          <div className="mr-box-head">这一间</div>
          <div className="mr-here">
            <span className="mr-here-title">
              {me.title || me.path || "首页"}
            </span>
            {me.entry && <span className="chip on">入口</span>}
            <span className="chip">{ACCESS_LABEL[me.access]}</span>
            {me.external && <span className="chip">外链</span>}
          </div>
          <div className="dim">/{me.path || ""}</div>
          <button className="btn btn-sm" onClick={() => onOpen(me)}>
            打开编辑器
          </button>
        </div>

        {/* 出去的门：左边是预览，这里是调整器 */}
        <div className="mr-box">
          <div className="mr-box-head">出去的门 · {outDoors.length}</div>
          {outDoors.length === 0 && (
            <p className="dim">这间房还没有门，下面开一扇。</p>
          )}
          {outDoors.map((d) => (
            <DoorRow
              key={d.page.id}
              link={d.out as MatrixLink}
              path={d.page.path}
              busy={busy}
              onRename={(v) => onRename(d.out as MatrixLink, v)}
              onPlace={(place) => onPlace(d.out as MatrixLink, place)}
              onUnlink={() => onUnlink(currentId, d.page.id)}
            />
          ))}

          <div className="mr-add">
            {openable.length === 0 ? (
              <p className="dim">没有别的页面可连了 —— 用下面的「新开一间房」。</p>
            ) : (
              <>
                <select
                  ref={pickRef}
                  className="field"
                  value={to}
                  onChange={(e) => setTo(e.target.value)}
                >
                  <option value="">连到哪一页…</option>
                  {openable.map((p) => (
                    <option key={p.id} value={p.id}>
                      /{p.path} · {p.title || "（未命名）"}
                    </option>
                  ))}
                </select>
                <input
                  className="field"
                  value={label}
                  maxLength={40}
                  placeholder="按钮文字（留空用目标页标题）"
                  onChange={(e) => setLabel(e.target.value)}
                />
                <div className="mr-place">
                  <select
                    className="field"
                    value={kind}
                    onChange={(e) =>
                      setKind(e.target.value as "auto" | "anchor")
                    }
                  >
                    <option value="auto">放在兜底栏</option>
                    <option value="anchor">填进命名锚点</option>
                  </select>
                  {kind === "anchor" && (
                    <input
                      className="field"
                      value={anchor}
                      placeholder="锚点名，如 north"
                      onChange={(e) => setAnchor(e.target.value)}
                    />
                  )}
                </div>
                <button
                  className="btn btn-sm"
                  disabled={busy || !to}
                  onClick={() => {
                    if (!to) return;
                    onLink(
                      currentId,
                      to,
                      label,
                      // 只填了锚点名才算锚点；否则一律兜底栏，落进不存在的锚点没意义
                      kind === "anchor" && anchor.trim()
                        ? { kind: "anchor", name: anchor.trim() }
                        : { kind: "auto" },
                    );
                    setTo("");
                    setLabel("");
                    setKind("auto");
                    setAnchor("");
                  }}
                >
                  开这扇门
                </button>
              </>
            )}
          </div>
        </div>

        {/* 来路：谁指着我。只读，点一下能走过去看看 */}
        <div className="mr-box">
          <div className="mr-box-head">来路 · {backRows.length}</div>
          {backRows.length === 0 && (
            <p className="dim">没有别的页面指向这里。</p>
          )}
          {backRows.map((r) => (
            <div className="mr-back" key={r.page.id}>
              <button
                className="mr-back-go"
                onClick={() => onWalk(r.page.id)}
                title={`走到 /${r.page.path}`}
              >
                /{r.page.path}
              </button>
              <span className="dim">的「{r.link.label}」</span>
            </div>
          ))}
        </div>

        {/* 新开一间房：建完就从这儿走进去 */}
        <div className="mr-box">
          <div className="mr-box-head">新开一间房</div>
          <input
            className="field"
            value={np.path}
            placeholder="层级路径，如 vault/b1"
            onChange={(e) =>
              setNp({ ...np, path: e.target.value.trim().toLowerCase() })
            }
          />
          <input
            className="field"
            value={np.title}
            placeholder="标题（导航与门上显示）"
            onChange={(e) => setNp({ ...np, title: e.target.value })}
          />
          <select
            className="field"
            value={np.access}
            onChange={(e) =>
              setNp({ ...np, access: e.target.value as MatrixAccess })
            }
          >
            <option value="public">公开 —— 任何人可见</option>
            <option value="visitor">持票来客 —— 登录后可见</option>
            <option value="admin">管理员 —— 仅管理员</option>
          </select>
          {np.path && npIssue && <p className="dim">{npIssue}</p>}
          <button
            className="btn btn-sm"
            disabled={busy || !!npIssue}
            onClick={() => {
              if (npIssue) return;
              onCreate({ path: np.path, title: np.title, access: np.access });
              setNp({ path: "", title: "", access: "public" });
            }}
          >
            建这间房，并从这儿开一扇门
          </button>
        </div>
      </aside>
    </div>
  );
}

/** 出去的那一扇门：文字改了就提交（失焦或回车）；下面挑落点，右边一个小 × 断开 */
function DoorRow({
  link,
  path,
  busy,
  onRename,
  onPlace,
  onUnlink,
}: {
  link: MatrixLink;
  path: string;
  busy: boolean;
  onRename: (label: string) => void;
  onPlace: (place: LinkPlace) => void;
  onUnlink: () => void;
}) {
  const [text, setText] = useState(link.label);
  useEffect(() => {
    setText(link.label);
  }, [link.label]);

  const placeKind = link.place.kind;
  const anchorName = placeKind === "anchor" ? link.place.name : "";
  /** 落点选择是本地草稿：选了「命名锚点」得等名字填上才提交 */
  const [kind, setKind] = useState<LinkPlace["kind"]>(placeKind);
  const [anchor, setAnchor] = useState(anchorName);
  useEffect(() => setKind(placeKind), [placeKind]);
  useEffect(() => setAnchor(anchorName), [anchorName]);

  const commit = () => {
    const v = text.trim();
    // 空文字没有意义：后端会拿目标页标题兜底，索性退回原样
    if (!v) {
      setText(link.label);
      return;
    }
    if (v !== link.label) onRename(v);
  };

  /** 切落点：兜底栏立刻生效；命名锚点要等名字填上；拖的落点只能从预览改 */
  const pickKind = (k: LinkPlace["kind"]) => {
    setKind(k);
    if (k === "auto") onPlace({ kind: "auto" });
    else if (k === "anchor" && anchor.trim())
      onPlace({ kind: "anchor", name: anchor.trim() });
  };

  const commitAnchor = () => {
    const v = anchor.trim();
    if (!v) {
      setAnchor(anchorName);
      return;
    }
    if (v !== anchorName) onPlace({ kind: "anchor", name: v });
  };

  return (
    <div className="mr-door-item">
      <div className="mr-door-row">
        <input
          className="field"
          value={text}
          maxLength={40}
          placeholder="按钮文字"
          onChange={(e) => setText(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            // 中文输入法选词时的回车不算「改完了」
            if (e.key === "Enter" && !e.nativeEvent.isComposing) {
              e.preventDefault();
              e.currentTarget.blur();
            }
          }}
        />
        <button
          type="button"
          className="mr-cut"
          title="断开这一扇门"
          disabled={busy}
          onClick={onUnlink}
        >
          ×
        </button>
      </div>
      <div className="dim mr-door-to">→ /{path}</div>
      <div className="mr-place">
        <select
          className="field"
          value={kind}
          disabled={busy}
          title="按钮落在这一页的哪儿"
          onChange={(e) => pickKind(e.target.value as LinkPlace["kind"])}
        >
          {/* 拖出来的落点只能由页面预览改，这里只作只读展示 */}
          {placeKind === "point" && (
            <option value="point">{PLACE_LABEL.point}</option>
          )}
          <option value="auto">{PLACE_LABEL.auto}</option>
          <option value="anchor">{PLACE_LABEL.anchor}</option>
        </select>
        {kind === "anchor" && (
          <input
            className="field"
            value={anchor}
            maxLength={80}
            placeholder="锚点名，如 north"
            onChange={(e) => setAnchor(e.target.value)}
            onBlur={commitAnchor}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                e.preventDefault();
                e.currentTarget.blur();
              }
            }}
          />
        )}
      </div>
    </div>
  );
}
