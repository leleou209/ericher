// 后端 `src/agent/lastView.ts` 的镜像。
//
// 与 types.ts 同一个理由：tsconfig.node/web 分离，web 侧是 composite 工程，
// 不能 import `src/` 下的文件（TS6307），所以这份纯逻辑在浏览器侧留一份。
// 两边判定规则必须一致；改动时对照后端那份一起改。

export interface StartViewSession {
  id: string;
  title: string;
  /** 这一场宿在哪间场屋；空串 = 老场，宿在人屋里 */
  home: string;
}

export interface StartViewDecision {
  action: "none" | "switch";
  room: string;
  session: string;
  title: string;
  /** 记录的那一场已经不在清单里了（多半被删了） */
  stale?: boolean;
}

/**
 * 算出这次开机要不要还原、还原到哪。
 * 判据与后端 src/agent/lastView.ts 逐条一致：
 * 没记过 / 已经就在那一场 / 记的那一场被删 → 不动；命中带 home → 切到那间场屋；
 * 命中无 home（宿在人屋的老场）→ 切回人屋那一场。
 */
export function resolveStartView(input: {
  baseRoom: string;
  lastRoom: string;
  lastSession: string;
  sessions: readonly StartViewSession[];
  currentSession: string;
}): StartViewDecision {
  const { baseRoom, lastRoom, lastSession, sessions, currentSession } = input;
  const none: StartViewDecision = {
    action: "none",
    room: baseRoom,
    session: currentSession,
    title: "",
  };

  if (!lastRoom || !lastSession) return none;
  if (lastSession === currentSession) return none;

  const target = sessions.find((s) => s.id === lastSession);
  if (!target) return { ...none, stale: true };

  return {
    action: "switch",
    room: target.home || baseRoom,
    session: target.id,
    title: target.title,
  };
}
