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
import type { FeedbackSummary, MsgComment } from "../lib/types";
import { Icon } from "./Icons";
import { zoomIn } from "./Lightbox";
import { toolMeta } from "./Panels";

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

// ── mermaid：她写的源码，渲染器摆线 ──────────────────────
// 动态 import 让首屏不背 mermaid 的包体 —— 只有真出现图时才拉渲染器；
// 渲染结果按源码缓存，历史消息重渲时直接复用，不重画。

const mermaidSvgCache = new Map<string, string>();
let mermaidMod: Promise<(typeof import("mermaid"))["default"]> | null = null;
let mermaidThemeKey = "";

function loadMermaid(): Promise<(typeof import("mermaid"))["default"]> {
  // mermaid 的主题是全局配置，初始化时定死 —— 外观主题变了就得重初始化、旧渲染作废
  const theme = document.documentElement.dataset.theme || "paper";
  const dark =
    theme === "dark" ||
    (theme === "system" &&
      window.matchMedia("(prefers-color-scheme: dark)").matches);
  const key = dark ? "dark" : "neutral";
  if (!mermaidMod || mermaidThemeKey !== key) {
    if (mermaidMod) mermaidSvgCache.clear();
    mermaidThemeKey = key;
    mermaidMod = import("mermaid").then((m) => {
      m.default.initialize({
        startOnLoad: false,
        theme: key,
        securityLevel: "strict",
        suppressErrorRendering: true,
      });
      return m.default;
    });
  }
  return mermaidMod;
}

/**
 * mermaid 画图时的落脚处。
 *
 * 不给容器，mermaid 会把它临时搭的那层 div 直接挂到 document.body 末尾 ——
 * 而且不带任何定位样式（mermaid 源码 appendDivSvgG 里，无容器那条支路 divStyle 是空的）。
 * 于是一刷新就出洋相：内存缓存空、每张图都要从头画，页面最底下（输入框之下）会实打实
 * 多出一张还没上色的图，文档高度跟着长一截 —— 看着就像「下面有什么在渲染」。
 * 给一个藏在屏外、visibility:hidden 的容器，图照样画得出来（量文字要用 getBBox，
 * 得保留排版，所以不能用 display:none），画完取源码即弃，页面上不留痕迹。
 * 每张图各给一个容器：mermaid 开画前会先清空容器，共用一个会把并发的另几张擦掉。
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
 * 一段 mermaid 源码 → 一张图。渲染失败把错误摆出来而不是吞掉 ——
 * 空卡片没人知道为什么，摆出来她改一版重发就是。
 */
function MermaidView({ source, alt }: { source: string; alt: string }) {
  const [svg, setSvg] = useState(() => mermaidSvgCache.get(source) ?? "");
  const [err, setErr] = useState("");
  useEffect(() => {
    const cached = mermaidSvgCache.get(source);
    if (cached) {
      setSvg(cached);
      setErr("");
      return;
    }
    setSvg("");
    let alive = true;
    const stage = newMermaidStage();
    loadMermaid()
      .then(async (mm) => {
        const { svg: out } = await mm.render(
          "mmd-" + Math.random().toString(36).slice(2),
          source,
          stage,
        );
        if (mermaidSvgCache.size > 200) mermaidSvgCache.clear();
        mermaidSvgCache.set(source, out);
        // 图渲出来长什么样，先在这儿留个底：看图层量到 0 宽时，这是唯一的对照物。
        // foreignObject / width / max-width 这三样正是内联能不能立住的关键。
        console.warn("[看图] mermaid 渲染成功", {
          源码行数: source.split("\n").length,
          svg长度: out.length,
          带foreignObject: out.includes("foreignObject"),
          带HTML标签: /<(div|span|p)\b/i.test(out),
          viewBox: /viewBox="([^"]*)"/.exec(out)?.[1] ?? "(无)",
          svg的width属性: /<svg[^>]*\swidth="([^"]*)"/.exec(out)?.[1] ?? "(无)",
          内联maxWidth: /max-width:\s*([^;"]*)/.exec(out)?.[1] ?? "(无)",
          主题: mermaidThemeKey,
        });
        if (alive) {
          setSvg(out);
          setErr("");
        }
      })
      .catch((e) => {
        // 整颗错误对象都摆出来：只取 message 会丢掉 mermaid 抛的语法细节
        console.error("[看图] mermaid 渲染失败", {
          源码前200字: source.slice(0, 200),
          错误对象: e,
          消息: e instanceof Error ? e.message : String(e),
          主题: mermaidThemeKey,
        });
        if (alive) setErr(e instanceof Error ? e.message : String(e));
      })
      // 画完（无论成没成）把落脚处撤掉：留在 body 里就是一堆看不见的空壳
      .finally(() => stage.remove());
    return () => {
      alive = false;
    };
  }, [source]);

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
      onClick={() => zoomIn("", alt, svg)}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

/** 云盘里的 .mmd：先取回源码再渲 —— 图是记忆和 send_image 的凭据，源码必须落在桶里 */
function MermaidFile({ src, alt }: { src: string; alt: string }) {
  const [source, setSource] = useState("");
  const [err, setErr] = useState("");
  useEffect(() => {
    let alive = true;
    setSource("");
    setErr("");
    fetch(src)
      .then((r) => {
        console.warn("[看图] .mmd 取源码回来", { 状态码: r.status, ok: r.ok });
        return r.ok ? r.text() : Promise.reject(new Error(`HTTP ${r.status}`));
      })
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
 * 画出来的图：工具结果里带图片地址时，直接把图摆出来。
 *
 * 为什么不指望模型在回复里写 markdown 就够了：
 * 它偶尔会忘了写，或者把那行改一个字符，人就只看到一句「画好了」却没有图 ——
 * 图是这条工具唯一的产出，摆在这儿谁也漏不掉。
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
  return (
    <img
      className="tool-img"
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
 * ericher 的输出按 Markdown 渲染。刻意不引入 rehype-raw —— 不解析原始 HTML，
 * 模型（或被注入的内容）无法往页面里塞标签。
 *
 * 为什么要 memo：流式输出每来一个 chunk，整条消息列表就会重渲一次。
 * react-markdown 是「给一段文字、重新解析成树」的组件，不做记忆化的话，
 * 每吐一个字，这一场里所有历史回答都要被 remarkGfm / remarkBreaks 重解析一遍 ——
 * 对话越长越卡，低端机上直接卡成 PPT。按 text 记忆之后，
 * 只有正在变的那一条会重新解析，历史那些原地不动。
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
 * 思考过程。正在想的时候摊开给你看 —— 那是「他在琢磨」的实感；
 * 一旦开始说正事就自动收起来。
 *
 * 为什么非收不可：一次思考动辄几千字，还是英文的内心独白。摊在对话里，
 * 人往下翻三屏都翻不到回答。收起来之后它还在，想看随时点开，只是不再挡路。
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
 * 「他正在想什么」。
 *
 * 真推理只给主人看；来客那边整段是空白的 —— 空气泡和「ericher 卡了」长得一模一样。
 * 所以服务端每隔几秒把他这一轮的动静翻成一句能见人的话送过来（见 src/agent/think.ts），
 * 最新那句摆在这儿，句尾那三点负责「还在动」的实感。
 * 想看他一路都在琢磨什么，点开下面那行：每一步一句、按先后排着 —— 那就是这一轮的思考。
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

// ── 附件在消息里长什么样 ──────────────────────────────
//
// 管理员发来的消息里，附件正文是原样拼进去的（见 src/agent/attach.ts 的 attachBlock）。
// 直接铺开的话，一次转录就能把整屏对话顶走 —— 所以这里把它拆出来，
// 上面留一个文件条，正文折进「看看我读到了什么」。
// 折起来不是藏起来：他随时能点开核对，我读了什么他看得见。

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

// ── 交互卡片（artifact）────────────────────────────────
//
// ericher 用 artifact 工具生成的自包含 HTML，回复里以一行
// [artifact <key> <标题>] 引用。这里把那行拆出来渲染成内联卡片：
// 沙箱 iframe —— 脚本能跑（卡片要能交互），但没有同源权限，
// 碰不到登录者的任何东西；后端响应头还垫了一层 CSP sandbox。

type ArtSeg =
  | { kind: "text"; text: string }
  | { kind: "artifact"; key: string; title: string };

// key 那一段不能只收 ASCII 的 [\w./-]：会话产物存在
// `f/<屋>/会话/<会话id>/…` 下，中间那段目录名就是中文（SESSION_FOLDER = "会话"），
// 收窄的字符集会让整行认不出来、原样漏成文本 —— key 里本来就不会有空白，
// 按「一段非空白」收就够，顺带把来客名字之类的中文屋名也一起兜住。
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
 * 从卡片 HTML 里把它那张 SVG 抠出来。
 *
 * 卡片是 sandboxed iframe（sandbox 里没有 allow-same-origin），父页面摸不到里面的
 * DOM —— 所以不能直接读 iframe 里的 svg，只能把文件再取一遍自己解析。DOMParser
 * 不执行脚本，取 outerHTML 会把 svg 自带的 <style> 一并带走，样式不丢。
 * 挑节点最多的那张：手写卡片常顺手塞个 16×16 的小图标，抓错了就只能放大一个点。
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
   * 放大。图困在 iframe 里，点它不冒泡到外面（mermaid 那张是内联 SVG，所以点得开）
   * —— 只能走「取文件 → 抠出 svg → 交给看图浮层」这条迂回路。真交互卡片
   * （表格、仪表盘）没有能放大的矢量图，退回「新窗口打开」那条老路。
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
 * 消息底部的反馈按钮。
 * ericher 的发言：赞 / 踩 / 评论 —— 评价它答得好不好。
 * 我自己的发言：标重 / 评论 —— 自己夸自己没意义，但可以标重（要它重视）和评论。
 * 评论只显示条数，正文要点开才看得到。
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
   * 工具条上带内容的不藏：赞踩数、评论数、标重、正在念 —— 这些是消息的一部分。
   * 悬停才浮出只该发生在「什么都没有」的条上，不然数字会凭空消失又凭空回来。
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
              if (e.key === "Enter") void post();
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
 * 单条消息。memo 的理由和上面 Markdown 那条一样：流式期间每个 chunk 都会把整条列表
 * 重渲一次，不记住的话，十几条历史消息连同它们的赞踩栏、附件卡、思考折叠
 * 每帧都要重新走一遍 render。真正该重画的只有正在变的那一条。
 */
const Message = memo(function Message({
  m,
  streaming,
  thoughts,
  feedback,
  speaking,
  retry,
  showThinking,
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
  feedback: FeedbackSummary;
  speaking?: boolean;
  retry?: boolean;
  /** 访客不渲染思考过程 —— 思考里可能复述任何上下文，属于纵深防御 */
  showThinking: boolean;
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
        {/* ericher 的名字是一枚小号衬线标签；我的发言靠靠右这一下就认得出，不必再报名 */}
        {!mine && <div className="msg-label">ericher</div>}
        <div className="msg-body">
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
  speakingId,
  room,
  onSpeak,
  onRetry,
  onFlash,
}: {
  messages: UIMessage[];
  streaming: boolean;
  role: Role;
  /** 这一轮他在想什么（服务端隔几秒翻一句过来）。只在生成期间有 */
  thoughts: string[];
  speakingId?: string;
  /** 当前连着的屋。反馈（赞/踩/标重/评论）都得跟着它走 —— 消息住在场屋里 */
  room?: string;
  onSpeak?: (id: string, text: string) => void;
  onRetry?: (id: string) => void;
  onFlash: (text: string) => void;
}) {
  const [feedback, setFeedback] = useState<FeedbackSummary>({
    votes: {},
    comments: {},
    flags: [],
  });
  const [openId, setOpenId] = useState<string | null>(null);

  const reload = useCallback(() => {
    api
      .feedback(room)
      .then(setFeedback)
      .catch(() => {});
  }, [room]);

  // 消息数变化（新消息落库）与流式结束都要重拉：徽标跟着消息走
  useEffect(() => {
    reload();
  }, [reload, messages.length, streaming]);

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
        <p>和 ericher 说点什么吧…</p>
        <p className="meta">输入 /help 看他现在能做什么</p>
      </div>
    );
  }
  const last = messages.length - 1;
  const onAssistant = messages[last].role === "assistant";
  /**
   * 「重来」只挂最后一条助手消息。
   * 因为重来 = 从那条往后全部作废、重新生成：挂在中间某条上，等于顺手删掉后面
   * 一整段对话，而那个代价用户根本看不见。只留最后一条，代价就永远是他看得见的
   * 「刚才那句不算」。
   */
  let lastAssistant = -1;
  messages.forEach((m, i) => {
    if (m.role === "assistant") lastAssistant = i;
  });
  // 思考过程只给管理员看。访客的界面里整个跳过这个 part：
  // 思考里可能复述任何上下文，不渲染是最稳的一层 —— 就算哪天读路径松了，屏幕上也先不露。
  const showThinking = role === "admin";
  return (
    <>
      <div className="msg-list">
        {messages.map((m, i) => (
          <Message
            key={m.id}
            m={m}
            streaming={streaming && onAssistant && i === last}
            thoughts={i === lastAssistant ? thoughts : undefined}
            feedback={feedback}
            speaking={speakingId === m.id}
            retry={i === lastAssistant}
            showThinking={showThinking}
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
              <div className="msg-label">ericher</div>
              <div className="msg-body">
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
