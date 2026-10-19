// 发件流水与收件箱：两块只读列表 + 详情弹页（接待台 → 设置 → 寄信 → 邮件）。
//
// 为什么单独一个文件：MailPanel.tsx 只管「那一份配置」，而这里两块面各读各的接口
// （/api/mail/outbox、/api/mail/inbox），混在一起会让一个开关的保存动作顺手把
// 两面的状态搅浑。FormDialog.tsx 是共享样板，只读不改。
//
// 口径全部外提在 ../lib/mailBoxView.ts（那边是不碰 React 的纯函数，node 环境测得住）：
// 这里只接线 —— 读视图、格式化时刻、按行渲染、按下弹页里的按钮才提交。
//
// 为什么不挂到 ../lib/api.ts：那一档是多个面板共用的文件，这一轮不许我改。
// 传输直接用 ../lib/http 的 request()/json() —— 它已经把「HTTP 200 但 ok:false」
// 也抛成 ApiError，所以 promise 落定就是真成功；落 catch 的原话一律显示，不关窗、
// 不做乐观更新（本项目硬规矩）。
//
// 正文一律走 <pre> 的文本子节点：外面寄进来的东西一个字都不许当 HTML 注入。

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
 * 收件面自己攥着的那份状态。和契约（MailInboxView）差一格：
 * `unread` 允许 null = 后端这次没回这个数（老后端 / 字段坏了），
 * 交给 unreadReadOf 落回「按清单数」并说明那是兜底。
 */
interface InboxFace {
  rows: MailInRow[];
  unread: number | null;
  enabled: boolean;
}

/**
 * 读失败那一块：出口走 LoadingBoundary 的 resourceErrorActions ——
 * 我们有 load() 可以就地重试，就不该让人刷新整个页面（弱网下那等于重下一遍）。
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
 * 发件流水：每一封寄出去过的（成的、败的都在）一行一个，点开是只读详情。
 * 面上没有任何输入条 —— 这一面本来也没什么可写的。
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
 *
 * 面上必须把两件事分开说：「收信通道还没接」（开关关着）与「通道通了但没信」
 * ——混成一句「收件箱是空的」，人就会去折腾明明配对了的地址。
 * 常显的那颗小控件只翻已读/未读，这是这一面唯一可写的动作 —— 写信与回信都在
 * 一级入口那页（MailboxPage.tsx，照笔记本的分布），这里不另开一套手势。
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
   * 点开一行才去取正文；读一封可能把未读账改了，所以回头重读清单。
   *
   * 弱网下这一下可能很慢，所以弹页不设 busy：人随时关得掉。关掉之后晚到的回包要丢掉 ——
   * 拿 reqRef 记住「这个窗现在是为哪一封开的」，那一笔就不许再改界面。
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
