import { useAgent } from "agents/react";
import { useAgentChat } from "@cloudflare/ai-chat/react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { api, type Role } from "./lib/api";
import {
  canDictate,
  canSpeak,
  speak,
  startDictation,
  stopSpeaking,
  textOf,
} from "./lib/speech";
import { INITIAL_UI_STATE } from "./lib/types";
import type {
  AskEntry,
  Attachment,
  ChatState,
  LastUsage,
  SessionMeta,
  SettingsKey,
  ThemeKey,
  UserCard,
  ViewKey,
  Voice,
} from "./lib/types";
import { Gate, useGate } from "./components/Gate";
import { Icon, type IconName } from "./components/Icons";
import { Lightbox } from "./components/Lightbox";
import { Messages } from "./components/Messages";
import { NoteDrawer } from "./components/NoteDrawer";
import { NotePage } from "./components/NotePage";
import { SessionMemoryDrawer } from "./components/SessionMemoryDrawer";
import { SessionMemoryPage } from "./components/SessionMemoryPage";
import {
  Backdrop,
  ChatSidebar,
  SettingsPage,
  Shield,
} from "./components/Pages";

/**
 * 快捷指令表：一份数据同时喂给三处 —— 输入框的「/」菜单、按下回车时的解析、
 * 以及按身份裁剪（访客看不到自己没有的那几条）。
 *
 * 分两种，这个区分是有用的：
 *   say —— 换成一句自然语言交给他。这类要的是他的判断（统计、整理、反思），绕不开模型。
 *   ui  —— 前端当场做完。切深度模式、新开一场对话本来就是界面动作，
 *          以前也要写一句话让他去调工具：白烧一轮 token，而且他回一句「好的，已切换」
 *          时状态未必真的变了 —— 人看到的是「他说切了」，实际上是没切。
 */
type Cmd = {
  name: string;
  label: string;
  desc: string;
  icon: IconName;
  /** 访客也能用。不标就是主人专属：他手上没有那些工具，列出来才是骗人 */
  guest?: boolean;
} & (
  | { kind: "say"; text: string }
  | { kind: "ui"; run: "deep" | "normal" | "new" | "ledger" }
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
    kind: "say",
    text: "统计一下记忆库现在有多少条，按分类说一下。",
  },
  {
    name: "/tasks",
    label: "看看待办",
    desc: "列出当前的任务和各自的状态",
    icon: "clipboard",
    kind: "say",
    text: "列出我当前所有任务和状态。",
  },
  {
    name: "/skills",
    label: "技能配方",
    desc: "他保存下来的那些成套做法",
    icon: "layers",
    kind: "say",
    text: "列出我保存的全部技能配方。",
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

/** 待发的一份附件：已经传到云盘、也已经读好了，只等跟着这条消息一起发出去。
 *  file：能内联的那张图，留着原件，发消息时读成 data URL 随行（模型亲眼看原图）。 */
type Attached = Attachment & { key: string; file?: File };

/** 一次最多带这么多份 —— 再多也不是读不完，是他自己都记不清带了什么 */
const MAX_ATTACH = 5;

/**
 * 哪些图可以原图直进消息：主流模型端点都认这四种，别的一律走转述兜底。
 * 体积卡在 3.5MB：端点单图上限 5MB 是按 base64 算的，原图先膨胀 1/3，留出余量。
 */
const INLINE_IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);
const INLINE_IMAGE_MAX = 3_500_000;
const canInlineImage = (f: File): boolean =>
  (INLINE_IMAGE_TYPES.has(f.type) || /\.(png|jpe?g|webp|gif)$/i.test(f.name)) &&
  f.size <= INLINE_IMAGE_MAX;

/** 文件读成 data URL。SDK 的 file part 认这个格式，转出来就是模型能吃的图片块 */
const readAsDataURL = (f: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error ?? new Error("读不出来"));
    r.readAsDataURL(f);
  });

/**
 * 提问卡上的自写答案框：回车就当作对这条问题的回答发出去。
 * 以前自写答案要挪到底下的输入栏 —— 工作流断一次；现在当场写当场发。
 */
function AskInlineInput({ onSend }: { onSend: (text: string) => void }) {
  const [draft, setDraft] = useState("");
  return (
    <div className="ask-inline">
      <input
        className="ask-inline-input"
        value={draft}
        placeholder="自己写一句，回车就发"
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && draft.trim()) {
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

export default function App() {
  const { gate, role, agent, unlock, unlockCard, lock } = useGate();
  if (gate === "checking") {
    return (
      <div className="gate">
        <p className="dim">检查中…</p>
      </div>
    );
  }
  if (gate === "locked")
    return <Gate onSubmit={unlock} onSubmitCard={unlockCard} />;
  return <Shell role={role} agentName={agent} onLock={lock} />;
}

/**
 * 进门介绍页：第一次来的访客先弄清楚这儿是谁、能干什么，再进去。
 *
 * 三种登记方式（身份卡体系，见后端 userCards.ts）：
 * - 临时进入：报个称呼就进，来历可写可不写；
 * - 登卡：老朋友凭「昵称 + 密码」回到卡绑定的那间屋 —— 成功后整页重载，
 *   cookie 已换成卡票，重连就是自己那间；
 * - 领卡：想把这段对话变成长期身份，就登记目的和卡密码 —— 当前房间整体升级，
 *   历史一条不搬。
 *
 * 为什么是一层覆盖而不是一个路由：它只该在「第一次」出现，之后永远不再打扰。
 * 记号写在本机 localStorage；后端那边一旦落了 guestName，这层也永远不再弹 ——
 * 两道闸，换台机器来过的老访客也不会被再塞一遍说明书。
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
      <div
        style={{
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
        {/* ericher 没有立绘，门口还是那个字母 */}
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
          }}
        >
          e
        </div>
        <h2
          style={{
            margin: "0 0 12px",
            fontSize: 20,
            fontWeight: 600,
            letterSpacing: "0.02em",
          }}
        >
          这里是 ericher 的接待台
        </h2>
        <p style={line}>我是 ericher，这间接待台的助手。</p>
        <p style={line}>先说说你是谁、为什么来。能办的事，我当场办。</p>
        <p style={{ ...line, marginBottom: 20 }}>办不了的，原话记下来转达。</p>
        <p style={{ ...line, fontSize: 12, marginBottom: 20 }}>
          对话与操作会留痕存档，供管理员查阅。
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

function Shell({
  role,
  agentName,
  onLock,
}: {
  role: Role;
  agentName: string;
  onLock: () => void;
}) {
  // 基础屋由后端按登录身份指定：来客必须进自己那间，否则一开门就会看到主人正在聊的内容。
  // 每场新对话另有自己的一间场屋（屋名 = 人屋--场id）——切场就是换连接：
  // name 一变，底层 socket 自动重连那间屋，历史按屋灌回。一个屋一辈子只聊一场，
  // 老场留在老屋里继续活着，这就是多场并行的地基
  const [activeRoom, setActiveRoom] = useState(agentName);
  const agent = useAgent<ChatState>({ agent: "CoworkAgent", name: activeRoom });
  // experimental_throttle：流水式刷新消息 store 会把 useSyncExternalStore 逼到同一 tick
  // 里嵌套更新几十次，React 直接抛「Maximum update depth exceeded」——抛错打断流处理，
  // 传输层随即 cancel，服务端被记成「用户中断」。给消息回调加 60ms 节流，把刷新压成
  // leading+trailing 两次，既保住尾帧又不炸渲染。
  const { messages, sendMessage, status, isServerStreaming, stop, regenerate } =
    useAgentChat({ agent, experimental_throttle: 60 });
  const state = agent.state ?? INITIAL_UI_STATE;

  const isAdmin = role === "admin";
  const busy =
    status === "streaming" || status === "submitted" || isServerStreaming;
  const online = agent.identified;
  const thinkDeep = state.thinkMode === "deep";
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
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  /** 这台机器上能用的嗓子。拿不到（比如来客）就是空的，设置页自然不显示这一块 */
  const [voices, setVoices] = useState<Voice[]>([]);
  /** 没选嗓音时后端实际会用哪一副。设置页要把它标出来，否则一列选项没人认领 */
  const [voiceDefault, setVoiceDefault] = useState("");
  const [voiceCloud, setVoiceCloud] = useState(false);
  const [activeSession, setActiveSession] = useState("");
  /**
   * 正在换场。从点下去到新屋把状态推回来，中间那几秒屏幕上摆的还是旧那一场 ——
   * 不遮一下，人看到的就是「点了没反应」，于是再点一次；两次切换的 state 互相追着改，
   * 侧栏高亮就来回跳。遮罩 + 先把侧栏跳过去，是把这个空窗明说出来，而不是假装没有。
   */
  const [switching, setSwitching] = useState<{
    id: string;
    title: string;
    mode: "new" | "switch";
  } | null>(null);
  /**
   * 已经点了「新建」、但还没开出来的那一场。
   *
   * 新建不连屋：一间场屋就是一个完整的 DO 实例，点一下就建 ——
   * 「点了没说话就走」会留下一间侧栏里看不见、界面上也删不掉的屋。
   * 所以这里先只握着「屋名 + 场 id」（服务端已经算好；建 stub 不会实例化 DO），
   * 等这一场的第一句话真要说出口了，再换连接把它开出来。
   *
   * 侧栏这时候不插行：还没说过一句话的位子不是一场对话，摆上去只会让列表
   * 里出现一条点不开、也删不掉的假会话。真要开始了（第一句话落位、后端登记）
   * 它自己会出现在列表里。
   */
  const [pendingRoom, setPendingRoom] = useState<{
    id: string;
    room: string;
  } | null>(null);
  /** 等着屋开出来再补发的那一句话 —— 只可能是这一场的第一句 */
  const queuedSend = useRef<Parameters<typeof sendMessage>[0] | null>(null);
  const [drawer, setDrawer] = useState(false);
  /** 左边的笔记本抽屉。和会话列表抽屉互斥 —— 两块东西都贴左边，同时拉开只会叠在一起 */
  const [noteDrawer, setNoteDrawer] = useState(false);
  /** 左边的回想抽屉。和笔记本互斥，理由同上 */
  const [memoDrawer, setMemoDrawer] = useState(false);
  const [input, setInput] = useState("");
  const [notice, setNotice] = useState("");
  /**
   * 这一轮他在想什么：服务端隔几秒翻一句过来（见 src/agent/think.ts）。
   *
   * 为什么要它：开口之前那一段静默里，来客那边整段推理是不给看的 ——
   * 屏幕上只剩一个空气泡，和「ericher 卡了」长得一模一样。
   */
  const [thoughts, setThoughts] = useState<string[]>([]);
  const thoughtTurn = useRef(0);
  const [listening, setListening] = useState(false);
  const [speakingId, setSpeakingId] = useState("");
  /** 还没发出去的附件 */
  const [pending, setPending] = useState<Attached[]>([]);
  /** 正在读的那一份的名字。读 PDF、转录音都要好几秒，界面得有个「我在读」的样子 */
  const [reading, setReading] = useState("");
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
   * 换场落底：切进一场有记录的对话，就该落在最新那条的末尾 ——
   * 不是从开头翻起。平时自动滚动只认「人本来就贴着底部」（stick），
   * 可刚从一场翻着旧账的对话里切出来时 stick 是假的，新场的历史灌进来
   * 就会停在顶上 —— 等于每换一场都被人摁回第一页。这个旗子压过 stick 一次
   */
  const jumpBottom = useRef(false);
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

  /** 当前这一场。列表里没有它（刚点的新建、还没说过话）时就没有标题，走「新的对话」 */
  const current = sessions.find((s) => s.id === activeSession);

  /**
   * 摆到屏幕上的那一份消息。
   *
   * 换场期间先清空：手上这份还是上一场的（客户端只在收到消息推送时才换，
   * 换屋和切场都有一段空窗），而遮罩是半透的磨砂 —— 摆出来等于把上一场的话
   * 透给人看。服务端那边已经在连接时把这一场的历史推过来了（见 cowork 的
   * onConnect），到位之前这里就是空的，正配上遮罩那句「正在切换」。
   *
   * 刚点的新建（pendingRoom）同理：新屋还没开，手上这份还是上一场的，
   * 新场该是空的。
   */
  const shownMessages =
    switching || pendingRoom || !agent.state ? [] : messages;

  /**
   * 界面上「现在这间屋」是哪一间。
   *
   * 站在刚点的新建上时，手上那条连接还挂在上一场上 —— 那一场已经不在眼前了，
   * 名字盘、笔记本、附件这些按屋取的东西都该读人屋：这一场真要开出来时，
   * 场屋就是从人屋那儿抄一份配置起步的（见 cowork 的 onConnect）。
   */
  const uiRoom = pendingRoom ? agentName : activeRoom;

  const flash = useCallback((text: string) => {
    setNotice(text);
    // 每条提示自己带一个定时器，并且把上一条的取消掉 ——
    // 否则前一条的定时器会提前把后一条抹掉（「停下了」紧跟「已切换」就会闪一下没）
    window.clearTimeout(noticeTimer.current);
    noticeTimer.current = window.setTimeout(() => setNotice(""), 2500);
  }, []);

  /**
   * 把攥在手里的「第一句话」还给输入框。
   *
   * 换场等不下去（保险丝烧断、人自己换去别处）时用。以前这里只是把它丢掉再提一句
   * 「再说一次就行」—— 等于让人白打一遍字，长句和附言都白费。至少把话放回原处：
   * 人按一下回车就重试，不用重打。
   * 输入框里已经有人自己打的新内容就不动它（合并两份文字比丢掉一份更糟）。
   */
  const restoreQueued = useCallback(
    (why: string) => {
      const q = queuedSend.current;
      if (!q) return;
      queuedSend.current = null;
      const text =
        typeof q === "string" ? q : ((q as { text?: string })?.text ?? "");
      if (text) setInput((cur) => (cur ? cur : text));
      if (why) flash(why);
    },
    [flash],
  );

  /**
   * 掀开换场遮罩，并压一根保险丝：新屋一直不回话（网断了、屋起不来）时
   * 也得把遮罩撤掉 —— 把人锁在一层毛玻璃后面，比慢本身更糟。
   *
   * 保险丝的时限跟着「新屋要冷启动」这件事定：一间没开过的场屋连上来要建库、跑迁移，
   * 起步还得跨间去人屋取人设与偏好 —— 刚部署完（所有屋都是冷的）这条链更慢。
   * 15 秒太紧，实测就会在「话还攥在手里」时烧断，等于把人的第一句话吃了。
   * 保险丝烧断时不再丢掉它：还给输入框（见 restoreQueued），让人一键重试。
   */
  const beginSwitch = useCallback(
    (id: string, title: string, mode: "new" | "switch") => {
      setSwitching({ id, title, mode });
      window.clearTimeout(switchFuse.current);
      switchFuse.current = window.setTimeout(() => {
        setSwitching(null);
        restoreQueued("新会话没接上，那句话给你放回输入框了 —— 按回车再发一次");
      }, 30000);
    },
    [restoreQueued],
  );

  const endSwitch = useCallback(() => {
    window.clearTimeout(switchFuse.current);
    setSwitching(null);
  }, []);

  const nav = useCallback((v: ViewKey) => {
    setView(v);
    setDrawer(false);
    setNoteDrawer(false);
    setMemoDrawer(false);
  }, []);

  // 动效开关：写 body 属性，CSS 里 body[data-motion="off"] 负责停掉动画
  useEffect(() => {
    document.body.dataset.motion = motion ? "on" : "off";
    localStorage.setItem(MOTION_KEY, motion ? "on" : "off");
  }, [motion]);

  // 外观主题：写 <html> 的 data-theme，theme.css 按值换一套 token。
  // 「跟随系统」解析成 paper/dark，并盯着系统的明暗开关实时翻面。
  // 浏览器框的颜色（theme-color meta）跟着一起翻：夜墨给深底，亮色给白纸
  useEffect(() => {
    localStorage.setItem(THEME_KEY, theme);
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const dark = theme === "dark" || (theme === "system" && mq.matches);
      document.documentElement.dataset.theme = dark
        ? "dark"
        : theme === "dawn"
          ? "dawn"
          : "paper";
      document
        .querySelector('meta[name="theme-color"]')
        ?.setAttribute("content", dark ? "#17191c" : "#ffffff");
    };
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, [theme]);

  // 会话都在后端，侧栏与设置页共用这一份。
  // 不分角色取两份：谁都只看自己那几场 —— 后端按登录身份把请求落到各自的屋子里，
  // 所以来客拿到的天然就是他自己那间，不是主人家的。
  const loadSessions = useCallback(async () => {
    try {
      const list = await api.sessions();
      setSessions(list);
      // 把最新列表交回去：删掉当前这场时得按 id 从里面找目标会话的 home，才知道换到哪间屋
      return list;
    } catch {
      /* 拿不到就保持空列表，不打扰用户 */
      return undefined;
    }
  }, []);

  useEffect(() => {
    void loadSessions();
  }, [loadSessions]);

  /**
   * 接住服务端主动开口时广播的那条 notice。
   *
   * 以前没人接这条消息 —— 他在那边说了话（提醒到点、有新动静），这边界面纹丝不动，
   * 只有事后翻记录才发现他说过。那就等于他白开口了一次。
   *
   * 顺带刷一次会话列表：他可能刚另开了一场说事，那一场得先出现在侧栏里，
   * 才有「闪一下 + 角标」可言。
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

  // 嗓子清单只问一次：它是这台机器的配置，跟聊什么无关。
  // 来客没有这个接口的权限，拿不到就空着 —— 设置页那一块会自己藏起来。
  useEffect(() => {
    if (!isAdmin) return;
    let alive = true;
    void api
      .voices()
      .then((r) => {
        if (!alive) return;
        setVoices(r.voices);
        setVoiceDefault(r.defaultVoice);
        setVoiceCloud(r.cloud);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [isAdmin]);

  // 「当前是哪一场」以后端为准：切会话、新建、被删都是它在改。
  // 但换场途中要放行本地那次乐观跳转 —— 旧屋的 state 会晚到一步，
  // 照单全收就会把刚点的那一场拽回去，看上去正是「乱跳会话」。
  // 站在还没开出来的新场上同理：那一场后端还不知道（屋都没建），
  // 位置只能本地拿着，这会儿后端说的「当前是上一场」不作数。
  useEffect(() => {
    if (!state.activeSession) return;
    if (switching && state.activeSession !== switching.id) return;
    if (pendingRoom) return;
    setActiveSession(state.activeSession);
  }, [state.activeSession, switching, pendingRoom]);

  // 新屋把状态推回来了：activeSession 落到目标上，就是「到了」，撤遮罩。
  // 连接也认出来了才算数 —— 否则刚换连接、旧屋的 state 还挂在那儿时会被误判成到位。
  //
  // 三道都要过：identified（socket 认过身份了）、agent.name 就是我们要去的屋
  // （旧屋的 state 可能还没散，光看 activeSession 会被它骗过去），
  // 以及 activeSession 落到目标场。agent.name 是服务端报回来的实例名，
  // 它一对上就说明这条 socket 真挂在目标屋上了 —— 比只等 state 到的更快也更准。
  //
  // 补发也在这儿：等着的「第一句话」必须等屋真连上再发 —— 提前发就落到上一间屋里去了
  // （换连接不是同步的，手上的 socket 还是旧的那条）。
  useEffect(() => {
    if (!switching) return;
    if (!agent.identified || agent.name !== activeRoom) return;
    if (state.activeSession !== switching.id) return;
    endSwitch();
    const q = queuedSend.current;
    if (!q) return;
    queuedSend.current = null;
    sendMessage(q);
  }, [
    switching,
    state.activeSession,
    agent.identified,
    agent.name,
    activeRoom,
    endSwitch,
    sendMessage,
  ]);

  // 换了一场对话：那些独白属于上一场他那句话，别跟着搬过来。
  // 轮次号一起归零 —— 号是那边的屋子发的，换了场次手上的号就没意义了
  useEffect(() => {
    setThoughts([]);
    thoughtTurn.current = 0;
  }, [activeSession]);

  // 只在用户本来就贴着底部时才自动滚动，免得翻历史记录被拽回来
  const onScroll = useCallback(() => {
    const el = stream.current;
    if (!el) return;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  }, []);

  // 自动滚动分两种：人本来就贴着底部（stick），跟着新话往下走；
  // 或者刚换了一场（jumpBottom），不管刚才在哪儿都得落到最新消息的末尾
  useEffect(() => {
    if (jumpBottom.current) {
      // 空列表跳了等于没跳：等历史灌进来再落底
      if (!messages.length) return;
      jumpBottom.current = false;
      stick.current = true;
      bottom.current?.scrollIntoView({ behavior: "auto", block: "end" });
      return;
    }
    if (stick.current)
      bottom.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, busy]);

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
   * 调思考强度。
   *
   * 走 /api/think 而不是 patchConfig：这件事访客也该有 —— 问的是同一副脑子，
   * 没道理主人能要他想深一点、来客就只能收着。而 patchConfig 是设置页那道口子，
   * 后面还站着人格提示词和任务清单，不能为了一个开关把它们一起放开。
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
      force = false,
    ): boolean => {
      const text = raw.trim();
      if (!text) return false;
      // ericher 还在说的时候就按了回车：说一声。以前是直接丢掉，
      // 人只看到输入框空了、ericher 没理人 —— 那看起来像故意不理。
      // force：提问卡的选项作答走这里 —— 点了选项就等于「停下听我答」，
      // 打断在 answerAsk 里先做（halt），这里只管放行
      if (busy && !force) {
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
        queuedSend.current = payload;
        beginSwitch(pendingRoom.id, "新会话", "new");
        setActiveRoom(pendingRoom.room);
        setPendingRoom(null);
        return true;
      }
      sendMessage(payload);
      return true;
    },
    [beginSwitch, busy, flash, pendingRoom, sendMessage],
  );

  const submit = () => {
    const raw = input.trim();
    // 把指令名敲全了再按回车，和从菜单里挑一条是同一条路 —— 两条出口分开写，
    // 迟早会长成两种行为（菜单里切了模式、手打却发了一段话给他）
    const hit = cmds.find((c) => c.name.toLowerCase() === raw.toLowerCase());
    if (hit) {
      runCommand(hit);
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
      setInput("");
      setPending([]);
      if (nearest) void dropAsk(nearest.id);
    };
    // 能内联的那几张图，先读成 data URL 再发 —— 这一步是异步的。读不出来就只发文字：
    // 服务端那份 R2 里的原件还在，转述兜底还在，不能因为读图失败把整句话吞掉
    const inline = pending.filter((f) => f.file);
    if (inline.length) {
      void Promise.all(inline.map((f) => readAsDataURL(f.file!)))
        .then((urls) => {
          const images = inline.map((f, i) => ({
            mediaType: f.file!.type || "image/png",
            filename: f.file!.name,
            url: urls[i],
          }));
          if (send(text, images)) afterSend();
        })
        .catch(() => {
          if (send(text)) afterSend();
        });
      return;
    }
    if (!send(text)) return;
    afterSend();
  };

  /**
   * 收下几份文件：先传到云盘，再让服务端读一遍。
   *
   * 两件事分开发、一份一份串着走，是为了「读」这一步能看见进度 ——
   * 一份 20 分钟的录音要转写十几秒，那十几秒界面不能是死的。
   */
  const addFiles = useCallback(
    async (list: FileList | File[] | null) => {
      if (!list || !isAdmin) return;
      const all = Array.from(list);
      const room = MAX_ATTACH - pending.length;
      if (room <= 0) {
        flash(`一次最多带 ${MAX_ATTACH} 份，先发出去再拿新的`);
        return;
      }
      const picked = all.slice(0, room);
      if (picked.length < all.length)
        flash(`一次最多带 ${MAX_ATTACH} 份，多出来的先没收`);
      for (const f of picked) {
        setReading(f.name);
        try {
          const up = await api.upload(f);
          // 主模型已经能亲眼看图：能内联的就告诉服务端「原图我自己带」，
          // 不必再等视觉模型转述一跳；太大的或格式冷门的仍走转述。
          const inline = canInlineImage(f);
          const a = await api.attach(up.key, f.name, inline);
          setPending((prev) =>
            prev.length >= MAX_ATTACH
              ? prev
              : [...prev, { ...a, key: up.key, file: inline ? f : undefined }],
          );
        } catch (e) {
          flash(`「${f.name}」没读成：${(e as Error).message}`);
        }
      }
      setReading("");
    },
    [flash, isAdmin, pending.length],
  );

  const dropFile = (f: Attached) =>
    setPending((prev) => prev.filter((x) => x.key !== f.key));

  /**
   * 打断。人对人说话，对方跑偏了就是一句「停一下」——这里也得有。
   *
   * 两刀都要下：先断客户端这条流，显示立刻停住；再告诉服务端。
   * 因为刷新页面后恢复的那种流，客户端手里没有 requestId，只断本地的话
   * 服务端还在那边说，界面会一直挂着「正在回应…」，谁也逃不出来。
   * 已经说出口的部分留着 —— 那是它说过的话。
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
   * 重来。他说得不合意，就让他把最后那句收回、重新想一遍。
   *
   * 界面上这个按钮只挂在最后一条 —— 重来等于「从那句往后全部作废、重新生成」，
   * 挂在中间某条上就是顺手删掉后面一整段对话，而那个代价用户看不见。
   */
  const retryMsg = useCallback(
    (id: string) => {
      if (busy) return;
      voiceReply.current = false; // 重来这一遍先不念，免得两遍念串
      void regenerate({ messageId: id });
      flash("重来一遍…");
    },
    [busy, flash, regenerate],
  );

  // Esc 打断：手不用离开键盘。这是「别说了」最自然的手势。
  // 但浮层（看图层、命令菜单）也认 Esc —— 它们把这下手势 preventDefault 认走时，
  // 这里就别再接：人家关的是自己的面板，不该顺手把正在跑的生成轮也砍了
  //（看图层的监听挂载在先、这里的随后重挂，认领逻辑先于本处执行，次序成立）
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

  // 逐条朗读：再点一下是同一条，就当「别念了」
  //
  // 先亮起「正在念」再等音频：云端合成要几百毫秒，
  // 等拿到了才变状态的话，点下去那一瞬像是没点着。
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

  // 一轮答完，把会话列表补一次。
  //
  // 为什么还要等一下再补：会话标题是他答完之后才起的（得读完自己刚说的话才起得准），
  // 比回答晚半拍。只刷一次的话，名字往往在刷新之后才落到库里，侧栏要等到下次
  // 换会话才会更新成新名字。所以先刷一次把时间和条数对上，过一会儿再接一次名字。
  //
  // 这个 effect 必须排在下面那个「用说的回」之前：那个 effect 结尾会写 wasBusy.current，
  // 一写就把「刚答完」这个信号吃掉了，排在它后面就永远等不到。
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

  const newSession = useCallback(async () => {
    // 连点门闩：已经在造新场屋就直接退出，否则两次 createSession 会各造一间互相覆盖
    if (creatingRef.current) return;
    creatingRef.current = true;
    try {
      if (busy) halt(); // 换话题之前先让他停下，不然那个回答会追到新会话里
      setPending([]); // 攒着还没发的附件属于上一场的话题，别跟着搬过去
      // 新对话 = 新开一间场屋。后端当场把场 id 和屋名算好（home），人屋本尊一动不动。
      //
      // 但这里**不换连接**：屋此刻还不建（建 stub 不会实例化 DO），等这一场的第一句话
      // 要说出口了才换（见 pendingRoom 与 send 里那一段）—— 那句话正好落进新屋的第一轮。
      // 没人说过话的场，就不会留下一间看不见也删不掉的空屋。
      const meta = await api.createSession();
      if (meta?.home) {
        setActiveSession(meta.id);
        setPendingRoom({ id: meta.id, room: meta.home });
      }
      await loadSessions();
      flash("新会话已就位，说第一句就开始");
    } catch (e) {
      flash((e as Error).message);
    } finally {
      creatingRef.current = false;
    }
  }, [busy, flash, halt, loadSessions]);

  /**
   * 执行一条快捷指令。
   *
   * ui 类故意不经过 sendMessage：切模式、新开一场、跳到账本这些事，
   * 他本来也不需要「知道」——以前写一句话让他去调工具，等于为了按一下开关烧一轮 token，
   * 而且那一下还不一定按对（他回「已切换」而 thinkMode 没动，人是分辨不出来的）。
   * 至于汇报类的（统计、整理、反思），要的本来就是他的判断，那必须交给他。
   *
   * 不是 useCallback：它只被事件处理器调用，不进任何依赖数组，
   * 而它要用到后面才定义的 newSession —— 包成 callback 反而会在依赖数组求值时踩到未初始化。
   */
  const runCommand = (cmd: Cmd) => {
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
    // ledger：账本在设置里那一格，人自己写最顺
    setView("settings");
    setSection("ledger");
    setDrawer(false);
    flash("写一句就行，底下就是登记框");
  };

  // 切会话分两种走法：宿在人屋的老场，由后端搬消息（存好这一场、把目标那场灌回来）；
  // 场屋里的场不搬 —— 消息住在那间独立的屋子里，换条连接就行，历史按屋灌回。
  // 两种都不能调 clearHistory()，那会顺手把服务端也清掉。
  const switchSession = useCallback(
    async (id: string, title: string) => {
      if (id === activeSession) return;
      if (busy) halt(); // 同上：切走之前先收干净，别让回答串场
      setPending([]); // 待发的附件跟人走，不跟着会话走
      const from = activeSession;
      // 走开就等于把这间还没开出来的屋作废 —— 它还没建，作废不掉任何东西。
      // 若那句话还攥在手上（屋没接上人就换走），还给输入框：这里不另发提示，
      // 紧接着的「已切换」提示会把它盖掉，说也白说
      if (pendingRoom) {
        restoreQueued("");
        setPendingRoom(null);
      }
      // 先把侧栏跳到这一场、把遮罩盖上，再去谈连接和搬运 ——
      // 老场宿在人屋时，后端要先清空再整场灌回，那段时间界面本来是一片空白
      beginSwitch(id, title, "switch");
      setActiveSession(id);
      try {
        const s = sessions.find((x) => x.id === id);
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
      busy,
      endSwitch,
      flash,
      halt,
      loadSessions,
      pendingRoom,
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
          setActiveRoom(target?.home || agentName);
          setActiveSession(r.active);
        }
        flash("已删除");
      } catch (e) {
        flash((e as Error).message);
      }
    },
    [activeSession, agentName, flash, loadSessions],
  );

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
    await api.logout();
    onLock();
  }, [onLock]);

  /**
   * 他还没等到回答的问题，只挑当前这一场的。
   *
   * 为什么要按会话过滤：卡片是「他正等着」的意思。换了一场话题还看见上一场的追问，
   * 会让人以为那件事还压在自己身上 —— 其实他早跟着新话题往下走了。
   */
  const pendingAsks = (state.asks || []).filter(
    (a) => a.sessionId === state.activeSession,
  );

  /** 收起一张提问卡（先不答）：空答案 resolve 挂起的工具，让他自己拿主意继续 */
  const dropAsk = useCallback(
    async (id: string) => {
      try {
        await api.answerAsk(id, "", activeRoom);
      } catch (e) {
        flash((e as Error).message);
      }
    },
    [flash, activeRoom],
  );

  /**
   * 答一张提问卡：REST 直达挂起的场屋，答案作为那次 ask 工具调用的结果回喂 ——
   * 模型带着答案在同一轮工作流里接着跑，不把回答当成一条新消息打断节奏。
   * 服务端已顺带收卡（state 经 WS 广播刷新），不再重复打一次收卡请求。
   * 挂起已经不在（超时/重启）就退回老路：当普通消息发。
   */
  const answerAsk = async (a: AskEntry, text: string) => {
    try {
      await api.answerAsk(a.id, text, activeRoom);
    } catch {
      if (busy) halt();
      // 服务端那边卡照收（过期的那种也收），所以不再补一次收卡请求
      if (!send(text, undefined, true)) return;
    }
  };

  return (
    <>
      <Backdrop />

      {view === "chat" && (
        // 笔记抽屉一拉开，左边的菜单栏就让位：两块都贴左边，并排站着只会叠在一起，
        // 而本子摊开的时候人要的是整块地方，不是「菜单栏边上挤出一条」
        <div
          className={`chat-app${noteDrawer || memoDrawer ? " note-open" : ""}`}
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
          {isAdmin && (
            <NoteDrawer
              open={noteDrawer}
              onClose={() => setNoteDrawer(false)}
              room={uiRoom}
              focusId={state.noteFocus}
            />
          )}
          {noteDrawer && (
            <div
              className="sidebar-mask"
              onClick={() => setNoteDrawer(false)}
            />
          )}

          {/* 回想抽屉：他休息时回头整理出来的那些。和笔记本一样占左边那一块 */}
          {isAdmin && (
            <SessionMemoryDrawer
              open={memoDrawer}
              onClose={() => setMemoDrawer(false)}
            />
          )}
          {memoDrawer && (
            <div
              className="sidebar-mask"
              onClick={() => setMemoDrawer(false)}
            />
          )}

          <main className="chat-main">
            <header className="chat-header">
              <button
                className="icon-btn menu-btn"
                onClick={() => {
                  setNoteDrawer(false);
                  setMemoDrawer(false);
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
                        setNoteDrawer((v) => !v);
                      }}
                      title="翻开笔记本（你翻着哪一篇，ericher 看得到）"
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
              {/* 只兜消息列表：某一条消息的渲染出了问题，输入框还得能用 ——
                  不然人连「说一句告诉它坏在哪」的机会都没有 */}
              <Shield what="消息">
                <Messages
                  messages={shownMessages}
                  streaming={busy}
                  role={role}
                  thoughts={thoughts}
                  speakingId={speakingId}
                  room={uiRoom}
                  onSpeak={speakMsg}
                  onRetry={retryMsg}
                  onFlash={flash}
                />
              </Shield>
              {dragOver && (
                <div className="drop-hint">松手，我看看这是什么</div>
              )}
              <div ref={bottom} />
            </section>

            <div className="input-area">
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
                          onClick={() => answerAsk(a, o)}
                        >
                          {o}
                        </button>
                      ))}
                    </div>
                  )}
                  {/* 自写答案就地发：选项不贴合时不用挪到底下的输入栏再答一遍 */}
                  <AskInlineInput onSend={(text) => answerAsk(a, text)} />
                  {/* 这句只写在贴着输入框的那张上：在下面打字，回的就是它 ——
                      每张都写一遍的话，人分不清那句话到底落给哪一张 */}
                  {a.id === pendingAsks[pendingAsks.length - 1].id && (
                    <p className="ask-hint">
                      {a.options.length
                        ? "挑一个，或在框里自己写"
                        : "在框里写一句就行"}
                    </p>
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
                      : "和 ericher 说点什么…（打 / 看能做什么）"
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
                        : "说给 ericher 听（用说的发，他就用说的回）"
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
            {(switching || !agent.state) && (
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
          <NotePage state={state} onNav={nav} room={uiRoom} />
        </Shield>
      )}

      {view === "memory-session" && isAdmin && (
        <Shield what="回想">
          <SessionMemoryPage onNav={nav} />
        </Shield>
      )}

      {view === "settings" && (
        <Shield what="设置">
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
        </Shield>
      )}

      {showIntro && <GuestIntro onDone={finishIntro} flash={flash} />}
      {notice && <div className="notice">{notice}</div>}
      {/* 看大图这一层挂在最外面：对话、笔记本、记忆面板里的图共用它 */}
      <Lightbox />
    </>
  );
}
