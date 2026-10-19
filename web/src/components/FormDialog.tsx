// 设置面的「列表 + 详情弹页」原语。
//
// 为什么要它：面板里一排排裸露的输入条把「这一项现在是什么」挤没了，改哪一格都
// 看不出头绪。这里把两件事分开 —— EntityRow 只负责让人看清列表里有什么，
// FormDialog 负责一次把一项填完，按下保存才提交。
// 提交口径不变：HTTP 200 里的 ok:false 由 lib/http.ts 抛错，调用方接住显示在弹页里，
// 失败不关窗、不做乐观更新。

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Icon } from "./Icons";
import "./FormDialog.css";

/** 弹页里的一行：左标题右控件，说明文字走 hint。窄屏自动折成上下两行。 */
export function FormRow({
  label,
  hint,
  wide,
  children,
}: {
  label: string;
  hint?: ReactNode;
  wide?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={"form-row" + (wide ? " form-row-wide" : "")}>
      <div className="form-row-label">
        <span>{label}</span>
        {hint && <em className="form-row-hint">{hint}</em>}
      </div>
      <div className="form-row-field">{children}</div>
    </div>
  );
}

/** 弹页里的小节标题（基本信息 / 凭据 / 权益 这样分段） */
export function FormSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="form-section">
      <h4 className="form-section-title">{title}</h4>
      {children}
    </section>
  );
}

export function FormDialog({
  title,
  subtitle,
  children,
  onClose,
  onSave,
  saveLabel = "保存",
  busy = false,
  error = "",
  dirty = false,
  wide = false,
}: {
  title: string;
  subtitle?: ReactNode;
  children: ReactNode;
  onClose: () => void;
  /** 不给就是只读弹页：没有保存按钮，Esc 直接关 */
  onSave?: () => void;
  saveLabel?: string;
  busy?: boolean;
  error?: string;
  /** 有未保存改动时，Esc / 点遮罩 / 取消都要先问一句 */
  dirty?: boolean;
  wide?: boolean;
}) {
  const card = useRef<HTMLDivElement>(null);
  // 是谁把弹页打开的：关掉后把焦点还回去，键盘用户不必从头再 Tab 一遍
  const opener = useRef<Element | null>(null);

  useEffect(() => {
    opener.current = document.activeElement;
    const first = card.current?.querySelector<HTMLElement>(
      "input,textarea,select,button",
    );
    first?.focus();
    return () => {
      (opener.current as HTMLElement | null)?.focus?.();
    };
  }, []);

  const requestClose = useCallback(() => {
    if (busy) return;
    if (
      dirty &&
      !window.confirm("这一项还没保存，确定放弃刚才的改动吗？")
    )
      return;
    onClose();
  }, [busy, dirty, onClose]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        requestClose();
        return;
      }
      if (e.key !== "Tab" || !card.current) return;
      // 焦点陷阱：Tab 到最后一格再往下，回到第一格，别掉到弹页背后的面板里
      const items = card.current.querySelectorAll<HTMLElement>(
        'input,textarea,select,button,a[href],[tabindex]:not([tabindex="-1"])',
      );
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [requestClose]);

  return (
    <div
      className="form-dialog-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) requestClose();
      }}
    >
      <div
        ref={card}
        className={"form-dialog" + (wide ? " form-dialog-wide" : "")}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <header className="form-dialog-head">
          <h3 className="form-dialog-title">{title}</h3>
          {subtitle && <p className="form-dialog-subtitle">{subtitle}</p>}
        </header>
        <div className="form-dialog-body">{children}</div>
        {error && (
          <p className="form-dialog-error" role="alert">
            {error}
          </p>
        )}
        <footer className="form-dialog-foot">
          <button className="btn-ghost" type="button" onClick={requestClose} disabled={busy}>
            {onSave ? "取消" : "关闭"}
          </button>
          {onSave && (
            <button className="btn" type="button" onClick={onSave} disabled={busy}>
              {busy ? "保存中…" : saveLabel}
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}

/**
 * 列表里的一行：名称 + 一行摘要，右侧是常驻控件，编辑/删除悬停（或键盘聚焦）才显形。
 *
 * 名称那一块本身就是按钮：点它等于点「编辑」，所以一行只有两处可点，
 * 不会误触。删除走原生 confirm —— 和矩阵、笔记本里删东西的口径一致。
 */
export function EntityRow({
  title,
  summary,
  right,
  onEdit,
  onDelete,
  deleteConfirm,
  disabled = false,
  editing = false,
}: {
  title: string;
  summary?: ReactNode;
  /** 常驻控件（启停开关这类），不参与悬停显隐 */
  right?: ReactNode;
  onEdit?: () => void;
  onDelete?: () => void;
  deleteConfirm?: string;
  disabled?: boolean;
  /** 这一项正被弹页编辑：行底色标出来，免得对着同一项开两个窗 */
  editing?: boolean;
}) {
  return (
    <div
      className={
        "entity-row" +
        (disabled ? " entity-row-disabled" : "") +
        (editing ? " entity-row-editing" : "")
      }
    >
      <button
        type="button"
        className="entity-main"
        onClick={onEdit}
        disabled={!onEdit}
        title={onEdit ? "编辑这一项" : undefined}
      >
        <span className="entity-title">{title}</span>
        {summary && <span className="entity-summary">{summary}</span>}
      </button>
      {(onEdit || onDelete) && (
        <span className="entity-actions">
          {onEdit && (
            <button
              type="button"
              className="entity-icon-btn"
              onClick={onEdit}
              aria-label={`编辑 ${title}`}
              title="编辑"
            >
              <Icon name="edit" size={15} />
            </button>
          )}
          {onDelete && (
            <button
              type="button"
              className="entity-icon-btn entity-icon-danger"
              onClick={() => {
                if (deleteConfirm && !window.confirm(deleteConfirm)) return;
                onDelete();
              }}
              aria-label={`删除 ${title}`}
              title="删除"
            >
              <Icon name="trash" size={15} />
            </button>
          )}
        </span>
      )}
      {right && <span className="entity-right">{right}</span>}
    </div>
  );
}

/** 列表上方的「新增」入口：与弹页共用一份表单，空态即新增 */
export function EntityAddButton({
  label,
  onClick,
  disabled = false,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button className="entity-add" type="button" onClick={onClick} disabled={disabled}>
      <Icon name="plus" size={14} />
      {label}
    </button>
  );
}

/** 一行只读摘要（没有编辑动作的列表用，比如状态行） */
export function EntityNote({ children }: { children: ReactNode }) {
  return <p className="entity-note">{children}</p>;
}

/**
 * 受控草稿：把「打开时拍一份快照、编辑中比对是否脏了」这套重复劳动收掉。
 * 弹页一律先改草稿，按下保存才提交给后端 —— 这正是列表不再挂输入条的前提。
 */
export function useDraft<T>(initial: T) {
  const [draft, setDraft] = useState<T>(initial);
  const baseline = useRef<T>(initial);
  const reset = useCallback((next: T) => {
    baseline.current = next;
    setDraft(next);
  }, []);
  const dirty = useCallback(
    (current: T) => JSON.stringify(current) !== JSON.stringify(baseline.current),
    [],
  );
  return { draft, setDraft, reset, dirty };
}
