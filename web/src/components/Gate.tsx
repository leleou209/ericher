import { useCallback, useEffect, useState } from "react";
import { api, setUnauthorizedHandler, type Role } from "../lib/api";
import "./Gate.css";

type GateState = "checking" | "locked" | "open";

export function useGate(): {
  gate: GateState;
  role: Role;
  /** 该连哪个 DO 实例。管理员是 default，来客每人一间自己的（见后端 auth.ts） */
  agent: string;
  unlock: (pw: string) => Promise<void>;
  /** 凭身份卡登入：昵称 + 密码，回卡绑定的那间屋（不需要门禁码） */
  unlockCard: (name: string, password: string) => Promise<void>;
  lock: () => void;
} {
  const [gate, setGate] = useState<GateState>("checking");
  const [role, setRole] = useState<Role>("user");
  const [agent, setAgent] = useState("");

  useEffect(() => {
    let alive = true;
    api
      .me()
      .then((r) => {
        if (!alive) return;
        setRole(r.role);
        setAgent(r.agent);
        setGate("open");
      })
      .catch(() => alive && setGate("locked"));
    return () => {
      alive = false;
    };
  }, []);

  // token 有 30 天，总会过期。过期之后每一个请求都回 401，
  // 但界面还开着 —— 人只会看到「哪儿都点不动」。这里接住那个信号，把人请回门口。
  useEffect(() => {
    setUnauthorizedHandler(() => setGate("locked"));
    return () => setUnauthorizedHandler(null);
  }, []);

  const unlock = useCallback(async (pw: string) => {
    const r = await api.login(pw);
    setRole(r.role);
    setAgent(r.agent);
    setGate("open");
  }, []);

  const unlockCard = useCallback(async (name: string, password: string) => {
    const r = await api.cardLogin({ name, password });
    setRole(r.role);
    setAgent(r.agent);
    setGate("open");
  }, []);

  const lock = useCallback(() => setGate("locked"), []);

  return { gate, role, agent, unlock, unlockCard, lock };
}

export function Gate({
  onSubmit,
  onSubmitCard,
}: {
  onSubmit: (pw: string) => Promise<void>;
  onSubmitCard: (name: string, password: string) => Promise<void>;
}) {
  // 两种进门方式：门禁码是「能不能进这栋楼」，身份卡是「你是哪位、回哪间房」。
  // 拿长期卡的老朋友不必先借别人的门禁码进来再登卡 —— 门口直接就有两条道。
  const [mode, setMode] = useState<"gate" | "card">("gate");
  const [pw, setPw] = useState("");
  const [name, setName] = useState("");
  const [cardPw, setCardPw] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setErr("");
    try {
      if (mode === "gate") {
        if (!pw) return;
        await onSubmit(pw);
        setPw("");
      } else {
        if (!name || !cardPw) return;
        await onSubmitCard(name.trim(), cardPw);
        setName("");
        setCardPw("");
      }
    } catch (e) {
      setErr((e as Error).message || "登录失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="gate" onSubmit={submit}>
      <div className="gate-card">
        {/* ericher 没有立绘和徽记，门口就用名字首字母顶替 */}
        <div className="gate-mark">e</div>
        <h1 className="gate-title">ericher 接待台</h1>
        <div className="gate-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={mode === "gate"}
            className={mode === "gate" ? "on" : ""}
            onClick={() => {
              setMode("gate");
              setErr("");
            }}
          >
            门禁密码
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === "card"}
            className={mode === "card" ? "on" : ""}
            onClick={() => {
              setMode("card");
              setErr("");
            }}
          >
            身份卡登入
          </button>
        </div>
        {mode === "gate" ? (
          <>
            <p className="gate-sub dim">请输入门禁密码</p>
            <input
              className="field gate-input"
              type="password"
              value={pw}
              onChange={(e) => setPw(e.target.value)}
              autoFocus
              autoComplete="current-password"
              disabled={busy}
            />
          </>
        ) : (
          <>
            <p className="gate-sub dim">凭长期身份卡回到自己的房间</p>
            <input
              className="field gate-input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="昵称"
              autoFocus
              autoComplete="username"
              maxLength={40}
              disabled={busy}
            />
            <input
              className="field gate-input"
              type="password"
              value={cardPw}
              onChange={(e) => setCardPw(e.target.value)}
              placeholder="卡密码"
              autoComplete="current-password"
              disabled={busy}
              style={{ marginTop: 8 }}
            />
          </>
        )}
        <button
          type="submit"
          className="btn btn-primary gate-submit"
          disabled={busy || (mode === "gate" ? !pw : !name.trim() || !cardPw)}
        >
          {busy ? "验证中…" : mode === "gate" ? "进入" : "凭卡登入"}
        </button>
        {err && <p className="gate-err">{err}</p>}
      </div>
    </form>
  );
}
