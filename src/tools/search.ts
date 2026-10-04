// 联网搜索、正文抓取与轻量微浏览器。
//
// 三层能力，按「想知道什么」分工：
//   search    —— 我还不知道在哪个网页上，先搜出候选
//   read_url  —— 我已经知道是哪一页，只要那一页的正文
//   browse    —— 我要在一个站里走一走：看它有什么、页面上能点去哪
//
// 搜索走哪家由 search_config 表说了算（Tavily / Brave，设置页可配）：
// 配了 key 就走配置的通道，没配（或通道挂了）退化为 DuckDuckGo 免 key 通道——
// 否则「不确定的我就先搜一下」在没配 key 的环境里就是一句空头承诺。
// 正文抓取的付费档只认 Tavily extract（Brave 没有抓取接口）；
// 抓取本身退化为受控直连 + 正文抽取，抽取结果太少再试 Jina Reader
// （它能执行 JS，覆盖前端渲染的站）。

import { tool } from "ai";
import puppeteer from "@cloudflare/puppeteer";
import { z } from "zod";
import type { SearchConfig } from "../agent/searchConfigs";
import { DEFAULT_SEARCH_CONFIG } from "../agent/searchConfigs";
import type { ToolCtx } from "./types";

const TAVILY_SEARCH = "https://api.tavily.com/search";
const TAVILY_EXTRACT = "https://api.tavily.com/extract";
const BRAVE_SEARCH = "https://api.search.brave.com/res/v1/web/search";
const JINA_READER = "https://r.jina.ai/";
const MAX_CHARS = 6000;
const UA = "Mozilla/5.0 (compatible; CoworkAgent/2.0)";

const PRIVATE_HOST =
  /^(localhost|127\.|0\.0\.0\.0|10\.|192\.168\.|169\.254\.|::1$|\[::1\]$|.*\.internal$|.*\.local$|metadata\.google\.internal$)/i;

/** 协议白名单 + 私网黑名单，防止工具被诱导去读内网 / 云元数据端点 */
export function assertPublicUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("URL 格式不合法: " + raw);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("只允许 http/https，拒绝: " + url.protocol);
  }
  const host = url.hostname.toLowerCase();
  if (PRIVATE_HOST.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host)) {
    throw new Error("拒绝访问私网地址: " + host);
  }
  return url;
}

// ── 正文抽取 ──────────────────────────────────────────

/** 常见实体解码。只处理真会出现在正文里的那些，不做完整 HTML 解析。 */
function decodeEntities(s: string): string {
  const named: Record<string, string> = {
    nbsp: " ",
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    mdash: "—",
    ndash: "–",
    hellip: "…",
    times: "×",
    middot: "·",
    laquo: "«",
    raquo: "»",
    ldquo: "“",
    rdquo: "”",
    lsquo: "‘",
    rsquo: "’",
  };
  return s
    .replace(/&([a-z]+);/gi, (m, n: string) => named[n.toLowerCase()] ?? m)
    .replace(/&#(\d+);/g, (_m, d: string) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, h: string) =>
      String.fromCharCode(parseInt(h, 16)),
    );
}

function textOf(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, " "))
    .replace(/[ \t\u00a0]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * 把 HTML 收成可读正文。
 * 思路是 readability 的简化版：先扔脚本 / 导航 / 页脚，再优先取 <article>/<main>，
 * 没有的话退一步只用 <p> 段落——这两步能覆盖绝大多数内容站，
 * 剩下的交给「标签转换行」把结构保住。
 */
export function extractMain(html: string): string {
  let body = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(
      /<(script|style|noscript|svg|canvas|iframe|form|template|head)[\s\S]*?<\/\1>/gi,
      "",
    )
    .replace(/<(nav|footer|header|aside)[\s\S]*?<\/\1>/gi, "");

  const container = /<(article|main)\b[^>]*>([\s\S]*?)<\/\1>/i.exec(body);
  if (container) {
    body = container[2];
  } else {
    const paras = [...body.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)].map(
      (m) => m[1],
    );
    if (textOf(paras.join("\n")).length > 400) body = paras.join("\n\n");
  }

  const withBreaks = body
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|section|blockquote|tr|li|h[1-6])>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "· ")
    .replace(
      /<h([1-6])\b[^>]*>/gi,
      (_m, n: string) => "\n" + "#".repeat(Number(n)) + " ",
    );

  return textOf(withBreaks);
}

function extractTitle(html: string): string {
  const og =
    /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i.exec(
      html,
    );
  const t = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return textOf(og?.[1] || t?.[1] || "");
}

/** 页面上的外链。模型拿到它才能决定「下一层点哪里」。 */
function extractLinks(
  html: string,
  base: URL,
  limit: number,
): Array<{ text: string; href: string }> {
  const out: Array<{ text: string; href: string }> = [];
  const seen = new Set<string>();
  for (const m of html.matchAll(
    /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
  )) {
    const raw = m[1].trim();
    if (
      !raw ||
      raw.startsWith("#") ||
      /^(javascript|mailto|tel|data):/i.test(raw)
    )
      continue;
    let u: URL;
    try {
      u = new URL(raw, base);
    } catch {
      continue;
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") continue;
    u.hash = "";
    const href = u.toString();
    if (seen.has(href)) continue;
    const text = textOf(m[2]).replace(/\s+/g, " ");
    if (text.length < 2) continue;
    seen.add(href);
    out.push({ text: text.slice(0, 60), href });
    if (out.length >= limit) break;
  }
  return out;
}

// ── 抓取通道 ──────────────────────────────────────────

interface TavilySearchResponse {
  answer?: string;
  results?: Array<{
    title?: string;
    url?: string;
    content?: string;
    published_date?: string;
  }>;
}

interface TavilyExtractResponse {
  results?: Array<{ url?: string; raw_content?: string }>;
  failed_results?: Array<{ url?: string; error?: string }>;
}

async function tavily(
  path: string,
  body: Record<string, unknown>,
  key: string,
): Promise<unknown> {
  const r = await fetch(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + key,
    },
    body: JSON.stringify(body),
  });
  if (!r.ok)
    throw new Error(`Tavily ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

// ── Brave 通道 ─────────────────────────────────────────
//
// Brave Search API：GET 一次、X-Subscription-Token 头带钥匙，没有摘要生成
// 但结果快、独立索引。freshness 是它的时间过滤记号（pd/pw/pm/py），
// 和 Tavily 的 time_range 用词不同，在这层翻译。

interface BraveResponse {
  web?: {
    results?: Array<{
      title?: string;
      url?: string;
      description?: string;
      age?: string;
    }>;
  };
}

/** Brave 的 freshness 记号。给了 timeRange 就翻译，没给不传（默认全时段） */
export function braveFreshness(
  t?: "day" | "week" | "month" | "year",
): string | null {
  switch (t) {
    case "day":
      return "pd";
    case "week":
      return "pw";
    case "month":
      return "pm";
    case "year":
      return "py";
    default:
      return null;
  }
}

/** 跑一次 Brave 网页搜索，收成和 Tavily 同形的条目列表（title/url/content） */
export async function braveSearch(
  query: string,
  key: string,
  maxResults: number,
  timeRange?: "day" | "week" | "month" | "year",
): Promise<FreeHit[]> {
  const u = new URL(BRAVE_SEARCH);
  u.searchParams.set("q", query);
  u.searchParams.set("count", String(Math.min(Math.max(maxResults, 1), 20)));
  const fresh = braveFreshness(timeRange);
  if (fresh) u.searchParams.set("freshness", fresh);
  const r = await fetch(u, {
    headers: {
      Accept: "application/json",
      "X-Subscription-Token": key,
      "User-Agent": UA,
    },
  });
  if (!r.ok)
    throw new Error(`Brave ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const d = (await r.json()) as BraveResponse;
  return (d.web?.results || [])
    .filter((x) => x.url)
    .map((x) => ({
      title: x.title || x.url!,
      url: x.url!,
      content: x.description || "",
    }));
}

/** Jina Reader：前端渲染的站直接抓是空壳，这里让它替我们把页面跑一遍 */
async function jinaRead(target: string): Promise<string> {
  try {
    const r = await fetch(JINA_READER + target, {
      headers: { "User-Agent": UA, Accept: "text/plain" },
    });
    if (!r.ok) return "";
    return (await r.text()).trim();
  } catch {
    return "";
  }
}

/** 直连抓取。返回原始 HTML，抽取交给调用方（browse 还要用同一份 HTML 取链接）。 */
async function directFetch(target: string): Promise<string> {
  const r = await fetch(target, {
    headers: { "User-Agent": UA, Accept: "text/html,*/*" },
    redirect: "follow",
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.text();
}

const clipped = (s: string) =>
  s.slice(0, MAX_CHARS) + (s.length > MAX_CHARS ? "\n\n[已截断]" : "");

// ── 免 key 搜索通道 ────────────────────────────────────
//
// 只在没配 TAVILY_API_KEY（或 Tavily 挂了）时启用。它是「能用」而不是「好用」：
// 摘要短、偶尔抽风，所以结果里会标明来源，让模型自己决定要不要 read_url 深挖。

interface FreeHit {
  title: string;
  url: string;
  content: string;
}

/** DuckDuckGo 的结果链接是 //duckduckgo.com/l/?uddg=<真实地址> 的跳转，得还原，否则模型读不了 */
function unddg(raw: string): string {
  const href = decodeEntities(raw).trim();
  if (!href) return "";
  try {
    const u1 = new URL(href.startsWith("//") ? "https:" + href : href);
    const real = u1.searchParams.get("uddg");
    if (real) return real; // 广告位 / 站内链接没有 uddg，直接丢弃
    if (u1.hostname.endsWith("duckduckgo.com")) return "";
    // 少数直链结果（如维基站外截图），u1 已是真实地址
    return u1.protocol === "http:" || u1.protocol === "https:"
      ? u1.toString()
      : "";
  } catch {
    return "";
  }
}

/** 域名是否落在某个过滤域里（含子域） */
function hostMatch(url: string, domain: string): boolean {
  try {
    const h = new URL(url).hostname.toLowerCase();
    const d = domain.toLowerCase().replace(/^\.+/, "");
    return h === d || h.endsWith("." + d);
  } catch {
    return false;
  }
}

/**
 * 解析 DDG 的结果页。两个端点的差异（都实测确认过）：
 *   html —— <a class="result__a">标题</a>，摘要也是 <a class="result__snippet">
 *   lite —— <a class="result-link">标题</a>，摘要是 <td class="result-snippet">
 * 属性顺序两边还不一样，所以先按 <a> 标签整体切、再看里面有没有结果类名，
 * 摘要的闭合标签用反向引用跟着开标签走——写死 </a> 会跨条目把下一条吞进来。
 */
function parseDdg(html: string, limit: number): FreeHit[] {
  // 只有「结果标题」链接才是条目起点，广告和站内链接在这一步就会被 unddg 丢掉
  const heads = [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)].filter(
    (m) => /(result__a|result-link)/i.test(m[1]),
  );
  const out: FreeHit[] = [];
  for (let i = 0; i < heads.length && out.length < limit; i++) {
    const m = heads[i];
    const url = unddg(/href=["']([^"']+)["']/i.exec(m[1])?.[1] || "");
    if (!url) continue;
    // 摘要在「下一条结果」之前找，不能见到下一个 <a> 就收——html 端点的摘要自己就是一个 <a>
    const end =
      i + 1 < heads.length ? (heads[i + 1].index ?? html.length) : html.length;
    const seg = html.slice((m.index ?? 0) + m[0].length, end);
    const sn =
      /<(a|td)\b[^>]*class=["'][^"']*(?:result__snippet|result-snippet)[^"']*["'][^>]*>([\s\S]*?)<\/\1>/i.exec(
        seg,
      );
    out.push({
      title: textOf(m[2]) || url,
      url,
      content: sn ? textOf(sn[2]) : "",
    });
  }
  return out;
}

/** DDG 结果页。html 端点结果更全，lite 端点更轻，互为备份。 */
async function ddgSearch(
  query: string,
  limit: number,
  timeRange?: string,
): Promise<FreeHit[]> {
  const form = new URLSearchParams({ q: query, kl: "wt-wt" });
  if (timeRange) {
    form.set(
      "df",
      timeRange === "day"
        ? "d"
        : timeRange === "week"
          ? "w"
          : timeRange === "month"
            ? "m"
            : "y",
    );
  }
  const body = form.toString();
  const headers = {
    "User-Agent": UA,
    "Content-Type": "application/x-www-form-urlencoded",
  };
  const endpoints = [
    "https://html.duckduckgo.com/html/",
    "https://lite.duckduckgo.com/lite/",
  ];
  let lastErr = "";
  for (const ep of endpoints) {
    try {
      const r = await fetch(ep, { method: "POST", headers, body });
      if (!r.ok) {
        lastErr = `DuckDuckGo ${r.status}`;
        continue;
      }
      const hits = parseDdg(await r.text(), limit);
      if (hits.length) return hits;
      lastErr = "结果页里没解析出条目";
    } catch (e) {
      lastErr = (e as Error).message;
    }
  }
  throw new Error(lastErr || "DuckDuckGo 不可用");
}

/** 最后一道兜底：DDG 即时问答。查「某某是什么」常直接给答案，但覆盖面很窄。 */
async function ddgInstant(query: string): Promise<string> {
  try {
    const r = await fetch(
      `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`,
      { headers: { "User-Agent": UA } },
    );
    if (!r.ok) return "";
    const d = (await r.json()) as {
      Answer?: string;
      AbstractText?: string;
      AbstractURL?: string;
      AbstractSource?: string;
      Definition?: string;
      RelatedTopics?: Array<{ Text?: string; FirstURL?: string }>;
    };
    const parts: string[] = [];
    if (d.Answer) parts.push(`💡 ${d.Answer}`);
    if (d.AbstractText)
      parts.push(
        `${d.AbstractText}\n🔗 ${d.AbstractURL || ""} ${d.AbstractSource || ""}`.trim(),
      );
    if (d.Definition) parts.push(`定义：${d.Definition}`);
    const rel = (d.RelatedTopics || []).filter((t) => t.Text).slice(0, 5);
    if (rel.length)
      parts.push("相关：\n" + rel.map((t) => `· ${t.Text}`).join("\n"));
    return parts.join("\n\n").trim();
  } catch {
    return "";
  }
}

/**
 * 维基百科检索。免 key、返回 JSON、不会被反爬拦——是唯一一条我敢保证
 * 「在 Worker 里一定调得通」的通道。代价是只覆盖百科类问题，所以只当第二手。
 */
async function wikiSearch(query: string, limit: number): Promise<FreeHit[]> {
  const out: FreeHit[] = [];
  for (const host of ["zh.wikipedia.org", "en.wikipedia.org"]) {
    try {
      const api =
        `https://${host}/w/api.php?action=query&list=search&format=json&utf8=1` +
        `&srlimit=${limit}&srsearch=${encodeURIComponent(query)}`;
      const r = await fetch(api, {
        headers: { "User-Agent": UA, Accept: "application/json" },
      });
      if (!r.ok) continue;
      const d = (await r.json()) as {
        query?: { search?: Array<{ title?: string; snippet?: string }> };
      };
      for (const it of d.query?.search || []) {
        if (!it.title) continue;
        out.push({
          title: it.title,
          url: `https://${host}/wiki/${encodeURIComponent(it.title.replace(/\s+/g, "_"))}`,
          content: it.snippet ? textOf(it.snippet) : "",
        });
        if (out.length >= limit) return out;
      }
    } catch {
      // 这个语言不通就换下一个
    }
  }
  return out;
}

/** 免 key 检索：DDG 结果 → 维基兜底 → 即时问答，中间统一过域名过滤 */
async function freeSearch(a: {
  query: string;
  maxResults: number;
  timeRange?: "day" | "week" | "month" | "year";
  includeDomains?: string[];
  excludeDomains?: string[];
}): Promise<string> {
  let hits: FreeHit[] = [];
  let channel = "DuckDuckGo";
  let channelErr = "";
  try {
    hits = await ddgSearch(a.query, Math.max(a.maxResults * 2, 8), a.timeRange);
  } catch (e) {
    channelErr = (e as Error).message;
  }
  if (!hits.length) {
    hits = await wikiSearch(a.query, a.maxResults);
    if (hits.length) channel = "维基百科";
  }

  if (a.includeDomains?.length) {
    const allow = a.includeDomains;
    hits = hits.filter((h) => allow.some((d) => hostMatch(h.url, d)));
  }
  if (a.excludeDomains?.length) {
    const deny = a.excludeDomains;
    hits = hits.filter((h) => !deny.some((d) => hostMatch(h.url, d)));
  }
  hits = hits.slice(0, a.maxResults);

  if (!hits.length) {
    const instant = await ddgInstant(a.query);
    if (instant) return `💡 即时问答（DuckDuckGo）：\n\n${instant}`;
    const why = channelErr
      ? `（免费通道报错：${channelErr}）`
      : "（免费通道，可能是关键词太窄）";
    return `未找到「${a.query}」的相关信息${why}。`;
  }

  const lines = hits.map((h, i) => {
    const snip = h.content ? h.content.slice(0, 400) : "(无摘要)";
    return `${i + 1}. ${h.title}\n${snip}\n🔗 ${h.url}`;
  });
  return (
    `（免费通道：${channel}，只有摘要没有全文；要细节就 read_url 打开其中一条）\n\n` +
    lines.join("\n\n")
  );
}

/** 域名白/黑名单过滤 + 截到条数上限。付费通道共用这一套（免费通道在 freeSearch 内联） */
function filterHits(
  hits: FreeHit[],
  a: {
    includeDomains?: string[];
    excludeDomains?: string[];
    maxResults?: number;
  },
): FreeHit[] {
  let out = hits;
  if (a.includeDomains?.length) {
    const allow = a.includeDomains;
    out = out.filter((h) => allow.some((d) => hostMatch(h.url, d)));
  }
  if (a.excludeDomains?.length) {
    const deny = a.excludeDomains;
    out = out.filter((h) => !deny.some((d) => hostMatch(h.url, d)));
  }
  return a.maxResults ? out.slice(0, a.maxResults) : out;
}

/**
 * 跑一次检索，返回给人看的文本。
 * 抽成普通函数是因为「盯梢」也要用同一套——两处各写一份，早晚会走偏。
 *
 * 通道由 cfg 决定（search_config 表）：Tavily / Brave 配了钥匙就走；
 * 通道挂了或没配钥匙，静默退到免费通道，别让一次搜索失败打断整轮对话。
 */
export async function runSearch(
  env: Env,
  a: {
    query: string;
    depth?: "basic" | "advanced" | "fast" | "ultra-fast";
    topic?: "general" | "news" | "finance";
    maxResults?: number;
    timeRange?: "day" | "week" | "month" | "year";
    includeDomains?: string[];
    excludeDomains?: string[];
  },
  cfg: SearchConfig = DEFAULT_SEARCH_CONFIG,
): Promise<string> {
  const maxResults = a.maxResults ?? 5;
  const vars = env as unknown as Record<string, string | undefined>;
  const key = cfg.keySecret ? vars[cfg.keySecret] : undefined;
  // 兜底要留痕：key 压根没接上 / 通道挂了 / 空手而归，都退到免费通道 ——
  // 但静默退法让人只能对着结果猜「是不是 key 没调度」。返回文本里带一句为什么，
  // 她会顺着念给用户听，问题当场现形
  let fallbackWhy = key
    ? ""
    : `（备注：主通道没接上 —— 配置的 keySecret「${cfg.keySecret || "空"}」在这台机器上没有对应的 secret，本次走免费通道）`;
  if (key && cfg.format === "tavily") {
    const body: Record<string, unknown> = {
      query: a.query,
      search_depth: a.depth ?? "basic",
      topic: a.topic ?? "general",
      max_results: maxResults,
      include_answer: true,
    };
    if (a.timeRange) body.time_range = a.timeRange;
    if (a.includeDomains?.length) body.include_domains = a.includeDomains;
    if (a.excludeDomains?.length) body.exclude_domains = a.excludeDomains;
    try {
      const data = (await tavily(
        TAVILY_SEARCH,
        body,
        key,
      )) as TavilySearchResponse;
      const results = data.results || [];
      if (results.length) {
        const lines = results.map((r, i) => {
          const when = r.published_date
            ? ` (${r.published_date.slice(0, 10)})`
            : "";
          return `${i + 1}. ${r.title || "无标题"}${when}\n${(r.content || "").slice(0, 600)}\n🔗 ${r.url || ""}`;
        });
        const head = data.answer ? `💡 摘要：${data.answer}\n\n` : "";
        // 成功了也要留名字：不然「返回里没有通道标记」这件事本身会被读成
        // 「主通道没接上」，而它其实只是成功得没吭声。Brave 与免费通道都报了名，
        // 就这条不报，反推出错的可能恰恰最大
        return (
          "（Tavily 检索，只有摘要与网页片段；要细节就 read_url 打开其中一条）\n\n" +
          head +
          lines.join("\n\n")
        );
      }
      fallbackWhy = "（备注：Tavily 通了但一条结果都没给，本次走免费通道）";
    } catch {
      // 配额用尽 / 网络问题：退到免费通道，别让一次搜索失败打断整轮对话 ——
      // 但要说清退了，不让人对着结果猜
      fallbackWhy =
        "（备注：Tavily 调用失败（多半是配额或鉴权），本次走免费通道）";
    }
  }
  if (key && cfg.format === "brave") {
    try {
      const hits = await braveSearch(a.query, key, maxResults, a.timeRange);
      const kept = filterHits(hits, { ...a, maxResults });
      if (kept.length) {
        const lines = kept.map((h, i) => {
          const snip = h.content ? h.content.slice(0, 400) : "(无摘要)";
          return `${i + 1}. ${h.title}\n${snip}\n🔗 ${h.url}`;
        });
        return (
          `（Brave 独立索引，只有摘要没有全文；要细节就 read_url 打开其中一条）\n\n` +
          lines.join("\n\n")
        );
      }
      fallbackWhy = "（备注：Brave 通了但一条结果都没给，本次走免费通道）";
    } catch {
      fallbackWhy = "（备注：Brave 调用失败，本次走免费通道）";
    }
  }
  const free = await freeSearch({ ...a, maxResults });
  return fallbackWhy ? `${fallbackWhy}\n\n${free}` : free;
}

/**
 * 拦页内子请求去私网：assertPublicUrl 只挡得住人给的那一个地址，第二条腿在页里的
 * JS 上（它可以让浏览器去请求内网或元数据地址）。每条都锚在 scheme+host 上，
 * 不去匹配路径里的数字串（`/v10.2/` 这种不该被误伤）。
 */
const PRIVATE_REQUEST_PATTERNS = [
  "^[a-z]+://localhost",
  "^[a-z]+://(127|10|192\\.168|169\\.254|0)\\.",
  "^[a-z]+://172\\.(1[6-9]|2\\d|3[01])\\.",
  "^[a-z]+://[^/]*\\.(local|internal)(:|/|$)",
  "^[a-z]+://\\[",
];

/**
 * 风控页识别：验证码 / 人机验证 / Cloudflare 挑战这类页面的招牌就在标题和开头。
 *
 * 所以只看前 600 字，且全文必须短（真文章哪怕开头提到「验证码」三个字，
 * 也不会全文短成两千字以内）。识别错了的代价很小：退到 Jina 再取一次，
 * 同一页 Jina 大概率照样取得到 —— 宁可错杀，不把验证页当正文交出去。
 */
const CHALLENGE_RE =
  /验证码|人机验证|安全验证|访问验证|滑动验证|拖动滑块|异常流量|请完成验证|captcha|are you a (robot|human)|verify you are human|unusual traffic|just a moment|checking your browser|enable javascript and cookies|access denied/i;

function looksLikeChallenge(text: string): boolean {
  return text.length < 2000 && CHALLENGE_RE.test(text.slice(0, 600));
}

/**
 * 一台正常人的 Chrome：无头浏览器 UA 里的 HeadlessChrome 字样，
 * 是最省事的风控一眼就查的破绽。IP 信誉这类强信号伪装不了，但便宜的伪装先做满。
 */
const REAL_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/** 抹掉第二常见的破绽 navigator.webdriver（字符串形式：它在页面里跑，不在 Worker 里）。 */
const STEALTH_SCRIPT =
  "Object.defineProperty(Navigator.prototype, 'webdriver', { get: () => undefined })";

/**
 * 这一档花了多少浏览器时间，打给 wrangler tail 看。
 * 只记站点主机名不记路径和查询串：那里面常有令牌，而日志是留着给人翻的。
 */
function logBrowser(
  target: string,
  outcome: string,
  ms: number,
  chars = 0,
): void {
  const host = new URL(target).host;
  console.log(`[browser] ${outcome} ${host} 用了 ${ms}ms，取回 ${chars} 字`);
}

/**
 * Browser Run：CF 边缘起一个无头浏览器把页面跑完，正文自己抽。
 *
 * 这一档替的是 Jina：两档都是为了「前端渲染的站直连抓回来是个空壳」，但走 Jina
 * 等于把「管理员在看哪个 URL」和整页正文一起交给一家第三方；Browser Run 是同一个
 * Worker 上的 binding，URL 和内容都不出 CF。所以顺序是便宜档先跑、这一档补渲染、
 * Jina 只在本机 dev（没接 binding）或这一档挂了/吃了风控时兜底。
 *
 * 用完整 puppeteer 而不是 quickAction：那层简化档不暴露 UA 和页面脚本，
 * 伪装（真 Chrome UA、抹 webdriver）就没地方做。伪装是尽力而为，
 * 任何一件失败都不该拖垮整次取正文。
 *
 * 拿不到就返回 null 而不是抛：浏览器那侧超时、配额到顶、站点挡自动化都是常事，
 * 这一档失败不该让整次 read_url 失败。唯一例外是落地私网 —— 那是安全问题，要抛。
 */
async function browserRead(
  env: Env,
  target: string,
): Promise<{ text: string; finalUrl: string } | null> {
  const binding = env.BROWSER;
  if (!binding) return null;
  const t0 = Date.now();
  let browser: Awaited<ReturnType<typeof puppeteer.launch>>;
  try {
    browser = await puppeteer.launch(binding);
  } catch {
    logBrowser(target, "挂了", 0);
    return null;
  }
  try {
    const page = await browser.newPage();
    // 伪装三件套，尽力而为：失败就裸奔，总比一次都取不到强
    try {
      await page.setUserAgent(REAL_UA);
      await page.setViewport({ width: 1440, height: 900 });
      await page.evaluateOnNewDocument(STEALTH_SCRIPT);
    } catch {
      // 伪装失败不算失败
    }
    // quickAction 时代的两条护栏在这层亲手装回来：
    // 页内子请求不去私网（页面 JS 发起的 SSRF），图片视频字体不花浏览器配额
    const blocked = (u: string) =>
      PRIVATE_REQUEST_PATTERNS.some((p) => new RegExp(p).test(u));
    try {
      await page.setRequestInterception(true);
      page.on("request", (req) => {
        const type = req.resourceType();
        if (
          blocked(req.url()) ||
          type === "image" ||
          type === "media" ||
          type === "font"
        )
          void req.abort().catch(() => {});
        else void req.continue().catch(() => {});
      });
    } catch {
      // 拦截层装不上就放行子请求：入口那一个地址 assertPublicUrl 仍然守着
    }
    const res = await page.goto(target, {
      waitUntil: "networkidle2",
      timeout: 20_000,
    });
    const ms = Date.now() - t0;
    if (res && res.status() >= 400) {
      logBrowser(target, `报错 ${res.status()}`, ms);
      return null;
    }
    const text = extractMain(await page.content()).trim();
    if (!text) {
      logBrowser(target, "空壳", ms);
      return null;
    }
    if (looksLikeChallenge(text)) {
      logBrowser(target, "吃了风控", ms, text.length);
      return null;
    }
    // 重定向链是这一档才看得见的：assertPublicUrl 只挡得住人给的那个地址，
    // 公共站 302 到一个内网名/元数据地址是经典 SSRF 走法
    const finalUrl = page.url();
    if (finalUrl && finalUrl !== target) {
      try {
        assertPublicUrl(finalUrl);
      } catch {
        logBrowser(target, "落地私网，已拒", ms);
        throw new Error(`页面被转到了不允许的地址：${finalUrl}`);
      }
    }
    logBrowser(target, "取到", ms, text.length);
    return { text, finalUrl: finalUrl || target };
  } catch (e) {
    const msg = (e as Error).message || "";
    if (msg.startsWith("页面被转到")) throw e; // 安全问题原样上抛，不当「拿不到」吞掉
    logBrowser(target, "挂了", Date.now() - t0);
    return null;
  } finally {
    await browser.close().catch(() => {});
  }
}

/**
 * 抓一个网页的正文：Tavily extract → 直连抽取 → Browser Run 渲染 → Jina 兜底。
 * read_url 和盯梢共用，所以这里不裁剪长度，调用方按自己的需要截。
 * 付费档只认 Tavily extract（Brave 没有抓取接口）；搜索通道换成 Brave 时
 * 抓取自动从直连起步，不多花一份没意义的钥匙。
 * 真的什么都拿不到才抛错，抛出来的话调用方原样告诉用户。
 */
export async function fetchPageText(
  env: Env,
  url: string,
  opts: { query?: string; depth?: "basic" | "advanced" } = {},
  cfg: SearchConfig = DEFAULT_SEARCH_CONFIG,
): Promise<{ url: string; text: string; rendered: boolean }> {
  const target = assertPublicUrl(
    url.startsWith("http") ? url : "https://" + url,
  ).toString();
  const vars = env as unknown as Record<string, string | undefined>;
  const key =
    cfg.format === "tavily" && cfg.keySecret ? vars[cfg.keySecret] : undefined;
  if (key) {
    try {
      const body: Record<string, unknown> = {
        urls: [target],
        extract_depth: opts.depth ?? "basic",
        format: "markdown",
        chunks_per_source: 3,
      };
      if (opts.query) body.query = opts.query;
      const data = (await tavily(
        TAVILY_EXTRACT,
        body,
        key,
      )) as TavilyExtractResponse;
      const ok = data.results?.[0]?.raw_content;
      if (ok) return { url: target, text: ok, rendered: false };
    } catch {
      // 抽不出来（配额 / 超时 / 该站不让抽）就退到直连，别让一次失败变成整次失败
    }
  }

  try {
    const text = extractMain(await directFetch(target));
    if (text.length >= 200) return { url: target, text, rendered: false };
  } catch (e) {
    const msg = (e as Error).message;
    if (msg.startsWith("拒绝") || msg.startsWith("只允许")) throw e;
  }
  const rendered = await browserRead(env, target);
  if (rendered)
    return { url: rendered.finalUrl, text: rendered.text, rendered: true };
  // Jina 自己也常被丢回来一张验证页：识别出来就当它没取到，别把风控页当正文
  const renderedText = await jinaRead(target);
  if (renderedText && !looksLikeChallenge(renderedText))
    return { url: target, text: renderedText, rendered: true };
  throw new Error(
    env.BROWSER
      ? `直连、浏览器、Jina 都没能拿到正文（${target}）；这个站很可能在挡自动化访问`
      : `直连拿不到正文，Jina 也没渲染出来（${target}）；这个部署没接 Browser Run binding`,
  );
}

export function searchTools(ctx: ToolCtx) {
  return {
    search: tool({
      description:
        "联网搜索。新闻、书评、学术、事实核查、任何不确定的内容都必须先搜索，不要凭记忆回答。" +
        "depth=advanced 更详细但消耗 2 倍额度，一般用 basic 即可。" +
        "没配搜索钥匙时自动走免费通道，结果只有标题和摘要，要细节再用 read_url 打开。",
      inputSchema: z.object({
        query: z.string().describe("搜索关键词，用自然语言描述你想知道什么"),
        depth: z
          .enum(["basic", "advanced", "fast", "ultra-fast"])
          .default("basic"),
        topic: z.enum(["general", "news", "finance"]).default("general"),
        maxResults: z.number().int().min(1).max(20).default(5),
        timeRange: z
          .enum(["day", "week", "month", "year"])
          .optional()
          .describe("只看最近这段时间的内容"),
        includeDomains: z
          .array(z.string())
          .optional()
          .describe("只在这些站点内搜索"),
        excludeDomains: z.array(z.string()).optional(),
      }),
      execute: async (a) => runSearch(ctx.env, a, await ctx.searchConfig()),
    }),

    read_url: tool({
      description:
        "读一个已知网页的正文。需要读全文、原文细节时用，比搜索结果的片段更完整。" +
        "想知道页面上还有哪些可点的地方，用 browse。",
      inputSchema: z.object({
        url: z.string().describe("要读取的网页地址"),
        query: z
          .string()
          .optional()
          .describe("你关注的具体问题，用于聚焦提取相关片段"),
        depth: z.enum(["basic", "advanced"]).default("basic"),
      }),
      execute: async (a) => {
        try {
          const page = await fetchPageText(
            ctx.env,
            a.url,
            { query: a.query, depth: a.depth },
            await ctx.searchConfig(),
          );
          const tag = page.rendered ? "（渲染后）" : "";
          return `📄 ${page.url}${tag}\n\n${clipped(page.text)}`;
        } catch (e) {
          return `抓取失败：${(e as Error).message}`;
        }
      },
    }),

    browse: tool({
      description:
        "轻量微浏览器：打开一个网页，拿到它的标题、正文，以及页面上可以继续点开的链接。" +
        "适合「这个站有什么」「顺着链接再走一层」这类探索；只要某一页的正文，read_url 更快更省。" +
        "想深入就照返回的链接再 browse 一次，别一次点太多。",
      inputSchema: z.object({
        url: z.string().describe("要打开的网址"),
        action: z
          .enum(["read", "links"])
          .default("read")
          .describe("read=正文+链接；links=只列链接，用于摸清站点结构"),
        limit: z
          .number()
          .int()
          .min(5)
          .max(50)
          .default(20)
          .describe("最多返回多少条链接"),
      }),
      execute: async (a) => {
        const url = assertPublicUrl(
          a.url.startsWith("http") ? a.url : "https://" + a.url,
        );
        const target = url.toString();

        let html = "";
        let directErr = "";
        try {
          html = await directFetch(target);
        } catch (e) {
          directErr = (e as Error).message;
        }

        const body = html ? extractMain(html) : "";
        const links = html ? extractLinks(html, url, a.limit) : [];
        const title = html ? extractTitle(html) : "";

        // 直连拿不到正文（前端渲染 / 反爬）：退到 Jina，拿到的只有正文，没有链接
        if (body.length < 200) {
          const rendered = await jinaRead(target);
          if (rendered) {
            const head = `🌐 ${title || target}\n🔗 ${target}\n`;
            if (a.action === "links")
              return `${head}\n页面链接没抓到（内容是渲染出来的），先看正文：\n\n${clipped(rendered)}`;
            return `${head}（渲染后）\n\n${clipped(rendered)}`;
          }
          return `打开失败：${directErr || "拿不到内容"}（${target}）`;
        }

        const head = `🌐 ${title || "(无标题)"}\n🔗 ${target}\n📏 正文约 ${body.length} 字`;
        if (a.action === "links") {
          return (
            head +
            "\n\n" +
            (links.length
              ? links
                  .map((l, i) => `${i + 1}. ${l.text} → ${l.href}`)
                  .join("\n")
              : "这一页没有可继续点的链接。")
          );
        }
        const tail = links.length
          ? "\n\n---\n页面上可继续点开的链接：\n" +
            links.map((l, i) => `${i + 1}. ${l.text} → ${l.href}`).join("\n")
          : "";
        return `${head}\n\n${clipped(body)}${tail}`;
      },
    }),
  };
}
