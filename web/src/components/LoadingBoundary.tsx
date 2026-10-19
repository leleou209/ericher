import { Component, Suspense, useEffect, useState, type ReactNode } from "react";
import "./LoadingBoundary.css";

export function LoadingStatus({ label, fullscreen = false }: { label: string; fullscreen?: boolean }) {
  const [slow, setSlow] = useState(false);
  useEffect(() => { const timer = setTimeout(() => setSlow(true), 8000); return () => clearTimeout(timer); }, []);
  return (
    <div className={fullscreen ? "gate" : "deferred-status"} role="status" aria-live="polite">
      <div><p className="dim">{label}…</p>
        {slow && <><p className="dim">资源仍在加载，网络可能较慢。</p><button className="btn" onClick={() => location.reload()}>重新加载页面</button></>}
      </div>
    </div>
  );
}

/**
 * 下载失败后给哪条出口：调用方接了就地重试就不必整页重载 ——
 * 弱网下 reload 等于把所有资源从头再下一遍，正是这套首屏策略要避免的。
 */
export function resourceErrorActions(onRetry?: () => void): {
  hint: string;
  label: string;
  reload: boolean;
} {
  return onRetry
    ? { hint: "请检查网络后重试；不必刷新整个页面。", label: "重试加载", reload: false }
    : { hint: "请检查网络后重新加载；尚未发送的草稿请先复制保存。", label: "重新加载页面", reload: true };
}

class ResourceError extends Component<{ children: ReactNode; label: string; fullscreen?: boolean; onRetry?: () => void }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    if (!this.state.failed) return this.props.children;
    const { onRetry } = this.props;
    const actions = resourceErrorActions(onRetry);
    return <div className={this.props.fullscreen ? "gate" : "deferred-status"} role="alert">
      <div><p>{this.props.label}暂时未能加载。</p><p className="dim">{actions.hint}</p>
        <button className="btn" onClick={() => {
          if (actions.reload) { location.reload(); return; }
          // React.lazy 一旦拒绝就不再重跑工厂：调用方换一个新 lazy 组件才算真重试
          // （见 App.tsx 的 shellGeneration），只把这一屏重渲染一遍是没用的
          onRetry?.();
          this.setState({ failed: false });
        }}>{actions.label}</button>
      </div>
    </div>;
  }
}

/** 可选模块失败只影响所在区域，不让设置/消息下载拖住整个聊天框架。 */
export function LoadingBoundary({ children, label, fullscreen = false, onRetry }: { children?: ReactNode; label: string; fullscreen?: boolean; onRetry?: () => void }) {
  return <ResourceError label={label} fullscreen={fullscreen} onRetry={onRetry}>
    <Suspense fallback={<LoadingStatus label={label} fullscreen={fullscreen} />}>{children}</Suspense>
  </ResourceError>;
}
