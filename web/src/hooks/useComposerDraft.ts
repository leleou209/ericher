import { useCallback, useRef, useSyncExternalStore } from "react";
import { ComposerDraftStore } from "../lib/composerDraft";
import type { Attached } from "../lib/attachments";

export function useComposerDraft(scope: string) {
  const ref = useRef<ComposerDraftStore | null>(null);
  if (!ref.current) ref.current = new ComposerDraftStore();
  const store = ref.current;
  useSyncExternalStore(store.subscribe, store.version, store.version);
  const draft = store.get(scope);
  const setInput = useCallback((value: string | ((previous: string) => string)) => store.setInput(scope, value), [store, scope]);
  const setPending = useCallback((value: Attached[] | ((previous: Attached[]) => Attached[])) => store.setPending(scope, value), [store, scope]);
  return { ...draft, store, setInput, setPending };
}
export type ComposerState = ReturnType<typeof useComposerDraft>;
