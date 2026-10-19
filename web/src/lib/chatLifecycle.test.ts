import { describe, expect, it } from "vitest";
import { connectionReady, EMPTY_CHAT_STREAM, streamStateForFrame } from "./chatLifecycle";

describe("连接及恢复状态", () => {
  it("身份曾确认但socket已经关闭，或目标房间不符，均不能提交", () => {
    expect(connectionReady({ identified: true, name: "a", readyState: 3 }, "a")).toBe(false);
    expect(connectionReady({ identified: true, name: "a", readyState: 1 }, "b")).toBe(false);
    expect(connectionReady({ identified: false, name: "a", readyState: 1 }, "a")).toBe(false);
    expect(connectionReady({ identified: true, name: "a", readyState: 1 }, "a")).toBe(true);
  });
  it("两次重连追上进度仍为busy，原流done后变idle，不依赖SDK残留observer标记", () => {
    let s = EMPTY_CHAT_STREAM;
    for (let i = 0; i < 2; i++) {
      s = streamStateForFrame(s, "a", { type: "cf_agent_stream_resuming", id: "original" });
      s = streamStateForFrame(s, "a", { type: "cf_agent_use_chat_response", id: "original", body: "", done: false, replayComplete: true });
      expect(s.busy).toBe(true);
    }
    s = streamStateForFrame(s, "a", { type: "cf_agent_use_chat_response", id: "original", done: true });
    expect(s.busy).toBe(false);
  });
  it("重复提交的空结束帧不能让原任务变idle；新房间状态也不能被旧房间结束覆盖", () => {
    const s = streamStateForFrame(EMPTY_CHAT_STREAM, "a", { type: "cf_agent_stream_resuming", id: "original" });
    expect(streamStateForFrame(s, "a", { type: "cf_agent_use_chat_response", id: "duplicate", done: true })).toBe(s);
    expect(streamStateForFrame(s, "b", { type: "cf_agent_use_chat_response", id: "original", done: true })).toBe(s);
  });
  it("无可恢复流及清空历史会解除busy，未知/无效帧不改变状态", () => {
    const s = streamStateForFrame(EMPTY_CHAT_STREAM, "a", { type: "cf_agent_stream_resuming", id: "r" });
    expect(streamStateForFrame(s, "a", { type: "cf_agent_stream_resume_none" }).busy).toBe(false);
    expect(streamStateForFrame(s, "a", { type: "cf_agent_chat_clear" }).busy).toBe(false);
    expect(streamStateForFrame(s, "a", null)).toBe(s);
    expect(streamStateForFrame(s, "a", { type: "notice" })).toBe(s);
  });
});
