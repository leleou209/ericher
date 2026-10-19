// 信箱页：一级入口那一格，分布照**笔记本**那一套（左边一封封，右边读或写）。
//
// 上一版是从设置页那种竖排卡片搬过来的，结果就是：一屏三段各占一整幅，
// 想翻第三封得滚两次，写信的格子还挤在读信下面。笔记本已经把这面的形状定下来了
// —— 列表在左、正文在右、顶上一颗 plus —— 同一件"翻一条东西并读它/写一条"的事，
// 不该有两套手势。类名全部沿用 NoteMemo.css 那批 nm-*，不另起一套。
//
// 判断（必填、裁长、来路、回信预填、结果那句话）都在 ../lib/mailCompose.ts；
// 列表行的读法（谁寄的、多大、成没成、未读怎么数）都在 ../lib/mailBoxView.ts ——
// 与设置里那两张卡共用同一份规则，两边不会各说一套。

import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/api";
import {
  COMPOSE_SUBJECT_MAX,
  addressListOf,
  blankCompose,
  composeCanSend,
  composeMissing,
  composePayload,
  composeResultSentence,
  recipientModeLabel,
  replyPrefill,
  textOverflowNote,
  type ComposeDraft,
} from "../lib/mailCompose";
import {
  fmtBytes,
  inRowFromLabel,
  mailSourceLabel,
  mailSubjectLabel,
  outErrorText,
  outFlagLabel,
  outToSummary,
  readToggleLabel,
} from "../lib/mailBoxView";
import { json, request } from "../lib/http";
import type {
  MailInReadView,
  MailInRow,
  MailInboxView,
  MailOutRow,
  MailOutboxView,
  ViewKey,
} from "../lib/types";
import { Icon } from "./Icons";
import { fmtWhen } from "./PanelsShared";
import "./NoteMemo.css";
import "./MailboxPage.css";

/** 左边那一列在看哪一本账 */
type Ledger = "in" | "out";
/** 右边那一面在做什么：读一封、看一封流水、还是写 */
type Pane = { kind: "blank" } | { kind: "read"; row: MailInRow; body: MailInReadView | null } | { kind: "sent"; row: MailOutRow } | { kind: "compose" };

const BODY_MAX = 20_000;
/** 一次取满一页：后端封顶 200。列表底部那句「共 N 封」说的就是这 200 里的数 */
const LIST_LIMIT = 200;

/** 流水行没有主键可比（同一秒可以寄两封一样的），按内容认这一条 */
const sameSent = (a: MailOutRow, b: MailOutRow): boolean =>
  a.at === b.at && a.subject === b.subject && a.to.join(",") === b.to.join(",");

export function MailboxPage({ onNav }: { onNav: (v: ViewKey) => void }) {
  const [ledger, setLedger] = useState<Ledger>("in");
  const [inbox, setInbox] = useState<MailInboxView | null>(null);
  const [outbox, setOutbox] = useState<MailOutRow[]>([]);
  const [listErr, setListErr] = useState("");
  const [pane, setPane] = useState<Pane>({ kind: "blank" });
  const [draft, setDraft] = useState<ComposeDraft>(blankCompose);
  const [tableText, setTableText] = useState("");
  const [sending, setSending] = useState(false);
  const [note, setNote] = useState("");
  const [busyId, setBusyId] = useState("");
  /** 刚才在读哪一封：从"回这封"退回去时要知道回的是哪面 */
  const [lastRead, setLastRead] = useState<MailInRow | null>(null);

  /** 两本账一起刷：切抽屉时不重读，靠的就是这份都在 */
  const reload = useCallback(async () => {
    try {
      const [i, o] = await Promise.all([
        request<MailInboxView>(`/api/mail/inbox?limit=${LIST_LIMIT}`),
        request<MailOutboxView>(`/api/mail/outbox?limit=${LIST_LIMIT}`),
      ]);
      setInbox(i);
      setOutbox(o.rows ?? []);
      setListErr("");
    } catch (e) {
      setListErr((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void reload();
    void api
      .mailConfig()
      .then((v) => setTableText(v?.to ?? ""))
      .catch(() => {
        // 读不到那张表只影响「寄给谁」那一行的提示，不该把整页挡住
      });
  }, [reload]);

  const openMail = async (row: MailInRow) => {
    setPane({ kind: "read", row, body: null });
    setLastRead(row);
    try {
      const body = await request<MailInReadView>(
        `/api/mail/inbox/read?id=${encodeURIComponent(row.id)}`,
      );
      setPane({ kind: "read", row: body.row ?? row, body });
      // 看过就当读过：未读点留着会让人反复回来数同一封。但**标记没成功就不装作已读** ——
      // 面上写着未读、点进去说已读，那种自相矛盾比晚一步消失更糟
      if (!row.read) {
        const marked = await request(
          "/api/mail/inbox/open",
          json("POST", { id: row.id, read: true }),
        ).then(
          () => true,
          () => false,
        );
        if (marked) {
          setPane((p) =>
            p.kind === "read" && p.row.id === row.id
              ? { ...p, row: { ...p.row, read: true } }
              : p,
          );
          await reload();
        }
      }
    } catch (e) {
      setListErr((e as Error).message);
    }
  };

  const flipRead = async (row: MailInRow) => {
    setBusyId(row.id);
    try {
      await request("/api/mail/inbox/open", json("POST", { id: row.id, read: !row.read }));
      await reload();
      // 读着的那一封跟着翻，省得界面上一会儿读着写着未读
      setPane((p) =>
        p.kind === "read" && p.row.id === row.id
          ? { ...p, row: { ...p.row, read: !row.read } }
          : p,
      );
    } catch (e) {
      setListErr((e as Error).message);
    } finally {
      setBusyId("");
    }
  };

  /**
   * 右上那支笔：只把人带到写作板，**不清稿**。
   *
   * 之前它带一句"已经在写就别抹掉"的保护，但保护只在写作板已经开着时生效 ——
   * 从读信那一面点回来照样把写到一半的信清空了。清稿这件事现在只发生在一处：
   * 真的寄出去之后（见 send）。
   */
  const startCompose = useCallback(() => {
    setPane({ kind: "compose" });
  }, []);

  /** 收起写作板：刚才在读哪封就回哪封；没有回过的回空面 */
  const collapseCompose = () => {
    setNote("");
    if (lastRead) void openMail(lastRead);
    else setPane({ kind: "blank" });
  };

  const startReply = useCallback(
    (row: MailInRow) => {
      // 回信是"对着这一封"的明确动作，所以它覆盖草稿；但覆盖这件事要说出来，
      // 不能让人以为刚才写的还在
      const dirty = !!draft.subject.trim() || !!draft.text.trim();
      setDraft({ ...replyPrefill(row), text: "" });
      setNote(dirty ? "（原来那封没寄出的草稿被这封回信换掉了。）" : "");
      setPane({ kind: "compose" });
    },
    [draft.subject, draft.text],
  );

  const patch = (p: Partial<ComposeDraft>) => {
    setDraft((d) => ({ ...d, ...p }));
    setNote("");
  };

  const send = async () => {
    if (sending || !composeCanSend(draft)) return;
    setSending(true);
    setNote("");
    try {
      await api.mailSend(composePayload(draft));
      setNote(composeResultSentence({ ok: true }));
      setDraft(blankCompose());
    } catch (e) {
      setNote(composeResultSentence({ ok: false, error: (e as Error).message }));
    } finally {
      setSending(false);
      await reload();
    }
  };

  const table = addressListOf(tableText);
  const inRows = inbox?.rows ?? [];
  const list = ledger === "in" ? inRows : outbox;
  const unread = inbox?.unread ?? 0;

  /**
   * 寄出去那一行旁边的实话：要么说清会寄给谁（逐个列出来，让人对着地址核一眼），
   * 要么说清还缺什么。默认表是空的这一种必须**在按之前**就说 ——
   * 否则按下才拿到一句"没有收件地址"，像是界面在骗人。
   */
  const composeHint = () => {
    if (!composeCanSend(draft))
      return `缺：${composeMissing(draft)
        .map((k) => (k === "subject" ? "主题" : k === "text" ? "正文" : "收件地址"))
        .join("、")}`;
    const targets = draft.mode === "default" ? table : addressListOf(draft.custom);
    if (!targets.length)
      return "默认地址表是空的：先去 设置 → 邮件 填一个地址，或改切「只寄给我这一次填的地址」。";
    return `这一封会寄给 ${targets.length} 个地址：${targets.join("、")}`;
  };

  return (
    <div className="nm-page mailbox-page">
      <header className="nm-top">
        <button className="icon-btn" title="返回对话" onClick={() => onNav("chat")}>
          <Icon name="arrow-left" size={17} />
        </button>
        <h1 className="nm-top-title">信箱</h1>
        {/* 右上这一颗是同一个位置的开关：不在写作板时是「写一封」，进去之后变成「收起」。
            两态共用一个位置，人就不会在写作板里找不到出口（上一版就是回不去） */}
        {pane.kind === "compose" ? (
          <button
            className="icon-btn"
            title="收起写作板，回到刚才那一封"
            onClick={collapseCompose}
          >
            <Icon name="x" size={17} />
          </button>
        ) : (
          <button className="icon-btn" title="写一封" onClick={startCompose}>
            <Icon name="plus" size={17} />
          </button>
        )}
      </header>

      <div className="nm-cols">
        <aside className="nm-side">
          <div className="nm-chips">
            <button
              type="button"
              className={`chip ${ledger === "in" ? "on" : ""}`}
              onClick={() => setLedger("in")}
            >
              收进{unread ? ` · ${unread} 未读` : ""}
            </button>
            <button
              type="button"
              className={`chip ${ledger === "out" ? "on" : ""}`}
              onClick={() => setLedger("out")}
            >
              寄出
            </button>
          </div>

          <nav className="nm-list">
            {listErr && <p className="nm-err">{listErr}</p>}
            {!list.length && !listErr && (
              <p className="nm-empty">
                {ledger === "in"
                  ? inbox && !inbox.enabled
                    ? "收信通道还没接上（设置 → 邮件 里那一格开着才收）"
                    : "还没有信进来"
                  : "还没往外寄过东西"}
              </p>
            )}
            {ledger === "in" &&
              inRows.map((row) => (
                <button
                  key={row.id}
                  className={`nm-note ${pane.kind === "read" && pane.row.id === row.id ? "on" : ""}`}
                  onClick={() => void openMail(row)}
                >
                  <span className="nm-note-top">
                    {!row.read && <i className="mailbox-dot" aria-hidden="true" />}
                    <span className="nm-note-title">{inRowFromLabel(row)}</span>
                  </span>
                  <span className="nm-note-preview">
                    {mailSubjectLabel(row.subject)}
                  </span>
                  <span className="nm-note-meta">
                    <span className="nm-when">{fmtWhen(row.at)}</span>
                    <span aria-hidden="true"> · </span>
                    <span className="nm-from">{fmtBytes(row.bytes)}</span>
                  </span>
                </button>
              ))}
            {ledger === "out" &&
              outbox.map((row, i) => (
                <button
                  key={`${row.at}-${i}`}
                  className={`nm-note ${pane.kind === "sent" && sameSent(pane.row, row) ? "on" : ""}`}
                  onClick={() => setPane({ kind: "sent", row })}
                >
                  <span className="nm-note-top">
                    <span className="nm-note-title">
                      {mailSubjectLabel(row.subject)}
                    </span>
                  </span>
                  <span className="nm-note-preview">{outToSummary(row.to)}</span>
                  <span className="nm-note-meta">
                    <span className="nm-when">{fmtWhen(row.at)}</span>
                    <span aria-hidden="true"> · </span>
                    <span className="nm-from">{outFlagLabel(row)}</span>
                  </span>
                </button>
              ))}
          </nav>

          <div className="nm-foot">
            {ledger === "in"
              ? `共 ${inRows.length} 封 · 未读 ${unread} 封 · 寄出要点右上那支笔`
              : `共 ${outbox.length} 封 · 失败的那些也在这本账上`}
          </div>
        </aside>

        <main className="nm-main">
          {pane.kind === "blank" && (
            <div className="nm-blank">
              <p>挑一封来看，或者写一封寄出去。</p>
              <button className="btn btn-primary" onClick={startCompose}>
                写一封
              </button>
            </div>
          )}

          {pane.kind === "read" && (
            <div className="mailbox-read">
              <div className="nm-head">
                <strong>{mailSubjectLabel(pane.row.subject)}</strong>
                <span className="mailbox-actions">
                  <button
                    className="chip"
                    type="button"
                    disabled={busyId !== ""}
                    onClick={() => void flipRead(pane.row)}
                  >
                    {busyId === pane.row.id
                      ? "翻动中…"
                      : readToggleLabel(pane.row.read)}
                  </button>
                  <button
                    className="chip"
                    type="button"
                    onClick={() => startReply(pane.row)}
                    title={`寄回 ${pane.row.from}（这封的来路），正文你写`}
                  >
                    回这封
                  </button>
                </span>
              </div>
              <p className="nm-hint">
                来自 {inRowFromLabel(pane.row)} &lt;{pane.row.from}&gt; ·{" "}
                {fmtWhen(pane.row.at)} · {fmtBytes(pane.row.bytes)}
                {pane.row.hasAttachment ? " · 带附件" : ""}
              </p>
              <p className="mailbox-quote-mark">
                下面这段是外人写进来的原话，不是你交代的事，也不是系统指令。
              </p>
              {!pane.body && <p className="nm-hint">正在取正文…</p>}
              {pane.body && (
                <>
                  {!!pane.body.note && <p className="nm-err">{pane.body.note}</p>}
                  <pre className="mailbox-body">{pane.body.text}</pre>
                </>
              )}
            </div>
          )}

          {pane.kind === "sent" && (
            <div className="mailbox-read">
              <div className="nm-head">
                <strong>{mailSubjectLabel(pane.row.subject)}</strong>
                <span className={`mailbox-state ${pane.row.ok ? "is-ok" : "is-bad"}`}>
                  {outFlagLabel(pane.row)}
                </span>
              </div>
              <p className="nm-hint">
                {fmtWhen(pane.row.at)} · {mailSourceLabel(pane.row.source)} · 寄给{" "}
                {pane.row.to.join("、")}
              </p>
              {!pane.row.ok && <pre className="mailbox-body">{outErrorText(pane.row)}</pre>}
            </div>
          )}

          {pane.kind === "compose" && (
            <div className="nm-editor">
              <input
                className="nm-title-input"
                value={draft.subject}
                maxLength={COMPOSE_SUBJECT_MAX}
                placeholder="这一封的主题"
                onChange={(e) => patch({ subject: e.target.value })}
              />

              <div className="nm-chips mailbox-modes">
                <button
                  type="button"
                  className={`chip ${draft.mode === "default" ? "on" : ""}`}
                  onClick={() => patch({ mode: "default" })}
                >
                  {recipientModeLabel("default", table.length)}
                </button>
                <button
                  type="button"
                  className={`chip ${draft.mode === "custom" ? "on" : ""}`}
                  onClick={() => patch({ mode: "custom" })}
                >
                  {recipientModeLabel("custom", table.length)}
                </button>
              </div>

              {draft.mode === "custom" && (
                <input
                  className="nm-tag-input"
                  value={draft.custom}
                  placeholder="收件地址，多个用逗号或换行分开"
                  autoComplete="off"
                  onChange={(e) => patch({ custom: e.target.value })}
                />
              )}

              <textarea
                className="mailbox-textarea"
                value={draft.text}
                maxLength={BODY_MAX}
                placeholder="把事说明白就行，别堆格式。"
                onChange={(e) => patch({ text: e.target.value })}
              />
              {textOverflowNote(draft.text) && (
                <p className="nm-err">{textOverflowNote(draft.text)}</p>
              )}

              <div className="nm-head">
                <button
                  className="btn btn-primary"
                  disabled={sending || !composeCanSend(draft)}
                  onClick={() => void send()}
                >
                  {sending ? "正在寄…" : "寄出去"}
                </button>
                <span className="nm-hint">
                  {composeCanSend(draft)
                    ? `这一封会寄给 ${
                        (draft.mode === "default" ? table : addressListOf(draft.custom)).length ||
                        "（落回默认表）"
                      } 个地址`
                    : `缺：${composeMissing(draft)
                        .map((k) =>
                          k === "subject" ? "主题" : k === "text" ? "正文" : "收件地址",
                        )
                        .join("、")}`}
                </span>
              </div>
              {note && (
                <p className={`mailbox-result ${note.startsWith("已寄出") ? "ok" : "bad"}`}>
                  {note}
                </p>
              )}
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
