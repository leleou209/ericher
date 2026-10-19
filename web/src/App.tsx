import { lazy, useCallback, useEffect, useMemo, useState } from "react";
import { api } from "./lib/api";
import {
  applyThemeToDocument, cacheTheme, defaultTheme, readCachedTheme, ThemeContext, type ThemeConfig,
} from "./lib/theme";
import { moduleResource } from "./lib/moduleResource";
import { rememberShellHint, shouldWarmShell } from "./lib/startupHint";
import { Gate, useGate } from "./components/Gate";
import { GateBoundary } from "./components/GateBoundary";
import { LoadingBoundary } from "./components/LoadingBoundary";
import { ThemePopups } from "./components/ThemePopups";

const shellResource = moduleResource(() => import("./Shell").then(module => ({ default: module.Shell })));

/** 门口只下载鉴权与基础样式；聊天运行时和可选面板不进入首屏静态依赖。 */
export default function App() {
  const { gate, role, agent, unlock, unlockCard, lock, checkError, retryCheck, enterGate } =
    useGate();
  // React.lazy 一旦拒绝就不会再跑一次工厂：重试必须是「换一个新 lazy」，
  // 而不是把同一个已失败的组件再渲染一遍
  const [shellGeneration, setShellGeneration] = useState(0);
  const Shell = useMemo(
    () => lazy(shellResource.load),
    [shellGeneration],
  );
  const [themeCfg, setThemeCfg] = useState<ThemeConfig>(() => readCachedTheme() ?? defaultTheme());
  const reloadTheme = useCallback(async () => {
    try {
      const theme = await api.themeGet();
      setThemeCfg(theme);
      applyThemeToDocument(theme);
      cacheTheme(theme);
    } catch { /* 主题请求失败不阻止接待台启动 */ }
  }, []);
  useEffect(() => {
    applyThemeToDocument(readCachedTheme() ?? defaultTheme());
    void reloadTheme();
  }, [reloadTheme]);
  useEffect(() => {
    const connection = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
    // 只预热公开代码，不挂载 Shell 或建立聊天连接；身份仍必须经 /api/me 验证。
    if (shouldWarmShell(connection?.saveData === true)) shellResource.preload();
  }, []);
  useEffect(() => {
    if (gate === "open") rememberShellHint(true);
    else if (gate === "locked") rememberShellHint(false);
  }, [gate]);
  const themeState = useMemo(() => ({ theme: themeCfg, reload: reloadTheme }), [themeCfg, reloadTheme]);

  return (
    <ThemeContext.Provider value={themeState}>
      <GateBoundary gate={gate} checkError={checkError} onRetry={retryCheck} onEnterGate={enterGate} locked={
        <Gate
          onSubmit={password => { shellResource.preload(); return unlock(password); }}
          onSubmitCard={(name, password) => { shellResource.preload(); return unlockCard(name, password); }}
        />
      }>
        <LoadingBoundary
          label="正在载入接待台"
          fullscreen
          onRetry={() => setShellGeneration((g) => g + 1)}
        >
          <Shell role={role} agentName={agent} onLock={lock} />
        </LoadingBoundary>
      </GateBoundary>
      <ThemePopups />
    </ThemeContext.Provider>
  );
}
