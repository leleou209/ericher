import { StrictMode, lazy } from "react";
import { LoadingBoundary } from "./components/LoadingBoundary";
import { createRoot } from "react-dom/client";
import App from "./App";
// 这两份是全站基础样式。生产构建会把结果内联进 index.html（见 vite.config.ts 的
// inline-startup-css）：弱网不必等一次样式请求就能画出启动与门禁界面；
// 保留静态导入是为了让 Vite 的依赖图知道聊天框架要用到它们。
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
      <LoadingBoundary label="正在载入工作台" fullscreen>
        <Workbench />
      </LoadingBoundary>
    ) : (
      <App />
    )}
  </StrictMode>,
);
