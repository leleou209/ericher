export interface ChatStreamState { room: string; requestId: string | null; busy: boolean }
export const EMPTY_CHAT_STREAM: ChatStreamState = { room: "", requestId: null, busy: false };

/** 以服务端协议确认运行状态，避免 SDK observer 与 resume reader 并存时的残留 busy。 */
export function streamStateForFrame(previous: ChatStreamState, room: string, value: unknown): ChatStreamState {
  if (!value || typeof value !== "object") return previous;
  const frame = value as Record<string, unknown>;
  if (frame.type === "cf_agent_chat_clear" || frame.type === "cf_agent_stream_resume_none")
    return { room, requestId: null, busy: false };
  if (typeof frame.id !== "string") return previous;
  if (frame.type === "cf_agent_stream_resuming")
    return { room, requestId: frame.id, busy: true };
  if (frame.type !== "cf_agent_use_chat_response") return previous;
  if (frame.done === true) {
    // 重复提交的空结束帧不能终止另一条真正还在运行的流。
    return previous.room === room && previous.requestId === frame.id
      ? { ...previous, busy: false } : previous;
  }
  // 回放追到当前进度不代表后台结束（replayComplete=true, done=false）。
  if (typeof frame.body === "string" && frame.body.trim())
    return { room, requestId: frame.id, busy: true };
  return previous;
}

export function connectionReady(agent: { identified: boolean; name: string; readyState: number }, room: string): boolean {
  return agent.identified && agent.name === room && agent.readyState === 1;
}
