import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import type { SessionMeta } from "../lib/types";
import { RequestEpoch } from "../lib/requestEpoch";

export function useSessionList() {
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [sessionsLoaded, setSessionsLoaded] = useState(false);
  const [sessionsOk, setSessionsOk] = useState(false);
  const epoch = useRef(new RequestEpoch());
  const loadSessions = useCallback(async () => {
    const ticket = epoch.current.next();
    try {
      const list = await api.sessions();
      if (!epoch.current.current(ticket)) return undefined;
      setSessions(list); setSessionsOk(true); setSessionsLoaded(true);
      return list;
    } catch {
      if (epoch.current.current(ticket)) setSessionsLoaded(true);
      return undefined;
    }
  }, []);
  useEffect(() => { void loadSessions(); return () => epoch.current.invalidate(); }, [loadSessions]);
  return { sessions, sessionsLoaded, sessionsOk, loadSessions };
}
