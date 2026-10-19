import { Chat } from "@ai-sdk/react";
import { describe, expect, it } from "vitest";
import { ComposerDraftStore, queuedDraftMatches, trackedSend } from "./composerDraft";
import type { Attached } from "./attachments";
const attachment = (key: string) => ({ key, block: `附件:${key}`, file: new File(["image"], key, { type: "image/png" }) } as Attached);

describe("异步发送与会话草稿隔离", () => {
  it("图片读取迟到不能消费或清空另一场草稿", async () => {
    const store = new ComposerDraftStore();
    store.setInput("room-a:session-a", "A的问题");
    store.setPending("room-a:session-a", [attachment("a.png")]);
    const snapshot = store.get("room-a:session-a");
    let complete!: () => void;
    let sent = false;
    let visible = snapshot.scope;
    const reading = new Promise<void>(resolve => { complete = resolve; }).then(() => {
      if (!store.current(snapshot, visible)) return;
      sent = true;
      store.clear(snapshot);
    });
    visible = "room-b:session-b";
    store.setInput(visible, "B的新草稿"); store.setPending(visible, [attachment("b.png")]);
    complete(); await reading;
    expect(sent).toBe(false);
    expect(store.get(visible).input).toBe("B的新草稿");
    expect(store.get(visible).pending[0].key).toBe("b.png");
    expect(store.get(snapshot.scope).input).toBe("A的问题");
  });
  it("同一场编辑了草稿也使旧图片读取失效", () => {
    const store = new ComposerDraftStore(); store.setInput("a", "first");
    const snapshot = store.get("a"); store.setInput("a", "newer");
    expect(store.current(snapshot, "a")).toBe(false);
    expect(store.clear(snapshot)).toBe(false);
    expect(store.get("a").input).toBe("newer");
  });
  it("失败恢复保留原输入和原文件，不恢复拼接后的附件正文", () => {
    const store = new ComposerDraftStore(); const file = attachment("a.png");
    store.setInput("a", "请看图片"); store.setPending("a", [file]);
    const snapshot = store.get("a"); expect(store.clear(snapshot)).toBe(true);
    store.setInput("b", "another"); store.recover(snapshot);
    expect(store.get("a").input).toBe("请看图片");
    expect(store.get("a").pending[0].file).toBe(file.file);
    expect(store.get("b").input).toBe("another");
  });
  it("失败不能覆盖新草稿；显式恢复时两份都保留且不重复收纳", () => {
    const store = new ComposerDraftStore(); store.setInput("a", "old");
    const old = store.get("a"); store.clear(old); store.setInput("a", "new");
    store.recover(old); store.recover(old);
    expect(store.get("a").input).toBe("new"); expect(store.get("a").failed).toHaveLength(1);
    store.restore("a", 0);
    expect(store.get("a").input).toBe("old"); expect(store.get("a").failed[0].input).toBe("new");
  });
  it("排队首句必须同时匹配房间与会话", () => {
    const store = new ComposerDraftStore(); const queued = { room: "a", session: "s-a", payload: { text: "A" }, draft: store.get("a:s-a") };
    expect(queuedDraftMatches(queued, "b", "s-b")).toBe(false);
    expect(queuedDraftMatches(queued, "a", "s-b")).toBe(false);
    expect(queuedDraftMatches(queued, "a", "s-a")).toBe(true);
  });
  it("真实AI SDK吞掉transport失败时，onError跟踪仍使包装器reject", async () => {
    const attempt: { error?: Error } = {};
    const chat = new Chat({
      transport: { sendMessages: async () => { throw new Error("disconnected before prepare"); }, reconnectToStream: async () => null },
      onError: error => { attempt.error = error; },
    });
    await expect(trackedSend(() => chat.sendMessage({ text: "draft" }), attempt)).rejects.toThrow("disconnected before prepare");
    expect(chat.status).toBe("error");
  });
  it("断线后的正常resolve也报告结果不确定，且不自动重发", async () => {
    let runs = 0;
    await expect(trackedSend(async () => { runs++; }, { error: new Error("可能已接收") })).rejects.toThrow("可能已接收");
    expect(runs).toBe(1);
  });
  it("未登记的新场取消接入后，可在任意会话显式找回，不创建新会话或自动发送", () => {
    const store = new ComposerDraftStore(); const file = attachment("first.png");
    store.setInput("unregistered-room:session-a", "首句原文");
    store.setPending("unregistered-room:session-a", [file]);
    const snapshot = store.get("unregistered-room:session-a");
    store.clear(snapshot); store.park(snapshot); store.park(snapshot);
    expect(store.parked).toHaveLength(1);
    expect(store.parked[0].scope).toBe("unregistered-room:session-a");
    store.setInput("b", "B原草稿"); store.restoreParked("b", 0);
    expect(store.get("b").input).toBe("首句原文");
    expect(store.get("b").pending[0].file).toBe(file.file);
    expect(store.get("b").failed[0].input).toBe("B原草稿");
    expect(store.parked).toHaveLength(0);
  });
  it("全局恢复列表变化也通知另一会话订阅者", () => {
    const store = new ComposerDraftStore(); store.get("b");
    let updates = 0; const unsubscribe = store.subscribe(() => { updates++; });
    const version = store.version();
    store.park({ scope: "a", revision: 0, input: "cancelled", pending: [] });
    expect(updates).toBe(1); expect(store.version()).toBeGreaterThan(version);
    expect(store.get("b").input).toBe("");
    unsubscribe();
  });

});
