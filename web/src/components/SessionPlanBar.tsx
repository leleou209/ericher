// 消息列表上方的一条「本场计划」常驻条。
//
// 它要解决的正是那句「声明」：这一场要干什么，得明面摆着 —— 不是藏在某个抽屉里
// 等人想起来了去翻。所以它贴着消息列表顶端，一眼扫得到；点开才是能改的地方。
//
// 只属于当前这一场（后端按 session 存 sessions.goal + session_tasks 表），
// 不设时间提醒。到点响的那种住在「提醒」里，是另一回事，别混。

import type { SessionTask } from "../lib/types";
import { Icon } from "./Icons";
import "./NoteMemo.css";

export function SessionPlanBar({
  goal,
  tasks,
  onOpen,
}: {
  goal: string;
  tasks: SessionTask[];
  onOpen: () => void;
}) {
  // 没目标也没步骤 = 这一场压根没设过，整条不渲染（不留一条空壳占地方）
  if (!goal && !tasks.length) return null;

  const doing = tasks.filter((t) => t.status === "doing").length;
  const done = tasks.filter((t) => t.status === "done").length;
  const meta = !tasks.length
    ? ""
    : done === tasks.length
      ? `${tasks.length} 步 · 全完了`
      : doing > 0
        ? `${tasks.length} 步 · 进行中 ${doing}`
        : `${tasks.length} 步`;

  return (
    <button
      className="sp-bar"
      onClick={onOpen}
      title="本场目标与步骤 —— 点开可以改（只管这一场；到点提醒在「提醒」里）"
    >
      <Icon name="clipboard" size={14} />
      <span className="sp-bar-goal">{goal || "本场还没定目标"}</span>
      {meta && <span className="sp-bar-meta">{meta}</span>}
    </button>
  );
}
