// 聊天界面左边的「本场计划」抽屉（本场目标 + 本场步骤）。
//
// 和笔记本、回想并列，理由也一样：这件事是在对话里发生的 —— 「这一场要干什么」
// 得能在同一屏里翻出来、顺手改两笔，而不是说完话再切走整个页面去设。
//
// 三层里它是第三层：管的是「这一场要做什么」，不设时间。
// 到点提醒在「提醒」里（reminders 表），跨会话的全局待办在「待办」里（task 工具）。
// 分工不必在抽屉里再摆一行字说 —— 常驻条的悬停提示里已经带了。

import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import type { SessionTask, TaskStatus } from "../lib/types";
import { Icon, type IconName } from "./Icons";
import "./NoteMemo.css";

const SAVE_DEBOUNCE_MS = 1000;
/** 本场步骤的上限。跨工程不能 import 后端常量，照 lastView 的习惯镜像一份（见 sessionStore.ts）。 */
const SESSION_TASK_CAP = 20;

/** 点一下往前推一格：待办 → 进行中 → 完成 → 待办 */
const NEXT: Record<TaskStatus, TaskStatus> = {
  todo: "doing",
  doing: "done",
  done: "todo",
};
const STAT_ICON: Record<TaskStatus, IconName | null> = {
  todo: null,
  doing: "play",
  done: "check",
};
const STAT_TITLE: Record<TaskStatus, string> = {
  todo: "待办 —— 点一下标记为进行中",
  doing: "进行中 —— 点一下标记为完成",
  done: "已完成 —— 点一下退回待办",
};

export function SessionPlanDrawer({
  open,
  onClose,
  room,
  session,
}: {
  open: boolean;
  onClose: () => void;
  /** 在哪间屋（一间屋能装好几场，老场都住在人屋） */
  room: string;
  /** 是哪一场 —— 空 = 这会儿还没在正经一场对话里 */
  session: string;
}) {
  const [goal, setGoal] = useState("");
  const [tasks, setTasks] = useState<SessionTask[]>([]);
  const [adding, setAdding] = useState("");
  const [err, setErr] = useState("");
  const [saved, setSaved] = useState(true);
  const goalTimer = useRef(0);

  // 只在拉开时取一次；换了一场也重取（本场计划本来就是这一场的）
  useEffect(() => {
    if (!open) return;
    if (!session) {
      setGoal("");
      setTasks([]);
      return;
    }
    let alive = true;
    void (async () => {
      try {
        const p = await api.sessionPlan(room, session);
        if (!alive) return;
        setGoal(p.goal);
        setTasks(p.tasks);
        setErr("");
      } catch (e) {
        if (alive) setErr((e as Error).message);
      }
    })();
    return () => {
      alive = false;
    };
  }, [open, room, session]);

  // 换场时把没落地的目标保存取消掉：那是上一场的目标，攒进新一场就串了
  useEffect(() => {
    window.clearTimeout(goalTimer.current);
  }, [room, session]);

  const saveGoal = async (text: string) => {
    try {
      await api.saveSessionPlan({ room, session, goal: text });
      setErr("");
      setSaved(true);
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const onGoalChange = (v: string) => {
    setGoal(v);
    setSaved(false);
    window.clearTimeout(goalTimer.current);
    goalTimer.current = window.setTimeout(
      () => void saveGoal(v),
      SAVE_DEBOUNCE_MS,
    );
  };

  const saveTasks = async (next: SessionTask[]) => {
    setTasks(next);
    setSaved(false);
    try {
      await api.saveSessionPlan({ room, session, tasks: next });
      setErr("");
      setSaved(true);
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const add = () => {
    const title = adding.trim();
    if (!title) return;
    if (tasks.length >= SESSION_TASK_CAP) {
      setErr(`本场步骤最多 ${SESSION_TASK_CAP} 条`);
      return;
    }
    void saveTasks([
      ...tasks,
      { title, desc: "", status: "todo", created: new Date().toISOString() },
    ]);
    setAdding("");
  };

  const cycle = (i: number) =>
    void saveTasks(
      tasks.map((t, j) => (j === i ? { ...t, status: NEXT[t.status] } : t)),
    );

  const del = (i: number) => void saveTasks(tasks.filter((_, j) => j !== i));

  return (
    <aside
      className={`drawer-left plan-drawer ${open ? "open" : ""}`}
      aria-hidden={!open}
    >
      <div className="nm-drawer-head">
        <h1 className="nm-drawer-title">本场目标 · 本场步骤</h1>
        <button className="icon-btn" title="收起" onClick={onClose}>
          <Icon name="x" size={17} />
        </button>
      </div>

      <div className="sp-goal-wrap">
        <span className="sp-label">
          本场目标
          <span className={`nm-save ${saved ? "" : "dirty"}`}>
            {saved ? "已保存" : "未保存"}
          </span>
        </span>
        <textarea
          className="sp-goal"
          value={goal}
          placeholder="这一场要干什么？可以空着 —— 没设就是没目的。"
          onChange={(e) => onGoalChange(e.target.value)}
          onBlur={() => {
            window.clearTimeout(goalTimer.current);
            void saveGoal(goal);
          }}
        />
      </div>

      <div className="sp-steps">
        <div className="sp-steps-head">
          <b>本场步骤</b>
          <span>
            {tasks.length}/{SESSION_TASK_CAP} · 点圆圈推进
          </span>
        </div>
        <div className="sp-list">
          {!tasks.length && (
            <p className="nm-empty">
              还没定步骤。写下这一场要走的几步，他照着做。
            </p>
          )}
          {tasks.map((t, i) => (
            <div
              key={`${i}-${t.created}`}
              className={`sp-step ${t.status === "done" ? "done" : ""}`}
            >
              <button
                className={`sp-stat ${t.status}`}
                title={STAT_TITLE[t.status]}
                onClick={() => cycle(i)}
                aria-label={STAT_TITLE[t.status]}
              >
                {STAT_ICON[t.status] && (
                  <Icon name={STAT_ICON[t.status]!} size={12} />
                )}
              </button>
              <span className="sp-step-title">{t.title}</span>
              <button
                className="sp-del"
                title="删掉这一步"
                onClick={() => del(i)}
                aria-label="删掉这一步"
              >
                <Icon name="trash" size={14} />
              </button>
            </div>
          ))}
        </div>
        <div className="sp-add">
          <Icon name="plus" size={14} />
          <input
            value={adding}
            placeholder="加一步…"
            onChange={(e) => setAdding(e.target.value)}
            onKeyDown={(e) => {
              // isComposing 守卫：输入法确认候选词的那下回车不算加步骤
              if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                e.preventDefault();
                add();
              }
            }}
          />
          <button onClick={add} disabled={!adding.trim()} title="加一步">
            加
          </button>
        </div>
      </div>

      {err && <p className="nm-err">{err}</p>}
    </aside>
  );
}
