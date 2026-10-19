import { describe, expect, it, vi } from "vitest";
import { AttachmentQueue, type AttachmentActions } from "./attachmentQueue";
import type { Attached } from "./attachments";
import type { Attachment } from "./types";
import { RequestEpoch } from "./requestEpoch";

function harness() {
  const pending: Attached[] = [];
  const actions: AttachmentActions = {
    count: () => pending.length, reading: vi.fn(), notice: vi.fn(), add: (item) => { pending.push(item); },
    upload: vi.fn(async (file) => ({ key: file.name })),
    analyze: vi.fn(async (_key, file) => ({ block: file.name } as Attachment)),
  };
  return { pending, actions, queue: new AttachmentQueue(actions) };
}
const file = (name: string) => new File(["text"], name, { type: "text/plain" });
describe("附件队列与请求上下文", () => {
  it("并发选择文件也预留容量，只上传五份", async () => {
    const h = harness();
    const first = h.queue.add([file("a"), file("b"), file("c")], true);
    const second = h.queue.add([file("d"), file("e"), file("f")], true);
    await Promise.all([first, second]);
    expect(h.pending).toHaveLength(5); expect(h.actions.upload).toHaveBeenCalledTimes(5);
    expect(h.actions.notice).toHaveBeenCalledWith(expect.stringContaining("多出来"));
  });
  it("切场取消后，较晚返回的上传不继续分析或写入新场", async () => {
    const h = harness(); let complete!: (result: { key: string }) => void;
    vi.mocked(h.actions.upload).mockImplementationOnce(() => new Promise((resolve) => { complete = resolve; }));
    const pending = h.queue.add([file("old")], true); await Promise.resolve();
    const signal = vi.mocked(h.actions.upload).mock.calls[0][1];
    h.queue.cancel(); expect(signal.aborted).toBe(true);
    await h.queue.add([file("new")], true); complete({ key: "old" }); await pending;
    expect(h.pending.map((item) => item.key)).toEqual(["new"]);
    expect(h.actions.analyze).toHaveBeenCalledTimes(1);
  });
  it("一份失败释放容量并继续其他文件，无权益时不处理", async () => {
    const h = harness(); vi.mocked(h.actions.upload).mockRejectedValueOnce(new Error("offline"));
    await h.queue.add([file("a"), file("b")], true);
    expect(h.pending.map((item) => item.key)).toEqual(["b"]);
    await h.queue.add([file("c")], false);
    expect(h.actions.upload).toHaveBeenCalledTimes(2);
    expect(h.actions.reading).toHaveBeenLastCalledWith("");
  });
  it("较早请求和失效上下文不能提交结果", () => {
    const epoch = new RequestEpoch(); const old = epoch.next(); const current = epoch.next();
    expect(epoch.current(old)).toBe(false); expect(epoch.current(current)).toBe(true);
    epoch.invalidate(); expect(epoch.current(current)).toBe(false);
  });
});
