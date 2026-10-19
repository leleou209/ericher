import type { ReactNode } from "react";

/** 身份未验证时只显示中性占位；既不闪现门禁，也不提前挂载私有会话。 */
export function GateBoundary({ gate, locked, children, checkError, onRetry, onEnterGate }: {
  gate: "checking" | "locked" | "open";
  locked: ReactNode;
  children?: ReactNode;
  checkError?: string;
  onRetry?: () => void;
  onEnterGate?: () => void;
}) {
  if (gate === "checking") return (
    <div className="gate" role="status" aria-live="polite">
      <div>
        <p className="dim">{checkError || "正在恢复会话…"}</p>
        {checkError && onRetry && <button className="btn" type="button" onClick={onRetry}>重试身份检查</button>}
        {checkError && onEnterGate && (
          <button className="btn-ghost" type="button" onClick={onEnterGate}>
            用门禁码 / 身份卡进门
          </button>
        )}
      </div>
    </div>
  );
  return gate === "open" ? children : locked;
}
