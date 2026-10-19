import type { Attached } from "./attachments";

export interface DraftContent { input: string; pending: Attached[] }
export interface DraftSnapshot extends DraftContent { scope: string; revision: number }
export interface ComposerDraft extends DraftSnapshot { failed: DraftContent[] }

/** 每个会话独立保留草稿；异步提交只能清理自己捕获的那一版。仅存本次页面内存。 */
export class ComposerDraftStore {
  private drafts = new Map<string, ComposerDraft>();
  private listeners = new Set<() => void>();
  private revision = 0;
  parked: DraftSnapshot[] = [];
  version = () => this.revision;
  private changed(): void { this.revision++; for (const listener of this.listeners) listener(); }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  get(scope: string): ComposerDraft {
    let draft = this.drafts.get(scope);
    if (!draft) { draft = { scope, revision: 0, input: "", pending: [], failed: [] }; this.drafts.set(scope, draft); }
    return draft;
  }
  private put(scope: string, patch: Partial<ComposerDraft>): void {
    const previous = this.get(scope);
    this.drafts.set(scope, { ...previous, ...patch, scope, revision: previous.revision + 1 });
    this.changed();
  }
  setInput(scope: string, value: string | ((previous: string) => string)): void {
    this.put(scope, { input: typeof value === "function" ? value(this.get(scope).input) : value });
  }
  setPending(scope: string, value: Attached[] | ((previous: Attached[]) => Attached[])): void {
    this.put(scope, { pending: typeof value === "function" ? value(this.get(scope).pending) : value });
  }
  current(snapshot: DraftSnapshot, visibleScope: string): boolean {
    return snapshot.scope === visibleScope && this.get(snapshot.scope).revision === snapshot.revision;
  }
  clear(snapshot: DraftSnapshot): boolean {
    if (this.get(snapshot.scope).revision !== snapshot.revision) return false;
    this.put(snapshot.scope, { input: "", pending: [] });
    return true;
  }
  recover(snapshot: DraftContent & { scope: string }): void {
    const current = this.get(snapshot.scope);
    const same = (draft: DraftContent) => draft.input === snapshot.input &&
      draft.pending.length === snapshot.pending.length && draft.pending.every((file, i) => file.key === snapshot.pending[i].key);
    if (same(current) || current.failed.some(same)) return;
    if (!current.input && !current.pending.length) this.put(snapshot.scope, { input: snapshot.input, pending: snapshot.pending });
    else this.put(snapshot.scope, { failed: [...current.failed, { input: snapshot.input, pending: snapshot.pending }] });
  }
  /** 尚未登记的新场可能没有侧栏入口，取消接入的草稿须能从任意会话找回。 */
  park(snapshot: DraftSnapshot): void {
    if (!snapshot.input && !snapshot.pending.length) return;
    if (this.parked.some(draft => draft.scope === snapshot.scope && draft.input === snapshot.input &&
      draft.pending.length === snapshot.pending.length && draft.pending.every((file, i) => file.key === snapshot.pending[i].key))) return;
    this.parked = [...this.parked, snapshot];
    this.changed();
  }
  restoreParked(scope: string, index: number): void {
    const selected = this.parked[index];
    if (!selected) return;
    const current = this.get(scope);
    const failed = [...current.failed];
    if (current.input || current.pending.length) failed.push({ input: current.input, pending: current.pending });
    this.parked = this.parked.filter((_, i) => i !== index);
    this.put(scope, { input: selected.input, pending: selected.pending, failed });
  }
  restore(scope: string, index: number): void {
    const current = this.get(scope);
    const selected = current.failed[index];
    if (!selected) return;
    const failed = current.failed.filter((_, i) => i !== index);
    // 不覆盖后写的草稿：恢复旧稿时把眼下这一份也保留在列表里。
    if (current.input || current.pending.length) failed.push({ input: current.input, pending: current.pending });
    this.put(scope, { ...selected, failed });
  }
}

export interface QueuedDraft<T> { room: string; session: string; payload: T; draft: DraftSnapshot }
export function queuedDraftMatches<T>(queued: QueuedDraft<T>, room: string, session: string): boolean {
  return queued.room === room && queued.session === session;
}

/** AI SDK 用 onError 报告某些失败，sendMessage Promise 却会 resolve。 */
export async function trackedSend(run: () => Promise<void>, attempt: { error?: Error }): Promise<void> {
  await run();
  if (attempt.error) throw attempt.error;
}
