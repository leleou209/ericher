// 笔记本撰写页：左边一篇篇，右边写正文。
//
// 为什么单独开一个顶层页面而不是塞进设置里：设置页是「调他」的地方 ——
// 改人设、看记忆、配嗓子。写东西不是配置，是干活，干活得有个不带侧栏的整块地方。
//
// 页面上有两件事同时成立：他在这里写，ericher 也在看（后端每轮读 state.noteFocus）。
// 所以打开一篇就上报一次，而不是等他发消息时才告诉 ericher —— 该在他问之前就知道。

import { memo, useCallback, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { api } from "../lib/api";
import type {
  ChatState,
  Note,
  NoteMeta,
  NoteRevision,
  ViewKey,
} from "../lib/types";
import { Icon } from "./Icons";
import "./NoteMemo.css";

/**
 * 笔记正文的 Markdown 渲染。
 *
 * 和对话那边同一条规矩：不引 rehype-raw，不解析原始 HTML ——
 * 本子是两个人一起写的，谁写进来的标签都不该有机会变成页面里的东西。
 * 加 memo 的理由也一样：正文长起来之后，每敲一个字都重解析一遍会卡。
 */
export const NotePreview = memo(function NotePreview({
  text,
}: {
  text: string;
}) {
  return (
    <div className="md note-preview-body">
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>
        {text}
      </ReactMarkdown>
    </div>
  );
});

/** 停手多久就自动落库。太短会在打字中间反复写盘，太长他又会以为没保存 */
const SAVE_DEBOUNCE_MS = 1200;

function when(iso: string): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "";
  const m = Math.floor((Date.now() - t) / 60000);
  if (m < 1) return "刚动过";
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d} 天前`;
  return iso.slice(0, 10);
}

/** 标签在界面上是逗号串，落库才是数组 —— 两端各转一次，模型和人都少写一层括号 */
function splitTags(s: string): string[] {
  return s
    .split(/[,，]/)
    .map((t) => t.trim())
    .filter(Boolean);
}

export function NotePage({
  state,
  onNav,
  room,
}: {
  state: ChatState;
  onNav: (v: ViewKey) => void;
  /** 本子跟着场走：连在哪间场屋上，读写的就是哪一间的笔记本 */
  room: string;
}) {
  const [list, setList] = useState<NoteMeta[]>([]);
  const [q, setQ] = useState("");
  const [current, setCurrent] = useState<Note | null>(null);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [tagsText, setTagsText] = useState("");
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [preview, setPreview] = useState(false);
  const [revs, setRevs] = useState<NoteRevision[] | null>(null);
  const [err, setErr] = useState("");
  /** 载入一篇的时候，不是「他改过」—— 不挡住这一下，一打开就会立刻自动保存一遍 */
  const loading = useRef(true);
  const titleRef = useRef<HTMLInputElement>(null);
  // 最新输入的镜像：保存响应回来时要对着它判断「这一轮发出去之后人有没有又敲字」，
  // 光读闭包只能拿到发起保存那一刻的旧值
  const latest = useRef({ title: "", body: "", tags: "" });
  latest.current = { title, body, tags: tagsText };
  // 打开一篇的请求定序：快速连点两篇，先点的那篇慢回来会把新打开的盖掉 ——
  // 人接着写，字就落进另一篇里了。过期响应直接作废
  const openSeq = useRef(0);

  const refresh = useCallback(
    async (keyword = "") => {
      try {
        setList(await api.notes(keyword || undefined, undefined, room));
      } catch (e) {
        setErr((e as Error).message);
      }
    },
    [room],
  );

  const open = useCallback(
    async (id: string) => {
      const seq = ++openSeq.current;
      try {
        const n = await api.readNote(id, room);
        // 过期响应：丢弃 —— 别把后点开的那篇刚铺好的稿子又盖回旧的
        if (!n || seq !== openSeq.current) return;
        loading.current = true;
        setCurrent(n);
        setTitle(n.title);
        setBody(n.body);
        setTagsText(n.tags.join("、"));
        setDirty(false);
        setRevs(null);
        setPreview(false);
        setErr("");
        // 上报「我翻开了这一篇」。失败不打扰人 —— 界面照常能用，只是他这一轮少知道一件事
        void api.focusNote(id, room).catch(() => {});
      } catch (e) {
        if (seq !== openSeq.current) return;
        setErr((e as Error).message);
      }
    },
    [room],
  );

  // 进页面时：拿列表，然后接上次那篇（后端记着的 noteFocus 还在本子上的话），
  // 没接过就打开最前面那篇。省掉他每次进来都要重新找一遍。
  // room 也算进依赖：本子跟着场走，换了一场进来就是另一本
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const rows = await api.notes(undefined, undefined, room);
        if (!alive) return;
        setList(rows);
        const want =
          state.noteFocus && rows.some((r) => r.id === state.noteFocus)
            ? state.noteFocus
            : rows[0]?.id;
        if (want) await open(want);
      } catch (e) {
        setErr((e as Error).message);
      }
    })();
    return () => {
      alive = false;
    };
    // 之后列表由 refresh 维护，跟着 q 走
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room]);

  // 搜索：打字停下来再问后端，不然每敲一个字都打一次
  useEffect(() => {
    const t = window.setTimeout(() => void refresh(q.trim()), 260);
    return () => window.clearTimeout(t);
  }, [q, refresh]);

  useEffect(() => {
    if (loading.current) {
      loading.current = false;
      return;
    }
    setDirty(true);
  }, [title, body, tagsText]);

  const saveNow = useCallback(async () => {
    if (!current) return;
    // 快照这一轮存的是什么。请求在途时人还在打字 —— 响应回来若内容已经变了，
    // 就不能 setDirty(false)：一熄，自动保存 effect 的 cleanup 会把刚排上的
    // 新定时器清掉，后敲的这段永远落不了库，界面却显示「已保存」
    const snap = { title, body, tags: tagsText };
    setSaving(true);
    try {
      const n = await api.saveNote(
        {
          id: current.id,
          // 标题留空时交给后端从正文首行取一句 —— 一篇没名字的笔记他下次认不出来
          title: title.trim() || undefined,
          body,
          tags: splitTags(tagsText),
        },
        room,
      );
      setCurrent(n);
      const now = latest.current;
      if (
        now.title === snap.title &&
        now.body === snap.body &&
        now.tags === snap.tags
      )
        setDirty(false);
      setErr("");
      void refresh(q.trim());
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSaving(false);
    }
  }, [current, title, body, tagsText, q, refresh, room]);

  // 自动保存：停手一秒多就落库。显式的保存按钮也留着 ——
  // 自动保存是「不用惦记」，按钮是「我现在就要确定它写进去了」，两件事都要有
  useEffect(() => {
    if (!current || !dirty) return;
    const t = window.setTimeout(() => void saveNow(), SAVE_DEBOUNCE_MS);
    return () => window.clearTimeout(t);
  }, [dirty, saveNow, current]);

  const create = async () => {
    try {
      const n = await api.saveNote({ title: "新的笔记", body: "" }, room);
      await refresh(q.trim());
      await open(n.id);
      titleRef.current?.focus();
      titleRef.current?.select();
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const remove = async (n: Note) => {
    if (!window.confirm(`删掉《${n.title}》？这一篇和它的几版旧稿一起没了。`))
      return;
    try {
      await api.deleteNote(n.id, room);
      const rows = await api.notes(q.trim() || undefined, undefined, room);
      setList(rows);
      const next = rows[0]?.id;
      if (next) await open(next);
      else {
        setCurrent(null);
        void api.focusNote("", room).catch(() => {});
      }
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const togglePin = async () => {
    if (!current) return;
    try {
      const n = await api.saveNote(
        { id: current.id, pinned: !current.pinned },
        room,
      );
      setCurrent(n);
      void refresh(q.trim());
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const openRevs = async () => {
    if (!current) return;
    if (revs) {
      setRevs(null);
      return;
    }
    try {
      setRevs(await api.noteRevisions(current.id, room));
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const restore = async (r: NoteRevision) => {
    if (!current) return;
    if (
      !window.confirm(
        `把正文退回「${when(r.savedAt)}」那一版？现在这一版也会被留成历史。`,
      )
    )
      return;
    try {
      const n = await api.restoreNote(current.id, r.seq, room);
      if (n) {
        loading.current = true;
        setTitle(n.title);
        setBody(n.body);
        setTagsText(n.tags.join("、"));
        setCurrent(n);
        setDirty(false);
      }
      setRevs(await api.noteRevisions(current.id, room));
      void refresh(q.trim());
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  return (
    <div className="nm-page">
      {/* 顶栏：衬线标题 + 返回 + 新建。写东西的地方，头顶要干净 */}
      <header className="nm-top">
        <button
          className="icon-btn"
          title="返回对话"
          onClick={() => onNav("chat")}
        >
          <Icon name="arrow-left" size={17} />
        </button>
        <h1 className="nm-top-title">笔记本</h1>
        <button
          className="icon-btn"
          title="写新的一篇"
          onClick={() => void create()}
        >
          <Icon name="plus" size={17} />
        </button>
      </header>

      <div className="nm-cols">
        <aside className="nm-side">
          <div className="nm-search">
            <Icon name="search" size={14} />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="搜标题或正文"
              aria-label="搜索笔记"
            />
            {q && (
              <button
                className="nm-search-clear"
                title="清空"
                onClick={() => setQ("")}
              >
                ×
              </button>
            )}
          </div>

          <nav className="nm-list">
            {!list.length && (
              <p className="nm-empty">
                {q.trim()
                  ? `没找到和「${q.trim()}」有关的笔记`
                  : "本子还空着，点右上角写第一篇"}
              </p>
            )}
            {list.map((n) => (
              <button
                key={n.id}
                className={`nm-note ${n.id === current?.id ? "on" : ""}`}
                onClick={() => void open(n.id)}
              >
                <span className="nm-note-top">
                  {n.pinned && <Icon name="bookmark" size={12} />}
                  <span className="nm-note-title">{n.title}</span>
                </span>
                {n.preview && (
                  <span className="nm-note-preview">{n.preview}</span>
                )}
                <span className="nm-note-meta">
                  {n.updatedBy === "assistant" ? "ericher 改的" : "你改的"} ·{" "}
                  {when(n.updated)}
                </span>
                {!!n.tags.length && (
                  <span className="nm-note-tags">
                    {n.tags.map((t) => (
                      <span className="nm-note-tag" key={t}>
                        {t}
                      </span>
                    ))}
                  </span>
                )}
              </button>
            ))}
          </nav>

          <div className="nm-foot">
            共 {list.length} 篇 · 他也能看到你翻着哪一篇
          </div>
        </aside>

        <main className="nm-main">
          {!current ? (
            <div className="nm-blank">
              <p>本子还空着。</p>
              <button className="btn btn-primary" onClick={() => void create()}>
                写第一篇
              </button>
            </div>
          ) : (
            <div className="nm-editor">
              <input
                ref={titleRef}
                className="nm-title-input"
                value={title}
                placeholder="这一篇叫什么"
                onChange={(e) => setTitle(e.target.value)}
              />
              <div className="nm-head">
                <span className={`nm-save ${dirty ? "dirty" : ""}`}>
                  {saving ? "保存中…" : dirty ? "未保存" : "已保存"}
                </span>
                <button
                  className="chip"
                  onClick={() => setPreview((v) => !v)}
                  title="看看它在 Markdown 里长什么样"
                >
                  <Icon name={preview ? "edit" : "book-open"} size={14} />
                  <span>{preview ? "接着写" : "预览"}</span>
                </button>
                <button
                  className={`chip ${current.pinned ? "on" : ""}`}
                  onClick={() => void togglePin()}
                  title="钉在最上面"
                >
                  <Icon name="bookmark" size={14} />
                </button>
                <button
                  className={`chip ${revs ? "on" : ""}`}
                  onClick={() => void openRevs()}
                  title="以前的版本"
                >
                  <Icon name="clock" size={14} />
                  <span>历史</span>
                </button>
                <button
                  className="chip danger"
                  onClick={() => void remove(current)}
                  title="删掉这一篇"
                >
                  <Icon name="trash" size={14} />
                </button>
              </div>

              <div className="nm-tag-row">
                <Icon name="bookmark" size={13} />
                <input
                  className="nm-tag-input"
                  value={tagsText}
                  placeholder="标签，逗号分隔（比如：项目、写作、待整理）"
                  onChange={(e) => setTagsText(e.target.value)}
                  aria-label="标签"
                />
              </div>

              {err && <p className="nm-err">{err}</p>}

              {revs ? (
                <div className="nm-revs">
                  <div className="nm-revs-head">
                    <b>以前的版本</b>
                    <span>
                      ericher 改写之前的样子都在这里 —— 退错了还能再退回来
                    </span>
                  </div>
                  {!revs.length && (
                    <p className="nm-empty">
                      还没有历史版本：这一篇从写下到现在没被改过。
                    </p>
                  )}
                  {revs.map((r) => (
                    <div className="nm-rev" key={r.seq}>
                      <div className="nm-rev-meta">
                        <b>{r.title || "（没标题）"}</b>
                        <span>
                          {when(r.savedAt)} ·{" "}
                          {r.by === "assistant" ? "ericher 改前" : "你改前"} ·{" "}
                          {r.body.length} 字
                        </span>
                      </div>
                      <p className="nm-rev-peek">
                        {r.body.slice(0, 160) || "（空）"}
                      </p>
                      <button className="chip" onClick={() => void restore(r)}>
                        退回到这一版
                      </button>
                    </div>
                  ))}
                </div>
              ) : preview ? (
                <div className="nm-body-wrap">
                  <NotePreview text={body} />
                </div>
              ) : (
                <div className="nm-body-wrap">
                  <textarea
                    className="nm-body"
                    value={body}
                    placeholder="写吧。Markdown 直接写，标题、列表、代码块都认。&#10;&#10;ericher 看得到你在翻哪一篇 —— 想让他整理，回对话里说一句「帮我理一下这篇」就行。"
                    onChange={(e) => setBody(e.target.value)}
                  />
                </div>
              )}
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
