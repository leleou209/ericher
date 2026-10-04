// 回想页：他休息时回头整理出来的那些。
//
// 为什么单独开一个顶层页面，而不是并进记忆面板：记忆面板是按书架分的静态库
// （身份、人物、项目……），翻的是「他记得什么」；这一页翻的是「哪一场聊过什么」。
// 两者按的轴不一样 —— 混在一起，检索就没法做成「按时间 / 按语气」。
//
// 和笔记本页同一套骨架，但这里只看不写：这些条目是他自己回头看留下的，
// 管理员能做的只有「检索」和「叫他这会儿再看一眼」。

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../lib/api";
import {
  SENTIMENTS,
  SENTIMENT_LABEL,
  type MemEntry,
  type Sentiment,
  type SessionMemoryGroup,
  type ViewKey,
} from "../lib/types";
import { Icon } from "./Icons";
import "./NoteMemo.css";

/** 记在哪一段后面（见后端 sessionMemo 工具的 INTENT_MARK） */
const INTENT_MARK = "【这段怎么聊的】";

/** 时间三档 + 全部。用本地零点而不是 UTC —— 问「今天」的是他，不是服务器 */
type TimeBand = "all" | "today" | "week" | "older";

const TIME_LABEL: Record<TimeBand, string> = {
  all: "全部",
  today: "今天",
  week: "这周",
  older: "更早",
};

/** 一档时间换算成查询区间。older 是「更早」，所以要 to 而不是 from */
function bandRange(band: TimeBand): { from?: string; to?: string } {
  const day = 24 * 60 * 60 * 1000;
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const today = start.getTime();
  if (band === "today") return { from: new Date(today).toISOString() };
  if (band === "week") return { from: new Date(today - 6 * day).toISOString() };
  if (band === "older") return { to: new Date(today - 6 * day).toISOString() };
  return {};
}

export function when(iso: string): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t) || !t) return "";
  const m = Math.floor((Date.now() - t) / 60000);
  if (m < 1) return "刚刚";
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d} 天前`;
  return iso.slice(0, 10);
}

/** 正文和「这段怎么聊的」在库里是一段，显示时分开 —— 后者是注解，不该混在叙述里 */
function splitMemo(content: string): { body: string; intent: string } {
  const i = content.indexOf(INTENT_MARK);
  if (i < 0) return { body: content, intent: "" };
  return {
    body: content.slice(0, i).trim(),
    intent: content.slice(i + INTENT_MARK.length).trim(),
  };
}

function sentimentLabel(v: string): string {
  return SENTIMENT_LABEL[v as Sentiment] || "";
}

/** 检索条：搜索框 + 时间档 + 语气档。页和抽屉共用同一份，免得两边慢慢长成两个东西 */
export function MemoFilters({
  q,
  onQ,
  band,
  onBand,
  sentiment,
  onSentiment,
}: {
  q: string;
  onQ: (v: string) => void;
  band: TimeBand;
  onBand: (v: TimeBand) => void;
  sentiment: string;
  onSentiment: (v: string) => void;
}) {
  return (
    <div className="nm-filters">
      <div className="nm-search">
        <Icon name="search" size={14} />
        <input
          value={q}
          onChange={(e) => onQ(e.target.value)}
          placeholder="搜聊过的内容或标签"
          aria-label="搜索会话记忆"
        />
        {q && (
          <button
            className="nm-search-clear"
            title="清空"
            onClick={() => onQ("")}
          >
            ×
          </button>
        )}
      </div>
      <div className="nm-chips">
        {(Object.keys(TIME_LABEL) as TimeBand[]).map((b) => (
          <button
            key={b}
            className={`chip ${band === b ? "on" : ""}`}
            onClick={() => onBand(b)}
          >
            {TIME_LABEL[b]}
          </button>
        ))}
      </div>
      <div className="nm-chips">
        <button
          className={`chip ${sentiment ? "" : "on"}`}
          onClick={() => onSentiment("")}
          title="不限语气"
        >
          什么语气都行
        </button>
        {SENTIMENTS.map((s) => (
          <button
            key={s}
            className={`chip ${sentiment === s ? "on" : ""}`}
            onClick={() => onSentiment(sentiment === s ? "" : s)}
          >
            {SENTIMENT_LABEL[s]}
          </button>
        ))}
      </div>
    </div>
  );
}

/** 一张卡片。页和抽屉共用，所以宽度自己不管，交给外面的容器 */
export function MemoCard({
  entry,
  sessionTitle,
}: {
  entry: MemEntry;
  sessionTitle: string;
}) {
  const { body, intent } = splitMemo(entry.content);
  const label = sentimentLabel(entry.sentiment);
  return (
    <article className="card nm-card">
      <header className="nm-card-top">
        <span className="nm-when">
          <Icon name="clock" size={12} />
          {when(entry.learned)}
        </span>
        {label && (
          <span className={`chip nm-senti s-${entry.sentiment}`}>{label}</span>
        )}
        <span
          className="nm-from"
          title={sessionTitle || "这场已经不在列表里了"}
        >
          {sessionTitle || "已不在的一场"}
        </span>
      </header>
      <p className="nm-card-body">{body}</p>
      {intent && (
        <p className="nm-intent">
          <span className="nm-intent-mark">这段怎么聊的</span>
          {intent}
        </p>
      )}
    </article>
  );
}

/**
 * 拉数据的那一段逻辑。页和抽屉各自持有一份 state ——
 * 共用一份的话，抽屉一开一关会把页面上的筛选条件也一起改掉。
 *
 * enabled：抽屉常年挂在 DOM 上（动画要它），合着的时候不该还一直问后端。
 */
export function useSessionMemories(enabled = true) {
  const [groups, setGroups] = useState<SessionMemoryGroup[]>([]);
  const [list, setList] = useState<MemEntry[]>([]);
  const [q, setQ] = useState("");
  const [band, setBand] = useState<TimeBand>("all");
  const [sentiment, setSentiment] = useState("");
  const [sessionId, setSessionId] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const refreshGroups = useCallback(async () => {
    try {
      const rows = await api.sessionMemoryGroups();
      if (alive.current) setGroups(rows);
    } catch (e) {
      if (alive.current) setErr((e as Error).message);
    }
  }, []);

  const refresh = useCallback(async () => {
    setBusy(true);
    try {
      const rows = await api.sessionMemories({
        q: q.trim() || undefined,
        sentiment: sentiment || undefined,
        sessionId: sessionId || undefined,
        ...bandRange(band),
      });
      if (alive.current) {
        setList(rows);
        setErr("");
      }
    } catch (e) {
      if (alive.current) setErr((e as Error).message);
    } finally {
      if (alive.current) setBusy(false);
    }
  }, [q, sentiment, sessionId, band]);

  // 打字停下来再问后端：不然每敲一个字都打一次
  useEffect(() => {
    if (!enabled) return;
    const t = window.setTimeout(() => void refresh(), 260);
    return () => window.clearTimeout(t);
  }, [refresh, enabled]);

  useEffect(() => {
    if (!enabled) return;
    void refreshGroups();
  }, [refreshGroups, enabled]);

  const titles = useMemo(
    () => new Map(groups.map((g) => [g.sessionId, g.title])),
    [groups],
  );

  /** 叫他这会儿就看一眼这一场。返回他说的话，界面照着回一句 */
  const recapNow = useCallback(
    async (id: string): Promise<string> => {
      try {
        const r = await api.recapNow(id);
        await Promise.all([refresh(), refreshGroups()]);
        return r.recap
          ? "他回头把这一场看过了。"
          : r.note || "这一场没有还没记过的新内容。";
      } catch (e) {
        return (e as Error).message;
      }
    },
    [refresh, refreshGroups],
  );

  return {
    groups,
    list,
    titles,
    q,
    setQ,
    band,
    setBand,
    sentiment,
    setSentiment,
    sessionId,
    setSessionId,
    busy,
    err,
    recapNow,
  };
}

/** 空状态那句话：说清这页为什么是空的，以及它什么时候会自己满起来 */
const EMPTY = "他还没回头看过。你停下半小时之后，他会自己回顾刚才那一段。";

export function SessionMemoryPage({ onNav }: { onNav: (v: ViewKey) => void }) {
  const m = useSessionMemories();
  const [said, setSaid] = useState("");

  return (
    <div className="nm-page">
      {/* 顶栏：衬线标题 + 返回。这一页只看不写，头顶比笔记本还少一枚按钮 */}
      <header className="nm-top">
        <button
          className="icon-btn"
          title="返回对话"
          onClick={() => onNav("chat")}
        >
          <Icon name="arrow-left" size={17} />
        </button>
        <h1 className="nm-top-title">回想</h1>
      </header>

      <div className="nm-cols">
        <aside className="nm-side">
          <nav className="nm-groups">
            <button
              className={`nm-group ${m.sessionId ? "" : "on"}`}
              onClick={() => m.setSessionId("")}
            >
              <span className="nm-group-title">全部</span>
              <span className="nm-group-n">
                {m.groups.reduce((n, g) => n + g.n, 0)}
              </span>
            </button>
            {m.groups.map((g) => (
              <button
                key={g.sessionId}
                className={`nm-group ${m.sessionId === g.sessionId ? "on" : ""}`}
                onClick={() =>
                  m.setSessionId(m.sessionId === g.sessionId ? "" : g.sessionId)
                }
                title={`${g.title} · 最后 ${when(g.last)}`}
              >
                <span className="nm-group-title">{g.title}</span>
                <span className="nm-group-n">{g.n}</span>
              </button>
            ))}
          </nav>

          <div className="nm-foot">他每回头看过一场，这里就多一条</div>
        </aside>

        <main className="nm-main nm-memo-main">
          <header className="nm-memo-head">
            <MemoFilters
              q={m.q}
              onQ={m.setQ}
              band={m.band}
              onBand={m.setBand}
              sentiment={m.sentiment}
              onSentiment={m.setSentiment}
            />
            {m.sessionId && (
              <div className="nm-chips">
                <button
                  className="chip"
                  title="叫他这会儿就看一眼这一场（平时他会自己等到你停下半小时）"
                  onClick={() => void m.recapNow(m.sessionId).then(setSaid)}
                >
                  <Icon name="refresh" size={14} />
                  <span>叫他再看一眼</span>
                </button>
              </div>
            )}
          </header>

          {said && <p className="nm-said">{said}</p>}
          {m.err && <p className="nm-err">{m.err}</p>}

          <div className="nm-feed">
            {!m.busy && !m.list.length && <p className="nm-empty">{EMPTY}</p>}
            {m.list.map((e) => (
              <MemoCard
                key={e.id}
                entry={e}
                sessionTitle={m.titles.get(e.sessionId) || ""}
              />
            ))}
          </div>
        </main>
      </div>
    </div>
  );
}
