import { useCallback, useEffect, useMemo, useRef, useState, type SetStateAction } from "react";
import { api } from "../lib/api";
import type { Attached } from "../lib/attachments";
import { AttachmentQueue } from "../lib/attachmentQueue";
import type { ComposerState } from "./useComposerDraft";

export function useAttachmentDraft(enabled: boolean, scope: string, notice: (message: string) => void, composer: ComposerState) {
  const { store } = composer;
  const [readingState, setReading] = useState({ scope: "", name: "" });
  const noticeRef = useRef(notice);
  noticeRef.current = notice;
  // 每一队列闭包固定所属会话，切场后迟到的结果绝不会写进新场。
  const queue = useMemo(() => new AttachmentQueue({
    count: () => store.get(scope).pending.length,
    reading: (name) => setReading({ scope, name }),
    add: attachment => store.setPending(scope, previous => [...previous, attachment]),
    notice: message => noticeRef.current(message),
    upload: (file, signal) => api.upload(file, "", signal),
    analyze: (key, file, inline, signal) => api.attach(key, file.name, inline, signal),
  }), [scope, store]);
  const setPending = useCallback((value: SetStateAction<Attached[]>) => {
    if (typeof value !== "function" && !value.length) queue.cancel();
    store.setPending(scope, value);
  }, [queue, scope, store]);
  useEffect(() => () => queue.cancel(), [queue]);
  useEffect(() => { if (!enabled) queue.cancel(); }, [enabled, queue]);
  const addFiles = useCallback((list: FileList | File[] | null) => {
    return list ? queue.add(Array.from(list), enabled) : Promise.resolve();
  }, [enabled, queue]);
  const dropFile = useCallback((attachment: Attached) => {
    setPending(previous => previous.filter(item => item.key !== attachment.key));
  }, [setPending]);
  return { pending: composer.pending, reading: readingState.scope === scope ? readingState.name : "", setPending, addFiles, dropFile,
    cancelUploads: () => queue.cancel() };
}
