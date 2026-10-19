import { trackedSend } from "../lib/composerDraft";
import { useCallback, useEffect, useRef, useState } from "react";
import { useAgent } from "agents/react";
import { useAgentChat } from "@cloudflare/ai-chat/react";
import { connectionReady, EMPTY_CHAT_STREAM, streamStateForFrame } from "../lib/chatLifecycle";
import { localStartRoom } from "../lib/viewStorage";
import { INITIAL_UI_STATE, type ChatState } from "../lib/types";

/** 房间连接与 SDK 节流统一装配；导航只负责选择当前房间。 */
export function useChatConnection(agentName: string) {
  const [activeRoom, setActiveRoom] = useState(() => localStartRoom(agentName));
  const [connection, setConnection] = useState({ room: "", open: false, epoch: 0 });
  const [serverStream, setServerStream] = useState(EMPTY_CHAT_STREAM);
  const recovery = useRef<string | null>(null);
  const attempts = useRef(new Map<string, { error?: Error }>());
  const controls = useRef<{ room: string; stop: () => Promise<void> } | null>(null);
  const agent = useAgent<ChatState>({
    agent: "CoworkAgent", name: activeRoom,
    // 断线时禁止积压 submit/cancel 帧。重连只走恢复协议，不能把旧操作补发。
    maxEnqueuedMessages: 0,
    onOpen: () => setConnection(c => ({ room: activeRoom, open: true, epoch: c.epoch + 1 })),
    onMessage: event => {
      if (typeof event.data !== "string") return;
      try {
        const frame: unknown = JSON.parse(event.data);
        setServerStream(previous => streamStateForFrame(previous, activeRoom, frame));
      } catch { /* 非协议帧不改变运行状态 */ }
    },
    onClose: () => {
      const attempt = attempts.current.get(activeRoom);
      if (attempt) attempt.error ??= new Error("连接中断，服务端可能已接收消息");
      setConnection(c => c.room === activeRoom ? { ...c, open: false } : c);
      if (controls.current?.room !== activeRoom) return;
      recovery.current = activeRoom;
      // socket 已关闭，且禁用离线队列：只终止失联的本地 reader，
      // SDK cancel 帧不会送达服务端。后台任务继续，重新接上后恢复原流。
      void controls.current.stop();
    },
  });
  const chat = useAgentChat({
    agent, experimental_throttle: 60,
    onError: error => {
      const attempt = attempts.current.get(activeRoom);
      if (attempt) attempt.error = error;
    },
    prepareSendMessagesRequest: () => {
      if (!connectionReady(agent, activeRoom))
        throw new Error("连接尚未恢复，消息未发送；请接通后再试");
      return { body: {} };
    },
  });
  controls.current = { room: activeRoom, stop: chat.stop };
  const online = connection.room === activeRoom && connection.open &&
    connectionReady(agent, activeRoom);
  const [recoveringRoom, setRecoveringRoom] = useState<string | null>(null);
  const recoveryGeneration = useRef(0);
  useEffect(() => { recoveryGeneration.current++; setRecoveringRoom(null); }, [activeRoom]);
  useEffect(() => {
    if (!online || recovery.current !== activeRoom) return;
    recovery.current = null;
    setRecoveringRoom(activeRoom);
    const generation = ++recoveryGeneration.current;
    void chat.resumeStream().catch(() => {}).finally(() => {
      if (recoveryGeneration.current === generation) setRecoveringRoom(null);
    });
    // 同房间的SDK实例/回调在重连中可重建；不能以effect清理判定恢复失效。
  }, [online, activeRoom, connection.epoch, chat.resumeStream]);
  const sends = useRef(new Set<string>());
  const sendMessage = useCallback<typeof chat.sendMessage>(async (...args) => {
    if (!online || agent.readyState !== 1) throw new Error("连接尚未恢复，消息未发送");
    if (sends.current.has(activeRoom)) throw new Error("这一场正在发送，请勿重复提交");
    sends.current.add(activeRoom);
    const attempt: { error?: Error } = {};
    attempts.current.set(activeRoom, attempt);
    try { await trackedSend(() => chat.sendMessage(...args), attempt); }
    finally {
      sends.current.delete(activeRoom);
      if (attempts.current.get(activeRoom) === attempt) attempts.current.delete(activeRoom);
    }
  }, [online, agent, activeRoom, chat.sendMessage]);
  const state = agent.state ?? INITIAL_UI_STATE;
  const busy = chat.status === "streaming" || chat.status === "submitted" ||
    (serverStream.room === activeRoom && serverStream.busy) || recoveringRoom === activeRoom;
  return { ...chat, sendMessage, agent, state, activeRoom, setActiveRoom, busy, online,
    thinkDeep: state.thinkMode === "deep" };
}
