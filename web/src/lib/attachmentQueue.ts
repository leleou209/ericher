import { MAX_ATTACH, canInlineImage, type Attached } from "./attachments";
import type { Attachment } from "./types";

export interface AttachmentActions {
  count(): number;
  reading(name: string): void;
  add(attachment: Attached): void;
  notice(message: string): void;
  upload(file: File, signal: AbortSignal): Promise<{ key: string }>;
  analyze(key: string, file: File, inline: boolean, signal: AbortSignal): Promise<Attachment>;
}

/** 跨选择操作串行处理，预留容量；取消后旧请求不能写回新会话。 */
export class AttachmentQueue {
  private generation = 0;
  private reserved = 0;
  private tail: Promise<void> = Promise.resolve();
  private controllers = new Set<AbortController>();
  constructor(private readonly actions: AttachmentActions) {}

  cancel(): void {
    this.generation++;
    this.reserved = 0;
    for (const controller of this.controllers) controller.abort();
    this.controllers.clear();
    this.tail = Promise.resolve();
    this.actions.reading("");
  }

  add(files: File[], enabled: boolean): Promise<void> {
    if (!enabled || !files.length) return Promise.resolve();
    const capacity = MAX_ATTACH - this.actions.count() - this.reserved;
    if (capacity <= 0) {
      this.actions.notice(`一次最多带 ${MAX_ATTACH} 份，先发出去再拿新的`);
      return Promise.resolve();
    }
    const picked = files.slice(0, capacity);
    if (picked.length < files.length) this.actions.notice(`一次最多带 ${MAX_ATTACH} 份，多出来的先没收`);
    const generation = this.generation;
    this.reserved += picked.length;
    const process = async () => {
      for (const file of picked) {
        if (generation !== this.generation) return;
        const controller = new AbortController();
        this.controllers.add(controller);
        this.actions.reading(file.name);
        try {
          const uploaded = await this.actions.upload(file, controller.signal);
          if (generation !== this.generation) return;
          const inline = canInlineImage(file);
          const attachment = await this.actions.analyze(uploaded.key, file, inline, controller.signal);
          if (generation === this.generation) this.actions.add({ ...attachment, key: uploaded.key, file: inline ? file : undefined });
        } catch (error) {
          if (generation === this.generation && !controller.signal.aborted)
            this.actions.notice(`「${file.name}」没读成：${error instanceof Error ? error.message : String(error)}`);
        } finally {
          this.controllers.delete(controller);
          if (generation === this.generation) this.reserved--;
        }
      }
      if (generation === this.generation) this.actions.reading("");
    };
    this.tail = this.tail.then(process);
    return this.tail;
  }
}
