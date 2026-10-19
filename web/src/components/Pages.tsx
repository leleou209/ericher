import { Component, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api } from "../lib/api";
import type { MatrixPage, RecallHit, SessionMeta, UserCard, ViewKey } from "../lib/types";
import { agentDisplay, useTheme } from "../lib/theme";
import { Icon, type IconName } from "./Icons";
import "./Pages.css";

/**
 * 出错兜底：一块界面崩了，别把整页带走。
 *
 * 为什么会想到这个：DOM 的 state 是持久化的 blob，老实例上少一个字段、
 * 或者一份后端返回的形状变了，某个面板就会在渲染时抛错。
 * 没有这层的话，React 会把整棵树卸掉 —— 用户看到的是一片白，
 * 而且不知道该怪谁，连重试一下都不行。
 * 有了它，坏掉的那一块自己说一句「出了点问题」，其余部分是好的。
 *
 * 只兜渲染期的错。事件回调、异步里的错它接不住（那是 React 的规矩），
 * 那些地方各自有自己的 try/catch。
 */
export class Shield extends Component<
  { children: ReactNode; what?: string },
  { err: Error | null }
> {
  state: { err: Error | null } = { err: null };

  static getDerivedStateFromError(err: unknown): { err: Error } {
    return { err: err instanceof Error ? err : new Error(String(err)) };
  }

  componentDidCatch(err: unknown) {
    console.error("[shield]", this.props.what || "", err);
  }

  render() {
    const { err } = this.state;
    if (!err) return this.props.children;
    return (
      <div className="shield">
        <div className="shield-card card">
          <h3>
            {this.props.what
              ? `${this.props.what}这块出了点问题`
              : "这块出了点问题"}
          </h3>
          <p className="shield-msg">{err.message || String(err)}</p>
          <p className="shield-note">
            其他地方还能用。点一下重试，或者刷新页面。
          </p>
          <div className="row-actions">
            <button
              className="btn btn-primary"
              onClick={() => this.setState({ err: null })}
            >
              重试
            </button>
            <button className="btn" onClick={() => location.reload()}>
              刷新页面
            </button>
          </div>
        </div>
      </div>
    );
  }
}

/**
 * 全站背景：一张白纸。
 * 旧版的装饰光晕、点阵、飘落动画已整体铲掉 —— 只留一层极淡的顶部微晕
 * （用 --yuzhe-bg-soft 染出纸面起伏），无 props、无动画，动起来的是内容不是背景。
 */
export function Backdrop() {
  return <div className="backdrop" aria-hidden="true" />;
}

// ── 对话页侧栏 ────────────────────────────────────────

const SIDE_NAV: Array<{
  key: ViewKey;
  label: string;
  icon: IconName;
  adminOnly?: boolean;
}> = [
  { key: "chat", label: "对话", icon: "message" },
  // 笔记本：管理员的本子；长期使用者（身份卡 + 档位开了记事本权益）也有自己的
  // 一本 —— 路由按权益放行，落在他自己那间屋的 SQLite。临时来客看不见这一项
  { key: "note", label: "笔记本", icon: "edit", adminOnly: true },
  // 回想同理，而且更该收着：那是他自己回头看留下的东西，
  // 按时间、按语气就能翻出主人每个晚上的心绪，不该当着来客的面摆出来
  { key: "memory-session", label: "回想", icon: "clock", adminOnly: true },
  // 信箱：写一封、看进来的、看我寄出的。摆成一级入口是有原因的 ——
  // 写信是日常动作，藏在设置第二段里就等于宣布它不存在（上一版就是这么丢的）
  { key: "mailbox", label: "信箱", icon: "archive", adminOnly: true },
  { key: "settings", label: "设置", icon: "settings" },
];

/**
 * 身份卡（usercard）：左下角这张小卡是「我」的使用者身份，跟旁边 ericher 的
 * 在线卡是两回事。点击弹出身份弹层 —— 称呼、类型档、临时还是长期、领卡时写的目的；
 * 长期身份在弹层里能解卡退出，临时身份能就地升级成长期（当前房间整体升级，历史不搬）。
 */
function IdentityCard({
  isAdmin,
  guestName,
  typeName,
  card,
  adminBio,
}: {
  isAdmin: boolean;
  /** 这个房间记下的称呼（介绍页 / whoami 登记的；管理员房里是主人自己的） */
  guestName: string;
  /** 所属类型档的名字（"common" 快照显示成「通用来客」） */
  typeName: string;
  /** 长期身份卡；null = 临时身份（管理员恒为 null） */
  card: UserCard | null;
  /** 管理员的签名（设置页写的）；只在这层展示 */
  adminBio: string;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [upgrading, setUpgrading] = useState(false);
  const [name, setName] = useState("");
  const [purpose, setPurpose] = useState("");
  const [email, setEmail] = useState("");
  const [pw, setPw] = useState("");

  const who = card?.name || guestName || "未登记";
  const kind = isAdmin ? "管理员" : card ? "长期" : "临时";

  const claim = async () => {
    if (busy) return;
    if (!name.trim() || !purpose.trim() || pw.length < 6) {
      setErr("昵称、目的必填，密码至少 6 位");
      return;
    }
    setBusy(true);
    setErr("");
    try {
      await api.cardCreate({
        name: name.trim(),
        purpose: purpose.trim(),
        password: pw,
        email: email.trim() || undefined,
      });
      // 与 App.tsx 的 INTRO_KEY 同一个记号：领完卡别再弹介绍页
      localStorage.setItem("introDone", "1");
      window.location.reload();
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  };

  const detach = async () => {
    if (busy) return;
    setBusy(true);
    setErr("");
    try {
      await api.cardDetach();
      window.location.reload();
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="identity-wrap">
      {open && (
        <>
          <div className="identity-mask" onClick={() => setOpen(false)} />
          <div className="identity-pop">
            <div className="identity-pop-head">
              <span className="identity-who">{who}</span>
              <span className={`identity-tag ${card || isAdmin ? "long" : ""}`}>
                {kind}
              </span>
            </div>
            {!isAdmin && (
              <dl className="identity-rows">
                <div>
                  <dt>类型档</dt>
                  <dd>{typeName || "—"}</dd>
                </div>
                {card ? (
                  <>
                    <div>
                      <dt>来意</dt>
                      <dd>{card.purpose || "—"}</dd>
                    </div>
                    {card.email && (
                      <div>
                        <dt>邮箱</dt>
                        <dd>{card.email}</dd>
                      </div>
                    )}
                  </>
                ) : (
                  <div>
                    <dt>说明</dt>
                    <dd>
                      临时身份只存在于这台设备的这个房间；领卡后房间归你，历史一条不搬。
                    </dd>
                  </div>
                )}
              </dl>
            )}
            {isAdmin && (
              <p className="identity-dim">
                {adminBio
                  ? `${adminBio} —— 一码通行，进出不做限制。`
                  : "一码通行，进出不做限制。"}
              </p>
            )}
            {err && <p className="identity-err">{err}</p>}
            {!isAdmin && !card && upgrading && (
              <div className="identity-form">
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="昵称（全局唯一，必填）"
                  maxLength={40}
                />
                <input
                  value={purpose}
                  onChange={(e) => setPurpose(e.target.value)}
                  placeholder="你为什么来（必填）"
                  maxLength={300}
                />
                <input
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="邮箱（选填，仅作登记）"
                  maxLength={120}
                />
                <input
                  type="password"
                  value={pw}
                  onChange={(e) => setPw(e.target.value)}
                  placeholder="卡密码（至少 6 位）"
                  maxLength={72}
                />
                <div className="identity-actions">
                  <button
                    className="identity-btn primary"
                    onClick={() => void claim()}
                    disabled={busy}
                  >
                    {busy ? "请稍候…" : "领卡"}
                  </button>
                  <button
                    className="identity-btn"
                    onClick={() => setUpgrading(false)}
                    disabled={busy}
                  >
                    再想想
                  </button>
                </div>
              </div>
            )}
            {!isAdmin && !card && !upgrading && (
              <div className="identity-actions">
                <button
                  className="identity-btn primary"
                  onClick={() => {
                    setName(guestName || "");
                    setUpgrading(true);
                  }}
                >
                  升级为长期身份
                </button>
              </div>
            )}
            {!isAdmin && card && (
              <div className="identity-actions">
                <button
                  className="identity-btn"
                  onClick={() => void detach()}
                  disabled={busy}
                  title="这台设备不再持卡；房间还在卡上，凭昵称密码再登卡就回来"
                >
                  {busy ? "请稍候…" : "解卡退出"}
                </button>
              </div>
            )}
          </div>
        </>
      )}
      <button
        className="identity-chip"
        onClick={() => setOpen((v) => !v)}
        title="我的身份"
      >
        <Icon name="user" size={14} />
        <span className="identity-chip-name">{who}</span>
        <span className={`identity-tag ${card || isAdmin ? "long" : ""}`}>
          {kind}
        </span>
      </button>
    </div>
  );
}

/**
 * 签名块底下摊出来的那份「去哪儿」：矩阵的网页列成一张单子。
 *
 * 点一行直接走过去，从接待台一步跨到矩阵里的某一页，不用先绕进工作台再找。
 * 每次打开现取一次，省得挂了半天还拿着旧名单。
 *
 * 只给管理员看：/api/matrix/* 整片都是管理员才进得去的，来客那边签名块是原样。
 */
function MatrixMenu({ onClose }: { onClose: () => void }) {
  const [pages, setPages] = useState<MatrixPage[] | null>(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    let alive = true;
    api
      .matrixPages()
      .then((r) => {
        if (alive) setPages(r.pages);
      })
      .catch((e) => {
        if (alive) setErr((e as Error).message);
      });
    return () => {
      alive = false;
    };
  }, []);

  // Esc 收摊：这时候焦点多半在单子上，指望不上签名块自己接键盘
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // 入口页打头，其余按路径排 —— 认路的那扇门永远在最上面
  const ordered = useMemo(
    () =>
      [...(pages ?? [])].sort(
        (a, b) =>
          Number(!!b.entry) - Number(!!a.entry) || a.path.localeCompare(b.path),
      ),
    [pages],
  );

  return (
    <>
      {/* 点别处就收：一层看不见的幕，铺在菜单底下 */}
      <div className="brand-scrim" onClick={onClose} />
      <div className="brand-menu">
        <div className="brand-menu-head">
          <span className="ttl">矩阵 · 网页</span>
          <span className="cnt">
            {pages ? `${pages.length} 页` : err ? "读不到" : "…"}
          </span>
        </div>
        {err ? (
          <p className="brand-menu-msg">{err}</p>
        ) : pages && !pages.length ? (
          <p className="brand-menu-msg">还没有页面，去工作台建一个。</p>
        ) : (
          <ul className="brand-menu-list">
            {ordered.map((p) => (
              <li key={p.id}>
                <a
                  className="brand-menu-item"
                  href={`/${p.path}`}
                  title={p.external ? `外站 · ${p.external}` : `/${p.path}`}
                >
                  <span className="nm">{p.title || p.path}</span>
                  <span className="pth">/{p.path}</span>
                  {p.entry && <span className="mk">入口</span>}
                  {p.external && <span className="mk">外站</span>}
                  {p.sandbox && <span className="mk">沙箱</span>}
                </a>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}

export function ChatSidebar({
  sessions,
  active,
  onSwitch,
  onRename,
  onDelete,
  onToggleVisibility,
  onToggleArchive,
  onTogglePin,
  onNew,
  view,
  onNav,
  online,
  isAdmin,
  open,
  onClose,
  card,
  guestName,
  typeName,
  adminBio,
  canNotes,
}: {
  sessions: SessionMeta[];
  active: string;
  onSwitch: (id: string, title: string) => void;
  onRename: (s: SessionMeta) => void;
  onDelete: (s: SessionMeta) => void;
  onToggleVisibility: (s: SessionMeta) => void;
  onToggleArchive: (s: SessionMeta) => void;
  onTogglePin: (s: SessionMeta) => void;
  onNew: () => void;
  view: ViewKey;
  onNav: (v: ViewKey) => void;
  online: boolean;
  isAdmin: boolean;
  open: boolean;
  onClose: () => void;
  /** 长期身份卡；null = 临时身份（管理员恒为 null） */
  card: UserCard | null;
  /** 房间记下的称呼（介绍页 / whoami 登记的；管理员房里是主人自己的） */
  guestName: string;
  /** 所属类型档的名字 */
  typeName: string;
  /** 管理员的签名（设置页写的） */
  adminBio: string;
  /** 这位来客能不能用笔记本（长期卡 + 档位开了记事本权益） */
  canNotes: boolean;
}) {
  // 谁都只看自己那几场 —— 后端按登录身份把请求落到各自的屋子，
  // 来客拿到的就是他自己的对话，不再是别人公开出来的那一批
  // 归档的收进折叠分组：列表长了以后，真正在聊的几场不该被旧对话淹没
  // 置顶的另立一段，排在主列表之上：这一段按「置顶的先后」升序 ——
  // 先顶上的一直在前，后顶上的顺次往后（取消再顶 = 排到这一段末尾）
  const pinned = sessions
    .filter((s) => s.pinned && !s.archived)
    .sort((a, b) => (a.pinned < b.pinned ? -1 : a.pinned > b.pinned ? 1 : 0));
  // 主列表按创建时间倒序（后端已排好，这里不再动）：发消息、点开都不换位
  const list = sessions.filter((s) => !s.archived && !s.pinned);
  const archived = sessions.filter((s) => s.archived);
  const [showArchived, setShowArchived] = useState(false);
  // 签名块上那行名字随主题叫（本文件另有纸色的 theme，换个叫法拿主题域的）
  const { theme: themeConfig } = useTheme();
  const persona = agentDisplay(themeConfig);
  /** 签名块摊开的矩阵清单开着没有（管理员才有这扇门） */
  const [matrixOpen, setMatrixOpen] = useState(false);

  /**
   * 「他另开了一场」的两种样子：先闪几秒把人叫过来，之后退成一个小点，
   * 直到他真的点进去（后端在切过去那一刻把 unread 清掉）。
   *
   * 为什么要记一份见过的 id：闪只该发生在「它刚出现在列表里」那一次。
   * 不记的话，每次列表刷新它都会重新闪一遍 —— 那就不是提醒，是抽搐。
   */
  const met = useRef<Set<string>>(new Set());
  const [fresh, setFresh] = useState<string[]>([]);
  useEffect(() => {
    const arrived = sessions
      .filter((s) => !met.current.has(s.id) && s.unread)
      .map((s) => s.id);
    for (const s of sessions) met.current.add(s.id);
    if (!arrived.length) return;
    setFresh((prev) => [...prev, ...arrived]);
    // 这个定时器故意不跟着列表刷新一起清：列表在这几秒里还会再刷一两次
    // （名字补上、消息落库各算一次），清了它就再也没人把 flash 撤下来
    window.setTimeout(
      () => setFresh((prev) => prev.filter((id) => !arrived.includes(id))),
      4000,
    );
  }, [sessions]);

  // 翻旧账：管理员在自己全部历史会话里搜原话。来客没有这个入口（搜不到私有内容）。
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<RecallHit[] | null>(null);
  const [searching, setSearching] = useState(false);
  // 搜失败和「没找到」是两回事：网络/服务端出错时如实说、让人能重试，
  // 别把报错渲染成「没找到」—— 那是在让人以为历史里根本没有这段
  const [searchErr, setSearchErr] = useState(false);
  // 搜索的请求定序：连打几个字就是几次搜索，只认最后一次的响应，
  // 免得先发的慢请求回来把后发的快请求刚写好的结果覆盖掉
  const recallSeq = useRef(0);
  // 失败不自动重试；点「再试一次」把同一个词重搜一遍
  const [retryN, setRetryN] = useState(0);

  useEffect(() => {
    const keyword = q.trim();
    if (!isAdmin || !keyword) {
      setHits(null);
      setSearching(false);
      setSearchErr(false);
      return;
    }
    setSearching(true);
    setSearchErr(false);
    // 打字停下来再发请求，不然每敲一个字都打一次后端
    const t = setTimeout(() => {
      const seq = ++recallSeq.current;
      api
        .recall(keyword)
        .then((rows) => {
          if (seq !== recallSeq.current) return; // 过期响应：丢弃，别 set
          setHits(rows);
          setSearchErr(false);
        })
        .catch(() => {
          if (seq !== recallSeq.current) return;
          setHits(null);
          setSearchErr(true);
        })
        .finally(() => {
          // 只有最新那次才负责收旗，旧响应回来不能把新请求的「翻找中」熄掉
          if (seq === recallSeq.current) setSearching(false);
        });
    }, 280);
    return () => clearTimeout(t);
  }, [q, isAdmin, retryN]);

  /**
   * 一行会话。置顶区与主列表用的是同一行渲染 —— 两处的行必须长得一模一样，
   * 各写一份迟早会有一边漏掉某个按钮（同一扇门对齐）。
   */
  const renderRow = (s: SessionMeta) => (
    <div
      key={s.id}
      className={`history-item ${s.id === active ? "on" : ""} ${fresh.includes(s.id) ? "flash" : ""}`}
    >
      <button
        className="history-open"
        onClick={() => {
          onSwitch(s.id, s.title);
          onClose();
        }}
      >
        <Icon name="message" size={16} />
        <span className="history-title">{s.title}</span>
        {/* 他开的那一场：闪过去之后，这个点就是「这里还有一件没看的事」 */}
        {s.unread && (
          <span className="history-dot" title="ericher 另开的一场，你还没看" />
        )}
        {isAdmin && s.visibility === "public" && (
          <span className="history-badge">公开</span>
        )}
      </button>
      {isAdmin && (
        <span className="history-tools">
          <button
            className={`history-edit${s.pinned ? " on" : ""}`}
            title={s.pinned ? "取消置顶" : "置顶，排到置顶区末尾"}
            onClick={(e) => {
              e.stopPropagation();
              onTogglePin(s);
            }}
          >
            <Icon name="pin" size={13} />
          </button>
          <button
            className="history-edit"
            title={
              s.visibility === "public" ? "收回为私有" : "设为公开，来客可读"
            }
            onClick={(e) => {
              e.stopPropagation();
              onToggleVisibility(s);
            }}
          >
            <Icon
              name={s.visibility === "public" ? "book-open" : "bookmark"}
              size={13}
            />
          </button>
          <button
            className="history-edit"
            title="重命名"
            onClick={(e) => {
              e.stopPropagation();
              onRename(s);
            }}
          >
            <Icon name="edit" size={13} />
          </button>
          <button
            className="history-edit"
            title="收起（不删，内容都还在）"
            onClick={(e) => {
              e.stopPropagation();
              onToggleArchive(s);
            }}
          >
            <Icon name="archive" size={13} />
          </button>
          <button
            className="history-edit danger"
            title="删除"
            onClick={(e) => {
              e.stopPropagation();
              onDelete(s);
            }}
          >
            <Icon name="trash" size={13} />
          </button>
        </span>
      )}
    </div>
  );

  return (
    <aside className={`chat-sidebar ${open ? "open" : ""}`}>
      <div className="sidebar-header">
        {/* 签名块：纯黑底上一行白色衬线名字。整套皮的识别记号就这一块。
            在线状态也住在这里 —— 底下那张 ericher 卡撤掉后，这是唯一的「他在不在」。
            管理员这儿它还兼一扇门：点开摊出矩阵的页面清单，挑一行就过去 */}
        <div
          className={`brand-block${isAdmin ? " launch" : ""}${
            matrixOpen ? " open" : ""
          }`}
          role={isAdmin ? "button" : undefined}
          tabIndex={isAdmin ? 0 : undefined}
          aria-expanded={isAdmin ? matrixOpen : undefined}
          title={isAdmin ? "矩阵页面：点一下挑一个去" : undefined}
          onClick={isAdmin ? () => setMatrixOpen((o) => !o) : undefined}
          onKeyDown={
            isAdmin
              ? (e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setMatrixOpen((o) => !o);
                  }
                }
              : undefined
          }
        >
          <h1 className="brand-name">{persona.name}</h1>
          <span className="brand-sub">接待台</span>
          <span className="brand-status" data-off={online ? "false" : "true"}>
            <span className="status-dot" />
            {online ? "在线" : "连接中"}
          </span>
          {isAdmin && <span className="brand-caret" aria-hidden="true" />}
        </div>
        {isAdmin && matrixOpen && (
          <MatrixMenu onClose={() => setMatrixOpen(false)} />
        )}
      </div>

      {/* 新建对话对谁都开着：来客也是这个家的朋友，他该能自己开一场新的，
          而不是所有话都挤在同一场里 */}
      <button className="new-chat-btn" onClick={onNew}>
        <Icon name="plus" size={18} />
        <span>新建对话</span>
      </button>

      <nav className="side-nav">
        {SIDE_NAV.filter(
          (n) => isAdmin || !n.adminOnly || (n.key === "note" && canNotes),
        ).map((n) => (
          <button
            key={n.key}
            className={view === n.key ? "on" : ""}
            onClick={() => {
              onNav(n.key);
              onClose();
            }}
          >
            <Icon name={n.icon} size={16} />
            {n.label}
          </button>
        ))}
      </nav>

      {isAdmin && (
        <div className="side-search">
          <Icon name="search" size={14} />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="搜历史会话"
            aria-label="搜索历史会话"
          />
          {q && (
            <button
              className="side-search-clear"
              title="清空"
              onClick={() => setQ("")}
            >
              ×
            </button>
          )}
        </div>
      )}

      {/* 中段整体进一个滚动容器：会话长了滚这里，头部/导航/底部各就各位不动 */}
      <div className="sidebar-scroll">
        {q.trim() ? (
          <nav className="chat-history">
            {searching && <p className="empty-sm">翻找中…</p>}
            {!searching && searchErr && (
              <p className="empty-sm">
                翻旧账没翻成 —— 搜索这会儿不通，稍后再来，或{" "}
                <button className="link" onClick={() => setRetryN((n) => n + 1)}>
                  再试一次
                </button>
              </p>
            )}
            {!searching && hits?.length === 0 && (
              <p className="empty-sm">没找到和「{q.trim()}」有关的旧对话</p>
            )}
            {!searching &&
              hits?.map((h, i) => (
                <button
                  key={`${h.sessionId}-${i}`}
                  className="recall-hit"
                  onClick={() => {
                    onSwitch(h.sessionId, h.sessionTitle);
                    onClose();
                  }}
                >
                  <span className="recall-where">
                    <Icon name="message" size={13} />
                    {h.sessionTitle} · {h.lastActive.slice(0, 10)}
                  </span>
                  <span className="recall-snippet">
                    <b>{h.role === "user" ? "用户" : "ericher"}：</b>
                    {h.message}
                  </span>
                </button>
              ))}
          </nav>
        ) : (
          <>
            {/* 置顶区：另立一段摆在最上面，区内按置顶的先后排。
                没有置顶的场时整段不出现 —— 不留一个空标题占位 */}
            {!!pinned.length && (
              <>
                <div className="history-label">置顶</div>
                <nav className="chat-history">{pinned.map(renderRow)}</nav>
              </>
            )}
            <div className="history-label">
              {isAdmin ? "我的会话" : "我的对话"}
            </div>
            <nav className="chat-history">
              {list.map(renderRow)}
              {!list.length && !pinned.length && (
                <p className="empty-sm">
                  {archived.length
                    ? "这几场都收起来了，展开「已归档」就能看到"
                    : "还没有对话记录"}
                </p>
              )}
            </nav>

            {!!archived.length && (
              <>
                <button
                  className="history-group"
                  onClick={() => setShowArchived((v) => !v)}
                >
                  <Icon
                    name={showArchived ? "chevron-down" : "chevron-right"}
                    size={13}
                  />
                  <span>已归档</span>
                  <span className="history-group-n">{archived.length}</span>
                </button>
                {showArchived && (
                  <nav className="chat-history archived">
                    {archived.map((s) => (
                      <div
                        key={s.id}
                        className={`history-item ${s.id === active ? "on" : ""}`}
                      >
                        <button
                          className="history-open"
                          onClick={() => {
                            onSwitch(s.id, s.title);
                            onClose();
                          }}
                        >
                          <Icon name="archive" size={16} />
                          <span className="history-title">{s.title}</span>
                          {s.id === active && (
                            <span className="history-badge">当前</span>
                          )}
                        </button>
                        <span className="history-tools">
                          <button
                            className="history-edit"
                            title="展开，放回会话列表"
                            onClick={(e) => {
                              e.stopPropagation();
                              onToggleArchive(s);
                            }}
                          >
                            <Icon name="corner-up-left" size={13} />
                          </button>
                          <button
                            className="history-edit danger"
                            title="删除"
                            onClick={(e) => {
                              e.stopPropagation();
                              onDelete(s);
                            }}
                          >
                            <Icon name="trash" size={13} />
                          </button>
                        </span>
                      </div>
                    ))}
                  </nav>
                )}
              </>
            )}
          </>
        )}
      </div>

      <div className="sidebar-footer">
        {/* 我的身份卡：使用者（管理员 / 来客）自己这张。ericher 的在线卡撤了 ——
            在线状态住进了顶部签名块，设置入口 side-nav 本来就有，不必再占一行 */}
        <IdentityCard
          isAdmin={isAdmin}
          guestName={guestName}
          typeName={typeName}
          card={card}
          adminBio={adminBio}
        />
      </div>
    </aside>
  );
}
