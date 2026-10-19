import "./Messages.css";
import {
  getToolInput,
  getToolOutput,
  getToolPartState,
} from "@cloudflare/ai-chat/react";
import {
  isValidElement,
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import ReactMarkdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { canSpeak, textOf } from "../lib/speech";
import {
  getToolName,
  isDataUIPart,
  isReasoningUIPart,
  isTextUIPart,
  isToolUIPart,
  type UIMessage,
} from "ai";
import { api, type Role } from "../lib/api";
import type { FeedbackSummary, MsgComment, TurnError } from "../lib/types";
import { agentDisplay, useTheme } from "../lib/theme";
import { Icon, type IconName } from "./Icons";
import { zoomIn } from "./Lightbox";
import { toolMeta } from "./PanelsShared";

/** 他说话前自报的那枚小签：主题给了头像就把头像别上，名字也随主题叫 */
function AgentLabel() {
  const { theme } = useTheme();
  const { name, avatar } = agentDisplay(theme);
  return (
    <div className="msg-label">
      {avatar && <img className="msg-avatar" src={avatar} alt="" />}
      {name}
    </div>
  );
}

/** 死因认领的年龄门槛：只认这个时刻之内的「新伤」，更老的直接进收件箱 */
const CLAIM_MAX_AGE = 10 * 60 * 1000;

const STATE_META: Record<string, { label: string; cls: string }> = {
  loading: { label: "运行中…", cls: "run" },
  streaming: { label: "思考中…", cls: "run" },
  "waiting-approval": { label: "等待确认", cls: "wait" },
  approved: { label: "已确认", cls: "ok" },
  complete: { label: "完成", cls: "ok" },
  error: { label: "出错", cls: "err" },
  denied: { label: "已拒绝", cls: "err" },
};

function short(input: unknown): string {
  const s = JSON.stringify(input);
  return s ? (s.length > 120 ? s.slice(0, 120) + "…" : s) : "∅";
}

function ToolCall({
  part,
  active,
}: {
  part: UIMessage["parts"][number];
  active: boolean;
}) {
  const stateKey = getToolPartState(part);
  const meta = STATE_META[stateKey] || { label: stateKey, cls: "run" };
  // 工具名只在 type 里（`tool-搜索`），没有 toolName 这个字段 ——
  // 之前读 part.toolName 一直是空串，卡片上就只有状态、看不出他在做什么
  const name = isToolUIPart(part) ? getToolName(part) : "";
  const zh = toolMeta(name).zh;
  const input = getToolInput(part);
  const output = getToolOutput(part);
  // 出错的具体死因（中断兜底 / 工具抛的错）：光一个红字「出错」没人知道发生了什么，
  // 摆出来才能判断是该重试、该简化，还是该来报 bug
  const errorText = (part as unknown as { errorText?: string; state?: string })
    .errorText;
  const running = meta.cls === "run";
  /**
   * 这一轮早结束了，卡片却还停在「运行中」—— 那不是他还在忙，是结果根本没传回来
   * （连接断过，最后一段丢失）。这时候继续写「思考中…」就是在骗人：
   * 他等一个永远不会来的结果，而我其实早就做完了。宁可说「没回来」，让他刷一下看真相。
   */
  const lost = running && !active;
  const label = lost ? "结果没回来" : meta.label;
  const cls = lost ? "warn" : meta.cls;

  // 运行中展开、结束后自动收起；收起后用户手动点开不会被后续渲染重置
  const [open, setOpen] = useState(running);
  const was = useRef(running);
  useEffect(() => {
    if (was.current !== running) setOpen(running);
    was.current = running;
  }, [running]);

  return (
    <details
      className={`tool-card ${cls}`}
      open={open}
      title={
        lost
          ? "连接断过，这一步的结果没传到界面上 —— 刷新一下就知道他到底做完没有"
          : undefined
      }
    >
      <summary className="tool-head">
        <span className="tool-icon">
          <Icon name={toolMeta(name).icon} size={14} />
        </span>
        <span className="tool-name" title={name}>
          {zh}
        </span>
        <span className="tool-state">
          {/* 还在跑的时候摆个小转圈：「在动」和「停了」，一眼要分得出来 */}
          {running && <span className="spinner" aria-hidden="true" />}
          {label}
        </span>
      </summary>
      {input !== undefined && <div className="tool-in">{short(input)}</div>}
      {meta.cls === "err" && errorText && (
        <div className="tool-err">{errorText}</div>
      )}
      {!running && <Drawn output={output} />}
      {output !== undefined && <div className="tool-out">{short(output)}</div>}
    </details>
  );
}

/**
 * 一轮异常中断的死因卡：输出超限、被停、上游拒单。以前只躺在 console 里，
 * 界面一片安静或只剩「结果没回来」；管理员可展开原始报文。
 */
const REASON_ICON: Record<TurnError["reason"], IconName> = {
  "output-limit": "scissors",
  aborted: "stop",
  "stream-error": "alert-circle",
};

function TurnErrorCard({
  err,
  showDetail,
}: {
  err: TurnError;
  /** 管理员才看得到原始报文；来客只看人话 */
  showDetail: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`turn-err ${err.reason}`}>
      <div className="turn-err-head">
        <span className="turn-err-icon">
          <Icon name={REASON_ICON[err.reason]} size={14} />
        </span>
        <span className="turn-err-title">{err.title}</span>
      </div>
      <div className="turn-err-detail">{err.detail}</div>
      {showDetail && err.raw ? (
        <>
          <button
            type="button"
            className="turn-err-toggle"
            onClick={() => setOpen((v) => !v)}
          >
            <Icon name={open ? "chevron-up" : "chevron-down"} size={12} />
            <span>{open ? "收起原始报文" : "看原始报文"}</span>
          </button>
          {open && <pre className="turn-err-raw">{err.raw}</pre>}
        </>
      ) : null}
    </div>
  );
}

// ── mermaid：她写的源码，渲染器摆线 ──
// 动态 import 让首屏不背包体。几层缓存：同源码只取一遍、同图只渲一遍、
// 拖过的高度按图记住 —— 历史重渲、外观翻面都不白跑。

/** 当前真正生效的外观主题。App 已把「跟随系统」落成 paper/dark，这里只兜底一次 */
function resolvedTheme(): string {
  const t = document.documentElement.dataset.theme || "paper";
  if (t !== "system") return t;
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "paper";
}

/**
 * 把当前主题的灰阶交给 mermaid。自带主题与纸感无关（白底黑线摆在夜墨纸上），
 * 改用 base + 显式 themeVariables，让图长在纸面上。
 */
function mermaidVars(): Record<string, unknown> {
  const cs = getComputedStyle(document.documentElement);
  const v = (n: string) => cs.getPropertyValue(n).trim();
  const surface = v("--yuzhe-surface");
  const soft = v("--yuzhe-bg-soft");
  const ink = v("--yuzhe-ink");
  const inkDim = v("--yuzhe-ink-dim");
  const inkFaint = v("--yuzhe-ink-faint");
  const line = v("--yuzhe-line");
  return {
    darkMode: resolvedTheme() === "dark",
    fontFamily: v("--font-ui"),
    fontSize: "14px",
    // 纸面
    background: surface,
    // 节点
    mainBkg: soft,
    primaryColor: soft,
    primaryTextColor: ink,
    primaryBorderColor: inkFaint,
    secondaryColor: soft,
    tertiaryColor: soft,
    nodeBorder: inkFaint,
    nodeTextColor: ink,
    // 连线与文字
    lineColor: inkDim,
    textColor: ink,
    titleColor: ink,
    edgeLabelBackground: surface,
    // 聚类（subgraph）
    clusterBkg: surface,
    clusterBorder: line,
    // 时序图
    actorBkg: soft,
    actorBorder: inkFaint,
    actorTextColor: ink,
    actorLineColor: inkFaint,
    signalColor: inkDim,
    signalTextColor: ink,
    labelBoxBkgColor: surface,
    labelBoxBorderColor: inkFaint,
    labelTextColor: ink,
    loopTextColor: ink,
    noteBkgColor: soft,
    noteBorderColor: inkFaint,
    noteTextColor: ink,
    // 状态图 / 类图
    labelBackgroundColor: surface,
  };
}

// 主题::源码 → 渲好的 svg ｜ 正在渲的那一个 ｜ 云盘地址 → 取回来的源码 ｜ 源码 → 拖过的高度
const mermaidSvgCache = new Map<string, string>();
const mermaidRenderInflight = new Map<string, Promise<string>>();
const mmdSourceCache = new Map<string, Promise<string>>();
const mermaidHeightCache = new Map<string, number>();

let mermaidMod: Promise<(typeof import("mermaid"))["default"]> | null = null;
let mermaidThemeKey = "";

/**
 * 外观翻面（含跟随系统）：mermaid 主题是全局配置，旧图作废，喊所有挂着的图重来。
 * 只盯 data-theme（App 已把系统明暗解析成 paper/dark）。
 */
let themeVersion = 0;
let themeWatchOn = false;
let themeSeen = "paper";
const themeSubs = new Set<() => void>();

function subscribeTheme(fn: () => void) {
  if (!themeWatchOn) {
    themeWatchOn = true;
    themeSeen = resolvedTheme();
    new MutationObserver(() => {
      const now = resolvedTheme();
      if (now === themeSeen) return;
      themeSeen = now;
      themeVersion++;
      mermaidSvgCache.clear();
      themeSubs.forEach((f) => f());
    }).observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
  }
  themeSubs.add(fn);
  return () => {
    themeSubs.delete(fn);
  };
}

/** 主题一翻就重渲：图跟着纸面换色，不用刷新页面 */
function useThemeVersion(): number {
  return useSyncExternalStore(subscribeTheme, () => themeVersion);
}

function loadMermaid(): Promise<(typeof import("mermaid"))["default"]> {
  // mermaid 的主题是全局配置，初始化时定死 —— 外观主题变了就得重初始化、旧渲染作废
  const theme = resolvedTheme();
  if (!mermaidMod || mermaidThemeKey !== theme) {
    if (mermaidMod) mermaidSvgCache.clear();
    mermaidThemeKey = theme;
    mermaidMod = import("mermaid").then((m) => {
      m.default.initialize({
        startOnLoad: false,
        // base 是「不自作主张」的那套：颜色全部由 themeVariables 说了算
        theme: "base",
        themeVariables: mermaidVars(),
        securityLevel: "strict",
        suppressErrorRendering: true,
        // 关掉自动撑满：默认会往根 svg 上写 width="100%" 和一条行内 max-width，
        // 横图被压扁、竖图被拉长，行内那条还压过样式表。让它按自然尺寸出图，
        // 摆放交给 CSS（max-width:100% 只缩不放）。
        flowchart: { useMaxWidth: false },
        sequence: { useMaxWidth: false },
        state: { useMaxWidth: false },
        class: { useMaxWidth: false },
        er: { useMaxWidth: false },
      });
      return m.default;
    });
  }
  return mermaidMod;
}

/**
 * 一段源码 → 一张图，同一主题下只渲一遍。工具卡与正文常各摆一份，
 * 共用 cache key，后到的直接等前一个 promise。
 */
function renderMermaid(source: string): Promise<string> {
  const key = resolvedTheme() + "\u0000" + source;
  const done = mermaidSvgCache.get(key);
  if (done !== undefined) return Promise.resolve(done);
  const running = mermaidRenderInflight.get(key);
  if (running) return running;

  const job = (async () => {
    const stage = newMermaidStage();
    try {
      const mm = await loadMermaid();
      const { svg } = await mm.render(
        "mmd-" + Math.random().toString(36).slice(2),
        source,
        stage,
      );
      if (mermaidSvgCache.size > 200) mermaidSvgCache.clear();
      mermaidSvgCache.set(key, svg);
      // 图渲出来长什么样，先在这儿留个底：看图层量到 0 宽时，这是唯一的对照物。
      // foreignObject / width / max-width 这三样正是内联能不能立住的关键。
      console.warn("[看图] mermaid 渲染成功", {
        源码行数: source.split("\n").length,
        svg长度: svg.length,
        带foreignObject: svg.includes("foreignObject"),
        带HTML标签: /<(div|span|p)\b/i.test(svg),
        viewBox: /viewBox="([^"]*)"/.exec(svg)?.[1] ?? "(无)",
        svg的width属性: /<svg[^>]*\swidth="([^"]*)"/.exec(svg)?.[1] ?? "(无)",
        内联maxWidth: /max-width:\s*([^;"]*)/.exec(svg)?.[1] ?? "(无)",
        主题: key.slice(0, key.indexOf("\u0000")),
      });
      return svg;
    } finally {
      stage.remove();
      mermaidRenderInflight.delete(key);
    }
  })();
  mermaidRenderInflight.set(key, job);
  return job;
}

/**
 * mermaid 画图的落脚处。不给容器它会挂到 body 末尾且无定位，页面底部会多出一张
 * 未上色的图、文档高度跟着长。给一个屏外 visibility:hidden 的容器（不能用
 * display:none，量文字要 getBBox），每图一个 —— mermaid 开画前会清空容器。
 */
function newMermaidStage(): HTMLDivElement {
  const stage = document.createElement("div");
  stage.setAttribute("aria-hidden", "true");
  stage.style.cssText =
    "position:fixed;top:0;left:0;width:100%;visibility:hidden;pointer-events:none;z-index:-1;";
  document.body.appendChild(stage);
  return stage;
}

/**
 * 源码 → 图。失败把错误摆出来，不吞。默认高 min(自然高, 约 70vh)，
 * 装不下就框内滚；底部可拖高，拖过的高度按图记住。
 */
function MermaidView({ source, alt }: { source: string; alt: string }) {
  const themeV = useThemeVersion();
  const [svg, setSvg] = useState(
    () => mermaidSvgCache.get(resolvedTheme() + "\u0000" + source) ?? "",
  );
  const [err, setErr] = useState("");
  const frameRef = useRef<HTMLDivElement | null>(null);
  const lastSource = useRef(source);
  // 用户拖过的高度：null = 还没动过，随「建议默认高」走
  const [cap, setCap] = useState<number | null>(
    () => mermaidHeightCache.get(source) ?? null,
  );
  // 图比一屏还高才有得调 —— 装得下的时候摆个把手只是徒增困惑
  const [tall, setTall] = useState(false);
  const dragFrom = useRef<{ y: number; h: number } | null>(null);
  // 拖过把手的那一下不是「点图」：松手别顺手把看图层弹出来
  const dragged = useRef(false);

  useEffect(() => {
    let alive = true;
    // 换了一张图才清空；只是翻了主题就先把旧图摆着，等新的渲好再换，免得闪一下白
    const sameSource = lastSource.current === source;
    lastSource.current = source;
    if (!sameSource) setSvg("");
    setErr("");
    const hit = mermaidSvgCache.get(resolvedTheme() + "\u0000" + source);
    if (hit) {
      setSvg(hit);
      return;
    }
    renderMermaid(source)
      .then((out) => {
        if (alive) setSvg(out);
      })
      .catch((e) => {
        // 整颗错误对象都摆出来：只取 message 会丢掉 mermaid 抛的语法细节
        console.error("[看图] mermaid 渲染失败", {
          源码前200字: source.slice(0, 200),
          错误对象: e,
          消息: e instanceof Error ? e.message : String(e),
          主题: resolvedTheme(),
        });
        if (alive) setErr(e instanceof Error ? e.message : String(e));
      });
    return () => {
      alive = false;
    };
  }, [source, themeV]);

  // 换了图就换回它自己那条高度记录（没记过就回到建议默认高）
  useEffect(() => {
    setCap(mermaidHeightCache.get(source) ?? null);
  }, [source]);

  // 量的永远是 svg 自己的高（父框把它裁了也不影响）：比 70vh 高才给把手
  useEffect(() => {
    const frame = frameRef.current;
    if (!svg || !frame) return;
    const measure = () => {
      const h = frame.querySelector("svg")?.getBoundingClientRect().height ?? 0;
      setTall(h > window.innerHeight * 0.7 + 8);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(frame);
    window.addEventListener("resize", measure);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [svg]);

  const gripDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.stopPropagation();
    const frame = frameRef.current;
    if (!frame) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    dragged.current = false;
    dragFrom.current = {
      y: e.clientY,
      h: frame.getBoundingClientRect().height,
    };
  };

  const gripMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const from = dragFrom.current;
    if (!from) return;
    e.stopPropagation();
    const dy = e.clientY - from.y;
    if (Math.abs(dy) > 3) dragged.current = true;
    setCap(Math.max(120, Math.round(from.h + dy)));
  };

  const gripUp = () => {
    if (!dragFrom.current) return;
    dragFrom.current = null;
    const h = frameRef.current?.getBoundingClientRect().height;
    if (h) mermaidHeightCache.set(source, Math.round(h));
  };

  if (err)
    return (
      <div className="mermaid-view mermaid-note" title={err}>
        <Icon name="image" size={13} />
        <span>
          这张图没渲出来：
          {err.length > 140 ? err.slice(0, 140) + "…" : err}
        </span>
      </div>
    );
  if (!svg)
    return (
      <div className="mermaid-view mermaid-note">
        <span className="spinner" aria-hidden="true" />
        <span>摆图中…</span>
      </div>
    );
  return (
    <div
      className="mermaid-view"
      title="点开看大图"
      onClick={() => {
        // 刚拖完把手的那一下不算「点图」
        if (dragged.current) {
          dragged.current = false;
          return;
        }
        zoomIn("", alt, svg);
      }}
    >
      <div
        className="mermaid-frame"
        ref={frameRef}
        style={cap != null ? { maxHeight: `${cap}px` } : undefined}
        dangerouslySetInnerHTML={{ __html: svg }}
      />
      {tall && (
        <div
          className="mermaid-grip"
          title="拖动调高"
          onPointerDown={gripDown}
          onPointerMove={gripMove}
          onPointerUp={gripUp}
          onPointerCancel={gripUp}
          onClick={(e) => e.stopPropagation()}
        />
      )}
    </div>
  );
}

/**
 * 云盘里的 .mmd：先取回源码再渲 —— 图是记忆和 send_image 的凭据，源码必须落在桶里。
 * 同一份源码只取一遍：工具卡和正文各摆一份时，后到的那个等前一个的回包。
 */
function loadMmdSource(src: string): Promise<string> {
  const hit = mmdSourceCache.get(src);
  if (hit) return hit;
  const job = fetch(src).then((r) => {
    console.warn("[看图] .mmd 取源码回来", { 状态码: r.status, ok: r.ok });
    return r.ok ? r.text() : Promise.reject(new Error(`HTTP ${r.status}`));
  });
  // 失败的不留在缓存里，下次还有重试的机会
  job.catch(() => mmdSourceCache.delete(src));
  mmdSourceCache.set(src, job);
  return job;
}

function MermaidFile({ src, alt }: { src: string; alt: string }) {
  const [source, setSource] = useState("");
  const [err, setErr] = useState("");
  useEffect(() => {
    let alive = true;
    setSource("");
    setErr("");
    loadMmdSource(src)
      .then((t) => {
        if (alive) setSource(t);
      })
      .catch((e) => {
        console.error("[看图] .mmd 源码没取回来", {
          原因: e instanceof Error ? e.message : String(e),
        });
        if (alive) setErr(e instanceof Error ? e.message : String(e));
      });
    return () => {
      alive = false;
    };
  }, [src]);
  if (err)
    return (
      <div className="mermaid-view mermaid-note">
        <span>源码没取回来：{err}</span>
      </div>
    );
  if (!source)
    return (
      <div className="mermaid-view mermaid-note">
        <span className="spinner" aria-hidden="true" />
        <span>取图中…</span>
      </div>
    );
  return <MermaidView source={source} alt={alt} />;
}

/**
 * 画出来的图：工具结果里有图片地址就直接摆出来。不指望模型写 markdown ——
 * 它偶尔忘写或改一个字符，人只看到「画好了」却没图；图是这条工具唯一的产出。
 */
function Drawn({ output }: { output: unknown }) {
  if (typeof output !== "string") return null;
  const m = /!\[[^\]]*\]\((\/api\/files\/[^)\s]+)\)/.exec(output);
  if (!m) {
    // 工具结果里明明有图片地址，却没被认成 markdown 图片行 —— 多半是模型没按
    // 约定的形状写那一行。这正是「说了画好了、却什么都看不见」的常见断点。
    if (output.includes("/api/files/"))
      console.warn("[看图] 工具卡里没认出图片行（地址形状不对）", {
        片段: output.slice(0, 200),
      });
    return null;
  }
  const src = m[1];
  // .mmd 是 mermaid 源码，得取回来渲染；.svg（旧图）和位图照旧当 <img>
  if (/\.mmd($|\?)/.test(src))
    return <MermaidFile src={src} alt="画出来的图" />;
  // 存量的 .svg 是深色主题之前、白底黑线那套渲的，夜墨纸上得翻个面（见 .pic-svg）
  const svgFile = /\.svg($|\?)/i.test(src);
  return (
    <img
      className={`tool-img${svgFile ? " pic-svg" : ""}`}
      src={src}
      alt="画出来的图"
      title="点开看大图"
      loading="lazy"
      onClick={() => zoomIn(src, "画出来的图")}
      onError={() =>
        console.error("[看图] 工具卡里的位图没加载出来", {
          地址: src,
        })
      }
    />
  );
}

/** 带语言标签与复制按钮的代码块。react-markdown 的 fenced code 一定包在 pre 里。 */
function CodeBlock({ children }: { children?: ReactNode }) {
  const [copied, setCopied] = useState(false);
  const child = Array.isArray(children) ? children[0] : children;
  const props = isValidElement<{ className?: string; children?: ReactNode }>(
    child,
  )
    ? child.props
    : null;
  const lang = /language-([\w-]+)/.exec(props?.className || "")?.[1] || "text";
  const raw = props?.children;
  const text = Array.isArray(raw)
    ? raw.join("")
    : typeof raw === "string"
      ? raw
      : "";

  const copy = () => {
    navigator.clipboard
      .writeText(text)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {});
  };

  const header = (
    <div className="code-header">
      <span className="code-lang">{lang}</span>
      <button
        className="code-copy-btn"
        onClick={copy}
        title={copied ? "已复制" : "复制代码"}
      >
        <Icon name={copied ? "check" : "copy"} size={13} />
      </button>
    </div>
  );

  // 正文里出现的 mermaid 代码块直接出图 —— GitHub / Cursor 都这么干；
  // 源码还在，复制按钮照旧（他想拿去别处渲染时用得上）
  if (lang === "mermaid")
    return (
      <div className="code-block">
        {header}
        <MermaidView source={text} alt="示意图" />
      </div>
    );

  return (
    <div className="code-block">
      {header}
      <pre className="code-body">{child}</pre>
    </div>
  );
}

/**
 * ericher 的输出按 Markdown 渲染。刻意不引 rehype-raw —— 不解析原始 HTML，
 * 模型或被注入的内容无法往页面塞标签。memo 是必需的：流式每个 chunk 都会重渲整列，
 * 不记忆的话历史回答全部重解析，低端机会卡死；按 text 记忆后只有正在变的会重解析。
 */
const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkBreaks]}
        components={{
          a: ({ node, ...rest }) => (
            <a {...rest} target="_blank" rel="noopener noreferrer" />
          ),
          // 答话里带的图点开能看大图：最多摆到 420px，
          // 画的是什么都看不清 —— 而他画图本来就是要给人看的
          img: ({ node, alt, ...rest }) => {
            const src = String(rest.src || "");
            // diagram 出的 .mmd 行也是走 markdown 图片的写法 —— 但那不是图，是源码，得渲染
            if (/\.mmd($|\?)/.test(src))
              return <MermaidFile src={src} alt={alt || "示意图"} />;
            return (
              <img
                {...rest}
                className={/\.svg($|\?)/i.test(src) ? "pic-svg" : undefined}
                alt={alt}
                loading="lazy"
                title="点开看大图"
                onClick={() => zoomIn(String(rest.src || ""), alt || "")}
                onError={() =>
                  console.error("[看图] 正文里的图没加载出来", { 地址: src })
                }
              />
            );
          },
          pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});

/**
 * 思考过程：正在想时摊开，开始说话就收起。一次思考动辄几千字，
 * 摊着会让人翻三屏都翻不到回答；收起后随时可点开。
 */
function Reasoning({ text, live }: { text: string; live: boolean }) {
  const [open, setOpen] = useState(live);
  const was = useRef(live);
  useEffect(() => {
    if (was.current !== live) setOpen(live);
    was.current = live;
  }, [live]);

  return (
    <details className="reasoning" open={open}>
      <summary>
        <Icon name="compass" size={14} />
        <span>{live ? "正在想…" : "他的思考"}</span>
      </summary>
      <p>{text}</p>
    </details>
  );
}

/**
 * 「他正在想什么」。真推理只给主人看；来客那边空白气泡和「卡了」分不清，
 * 所以服务端隔几秒翻一句能见人的话过来（src/agent/think.ts）。
 * 点开下面那行可看这一轮每一步。
 */
function Thoughts({
  lines,
  now,
}: {
  lines: string[];
  /** 摆不摆「此刻」那一行。气泡里已经有正文或工具卡时不摆，别压在他的话上面 */
  now: boolean;
}) {
  if (!lines.length) return null;
  const last = lines[lines.length - 1];
  return (
    <div className="thinking">
      {now && (
        <div className="thinking-now">
          <Icon name="compass" size={14} />
          <span>{last}</span>
          <span className="thinking-dots">
            <span />
            <span />
            <span />
          </span>
        </div>
      )}
      {/* 只有一句、而且正摆着的时候，下面这条就是它自己 —— 不必再摊一份 */}
      {lines.length > (now ? 1 : 0) && (
        <details className="thinking-trail">
          <summary>{now ? "他这一路在想什么" : "他当时在想什么"}</summary>
          <ol>
            {lines.map((l, i) => (
              <li key={i}>{l}</li>
            ))}
          </ol>
        </details>
      )}
    </div>
  );
}

// ── 附件在消息里长什么样 ──
// 附件正文由后端原样拼进消息（attachBlock），铺开会顶走整屏 ——
// 这里拆出文件条，正文折进「看看我读到了什么」，随时可点开核对。

type Segment =
  | { kind: "text"; text: string }
  | { kind: "file"; name: string; note: string; body: string };

const ATTACH_RE =
  /【附件：([\s\S]*?)】(?:\n<<<附件正文\n([\s\S]*?)\n附件正文>>>)?/g;

export function splitAttach(text: string): Segment[] {
  const segs: Segment[] = [];
  let last = 0;
  ATTACH_RE.lastIndex = 0;
  for (let m = ATTACH_RE.exec(text); m; m = ATTACH_RE.exec(text)) {
    const before = text.slice(last, m.index).trim();
    if (before) segs.push({ kind: "text", text: before });
    // 附件头形如「report.pdf（PDF · 抽到 1234 字）」，拆成名字和那句结论
    const head = m[1];
    const cut = head.indexOf("（");
    segs.push({
      kind: "file",
      name: cut > 0 ? head.slice(0, cut) : head,
      note: cut > 0 ? head.slice(cut + 1).replace(/）\s*$/, "") : "",
      body: (m[2] || "").trim(),
    });
    last = m.index + m[0].length;
  }
  const after = text.slice(last).trim();
  if (after) segs.push({ kind: "text", text: after });
  return segs.length ? segs : [{ kind: "text", text }];
}

// ── 交互卡片（artifact）──
// artifact 工具生成的自包含 HTML，回复里以 [artifact <key> <标题>] 引用。
// 渲染成沙箱 iframe：脚本能跑（卡片要交互），但没有同源权限；后端另垫一层 CSP sandbox。

type ArtSeg =
  | { kind: "text"; text: string }
  | { kind: "artifact"; key: string; title: string };

// key 不能只收 ASCII：会话产物在 `f/<屋>/会话/<会话id>/…`，
// 中间目录名是中文 —— 收窄会让整行认不出、漏成文本。按「一段非空白」收即可。
const ARTIFACT_RE = /\[artifact\s+(\S+)\s+([^\]\n]+?)\s*\]/g;

function splitArtifacts(text: string): ArtSeg[] {
  const segs: ArtSeg[] = [];
  let last = 0;
  ARTIFACT_RE.lastIndex = 0;
  for (let m = ARTIFACT_RE.exec(text); m; m = ARTIFACT_RE.exec(text)) {
    const before = text.slice(last, m.index).trim();
    if (before) segs.push({ kind: "text", text: before });
    segs.push({ kind: "artifact", key: m[1], title: m[2] });
    last = m.index + m[0].length;
  }
  const after = text.slice(last).trim();
  if (after) segs.push({ kind: "text", text: after });
  return segs.length ? segs : [{ kind: "text", text }];
}

/**
 * 从卡片 HTML 里抠出主 SVG。卡片是 sandbox iframe（无 allow-same-origin），父页摸不到
 * 里面的 DOM，只能再取一遍文件自己解析；DOMParser 不执行脚本，outerHTML 带着 <style>。
 * 取节点最多的那张 —— 手写卡片常塞 16×16 小图标。
 */
function pickSvg(html: string): string {
  const svgs = Array.from(
    new DOMParser().parseFromString(html, "text/html").querySelectorAll("svg"),
  );
  const main = svgs.find((s) => s.querySelectorAll("*").length > 20) ?? svgs[0];
  return main?.outerHTML ?? "";
}

function ArtifactCard({ keyName, title }: { keyName: string; title: string }) {
  // key 里的斜杠是路径分隔，其余字符逐段编码
  const src = `/api/files/${keyName
    .split("/")
    .map(encodeURIComponent)
    .join("/")}`;
  // 抠出来的 svg 留着复用：null = 还没取过，"" = 取过、但没有能放大的图
  const [svg, setSvg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /**
   * 放大：iframe 里的图点不冒泡，只能「取文件 → 抠 svg → 交给看图浮层」。
   * 真交互卡片没有可放大的矢量图，退回「新窗口打开」。
   */
  const zoom = async () => {
    let source = svg;
    if (source === null) {
      setBusy(true);
      try {
        source = pickSvg(await (await fetch(src)).text());
      } catch {
        source = "";
      }
      setSvg(source);
      setBusy(false);
    }
    if (source) zoomIn("", title, source);
    else window.open(src, "_blank", "noreferrer");
  };

  return (
    <div className="artifact-card">
      <div className="artifact-head">
        <Icon name="layers" size={14} />
        <button
          type="button"
          className="artifact-title"
          title="点开看大图"
          onClick={zoom}
        >
          {title}
        </button>
        <button
          type="button"
          className="artifact-zoom"
          onClick={zoom}
          disabled={busy}
        >
          {busy ? "取图中…" : "放大"}
        </button>
        <a
          href={src}
          target="_blank"
          rel="noreferrer"
          className="artifact-open"
        >
          新窗口打开
        </a>
      </div>
      <iframe
        src={src}
        sandbox="allow-scripts allow-forms"
        title={title}
        loading="lazy"
      />
    </div>
  );
}

function AttachCard({
  name,
  note,
  body,
}: {
  name: string;
  note: string;
  body: string;
}) {
  return (
    <div className="attach-card">
      <div className="attach-card-head">
        <Icon name="paperclip" size={14} />
        <span className="attach-card-name">{name}</span>
        {note && <span className="attach-card-note">{note}</span>}
      </div>
      {body && (
        <details className="attach-card-body">
          <summary>看看我读到了什么</summary>
          <pre>{body}</pre>
        </details>
      )}
    </div>
  );
}

function Part({
  part,
  markdown,
  live,
  active,
  showThinking,
}: {
  part: UIMessage["parts"][number];
  markdown: boolean;
  live?: boolean;
  /** 这条消息还在流式输出中。工具卡靠它区分「真的在跑」和「结果没传回来」 */
  active: boolean;
  /** 访客不渲染思考过程：思考里可能复述任何上下文，直接跳过这个 part */
  showThinking: boolean;
}) {
  if (isTextUIPart(part)) {
    if (!part.text) return null;
    if (markdown) {
      const art = splitArtifacts(part.text);
      if (!art.some((s) => s.kind === "artifact"))
        return <Markdown text={part.text} />;
      return (
        <>
          {art.map((s, i) =>
            s.kind === "artifact" ? (
              <ArtifactCard key={i} keyName={s.key} title={s.title} />
            ) : (
              <Markdown key={i} text={s.text} />
            ),
          )}
        </>
      );
    }
    // 管理员的消息：附件条和他说的话分开摆，各是各的
    const segs = splitAttach(part.text);
    if (segs.some((s) => s.kind === "file")) {
      return (
        <>
          {segs.map((s, i) =>
            s.kind === "file" ? (
              <AttachCard key={i} name={s.name} note={s.note} body={s.body} />
            ) : (
              <p className="text" key={i}>
                {s.text}
              </p>
            ),
          )}
        </>
      );
    }
    return <p className="text">{part.text}</p>;
  }
  // 他带的原件：图片直接摆出来 —— 模型看到的就是这张图，人也该看到同一张。
  // 点开能放大：缩在消息里那一张，画的是什么都看不清
  if (part.type === "file" && part.mediaType?.startsWith("image/")) {
    return (
      <img
        className="attach-img"
        src={part.url}
        alt={part.filename || "附图"}
        title="点开看大图"
        loading="lazy"
        onClick={() => zoomIn(part.url, part.filename || "附图")}
      />
    );
  }
  if (isToolUIPart(part)) return <ToolCall part={part} active={active} />;
  // 回想的分割线：他休息时回头看过这一段了，线以上的内容已经进了记忆库。
  // 它只在界面上存在 —— 主循环没配 convertDataPart，这条 data part 不会被喂回模型
  if (isDataUIPart(part) && part.type === "data-recap")
    return (
      <div
        className="recap-marker"
        title="这一条以上的内容，他已经回顾过并记下来了"
      >
        <span className="recap-marker-line" />
        <span className="recap-marker-text">↑ 以上已记</span>
        <span className="recap-marker-line" />
      </div>
    );
  if (isReasoningUIPart(part)) {
    if (!showThinking || !part.text) return null;
    return <Reasoning text={part.text} live={!!live} />;
  }
  // file / step-start / source 等未渲染的原生 part，静默跳过
  return null;
}

/**
 * 反馈按钮。ericher 的发言：赞/踩/评论；我自己的：标重/评论。
 * 评论只显示条数，正文点开才看。
 */
function Foot({
  id,
  mine,
  vote,
  comments,
  flagged,
  speaking,
  canSpeak,
  retry,
  onVote,
  onFlag,
  onOpen,
  onSpeak,
  onRetry,
}: {
  id: string;
  mine: boolean;
  vote?: { up: number; down: number; mine: number };
  comments: number;
  flagged: boolean;
  speaking?: boolean;
  canSpeak?: boolean;
  retry?: boolean;
  onVote: (id: string, value: 1 | -1) => void;
  onFlag: (id: string) => void;
  onOpen: (id: string) => void;
  onSpeak?: (id: string) => void;
  onRetry?: (id: string) => void;
}) {
  const up = vote?.up || 0;
  const down = vote?.down || 0;
  /**
   * 带内容的按钮不藏（赞踩数、评论数、标重、正在念）—— 它们属于消息；
   * 只有空条才悬停浮出，否则数字会忽隐忽现。
   */
  const pinned =
    flagged ||
    !!speaking ||
    comments > 0 ||
    up > 0 ||
    down > 0 ||
    (vote?.mine ?? 0) !== 0;
  return (
    <div className={`msg-foot${pinned ? " pinned" : ""}`}>
      {mine ? (
        <button
          className={`vote${flagged ? " on flag" : ""}`}
          onClick={() => onFlag(id)}
          title={flagged ? "已标重，再点取消" : "标重：让 ericher 重视这条"}
        >
          <Icon name="flag" size={14} />
          {flagged && <span>重点</span>}
        </button>
      ) : (
        <>
          <button
            className={`vote${vote?.mine === 1 ? " on up" : ""}`}
            onClick={() => onVote(id, 1)}
            title="这条答得好"
          >
            <Icon name="thumbs-up" size={14} />
            {up > 0 && <span>{up}</span>}
          </button>
          <button
            className={`vote${vote?.mine === -1 ? " on down" : ""}`}
            onClick={() => onVote(id, -1)}
            title="这条不行（ericher 会记下来）"
          >
            <Icon name="thumbs-down" size={14} />
            {down > 0 && <span>{down}</span>}
          </button>
          {/* 念出来：只在浏览器支持朗读时才出现，否则就是个按了没反应的按钮 */}
          {canSpeak && onSpeak && (
            <button
              className={`vote${speaking ? " on speak" : ""}`}
              onClick={() => onSpeak(id)}
              title={speaking ? "别念了" : "念出来"}
            >
              <Icon name={speaking ? "pause" : "volume"} size={14} />
            </button>
          )}
          {/* 重来：只挂在最后一条上。理由见 Messages 里那段注释 —— 不是漏了 */}
          {retry && onRetry && (
            <button
              className="vote"
              onClick={() => onRetry(id)}
              title="这条不算，重来一遍"
            >
              <Icon name="refresh" size={14} />
            </button>
          )}
        </>
      )}
      <button
        className={`vote${comments ? " has" : ""}`}
        onClick={() => onOpen(id)}
        title="评论"
      >
        <Icon name="comment" size={14} />
        {comments > 0 && <span>{comments}</span>}
      </button>
    </div>
  );
}

function authorLabel(author: string, role: Role): string {
  if (author === "ai") return "ericher";
  if (author === role) return "你";
  return author === "admin" ? "管理员" : "来客";
}

/** 评论区：用户和 ericher 都能在这里补话，正文不进上下文，只有 ericher 主动读才看得到。 */
function Comments({
  messageId,
  role,
  room,
  onClose,
  onPosted,
}: {
  messageId: string;
  role: Role;
  /** 这条消息所在的场屋。评论读写都得点名，不然后端会落到人屋找不到这条 */
  room?: string;
  onClose: () => void;
  onPosted: () => void;
}) {
  const [list, setList] = useState<MsgComment[] | null>(null);
  const [text, setText] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api
      .comments(messageId, room)
      .then(setList)
      .catch((e: Error) => setErr(e.message));
  }, [messageId, room]);

  useEffect(load, [load]);

  const post = async () => {
    const t = text.trim();
    if (!t || busy) return;
    setBusy(true);
    setErr("");
    try {
      await api.comment(messageId, t, room);
      setText("");
      load();
      onPosted();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="cmt-mask" onClick={onClose}>
      <div className="cmt" onClick={(e) => e.stopPropagation()}>
        <div className="cmt-head">
          <h3>评论 · 会话的补充上下文</h3>
          <button className="icon-btn" onClick={onClose} title="关闭">
            <Icon name="x" size={14} />
          </button>
        </div>
        <div className="cmt-body">
          {list === null && !err && <p className="empty-sm">加载中…</p>}
          {list?.length === 0 && (
            <p className="empty-sm">还没有评论。写一句，ericher 下次会读到。</p>
          )}
          {list?.map((c) => (
            <div className="cmt-item" key={c.id}>
              <div className="cmt-who">{authorLabel(c.author, role)}</div>
              <p>{c.content}</p>
            </div>
          ))}
          {err && <p className="err">{err}</p>}
        </div>
        <div className="cmt-form">
          <input
            className="field"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              // isComposing 守卫：输入法确认候选词的那下回车不算提交
              if (e.key === "Enter" && !e.nativeEvent.isComposing) void post();
            }}
            placeholder="补充一句…"
            autoComplete="off"
          />
          <button
            className="btn btn-primary btn-sm"
            onClick={() => void post()}
            disabled={busy || !text.trim()}
          >
            {busy ? "…" : "发送"}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * 单条消息。memo 理由同上：流式每个 chunk 都会重渲整列，不记忆的话历史消息
 * 连同赞踩栏、附件卡、思考折叠每帧都要重走 render。
 */
const Message = memo(function Message({
  m,
  streaming,
  thoughts,
  turnError,
  feedback,
  speaking,
  retry,
  showThinking,
  showDetail,
  onSpeak,
  onRetry,
  onVote,
  onFlag,
  onOpen,
}: {
  m: UIMessage;
  streaming?: boolean;
  /** 这一轮他在想什么（只喂给最后一条助手消息，见 Messages） */
  thoughts?: string[];
  /** 这一轮这个回答的死因（后端按 messageId 挂上来的）；没有就是正常跑完 */
  turnError?: TurnError;
  feedback: FeedbackSummary;
  speaking?: boolean;
  retry?: boolean;
  /** 访客不渲染思考过程 —— 思考里可能复述任何上下文，属于纵深防御 */
  showThinking: boolean;
  /** 访客不渲染原始报文；只有管理员能展开看死因细节 */
  showDetail: boolean;
  onSpeak?: (id: string, text: string) => void;
  onRetry?: (id: string) => void;
  onVote: (id: string, value: 1 | -1) => void;
  onFlag: (id: string) => void;
  onOpen: (id: string) => void;
}) {
  const mine = m.role === "user";
  const flagged = feedback.flags.includes(m.id);
  // 还在想、又还没开口：这时候把思考摊开；一开始说话就收起来
  const hasText = m.parts.some((p) => isTextUIPart(p) && !!p.text);
  const live = !!streaming && !hasText;
  /**
   * 气泡里已经摆出东西了没有：他说的话、手上的工具卡、或者（主人那边）摊着的真推理。
   * 一样都没有的时候，来客看到的就只是一个空壳 —— 那正是要摆「他正在想什么」的时候。
   */
  const shown = m.parts.some(
    (p) =>
      (isTextUIPart(p) && !!p.text) ||
      isToolUIPart(p) ||
      (showThinking && isReasoningUIPart(p) && !!p.text),
  );
  return (
    <div
      className={`msg ${m.role}`}
      data-flag={flagged ? "1" : "0"}
      data-streaming={streaming ? "1" : "0"}
    >
      <div className="msg-main">
        {/* 他说话前自报的小签：名字和头像都随主题换 */}
        {!mine && <AgentLabel />}
        <div className="msg-body theme-msg">
          {m.parts.map((p, i) => (
            <Part
              key={i}
              part={p}
              markdown={!mine}
              live={live}
              active={!!streaming}
              showThinking={showThinking}
            />
          ))}
          {thoughts?.length ? (
            <Thoughts lines={thoughts} now={!!streaming && !shown} />
          ) : null}
          {turnError && (
            <TurnErrorCard err={turnError} showDetail={showDetail} />
          )}
          {streaming && <span className="live-spin" />}
        </div>
        {!streaming && (
          <Foot
            id={m.id}
            mine={mine}
            vote={feedback.votes[m.id]}
            comments={feedback.comments[m.id] || 0}
            flagged={flagged}
            speaking={speaking}
            canSpeak={canSpeak()}
            retry={retry}
            onVote={onVote}
            onFlag={onFlag}
            onOpen={onOpen}
            onSpeak={onSpeak ? (id) => onSpeak(id, textOf(m)) : undefined}
            onRetry={onRetry}
          />
        )}
      </div>
    </div>
  );
});

export function Messages({
  messages,
  streaming,
  role,
  thoughts,
  turnErrors,
  speakingId,
  room,
  roomReady = true,
  showDetail,
  onSpeak,
  onRetry,
  onFlash,
}: {
  messages: UIMessage[];
  streaming: boolean;
  role: Role;
  /** 这一轮他在想什么（服务端隔几秒翻一句过来）。只在生成期间有 */
  thoughts: string[];
  /** 异常中断的死因账（后端写进 state）；按 messageId 挂到对应回答下面 */
  turnErrors?: TurnError[];
  speakingId?: string;
  /** 当前连着的屋。反馈（赞/踩/标重/评论）都得跟着它走 —— 消息住在场屋里 */
  room?: string;
  /**
   * 连接是真挂在 `room` 这间屋上了没有。换场那一下 room 立刻就变了，
   * 而 socket 还在旧屋上 —— 这时候去拉反馈是白跑一趟（还正撞上屋在唤醒，最慢）。
   */
  roomReady?: boolean;
  /** 管理员才看得到原始报文；来客只看人话 */
  showDetail: boolean;
  onSpeak?: (id: string, text: string) => void;
  onRetry?: (id: string) => void;
  onFlash: (text: string) => void;
}) {
  const [feedback, setFeedback] = useState<FeedbackSummary>({
    votes: {},
    comments: {},
    flags: [],
  });
  /** 主题给他起的名字 —— 空态招呼语也跟着叫 */
  const { theme } = useTheme();
  const [openId, setOpenId] = useState<string | null>(null);
  /** 异常收件箱开不开 —— 落不到具体消息上的死因都汇总在这里 */
  const [errOpen, setErrOpen] = useState(false);
  /**
   * 死因认领：按「哪一场 + 何时断 + 怎么断」记。断流时界面上那条助手消息还是临时
   * id，与落库 id 对不上 —— 退一步认给当时队尾的助手消息，认过就钉住；换屋作废。
   */
  const claimed = useRef(new Map<string, string>());
  /**
   * 降级的死因：认过的目标后来消失（残段没落库）就进收件箱，钉死不再改认 ——
   * 以前会松手重认，报错卡一路往下漂，新消息全跑它上面。
   */
  const demoted = useRef(new Set<string>());
  /**
   * 反馈请求定序：换屋时先发的那趟慢响应不许盖新屋的账。换屋当场清空并作废在飞的，
   * 否则上一屋的赞/踩会先套到新屋消息上。
   */
  const fbSeq = useRef(0);
  useEffect(() => {
    claimed.current.clear();
    demoted.current.clear();
    setErrOpen(false);
    fbSeq.current++;
    setFeedback({ votes: {}, comments: {}, flags: [] });
  }, [room]);

  const reload = useCallback(() => {
    const seq = ++fbSeq.current;
    api
      .feedback(room)
      .then((f) => {
        if (seq === fbSeq.current) setFeedback(f);
      })
      .catch(() => {});
  }, [room]);

  /**
   * 消息数变化与流式结束都要重拉徽标，但换场时几件事挤在一起。两道闸：
   * 屋子没真连上不拉（roomReady）；200ms 内的多次触发并成一次。
   */
  useEffect(() => {
    if (!roomReady) return;
    const t = window.setTimeout(reload, 200);
    return () => window.clearTimeout(t);
  }, [roomReady, reload, messages.length, streaming]);

  const onVote = useCallback(
    async (id: string, value: 1 | -1) => {
      try {
        const r = await api.vote(id, value, room);
        reload();
        if (r.value === -1) onFlash("已记下，ericher 会避开这个方向");
        else if (r.value === null) onFlash("已取消");
      } catch (e) {
        onFlash((e as Error).message);
      }
    },
    [reload, onFlash, room],
  );

  const onFlag = useCallback(
    async (id: string) => {
      try {
        const r = await api.flag(id, room);
        reload();
        onFlash(r.flagged ? "已标重，ericher 下一轮会重视这条" : "已取消标重");
      } catch (e) {
        onFlash((e as Error).message);
      }
    },
    [reload, onFlash, room],
  );

  if (!messages.length) {
    return (
      <div className="empty">
        {/* ericher 没有立绘和封面图，空态只留文字 */}
        <p>和 {agentDisplay(theme).name} 说点什么吧…</p>
        <p className="meta">输入 /help 看他现在能做什么</p>
      </div>
    );
  }
  const last = messages.length - 1;
  const onAssistant = messages[last].role === "assistant";
  /**
   * 「重来」只挂最后一条助手消息：重来 = 从那句往后全部作废重生成，
   * 挂在中间会顺手删掉后面一整段，代价用户看不见。
   */
  let lastAssistant = -1;
  messages.forEach((m, i) => {
    if (m.role === "assistant") lastAssistant = i;
  });
  // 思考过程只给管理员看。访客的界面里整个跳过这个 part：
  // 思考里可能复述任何上下文，不渲染是最稳的一层 —— 就算哪天读路径松了，屏幕上也先不露。
  const showThinking = role === "admin";
  /**
   * 死因两路：挂得上的钉在对应回答下；挂不上或认过又丢的进收件箱。
   * 绝不重认 —— 卡片要么钉死，要么老实待在收件箱，永不漂移。
   */
  const liveIds = new Set(messages.map((m) => m.id));
  const errByMsg = new Map<string, TurnError>();
  const inboxErrors: TurnError[] = [];
  const takenIds = new Set<string>();
  // 从新到旧认：最新的死因配最新的回答，往前的依次往前配，次序才对得上
  for (const e of [...(turnErrors ?? [])].reverse()) {
    const key = `${e.sessionId ?? ""}|${e.at}|${e.reason}`;
    if (e.messageId && liveIds.has(e.messageId)) {
      if (!errByMsg.has(e.messageId)) errByMsg.set(e.messageId, e);
      takenIds.add(e.messageId);
      continue;
    }
    if (!e.messageId || demoted.current.has(key)) {
      inboxErrors.push(e);
      continue;
    }
    let target = claimed.current.get(key) ?? "";
    // 认过的去向已经不在场上了（重取后那条残段没落库）：降级进收件箱，钉死
    if (target && !liveIds.has(target)) {
      claimed.current.delete(key);
      demoted.current.add(key);
      inboxErrors.push(e);
      continue;
    }
    if (!target) {
      // 认领有年龄门槛：只认新伤。老死因的残段多半早就不在场上，刷新后硬认
      // 只会认给最新的回复 —— 几小时前断的一轮，死因卡凭空钉在最新回答下面，
      // 看着就是张孤儿卡。老伤一律进收件箱，胶囊里翻得到。
      if (Date.now() - e.at > CLAIM_MAX_AGE) {
        demoted.current.add(key);
        inboxErrors.push(e);
        continue;
      }
      for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (m.role !== "assistant" || takenIds.has(m.id)) continue;
        target = m.id;
        claimed.current.set(key, target);
        break;
      }
    }
    if (target && liveIds.has(target)) {
      errByMsg.set(target, e);
      takenIds.add(target);
    } else {
      inboxErrors.push(e);
    }
  }
  inboxErrors.reverse(); // 收件箱新的在上
  return (
    <>
      <div className="msg-list">
        {messages.map((m, i) => (
          <Message
            key={m.id}
            m={m}
            streaming={streaming && onAssistant && i === last}
            thoughts={i === lastAssistant ? thoughts : undefined}
            turnError={m.role === "assistant" ? errByMsg.get(m.id) : undefined}
            feedback={feedback}
            speaking={speakingId === m.id}
            retry={i === lastAssistant}
            showThinking={showThinking}
            showDetail={showDetail}
            onSpeak={onSpeak}
            onRetry={onRetry}
            onVote={onVote}
            onFlag={onFlag}
            onOpen={setOpenId}
          />
        ))}
        {streaming && !onAssistant && (
          // 他还没开口 —— 但人得看得见他在。所以这里摆的是和真消息同一个壳：
          // 名字、正文区都在，只差里面的话。用同一套 class 是有意的：
          // 等真正的消息一到，位置和字号一点都不会跳。
          <div className="msg assistant">
            <div className="msg-main">
              <AgentLabel />
              <div className="msg-body theme-msg">
                {thoughts.length ? (
                  <Thoughts lines={thoughts} now />
                ) : (
                  // 还没翻出第一句的时候，那三点先替他占着 —— 「在动」这件事不能有空白
                  <div className="typing">
                    <span /> <span /> <span />
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
        {/* 异常收件箱：落不到具体消息上的死因（话没吐出来就断的、认过的消息
            没落库的）全汇总在这里 —— 胶囊钉在列表底，点开向上翻，按时间倒序。
            以前这些卡摆在队尾，新消息一来就被顶到上面，看着像报错在「漂」 */}
        {!!inboxErrors.length && (
          <div className="err-inbox">
            {errOpen && (
              <div className="err-inbox-panel">
                <div className="err-inbox-cap">
                  这一场的异常，新的在上
                  <button
                    className="err-inbox-close"
                    onClick={() => setErrOpen(false)}
                    aria-label="收起"
                  >
                    <Icon name="x" size={12} />
                  </button>
                </div>
                {inboxErrors.map((e) => (
                  <div
                    className="err-inbox-item"
                    key={`turn-err-${e.at}-${e.reason}`}
                  >
                    <span className="err-inbox-time">
                      {new Date(e.at).toLocaleTimeString([], {
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </span>
                    <TurnErrorCard err={e} showDetail={showDetail} />
                  </div>
                ))}
              </div>
            )}
            <button
              className="err-inbox-chip"
              onClick={() => setErrOpen((v) => !v)}
              title="落不到具体消息上的异常中断，点开看"
            >
              <Icon name="alert-circle" size={13} />
              异常 {inboxErrors.length}
              <Icon name={errOpen ? "chevron-down" : "chevron-up"} size={12} />
            </button>
          </div>
        )}
      </div>
      {openId && (
        <Comments
          messageId={openId}
          role={role}
          room={room}
          onClose={() => setOpenId(null)}
          onPosted={reload}
        />
      )}
    </>
  );
}
