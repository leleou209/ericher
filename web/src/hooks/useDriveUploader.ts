import { useCallback, useRef, useState } from "react";
import { api } from "../lib/api";
import {
  uploadFile,
  type UploadTier,
} from "../lib/upload";

export interface UploadProgress {
  /** 文件名 */
  name: string;
  /** 已传字节 */
  loaded: number;
  /** 总字节 */
  total: number;
  /** 走的哪一档 */
  tier: UploadTier;
  /** 失败时的原因 */
  error?: string;
  status: "uploading" | "done" | "failed";
}

/**
 * 云盘上传：多份文件并发上传，每份都有进度。
 *
 * 旧实现一份接一份地传（for 循环里 await），队列后面的文件干等着；
 * 现在并发传，但上限受控 —— 同时开太多条连接在弱网下反而互相抢带宽。
 */
export function useDriveUploader(folder: string, onDone?: () => void) {
  const [items, setItems] = useState<UploadProgress[]>([]);
  const controllers = useRef(new Set<AbortController>());
  const running = useRef(false);

  const patch = useCallback((name: string, next: Partial<UploadProgress>) => {
    setItems(current =>
      current.map(item =>
        item.name === name ? { ...item, ...next } : item,
      ),
    );
  }, []);

  const upload = useCallback(
    async (list: FileList | null, tier?: UploadTier) => {
      const files = list ? Array.from(list) : [];
      if (!files.length || running.current) return;
      running.current = true;
      setItems(
        files.map(file => ({
          name: file.name,
          loaded: 0,
          total: file.size,
          tier: tier ?? "lite",
          status: "uploading" as const,
        })),
      );
      try {
        // 一次三份：再多就互相抢带宽，单份反而更慢
        const CONCURRENCY = 3;
        let cursor = 0;
        const workers = Array.from(
          { length: Math.min(CONCURRENCY, files.length) },
          async () => {
            for (;;) {
              const index = cursor++;
              if (index >= files.length) return;
              const file = files[index];
              const controller = new AbortController();
              controllers.current.add(controller);
              try {
                await uploadFile(file, {
                  folder,
                  tier,
                  signal: controller.signal,
                  onProgress: loaded => patch(file.name, { loaded }),
                });
                patch(file.name, { status: "done", loaded: file.size });
              } catch (e) {
                const aborted = (e as Error).name === "AbortError";
                patch(file.name, {
                  status: aborted ? "failed" : "failed",
                  error: aborted ? "已取消" : (e as Error).message,
                });
              } finally {
                controllers.current.delete(controller);
              }
            }
          },
        );
        await Promise.all(workers);
        await onDone?.();
      } finally {
        running.current = false;
      }
    },
    [folder, onDone, patch],
  );

  const cancel = useCallback(() => {
    for (const controller of controllers.current) controller.abort();
    controllers.current.clear();
  }, []);

  const clear = useCallback(() => setItems([]), []);

  return { items, upload, cancel, clear, busy: items.some(i => i.status === "uploading") };
}

/** 百分比显示：不足 1% 也给一个下限，让人知道它在动。 */
export function percentOf(item: UploadProgress): number {
  if (!item.total) return 100;
  return Math.max(1, Math.min(100, Math.round((item.loaded / item.total) * 100)));
}
