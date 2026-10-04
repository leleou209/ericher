import {
  Component,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { api, type Role } from "../lib/api";
import type {
  ModelEntry,
  ModelProvider,
  ThemeKey,
  UserCard,
} from "../lib/types";
import { Icon, type IconName } from "./Icons";
import {
  ContactPanel,
  FilePanel,
  GuestPermsPanel,
  GuestTypesPanel,
  LedgerPanel,
  MemoryPanel,
  ModelConfigsPanel,
  PromptPanel,
  RecapGuidePanel,
  QuotaPanel,
  ReminderPanel,
  SelfPanel,
  SessionSection,
  SkillPanel,
  SearchConfigsPanel,
  TaskPanel,
  ToolGuidePanel,
  TtsConfigsPanel,
  VoicePanel,
  VisitorsPanel,
  deviceId,
  DrawConfigsPanel,
} from "./Panels";
import type {
  ChatState,
  RecallHit,
  SessionMeta,
  SettingsKey,
  ViewKey,
  Voice,
} from "../lib/types";
import "./Pages.css";

type Patch = (patch: Partial<ChatState>) => Promise<void>;

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
  { key: "settings", label: "设置", icon: "settings" },
];

/**
 * 身份卡（usercard）：左下角这张小卡是「我」的使用者身份，跟旁边 ericher 的
 * 在线卡是两回事。点击弹出身份弹层 —— 称呼、类型档、临时还是长期、领卡时写的目的；
 * 长期身份在弹层里能解卡退出，临时身份能就地升级成长期（当前房间整体升级，历史不搬）。
 */
export function IdentityCard({
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

  useEffect(() => {
    const keyword = q.trim();
    if (!isAdmin || !keyword) {
      setHits(null);
      setSearching(false);
      return;
    }
    setSearching(true);
    // 打字停下来再发请求，不然每敲一个字都打一次后端
    const t = setTimeout(() => {
      api
        .recall(keyword)
        .then(setHits)
        .catch(() => setHits([]))
        .finally(() => setSearching(false));
    }, 280);
    return () => clearTimeout(t);
  }, [q, isAdmin]);

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
            在线状态也住在这里 —— 底下那张 ericher 卡撤掉后，这是唯一的「他在不在」 */}
        <div className="brand-block">
          <h1 className="brand-name">ericher</h1>
          <span className="brand-sub">接待台</span>
          <span className="brand-status" data-off={online ? "false" : "true"}>
            <span className="status-dot" />
            {online ? "在线" : "连接中"}
          </span>
        </div>
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

// ── 设置页 ────────────────────────────────────────────

const GROUPS: Array<{
  title: string;
  items: Array<{
    key: SettingsKey;
    label: string;
    icon: IconName;
    admin?: boolean;
    guest?: boolean;
  }>;
}> = [
  {
    title: "账户",
    items: [
      { key: "profile", label: "个人信息", icon: "user" },
      { key: "about", label: "关于", icon: "help-circle" },
    ],
  },
  {
    title: "对话",
    items: [
      { key: "style", label: "回复风格", icon: "message" },
      { key: "memory", label: "上下文记忆", icon: "book-open", admin: true },
      { key: "contact", label: "人物记忆", icon: "user", admin: true },
      // 账本与公开墙全员可见：账本是他记人记事的公开面，墙上贴着持卡者的纸条；
      // 管理员也看 —— 那块板子归他收拾
      { key: "ledger", label: "公开账本", icon: "book-open" },
    ],
  },
  {
    title: "能力",
    items: [
      { key: "skills", label: "技能配方", icon: "layers", admin: true },
      { key: "task", label: "任务清单", icon: "check" },
      { key: "remind", label: "提醒", icon: "bell", admin: true },
    ],
  },
  {
    title: "储存内容",
    items: [
      { key: "session", label: "会话记录", icon: "clock", admin: true },
      // 云盘跟着 permFiles 权益走（管理员天生有，见上面 groups 的过滤），
      // 不再钉死 admin —— 档位开了云盘的长期卡也该有自己的文件柜
      { key: "file", label: "云盘文件", icon: "clipboard" },
    ],
  },
  {
    title: "来客设置",
    items: [
      { key: "visitors", label: "来客", icon: "user", admin: true },
      { key: "guestTypes", label: "来客类型", icon: "bookmark", admin: true },
      { key: "guestPerms", label: "来客权限管理", icon: "check", admin: true },
    ],
  },
  {
    title: "模型配置",
    items: [
      { key: "modelConfigs", label: "模型配置", icon: "code", admin: true },
      { key: "ttsConfigs", label: "读音配置", icon: "volume", admin: true },
      { key: "drawConfigs", label: "绘图配置", icon: "image", admin: true },
      { key: "searchConfigs", label: "搜索配置", icon: "search", admin: true },
    ],
  },
  {
    title: "守则",
    items: [
      { key: "prompt", label: "工作守则", icon: "edit", admin: true },
      { key: "toolPrompt", label: "工具守则", icon: "code", admin: true },
      { key: "recapPrompt", label: "回想守则", icon: "clock", admin: true },
      { key: "self", label: "自我认知", icon: "compass", admin: true },
    ],
  },
  {
    title: "声音",
    items: [{ key: "voice", label: "朗读嗓音", icon: "mic", admin: true }],
  },
  {
    title: "外观",
    items: [{ key: "appearance", label: "主题与动效", icon: "play" }],
  },
];

const SECTION_META: Record<SettingsKey, { title: string; desc: string }> = {
  profile: { title: "个人信息", desc: "当前身份、设备与会话状态" },
  about: { title: "关于", desc: "这个 agent 是什么、跑在哪里" },
  style: {
    title: "回复风格",
    desc: "选择 ericher 回复你时的思考深度，并给两种模式各指派一套模型",
  },
  memory: {
    title: "上下文记忆",
    desc: "长期记忆库：按分类组织、可检索、可增删",
  },
  ledger: {
    title: "公开账本",
    desc: "ericher 公开给你看的人和事，加上公开权益的持卡者贴上墙的纸条",
  },
  contact: { title: "人物记忆", desc: "同一份记忆的另一种看法：按人翻" },
  session: { title: "会话记录", desc: "历史会话索引与会话摘要" },
  file: {
    title: "云盘文件",
    desc: "对话产物按会话归档，也可以自己建文件夹整理；改名、移动、删除都在行内",
  },
  visitors: {
    title: "来客",
    desc: "谁进过门、最近什么时候、都做了什么 —— 留痕当面说明过，也摊在这里",
  },
  guestTypes: {
    title: "来客类型",
    desc: "一个口令一类来客：名字、口令与接待说明 —— 能用哪些工具去「来客权限管理」",
  },
  guestPerms: {
    title: "来客权限管理",
    desc: "各档 × 各工具：逐件勾这一档能用什么，恒开的单独标出来",
  },
  modelConfigs: {
    title: "模型配置",
    desc: "接哪家模型、用哪把钥匙；普通/深度各用哪个，去「回复风格」页指派",
  },
  ttsConfigs: {
    title: "读音配置",
    desc: "一条就是一副可用嗓子：协议、模型与音色都在这里配",
  },
  drawConfigs: {
    title: "绘图配置",
    desc: "出图三档各用哪家：端点、模型与 key 都在这里配，降级顺序即模型顺序",
  },
  searchConfigs: {
    title: "搜索配置",
    desc: "联网搜索走哪家：Tavily 或 Brave，配一把钥匙就升级，不配也能用免费通道",
  },
  task: { title: "任务清单", desc: "待办、进行中、已完成" },
  remind: {
    title: "提醒",
    desc: "到点 ericher 会自己开口，这里管的是你们约好的那些事",
  },
  skills: {
    title: "技能配方",
    desc: "把常用的多步流程存成配方，下次一句话就能复用",
  },
  prompt: {
    title: "工作守则",
    desc: "ericher 的第一人称行为底稿，改完即刻生效",
  },
  toolPrompt: {
    title: "工具守则",
    desc: "一件工具一格：手里有哪些工具、什么话该用哪一件 —— 主人/来客两套分开改",
  },
  recapPrompt: {
    title: "回想守则",
    desc: "没人说话半小时后，她回头整理这场对话时读的提示词（默认出工作纪要，不带情绪）",
  },
  self: { title: "自我认知", desc: "ericher 对自己的理解，以及更新日志" },
  voice: { title: "朗读嗓音", desc: "ericher 念给你听时用的是哪副嗓子" },
  appearance: { title: "主题与动效", desc: "界面配色与动效" },
};

/**
 * 版本与更新：显示当前版本（package.json）与构建号（git 短 hash），
 * 点「检查更新」拿本地版本号去对开源仓库的版本号 —— 攒批推送是常态，
 * 两边的提交几乎永远对不上号，hash 不同不代表这边旧；
 * 开源仓的版本号（package.json，随发布走）比本地新，才是真的该更新。
 */
function VersionCard() {
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<{
    upToDate: boolean;
    latest: {
      version: string;
      hash: string;
      message: string;
      date: string;
    } | null;
  } | null>(null);
  const [err, setErr] = useState("");

  const check = async () => {
    setChecking(true);
    setErr("");
    try {
      setResult(await api.updateCheck());
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="settings-card">
      <div className="card-header">
        <h3 className="card-title">版本与更新</h3>
        <p className="card-desc">
          版本号取自 package.json，构建号是发布时的那次提交
        </p>
      </div>
      <div className="toggle-list">
        <div className="toggle-row">
          <div className="toggle-info">
            <div className="toggle-icon">
              <Icon name="play" size={17} />
            </div>
            <div className="toggle-text">
              <div className="toggle-title">ericher v{__APP_VERSION__}</div>
              <div className="toggle-desc">构建 {__GIT_HASH__}</div>
            </div>
          </div>
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => void check()}
            disabled={checking}
          >
            {checking ? "检查中…" : "检查更新"}
          </button>
        </div>
        {err && <p className="err">{err}</p>}
        {result && (
          <p className="meta">
            {result.upToDate
              ? result.latest
                ? `已是最新 —— 开源仓版本 v${result.latest.version}，不比这边新。`
                : "已是最新。"
              : result.latest
                ? `开源仓有新版本 v${result.latest.version}（构建 ${result.latest.hash}）：${result.latest.message}`
                : "开源仓库还没有版本信息。"}
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * 模式指派：把模型目录里的条目分给「普通模式」和「深度思考」两个槽位。
 * 普通 = 载入中的那个条目（activate 语义）；深度 = state.deepConfigId，
 * 空着表示跟普通同一个。删掉的条目会自动从槽位上摘下来（后端兜底）。
 */
function StyleAssign({
  deepConfigId,
  patch,
}: {
  deepConfigId: string;
  patch: (p: { deepConfigId?: string }) => void;
}) {
  const [catalog, setCatalog] = useState<{
    providers: ModelProvider[];
    entries: ModelEntry[];
  } | null>(null);

  useEffect(() => {
    void api
      .modelCatalog()
      .then((r) => setCatalog({ providers: r.providers, entries: r.entries }))
      .catch(() => setCatalog({ providers: [], entries: [] }));
  }, []);

  if (catalog === null) return <p className="meta">模型目录读取中…</p>;
  const { providers, entries } = catalog;
  const labelOf = (e: ModelEntry) => {
    const p = providers.find((x) => x.id === e.providerId);
    return `${p ? p.name : "未知供应商"}（${e.model}）`;
  };
  const active = entries.find((e) => e.active) || null;

  return (
    <div className="style-assign">
      <p className="card-desc">
        两种模式各用哪个模型，从这里指派；换完下一轮对话生效。
      </p>
      <div className="style-assign-row">
        <span className="meta">普通模式用</span>
        <select
          className="field"
          value={active?.id ?? ""}
          disabled={!entries.length}
          onChange={(e) => {
            void api
              .modelEntryPatch({ id: e.target.value, active: true })
              .then(() => api.modelCatalog())
              .then((r) =>
                setCatalog({ providers: r.providers, entries: r.entries }),
              )
              .catch(() => undefined);
          }}
        >
          {!entries.length && <option value="">目录还是空的</option>}
          {entries.map((e) => (
            <option key={e.id} value={e.id}>
              {labelOf(e)}
            </option>
          ))}
        </select>
      </div>
      <div className="style-assign-row">
        <span className="meta">深度思考用</span>
        <select
          className="field"
          value={deepConfigId}
          disabled={!entries.length}
          onChange={(e) => patch({ deepConfigId: e.target.value })}
        >
          <option value="">跟普通模式同一套</option>
          {entries.map((e) => (
            <option key={e.id} value={e.id}>
              {labelOf(e)}
            </option>
          ))}
        </select>
      </div>
      {!entries.length && (
        <p className="meta">先到「模型配置」里加供应商和模型，再回来指派。</p>
      )}
    </div>
  );
}

/**
 * 管理员的个人信息：称呼 + 签名，就地编辑。
 * 为什么不走来客那套卡：管理员一码通行，没有卡可领 ——
 * 这两格只是他自己房里的展示档案，存进 state，左下角那张身份卡照着显示。
 * 直接打 api.patchConfig 而不走 App 的 patch：那层把错误吞进聊天页的提示条，
 * 这里要的是「成没成」当场说清楚。
 */
function AdminIdentityFields({
  guestName,
  adminBio,
}: {
  guestName: string;
  adminBio: string;
}) {
  const [name, setName] = useState(guestName);
  const [bio, setBio] = useState(adminBio);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  // 屋子的 state 广播回来时别冲掉正在打的字：动过笔之后就跟编辑值走
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    if (!dirty) setName(guestName);
  }, [guestName, dirty]);
  useEffect(() => {
    if (!dirty) setBio(adminBio);
  }, [adminBio, dirty]);

  const save = async () => {
    if (busy) return;
    setBusy(true);
    setMsg("");
    try {
      await api.patchConfig({
        guestName: name.trim().slice(0, 20),
        adminBio: bio.trim().slice(0, 80),
      });
      setMsg("已保存");
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="form-field" style={{ marginBottom: 14 }}>
        <label className="form-label">称呼（左下角身份卡显示的名字）</label>
        <input
          className="form-input"
          value={name}
          maxLength={20}
          placeholder="怎么称呼你"
          onChange={(e) => {
            setDirty(true);
            setName(e.target.value);
          }}
        />
      </div>
      <div className="form-field" style={{ marginBottom: 14 }}>
        <label className="form-label">签名（一句话，选填）</label>
        <input
          className="form-input"
          value={bio}
          maxLength={80}
          placeholder="身份弹层里的一句话"
          onChange={(e) => {
            setDirty(true);
            setBio(e.target.value);
          }}
        />
      </div>
      <div className="row-actions" style={{ marginBottom: 14 }}>
        <button
          className="save-btn"
          onClick={() => void save()}
          disabled={busy}
        >
          <Icon name="edit" size={16} />
          <span>{busy ? "保存中…" : "保存"}</span>
        </button>
        {msg && (
          <span className="dim" style={{ alignSelf: "center" }}>
            {msg}
          </span>
        )}
      </div>
    </>
  );
}

export function SettingsPage({
  section,
  onSection,
  state,
  patch,
  isAdmin,
  role,
  card,
  canPublic,
  canFiles,
  onNav,
  sessions,
  activeSession,
  voices,
  voiceDefault,
  voiceCloud,
  onSwitchSession,
  onRenameSession,
  onDeleteSession,
  onToggleVisibility,
  onToggleArchive,
  onTogglePin,
  onLogout,
  online,
  motion,
  setMotion,
  theme,
  setTheme,
  setThink,
}: {
  section: SettingsKey;
  onSection: (s: SettingsKey) => void;
  state: ChatState;
  patch: Patch;
  isAdmin: boolean;
  role: Role;
  /** 当前登录者的卡；管理员和临时票是 null */
  card: UserCard | null;
  /** 有没有公开权益（公开墙的贴条资格） */
  canPublic: boolean;
  /** 有没有云盘权益（文件面板的进门资格；管理员天生有） */
  canFiles: boolean;
  onNav: (v: ViewKey) => void;
  sessions: SessionMeta[];
  activeSession: string;
  /** 这台机器上能用的嗓子；来客拿不到，就是空的 */
  voices: Voice[];
  /** 没选嗓音时实际会用哪一副 */
  voiceDefault: string;
  /** 这台机器接上云端嗓子了吗 */
  voiceCloud: boolean;
  onSwitchSession: (id: string, title: string) => void;
  onRenameSession: (s: SessionMeta) => void;
  onDeleteSession: (s: SessionMeta) => void;
  onToggleVisibility: (s: SessionMeta) => void;
  onToggleArchive: (s: SessionMeta) => void;
  onTogglePin: (s: SessionMeta) => void;
  onLogout: () => void;
  online: boolean;
  motion: boolean;
  setMotion: (v: boolean) => void;
  theme: ThemeKey;
  setTheme: (t: ThemeKey) => void;
  /** 调思考强度。和别的设置分开走：这一格来客也有，不能经过管理员那道路由 */
  setThink: (mode: "normal" | "deep") => void;
}) {
  const groups = useMemo(
    () =>
      GROUPS.map((g) => ({
        ...g,
        items: g.items.filter(
          (i) =>
            (!i.admin || isAdmin) &&
            (!i.guest || !isAdmin) &&
            // 云盘面板跟着权益走：管理员天生有，来客要长期卡 + 档位开了 permFiles
            (i.key !== "file" || canFiles),
        ),
      })).filter((g) => g.items.length > 0),
    [isAdmin, canFiles],
  );
  const visible = useMemo(
    () => groups.flatMap((g) => g.items.map((i) => i.key)),
    [groups],
  );
  const meta = SECTION_META[section];

  // 权限收窄（或分组变化）后，把停在隐藏分区上的选择拉回来
  useEffect(() => {
    if (!visible.includes(section) && visible.length) onSection(visible[0]);
  }, [visible, section, onSection]);

  return (
    <div className="settings-app">
      <aside className="settings-sidebar">
        <div className="sidebar-header">
          <button
            className="back-btn"
            title="返回对话"
            onClick={() => onNav("chat")}
          >
            <Icon name="arrow-left" size={17} />
          </button>
          <h1 className="sidebar-title">设置</h1>
        </div>

        <nav className="settings-nav">
          {groups.map((g) => (
            <div className="nav-group" key={g.title}>
              <div className="nav-group-title">{g.title}</div>
              {g.items.map((i) => (
                <button
                  key={i.key}
                  className={`nav-item ${section === i.key ? "on" : ""}`}
                  onClick={() => onSection(i.key)}
                >
                  <span className="nav-indicator" />
                  <Icon name={i.icon} size={16} />
                  <span className="nav-label">{i.label}</span>
                </button>
              ))}
            </div>
          ))}
        </nav>

        <div className="sidebar-footer">
          <div className="character-card">
            <div className="avatar-ring">
              <div className="character-avatar">e</div>
            </div>
            <div className="character-meta">
              <span className="character-name">ericher</span>
              <span
                className="character-status"
                data-off={online ? "false" : "true"}
              >
                <span className="status-dot" />
                {online ? "在线" : "连接中"}
              </span>
            </div>
          </div>
        </div>
      </aside>

      <section className="settings-main">
        <div className="settings-scroll">
          <div className="settings-content">
            <header className="page-header">
              <h2 className="page-title">{meta.title}</h2>
              <p className="page-desc">{meta.desc}</p>
            </header>

            {section === "profile" && (
              <div className="settings-card">
                <div className="card-header">
                  <h3 className="card-title">身份</h3>
                  <p className="card-desc">
                    {isAdmin
                      ? "称呼和签名写在这：左下角那张身份卡按它显示，保存即刻生效"
                      : "登录状态由门禁密码决定，管理员才有写权限"}
                  </p>
                </div>
                {isAdmin ? (
                  <AdminIdentityFields
                    guestName={state.guestName}
                    adminBio={state.adminBio}
                  />
                ) : (
                  <div className="form-field" style={{ marginBottom: 14 }}>
                    <label className="form-label">当前角色</label>
                    <input className="form-input" value="访客" readOnly />
                  </div>
                )}
                <div className="form-field" style={{ marginBottom: 14 }}>
                  <label className="form-label">
                    设备标识（会话索引按它分片）
                  </label>
                  <input className="form-input" value={deviceId()} readOnly />
                </div>
                <div className="toggle-list">
                  <div className="toggle-row">
                    <div className="toggle-info">
                      <div className="toggle-icon">
                        <Icon name="refresh" size={17} />
                      </div>
                      <div className="toggle-text">
                        <div className="toggle-title">连接状态</div>
                        <div className="toggle-desc">
                          {online ? "已连上 CoworkAgent" : "正在建立连接…"}
                        </div>
                      </div>
                    </div>
                    <span className={`tag ${online ? "ok" : "ghost"}`}>
                      {online ? "在线" : "连接中"}
                    </span>
                  </div>
                </div>
                <div className="row-actions" style={{ marginTop: 16 }}>
                  <button className="save-btn" onClick={onLogout}>
                    <Icon name="arrow-left" size={16} />
                    <span>退出登录</span>
                  </button>
                </div>
              </div>
            )}

            {section === "about" && (
              <div className="settings-card">
                <div className="card-header">
                  <h3 className="card-title">ericher</h3>
                  <p className="card-desc">
                    接待台的助手：问清来意、办能办的事、办不了的如实转达
                  </p>
                </div>
                <div className="toggle-list">
                  <div className="toggle-row">
                    <div className="toggle-info">
                      <div className="toggle-icon">
                        <Icon name="layers" size={17} />
                      </div>
                      <div className="toggle-text">
                        <div className="toggle-title">运行形态</div>
                        <div className="toggle-desc">
                          Cloudflare Workers + Durable Object，状态持久在 agent
                          里
                        </div>
                      </div>
                    </div>
                  </div>
                  <div className="toggle-row">
                    <div className="toggle-info">
                      <div className="toggle-icon">
                        <Icon name="book-open" size={17} />
                      </div>
                      <div className="toggle-text">
                        <div className="toggle-title">记忆</div>
                        <div className="toggle-desc">
                          SQLite 记忆库，按分类组织，支持语义检索
                        </div>
                      </div>
                    </div>
                  </div>
                  <div className="toggle-row">
                    <div className="toggle-info">
                      <div className="toggle-icon">
                        <Icon name="clipboard" size={17} />
                      </div>
                      <div className="toggle-text">
                        <div className="toggle-title">文件</div>
                        <div className="toggle-desc">
                          R2 云盘，上传后 ericher 可以直接读
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* 额度账只有管理员看得到：它是这间屋子的运行账，不是访客该操心的 */}
            {section === "about" && <VersionCard />}

            {section === "about" && isAdmin && (
              <div className="settings-card">
                <div className="card-header">
                  <h3 className="card-title">今天的额度</h3>
                  <p className="card-desc">
                    他每天能写 10 万行；写满了连翻记忆都做不到，要等早上八点重置
                  </p>
                </div>
                <QuotaPanel />
              </div>
            )}

            {section === "style" && (
              <div className="settings-card">
                <div className="card-header">
                  <h3 className="card-title">思考深度</h3>
                  <p className="card-desc">
                    深度模式会让 ericher 想得更久，也更愿意展开推理过程
                  </p>
                </div>
                <div className="style-options">
                  <label className="style-card">
                    <input
                      type="radio"
                      name="style"
                      checked={state.thinkMode !== "deep"}
                      onChange={() => setThink("normal")}
                    />
                    <div className="style-card-inner">
                      <div className="style-icon">
                        <Icon name="type" size={20} />
                      </div>
                      <div className="style-title">普通模式</div>
                      <div className="style-desc">直接给答案，快而不啰嗦</div>
                    </div>
                  </label>
                  <label className="style-card">
                    <input
                      type="radio"
                      name="style"
                      checked={state.thinkMode === "deep"}
                      onChange={() => setThink("deep")}
                    />
                    <div className="style-card-inner">
                      <div className="style-icon">
                        <Icon name="compass" size={20} />
                      </div>
                      <div className="style-title">深度思考</div>
                      <div className="style-desc">
                        先推理再作答，适合复杂问题
                      </div>
                    </div>
                  </label>
                </div>
                {isAdmin && (
                  <StyleAssign
                    deepConfigId={state.deepConfigId}
                    patch={patch}
                  />
                )}
              </div>
            )}

            {section === "voice" && (
              <div className="settings-card">
                <VoicePanel
                  voices={voices}
                  current={state.voice}
                  fallback={voiceDefault}
                  cloud={voiceCloud}
                  patch={patch}
                />
              </div>
            )}

            {section === "memory" && (
              <div className="settings-card">
                <MemoryPanel />
              </div>
            )}

            {section === "ledger" && (
              <div className="settings-card">
                <LedgerPanel
                  isAdmin={isAdmin}
                  cardId={card?.id ?? null}
                  canPublic={canPublic}
                />
              </div>
            )}

            {section === "contact" && (
              <div className="settings-card">
                <ContactPanel />
              </div>
            )}

            {section === "session" && (
              <div className="settings-card">
                <SessionSection
                  list={sessions}
                  active={activeSession}
                  onSwitch={onSwitchSession}
                  onRename={onRenameSession}
                  onDelete={onDeleteSession}
                  onToggleVisibility={onToggleVisibility}
                  onToggleArchive={onToggleArchive}
                  onTogglePin={onTogglePin}
                  summaries={state.summaries ?? []}
                />
              </div>
            )}

            {section === "file" && (
              <div className="settings-card">
                <FilePanel sessions={sessions} />
              </div>
            )}

            {section === "visitors" && (
              <div className="settings-card">
                <VisitorsPanel />
              </div>
            )}

            {section === "guestTypes" && (
              <div className="settings-card">
                <GuestTypesPanel />
              </div>
            )}

            {section === "guestPerms" && (
              <div className="settings-card">
                <GuestPermsPanel />
              </div>
            )}

            {section === "modelConfigs" && (
              <div className="settings-card">
                <ModelConfigsPanel />
              </div>
            )}

            {section === "ttsConfigs" && (
              <div className="settings-card">
                <TtsConfigsPanel />
              </div>
            )}

            {section === "drawConfigs" && (
              <div className="settings-card">
                <DrawConfigsPanel />
              </div>
            )}

            {section === "searchConfigs" && (
              <div className="settings-card">
                <SearchConfigsPanel />
              </div>
            )}

            {section === "task" && (
              <div className="settings-card">
                <TaskPanel state={state} patch={patch} readOnly={!isAdmin} />
              </div>
            )}

            {section === "remind" && (
              <div className="settings-card">
                <ReminderPanel />
              </div>
            )}

            {section === "skills" && (
              <div className="settings-card">
                <div className="card-header">
                  <h3 className="card-title">技能配方</h3>
                  <p className="card-desc">
                    每行一步，写清让 ericher 怎么做；对话里说一句「用 XX
                    技能」他就会照着走
                  </p>
                </div>
                <SkillPanel state={state} patch={patch} />
              </div>
            )}

            {section === "prompt" && (
              <div className="settings-card">
                <PromptPanel state={state} patch={patch} />
              </div>
            )}

            {section === "toolPrompt" && (
              <div className="settings-card">
                <ToolGuidePanel state={state} patch={patch} />
              </div>
            )}

            {section === "recapPrompt" && (
              <div className="settings-card">
                <RecapGuidePanel state={state} patch={patch} />
              </div>
            )}

            {section === "self" && (
              <div className="settings-card">
                <SelfPanel state={state} patch={patch} />
              </div>
            )}

            {section === "appearance" && (
              <>
                <div className="settings-card">
                  <div className="card-header">
                    <h3 className="card-title">外观主题</h3>
                    <p className="card-desc">
                      同一套版式换几种纸色；跟随系统按系统的明暗自动翻面
                    </p>
                  </div>
                  <div className="theme-options">
                    {(
                      [
                        { key: "paper", name: "白纸黑字", cls: "theme-paper" },
                        { key: "dawn", name: "晨曦微蓝", cls: "theme-dawn" },
                        { key: "dark", name: "夜墨", cls: "theme-dark" },
                        {
                          key: "system",
                          name: "跟随系统",
                          cls: "theme-system",
                        },
                      ] as { key: ThemeKey; name: string; cls: string }[]
                    ).map((t) => (
                      <label key={t.key} className="theme-option">
                        <input
                          type="radio"
                          name="theme"
                          checked={theme === t.key}
                          onChange={() => setTheme(t.key)}
                        />
                        <div className={`theme-preview ${t.cls}`}>
                          <span className="theme-ring" />
                        </div>
                        <span className="theme-name">{t.name}</span>
                      </label>
                    ))}
                  </div>
                </div>

                <div className="settings-card">
                  <div className="card-header">
                    <h3 className="card-title">动画效果</h3>
                    <p className="card-desc">关掉之后界面动画与过渡都停下</p>
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
                            背景微晕与界面的过渡动画
                          </div>
                        </div>
                      </div>
                      <label className="toggle-switch">
                        <input
                          type="checkbox"
                          checked={motion}
                          onChange={(e) => setMotion(e.target.checked)}
                        />
                        <span className="toggle-slider" />
                      </label>
                    </div>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
