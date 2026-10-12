// 聊天界面左边的笔记本抽屉。
//
// 为什么要有它，而不只是那个独立的撰写页：写东西和跟他说话是交替发生的 ——
// 「帮我理一下这篇」这句话是在对话里说的，本子得能在同一屏里翻得到。
// 让人为了看一眼笔记切走整个页面、再切回来，就是把一件事拆成两件。
//
// 和撰写页的分工：这里是随手翻、随手改两句；整篇重写和版本回溯在撰写页里（那边地方大）。

import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import type { Note, NoteMeta } from "../lib/types";
import { Icon } from "./Icons";
import { NotePreview } from "./NotePage";
import "./NoteMemo.css";

const SAVE_DEBOUNCE_MS = 1200;

function when(iso: string): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "";
  const m = Math.floor((Date.now() - t) / 60000);
  if (m < 1) return "刚动过";
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  return `${Math.floor(h / 24)} 天前`;
}

export function NoteDrawer({
  open,
  onClose,
  room,
  focusId,
}: {
  open: boolean;
  onClose: () => void;
  /** 本子跟着场走：连在哪间场屋上，读写的就是哪一间的笔记本 */
  room: string;
  /** 后端记着的「他正在看哪一篇」，列表里标出来 */
  focusId: string;
}) {
  const [list, setList] = useState<NoteMeta[]>([]);
  const [q, setQ] = useState("");
  const [cur, setCur] = useState<Note | null>(null);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [dirty, setDirty] = useState(false);
  const [preview, setPreview] = useState(false);
  const [err, setErr] = useState("");
  /** 载入一篇时不算「他改过」：否则抽屉一打开就会自动存一遍 */
  const loading = useRef(true);
  // 最新输入的镜像：保存响应回来时要对着它判断「这一轮发出去之后人有没有又敲字」，
  // 光读闭包只能拿到发起保存那一刻的旧值
  const latest = useRef({ title: "", body: "" });
  latest.current = { title, body };
  // 打开一篇的请求定序：快速连点两篇，先点的那篇慢回来会把新打开的盖掉 ——
  // 人接着写，字就落进另一篇里了。过期响应直接作废
  const openSeq = useRef(0);

  // 只在拉开的时候取列表：抽屉常年挂着（动画要它），但没必要一直问后端。
  // 换了一场也重取：本子跟着场走，这场是这场的那本
  useEffect(() => {
    if (!open) return;
    void (async () => {
      try {
        setList(await api.notes(undefined, undefined, room));
        setErr("");
      } catch (e) {
        setErr((e as Error).message);
      }
    })();
  }, [open, room]);

  useEffect(() => {
    if (!open) return;
    const t = window.setTimeout(() => {
      void (async () => {
        try {
          setList(await api.notes(q.trim() || undefined, undefined, room));
        } catch {
          /* 搜索失败不该弹东西：列表停在上一份就好 */
        }
      })();
    }, 260);
    return () => window.clearTimeout(t);
  }, [q, open, room]);

  // 换了一场，翻到一半的那篇收回去 —— 它是上一场的本子上的，
  // 留着的话自动保存会把它存进新一场的本子里（按 id 在那边另立一篇）
  useEffect(() => {
    setCur(null);
  }, [room]);

  useEffect(() => {
    if (loading.current) {
      loading.current = false;
      return;
    }
    setDirty(true);
  }, [title, body]);

  const openNote = async (id: string) => {
    const seq = ++openSeq.current;
    try {
      const n = await api.readNote(id, room);
      // 过期响应：丢弃 —— 别把后点开的那篇刚铺好的稿子又盖回旧的
      if (!n || seq !== openSeq.current) return;
      loading.current = true;
      setCur(n);
      setTitle(n.title);
      setBody(n.body);
      setDirty(false);
      setPreview(false);
      setErr("");
      // 拉开哪一篇就上报哪一篇：他下一轮才知道你说的「这篇」是哪篇
      void api.focusNote(id, room).catch(() => {});
    } catch (e) {
      if (seq !== openSeq.current) return;
      setErr((e as Error).message);
    }
  };

  useEffect(() => {
    if (!cur || !dirty) return;
    const t = window.setTimeout(() => {
      void (async () => {
        try {
          // 快照这一轮存的是什么。请求在途时人还在打字 —— 响应回来若内容已经变了，
          // 就不能 setDirty(false)：一熄，本 effect 的 cleanup 会把刚排上的新定时器
          // 清掉，后敲的这段永远落不了库，界面却显示「已保存」
          const snap = { title, body };
          const n = await api.saveNote(
            {
              id: cur.id,
              title: title.trim() || undefined,
              body,
            },
            room,
          );
          setCur(n);
          const now = latest.current;
          if (now.title === snap.title && now.body === snap.body)
            setDirty(false);
        } catch (e) {
          setErr((e as Error).message);
        }
      })();
    }, SAVE_DEBOUNCE_MS);
    return () => window.clearTimeout(t);
  }, [cur, dirty, title, body, room]);

  const create = async () => {
    try {
      const n = await api.saveNote({ title: "新的笔记", body: "" }, room);
      setList(await api.notes(undefined, undefined, room));
      await openNote(n.id);
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  return (
    <aside
      className={`drawer-left note-drawer ${open ? "open" : ""}`}
      aria-hidden={!open}
    >
      <div className="nm-drawer-head">
        <h1 className="nm-drawer-title">笔记本</h1>
        <button
          className="icon-btn"
          title="写新的一篇"
          onClick={() => void create()}
        >
          <Icon name="plus" size={17} />
        </button>
        <button className="icon-btn" title="收起" onClick={onClose}>
          <Icon name="x" size={17} />
        </button>
      </div>

      <p className="nm-hint">
        <Icon name="eye" size={13} />
        你翻着哪一篇，ericher 看得到 —— 回对话里说「帮我理一下这篇」就行。
      </p>

      {cur ? (
        <div className="nm-drawer-editor">
          <div className="nm-drawer-editor-top">
            <button
              className="icon-btn"
              title="回到列表"
              onClick={() => setCur(null)}
            >
              <Icon name="arrow-left" size={16} />
            </button>
            <span className={`nm-save ${dirty ? "dirty" : ""}`}>
              {dirty ? "未保存" : "已保存"}
            </span>
            <button
              className="chip"
              onClick={() => setPreview((v) => !v)}
              title="看看 Markdown 长什么样"
            >
              <Icon name={preview ? "edit" : "book-open"} size={14} />
              <span>{preview ? "接着写" : "预览"}</span>
            </button>
          </div>
          <input
            className="nm-title-input"
            value={title}
            placeholder="这一篇叫什么"
            onChange={(e) => setTitle(e.target.value)}
          />
          {preview ? (
            <div className="nm-body-wrap">
              <NotePreview text={body} />
            </div>
          ) : (
            <textarea
              className="nm-body"
              value={body}
              placeholder="写吧，Markdown 直接写。"
              onChange={(e) => setBody(e.target.value)}
            />
          )}
        </div>
      ) : (
        <>
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
                {q.trim() ? "没找到对得上的" : "本子还空着，点右上角写第一篇"}
              </p>
            )}
            {list.map((n) => (
              <button
                key={n.id}
                className={`nm-note ${n.id === focusId ? "on" : ""}`}
                onClick={() => void openNote(n.id)}
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
              </button>
            ))}
          </nav>
        </>
      )}

      {err && <p className="nm-err">{err}</p>}
    </aside>
  );
}
