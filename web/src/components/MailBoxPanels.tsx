// 发件流水与收件箱：两块只读列表 + 详情弹页（设置 → 邮件）。
// 读法与措辞全在 ../lib/mailBoxView.ts 的纯函数里（node 可测），这里只接线。
// 传输走 ../lib/http：HTTP 200 里的 ok:false 也抛成 ApiError，落定即真成功；
// 失败原话照显、不关窗、不做乐观更新。正文一律走 <pre> 文本节点，绝不注入 HTML。

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { json, request } from "../lib/http";
import {
  fmtBytes,
  inDetailSummary,
  inRowFromAddr,
  inRowFromLabel,
  inRowSummary,
  inboxFaceNote,
  inboxUnreadLabel,
  mailSourceNote,
  mailSubjectLabel,
  markerSentences,
  outErrorText,
  outFlagLabel,
  outFlagSentence,
  outRecipients,
  outRowSummary,
  outToSummary,
  outboxFaceNote,
  readBodyOf,
  readMarkersOf,
  readToggleLabel,
  readToggleTitle,
  rowsNewestFirst,
  unreadReadOf,
} from "../lib/mailBoxView";
import type {
  MailInRow,
  MailInboxView,
  MailInOpenReceipt,
  MailInReadView,
  MailOutRow,
  MailOutboxView,
} from "../lib/types";
import { resourceErrorActions } from "./LoadingBoundary";
import { Icon } from "./Icons";
import {
  EntityNote,
  EntityRow,
  FormDialog,
  FormSection,
} from "./FormDialog";
import { fmtWhen } from "./PanelsShared";
import "./MailBoxPanels.css";

/**
 * 收件面自己攥着的状态。与 MailInboxView 差一格：unread 允许 null（后端没回），
 * 由 unreadReadOf 落回「按清单数」并说明那是兜底。
 */
interface InboxFace {
  rows: MailInRow[];
  unread: number | null;
  enabled: boolean;
}

/**
 * 读失败那一块：走 LoadingBoundary 的 resourceErrorActions ——
 * 有 load() 就地重试，别让人刷新整页（弱网下等于重下一遍）。
 */
function LoadError({ error, onRetry }: { error: string; onRetry: () => void }) {
  const actions = resourceErrorActions(onRetry);
  return (
    <div className="mailbox-error" role="alert">
      <p className="err">{error}</p>
      <p className="dim">{actions.hint}</p>
      <button className="btn btn-ghost btn-sm" type="button" onClick={onRetry}>
        {actions.label}
      </button>
    </div>
  );
}

/** 面头上那一行：标题 + 计数 + 就地刷新 */
function MailBoxHead({
  title,
  count,
  unit,
  onRefresh,
  busy,
  children,
}: {
  title: string;
  count: number;
  unit: string;
  onRefresh: () => void;
  busy: boolean;
  /** 开关状态、未读数这类常驻事实 */
  children?: ReactNode;
}) {
  return (
    <div className="mailbox-head">
      <h3 className="sect mailbox-title">
        {title}（{count}
        {unit}）
      </h3>
      {children}
      <button
        className="btn btn-ghost btn-sm mailbox-refresh"
        type="button"
        onClick={onRefresh}
        disabled={busy}
        title="重新拉一次清单"
      >
        <Icon name="refresh" size={14} />
        {busy ? "读取中…" : "刷新"}
      </button>
    </div>
  );
}

// ── 发件箱 ─────────────────────────────────────────

/**
 * 发件流水：每一封寄出去过的（成、败都在）一行一个，点开是只读详情。
 */
export function MailOutboxPanel() {
  const [rows, setRows] = useState<MailOutRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  // 存的是清单里那个对象本身：行与弹页比的是引用，不用给流水编 id
  const [detail, setDetail] = useState<MailOutRow | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const v = await request<MailOutboxView>("/api/mail/outbox");
      setRows(rowsNewestFirst(Array.isArray(v?.rows) ? v.rows : []));
      setErr("");
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const faceNote = outboxFaceNote(rows);

  return (
    <div className="panel-body">
      <MailBoxHead
        title="发件箱"
        count={rows.length}
        unit=" 封"
        onRefresh={() => void load()}
        busy={loading}
      />
      <p className="meta">
        寄出去过的每一封都在这里：谁要寄的、寄给谁、成没成。行只读，点开的详情也是只读 ——
        要寄新的，去上面的发信账号里按「发一封测试邮件」。
      </p>

      {loading && !rows.length && <p className="empty-sm">读取中…</p>}
      {err && <LoadError error={err} onRetry={() => void load()} />}

      {!!rows.length && (
        <div className="entity-list">
          {rows.map((row, i) => (
            <EntityRow
              key={`${row.at}-${i}`}
              title={mailSubjectLabel(row.subject)}
              summary={outRowSummary(row, fmtWhen(row.at))}
              editing={detail === row}
              onEdit={() => setDetail(row)}
              right={
                <span
                  className={"mailbox-flag" + (row.ok ? "" : " is-bad")}
                  title={row.ok ? "这一封服务商应了" : "这一封没寄出去，点开看原因原文"}
                >
                  {outFlagLabel(row)}
                </span>
              }
            />
          ))}
        </div>
      )}
      {!loading && !err && faceNote && <p className="empty-sm">{faceNote}</p>}

      {detail && (
        <FormDialog
          wide
          title={mailSubjectLabel(detail.subject)}
          subtitle={`${fmtWhen(detail.at) || "时刻没记上"} · ${outFlagLabel(detail)} · ${outToSummary(detail.to)}`}
          onClose={() => setDetail(null)}
        >
          <FormSection title="这一封">
            <EntityNote>{outFlagSentence(detail)}</EntityNote>
            <EntityNote>{mailSourceNote(detail.source)}</EntityNote>
          </FormSection>

          <FormSection title={`收件人（${outRecipients(detail).length}）`}>
            {outRecipients(detail).length ? (
              <ul className="mailbox-list">
                {outRecipients(detail).map((addr, i) => (
                  <li key={`${addr}-${i}`}>{addr}</li>
                ))}
              </ul>
            ) : (
              <EntityNote>
                后端没记上这一封寄给谁 —— 断在写收件人之前会留下这种行。
              </EntityNote>
            )}
          </FormSection>

          {!detail.ok && (
            <FormSection title="失败原因原文">
              <EntityNote>
                下面这串是服务商说的原话：界面不截短、不改写、不折行 ——
                排查时要拿的就是这串去对文档。
              </EntityNote>
              <pre className="mailbox-raw">{outErrorText(detail)}</pre>
            </FormSection>
          )}
        </FormDialog>
      )}
    </div>
  );
}

// ── 收件箱 ─────────────────────────────────────────

/**
 * 收件箱：头部在清单里，正文与原件在云盘，点开才取。
 * 必须分开说「通道还没接」与「通道通了没信」—— 混成「收件箱是空的」，
 * 人会去折腾明明配对的地址。常显控件只翻已读/未读；写信回信在一级入口页。
 */
export function MailInboxPanel() {
  const [view, setView] = useState<InboxFace | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  // 已读翻动的哪一行（同一时刻只让按一个，免得两笔 POST 抢着覆盖）
  const [busyId, setBusyId] = useState("");
  const [openId, setOpenId] = useState("");
  const [detail, setDetail] = useState<MailInReadView | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailErr, setDetailErr] = useState("");
  // 这个窗现在是为哪一封开的（晚到的回包据此丢弃）
  const reqRef = useRef("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const v = await request<MailInboxView>("/api/mail/inbox");
      setView({
        rows: Array.isArray(v?.rows) ? v.rows : [],
        // 后端没给或给坏时留 null：unreadReadOf 会落回按清单数，并说明那是兜底
        unread:
          typeof v?.unread === "number" && Number.isFinite(v.unread) && v.unread >= 0
            ? v.unread
            : null,
        enabled: !!v?.enabled,
      });
      setErr("");
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const rows = rowsNewestFirst(view?.rows ?? []);
  const enabled = !!view?.enabled;
  const reading = unreadReadOf(rows, view ? view.unread : undefined);
  const faceNote = inboxFaceNote(enabled, rows);

  /**
   * 点开一行才取正文；读一封改了未读账，所以回头重读清单。
   * 弱网下弹页不设 busy（随时关得掉）；reqRef 记住这窗为哪封开，晚到回包一律丢弃。
   */
  const openMail = async (row: MailInRow) => {
    setOpenId(row.id);
    setDetail(null);
    setDetailErr("");
    setDetailLoading(true);
    reqRef.current = row.id;
    try {
      const d = await request<MailInReadView>(
        `/api/mail/inbox/read?id=${encodeURIComponent(row.id)}`,
      );
      if (reqRef.current !== row.id) return;
      setDetail({
        row: d?.row ?? row,
        text: typeof d?.text === "string" ? d.text : "",
        note: typeof d?.note === "string" ? d.note : "",
      });
      await load();
    } catch (e) {
      // 取不到正文也留着窗：那句原话得摆在这里，不然只会看到窗「自己关了」
      if (reqRef.current === row.id) setDetailErr((e as Error).message);
    } finally {
      if (reqRef.current === row.id) setDetailLoading(false);
    }
  };

  const closeMail = () => {
    reqRef.current = "";
    setOpenId("");
    setDetail(null);
    setDetailErr("");
    setDetailLoading(false);
  };

  const setRead = async (row: MailInRow, read: boolean) => {
    if (busyId) return;
    setBusyId(row.id);
    setErr("");
    try {
      await request<MailInOpenReceipt>(
        "/api/mail/inbox/open",
        json("POST", { id: row.id, read }),
      );
      // 落库后回读：面上的未读数与那颗点是服务器那份账，不是刚按的那个值
      await load();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusyId("");
    }
  };

  const openRow = detail?.row ?? rows.find((r) => r.id === openId) ?? null;
  const markers = detail
    ? markerSentences(readMarkersOf(detail.row, detail.note))
    : [];
  const body = detail && openRow ? readBodyOf(detail.text, openRow) : null;

  return (
    <div className="panel-body">
      <MailBoxHead
        title="收件箱"
        count={rows.length}
        unit=" 封"
        onRefresh={() => void load()}
        busy={loading}
      >
        <span
          className={"mailbox-flag" + (enabled ? " is-on" : " is-warn")}
          title={
            enabled
              ? "收信落库开着：新信会出现在这张清单里"
              : "收信落库关着：这还不是「没有信」，是通道没接"
          }
        >
          {enabled ? "收信已开" : "还没接收件通道"}
        </span>
        <span className="mailbox-flag" title="后端给的全量未读账">
          {inboxUnreadLabel(enabled, reading.count)}
        </span>
      </MailBoxHead>

      {/* 两个数对不上时那句说明摊开讲，不悄悄挑一个 */}
      {reading.note && <p className="meta">{reading.note}</p>}

      {loading && !rows.length && <p className="empty-sm">读取中…</p>}
      {err && <LoadError error={err} onRetry={() => void load()} />}
      {/* 通道开没开这一句摆在清单前面：先让人知道下面那一堆是什么处境，别翻完列表才看到说明 */}
      {!loading && !err && faceNote && <p className="empty-sm">{faceNote}</p>}

      {!!rows.length && (
        <div className="entity-list">
          {rows.map((row) => (
            <EntityRow
              key={row.id}
              title={inRowFromLabel(row)}
              summary={
                <>
                  {!row.read && <i className="mailbox-dot" aria-hidden="true" />}
                  {inRowSummary(row, fmtWhen(row.at))}
                </>
              }
              editing={openId === row.id}
              onEdit={() => void openMail(row)}
              right={
                <button
                  className="chip"
                  type="button"
                  disabled={busyId !== ""}
                  onClick={() => void setRead(row, !row.read)}
                  title={readToggleTitle(row.read)}
                >
                  {busyId === row.id ? "翻动中…" : readToggleLabel(row.read)}
                </button>
              }
            />
          ))}
        </div>
      )}

      {openId && (
        <FormDialog
          wide
          title={openRow ? mailSubjectLabel(openRow.subject) : "这一封"}
          subtitle={
            openRow
              ? [
                  inRowFromLabel(openRow),
                  inRowFromAddr(openRow),
                  inDetailSummary(openRow, fmtWhen(openRow.at)),
                ]
                  .filter(Boolean)
                  .join(" · ")
              : "读取中…"
          }
          error={detailErr}
          onClose={closeMail}
        >
          {!detail && !detailErr && (
            <p className="empty-sm">正文读取中…（下面这些是清单里已经带回来的头部）</p>
          )}

          {openRow && (
            <>
              <FormSection title="这封的来路">
                <EntityNote>
                  寄自 {(openRow.from || "地址没记上").trim()}
                  {openRow.fromName.trim() ? `（自称「${openRow.fromName.trim()}」）` : ""}
                  。名字是人家的自称，当不了地址用 —— 要回信就照上面那个地址回。
                </EntityNote>
                <EntityNote>清单上说的字节是整封原始报文的大小，不是正文的字数：{fmtBytes(openRow.bytes)}。</EntityNote>
              </FormSection>

              {!!markers.length && (
                <FormSection title="这一封看不全的地方">
                  <ul className="mailbox-flags">
                    {markers.map((m, i) => (
                      <li key={i}>{m}</li>
                    ))}
                  </ul>
                </FormSection>
              )}

              {!!detail?.note.trim() && (
                <FormSection title="后端那一句说明">
                  <EntityNote>{detail.note}</EntityNote>
                </FormSection>
              )}

              <FormSection title="正文（纯文本）">
                {detail && !!body?.missing && <EntityNote>{body.missing}</EntityNote>}
                {/* 文本子节点：正文里写着 <script> 也只是一行字，永不注入 HTML */}
                <pre className="mailbox-raw">
                  {detail
                    ? body?.body || "（没有可读的正文）"
                    : detailLoading
                      ? "正文读取中…"
                      : "还没读到正文"}
                </pre>
              </FormSection>
            </>
          )}
        </FormDialog>
      )}
    </div>
  );
}
