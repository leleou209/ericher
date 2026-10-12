// 触发式弹页：管理员在主题里配的「什么时候弹、弹什么」，到点就弹给来人看。
//
// 触发语义在 lib/theme.ts 的 popupDue 里（load 每次进站 / first 仅首次 /
// daily 每天一次 / delay 延时 N 秒），这里只管三件事：
//   1. 到点判定 + 会话内去重（同一场只弹一次，别烦人）；
//   2. 弹过的记进 localStorage（first / daily 靠它跨会话记账）；
//   3. 把弹页画出来（标题、正文、插图）。
// 多条弹页同场到点就排队一条条来，不叠罗汉。

import { useCallback, useEffect, useRef, useState } from "react";
import {
  dateKey,
  popupDelaySeconds,
  popupDue,
  popupShown,
  resolveAsset,
  useTheme,
  type PopupRecord,
  type ThemePopup,
} from "../lib/theme";
import "./ThemePopups.css";

const STORAGE_KEY = "ericher-theme-popups";

function loadRecords(): Record<string, PopupRecord> {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}") ?? {};
  } catch {
    // 记账本坏了就当没记过：弹页不该拦着人用别的
    return {};
  }
}

export function ThemePopups() {
  const { theme } = useTheme();
  const [active, setActive] = useState<ThemePopup | null>(null);
  /** 台上站着谁：出队/记账这些副作用全靠它在渲染外拍板，别塞进 setState updater */
  const activeRef = useRef<ThemePopup | null>(null);
  const queueRef = useRef<ThemePopup[]>([]);
  /** 这一场已经弹过/排上队的，不再重复 */
  const shownRef = useRef<Set<string>>(new Set());
  const recordsRef = useRef<Record<string, PopupRecord> | null>(null);

  /**
   * 队首上台：台上有人就等着，没人就掀帘。
   * 出队和记账都写在回调里、用 activeRef 判空 —— setState 的 updater 必须是纯函数
   * （React 会重复调用它验纯度），把 shift() 塞进去会被执行两次，
   * 弹页从队列里被吞掉却永远弹不出来。
   */
  const drain = useCallback(() => {
    if (activeRef.current) return;
    const next = queueRef.current.shift() ?? null;
    activeRef.current = next;
    // 真的弹出来了才记账：被吞掉/没轮上的不该背「已看过」的锅，
    // 否则 first/daily 会被记成看过，从此再也不弹（「弹页不生效」的老毛病）
    if (next) {
      const records = (recordsRef.current ??= loadRecords());
      records[next.id] = popupShown(records[next.id], dateKey(new Date()));
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(records));
      } catch {
        /* 存不下也照弹，只是明天还会再见 */
      }
    }
    setActive(next);
  }, []);

  const close = useCallback(() => {
    activeRef.current = null;
    setActive(null);
    drain();
  }, [drain]);

  useEffect(() => {
    const popups = theme.popups ?? [];
    if (!popups.length) return;
    const records = (recordsRef.current ??= loadRecords());
    const today = dateKey(new Date());
    const timers: number[] = [];

    const enqueue = (p: ThemePopup) => {
      if (shownRef.current.has(p.id)) return;
      shownRef.current.add(p.id);
      queueRef.current.push(p);
      drain();
    };

    for (const p of popups) {
      if (!popupDue(p, records[p.id], today)) continue;
      const delay = popupDelaySeconds(p);
      if (delay > 0) timers.push(window.setTimeout(() => enqueue(p), delay * 1000));
      else enqueue(p);
    }
    return () => timers.forEach((t) => window.clearTimeout(t));
  }, [theme.popups, drain]);

  if (!active) return null;
  const img = resolveAsset(active.image);

  return (
    <div
      className="theme-popup-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={active.title || "公告"}
      onClick={close}
    >
      <div className="theme-popup" onClick={(e) => e.stopPropagation()}>
        {img && <img className="theme-popup-img" src={img} alt="" />}
        {active.title && <h3 className="theme-popup-title">{active.title}</h3>}
        {active.body && <p className="theme-popup-body">{active.body}</p>}
        {active.actions.length > 0 && (
          <div className="theme-popup-actions">
            {active.actions.map((a, i) =>
              // 站内路径走同窗口跳转；外链另开新页（noopener 断掉 window.opener）
              // 第一个动作是主按钮，其余当次要按钮
              a.to.startsWith("/") ? (
                <button
                  key={i}
                  type="button"
                  className={`btn theme-popup-action${i === 0 ? " btn-primary" : ""}`}
                  onClick={() => {
                    close();
                    location.assign(a.to);
                  }}
                >
                  {a.label}
                </button>
              ) : (
                <a
                  key={i}
                  className={`btn theme-popup-action${i === 0 ? " btn-primary" : ""}`}
                  href={a.to}
                  target="_blank"
                  rel="noopener"
                  onClick={close}
                >
                  {a.label}
                </a>
              ),
            )}
          </div>
        )}
        <button type="button" className="btn theme-popup-close" onClick={close}>
          知道了
        </button>
      </div>
    </div>
  );
}
