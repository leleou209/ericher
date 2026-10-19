/** 仅公开这一种已知业务冲突；其余平台/存储错误仍由通用错误处理脱敏。 */
export const SESSION_RUNNING_MESSAGE = "这间旧会话仍在运行，请等它结束再切换旧会话；可以先打开独立会话";

export function sessionConflictResponse(error: unknown): Response | null {
  // DO RPC 可能附加远端错误前缀，但不应把未知错误原文返回给客户端。
  if (!(error instanceof Error) || !error.message.includes(SESSION_RUNNING_MESSAGE)) return null;
  return Response.json({ ok: false, error: SESSION_RUNNING_MESSAGE }, { status: 409 });
}
