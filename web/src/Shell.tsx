import { useComposerDraft } from "./hooks/useComposerDraft";
import { queuedDraftMatches, type QueuedDraft, type DraftSnapshot } from "./lib/composerDraft";
import { FailedDrafts } from "./components/FailedDrafts";
import { useChatConnection } from "./hooks/useChatConnection";
import { useAttachmentDraft } from "./hooks/useAttachmentDraft";
import { useSessionList } from "./hooks/useSessionList";
import { writeLocalView } from "./lib/viewStorage";
import { readAsDataURL } from "./lib/attachments";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  lazy,
  type CSSProperties,
} from "react";
import { api, type Role } from "./lib/api";
import {
  agentDisplay,
  useTheme,
} from "./lib/theme";
import {
  canDictate,
  canSpeak,
  speak,
  startDictation,
  stopSpeaking,
  textOf,
} from "./lib/speech";
import { resolveStartView } from "./lib/lastView";
import type {
  AskEntry,
  ChatState,
  LastUsage,
  SessionMeta,
  SessionTask,
  SettingsKey,
  ThemeKey,
  UserCard,
  ViewKey,
  Voice,
} from "./lib/types";
import { Icon, type IconName } from "./components/Icons";
import { SessionPlanBar } from "./components/SessionPlanBar";
import { ThemeBackdrop } from "./components/ThemeBackdrop";
import {
  Backdrop,
  ChatSidebar,
  Shield,
} from "./components/Pages";

import { LoadingBoundary } from "./components/LoadingBoundary";
import { drawerMounted, rememberDrawer, type DrawerVisits } from "./lib/drawerKeepMounted";
// 看图层约 70 KiB（gzip），且只在消息/笔记里真有图时才用得上。
// 挂到有内容之后再加载：门禁与空会话首屏不必为它付费。
const Lightbox = lazy(() =>
  import("./components/Lightbox").then((m) => ({ default: m.Lightbox })),
);
const Messages = lazy(() => import("./components/Messages").then(module => ({ default: module.Messages })));
const NoteDrawer = lazy(() => import("./components/NoteDrawer").then(module => ({ default: module.NoteDrawer })));
const NotePage = lazy(() => import("./components/NotePage").then(module => ({ default: module.NotePage })));
const SessionMemoryDrawer = lazy(() => import("./components/SessionMemoryDrawer").then(module => ({ default: module.SessionMemoryDrawer })));
const SessionMemoryPage = lazy(() => import("./components/SessionMemoryPage").then(module => ({ default: module.SessionMemoryPage })));
const MailboxPage = lazy(() => import("./components/MailboxPage").then(module => ({ default: module.MailboxPage })));
const SessionPlanDrawer = lazy(() => import("./components/SessionPlanDrawer").then(module => ({ default: module.SessionPlanDrawer })));
const SettingsPage = lazy(() => import("./components/SettingsPage").then(module => ({ default: module.SettingsPage })));

/**
 * 快捷指令表：同时喂给「/」菜单、回车解析与身份裁剪。
 * say = 换成自然语言交给他（要他的判断）；ui = 前端当场做完 ——
 * 以前也写句话让他调工具，白烧一轮 token，状态还未必真变。
 */
/**
 * 消息列表只挂最近这一层的条数，翻到顶再放一层。历史仍在 SDK 消息库与模型上下文里，
 * 这里只管屏幕：几百条一次 mount，弱设备要画好几秒。
 */
const MSG_WIN = 50;

type Cmd = {
  name: string;
  label: string;
  desc: string;
  icon: IconName;
  /** 访客也能用。不标就是主人专属：他手上没有那些工具，列出来才是骗人 */
  guest?: boolean;
  /**
   * 这条指令收不收行内参数（值是提示写的什么）。有它，敲「名字 + 空格 + 内容」才认；
   * 没有，名字后跟字就当正经说话，不吞。空指令永远认。
   */
  argHint?: string;
} & (
  | { kind: "say"; text: string }
  | {
      kind: "ui";
      run:
        | "deep"
        | "normal"
        | "new"
        | "ledger"
        | "plan"
        | "memory"
        | "tasks"
        | "skills";
    }
);

const COMMANDS: Cmd[] = [
  {
    name: "/help",
    label: "看看能做什么",
    desc: "列出他当前能做的事，和怎么开口",
    icon: "help-circle",
    guest: true,
    kind: "say",
    text: "列出你现在能办的事，以及我可以怎么开口。",
  },
  {
    name: "/memory",
    label: "记忆库现状",
    desc: "多少条、都分布在哪些分类里",
    icon: "book-open",
    kind: "ui",
    run: "memory",
  },
  {
    name: "/tasks",
    label: "看看待办",
    desc: "列出当前的任务和各自的状态",
    icon: "clipboard",
    kind: "ui",
    run: "tasks",
  },
  {
    name: "/skills",
    label: "技能配方",
    desc: "他保存下来的那些成套做法",
    icon: "layers",
    kind: "ui",
    run: "skills",
  },
  {
    name: "/organize",
    label: "整理一下",
    desc: "把这段对话里值得长期记住的记下来",
    icon: "archive",
    kind: "say",
    text: "整理一下我们的对话历史，把值得长期记住的东西记下来。",
  },
  {
    name: "/self",
    label: "复盘接待",
    desc: "复盘最近的对话，看看哪里要改进",
    icon: "eye",
    kind: "say",
    text: "复盘一下最近的对话，看看哪里要改进。",
  },
  {
    name: "/deep",
    label: "深度思考",
    desc: "接下来想得更深，节奏慢一些",
    icon: "compass",
    guest: true,
    kind: "ui",
    run: "deep",
  },
  {
    name: "/normal",
    label: "普通模式",
    desc: "换回平常的节奏",
    icon: "message",
    guest: true,
    kind: "ui",
    run: "normal",
  },
  {
    name: "/plan",
    label: "定本场目标",
    desc: "只给这一场定目标，当场生效 —— 也可以直接写 /plan 要干什么",
    icon: "flag",
    kind: "ui",
    run: "plan",
    argHint: "要干什么",
  },
  {
    name: "/new",
    label: "开一场新对话",
    desc: "换个话题就换一场，旧的那场还留着",
    icon: "plus",
    guest: true,
    kind: "ui",
    run: "new",
  },
  {
    name: "/记一笔",
    label: "往账本上写一句",
    desc: "记在公开账本上，事后随时能查",
    icon: "edit",
    guest: true,
    kind: "ui",
    run: "ledger",
  },
];

/** 这个人手上真有的指令。访客不该看见自己做不了的 —— 那不是清单，是误导 */
function commandsFor(isAdmin: boolean): Cmd[] {
  return COMMANDS.filter((c) => isAdmin || c.guest);
}

const MOTION_KEY = "xm_motion";
/** 外观主题的本机选择（见 ThemeKey）；appearance 是设备本地的事，不进后端 */
const THEME_KEY = "xm_theme";
/** 访客介绍页的本机记号：进过一次，这台机器上就不再弹第二次 */
const INTRO_KEY = "introDone";

/** 提问卡上的自写答案框，回车直接作答。 */
function AskInlineInput({
  onSend,
  disabled,
}: {
  onSend: (text: string) => void;
  /** 答案正在送：把它也锁上，免得同一张卡送出两份回答 */
  disabled?: boolean;
}) {
  const [draft, setDraft] = useState("");
  return (
    <div className="ask-inline">
      <input
        className="ask-inline-input"
        value={draft}
        disabled={disabled}
        placeholder="自己写一句，回车就发"
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          // isComposing 守卫：中文输入法按回车确认候选词时 key 也是 Enter，
          // 那一下是给输入法的，不是要发送 —— 没守卫会把半句话直接发出去
          if (e.key === "Enter" && !e.nativeEvent.isComposing && draft.trim()) {
            onSend(draft.trim());
            setDraft("");
          }
        }}
      />
    </div>
  );
}

/**
 * 聊天头部的上下文占用牌：默认显示「~38K / 200K」，点一下切成缓存命中详情，
 * 再点切回 —— 悬停提示（title）手机上没有，点按是手机电脑都好使的开关。
 */
function UsageChip({ usage }: { usage: LastUsage }) {
  const [detail, setDetail] = useState(false);
  const hit = Math.round((usage.cacheRead / Math.max(usage.input, 1)) * 100);
  return (
    <button
      className={`chip chip-usage${detail ? " on" : ""}`}
      title={`缓存命中 ${hit}%（输入 ${usage.input} · 输出 ${usage.output}）—— 点按切换`}
      onClick={() => setDetail((v) => !v)}
    >
      {detail ? (
        <span>
          命中 {hit}% · 入 {Math.round(usage.input / 1000)}K · 出{" "}
          {Math.round(usage.output / 1000)}K
        </span>
      ) : (
        <span>
          ~{Math.round((usage.input + usage.output) / 1000)}K
          {usage.contextWindow
            ? ` / ${Math.round(usage.contextWindow / 1000)}K`
            : ""}
        </span>
      )}
    </button>
  );
}

/**
 * 进门介绍页：三种登记（临时进入 / 登卡 / 领卡，见 userCards.ts）。它是一层覆盖而非路由，
 * 只在第一次出现；本机 localStorage 与后端 guestName 两道闸，老访客换机器也不再弹。
 * 登卡/领卡成功整页重载（cookie 已换，重连即自己那间）；领卡是当前房间整体升级，历史不搬。
 */
function GuestIntro({
  onDone,
  flash,
}: {
  onDone: () => void;
  flash: (text: string) => void;
}) {
  const [mode, setMode] = useState<"temp" | "card" | "claim">("temp");
  const [nickname, setNickname] = useState("");
  const [origin, setOrigin] = useState("");
  const [purpose, setPurpose] = useState("");
  const [email, setEmail] = useState("");
  const [cardPw, setCardPw] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  // 介绍页报的名、门口那个字母 —— 都随主题换
  const { theme } = useTheme();
  const agent = agentDisplay(theme);

  const finish = () => {
    localStorage.setItem(INTRO_KEY, "1");
    onDone();
  };

  /** 登卡 / 领卡成功：cookie 已经换掉，重载后连进卡绑定的那间屋 */
  const reenter = () => {
    localStorage.setItem(INTRO_KEY, "1");
    window.location.reload();
  };

  const enter = async () => {
    if (busy) return;
    // 临时进入：昵称必填，来历可空 —— 这张台子总得知道怎么称呼眼前的人
    if (mode === "temp" && !nickname.trim()) {
      setErr("怎么称呼你总要留一个，不然我不知道喊你什么");
      return;
    }
    setBusy(true);
    setErr("");
    try {
      if (mode === "temp") {
        await api.guestIntro({
          nickname: nickname.trim(),
          origin: origin.trim() || undefined,
        });
        finish();
      } else if (mode === "card") {
        await api.cardLogin({ name: nickname.trim(), password: cardPw });
        reenter();
      } else {
        await api.cardCreate({
          name: nickname.trim(),
          purpose: purpose.trim(),
          password: cardPw,
          email: email.trim() || undefined,
        });
        reenter();
      }
    } catch (e) {
      const msg = (e as Error).message;
      if (mode === "temp") {
        // 提交失败不把人拦在门外：称呼没记上，接待照样开始
        flash(`称呼没记上（${msg}），先请进`);
        finish();
      } else {
        setErr(msg || "没成，再试一次");
      }
    } finally {
      setBusy(false);
    }
  };

  /** 介绍页不借 styles.css 里任何一个类：它自己站得住，改样式不必穿过整个文件 */
  const field: CSSProperties = {
    width: "100%",
    boxSizing: "border-box",
    border: "1px solid var(--yuzhe-line)",
    borderRadius: 6,
    background: "var(--yuzhe-surface)",
    color: "var(--yuzhe-ink)",
    padding: "9px 12px",
    fontSize: 14,
    outline: "none",
  };
  const line: CSSProperties = {
    margin: "0 0 6px",
    lineHeight: 1.8,
    color: "var(--yuzhe-ink-dim)",
    fontSize: 14,
  };

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 200,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "rgba(31, 35, 41, 0.44)",
        padding: 24,
      }}
    >
      {/* 登录壁纸：铺在遮罩里（absolute），介绍卡浮在它上面 */}
      <ThemeBackdrop scope="login" variant="absolute" />
      <div
        style={{
          position: "relative",
          zIndex: 1,
          width: "100%",
          maxWidth: 430,
          border: "1px solid var(--yuzhe-line)",
          borderRadius: 16,
          background: "var(--yuzhe-surface)",
          color: "var(--yuzhe-ink)",
          boxShadow: "var(--yuzhe-shadow-pop)",
          padding: "30px 28px",
        }}
      >
        {/* 没立绘就还是那个字母；主题给了头像就换头像 */}
        <div
          style={{
            width: 44,
            height: 44,
            borderRadius: "50%",
            border: "none",
            background: "var(--yuzhe-black)",
            color: "var(--yuzhe-on-black)",
            fontFamily: "var(--font-display)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 20,
            fontWeight: 600,
            marginBottom: 16,
            overflow: "hidden",
          }}
        >
          {agent.avatar ? (
            <img
              src={agent.avatar}
              alt=""
              style={{
                width: "100%",
                height: "100%",
                objectFit: "cover",
              }}
            />
          ) : (
            agent.name.slice(0, 1)
          )}
        </div>
        <h2
          style={{
            margin: "0 0 12px",
            fontSize: 20,
            fontWeight: 600,
            letterSpacing: "0.02em",
          }}
        >
          这里是 {agent.name} 的接待台
        </h2>
        <p style={line}>我是 {agent.name}，这间接待台的助手。</p>
        <p style={line}>先说说你是谁、为什么来。能办的事，我当场办。</p>
        <p style={{ ...line, marginBottom: 20 }}>办不了的，原话记下来转达。</p>
        <p style={{ ...line, fontSize: 12, marginBottom: 20 }}>
          对话与操作会留痕存档；管理员可在自己的屋里按需查看本房间的聊天记录。
        </p>
        {/* 三种登记方式的小切换条：样式自成一体，跟介绍页其他部分一样不借外部类 */}
        <div
          style={{
            display: "flex",
            gap: 4,
            padding: 3,
            border: "1px solid var(--yuzhe-line)",
            borderRadius: 8,
            marginBottom: 16,
          }}
        >
          {(
            [
              ["temp", "临时进入"],
              ["card", "登卡"],
              ["claim", "领长期身份"],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              onClick={() => {
                setMode(key);
                setErr("");
              }}
              style={{
                flex: 1,
                border: "none",
                borderRadius: 6,
                padding: "7px 0",
                fontSize: 13,
                cursor: "pointer",
                background: mode === key ? "var(--yuzhe-black)" : "transparent",
                color:
                  mode === key
                    ? "var(--yuzhe-on-black)"
                    : "var(--yuzhe-ink-dim)",
                fontWeight: mode === key ? 600 : 400,
              }}
            >
              {label}
            </button>
          ))}
        </div>
        {mode === "temp" && (
          <>
            <label
              style={{
                display: "block",
                fontSize: 12,
                color: "var(--yuzhe-ink-faint)",
                margin: "0 0 6px",
              }}
            >
              怎么称呼你
            </label>
            <input
              value={nickname}
              onChange={(e) => setNickname(e.target.value)}
              placeholder="昵称（必填）"
              maxLength={30}
              style={{ ...field, marginBottom: 12 }}
            />
            <label
              style={{
                display: "block",
                fontSize: 12,
                color: "var(--yuzhe-ink-faint)",
                margin: "0 0 6px",
              }}
            >
              来历（可选）
            </label>
            <input
              value={origin}
              onChange={(e) => setOrigin(e.target.value)}
              placeholder="哪家来的、受谁所托"
              maxLength={60}
              style={{ ...field, marginBottom: 20 }}
            />
          </>
        )}
        {mode === "card" && (
          <>
            <p style={{ ...line, marginBottom: 12 }}>
              有长期身份卡的老朋友，凭昵称和密码回到自己的房间。
            </p>
            <input
              value={nickname}
              onChange={(e) => setNickname(e.target.value)}
              placeholder="昵称"
              maxLength={40}
              style={{ ...field, marginBottom: 12 }}
            />
            <input
              type="password"
              value={cardPw}
              onChange={(e) => setCardPw(e.target.value)}
              placeholder="卡密码"
              maxLength={72}
              style={{ ...field, marginBottom: 20 }}
            />
          </>
        )}
        {mode === "claim" && (
          <>
            <p style={{ ...line, marginBottom: 12 }}>
              领一张长期身份卡：现在这间屋子从此就是你的，历史一条不搬。
            </p>
            <input
              value={nickname}
              onChange={(e) => setNickname(e.target.value)}
              placeholder="昵称（全局唯一，必填）"
              maxLength={40}
              style={{ ...field, marginBottom: 12 }}
            />
            <input
              value={purpose}
              onChange={(e) => setPurpose(e.target.value)}
              placeholder="你为什么来（必填）"
              maxLength={300}
              style={{ ...field, marginBottom: 12 }}
            />
            <input
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="邮箱（选填，仅作登记）"
              maxLength={120}
              style={{ ...field, marginBottom: 12 }}
            />
            <input
              type="password"
              value={cardPw}
              onChange={(e) => setCardPw(e.target.value)}
              placeholder="卡密码（至少 6 位）"
              maxLength={72}
              style={{ ...field, marginBottom: 20 }}
            />
          </>
        )}
        {err && (
          <p
            style={{
              margin: "0 0 12px",
              fontSize: 13,
              color: "var(--yuzhe-danger, #b3261e)",
            }}
          >
            {err}
          </p>
        )}
        <div style={{ display: "flex", gap: 10 }}>
          <button
            onClick={() => void enter()}
            disabled={busy}
            style={{
              flex: 1,
              border: "none",
              borderRadius: 6,
              background: "var(--yuzhe-black)",
              color: "var(--yuzhe-on-black)",
              padding: "10px 0",
              fontSize: 14,
              fontWeight: 600,
              cursor: busy ? "default" : "pointer",
            }}
          >
            {busy
              ? "请稍候…"
              : mode === "temp"
                ? "进入"
                : mode === "card"
                  ? "凭卡登入"
                  : "领卡并进入"}
          </button>
          {mode === "temp" && (
            <button
              onClick={finish}
              disabled={busy}
              style={{
                border: "1px solid var(--yuzhe-line)",
                borderRadius: 6,
                background: "var(--yuzhe-surface)",
                color: "var(--yuzhe-ink-dim)",
                padding: "10px 18px",
                fontSize: 14,
                cursor: "pointer",
              }}
            >
              跳过
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export function Shell({
  role,
  agentName,
  onLock,
}: {
  role: Role;
  agentName: string;
  onLock: () => void;
}) {
  // 基础屋由后端按身份指定（来客必须进自己那间）；每场新对话有自己的场屋（人屋--场id），
  // name 一变 socket 自动重连、历史按屋灌回。初值优先本机落点，省一次 DO 冷启动。
  const { activeRoom, setActiveRoom, agent, messages, sendMessage, status, stop, regenerate,
    state, busy: connectionBusy, online, thinkDeep } = useChatConnection(agentName);
  const isAdmin = role === "admin";
  /** 第一次来的访客先过一遍介绍页。管理员不用；后端已经记下称呼的老访客也不用 */
  const [introDone, setIntroDone] = useState(
    () => localStorage.getItem(INTRO_KEY) === "1",
  );
  const finishIntro = useCallback(() => setIntroDone(true), []);
  // 介绍层只在「第一次来、还没自报过家门」时出现。
  // 等 agent.state 同步完再判断（!!agent.state）：老访客刷新的那一瞬间不至于被闪一层
  const showIntro = !isAdmin && !introDone && !!agent.state && !state.guestName;

  // 长期身份卡：进来时问一次就不再问（登卡/领卡/解卡都会整页重载，重新走这里）。
  // 临时票回 card:null；管理员不问 —— 一码通行，没有卡这一说
  const [card, setCard] = useState<UserCard | null>(null);
  useEffect(() => {
    if (isAdmin) return;
    api
      .cardInfo()
      .then((r) => setCard(r.card ?? null))
      .catch(() => {});
  }, [isAdmin]);
  // 笔记本入口：管理员总在；来客要长期卡且所属档位开了记事本权益
  const canNotes = isAdmin || (!!card && (state.guestType?.permNotes ?? false));
  // 公开墙的贴条资格：同一套逻辑，档位开的是 permPublic
  const canPublic =
    isAdmin || (!!card && (state.guestType?.permPublic ?? false));
  // 云盘文件面板：同一把 permFiles 权益 —— 能往云盘传东西的，也该能翻自己那间
  const canFiles = isAdmin || (!!card && (state.guestType?.permFiles ?? false));

  const [view, setView] = useState<ViewKey>("chat");
  const [section, setSection] = useState<SettingsKey>("profile");
  const [motion, setMotion] = useState(
    () => localStorage.getItem(MOTION_KEY) !== "off",
  );
  const [theme, setTheme] = useState<ThemeKey>(() => {
    const saved = localStorage.getItem(THEME_KEY) as ThemeKey | null;
    return saved === "dawn" || saved === "dark" || saved === "system"
      ? saved
      : "paper";
  });
  // 主题里的他叫什么、长什么样（本组件的 theme 已被配色档占了名，换个叫法）
  const { theme: themeConfig } = useTheme();
  const persona = agentDisplay(themeConfig);
  const { sessions, sessionsLoaded, sessionsOk, loadSessions } = useSessionList();
  /**
   * 开机落点拍板完成 —— 状态恢复的唯一入口。
   * 以前后端同步与独立恢复器各跑各的，会先画出错误的一场再跳；现在清单到位前正文空着、
   * 遮罩提示接入，到位后一次定下落点，之后的变化再交回后端同步。
   */
  const [startupDone, setStartupDone] = useState(false);
  /** 这台机器上能用的嗓子。拿不到（比如来客）就是空的，设置页自然不显示这一块 */
  const [voices, setVoices] = useState<Voice[]>([]);
  /** 没选嗓音时后端实际会用哪一副。设置页要把它标出来，否则一列选项没人认领 */
  const [voiceDefault, setVoiceDefault] = useState("");
  const [voiceCloud, setVoiceCloud] = useState(false);
  /** 嗓子清单拉过没有。拉过之后只有进设置页才重拉，别每次切页都去戳后端 */
  const voicesLoadedRef = useRef(false);
  const [activeSession, setActiveSession] = useState("");
  /**
   * 正在换场。新屋把状态推回来前，屏幕摆的还是旧场 —— 不遮会让人以为「点了没反应」
   * 再点一次，两次切换互相追着改。遮罩 + 侧栏先跳，是把空窗明说出来。
   */
  const [switching, setSwitching] = useState<{
    id: string;
    title: string;
    mode: "new" | "switch";
    /** 要去的那间屋：知道了就能先把这一场的东西取回来，别等落地再排队 */
    room?: string;
  } | null>(null);
  /**
   * 已点「新建」但还没开出来的场。新建不连屋：每间场屋是一个 DO 实例，
   * 「点了没说话就走」会留下看不见也删不掉的屋。先只握屋名 + 场 id，
   * 等第一句话真要说出口再换连接；侧栏也不插行，免得出现点不开的假会话。
   */
  const [pendingRoom, setPendingRoom] = useState<{
    id: string;
    room: string;
  } | null>(null);
  // 新建只是视图，旧连接即使还在运行也不占新草稿的 busy。
  const busy = !pendingRoom && connectionBusy;
  const visibleRoom = useRef(activeRoom);
  visibleRoom.current = pendingRoom?.room ?? activeRoom;
  /** 等着屋开出来再补发的那一句话 —— 只可能是这一场的第一句 */
  const queuedSend = useRef<QueuedDraft<Parameters<typeof sendMessage>[0]> | null>(null);
  const [drawer, setDrawer] = useState(false);
  /** 左边的笔记本抽屉。和会话列表抽屉互斥 —— 两块东西都贴左边，同时拉开只会叠在一起 */
  const [noteDrawer, setNoteDrawer] = useState(false);
  /** 左边的回想抽屉。和笔记本互斥，理由同上 */
  const [memoDrawer, setMemoDrawer] = useState(false);
  /** 左边的本场计划抽屉（本场目标 + 步骤）。和上面两块左边的东西互斥 */
  const [planDrawer, setPlanDrawer] = useState(false);
  const [visitedDrawers, setVisitedDrawers] = useState<DrawerVisits>({ note: false, memo: false, plan: false });
  useEffect(() => {
    setVisitedDrawers(previous => rememberDrawer(previous, { note: noteDrawer, memo: memoDrawer, plan: planDrawer }));
  }, [noteDrawer, memoDrawer, planDrawer]);
  /**
   * 这一场的计划（目标 + 步骤）。内容不在 state 里，得按 room/session 去
   * /api/session-plan 拉；state.planRev 一变就重拉一次（见下面的 effect）。
   */
  const [sessionPlan, setSessionPlan] = useState<{
    goal: string;
    tasks: SessionTask[];
  }>({ goal: "", tasks: [] });
  const draftScope = `${pendingRoom?.room ?? switching?.room ?? activeRoom}:${activeSession}`;
  const composerDraft = useComposerDraft(draftScope);
  const { input, setInput } = composerDraft;
  const draftScopeRef = useRef(draftScope);
  draftScopeRef.current = draftScope;
  const preparation = useRef(0);
  const [notice, setNotice] = useState("");
  /**
   * 这一轮他在想什么：服务端隔几秒翻一句过来（think.ts）。来客看不到真推理，
   * 不送这句就只剩空气泡，和「卡了」分不清。
   */
  const [thoughts, setThoughts] = useState<string[]>([]);
  const thoughtTurn = useRef(0);
  const [listening, setListening] = useState(false);
  const [speakingId, setSpeakingId] = useState("");
  /** 有文件正被拖在窗口上方：整块地方亮起来，告诉他可以松手了 */
  const [dragOver, setDragOver] = useState(false);
  /** 「/」菜单里光标停在第几条 */
  const [cmdIdx, setCmdIdx] = useState(0);
  /** 按 Esc 把菜单关掉了（再打字就重新打开）。不记这个的话 Esc 关不掉它 */
  const [cmdOff, setCmdOff] = useState(false);

  const cmds = useMemo(() => commandsFor(isAdmin), [isAdmin]);
  /** 正在打指令名：以 / 开头、还没敲空格。敲了空格就说明后面是正经内容，不该再挡着他 */
  const picking = input.startsWith("/") && !/\s/.test(input) && !cmdOff;
  const matched = picking
    ? cmds.filter((c) => c.name.toLowerCase().startsWith(input.toLowerCase()))
    : [];
  const cmdCursor = Math.min(cmdIdx, Math.max(matched.length - 1, 0));

  const stream = useRef<HTMLElement>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const ta = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const stick = useRef(true);
  /**
   * 落底旗：切进有记录的场就落在最新末尾，不从开头翻。平时自动滚动只认 stick，
   * 但从旧账里切出来时 stick 是假的；开机首屏也靠它跳过「从顶滑到底」的动画。
   */
  const jumpBottom = useRef(true);
  const rec = useRef<{ stop: () => void } | null>(null);
  /** 按下麦克风之前输入框里已有的内容，语音识别出来的接在它后面 */
  const dictBase = useRef("");
  /** 这条是我用说的写的 */
  const dictated = useRef(false);
  /** 这条要用说的回 */
  const voiceReply = useRef(false);
  const wasBusy = useRef(false);
  const noticeTimer = useRef(0);
  // 新建会话 / 整理的连点门闩：手机双击很常见，重入会造出两间互相覆盖的场屋
  const creatingRef = useRef(false);
  /** 换场遮罩的保险丝（见 beginSwitch）：新屋一直不回话也得把遮罩撤掉 */
  const switchFuse = useRef(0);
  // 朗读定序：每次朗读领一个自增 token，过期的 onEnd 不许清 speakingId（见 speakMsg）
  const speakToken = useRef(0);

  /**
   * 停滞检测：busy 期间 5 秒无新内容（消息没变、想法没翻新）就截状态报出来。
   * CF 打盹、工具卡死、上游断流都会让会话静默停下；正常结束或思考中不会触发。
   */
  const lastActivity = useRef(Date.now());
  const stallReported = useRef(false);
  const [stallReport, setStallReport] = useState<{
    at: number;
    session: string;
    msgCount: number;
    thoughtCount: number;
    lastMsgRole: string;
    toolStates: string[];
  } | null>(null);

  // busy 一变就重置：开始新一轮检测；结束时清掉报告
  useEffect(() => {
    if (busy) {
      lastActivity.current = Date.now();
      stallReported.current = false;
      setStallReport(null);
    } else {
      setStallReport(null);
      stallReported.current = false;
    }
  }, [busy]);

  // 消息或想法有更新就刷新活动时间。依赖用数组本身：长回复流式增长时条数不变，
  // 按长度刷新会把正常的流式回复误判成「停滞」。
  useEffect(() => {
    if (busy) lastActivity.current = Date.now();
  }, [messages, thoughts, busy]);

  // 轮询：每秒看一次，busy 超过 5 秒没动静就报
  useEffect(() => {
    if (!busy) return;
    const iv = setInterval(() => {
      if (!busy || stallReported.current) return;
      const elapsed = Date.now() - lastActivity.current;
      if (elapsed < 5000) return;
      stallReported.current = true;
      const lastMsg = messages[messages.length - 1];
      // 把正在跑的工具状态捞出来 —— 那些多半就是卡住的地方
      const toolStates: string[] = [];
      if (lastMsg) {
        for (const part of lastMsg.parts ?? []) {
          if (part.type?.startsWith("tool-")) {
            const st = (part as { state?: string }).state ?? "?";
            const name = (part as { toolName?: string }).toolName ?? "";
            if (st === "input-streaming" || st === "output-available") continue;
            toolStates.push(`${name}:${st}`);
          }
        }
      }
      setStallReport({
        at: Date.now(),
        session: activeSession,
        msgCount: messages.length,
        thoughtCount: thoughts.length,
        lastMsgRole: lastMsg?.role ?? "",
        toolStates,
      });
    }, 1000);
    return () => clearInterval(iv);
  }, [busy, messages, thoughts, activeSession]);

  /** 当前这一场。列表里没有它（刚点的新建、还没说过话）时就没有标题，走「新的对话」 */
  const current = sessions.find((s) => s.id === activeSession);

  /** 界面窗口：现在从最新往回挂多少条。换场/换屋收回到一层 */
  const [winSize, setWinSize] = useState(MSG_WIN);
  useEffect(() => {
    setWinSize(MSG_WIN);
  }, [activeRoom, activeSession]);

  /**
   * 我此刻是否贴着最新一条。与 stick 不同：那个是内部旗、不重渲染；
   * 这个驱动界面 —— 翻旧账时浮出「滑到底」。
   */
  const [atBottom, setAtBottom] = useState(true);
  /** 放层那一刻的 scrollHeight：prepend 之后把视口补回去，眼前那条原地不动 */
  const growAnchor = useRef<number | null>(null);

  /**
   * 摆到屏幕上的消息。换场/新建/开机未拍板时先清空：手上这份还是上一场的，
   * 遮罩是半透的，摆出来等于把上一场的话透给人看。之后再按 winSize 收窗口，
   * SDK 消息库仍是全量。
   */
  const shown =
    switching || pendingRoom || !agent.state || !startupDone ? [] : messages;
  /** 还压在窗口上面没挂出来的老消息数 */
  const olderCount = Math.max(0, shown.length - winSize);
  const shownMessages = useMemo(
    () => (olderCount ? shown.slice(-winSize) : shown),
    [shown, olderCount, winSize],
  );

  // 放层之后把视口补回去：上面插进来多高，scrollTop 就补多少 —— 眼前这条不跳
  useLayoutEffect(() => {
    if (growAnchor.current == null) return;
    const el = stream.current;
    if (el) el.scrollTop += el.scrollHeight - growAnchor.current;
    growAnchor.current = null;
  }, [shownMessages]);

  /**
   * 界面上「现在这间屋」是哪间。站在刚点的新建上时连接还在上一场，已不在眼前；
   * 名字盘、笔记本、附件都该读人屋 —— 新场屋会从人屋抄配置起步（见 onConnect）。
   */
  const uiRoom = pendingRoom ? agentName : activeRoom;

  /**
   * 本场计划存在场屋的表里，state 只给 planRev 信号。换场/换屋/改计划都重拉；
   * 换场空窗里就开拉，等落地时已在手上，免得再等一个往返。计划条空窗里不渲染。
   */
  const planSeq = useRef(0);
  /**
   * 上一次为谁拉的。抢跑那次不知道目标 planRev，记 null；落地认下版本号，
   * 免得 activeSession/switching/room 先后变化时再补跑两趟一样的。
   */
  const planFetched = useRef<{
    room: string;
    sid: string;
    rev: number | null;
  } | null>(null);
  useEffect(() => {
    const target = switching
      ? switching.room
        ? { room: switching.room, sid: switching.id }
        : null
      : state.activeSession && !pendingRoom
        ? { room: uiRoom, sid: state.activeSession }
        : null;
    if (!isAdmin || !target) {
      // 没有目标（来客、或正站在还没开屋的新建上）：计划整条清掉。
      // 连同记号与在飞的那趟一起作废 —— 否则先前那一趟的慢响应回来又把清掉的填回去，
      // 或者同一场再回来时被误判成「已经拉过」而不再重取
      planFetched.current = null;
      planSeq.current++;
      setSessionPlan({ goal: "", tasks: [] });
      return;
    }
    const rev = switching ? null : state.planRev;
    const prev = planFetched.current;
    if (
      prev &&
      prev.room === target.room &&
      prev.sid === target.sid &&
      (prev.rev === null || prev.rev === rev)
    ) {
      planFetched.current = { room: target.room, sid: target.sid, rev };
      return;
    }
    planFetched.current = { room: target.room, sid: target.sid, rev };
    const seq = ++planSeq.current;
    void api
      .sessionPlan(target.room, target.sid)
      .then((p) => {
        // 只认最后发出的那一份：换得快时，先发的慢响应不许盖掉后发的
        if (seq === planSeq.current) setSessionPlan(p);
      })
      .catch(() => {
        // 这一趟没拉回来：把「拉过」的记号撤掉、计划清空。
        // 不撤的话，换场落地那一下会命中上面的去重、当成「已经拉过」而不再重取，
        // 上一场的计划就一直贴在新场头上了；清空则是「拉不到就当这一场没设过」的如实呈现
        if (seq === planSeq.current) {
          planFetched.current = null;
          setSessionPlan({ goal: "", tasks: [] });
        }
      });
  }, [
    isAdmin,
    uiRoom,
    state.activeSession,
    state.planRev,
    switching,
    pendingRoom,
  ]);

  const flash = useCallback((text: string) => {
    setNotice(text);
    // 每条提示自己带一个定时器，并且把上一条的取消掉 ——
    // 否则前一条的定时器会提前把后一条抹掉（「停下了」紧跟「已切换」就会闪一下没）
    window.clearTimeout(noticeTimer.current);
    noticeTimer.current = window.setTimeout(() => setNotice(""), 2500);
  }, []);

  /**
   * 多行长版 flash：10 秒，给 /memory /tasks /skills 这类结构化输出用。
   * 仍与 flash 共用一个定时器，后一条替掉前一条。
   */
  const flashLong = useCallback((text: string) => {
    setNotice(text);
    window.clearTimeout(noticeTimer.current);
    noticeTimer.current = window.setTimeout(() => setNotice(""), 10_000);
  }, []);

  // 保持现有附件授权边界，仅修复容量预留、取消和跨场迟到写回。
  const { pending, reading, addFiles, dropFile, cancelUploads } = useAttachmentDraft(isAdmin, draftScope, flash, composerDraft);

  /** 取消接入时把原文与附件留在全局恢复列表，不串入新场，也不自动重发。 */
  const restoreQueued = useCallback((why: string) => {
    const queued = queuedSend.current;
    if (!queued) {
      // 未发送的新场也可能尚未登记，切走前提供全局恢复入口。
      if (pendingRoom) composerDraft.store.park(composerDraft.store.get(draftScope));
      return;
    }
    queuedSend.current = null;
    composerDraft.store.park(queued.draft);
    if (why) flash(why);
  }, [composerDraft.store, draftScope, pendingRoom, flash]);

  // 保险丝是 30 秒后才响的，那时「该把话放回哪一场」早就换了：
  // 直接闭包捕获会按叫停那一刻的旧 scope 去 park，草稿落到别的场里去。走 ref 读最新的。
  const restoreQueuedRef = useRef(restoreQueued);
  restoreQueuedRef.current = restoreQueued;

  const beginSwitch = useCallback(
    (id: string, title: string, mode: "new" | "switch", room?: string) => {
      setSwitching({ id, title, mode, room });
      window.clearTimeout(switchFuse.current);
      switchFuse.current = window.setTimeout(() => {
        setSwitching(null);
        restoreQueuedRef.current(
          "新会话没接上，那句话给你放回输入框了 —— 按回车再发一次",
        );
      }, 30000);
    },
    [],
  );

  const endSwitch = useCallback(() => {
    window.clearTimeout(switchFuse.current);
    setSwitching(null);
  }, []);

  // 卸载时必须拆掉保险丝：切场途中吃到 401 会让整个 Shell 退场，
  // 定时器留着就会在 30 秒后对着已经不存在的这一场 park 一份过期草稿。
  // 提示条的定时器同一条路：界面都没了，它还该不到什么，只会在后台续着计时。
  useEffect(
    () => () => {
      window.clearTimeout(switchFuse.current);
      window.clearTimeout(noticeTimer.current);
    },
    [],
  );

  const nav = useCallback((v: ViewKey) => {
    setView(v);
    setDrawer(false);
    setNoteDrawer(false);
    setMemoDrawer(false);
    setPlanDrawer(false);
  }, []);

  // 主题（门面装点）：locked 时纸色/黎明/暗色的最终决定权在管理员那
  const { theme: themeCfg } = useTheme();

  // 动效开关：写 body 属性，CSS 里 body[data-motion="off"] 负责停掉动画
  useEffect(() => {
    document.body.dataset.motion =
      motion && themeCfg.motion !== "off" ? "on" : "off";
    localStorage.setItem(MOTION_KEY, motion ? "on" : "off");
  }, [motion, themeCfg.motion]);

  // 外观主题：写 <html> 的 data-theme，theme.css 按值换一套 token。
  // 「跟随系统」解析成 paper/dark，并盯着系统的明暗开关实时翻面。
  // 浏览器框的颜色（theme-color meta）跟着一起翻：夜墨给深底，亮色给白纸
  useEffect(() => {
    localStorage.setItem(THEME_KEY, theme);
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      // 「允许来客改自己的纸色」关着时，来客的本机选择被管理员定的基调接管
      // （管理员自己不受这条约束 —— 那个开关管的是来客）
      const pick: ThemeKey =
        themeCfg.locked && !isAdmin ? themeCfg.base : theme;
      const dark = pick === "dark" || (pick === "system" && mq.matches);
      document.documentElement.dataset.theme = dark
        ? "dark"
        : pick === "dawn"
          ? "dawn"
          : "paper";
      document
        .querySelector('meta[name="theme-color"]')
        ?.setAttribute("content", dark ? "#17191c" : "#ffffff");
    };
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, [theme, themeCfg.locked, themeCfg.base, isAdmin]);

  // 开机落点的保险丝：正常路径下 state、连接认身、清单三样几乎同时到位，恢复段当场拍板。
  // 万一某一样迟迟不来（半死的连接、卡住的清单请求），也别把人永久锁在「正在接入」后面 ——
  // 到点直接放行，落点退回到「连上哪间就停在哪」，至少界面能用。
  useEffect(() => {
    if (startupDone) return;
    const t = window.setTimeout(() => setStartupDone(true), 8000);
    return () => window.clearTimeout(t);
  }, [startupDone]);

  /**
   * 接服务端主动开口的 notice 并顺手刷新会话列表（他可能刚另开一场说事）。
   * 以前没人接，他开了口界面纹丝不动，等于白说。
   */
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (typeof e.data !== "string") return;
      try {
        const m = JSON.parse(e.data) as {
          type?: string;
          text?: string;
          turn?: number;
        };
        // 「他正在想什么」：这一轮他走到哪一步了。只认比手上这条更新的轮次 ——
        // 上一轮的尾巴偶尔会飘过来，飘过来也不能落到新一轮的头上；
        // 同一轮的就往后排，攒成「他这一路在想什么」。
        if (m.type === "thought" && m.text) {
          const turn = typeof m.turn === "number" ? m.turn : 0;
          if (turn > thoughtTurn.current) {
            thoughtTurn.current = turn;
            setThoughts([m.text]);
          } else if (turn === thoughtTurn.current) {
            setThoughts((p) => [...p, m.text as string]);
          }
          return;
        }
        if (m.type !== "notice" || !m.text) return;
        flash(m.text);
        void loadSessions();
      } catch {
        // 不是这种消息（状态同步、聊天流等），不关我的事
      }
    };
    agent.addEventListener("message", onMessage);
    return () => agent.removeEventListener("message", onMessage);
  }, [agent, flash, loadSessions]);

  // 嗓子清单跟聊什么无关，但管理员在「读音配置」里改动后要能马上看到——
  // 所以进设置页、在设置页里换区时都重拉一次，其余时间不打扰后端。
  // 来客没有这个接口的权限，拿不到就空着 —— 设置页那一块会自己藏起来。
  useEffect(() => {
    if (!isAdmin) return;
    if (view !== "settings" && voicesLoadedRef.current) return;
    let alive = true;
    void api.voices().then((r) => {
      if (!alive) return;
      voicesLoadedRef.current = true;
      setVoices(r.voices); setVoiceDefault(r.defaultVoice); setVoiceCloud(r.cloud);
    }).catch(() => {});
    return () => { alive = false; };
  }, [isAdmin, view, section]);

  // 「当前是哪一场」以后端为准，但换场途中要放行本地乐观跳转（旧屋 state 晚到），
  // 新场未开时后端也不知道。开机前闸：恢复器拍板前一律不接，避免先画错一场再跳。
  useEffect(() => {
    if (!startupDone) return;
    if (!state.activeSession) return;
    if (switching && state.activeSession !== switching.id) return;
    if (pendingRoom) return;
    setActiveSession(state.activeSession);
  }, [state.activeSession, switching, pendingRoom, startupDone]);

  // 新屋把状态推回来了：identified + agent.name 对上目标屋 + activeSession 落到目标场，
  // 才撤遮罩（只看 state 会被旧屋迟到推送骗过）。补发也在这：首句必须等屋真连上再发。
  useEffect(() => {
    if (!switching) return;
    if (!online || agent.readyState !== 1 || agent.name !== activeRoom) return;
    if (state.activeSession !== switching.id) return;
    endSwitch();
    const queued = queuedSend.current;
    if (!queued) return;
    if (!queuedDraftMatches(queued, activeRoom, switching.id)) {
      restoreQueued("原场首句已保留为草稿，未发送到其他会话");
      return;
    }
    queuedSend.current = null;
    void sendMessage(queued.payload).catch((error: unknown) => {
      composerDraft.store.recover(queued.draft);
      flash(`${(error as Error).message}；草稿已保留，请核对原任务后再发送`);
    });
  }, [switching, state.activeSession, online, agent, activeRoom, endSwitch, sendMessage,
    composerDraft.store, restoreQueued, flash]);

  // 换了一场对话：那些独白属于上一场他那句话，别跟着搬过来。
  // 轮次号一起归零 —— 号是那边的屋子发的，换了场次手上的号就没意义了
  useEffect(() => {
    setThoughts([]);
    thoughtTurn.current = 0;
  }, [activeSession]);

  // 只在用户本来就贴着底部时才自动滚动，免得翻历史记录被拽回来。
  // 翻到顶则是另一件事：上面还压着没挂出来的老消息，当场再放一层
  const onScroll = useCallback(() => {
    const el = stream.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    stick.current = nearBottom;
    // 同一个值反复 set 会被 React 挡回去，不必自己比
    setAtBottom(nearBottom);
    if (el.scrollTop <= 4 && messages.length > winSize) {
      growAnchor.current = el.scrollHeight;
      setWinSize((s) => s + MSG_WIN);
    }
  }, [messages.length, winSize]);

  // 换场落底抢在绘制前（useLayoutEffect）：放 useEffect 会先画出列表顶，
  // 看起来像从上往下扫。等的是 shownMessages —— 换场遮罩开了才算数。
  useLayoutEffect(() => {
    if (!jumpBottom.current) return;
    if (!shownMessages.length) return;
    jumpBottom.current = false;
    stick.current = true;
    setAtBottom(true);
    const el = stream.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [shownMessages]);

  // 贴底时跟着新话走，但只认「真的长了东西」。SDK store 恢复完还会抖几下，
  // 每抖都平滑滚一遍，图片/工具卡撑高时就成了一段接一段的滑动动画。
  const prevLastId = useRef("");
  useEffect(() => {
    const id = messages.length ? messages[messages.length - 1].id : "";
    const grew = id !== prevLastId.current;
    prevLastId.current = id;
    if (!stick.current || jumpBottom.current) return;
    if (!grew && !busy) return;
    const el = stream.current;
    if (!el) return;
    // 距离保险：要滚超过两屏，多半不是「跟着新话走」而是哪里错了位 ——
    // 瞬移到位，绝不把这么长的路演成动画
    if (el.scrollHeight - el.scrollTop - el.clientHeight > el.clientHeight * 2)
      el.scrollTop = el.scrollHeight;
    else bottom.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, busy]);

  /**
   * 一键滑到底。先立回 stick 再滚 —— 顺序反了，途中来新话时跟随 effect 会撂下不管。
   * 关掉动效的人直接瞬移。
   */
  const jumpToBottom = useCallback(() => {
    const el = stream.current;
    if (!el) return;
    stick.current = true;
    setAtBottom(true);
    el.scrollTo({
      top: el.scrollHeight,
      behavior: motion ? "smooth" : "auto",
    });
  }, [motion]);

  // 输入框随内容长高，超过 160px 由 CSS 接管滚动
  useEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [input]);

  const patch = useCallback(
    async (p: Partial<ChatState>) => {
      try {
        await api.patchConfig(p);
      } catch (e) {
        flash((e as Error).message);
      }
    },
    [flash],
  );

  /**
   * 调思考强度。走 /api/think 而非 patchConfig：来客也该能调，而 patchConfig
   * 那道门后面站着人格提示词与任务清单。点名 uiRoom —— 新建时写人屋，供新场抄。
   */
  const setThink = useCallback(
    (mode: "normal" | "deep") => {
      // 点名当前这间屋：连在场屋上时调的是那一场自己的开关，不动人屋的。
      // 站在「刚点的新建」上时写的是人屋（见 uiRoom）—— 新场屋开出来会从人屋
      // 抄一份偏好，写进上一间场屋就成了「改了一场已经不在眼前的会话」。
      void api
        .setThinkMode(mode, uiRoom)
        .then(() =>
          flash(mode === "deep" ? "好，接下来我多想一会儿" : "回到平常的节奏"),
        )
        .catch((e) => flash((e as Error).message));
    },
    [flash, uiRoom],
  );

  const send = useCallback(
    /**
     * 发出去没有。没发出去的时候调用方要把字留在输入框里 —— 悄悄清空等于把话吃了。
     * images：原图随行（data URL）。SDK 会把它们排在这条消息 parts 的最前面，
     * 模型先看到画面、再读到下面那段附件说明和他的话 —— 顺序正合适。
     */
    (
      raw: string,
      images?: { mediaType: string; filename: string; url: string }[],
      snapshot?: DraftSnapshot,
    ): boolean => {
      const text = raw.trim();
      if (!text) return false;
      // ericher 还在说的时候就按了回车：说一声。以前是直接丢掉，
      // 人只看到输入框空了、ericher 没理人 —— 那看起来像故意不理。
      if (switching) {
        flash("这一场正在接上，请稍等");
        return false;
      }
      if (!pendingRoom && (!online || agent.readyState !== 1 || agent.name !== activeRoom)) {
        flash("连接已断开，内容留在输入框里；接通后再发送");
        return false;
      }
      if (busy) {
        flash("他还在说这一句，等说完再发 —— 或者按 Esc 让他停下");
        return false;
      }
      stopSpeaking(); // 他开始想事情了，别让上一句还在念
      setSpeakingId("");
      // 新一轮要开口了：上一轮那句「他当时在想什么」该让位。
      // 轮次号留着不清 —— 上一轮的尾巴再飘过来，也不该落到新一轮的头上
      setThoughts([]);
      // 「用说的发，就用说的回」：这是人对对话的默认期待，不用再教一遍
      voiceReply.current = dictated.current;
      dictated.current = false;
      const payload = {
        text,
        files: images?.length
          ? images.map((i) => ({ type: "file" as const, ...i }))
          : undefined,
      };
      // 这一场还没开屋（刚点的新建）：这句话就是它的第一句。
      // 先把屋开出来，连上了再由上面那个 effect 补发 —— 现在发，落到的是上一间屋
      if (pendingRoom) {
        if (queuedSend.current) {
          flash("这一场正在接上，等它一下");
          return false;
        }
        queuedSend.current = { room: pendingRoom.room, session: pendingRoom.id, payload, draft: snapshot ?? composerDraft.store.get(draftScope) };
        beginSwitch(pendingRoom.id, "新会话", "new", pendingRoom.room);
        setActiveRoom(pendingRoom.room);
        setPendingRoom(null);
        return true;
      }
      const draft = snapshot ?? { ...composerDraft.store.get(draftScope), input: raw };
      void sendMessage(payload).catch((error: unknown) => {
        composerDraft.store.recover(draft);
        flash(`${(error as Error).message}；草稿已保留，请核对原任务后再发送`);
      });
      return true;
    },
    [activeRoom, agent, beginSwitch, busy, flash, online, pendingRoom, sendMessage, switching, composerDraft.store, draftScope],
  );

  const submit = () => {
    const snapshot = composerDraft.store.get(draftScope);
    const operation = ++preparation.current;
    const valid = () => operation === preparation.current && composerDraft.store.current(snapshot, draftScopeRef.current);
    const raw = input.trim();
    // 指令名敲全回车 = 从菜单挑一条，两条出口分开写迟早长成两种行为。
    // 名字后空一格才是参数；只有声明 argHint 的才认，否则就是正经说话。
    const sp = raw.search(/\s/);
    const name = (sp < 0 ? raw : raw.slice(0, sp)).toLowerCase();
    const arg = sp < 0 ? "" : raw.slice(sp).trim();
    const hit = cmds.find(
      (c) => c.name.toLowerCase() === name && (arg === "" || !!c.argHint),
    );
    if (hit) {
      runCommand(hit, arg);
      return;
    }
    // 附件正文接在管理员的话前面：模型先看到材料，再看到问题 ——
    // 反过来它容易先答了再回头发现底下还有一份文件
    const blocks = pending.map((f) => f.block).join("\n\n");
    const text = [blocks, raw].filter(Boolean).join("\n\n");
    // 他直接打字回的，是贴着输入框的那一张（最新的一问）——
    // 眼睛落在哪张就答哪张。上面那几张没答的仍留着，等着被点选项或者被 × 收掉：
    // 一句话回两三个问题本来就少见，而把没答的一起收掉，更像是替他丢了问题。
    const nearest = pendingAsks[pendingAsks.length - 1];
    const afterSend = () => {
      if (!valid()) return;
      cancelUploads();
      composerDraft.store.clear(snapshot);
      if (nearest) void dropAsk(nearest.id);
    };
    // 能内联的那几张图，先读成 data URL 再发 —— 这一步是异步的。读不出来就只发文字：
    // 服务端那份 R2 里的原件还在，转述兜底还在，不能因为读图失败把整句话吞掉
    const inline = pending.filter((f) => f.file);
    if (inline.length) {
      void Promise.all(inline.map((f) => readAsDataURL(f.file!)))
        .then((urls) => {
          if (!valid()) return;
          const images = inline.map((f, i) => ({
            mediaType: f.file!.type || "image/png",
            filename: f.file!.name,
            url: urls[i],
          }));
          if (send(text, images, snapshot)) afterSend();
        }, () => {
          if (valid() && send(text, undefined, snapshot)) afterSend();
        });
      return;
    }
    if (!valid() || !send(text, undefined, snapshot)) return;
    afterSend();
  };

  /**
   * 打断。两刀都要下：先断客户端这条流（显示立刻停），再告诉服务端 ——
   * 刷新后恢复的流客户端没有 requestId，只断本地的话服务端还在说，
   * 界面会一直挂着「正在回应…」。已说出口的部分留着。
   */
  const halt = useCallback(() => {
    voiceReply.current = false; // 都被打断了，就别再把半截话念出来
    void stop();
    flash("停下了"); // 先说出口：界面该立刻应我一声，不该等一个网络来回
    // REST 这条路没有连接语义，得点名「正在说话的那间屋」——
    // 换屋之前调用，闭包里抓到的才是将要离开的那间
    void api.stop(activeRoom).catch(() => {
      /* 服务端没收到也无妨，本地已经停下了 */
    });
  }, [activeRoom, flash, stop]);

  /**
   * 重来：最后那句收回重想。按钮只挂最后一条 —— 重来 = 从那句往后全部作废，
   * 挂中间等于删掉后面一整段，代价用户看不见。
   */
  const retryMsg = useCallback(
    (id: string) => {
      if (busy) return;
      if (!online || agent.readyState !== 1) {
        flash("连接尚未恢复，不能重来；请接通后再试");
        return;
      }
      voiceReply.current = false; // 重来这一遍先不念，免得两遍念串
      void regenerate({ messageId: id }).catch((e: unknown) => flash((e as Error).message));
      flash("重来一遍…");
    },
    [agent, busy, flash, online, regenerate],
  );

  // Esc 打断。浮层（看图层、命令菜单）认领时已 preventDefault，这里就别再接 ——
  // 人家关的是自己的面板，不该顺手砍掉生成轮。
  useEffect(() => {
    if (!busy) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) halt();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, halt]);

  // 麦克风：按一下开始听，再按一下停。识别的字直接落进输入框，
  // 让人能先看一眼再发 —— 听错一个字就整句发出去，比手打还费事。
  const toggleMic = useCallback(() => {
    if (listening) {
      rec.current?.stop();
      return;
    }
    dictBase.current = input.trim() ? input.trim() + " " : "";
    const d = startDictation({
      onText: (t) => {
        dictated.current = true;
        setInput(dictBase.current + t);
      },
      onEnd: () => setListening(false),
      onError: (msg) => {
        setListening(false);
        flash(msg);
      },
    });
    if (!d) {
      flash("这个浏览器不支持语音输入，Chrome 或 Edge 可以");
      return;
    }
    rec.current = d;
    setListening(true);
  }, [flash, input, listening]);

  // 逐条朗读：再点同一条 = 停。先亮「正在念」再等音频 ——
  // 云端合成要几百毫秒，等拿到才变状态会像没点着。
  const speakMsg = useCallback(
    (id: string, text: string) => {
      // 每次朗读领一个自增 token。A 正在念时点 B，speak() 开头的 stopSpeaking() 会触发
      // A 那次的 onEnd；若它照旧清空 speakingId，就会把 B 刚落下的 id 抹掉 ——
      // 只有 token 仍是最新时才准许清，过期的回调直接作废。
      const token = ++speakToken.current;
      if (speakingId === id) {
        stopSpeaking();
        setSpeakingId("");
        return;
      }
      setSpeakingId(id);
      void speak(text, state.voice || "", () => {
        if (token === speakToken.current) setSpeakingId("");
      }).then((r) => {
        if (token !== speakToken.current) return; // 已切去念别的条，这次的结果不作数
        if (r.by === "none") {
          setSpeakingId("");
          flash("这台设备念不出来");
        } else if (r.by === "browser" && voiceCloud) {
          // 云端配了却没出声，说明它当场挂了（密钥失效、额度用尽、供应商抽风）。
          // 带上原因：只说「没出声」，人只会以为「换了个更难听的嗓子」，
          // 而不知道是要去充值、还是去换 key。
          flash(`云端嗓子没出声（${r.why}），先用浏览器自带的念了`);
        }
      });
    },
    [flash, speakingId, state.voice, voiceCloud],
  );

  // 一轮答完补一次会话列表。标题晚半拍才起，所以先刷一次对时间/条数，
  // 2.5 秒后再接一次名字。必须排在下个 effect 之前 —— 它会写 wasBusy，吃掉信号。
  useEffect(() => {
    if (!(wasBusy.current && !busy)) return;
    void loadSessions();
    const t = window.setTimeout(() => void loadSessions(), 2500);
    return () => window.clearTimeout(t);
  }, [busy, loadSessions]);

  // 一轮答完，如果这条是我用说的发出去的，就用说的回
  useEffect(() => {
    if (wasBusy.current && !busy && voiceReply.current) {
      voiceReply.current = false;
      const last = [...messages].reverse().find((m) => m.role === "assistant");
      const text = last ? textOf(last) : "";
      if (last && text) {
        setSpeakingId(last.id);
        void speak(text, state.voice || "", () => setSpeakingId("")).then(
          (r) => {
            if (r.by === "none") setSpeakingId("");
          },
        );
      }
    }
    wasBusy.current = busy;
  }, [busy, messages, state.voice]);

  /**
   * 这一眼记回人屋：本机最后看的场/屋，供别的设备开机对齐。
   * 按动作发生那刻打戳，后端只留最晚一笔；写失败在控制台留痕，别悄无声息。
   */
  const recordView = useCallback((room: string, session: string) => {
    void api
      .setActiveRoom(room, session, Date.now())
      .catch((e: unknown) =>
        console.warn("[留存] 记最后状态失败：", (e as Error).message),
      );
  }, []);

  /**
   * 这一轮加载里人有没有亲手动过场/屋。动过就让开机对表让路 ——
   * 别拿旧记录把他从刚打开的那场拽回去。
   */
  const userActed = useRef(false);

  const newSession = useCallback(async () => {
    // 连点门闩：已经在造新场屋就直接退出，否则两次 createSession 会各造一间互相覆盖
    if (creatingRef.current) return;
    creatingRef.current = true;
    try {
      restoreQueued("首句已保留在原场草稿中");
      endSwitch();
      // 新建只换视图，旧屋继续运行；停止必须由用户显式操作。
      voiceReply.current = false;
      stopSpeaking();
      setSpeakingId("");
      cancelUploads(); // 取消旧上传，已读好的附件留在原场草稿。
      // 新对话 = 新开一间场屋；后端当场算好场 id 与屋名（home）。这里不换连接 ——
      // 屋还不建（stub 不实例化 DO），等第一句话要说出口才换，没人说话就不留空屋。
      const meta = await api.createSession();
      if (meta?.home) {
        userActed.current = true;
        setActiveSession(meta.id);
        setPendingRoom({ id: meta.id, room: meta.home });
        // 刚开的这一场也当场记下：多半还没落库（草稿），但那正是「我此刻在看的一眼」
        recordView(meta.home, meta.id);
      }
      await loadSessions();
      flash("新会话已就位，说第一句就开始");
    } catch (e) {
      flash((e as Error).message);
    } finally {
      creatingRef.current = false;
    }
  }, [flash, loadSessions, recordView, restoreQueued, endSwitch, cancelUploads]);

  /**
   * 执行快捷指令。ui 类故意不走 sendMessage：切模式、新开一场本来就不必让他知道 ——
   * 写句话让他调工具等于烧一轮 token，还不一定按对。汇报类（统计/整理）才交给他。
   * 不是 useCallback：只被事件调用，且要用后面定义的 newSession。
   */
  const runCommand = (cmd: Cmd, arg = "") => {
    setCmdOff(false);
    if (cmd.kind === "say") {
      // 发出去才清空：他正说着的时候指令发不出去，那行字该留在框里等人再按一次回车
      if (send(cmd.text)) setInput("");
      return;
    }
    setInput("");
    if (cmd.run === "deep" || cmd.run === "normal") {
      setThink(cmd.run);
      return;
    }
    if (cmd.run === "new") {
      void newSession();
      return;
    }
    if (cmd.run === "plan") {
      runPlan(arg);
      return;
    }
    if (cmd.run === "memory") {
      void runMemory();
      return;
    }
    if (cmd.run === "tasks") {
      runTasks();
      return;
    }
    if (cmd.run === "skills") {
      runSkills();
      return;
    }
    // ledger：账本在设置里那一格，人自己写最顺
    setView("settings");
    setSection("ledger");
    setDrawer(false);
    flash("写一句就行，底下就是登记框");
  };

  /**
   * /plan：给这一场定目标，当场生效、不经过模型。光敲开抽屉手写，跟内容就直接设目标；
   * 但得先有这一场（新建还没落库时目标无处可挂）。
   */
  const runPlan = (arg: string) => {
    // 左边那几块抽屉互斥：开计划抽屉就把另外两块收掉（同 note/memo 芯片的做法）
    setNoteDrawer(false);
    setMemoDrawer(false);
    setDrawer(false);
    if (!arg) {
      setPlanDrawer(true);
      flash("这里就是这一场的计划；想一句话定下，就写 /plan 要干什么");
      return;
    }
    if (!state.activeSession) {
      setPlanDrawer(true);
      flash("先说一句话把这一场开起来，再说 /plan 要干什么");
      return;
    }
    void api
      .saveSessionPlan({
        room: uiRoom,
        session: state.activeSession,
        goal: arg,
      })
      .then((p) => {
        setSessionPlan(p);
        flash("本场目标已定下");
      })
      .catch((e) => flash((e as Error).message));
  };

  /** /memory：直接拉统计，不走模型；多行用长 flash 展示 */
  const runMemory = async () => {
    try {
      const stats = await api.memoryStats();
      const total = stats.reduce((s, r) => s + r.n, 0);
      if (!total) {
        flash("记忆库是空的 —— 还没记过东西");
        return;
      }
      const lines = stats
        .slice()
        .sort((a, b) => b.n - a.n)
        .map((r) => `  ${r.shelf}: ${r.n}`)
        .join("\n");
      flashLong(`记忆库共 ${total} 条\n${lines}`);
    } catch (e) {
      flash((e as Error).message);
    }
  };

  /** /tasks：直接读 state.tasks；进行中 + 待办列出，已完成只报个数 */
  const runTasks = () => {
    const tasks = state.tasks || [];
    if (!tasks.length) {
      flash("没有待办 —— 该做的都做完了");
      return;
    }
    const active = tasks.filter((t) => t.status !== "done");
    const done = tasks.filter((t) => t.status === "done");
    const lines = active
      .map((t) => {
        const mark = t.status === "doing" ? "🔄" : "📋";
        return `  ${mark} ${t.title}`;
      })
      .join("\n");
    const tail = done.length ? `\n  ✓ 已完成 ${done.length} 条` : "";
    flashLong(`待办 ${active.length} 条${tail}\n${lines}`);
  };

  /** /skills：直接读 state.skills，列出有几套、各叫什么 */
  const runSkills = () => {
    const skills = state.skills || {};
    const names = Object.keys(skills);
    if (!names.length) {
      flash("还没存过技能配方 —— 在对话里让他整理出一套做法就能存");
      return;
    }
    const lines = names
      .map((n) => {
        const steps = skills[n];
        const cnt = Array.isArray(steps) ? steps.length : 0;
        return `  ${n}${cnt ? `（${cnt} 步）` : ""}`;
      })
      .join("\n");
    flashLong(`技能配方 ${names.length} 套\n${lines}`);
  };

  // 切会话分两种走法：宿在人屋的老场，由后端搬消息（存好这一场、把目标那场灌回来）；
  // 场屋里的场不搬 —— 消息住在那间独立的屋子里，换条连接就行，历史按屋灌回。
  // 两种都不能调 clearHistory()，那会顺手把服务端也清掉。
  const switchSession = useCallback(
    // byUser：这一刀是不是人亲手切的。开机照记录还原时传 false —— 那是照记录走，
    // 不该反过来再把那份记录推新一版（推新了，别处更晚的一笔反而会被它盖掉）。
    async (id: string, title: string, byUser = true) => {
      if (id === activeSession) return;
      const s = sessions.find((x) => x.id === id);
      const targetRoom = s?.home || agentName;
      if (!pendingRoom && connectionBusy && activeRoom === agentName && targetRoom === agentName) {
        flash("这间旧会话仍在运行，请等它结束再切换旧会话；可以先打开独立会话");
        return;
      }
      cancelUploads(); // 导航不清掉原场草稿。
      voiceReply.current = false;
      stopSpeaking();
      setSpeakingId("");
      const from = activeSession;
      // 走开就等于把这间还没开出来的屋作废 —— 它还没建，作废不掉任何东西。
      // 尚未接入的首句保留到全局草稿列表，不放进新会话的输入框。
      restoreQueued("");
      if (pendingRoom) setPendingRoom(null);
      // 先把侧栏跳到这一场、把遮罩盖上，再去谈连接和搬运 ——
      // 老场宿在人屋时，后端要先清空再整场灌回，那段时间界面本来是一片空白。
      // 目标屋一并带上：那几秒里就能把这一场的计划先取回来（见 sessionPlan 那条 effect）
      beginSwitch(id, title, "switch", targetRoom);
      setActiveSession(id);
      if (byUser) {
        // 这一眼当场记下（按点击时刻打戳）—— 不等换场落地、不等开机对表。
        // 记的是「我选了这场」这件事本身；别的设备要的也正是这个先后。
        userActed.current = true;
        recordView(targetRoom, id);
      }
      try {
        if (s?.home) {
          // 场屋里的场：换连接就好。广播回来时 activeSession 会跟着对上
          jumpBottom.current = true; // 落到这场最新一条的末尾，不从开头翻起
          setActiveRoom(s.home);
          flash(`已切换到「${title}」`);
          return;
        }
        const meta = await api.switchSession(id);
        if (!meta) throw new Error("这场会话已经不在了");
        jumpBottom.current = true;
        setActiveRoom(agentName); // 回人屋：这场宿在人屋里（若本就人屋则原地不动）
        await loadSessions();
        flash(`已切换到「${title}」`);
      } catch (e) {
        // 没切成：把高亮和遮罩都退回原处，别让人停在一个不存在的场上
        setActiveSession(from);
        endSwitch();
        flash((e as Error).message);
      }
    },
    [
      activeSession,
      agentName,
      beginSwitch,
      connectionBusy,
      cancelUploads,
      activeRoom,
      endSwitch,
      flash,
      loadSessions,
      pendingRoom,
      recordView,
      restoreQueued,
      sessions,
    ],
  );

  const renameSession = useCallback(
    async (s: SessionMeta) => {
      const next = window.prompt("重命名会话", s.title);
      if (next === null) return;
      const title = next.trim();
      if (!title || title === s.title) return;
      try {
        await api.renameSession(s.id, title);
        await loadSessions();
        flash("已重命名");
      } catch (e) {
        flash((e as Error).message);
      }
    },
    [flash, loadSessions],
  );

  const deleteSession = useCallback(
    async (s: SessionMeta) => {
      if (!window.confirm(`删掉「${s.title}」？这场对话就找不回来了。`)) return;
      try {
        const r = await api.deleteSession(s.id);
        if (r.active) setActiveSession(r.active);
        const list = await loadSessions();
        // 删的正好是当前这场时，activeRoom 还指着已经被删掉的场屋 ——
        // useAgent 不会自己重连，界面会一直显示旧消息、侧栏高亮却跳到了别处。
        // 像 switchSession 的 home 分支那样同步换连接：目标会话在列表里且有 home 就进它的屋，
        // 否则回人屋（r.active 是删后新建的预备栏，通常还不在列表里）。
        if (s.id === activeSession) {
          const target = list?.find((x) => x.id === r.active);
          jumpBottom.current = true; // 落到新场最新一条的末尾，不从开头翻起
          const room = target?.home || agentName;
          setActiveRoom(room);
          setActiveSession(r.active);
          // 删掉眼前这场等于人被挪到了别处 —— 当场记下，别让别的设备还照旧记录找回来
          userActed.current = true;
          recordView(room, r.active);
        }
        flash("已删除");
      } catch (e) {
        flash((e as Error).message);
      }
    },
    [activeSession, agentName, flash, loadSessions, recordView],
  );

  /**
   * 开机落点 · 状态恢复的唯一入口。以前后端同步与独立恢复器各跑各的，会先画错一场再跳；
   * 现在这里拍板前正文空着，拍板后才放行后端同步。闸：state 到、连接确在目标屋
   * （agent.name === activeRoom）、每次加载只跑一次。只在真要还原时才等清单；
   * 人已亲手切过（userActed）或清单拿不到（sessionsOk 假）时不判定，免得抹掉更晚的记录。
   */
  const viewRestored = useRef(false);
  /**
   * 开机直连目标场屋时记下这间；清单回来后核对它是否已不在册
   * （多半别的设备删了），是就退回人屋（见下面的兜底 effect）。
   */
  const bootFieldRoom = useRef("");
  useEffect(() => {
    if (viewRestored.current) return;
    if (!agent.state) return;
    if (!agent.identified || agent.name !== activeRoom) return;
    const settle = () => setStartupDone(true);
    // 开机就直连在目标场屋上：手上的正文就是那一场，不必等清单，当场拍板。
    if (agent.name !== agentName) {
      viewRestored.current = true;
      bootFieldRoom.current = agent.name;
      return settle();
    }
    // 他已经亲手动过场/屋：不还原，也不去动他那份记录（见 recordView 的注释）
    if (userActed.current) {
      viewRestored.current = true;
      return settle();
    }
    // 没记过落点，或记的就是眼下这一场：没有可还原的，清单也不必等
    if (
      !state.lastRoom ||
      !state.lastSession ||
      state.lastSession === state.activeSession
    ) {
      viewRestored.current = true;
      return settle();
    }
    // 记的那一场和眼下这场不一样：得等清单，才知道它还在不在、宿在哪间场屋
    if (!sessionsLoaded) return;
    viewRestored.current = true;
    if (!sessionsOk) return settle();
    const d = resolveStartView({
      baseRoom: agentName,
      lastRoom: state.lastRoom,
      lastSession: state.lastSession,
      sessions,
      currentSession: state.activeSession,
    });
    if (d.action === "switch") {
      // 照记录走的一刀不算「人亲手动的」（byUser=false）：别把这份记录又推新一版。
      // 切完即拍板：switching 压着后端同步（见上面那条 effect 的换场放行闸），
      // 新屋把目标场推回来之前不会有人半路插播旧指向
      void switchSession(d.session, d.title, false);
      settle();
    } else {
      if (d.stale) {
        // 记的那一场已经没了：清掉，免得每次开机都拿一个死 id 去试。
        // 走 recordView 带时间戳 —— 别拿这一清把别处更晚的一笔顺手抹了
        recordView("", "");
      }
      // none：没记过 / 已经就在那一场 —— 落点就是人屋此刻的会话，放行同步
      settle();
    }
  }, [
    sessionsLoaded,
    sessionsOk,
    agent.state,
    agent.identified,
    agent.name,
    activeRoom,
    agentName,
    state.lastRoom,
    state.lastSession,
    state.activeSession,
    sessions,
    switchSession,
    recordView,
  ]);

  // 落点记本机：只在拍板之后、且不在换场空窗里写 —— 换场中间 activeRoom 与
  // activeSession 会有一小段对不上，写进去就是脏记录。下次开机按它直连（见 localStartRoom）。
  useEffect(() => {
    if (!startupDone || switching || pendingRoom) return;
    if (!activeSession) return;
    writeLocalView(agentName, activeRoom, activeSession);
  }, [startupDone, switching, pendingRoom, activeRoom, activeSession, agentName]);

  // 直连场屋的兜底核对：清单回来发现这一场已经不在册（多半别的设备删了它），
  // 退回人屋 —— 本机记的那一笔就不该再当真。只在「开机直连」这一路启用，
  // 免得对正常换场过来的场屋也横生枝节。
  useEffect(() => {
    const room = bootFieldRoom.current;
    if (!room || activeRoom !== room) return;
    if (!startupDone || !sessionsLoaded || !sessionsOk) return;
    if (switching || pendingRoom) return;
    const sid = state.activeSession;
    if (!sid || sessions.some((s) => s.id === sid)) return;
    bootFieldRoom.current = "";
    setActiveRoom(agentName);
    flash("这一场已经不在了，回到默认会话");
  }, [
    startupDone,
    sessionsLoaded,
    sessionsOk,
    switching,
    pendingRoom,
    activeRoom,
    agentName,
    state.activeSession,
    sessions,
    flash,
  ]);

  const toggleVisibility = useCallback(
    async (s: SessionMeta) => {
      const next = s.visibility === "public" ? "private" : "public";
      try {
        await api.setSessionVisibility(s.id, next);
        await loadSessions();
        // 公开会话的入口暂时收着（来客现在只看自己那几场），所以这里不承诺「别人能看到」——
        // 标了公开只意味着以后重开入口时这场会被列出去，现在它还是只给自己看
        flash(
          next === "public"
            ? "已标为公开（公开入口暂时收着，眼下还是只给自己看）"
            : "已收回，只有你能看到",
        );
      } catch (e) {
        flash((e as Error).message);
      }
    },
    [flash, loadSessions],
  );

  /**
   * 收起 / 展开一场。不是删除 —— 说得很明白：内容都在，翻旧账照样搜得到。
   */
  const toggleArchive = useCallback(
    async (s: SessionMeta) => {
      const next = !s.archived;
      try {
        await api.setSessionArchived(s.id, next);
        await loadSessions();
        flash(
          next ? "已收起，在「已归档」里随时能找回来" : "已展开，回到会话列表",
        );
      } catch (e) {
        flash((e as Error).message);
      }
    },
    [flash, loadSessions],
  );

  /**
   * 置顶 / 取消置顶。只把这一场挪进或挪出置顶区，内容一个字不动。
   * 置顶区按「置顶的先后」排：先顶上的一直在前，后顶上的顺次往后 ——
   * 所以取消再顶，等于排到置顶区末尾。
   */
  const togglePin = useCallback(
    async (s: SessionMeta) => {
      const next = !s.pinned;
      try {
        await api.setSessionPinned(s.id, next);
        await loadSessions();
        flash(next ? "已置顶，排在置顶区末尾" : "已取消置顶");
      } catch (e) {
        flash((e as Error).message);
      }
    },
    [flash, loadSessions],
  );

  const organize = useCallback(async () => {
    if (!isAdmin) return;
    // 同款连点门闩：整理已在跑就别再提交一次，否则等于白烧两轮 LLM
    if (creatingRef.current) return;
    creatingRef.current = true;
    flash("整理中…");
    try {
      flash(await api.organize());
    } catch (e) {
      flash((e as Error).message);
    } finally {
      creatingRef.current = false;
    }
  }, [flash, isAdmin]);

  const logout = useCallback(async () => {
    // 登出意图本地先行：断网时服务端那声「再见」送不到，也照样锁屏 ——
    // 点了退出却毫无反应、会话还开着，比服务端少记一笔登出危险得多
    try {
      await api.logout();
    } catch {
      // 本地已经要锁了，网络失败就静默吞掉，不再打断锁屏这一步
    } finally {
      onLock();
    }
  }, [onLock]);

  /**
   * 他还没答的问题，只挑当前这场。按侧栏选中场过滤（不是连接上的 state.activeSession）——
   * 刚点新建时后端仍报上一场，照它滤会让空白新场冒出上一场的追问，
   * 发首句时还会被当成「答过了」收掉（见 submit 的 nearest）。
   */
  const pendingAsks = (state.asks || []).filter(
    (a) => a.sessionId === activeSession,
  );

  /**
   * 正在送答案的卡（ref 同步防重、state 管禁用）。CF 打盹/弱网时人会连点：
   * 第一次喂进挂起的工具，之后几次拿 409、被当普通消息发出去，还会掐断生成 ——
   * 所以请求期间全禁并明说「正在送」。
   */
  const sendingAsk = useRef<Set<string>>(new Set());
  const [sendingAsks, setSendingAsks] = useState<string[]>([]);
  const markSending = (id: string, on: boolean) => {
    if (on) sendingAsk.current.add(id);
    else sendingAsk.current.delete(id);
    setSendingAsks([...sendingAsk.current]);
  };

  /** 收起一张提问卡（先不答）：空答案 resolve 挂起的工具，让他自己拿主意继续 */
  const dropAsk = useCallback(
    async (id: string) => {
      if (sendingAsk.current.has(id)) return;
      markSending(id, true);
      try {
        await api.answerAsk(id, "", activeRoom);
      } catch (e) {
        flash((e as Error).message);
      } finally {
        markSending(id, false);
      }
    },
    [flash, activeRoom],
  );

  /**
   * 答提问卡：答案作为挂起的 ask 工具结果回喂，模型在同一轮接着跑，不当新消息。
   * 服务端已顺带收卡；失败/过期只保留答案草稿，不自动另发。连点只认第一次。
   */
  const answerAsk = async (a: AskEntry, text: string) => {
    if (sendingAsk.current.has(a.id)) return;
    markSending(a.id, true);
    try {
      await api.answerAsk(a.id, text, activeRoom);
    } catch (e) {
      // 即使收到 409，也可能是首次响应丢失后的重复作答；不能自动另开一轮。
      if (visibleRoom.current === activeRoom) setInput(cur => cur || text);
      flash(`${(e as Error).message}；未另发新消息，请核对原任务后再决定是否发送`);
    } finally {
      markSending(a.id, false);
    }
  };

  return (
    <>
      <Backdrop />
      {/* 主题壁纸：铺哪张随当前视图走；没铺的视图回落到全局那张（见 lib/theme 的 backgroundFor） */}
      <ThemeBackdrop
        scope={
          view === "chat"
            ? "chat"
            : view === "note"
              ? "notes"
              : view === "settings"
                ? "settings"
                : "global"
        }
      />

      {view === "chat" && (
        // 笔记抽屉一拉开，左边的菜单栏就让位：两块都贴左边，并排站着只会叠在一起，
        // 而本子摊开的时候人要的是整块地方，不是「菜单栏边上挤出一条」
        <div
          className={`chat-app${noteDrawer || memoDrawer || planDrawer ? " note-open" : ""}`}
        >
          <ChatSidebar
            sessions={sessions}
            active={activeSession}
            onSwitch={switchSession}
            onRename={renameSession}
            onDelete={deleteSession}
            onToggleVisibility={toggleVisibility}
            onToggleArchive={toggleArchive}
            onTogglePin={togglePin}
            onNew={newSession}
            view={view}
            onNav={nav}
            online={online}
            isAdmin={isAdmin}
            open={drawer}
            onClose={() => setDrawer(false)}
            card={card}
            guestName={state.guestName}
            typeName={state.guestType?.name ?? ""}
            adminBio={state.adminBio}
            canNotes={canNotes}
          />
          {drawer && (
            <div className="sidebar-mask" onClick={() => setDrawer(false)} />
          )}

          {/* 笔记本抽屉：和他说话的时候顺手翻本子。两块左边的东西互斥，
              共用同一层遮罩语义（点空白处收起来） */}
          {isAdmin && drawerMounted(noteDrawer, visitedDrawers.note) && (
            <LoadingBoundary label="正在载入笔记本">
            <NoteDrawer
              open={noteDrawer}
              onClose={() => setNoteDrawer(false)}
              room={uiRoom}
              focusId={state.noteFocus}
            />
            </LoadingBoundary>
          )}
          {noteDrawer && (
            <div
              className="sidebar-mask"
              onClick={() => setNoteDrawer(false)}
            />
          )}

          {/* 回想抽屉：他休息时回头整理出来的那些。和笔记本一样占左边那一块 */}
          {isAdmin && drawerMounted(memoDrawer, visitedDrawers.memo) && (
            <LoadingBoundary label="正在载入回想">
            <SessionMemoryDrawer
              open={memoDrawer}
              onClose={() => setMemoDrawer(false)}
            />
            </LoadingBoundary>
          )}
          {memoDrawer && (
            <div
              className="sidebar-mask"
              onClick={() => setMemoDrawer(false)}
            />
          )}

          {/* 本场计划抽屉：这一场要干什么，摆在眼前、顺手能改。
              只管这一场（不设时间）—— 到点提醒在「提醒」里，是另一回事 */}
          {isAdmin && drawerMounted(planDrawer, visitedDrawers.plan) && (
            <LoadingBoundary label="正在载入本场计划">
            <SessionPlanDrawer
              open={planDrawer}
              onClose={() => setPlanDrawer(false)}
              room={uiRoom}
              session={state.activeSession}
            />
            </LoadingBoundary>
          )}
          {planDrawer && (
            <div
              className="sidebar-mask"
              onClick={() => setPlanDrawer(false)}
            />
          )}

          <main className="chat-main">
            <header className="chat-header">
              <button
                className="icon-btn menu-btn"
                onClick={() => {
                  setNoteDrawer(false);
                  setMemoDrawer(false);
                  setPlanDrawer(false);
                  setDrawer(true);
                }}
                title="会话列表"
              >
                <Icon name="message" size={18} />
              </button>
              <div className="chat-title-wrap">
                <h1 className="chat-title">{current?.title || "新的对话"}</h1>
                <p className="chat-subtitle">
                  {busy
                    ? "正在回应…"
                    : isAdmin
                      ? "管理员 · 全部能力已解锁"
                      : "访客 · 这场对话只有你看得到"}
                </p>
              </div>
              <div className="chat-actions">
                {/* 上下文占用：上一轮烧了多少、窗口多宽（账跟着场走，
                    换了一场或还没聊过都不显示）。点按切缓存命中详情，悬停也有。
                    刚点的新建上也不显示：那笔账属于上一场，这会儿还没换过来 */}
                {!pendingRoom &&
                  state.lastUsage &&
                  state.lastUsage.sessionId === state.activeSession && (
                    <UsageChip usage={state.lastUsage} />
                  )}
                {/* 强度这一格来客也看得见：菜单里的 /deep、/normal 是同一件事的另一个入口，
                    两边都走 /api/think。不给他这一格，他就只能靠指令切、却看不出现在是哪一档 */}
                <button
                  className={`chip ${thinkDeep ? "on" : ""}`}
                  onClick={() => setThink(thinkDeep ? "normal" : "deep")}
                  title="切换思考模式：深一点慢一点，还是平常的节奏"
                >
                  <Icon name="type" size={15} />
                  <span>{thinkDeep ? "深度" : "普通"}</span>
                </button>
                {isAdmin && (
                  <>
                    {/* 本子就在左手边：说着「帮我理一下这篇」的时候，得能顺手翻开看一眼 */}
                    <button
                      className={`chip ${noteDrawer ? "on" : ""}`}
                      onClick={() => {
                        setDrawer(false);
                        setMemoDrawer(false);
                        setPlanDrawer(false);
                        setNoteDrawer((v) => !v);
                      }}
                      title={`翻开笔记本（你翻着哪一篇，${persona.name} 看得到）`}
                    >
                      <Icon name="edit" size={15} />
                      <span>笔记</span>
                    </button>
                    {/* 回想就在旁边：他说「上次那个」时，得能顺手看一眼他那次记了什么 */}
                    <button
                      className={`chip ${memoDrawer ? "on" : ""}`}
                      onClick={() => {
                        setDrawer(false);
                        setNoteDrawer(false);
                        setPlanDrawer(false);
                        setMemoDrawer((v) => !v);
                      }}
                      title="翻看他回头整理过的那些（他休息时会自己回顾）"
                    >
                      <Icon name="clock" size={15} />
                      <span>回想</span>
                    </button>
                    <button
                      className="chip"
                      onClick={organize}
                      title="整理对话并萃取洞察"
                    >
                      <Icon name="refresh" size={15} />
                      <span>整理</span>
                    </button>
                  </>
                )}
              </div>
            </header>

            {/* 本场计划常驻条：这一场要干什么，明面摆在消息列表顶上（点开改）。
                没设过（无目标也无步骤）时它自己整条不渲染，不留空壳占地方。
                换场空窗里不摆：那会儿手上这份还是上一场的 */}
            {isAdmin && !switching && !pendingRoom && (
              <SessionPlanBar
                goal={sessionPlan.goal}
                tasks={sessionPlan.tasks}
                onOpen={() => {
                  setDrawer(false);
                  setNoteDrawer(false);
                  setMemoDrawer(false);
                  setPlanDrawer(true);
                }}
              />
            )}

            <section
              className={`messages-area${dragOver ? " dropping" : ""}`}
              ref={stream}
              onScroll={onScroll}
              // 拖进来就接住：文件是「丢过来」的，多一步「点按钮选文件」都是多余的
              onDragOver={(e) => {
                if (!isAdmin || !e.dataTransfer.types.includes("Files")) return;
                e.preventDefault();
                setDragOver(true);
              }}
              onDragLeave={(e) => {
                // 移到子元素上也会触发 leave，得确认真的离开了这一块
                if (!e.currentTarget.contains(e.relatedTarget as Node))
                  setDragOver(false);
              }}
              onDrop={(e) => {
                if (!isAdmin) return;
                e.preventDefault();
                setDragOver(false);
                void addFiles(e.dataTransfer.files);
              }}
            >
              {/* 窗口上头还压着老消息：摆一条活路。点一下放一层；
                  顺手向上滑到顶也会自动放 —— 短消息撑不满一屏时，光靠滑可能永远到不了顶 */}
              {olderCount > 0 && (
                <button
                  className="older-btn"
                  onClick={() => {
                    const el = stream.current;
                    if (el) growAnchor.current = el.scrollHeight;
                    setWinSize((s) => s + MSG_WIN);
                  }}
                >
                  更早 {olderCount} 条
                </button>
              )}
              {/* 只兜消息列表：某一条消息的渲染出了问题，输入框还得能用 ——
                  不然人连「说一句告诉它坏在哪」的机会都没有 */}
              <Shield what="消息">
                {!shownMessages.length && !busy && !thoughts.length && !(state.turnErrors?.length) && (
                  <div className="empty">
                    <p>和 {persona.name} 说点什么吧…</p>
                    <p className="meta">输入 /help 看他现在能做什么</p>
                  </div>
                )}
                {(shownMessages.length > 0 || busy || thoughts.length > 0 || (state.turnErrors?.length ?? 0) > 0) && (
                <LoadingBoundary label="正在载入消息">
                <Messages
                  messages={shownMessages}
                  streaming={busy}
                  role={role}
                  thoughts={thoughts}
                  turnErrors={(state.turnErrors ?? []).filter(
                    (e) =>
                      !e.sessionId ||
                      !state.activeSession ||
                      e.sessionId === state.activeSession,
                  )}
                  speakingId={speakingId}
                  room={uiRoom}
                  // 连接真挂在 uiRoom 上了才让它去拉按屋取的东西
                  roomReady={agent.identified && agent.name === uiRoom}
                  showDetail={isAdmin}
                  onSpeak={speakMsg}
                  onRetry={retryMsg}
                  onFlash={flash}
                />
                </LoadingBoundary>
                )}
              </Shield>
              {stallReport && (
                <div className="stall-card">
                  <div className="stall-head">
                    <Icon name="alert-circle" size={14} />
                    <span>停滞了 — 可能卡住了</span>
                    <button
                      className="stall-x"
                      onClick={() => setStallReport(null)}
                      aria-label="关掉"
                    >
                      <Icon name="x" size={12} />
                    </button>
                  </div>
                  <div className="stall-body">
                    <p>
                      会话停在「{stallReport.lastMsgRole}」这条，
                      {stallReport.msgCount} 条消息 · {stallReport.thoughtCount}{" "}
                      句想法
                    </p>
                    {!!stallReport.toolStates.length && (
                      <p>工具状态：{stallReport.toolStates.join(" · ")}</p>
                    )}
                    <p className="stall-hint">
                      可能是 CF 打盹、上游断流、或工具卡死 ——
                      等一会儿可能自己恢复；不行就按停止重来
                    </p>
                  </div>
                </div>
              )}
              {dragOver && (
                <div className="drop-hint">松手，我看看这是什么</div>
              )}
              {/* 翻旧账翻远了：右下角浮出一枚「滑到底」。贴着最新那条时它自己收起来，
                  免得挡着刚写的话。sticky 让它钉在可视区下沿，不随内容滚走 */}
              {!atBottom && shownMessages.length > 0 && (
                <button
                  className="jump-bottom"
                  onClick={jumpToBottom}
                  title="回到最新"
                  aria-label="滑到底部"
                >
                  <Icon name="chevron-down" size={18} />
                </button>
              )}
              <div ref={bottom} />
            </section>

            <div className="input-area">
              <FailedDrafts composer={composerDraft} />
              {(!!pending.length || !!reading) && (
                <div className="attach-tray">
                  {pending.map((f) => (
                    <span className="attach-chip" key={f.key} title={f.note}>
                      <Icon name="paperclip" size={13} />
                      <span className="attach-chip-name">{f.name}</span>
                      <button
                        className="attach-chip-x"
                        onClick={() => dropFile(f)}
                        title="不带了"
                        aria-label="移除附件"
                      >
                        <Icon name="x" size={12} />
                      </button>
                    </span>
                  ))}
                  {reading && (
                    <span className="attach-chip reading">
                      <Icon name="paperclip" size={13} />
                      <span className="attach-chip-name">{reading}</span>
                      <span className="attach-chip-note">正在读…</span>
                    </span>
                  )}
                </div>
              )}
              {/* 提问卡：他做到一半回头问你的那句。摆在输入框正上方 ——
                  答案的去处就是下面这个框，两样东西贴在一起才不用想「答到哪去」 */}
              {pendingAsks.map((a) => (
                <div className="ask-card" key={a.id}>
                  <div className="ask-head">
                    <Icon name="help-circle" size={14} />
                    <span className="ask-title">他做到这儿，想问你一句</span>
                    <button
                      className="ask-x"
                      disabled={sendingAsks.includes(a.id)}
                      onClick={() => void dropAsk(a.id)}
                      title="先不答，让他自己拿主意"
                      aria-label="先不答"
                    >
                      <Icon name="x" size={12} />
                    </button>
                  </div>
                  <p className="ask-text">{a.text}</p>
                  {a.why && <p className="ask-why">{a.why}</p>}
                  {!!a.options.length && (
                    <div className="ask-options">
                      {a.options.map((o) => (
                        <button
                          key={o}
                          className="ask-option"
                          disabled={sendingAsks.includes(a.id)}
                          onClick={() => answerAsk(a, o)}
                        >
                          {o}
                        </button>
                      ))}
                    </div>
                  )}
                  {/* 自写答案就地发：选项不贴合时不用挪到底下的输入栏再答一遍 */}
                  <AskInlineInput
                    disabled={sendingAsks.includes(a.id)}
                    onSend={(text) => answerAsk(a, text)}
                  />
                  {/* 这句只写在贴着输入框的那张上：在下面打字，回的就是它 ——
                      每张都写一遍的话，人分不清那句话到底落给哪一张。
                      正在送的那张把提示换成「正在送」，让等待看得见 */}
                  {sendingAsks.includes(a.id) ? (
                    <p className="ask-hint">正在送过去…</p>
                  ) : (
                    a.id === pendingAsks[pendingAsks.length - 1].id && (
                      <p className="ask-hint">
                        {a.options.length
                          ? "挑一个，或在框里自己写"
                          : "在框里写一句就行"}
                      </p>
                    )
                  )}
                </div>
              ))}
              {/* 「/」菜单：贴着输入框往上升。以前这些指令只活在 placeholder 那一行小字里，
                  不打出来就不知道有；现在敲一下斜杠就能看见，也不用背 */}
              {picking && (
                <div className="cmd-menu" role="listbox" aria-label="快捷指令">
                  {matched.length ? (
                    <>
                      <p className="cmd-menu-tip">
                        ↑↓ 选 · Enter 就用 · Esc 关掉
                      </p>
                      {matched.map((c, i) => (
                        <button
                          key={c.name}
                          role="option"
                          aria-selected={i === cmdCursor}
                          className={`cmd-item${i === cmdCursor ? " on" : ""}`}
                          onMouseEnter={() => setCmdIdx(i)}
                          onClick={() => runCommand(c)}
                        >
                          <Icon name={c.icon} size={15} />
                          <span className="cmd-name">{c.name}</span>
                          <span className="cmd-label">{c.label}</span>
                          <span className="cmd-desc">{c.desc}</span>
                        </button>
                      ))}
                    </>
                  ) : (
                    <p className="cmd-menu-empty">
                      没有这条指令。打个 / 看看有哪些
                    </p>
                  )}
                </div>
              )}
              <div className="input-wrapper">
                {isAdmin && (
                  <input
                    ref={picker}
                    type="file"
                    multiple
                    hidden
                    onChange={(e) => {
                      void addFiles(e.target.files);
                      // 清空 value：同一份文件选第二次也要能触发 change
                      e.target.value = "";
                    }}
                  />
                )}
                {isAdmin && (
                  <button
                    className="input-side-btn"
                    onClick={() => picker.current?.click()}
                    disabled={!!reading}
                    title="给他看一份文件：图片、PDF、文本、录音、视频都行（也能直接拖进来，或粘贴截图）"
                  >
                    <Icon name="paperclip" size={17} />
                  </button>
                )}
                <textarea
                  ref={ta}
                  className="chat-textarea"
                  value={input}
                  rows={1}
                  onChange={(e) => {
                    setInput(e.target.value);
                    // 动了字就重新认一遍：Esc 关掉的菜单再打字会回来，光标也归第一位
                    setCmdOff(false);
                    setCmdIdx(0);
                  }}
                  onPaste={(e) => {
                    // 截图之后直接粘贴，是最顺手的一条路（QQ/微信截图都在剪贴板里）
                    const fs = Array.from(e.clipboardData?.files || []);
                    if (fs.length && isAdmin) {
                      e.preventDefault();
                      void addFiles(fs);
                    }
                  }}
                  onKeyDown={(e) => {
                    // 菜单开着的时候，方向键和回车归菜单用 —— 挡住它们，
                    // 免得「想选第二条」变成「把 /t 发了出去」
                    if (picking && matched.length) {
                      if (e.key === "ArrowDown") {
                        e.preventDefault();
                        setCmdIdx((i) => (i + 1) % matched.length);
                        return;
                      }
                      if (e.key === "ArrowUp") {
                        e.preventDefault();
                        setCmdIdx(
                          (i) => (i - 1 + matched.length) % matched.length,
                        );
                        return;
                      }
                      if (
                        (e.key === "Enter" || e.key === "Tab") &&
                        !e.nativeEvent.isComposing
                      ) {
                        e.preventDefault();
                        runCommand(matched[cmdCursor]);
                        return;
                      }
                      if (e.key === "Escape") {
                        e.preventDefault();
                        // 别让这一下顺手把他的回答也打断了（window 上那个 Esc 是「别说了」）
                        e.stopPropagation();
                        setCmdOff(true);
                        return;
                      }
                    }
                    if (
                      e.key === "Enter" &&
                      !e.shiftKey &&
                      !e.nativeEvent.isComposing
                    ) {
                      e.preventDefault();
                      submit();
                    }
                  }}
                  placeholder={
                    listening
                      ? "在听…"
                      : `和 ${persona.name} 说点什么…（打 / 看能做什么）`
                  }
                  autoComplete="off"
                />
                {canDictate() && (
                  <button
                    className={`input-side-btn mic${listening ? " listening" : ""}`}
                    onClick={toggleMic}
                    title={
                      listening
                        ? "说完了，点一下停"
                        : `说给 ${persona.name} 听（用说的发，他就用说的回）`
                    }
                  >
                    <Icon name={listening ? "stop" : "mic"} size={17} />
                  </button>
                )}
                {busy ? (
                  <button
                    className="send-button stop"
                    onClick={halt}
                    title="停下来（Esc）"
                  >
                    <Icon name="stop" size={16} />
                  </button>
                ) : (
                  <button
                    className="send-button"
                    onClick={submit}
                    disabled={!input.trim() && !pending.length}
                    title="发送"
                  >
                    <Icon name="arrow-right" size={18} />
                  </button>
                )}
              </div>
              {/* 空闲时这一行是给键盘写的（Enter / Shift+Enter / 拖文件），
                  手机上一条都用不上，那边整行藏掉（见 styles.css 响应式段）。 */}
              <p
                className={`input-hint${reading || listening || busy || pending.length ? "" : " desk"}`}
              >
                {reading
                  ? `正在读「${reading}」…读完就能一起发出去`
                  : listening
                    ? "在听你说 —— 说完点一下方块，确认一遍再发"
                    : busy
                      ? "正在回应… 点方块或按 Esc 让他停下"
                      : pending.length
                        ? `带了 ${pending.length} 份附件，说句话我就一起看`
                        : "Enter 发送 · Shift + Enter 换行 · 文件可以直接拖进来"}
              </p>
            </div>

            {/* 换场/初次接入时的毛玻璃：底下的正文这会儿还是上一场（或空着），
                与其让人以为「点了没反应」，不如明说正在换。遮罩期间下面的
                消息区不接点击 —— 那会儿点什么都点不到正确的场上 */}
            {(switching || !agent.state || !startupDone) && (
              <div className="chat-switching" role="status" aria-live="polite">
                <div className="chat-switching-card">
                  <span className="spinner" />
                  <p>
                    {switching
                      ? switching.mode === "new"
                        ? "正在开启新会话…"
                        : `正在切换到「${switching.title}」…`
                      : "正在接入…"}
                  </p>
                </div>
              </div>
            )}
          </main>
        </div>
      )}

      {/* 笔记本：管理员的总在本子上；长期来客（卡 + 档位开了权益）的是自己
          那间屋的本子 —— 路由按票寻址落他自己的 SQLite，这里只管把门对齐：
          侧栏放谁进来（canNotes），视图就得放谁进来，少一半就是整页空白。 */}
      {view === "note" && (isAdmin || canNotes) && (
        <Shield what="笔记本">
          <LoadingBoundary label="正在载入笔记本">
          <NotePage state={state} onNav={nav} room={uiRoom} />
          </LoadingBoundary>
        </Shield>
      )}

      {view === "memory-session" && isAdmin && (
        <Shield what="回想">
          <LoadingBoundary label="正在载入回想">
          <SessionMemoryPage onNav={nav} />
          </LoadingBoundary>
        </Shield>
      )}

      {view === "mailbox" && isAdmin && (
        <Shield what="信箱">
          <LoadingBoundary label="正在载入信箱">
          <MailboxPage onNav={nav} />
          </LoadingBoundary>
        </Shield>
      )}

      {view === "settings" && (
        <Shield what="设置">
          <LoadingBoundary label="正在载入设置">
          <SettingsPage
            section={section}
            onSection={setSection}
            state={state}
            patch={patch}
            isAdmin={isAdmin}
            role={role}
            card={card}
            canPublic={canPublic}
            canFiles={canFiles}
            onNav={nav}
            sessions={sessions}
            activeSession={activeSession}
            voices={voices}
            voiceDefault={voiceDefault}
            voiceCloud={voiceCloud}
            onSwitchSession={switchSession}
            onRenameSession={renameSession}
            onDeleteSession={deleteSession}
            onToggleVisibility={toggleVisibility}
            onToggleArchive={toggleArchive}
            onTogglePin={togglePin}
            onLogout={logout}
            online={online}
            motion={motion}
            setMotion={setMotion}
            theme={theme}
            setTheme={setTheme}
            setThink={setThink}
          />
          </LoadingBoundary>
        </Shield>
      )}

      {showIntro && <GuestIntro onDone={finishIntro} flash={flash} />}
      {notice && <div className="notice">{notice}</div>}
      {/* 看大图这一层挂在最外面：对话、笔记本、记忆面板里的图共用它 */}
      {(shownMessages.length > 0 || view === "note") && (
        <LoadingBoundary label="正在载入看图">
          <Lightbox />
        </LoadingBoundary>
      )}
    </>
  );
}
