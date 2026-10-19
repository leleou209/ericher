import type { ComposerState } from "../hooks/useComposerDraft";

/** 发送结果不确定时只保留草稿，由用户核对，不自动重发。 */
export function FailedDrafts({ composer }: { composer: ComposerState }) {
  const parked = composer.store.parked;
  if (!composer.failed.length && !parked.length) return null;
  return (
    <details className="input-hint" style={{ padding: "8px 12px" }}>
      <summary>有 {composer.failed.length + parked.length} 份保留的草稿，请先核对原任务</summary>
      {parked.map((draft, index) => (
        <button key={`parked-${index}`} type="button" className="btn" title={`原会话：${draft.scope}`}
          onClick={() => composer.store.restoreParked(composer.scope, index)}>
          取消接入的草稿：{draft.input.slice(0, 32) || `${draft.pending.length} 份附件`}（恢复到当前输入框，不发送）
        </button>
      ))}
      {composer.failed.map((draft, index) => (
        <button key={index} type="button" className="btn" onClick={() => composer.store.restore(composer.scope, index)}>
          恢复草稿：{draft.input.slice(0, 32) || `${draft.pending.length} 份附件`}（保留当前草稿）
        </button>
      ))}
    </details>
  );
}
