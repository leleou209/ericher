/**
 * 本机记的「最后看的是哪间屋、哪一场」。按身份隔离存放 —— agent 名是按登录身份
 * 派生的，换个人登进来就是另一间屋，不该被送去上一个人的场屋。
 *
 * 它是**开机直连**的依据：本机记着落点在某间场屋上，开机就直接连那间，省掉
 * 「先连人屋、读到记录、再切过去」——那一下等于两次 Durable Object 冷启动，
 * 部署后所有屋都是冷的，最贵的就是这一步。后端那份 lastRoom/lastSession 照旧
 * 负责跨设备对齐，本地这份只是本机的先手；真失效了开机还会做一次兜底核对。
 */
export const viewKey = (agentName: string) => `xm_lastview:${agentName}`;
export function readLocalView(agentName: string): { room: string; session: string } | null {
  try {
    const raw = localStorage.getItem(viewKey(agentName));
    if (!raw) return null;
    const o = JSON.parse(raw) as { room?: unknown; session?: unknown };
    if (typeof o?.room !== "string" || typeof o?.session !== "string") return null;
    return { room: o.room, session: o.session };
  } catch {
    return null;
  }
}
export function writeLocalView(agentName: string, room: string, session: string): void {
  try {
    localStorage.setItem(viewKey(agentName), JSON.stringify({ room, session }));
  } catch {
    /* 存不下就算了：只是少一次直连，功能不受影响 */
  }
}
/** 开机落点：只认本机记录落在场屋上的那一种 —— 人屋上的老场不占这个便宜 */
export function localStartRoom(agentName: string): string {
  const hint = readLocalView(agentName);
  // 篡改防护：本机这份记录是可以被人手改的，而场屋名必须是「我的人屋名 + -- + 场 id」
  // （见 auth.ts 的 sessionRoom；人屋名不含 `--`）。前缀对不上的一律不认 ——
  // 否则改一笔就能让开机直连落到别人的场屋上，退回人屋。
  if (!hint || !hint.room.startsWith(agentName + "--")) return agentName;
  return hint.room;
}