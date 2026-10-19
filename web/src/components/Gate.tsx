import { useCallback, useEffect, useState } from "react";
import { api, setUnauthorizedHandler, type Role } from "../lib/api";
import { agentDisplay, useTheme } from "../lib/theme";
import { ThemeBackdrop } from "./ThemeBackdrop";
import "./Gate.css";

import { createSessionCheck, sessionFailure } from "../lib/sessionCheck";

const checkSession = createSessionCheck(signal => api.me(signal));
type GateState = "checking" | "locked" | "open";

export function useGate(): {
  gate: GateState;
  checkError: string;
  retryCheck: () => void;
  /** 身份检查一直问不出结果（服务端 5xx、网关挂了）时的一条路：直接走门禁码/身份卡。
   *  留在「正在恢复会话」里等，等于把知道口令的人也挡在门外 —— 门禁本身就是登录入口。 */
  enterGate: () => void;
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
  const [checkError, setCheckError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const retryCheck = useCallback(() => {
    setCheckError("");
    setGate("checking");
    setAttempt(previous => previous + 1);
  }, []);

  const enterGate = useCallback(() => setGate("locked"), []);

  useEffect(() => {
    let alive = true;
    checkSession().then(identity => {
      if (!alive) return;
      setRole(identity.role);
      setAgent(identity.agent);
      setCheckError("");
      setGate("open");
    }).catch(error => {
      if (!alive) return;
      if (sessionFailure(error) === "locked") setGate("locked");
      else {
        setGate("checking");
        setCheckError("暂时无法确认登录状态，请检查网络后重试；这不代表你已退出登录。");
      }
    });
    return () => { alive = false; };
  }, [attempt]);

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

  return { gate, role, agent, unlock, unlockCard, lock, checkError, retryCheck, enterGate };
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
  // 门口报的名、别在门上的徽记 —— 都随主题换
  const { theme } = useTheme();
  const agent = agentDisplay(theme);

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
      {/* 门口的壁纸：铺在门里（absolute），卡浮在它上面 */}
      <ThemeBackdrop scope="gate" variant="absolute" />
      <div className="gate-card">
        {/* 没立绘就用名字首字母顶替；主题给了头像就别头像 */}
        <div className="gate-mark">
          {agent.avatar ? (
            <img src={agent.avatar} alt="" />
          ) : (
            agent.name.slice(0, 1)
          )}
        </div>
        <h1 className="gate-title">{agent.name} 接待台</h1>
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
