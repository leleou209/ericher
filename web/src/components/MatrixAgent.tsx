// 网页矩阵工作台 · 右侧助手栏：左边看图、右边让它改图，可整体收起（浮标在右下角，
// 让开左下角的「导航 | 编辑」）。它连的是独立场屋 `人屋--matrix`，不混人屋的上下文。
// 能力本来就在助手的矩阵工具里（src/tools/matrix.ts），这栏只做接线；只有「清空」，没有会话管理。

import { useCallback, useEffect, useRef, useState } from "react";
import { useAgent } from "agents/react";
import { useAgentChat } from "@cloudflare/ai-chat/react";
import { api } from "../lib/api";
import type { ChatState, MatrixStat } from "../lib/types";
import { Icon } from "./Icons";
import { Messages } from "./Messages";
import "./MatrixAgent.css";

/** 记「上一回见到的渲染方是谁」的口袋：换了包只提一次，不反复念叨 */
const PACK_KEY = "matrix:agent:pack";

export function MatrixAgent({
  agentName,
  stat,
  visible,
  onCollapse,
}: {
  /** 登录身份推导出的人屋名 —— 矩阵屋就是它的 `--matrix` 那间（理由见文件头） */
  agentName: string;
  /** 矩阵总览（版本 / 构建）。还没探到时为 null */
  stat: MatrixStat | null;
  /** 这一栏这会儿露着没有。收起来只是 display:none，得知道什么时候重新贴底 */
  visible: boolean;
  /** 收起这一栏 */
  onCollapse: () => void;
}) {
  const room = `${agentName}--matrix`;
  /**
   * 清空后换一把钥匙，让连接整个重来 —— 清空是服务端的事，重连最省事，
   * 也保证不残留旧消息。
   */
  const [gen, setGen] = useState(0);
  const [clearing, setClearing] = useState(false);
  /** 渲染方换过：只在首次发现时亮一次，点掉就不再提 */
  const [packNote, setPackNote] = useState("");
  /** 一闪而过的提示（清空结果、发送失败这类小事） */
  const [note, setNote] = useState("");
  const noteTimer = useRef<number | undefined>(undefined);

  const flash = useCallback((t: string) => {
    setNote(t);
    window.clearTimeout(noteTimer.current);
    noteTimer.current = window.setTimeout(
      () => setNote((cur) => (cur === t ? "" : cur)),
      2800,
    );
  }, []);
  // 走的时候把没到点的那个定时器带上：不然它醒来还会往一个已经不在的组件里写
  useEffect(() => () => window.clearTimeout(noteTimer.current), []);

  // 渲染方指纹：换了包只提一次（旧 → 新），点掉之后这一版就记成「见过了」
  useEffect(() => {
    if (!stat) return;
    const now = `v${stat.version} · 构建 ${stat.build}`;
    let prev = "";
    try {
      prev = localStorage.getItem(PACK_KEY) || "";
    } catch {
      /* 隐私模式读不了就不比了 */
    }
    if (prev && prev !== now)
      setPackNote(`渲染方换了（${prev} → ${now}）—— 能力可能有别`);
    try {
      localStorage.setItem(PACK_KEY, now);
    } catch {
      /* 写不了就不记 */
    }
  }, [stat]);

  const clear = () => {
    if (clearing) return;
    if (
      !window.confirm(
        "清空这间屋的聊天记录？说过的话就找不回来了（页面与结构都不动）。",
      )
    )
      return;
    setClearing(true);
    void api
      .clear(room)
      .then(() => {
        setGen((g) => g + 1);
        flash("清空了 —— 面前是一张白纸");
      })
      .catch((e) => flash((e as Error).message))
      .finally(() => setClearing(false));
  };

  return (
    <div className="wba">
      <header className="wba-bar">
        <span className="wba-mark" aria-hidden="true" />
        <div className="wba-brand">
          <strong className="wba-name">矩阵助手</strong>
          {/* 栏顶常驻的那枚指纹：这一栏认的是「功能」，记一笔渲染方的版本 */}
          <span className="wba-sub dim">
            {stat
              ? `渲染方 v${stat.version} · 构建 ${stat.build}`
              : "版本未探到"}
          </span>
        </div>
        <button
          className="wba-x"
          title="清空这间屋的聊天记录"
          disabled={clearing}
          onClick={clear}
        >
          <Icon name="trash" size={14} />
        </button>
        <button className="wba-x" title="收起助手栏" onClick={onCollapse}>
          <Icon name="x" size={14} />
        </button>
      </header>

      {!!packNote && (
        <div className="wba-note">
          <span>{packNote}</span>
          <button className="wba-note-x" onClick={() => setPackNote("")}>
            知道了
          </button>
        </div>
      )}

      <MatrixChat key={gen} room={room} note={note} flash={flash} visible={visible} />
    </div>
  );
}

/**
 * 一间屋的对话面：消息流 + 输入行。单独拆出来是为了「清空」——
 * 换 key 就整条重建，重新问服务端要一次历史。
 */
function MatrixChat({
  room,
  note,
  visible,
  flash,
}: {
  room: string;
  /** 由外壳统一管的提示条（清空结果、发送失败都在这一条上） */
  note: string;
  /** 这一栏这会儿露着没有（重新露出来时要贴回底） */
  visible: boolean;
  flash: (t: string) => void;
}) {
  const agent = useAgent<ChatState>({ agent: "CoworkAgent", name: room });
  // 和接待台同一套参数：throttle 是给消息 store 降频的，不给会把 React 逼到嵌套更新报错
  const { messages, sendMessage, status, isServerStreaming, stop } = useAgentChat({
    agent,
    experimental_throttle: 60,
  });
  const state = agent.state;
  const busy =
    status === "streaming" || status === "submitted" || isServerStreaming;
  const thinkDeep = state?.thinkMode === "deep";

  const [draft, setDraft] = useState("");
  const [thinkBusy, setThinkBusy] = useState(false);
  /** 这一轮他走到哪一步了（服务端隔几秒翻一句过来） */
  const [thoughts, setThoughts] = useState<string[]>([]);
  const thoughtTurn = useRef(0);
  const stream = useRef<HTMLDivElement>(null);

  // 「他正在想什么」和后端捎来的通知走同一条实时通道 —— 与接待台里那套一样
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (typeof e.data !== "string") return;
      try {
        const m = JSON.parse(e.data) as {
          type?: string;
          text?: string;
          turn?: number;
        };
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
        if (m.type === "notice" && m.text) flash(m.text);
      } catch {
        // 不是这种消息（状态同步、聊天流等），不关我的事
      }
    };
    agent.addEventListener("message", onMessage);
    return () => agent.removeEventListener("message", onMessage);
  }, [agent, flash]);

  // 有新东西就贴底：栏子窄，来回翻比读还慢。
  // visible 也在依赖里：藏着的那些时刻滚不动（display:none），重新露出来要补一次
  useEffect(() => {
    const el = stream.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, thoughts.length, busy, visible]);

  /**
   * 调这一场的思考强度。必须点名这间屋 —— 强度是每场一份，
   * 不点名调的是人屋，眼前这场纹丝不动。
   */
  const setThink = (mode: "normal" | "deep") => {
    setThinkBusy(true);
    void api
      .setThinkMode(mode, room)
      .then(() => flash(mode === "deep" ? "好，接下来我多想一会儿" : "回到平常的节奏"))
      .catch((e) => flash((e as Error).message))
      .finally(() => setThinkBusy(false));
  };

  const send = useCallback(
    (raw: string) => {
      const text = raw.trim();
      if (!text) return;
      if (busy) {
        flash("他还在说这一句，等说完再发 —— 或者按停止");
        return;
      }
      setThoughts([]);
      setDraft("");
      sendMessage({ text });
    },
    [busy, flash, sendMessage],
  );

  return (
    <>
      <div className="wba-stream" ref={stream}>
        <Messages
          messages={messages}
          streaming={busy}
          role="admin"
          thoughts={thoughts}
          turnErrors={state?.turnErrors ?? []}
          room={room}
          showDetail
          onFlash={flash}
        />
        {!messages.length && !busy && (
          <p className="wba-empty">
            这间屋只管网页矩阵：让他「看看现在有哪些页面」，他会自己去翻结构；
            要建页、连线、换外观，也在这儿说。改动落到对面那排页面上，不与接待台的对话混。
          </p>
        )}
      </div>

      {!!note && <div className="wba-flash">{note}</div>}

      <div className="wba-input">
        <button
          className={`chip wba-think${thinkDeep ? " on" : ""}`}
          disabled={thinkBusy}
          title="切换思考模式：深一点慢一点，还是平常的节奏（只影响这一间屋）"
          onClick={() => setThink(thinkDeep ? "normal" : "deep")}
        >
          <Icon name="type" size={15} />
          <span>{thinkDeep ? "深度" : "普通"}</span>
        </button>
        <textarea
          className="field wba-text"
          rows={1}
          value={draft}
          placeholder="让助手改矩阵：建页 / 连线 / 换外观…"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            // IME 守卫：中文输入法按回车确认候选词时 key 也是 Enter
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              send(draft);
            }
          }}
        />
        {busy ? (
          <button
            className="btn btn-sm"
            title="让他停下"
            onClick={() => void stop()}
          >
            停止
          </button>
        ) : (
          <button
            className="btn btn-sm btn-primary"
            title="发送"
            onClick={() => send(draft)}
            disabled={!draft.trim()}
          >
            发送
          </button>
        )}
      </div>
    </>
  );
}
