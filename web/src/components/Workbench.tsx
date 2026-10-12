import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { useDragPos } from "../lib/dragPos";
import type { MatrixStat } from "../lib/types";
import { Gate, useGate } from "./Gate";
import { Icon } from "./Icons";
import { MatrixAgent } from "./MatrixAgent";
import { MatrixPanel } from "./MatrixPanel";
import "./Workbench.css";

/**
 * 网页矩阵工作台（/assistant/workbench）。
 *
 * 矩阵是外挂在接待台之外的一批自建网页：层级路径、四档身份、节点连线、房间视角、
 * 页面预览、外观注入、外站认定……配置面又宽又深，塞进设置页那个抽屉里只会被压扁。
 * 所以它单开一页，一切摊开来看。
 *
 * 它是管理员的私密页：非管理员（持票来客）看到的只有一句说明与「回接待台」。
 */
export function Workbench() {
  const { gate, role, agent, unlock, unlockCard } = useGate();
  /** 矩阵总览：给头部那枚状态胶囊用（版本 / 构建 / 在线） */
  const [stat, setStat] = useState<MatrixStat | null>(null);
  const [probe, setProbe] = useState<"loading" | "on" | "off">("loading");
  /**
   * 「导航收了」= 只剩舞台：下面那层面板会把这件事报上来，那时连顶栏一块儿退场，
   * 整幅高度都让给舞台（预览面就靠这个铺满整屏）。顶栏在这一层手里，只能在这儿藏。
   */
  const [bare, setBare] = useState(false);
  /**
   * 右侧助手栏开不开。常驻右缘，一收就只剩一枚浮标 —— 收起来是为了把宽度还给
   * 舞台（图谱和预览都吃宽），不是因为它不重要。选择记本地，下次进来还是这样。
   */
  const [agentOn, setAgentOn] = useState(() => {
    try {
      return localStorage.getItem("matrix:agent:collapsed") !== "1";
    } catch {
      return true;
    }
  });
  /**
   * 「这辈子开过没有」：开过一次就一直挂在树上了。
   * 收起来只是给它挂个 .off（display:none）—— 连接、消息、输入框里没发出去的字
   * 都还在原地，展开是露出来而不是重来一遍。收起时拆掉的话，每回展开都要重新
   * 连一次、历史重取一遍，看起来就是「白一下」。
   */
  const [agentSeen, setAgentSeen] = useState(agentOn);
  const setAgent = (on: boolean) => {
    setAgentOn(on);
    // 开过一次就一直挂着（见下面 .wb-agent.off）：收起只是藏起来，
    // 不是拆掉 —— 否则每回展开都要重连一次，历史还得重取一遍
    if (on) setAgentSeen(true);
    try {
      localStorage.setItem("matrix:agent:collapsed", on ? "0" : "1");
    } catch {
      /* 隐私模式下写不了就不记 —— 不影响这一会儿的收放 */
    }
  };
  /** 收起来后那枚浮标的落点：钉在右下角，别去挤左下角的「导航 | 编辑」 */
  const agentFab = useDragPos("matrix:agent:fab");

  useEffect(() => {
    if (gate !== "open" || role !== "admin") return;
    let alive = true;
    api
      .matrixStat()
      .then((s) => {
        if (!alive) return;
        setStat(s);
        setProbe("on");
      })
      .catch(() => {
        if (alive) setProbe("off");
      });
    return () => {
      alive = false;
    };
  }, [gate, role]);

  if (gate === "checking") {
    return (
      <div className="wb-boot">
        <p className="dim">检查中…</p>
      </div>
    );
  }

  // 没登录就地给门禁：管理员从这个链接进来常常是新开的一页，cookie 还在，
  // 直接放行；cookie 不在了也别把人赶去别处，门口就在这儿。
  if (gate === "locked") {
    return <Gate onSubmit={unlock} onSubmitCard={unlockCard} />;
  }

  if (role !== "admin") {
    return (
      <div className="wb-deny">
        <div className="wb-deny-card">
          <h1>网页矩阵工作台</h1>
          <p className="dim">这个页面只对管理员开放。</p>
          <a className="btn btn-primary" href="/assistant">
            回接待台
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className={`wb${bare ? " wb-bare" : ""}`}>
      <header className="wb-bar">
        <span className="wb-mark" aria-hidden="true" />
        <div className="wb-brand">
          <strong className="wb-name">网页矩阵工作台</strong>
          <span className="wb-sub dim">网页矩阵的编辑台</span>
        </div>
        <span className="wb-spacer" />
        <span className={`wb-chip ${probe}`}>
          {probe === "on"
            ? `矩阵在线 · v${stat?.version || __APP_VERSION__} · 构建 ${
                stat?.build || __GIT_HASH__
              }`
            : probe === "off"
              ? "状态读取失败"
              : "探测中…"}
        </span>
        <a className="btn btn-sm" href="/assistant">
          回接待台
        </a>
      </header>

      <div className="wb-body">
        <main className="wb-main">
          <MatrixPanel onBare={setBare} />
        </main>

        {/* 右侧助手栏：跟舞台并排，收起来就只剩下面那枚浮标。
            它是「跟助手商量着改矩阵」的地方 —— 连的是 `人屋--matrix` 那间功能屋，
            不是接待台里那些对话（理由与换包的处置见 MatrixAgent.tsx 文件头）。
            开过一次之后一直挂着，收起来只挂 .off —— 见 agentSeen 的注 */}
        {(agentOn || agentSeen) && (
          <aside className={`wb-agent${agentOn ? "" : " off"}`}>
            {agent ? (
              <MatrixAgent
                agentName={agent}
                stat={stat}
                visible={agentOn}
                onCollapse={() => setAgent(false)}
              />
            ) : (
              <p className="dim" style={{ padding: 16 }}>
                接入中…
              </p>
            )}
          </aside>
        )}
      </div>

      {/* 收起来后留的浮标：钉右下角。整枚能拖 —— 与左下角那枚同一个路子 */}
      {!agentOn && (
        <div
          className={`wb-agent-fab${agentFab.dragging ? " dragging" : ""}`}
          ref={agentFab.bind}
          style={
            agentFab.pos
              ? {
                  left: agentFab.pos.x,
                  top: agentFab.pos.y,
                  right: "auto",
                  bottom: "auto",
                }
              : undefined
          }
          onPointerDown={agentFab.onPointerDown}
          onClickCapture={agentFab.guardCapture}
        >
          <button
            className="mx-fab-half"
            title="展开助手栏"
            onClick={agentFab.click(() => setAgent(true))}
          >
            <Icon name="message" size={14} />
            助手
          </button>
        </div>
      )}
    </div>
  );
}
