import { useMemo, useRef, type ReactNode } from "react";

/**
 * 正文编辑器：等宽字 + HTML 词法着色，外带一份「改了哪几行」的比对。
 *
 * 高亮不引库：正文是整页 HTML，扫一遍注释 / 声明 / 标签 / 属性就够看了 ——
 * 上色只是为了让人一眼分出「这是标签、那是正文」，不求编辑器级精确。
 *
 * 做法是经典的两层叠放：底下一层 <pre> 摆着色后的文本，上面一层 <textarea>
 * 透明字、只留光标与选区。两层字体、行高、内边距、换行规则必须一模一样，否则
 * 一个字都错位 —— 所以不折行（wrap="off"），长行靠横向滚动对齐。
 */

type Tok = "text" | "comment" | "decl" | "tag" | "attr" | "str";

interface Piece {
  t: Tok;
  v: string;
}

/** 标签内部的属性：名字 / 等号 / 值（值可带引号，也可裸写） */
const ATTR_RE = /([a-zA-Z_:][\w:.-]*)(\s*=\s*)("[^"]*"|'[^']*'|[^\s"'=<>`]+)?/g;

/** 把一段 HTML 切成「上色片段」。不认识的东西一律当正文，绝不吞字 */
export function tokenize(src: string): Piece[] {
  const out: Piece[] = [];
  const push = (t: Tok, v: string) => {
    if (v) out.push({ t, v });
  };
  let i = 0;
  while (i < src.length) {
    const lt = src.indexOf("<", i);
    if (lt < 0) {
      push("text", src.slice(i));
      break;
    }
    if (lt > i) push("text", src.slice(i, lt));

    // 注释与声明各吃一整段
    if (src.startsWith("<!--", lt)) {
      const end = src.indexOf("-->", lt + 4);
      const at = end < 0 ? src.length : end + 3;
      push("comment", src.slice(lt, at));
      i = at;
      continue;
    }
    if (src.startsWith("<!", lt)) {
      const end = src.indexOf(">", lt);
      const at = end < 0 ? src.length : end + 1;
      push("decl", src.slice(lt, at));
      i = at;
      continue;
    }

    const end = src.indexOf(">", lt);
    if (end < 0) {
      // 没闭合的半个标签：剩下的全是正文，不硬凑
      push("text", src.slice(lt));
      break;
    }
    const raw = src.slice(lt, end + 1);
    const m = /^(<\/?)([a-zA-Z][\w:-]*)([\s\S]*?)(\/?>)$/.exec(raw);
    if (!m) {
      push("tag", raw);
      i = end + 1;
      continue;
    }
    push("tag", m[1]);
    push("tag", m[2]);
    const attrs = m[3];
    let last = 0;
    ATTR_RE.lastIndex = 0;
    let am: RegExpExecArray | null;
    while ((am = ATTR_RE.exec(attrs))) {
      push("text", attrs.slice(last, am.index));
      push("attr", am[1]);
      if (am[2]) push("text", am[2]);
      if (am[3]) push("str", am[3]);
      last = ATTR_RE.lastIndex;
    }
    push("text", attrs.slice(last));
    push("tag", m[4]);
    i = end + 1;
  }
  return out;
}

function painted(pieces: Piece[]): ReactNode[] {
  return pieces.map((p, i) =>
    p.t === "text" ? (
      <span key={i}>{p.v}</span>
    ) : (
      <span key={i} className={`tok-${p.t}`}>
        {p.v}
      </span>
    ),
  );
}

export function HtmlEditor({
  value,
  onChange,
  disabled,
  rows = 14,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  rows?: number;
  placeholder?: string;
}) {
  const taRef = useRef<HTMLTextAreaElement>(null);
  const preRef = useRef<HTMLPreElement>(null);

  /**
   * 着色后的那一层。按 value 缓存 —— 不缓存的话每次 render 都要把整页正文
   * 重扫一遍（上限 2MB），敲一个字等的就是这一下的账。
   */
  const paintedNodes = useMemo(() => painted(tokenize(value)), [value]);

  /** 两层一起滚：textarea 滚到哪，高亮层跟到哪 */
  const sync = () => {
    const ta = taRef.current;
    const pre = preRef.current;
    if (!ta || !pre) return;
    pre.scrollTop = ta.scrollTop;
    pre.scrollLeft = ta.scrollLeft;
  };

  return (
    <div className="hx-editor">
      <pre className="hx-pre" ref={preRef} aria-hidden="true">
        {paintedNodes}
        {"\n"}
      </pre>
      <textarea
        className="hx-ta"
        ref={taRef}
        value={value}
        disabled={disabled}
        spellCheck={false}
        wrap="off"
        rows={rows}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        onScroll={sync}
      />
    </div>
  );
}

// ── 改动比对 ────────────────────────────────────────────

export interface DiffLine {
  kind: "same" | "add" | "del";
  text: string;
}

/** 超过这个行数就懒得分了：LCS 是 O(n·m)，长页不划算 */
const DIFF_CAP = 1200;

/**
 * 行级比对：先剥掉首尾相同的一大截，剩下的用 LCS 找最长公共子序列，
 * 再照着它把行标成「原样 / 新增 / 删除」。超长返回 null，由界面降级成整篇确认。
 */
export function diffLines(a: string, b: string): DiffLine[] | null {
  const A = a.split("\n");
  const B = b.split("\n");
  if (A.length > DIFF_CAP || B.length > DIFF_CAP) return null;

  // 首尾相同段先摘掉：HTML 改一处往往只动一小块，剥完中间往往就没几行了
  let head = 0;
  while (head < A.length && head < B.length && A[head] === B[head]) head++;
  let tail = 0;
  while (
    tail < A.length - head &&
    tail < B.length - head &&
    A[A.length - 1 - tail] === B[B.length - 1 - tail]
  )
    tail++;

  const midA = A.slice(head, A.length - tail);
  const midB = B.slice(head, B.length - tail);
  const n = midA.length;
  const m = midB.length;

  // dp[i][j] = midA[i..] 与 midB[j..] 的最长公共子序列长度；只留表，回溯时倒着走
  const dp: Uint16Array[] = [];
  for (let i = 0; i <= n; i++) dp.push(new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i][j] =
        midA[i] === midB[j]
          ? dp[i + 1][j + 1] + 1
          : Math.max(dp[i + 1][j], dp[i][j + 1]);

  const mid: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (midA[i] === midB[j]) {
      mid.push({ kind: "same", text: midA[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      mid.push({ kind: "del", text: midA[i] });
      i++;
    } else {
      mid.push({ kind: "add", text: midB[j] });
      j++;
    }
  }
  while (i < n) mid.push({ kind: "del", text: midA[i++] });
  while (j < m) mid.push({ kind: "add", text: midB[j++] });

  return [
    ...A.slice(0, head).map((t) => ({ kind: "same" as const, text: t })),
    ...mid,
    ...A.slice(A.length - tail).map((t) => ({ kind: "same" as const, text: t })),
  ];
}

/** 改动的比对结果：一行一行摆出来，加了什么、去了什么一眼可见 */
export function DiffView({ lines }: { lines: DiffLine[] }) {
  const added = lines.filter((l) => l.kind === "add").length;
  const removed = lines.filter((l) => l.kind === "del").length;
  return (
    <div className="hx-diff">
      <div className="hx-diff-head">
        <span className="hx-diff-add">+{added}</span>
        <span className="hx-diff-del">−{removed}</span>
        <span className="dim">（未改动的行也一并在列，好对上下文）</span>
      </div>
      <pre className="hx-diff-body">
        {lines.map((l, i) => (
          <div key={i} className={`hx-line ${l.kind}`}>
            <span className="hx-sign">
              {l.kind === "add" ? "+" : l.kind === "del" ? "−" : " "}
            </span>
            <span className="hx-text">{l.text}</span>
          </div>
        ))}
      </pre>
    </div>
  );
}
