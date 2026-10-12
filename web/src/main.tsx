import { StrictMode, Suspense, lazy } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./theme.css";
import "./styles.css";

/**
 * 两条路：接待台本体（App），与它的外挂工作台（网页矩阵编辑台）。
 *
 * 这里不做完整路由 —— 就一处分流。矩阵工作台单开一页是因为它配置面太宽
 * （图谱、房间视角、整页预览），塞进设置抽屉里铺不开；它平时是懒加载的，
 * 没人进工作台就不会把它带进首屏。
 */
const Workbench = lazy(() =>
  import("./components/Workbench").then((m) => ({ default: m.Workbench })),
);

/** 去掉尾斜杠再比：/assistant/workbench/ 也认 */
const path = location.pathname.replace(/\/+$/, "");

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {path === "/assistant/workbench" ? (
      <Suspense fallback={<p className="dim" style={{ padding: 24 }}>正在载入工作台…</p>}>
        <Workbench />
      </Suspense>
    ) : (
      <App />
    )}
  </StrictMode>,
);
