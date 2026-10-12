// 「这一台设备该从哪一场、哪间屋开始」的判定。
//
// 多端登录的坑：当前连的是哪间屋（人屋还是某间场屋）以前只活在前端内存里，
// 一刷新就回人屋默认场。于是 A 端刚切到某场屋、B 端想来对齐，B 一刷却落回人屋，
// 两端各看各的。
//
// 人屋的 state 里存着「最后看的屋 + 场」（lastRoom / lastSession，见 state.ts），
// 这里把「人屋 + 那两格 + 已知会话清单」翻成一个明确动作：
// 什么都不用做，还是切到哪一场（切到哪间屋由那一场的 home 决定）。
//
// 做成纯函数是为了能测：会话被删、宿在人屋的老场、本就已经对上了……这些边界
// 都靠它兜住，前端只负责照着动作执行。

/** 会话元信息里判定要用到的最小形状（对齐 sessionStore.ts 的 SessionMeta） */
export interface StartViewSession {
  id: string;
  title: string;
  /** 这一场宿在哪间场屋；空串 = 老场，宿在人屋里 */
  home: string;
}

export interface StartViewDecision {
  action: "none" | "switch";
  /** switch 时该连哪间屋；none 时原样回传入的 baseRoom */
  room: string;
  /** switch 时该切到哪一场；none 时回 currentSession */
  session: string;
  /** switch 时这一场的标题（给界面提示用） */
  title: string;
  /**
   * 记录的那一场已经不在清单里了（多半被删了）。
   * 调用方据此把 lastRoom/lastSession 清掉，免得每次开机都拿一个死 id 试。
   */
  stale?: boolean;
}

/**
 * 算出这次开机要不要还原、还原到哪。
 *
 * 判据：
 *  - 没记过（lastRoom / lastSession 为空）→ 不动；
 *  - 已经就在那一场（lastSession === currentSession）→ 不动；
 *  - 记的那一场不在清单里（被删）→ 不动，并标 stale；
 *  - 在清单里且带 home → 切到那间场屋；
 *  - 在清单里但没 home（宿在人屋的老场）→ 切回人屋那一场。
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

  // 场屋名以会话记录里的 home 为准，比 lastRoom 更可信（那是后端存的）
  return {
    action: "switch",
    room: target.home || baseRoom,
    session: target.id,
    title: target.title,
  };
}

/**
 * 两笔「最后看的场 + 屋」记录，后到的那笔该不该收下。
 *
 * 多端各自都会写回：只认时间上更晚的那笔，人屋只留最新的一份 ——
 * 旧设备内存里揣着的时刻、网络乱序迟到的那条，都不该把已经记下的新状态顶回去。
 * 用 `>=` 而非 `>`：同一毫秒里的后一笔也算数（时钟精度就到这儿了）。
 */
export function newerViewWins(prevAt: number, at: number): boolean {
  return at >= prevAt;
}
