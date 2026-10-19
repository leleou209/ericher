// 发件流水与收件箱在界面上的读法：全部是不碰 React、不碰接口、不碰 DOM 的纯规则。
//
// 为什么要外提：测试环境是 node，没有 jsdom —— 组件渲染一行都测不住。
// 「三个收件人该怎么折成一句」「字节数说到哪一档换成 MB」「后端给的未读总数和
// 清单里数出来的不一致时信谁」「原件没落盘 / 正文被裁 / 只有 HTML 这三个标记怎么合成
// 人话」这类判断只要写进 JSX 就等于没测过，改一句措辞就能悄悄把边界挪坏。
//
// 一条贯穿全文件的口径：**凡是后端给的原话（失败原因、note、正文），一律原样端出来，
// 不截、不改写、不重新措辞**。界面负责的是「说明这是什么」，不是替服务器说话 ——
// 把 535 认证失败念成「发送失败」，人就再也没法拿那串原话去查服务商的文档了。

import { addressListSummary } from "./mailForm";
import type { MailInRow, MailOutRow, MailSource } from "./types";

// ── 来路 ────────────────────────────────────────────

/** 来路的短标签（行上用）：名字定了就不许在面板里再写一份措辞 */
export const MAIL_SOURCE_LABEL: Record<MailSource, string> = {
  panel: "面板试发",
  tool: "ericher 寄的",
  say: "提醒/盯梢的副本",
};

/**
 * 来路的整句说明（弹页上用）：这一封为什么会被寄出去。
 * `say` 特意写成「离线副本」—— 它就是怕人不在界面前听不到才寄的。
 */
export const MAIL_SOURCE_SENTENCE: Record<MailSource, string> = {
  panel: "这一封是在接待台上按「发一封测试邮件」寄出去的。",
  tool: "这一封是 ericher 自己在对话里用寄信的工具寄的。",
  say: "这一封是提醒 / 盯梢到点时另寄的离线副本：界面里说过一遍，邮件再寄一份，人不在界面前也收得到。",
};

const isKnownSource = (source: string): source is MailSource =>
  Object.prototype.hasOwnProperty.call(MAIL_SOURCE_SENTENCE, source);

/**
 * 来源 → 中文标签。后端哪天新增一档来路（比如定时整理），界面不能崩、
 * 也不能把它说成上面三档里的任何一档：原样念出来，前面标「没听过的来路」。
 */
export const mailSourceLabel = (source: MailSource | string): string =>
  isKnownSource(source) ? MAIL_SOURCE_LABEL[source] : `来路「${source || "没记上"}」`;

/** 来源 → 整句说明；认不出来的来路只报告白，不编故事 */
export const mailSourceNote = (source: MailSource | string): string =>
  isKnownSource(source)
    ? MAIL_SOURCE_SENTENCE[source]
    : `后端记的来路是「${source}」，界面里还没这一档说法 —— 原样摆着，不替它编。`;

// ── 排序 ────────────────────────────────────────────

const atMs = (iso: string): number => {
  const t = Date.parse(iso ?? "");
  return Number.isFinite(t) ? t : 0;
};

/**
 * 按时刻倒序（最新在前）。时刻念不出来的行排在最后，而不是把整面卡住。
 * 后端回来的顺序已经是新的在前 —— 这里再排一遍是幂等的，
 * 为的是万一那侧改成升序，界面不至于把「三年前那封」顶在第一行。
 * 时刻相同的保持原序（拿原下标兜住），不靠 sort 的稳定性碰运气。
 */
export const rowsNewestFirst = <T extends { at: string }>(rows: readonly T[]): T[] =>
  rows
    .map((r, i) => ({ r, i }))
    .sort((a, b) => atMs(b.r.at) - atMs(a.r.at) || a.i - b.i)
    .map((x) => x.r);

// ── 两个面板共用的小措辞 ────────────────────────────

/** 主题空着不能说「空行」：一行没有主题的信很常见，得明说它是真没有 */
export const mailSubjectLabel = (subject: string): string =>
  subject.trim() ? subject.trim() : "（没有主题）";

/**
 * 收件人数组 → 摘要：一个就念那一个，多个折成「第一个 等 N 个」，
 * 一个也没有就说「收件人没记上」—— 后端有失败发生在写收件人之前，
 * 那种行确实一个地址都没有，留空行会让人以为是界面坏了。
 */
export const outToSummary = (to: readonly string[]): string =>
  addressListSummary(to) || "收件人没记上";

/** 这一封实际寄给谁（逐个列全用）：只丢空串，不动大小写与顺序 */
export const outRecipients = (row: MailOutRow): string[] =>
  (row.to ?? []).map((x) => (x ?? "").trim()).filter(Boolean);

// ── 发件箱 ──────────────────────────────────────────

/** 行上的成/败标记：两个字太冷，写成「没寄出去」才看得出这是坏消息 */
export const outFlagLabel = (row: MailOutRow): string =>
  row.ok ? "已寄出" : "没寄出去";

/** 行摘要：时刻 · 收件人（折叠）· 来路 —— 主题在标题那一行，不重复 */
export const outRowSummary = (row: MailOutRow, when: string): string =>
  [
    when || row.at || "时刻没记上",
    `收件 ${outToSummary(row.to)}`,
    mailSourceLabel(row.source),
  ].join(" · ");

/** 弹页里成/败那一行 */
export const outFlagSentence = (row: MailOutRow): string =>
  row.ok
    ? "这一封交出去了，服务商应了收件（寄出去 ≠ 对方一定看得见，垃圾邮件那关不在这里）。"
    : "这一封没寄出去：原因原文在下面。";

/**
 * 失败原因：原样返回后端给的那串，一个字符都不动。
 *
 * 为什么不做任何加工：那是 SMTP 服务器说的原话（`535 authentication failed`、
 * `451 temporary error, try later`、TLS 握手断在哪一步），人和排查笔记认的都是这串。
 * 折行、截短、翻译成「发送失败」都会把唯一线索弄丢 —— 尤其长报文，
 * 后面那半截往往才是真正的原因。空 error 才补一句「后端没给出原因」。
 */
export const outErrorText = (row: MailOutRow): string => {
  if (row.ok) return "";
  const raw = row.error ?? "";
  return raw.trim() ? raw : "后端没给出原因（error 是空串）";
};

/** 发件清单空着那句话：和「读不到」区分开 */
export const outboxFaceNote = (rows: readonly MailOutRow[]): string =>
  rows.length
    ? ""
    : "这台机器还没往外寄出过信 —— 在上面的发信账号里按「发一封测试邮件」，这里就会留下一行。";

// ── 字节数 ──────────────────────────────────────────

const KB = 1024;
const MB = KB * 1024;

/** 一位小数就够：收件箱里看的是量级，不是精确字节数（精确值在详情里另有原文） */
const round1 = (x: number): number => Math.round(x * 10) / 10;

/**
 * 整封报文的字节数说成人话：< 1024 用 B，到 1 MB 用 KB，再往上用 MB。
 *
 * 阈值按 1024 折（不是 1000）：后端记的是原始报文长度，跟桶里看到的量级要对得上。
 * 一封信带 base64 附件很容易就上 MB，所以 MB 这一档必须有，不然满屏「15360 KB」。
 * 负数、NaN、Infinity 这些拿不到账的情况明说「字节不明」，不折成一个像样的数糊过去。
 */
export const fmtBytes = (n: number): string => {
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return "字节不明";
  if (n < KB) return `${Math.round(n)} B`;
  if (n < MB) return `${round1(n / KB)} KB`;
  return `${round1(n / MB)} MB`;
};

// ── 收件箱：行 ──────────────────────────────────────

/**
 * 行上的发件人：有显示名就用显示名，没有落回地址，两个都没有才说「不知道谁寄的」。
 * 显示名是人家的自称（From 头里的一段），不能当地址用 —— 所以地址单独走 inRowFromAddr。
 */
export const inRowFromLabel = (row: MailInRow): string =>
  row.fromName.trim() || row.from.trim() || "不知道谁寄的";

/** 地址那一小段：已经用显示名当标题时才单独列出，否则不重复念一遍 */
export const inRowFromAddr = (row: MailInRow): string =>
  row.fromName.trim() ? row.from.trim() : "";

/** 行摘要：地址（有显示名时）· 主题 · 时刻 · 字节（· 带附件） */
export const inRowSummary = (row: MailInRow, when: string): string => {
  const parts = [
    inRowFromAddr(row),
    mailSubjectLabel(row.subject),
    when || row.at || "时刻没记上",
    fmtBytes(row.bytes),
  ];
  if (row.hasAttachment) parts.push("带附件");
  return parts.filter(Boolean).join(" · ");
};

/** 行上那颗常显控件的字：没读过的点「标已读」，读过的还能退回未读 */
export const readToggleLabel = (read: boolean): string =>
  read ? "标未读" : "标已读";

/** 那颗控件的 title：说清按下去会变成什么，不让人猜 */
export const readToggleTitle = (read: boolean): string =>
  read
    ? "这一封算看过了；点一下退回未读"
    : "这一封还没看过；点一下算看过（不会打开正文）";

/** 清单里数出来的未读封数 */
export const unreadFromRows = (rows: readonly MailInRow[]): number =>
  (rows ?? []).filter((r) => !r.read).length;

export interface UnreadReading {
  /** 面上要摆的那个数 */
  count: number;
  /** 两边对不上时要补的那一句；一致就空串 */
  note: string;
}

/**
 * 未读计数怎么读：后端那格 `unread` 是权威。
 *
 * 理由：它数的是全量账，而清单可能只回了最近若干行 —— 拿清单里的数当总数，
 * 一翻页就把「还有 40 封没看」念成「3 封」。清单里数出来的只用来兜底
 * （老后端没回这一格、或回的不是个数），并且两个数对不上时把差异摊开说出来，
 * 不悄悄挑一个。
 */
export const unreadReadOf = (
  rows: readonly MailInRow[],
  unread: unknown,
): UnreadReading => {
  const local = unreadFromRows(rows);
  const list = rows ?? [];
  if (typeof unread === "number" && Number.isFinite(unread) && unread >= 0) {
    if (unread === local) return { count: local, note: "" };
    return {
      count: unread,
      note: `后端记的是 ${unread} 封未读，这一页清单里数出来是 ${local} 封 —— 面上摆的是后端那个全量数（清单只回了最近 ${list.length} 行）。`,
    };
  }
  return {
    count: local,
    note: `后端没回未读总数，这个 ${local} 是按清单里这 ${list.length} 行数出来的，可能只是最近一段。`,
  };
};

/**
 * 收件面开头上那句话。
 *
 * 「开关没开」和「收件箱是空的」是两件事，必须分开说：前者是这台机器还没接收件通道
 * （外面寄来的信根本到不了这儿），后者是通道通了但还没人来。混成一句
 * 「收件箱是空的」会让人以为自己配错了地址，其实那档开关还关着。
 */
export const inboxFaceNote = (
  enabled: boolean,
  rows: readonly MailInRow[],
): string => {
  if (enabled)
    return rows.length ? "" : "通道开着，还没收到信 —— 清单是空的。";
  return rows.length
    ? "还没接收件通道（收信落库是关的）：下面这些是以前落下来的那几封，不会再有新的。"
    : "还没接收件通道：收信落库没打开，外面寄来的信进不来。这不是「收件箱是空的」—— 开关在邮件设置那行上。";
};

/** 收信开关没开时，未读数照摆但要说清它是旧账：新信这会儿进不来 */
export const inboxUnreadLabel = (enabled: boolean, count: number): string =>
  enabled ? `未读 ${count}` : `未读 ${count}（通道还没接，这是旧账）`;

// ── 收件详情：三个「这封看不全」的标记 ─────────────

/**
 * 后端契约里 MailInRow 只有 emlKey，没有 truncated / htmlOnly ——
 * 那两个标记住在解析器输出里，随正文一起回来时可能挂在行上、也可能只写在 note 里。
 * 这里先收行上明写的布尔值，没有才去 note 里找关键词；两条都没有就不下结论。
 */
type MarkerCarrier = MailInRow & { truncated?: unknown; htmlOnly?: unknown };

const explicitFlag = (row: MailInRow, key: "truncated" | "htmlOnly"): boolean | null => {
  const v = (row as MarkerCarrier)[key];
  return typeof v === "boolean" ? v : null;
};

/** note 里出现这些字样就算「正文被裁过」 */
const TRUNCATED_RE = /裁|截断|截掉|截了|truncat/i;
/** note 里提到 HTML 就算「这封只有 HTML」 */
const HTML_ONLY_RE = /html/i;

export interface MailReadMarkers {
  /** 原件没落盘：只有头部摘要，正文读不到 */
  onlySummary: boolean;
  /** 正文被上限裁过：下面贴的不是全文 */
  truncated: boolean;
  /** 这封只有 HTML，现在看到的是剥了标签的文字 */
  htmlOnly: boolean;
}

/**
 * 三个标记的合成规则（顺序也是详情里说的顺序）：
 * 1. `emlKey` 为空 = 原件没落到这台机器上，只能看摘要 —— 这条只看行上的字段，
 *    它是契约里明写的事实，不受 note 措辞影响；
 * 2. truncated / htmlOnly 先看行上有没有布尔字段（后端哪天直接挂出来就照单收），
 *    没有才读 note 的原话。
 */
export const readMarkersOf = (row: MailInRow, note = ""): MailReadMarkers => {
  const n = note ?? "";
  const t = explicitFlag(row, "truncated");
  const h = explicitFlag(row, "htmlOnly");
  return {
    onlySummary: !(row.emlKey ?? "").trim(),
    truncated: t ?? TRUNCATED_RE.test(n),
    htmlOnly: h ?? HTML_ONLY_RE.test(n),
  };
};

/**
 * 标记 → 说给人的话。三条各一句，按「先说能拿到什么、再说为什么拿不到」排。
 * 返回空数组 = 这封是完整的纯文本，界面就不必再多嘴。
 */
export const markerSentences = (m: MailReadMarkers): string[] => {
  const out: string[] = [];
  if (m.onlySummary)
    out.push(
      "这一封只有摘要：原件（emlKey）没落到这台机器上，正文取不到 —— 能看到的就是头部里那一段，不是「信是空的」。",
    );
  if (m.truncated)
    out.push("正文被裁过：下面贴出来的不是全文，超出上限的那一段在入库时就已经丢了。");
  if (m.htmlOnly)
    out.push(
      "这封只有 HTML、没有 text/plain：下面看到的是剥掉标签的文字，排版和原信不一样，图片与样式都不在。",
    );
  return out;
};

export interface ReadBody {
  /** 要原样贴在 <pre> 里的纯文本（永不注入 HTML） */
  body: string;
  /** 拿不到正文时补的那一句；拿得到就空串 */
  missing: string;
}

/**
 * 详情里贴哪一段：后端给的正文优先；正文空着才退回清单里带回来的 preview，
 * 并说明那只是开头一段。两个都空就明说没有，不摆一个空白框当「读完了」。
 */
export const readBodyOf = (text: string, row: MailInRow): ReadBody => {
  const t = text ?? "";
  if (t.trim()) return { body: t, missing: "" };
  const p = (row.preview ?? "").trim();
  if (p)
    return {
      body: row.preview,
      missing: "正文这次没读到，下面这段是清单里带回来的开头一段，不是全文。",
    };
  return { body: "", missing: "这一封没有可读的正文：原件没落盘，头部摘要里也没留下文字。" };
};

/** 详情副标题：一行把这封的账报完（收件对象 + 字节） */
export const inDetailSummary = (row: MailInRow, when: string): string => {
  const to = (row.to ?? "").trim();
  return [
    when || row.at || "时刻没记上",
    to ? `寄到 ${to}` : "寄到谁那儿没记上",
    fmtBytes(row.bytes),
    row.hasAttachment ? "带附件" : "",
  ]
    .filter(Boolean)
    .join(" · ");
};

// ── 附件清单 ────────────────────────────────────────
//
// 库里那一格只有名字与大小（内容在 R2 的原件里），所以这里**永远不说"可下载"**，
// 也不把"带附件"和"有清单"混成一件事：老行只有前者。

export const attachCount = (row: MailInRow): number => row.attachments?.length ?? 0;

/** 行上那一句 */
export const attachSummary = (row: MailInRow): string => {
  const n = attachCount(row);
  if (n) return `附件 ${n} 件`;
  return row.hasAttachment ? "带附件（清单没记名）" : "";
};

/** 详情里逐条列出：名字 + 大小。条目本身缺字段也不该把整封信的读信面弄崩 */
export const attachLines = (row: MailInRow): string[] =>
  (row.attachments ?? []).map((a) => {
    const name = String(a?.name ?? "").trim();
    return `${name || "（没报名字）"} · ${fmtBytes(Number(a?.bytes ?? -1))}`;
  });

// ── 左列搜索 ────────────────────────────────────────
//
// 口径先说死：筛的是**清单里已经有的字段**（收件这侧是发件人名/地址/主题/摘要/附件名，
// 寄件这侧是主题/收件人/失败原因/来路）。正文在云盘的原件里，不在清单上，
// 所以占位符不许写"搜正文" —— 写了就是让人对着一个不做的事搜。

export const normalizeQuery = (q: string): string => q.trim().toLowerCase();

export const inRowMatches = (row: MailInRow, q: string): boolean => {
  const k = normalizeQuery(q);
  if (!k) return true;
  return [
    row.fromName,
    row.from,
    row.subject,
    row.preview,
    ...(row.attachments ?? []).map((a) => a.name),
  ]
    .join("\n")
    .toLowerCase()
    .includes(k);
};

export const outRowMatches = (row: MailOutRow, q: string): boolean => {
  const k = normalizeQuery(q);
  if (!k) return true;
  return [row.subject, ...row.to, row.error, mailSourceLabel(row.source)]
    .join("\n")
    .toLowerCase()
    .includes(k);
};

/** 空查询原样返回同一个数组（不复制一份，免得调用方拿引用比较时以为变了） */
export const filterInRows = (rows: readonly MailInRow[], q: string): MailInRow[] =>
  normalizeQuery(q) ? rows.filter((r) => inRowMatches(r, q)) : [...rows];

export const filterOutRows = (
  rows: readonly MailOutRow[],
  q: string,
): MailOutRow[] => (normalizeQuery(q) ? rows.filter((r) => outRowMatches(r, q)) : [...rows]);

export const searchPlaceholder = (kind: "in" | "out"): string =>
  kind === "in" ? "搜发件人、主题、摘要或附件名" : "搜主题、收件人、失败原因或来路";

/**
 * 空列表那句话：筛空了与本来就没有，是两件完全不同的事。
 * 混成一句"还没有信进来"，人就会去查通道，而真相是他刚打了个错字。
 */
export const emptyListNote = (
  kind: "in" | "out",
  q: string,
  total: number,
  extra = "",
): string => {
  const k = normalizeQuery(q);
  if (k) return `没有和「${q.trim()}」对得上的（清单里一共 ${total} 封）`;
  if (extra) return extra;
  return kind === "in" ? "还没有信进来" : "还没往外寄过东西";
};
