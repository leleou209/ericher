// 只提示“这台设备曾成功载入聊天”，用于预热代码，绝不是登录凭据或授权依据。
const KEY = "ericher.shell.warm.v1";
export function shouldWarmShell(saveData: boolean): boolean {
  if (saveData) return false;
  try { return localStorage.getItem(KEY) === "1"; } catch { return false; }
}
export function rememberShellHint(open: boolean): void {
  try { if (open) localStorage.setItem(KEY, "1"); else localStorage.removeItem(KEY); } catch { /* 缓存可选 */ }
}
