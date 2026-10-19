/**
 * 网页取正文这条链的测试：SSRF 拦截 + Browser Run 那一档。
 *
 * 为什么盯这几件事：
 *   1. read_url 是一个「模型可以给任意地址」的口子。挡不住私网和云元数据地址，
 *      它就成了从公网打向内网的跳板；所以白名单/黑名单要能测出红。
 *   2. Browser Run 按浏览器时间计费（免费档每天 10 分钟），花了多少必须看得见。
 *   3. 站点吃风控时丢回来的是一张验证页——它长得像正文，危害比取不到还大：
 *      模型会把它当成那篇文章来读。识别出来必须退到下一档，不能交出去。
 *
 * 这里不碰真网络：globalThis.fetch 被换掉，puppeteer.launch 被换成假剧本。
 * 运行: npx vitest run test/pageRead.test.ts
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { assertPublicUrl, fetchPageText, searchTools } from "../src/tools/search";

// launchState 在 vi.mock 工厂里被引用，必须用 vi.hoisted 提到提升之前
const launchState = vi.hoisted(() => ({
  impl: null as null | ((endpoint: unknown) => Promise<unknown>),
}));

vi.mock("@cloudflare/puppeteer", () => ({
  default: {
    launch: (endpoint: unknown) => {
      if (!launchState.impl) throw new Error("这轮测试没安排 launch 的剧本");
      return launchState.impl(endpoint);
    },
  },
}));

import type { ToolCtx } from "../src/tools/types";

const SHELL_HTML = "<html><body>空壳</body></html>"; // 短到进不了「直连够用」那一档

/** 假 fetch：只认直连和 Jina 两条路，别的都算没被调用 */
function stubFetch(opts: { direct?: string; jina?: string } = {}) {
  const calls: string[] = [];
  const fn = vi.fn(async (input: unknown) => {
    const url = String(input);
    calls.push(url);
    if (url.startsWith("https://r.jina.ai/"))
      return new Response(opts.jina ?? "", { status: opts.jina ? 200 : 404 });
    return new Response(opts.direct ?? SHELL_HTML, {
      status: 200,
      headers: { "Content-Type": "text/html" },
    });
  });
  vi.stubGlobal("fetch", fn);
  return { calls };
}

interface ReqLike {
  url: () => string;
  resourceType: () => string;
  abort: ReturnType<typeof vi.fn>;
  continue: ReturnType<typeof vi.fn>;
}

/** 假 puppeteer 页面：记录伪装调用，content/url/状态由剧本给 */
function fakePage(script: { html?: string; url?: string; status?: number }) {
  const calls: Record<string, unknown[]> = {
    setUserAgent: [],
    evaluateOnNewDocument: [],
    setRequestInterception: [],
  };
  const handlers: Array<(req: ReqLike) => void> = [];
  const page = {
    setUserAgent: async (ua: string) => void calls.setUserAgent.push(ua),
    setViewport: async (v: unknown) => void v,
    evaluateOnNewDocument: async (s: string) =>
      void calls.evaluateOnNewDocument.push(s),
    setRequestInterception: async (on: boolean) =>
      void calls.setRequestInterception.push(on),
    on: (_: string, fn: (req: ReqLike) => void) => void handlers.push(fn),
    goto: async () => ({ status: () => script.status ?? 200 }),
    content: async () => script.html ?? "",
    url: () => script.url ?? "https://example.com/",
  };
  return {
    browser: { newPage: async () => page, close: async () => {} },
    page,
    calls,
    handlers,
  };
}

/** 给这轮测试装上 launch 的剧本；throws 表示浏览器直接起不来 */
function useBrowser(
  script: { html?: string; url?: string; status?: number } | { throws: true },
) {
  const fp = "throws" in script ? null : fakePage(script);
  launchState.impl = async () => {
    if (!fp) throw new Error("浏览器不可用");
    return fp.browser;
  };
  return fp;
}

/** 收 console.log 的每一行，用来验「这次花了多少浏览器时间」确实留了痕 */
function spyLogs() {
  const lines: string[] = [];
  const fn = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
    lines.push(a.map(String).join(" "));
  });
  return { lines, restore: () => fn.mockRestore() };
}

const envOf = (over: Record<string, unknown> = {}) => over as unknown as Env;
const withBrowser = { BROWSER: { fetch: () => {} } }; // launch 已被 mock，binding 是真是假无所谓

afterEach(() => {
  vi.unstubAllGlobals();
  launchState.impl = null;
});

describe("assertPublicUrl（私网和元数据地址一律拒绝）", () => {
  const blocked = [
    "http://localhost:8787/admin",
    "http://127.0.0.1/",
    "http://0.0.0.0/",
    "http://10.1.2.3/",
    "http://192.168.1.1/",
    "http://172.16.0.1/",
    "http://172.31.255.255/",
    "http://169.254.169.254/latest/meta-data/iam/",
    "http://[::1]/",
    "http://intranet.local/",
    "http://svc.internal/api",
    "file:///etc/passwd",
    "gopher://127.0.0.1:11211/",
  ];

  for (const raw of blocked)
    it(`拒绝 ${raw}`, () => {
      expect(() => assertPublicUrl(raw)).toThrow(/拒绝|只允许/);
    });

  // 阳性对照：全是真公网地址，必须放行。没有这一组，上面那串红可能只是选择器写坏了
  it("公网地址放行", () => {
    for (const raw of [
      "https://example.com",
      "https://nodejs.org/en/download/v10.2/",
      "https://10000000000000.example.com/a",
      "http://172.32.0.1/",
    ])
      expect(() => assertPublicUrl(raw)).not.toThrow();
  });
});

describe("fetchPageText 走 Browser Run 那一档", () => {
  it("直连是空壳时用浏览器渲染的结果，且不再问第三方", async () => {
    useBrowser({ html: "<html><body><h1>渲染出来的正文</h1></body></html>" });
    const { calls } = stubFetch();
    const out = await fetchPageText(envOf(withBrowser), "https://example.com");
    expect(out.text).toContain("渲染出来的正文");
    expect(out.rendered).toBe(true);
    // Jina 是把 URL 和正文交给第三方，有浏览器这一档就不该再走它
    expect(calls.filter((u) => u.startsWith("https://r.jina.ai/"))).toEqual([]);
  });

  it("没接 binding 时退回老链条（直连 + Jina），不报错", async () => {
    stubFetch({ direct: SHELL_HTML, jina: "Jina 渲染的正文" });
    const out = await fetchPageText(envOf(), "https://example.com");
    expect(out.text).toContain("Jina 渲染的正文");
  });

  it("浏览器起不来不算这次失败：照旧退到 Jina", async () => {
    useBrowser({ throws: true });
    stubFetch({ jina: "兜底正文" });
    const out = await fetchPageText(envOf(withBrowser), "https://example.com");
    expect(out.text).toContain("兜底正文");
  });

  it("伪装三件套都在，且页内子请求的护栏亲手装上了", async () => {
    const fp = useBrowser({
      html: "<html><body><p>正文内容</p></body></html>",
    });
    stubFetch();
    await fetchPageText(envOf(withBrowser), "https://example.com");

    // UA 要像真人 Chrome，不能带 Headless 字样
    const ua = fp!.calls.setUserAgent.join();
    expect(ua).toContain("Chrome");
    expect(ua).not.toContain("Headless");
    // webdriver 抹除脚本有下发
    expect(fp!.calls.evaluateOnNewDocument.join()).toContain("webdriver");
    // 拦截层真的装上了
    expect(fp!.calls.setRequestInterception).toEqual([true]);

    // 私网子请求和图片被拦，正常子请求放行
    const req = (url: string, resourceType: string): ReqLike => ({
      url: () => url,
      resourceType: () => resourceType,
      abort: vi.fn(async () => {}),
      continue: vi.fn(async () => {}),
    });
    const meta = req("http://169.254.169.254/latest/", "xhr");
    const img = req("https://example.com/a.png", "image");
    const ok = req("https://cdn.example.com/api", "fetch");
    for (const r of [meta, img, ok]) fp!.handlers.forEach((h) => h(r));
    expect(meta.abort).toHaveBeenCalled();
    expect(img.abort).toHaveBeenCalled();
    expect(ok.continue).toHaveBeenCalled();
    expect(ok.abort).not.toHaveBeenCalled();
  });

  it("浏览器说页面被转去了内网：一个字都不交出去", async () => {
    useBrowser({
      html: "<p>不该看到的内容</p>",
      url: "http://169.254.169.254/latest/meta-data/",
    });
    stubFetch();
    await expect(
      fetchPageText(envOf(withBrowser), "https://example.com"),
    ).rejects.toThrow();
  });

  it("每次用掉多少浏览器时间都留一行日志（免费档每天 10 分钟，得有账可查）", async () => {
    useBrowser({ html: "<html><body><p>四字正文啊</p></body></html>" });
    // 直连那档也得钉死：真放它去问 example.com，这轮日志断言就跟着网络和那页的
    // 长短一起漂 —— 页长一点、直连就够用，浏览器压根不跑，日志自然一行都没有
    stubFetch();
    const logs = spyLogs();
    await fetchPageText(envOf(withBrowser), "https://example.com");
    const line = logs.lines.filter((l) => l.includes("[browser]"));
    expect(line).toHaveLength(1);
    expect(line[0]).toMatch(/\d+ms/);
    expect(line[0]).toContain("字");
    logs.restore();
  });

  // 日志是留着给人翻的，地址里那条查询串常常挂着令牌，不能跟着进日志
  it("日志里只留站点主机名，不带路径和查询串", async () => {
    useBrowser({ html: "<html><body><p>正文</p></body></html>" });
    stubFetch(); // 同上：这一档要看到的是浏览器那行，不是直连撞上真网络
    const logs = spyLogs();
    await fetchPageText(
      envOf(withBrowser),
      "https://example.com/private/doc?token=abc123",
    );
    const line = logs.lines.filter((l) => l.includes("[browser]")).join("\n");
    expect(line).toContain("example.com");
    expect(line).not.toContain("abc123");
    expect(line).not.toContain("/private/doc");
    logs.restore();
  });
});

describe("风控页识别（验证页长得像正文，危害比取不到还大）", () => {
  it("浏览器丢回来一张验证页：不交出去，退到 Jina", async () => {
    useBrowser({
      html: "<html><body><h1>请完成安全验证</h1><div>继续访问前先拖动滑块</div></body></html>",
    });
    stubFetch({ jina: "Jina 拿到的正文" });
    const logs = spyLogs();
    const out = await fetchPageText(envOf(withBrowser), "https://example.com");
    expect(out.text).toContain("Jina 拿到的正文");
    expect(logs.lines.join("\n")).toContain("吃了风控");
    logs.restore();
  });

  it("长文哪怕开头提到「验证码」也不误伤：那是文章，不是挑战页", async () => {
    const long = "验证码是现代身份验证的基石。".repeat(150); // 2000 字以上
    useBrowser({ html: `<html><body><p>${long}</p></body></html>` });
    const { calls } = stubFetch();
    const out = await fetchPageText(envOf(withBrowser), "https://example.com");
    expect(out.text).toContain("验证码是现代身份验证的基石");
    expect(calls.filter((u) => u.startsWith("https://r.jina.ai/"))).toEqual([]);
  });

  it("Jina 自己也被丢了一张验证页：当它没取到，报错里把话说透", async () => {
    useBrowser({ html: "<html><body><p>请完成人机验证</p></body></html>" });
    stubFetch({ jina: "unusual traffic detected" });
    await expect(
      fetchPageText(envOf(withBrowser), "https://example.com"),
    ).rejects.toThrow(/挡自动化访问/);
  });
});

// 实际GBK字节，不使用UTF-8字符串Response假装传统编码。
describe("直连传统中文编码回归", () => {
  it("长GB2312新闻正确解码，不因乱码超过200字就认作成功", async () => {
    const text = "9月CPI和PPI同比涨幅扩大，中文新闻。";
    const unit = Uint8Array.from("39d4c2435049bacd505049cdacb1c8d5c7b7f9c0a9b4f3a3acd6d0cec4d0c2cec5a1a3".match(/../g)!.map(x => parseInt(x, 16)));
    const head = new TextEncoder().encode('<html><head><meta charset="gb2312"></head><body><p>');
    const tail = new TextEncoder().encode('</p></body></html>');
    const bytes = new Uint8Array(head.length + unit.length * 30 + tail.length);
    bytes.set(head);
    for (let i=0;i<30;i++) bytes.set(unit,head.length+i*unit.length);
    bytes.set(tail, bytes.length-tail.length);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(bytes, { headers: { "content-type": "text/html" } })));
    const result = await fetchPageText(envOf(), "https://example.com/news.html");
    expect(result.text).toContain(text.repeat(30));
    expect(result.text).not.toContain("�");
    expect(result.rendered).toBe(false);
  });
});

const fakeCtx = (format: "tavily" | "brave" = "tavily", keyed = false) => ({
  env: envOf(keyed ? { TEST_SEARCH_KEY: "fake-test-only" } : {}),
  searchConfig: async () => ({ format, keySecret: keyed ? "TEST_SEARCH_KEY" : "" }),
}) as unknown as ToolCtx;
const execOptions = { toolCallId: "encoding-test", messages: [] };
const gbkPage = (prefix: string, count=1, suffix="") => {
  const gb = [0xd6,0xd0,0xce,0xc4,0xd0,0xc2,0xce,0xc5]; // 中文新闻
  const bytes = [...new TextEncoder().encode(prefix)];
  for(let i=0;i<count;i++) bytes.push(...gb);
  bytes.push(...new TextEncoder().encode(suffix));
  return new Uint8Array(bytes);
};

describe("搜索和浏览编码联动", () => {
  it("browse正文、标题、锚点文字统一GBK解码", async () => {
    const bytes=gbkPage('<html><head><title>',1,'</title></head><body>');
    const rest=gbkPage('<p>',80,'</p><a href="/next">');
    const last=gbkPage('',1,'</a></body></html>');
    const merged=new Uint8Array(bytes.length+rest.length+last.length);
    merged.set(bytes);merged.set(rest,bytes.length);merged.set(last,bytes.length+rest.length);
    vi.stubGlobal("fetch",vi.fn(async()=>new Response(merged,{headers:{"content-type":"text/html; charset=GBK"}})));
    const out=await searchTools(fakeCtx()).browse.execute!({url:"https://example.com/",action:"read",limit:20},execOptions);
    expect(out).toContain("🌐 中文新闻");
    expect(out).toContain("中文新闻 → https://example.com/next");
    expect(out).not.toContain("�");
  });
  it("DDG的HTML标题和摘要也按字符集读取", async () => {
    const bytes=gbkPage('<meta charset="gb2312"><a class="result__a" href="https://example.com/news">',1,'</a><a class="result__snippet">');
    const tail=gbkPage('',1,'</a>');
    const all=new Uint8Array(bytes.length+tail.length);all.set(bytes);all.set(tail,bytes.length);
    const fn=vi.fn(async()=>new Response(all,{headers:{"content-type":"text/html"}}));vi.stubGlobal("fetch",fn);
    const out=await searchTools(fakeCtx()).search.execute!({query:"中文新闻",depth:"basic",topic:"news",maxResults:5},execOptions);
    expect(out).toContain("1. 中文新闻");expect(out).not.toContain("�");expect(fn).toHaveBeenCalledTimes(1);
  });
  it.each(["tavily","brave"] as const)("%s UTF8 JSON中文摘要保持正常，不走网页GBK解码",async format=>{
    vi.stubGlobal("fetch",vi.fn(async()=>Response.json(format==="tavily"
      ? {answer:"中文摘要",results:[{title:"中文新闻",content:"同比上涨0.2%",url:"https://example.com/"}]}
      : {web:{results:[{title:"中文新闻",description:"同比上涨0.2%",url:"https://example.com/"}]}})));
    const out=await searchTools(fakeCtx(format,true)).search.execute!({query:"CPI",depth:"basic",topic:"news",maxResults:5},execOptions);
    expect(out).toContain("中文新闻");expect(out).toContain("同比上涨0.2%");
  });
  it("没有字符集且不是UTF8时进入备用通道，不伪造正常长正文",async()=>{
    const fn=vi.fn(async(input:unknown)=>String(input).startsWith("https://r.jina.ai/")
      ? new Response("备用通道正确中文")
      : new Response(gbkPage('<p>',100,'</p>'),{headers:{"content-type":"text/html"}}));vi.stubGlobal("fetch",fn);
    expect((await fetchPageText(envOf(),"https://example.com")).text).toBe("备用通道正确中文");
    expect(fn).toHaveBeenCalledTimes(2);
  });
  it("上游extract正文已损坏时不能当成功，退回原页可靠解码",async()=>{
    const fn=vi.fn(async(input:unknown)=>String(input).includes("api.tavily.com")
      ? Response.json({results:[{raw_content:"9�·�CPI��PPIͬ���Ƿ�������".repeat(30)}]})
      : new Response(gbkPage('<p>',100,'</p>'),{headers:{"content-type":"text/html;charset=gbk"}}));vi.stubGlobal("fetch",fn);
    const result=await fetchPageText(envOf({TEST_SEARCH_KEY:"fake"}),"https://example.com",{}, {format:"tavily",keySecret:"TEST_SEARCH_KEY"});
    expect(result.text).toContain("中文新闻");expect(result.text).not.toContain("�");expect(fn).toHaveBeenCalledTimes(2);
  });
  it("所有读取方式失败时明确保留编码失败原因",async()=>{
    vi.stubGlobal("fetch",vi.fn(async(input:unknown)=>String(input).startsWith("https://r.jina.ai/")
      ? new Response("",{status:404}) : new Response(gbkPage('<p>',100,'</p>'),{headers:{"content-type":"text/html"}})));
    await expect(fetchPageText(envOf(),"https://example.com")).rejects.toThrow(/直连失败原因.*可靠解码/);
  });
});

describe("标准JSON备用通道与损坏摘要", () => {
  it.each(["tavily","brave"] as const)("%s上游损坏摘要退到免费检索并明确原因",async format=>{
    const junk="9�·�CPI��PPIͬ���Ƿ�������";
    vi.stubGlobal("fetch",vi.fn(async(input:unknown)=>String(input).includes("duckduckgo.com")
      ? new Response('<a class="result__a" href="https://example.com">正确中文新闻</a><a class="result__snippet">正确摘要</a>',{headers:{"content-type":"text/html;charset=utf-8"}})
      : Response.json(format==="tavily" ? {results:[{title:"news",content:junk,url:"https://example.com"}]} : {web:{results:[{title:"news",description:junk,url:"https://example.com"}]}})));
    const out=await searchTools(fakeCtx(format,true)).search.execute!({query:"news",depth:"basic",topic:"news",maxResults:5},execOptions);
    expect(out).toContain("返回文字编码损坏");expect(out).toContain("正确中文新闻");expect(out).not.toContain(junk);
  });
  it("DDG不可用时维基UTF8 JSON标题及HTML摘要保持中文",async()=>{
    vi.stubGlobal("fetch",vi.fn(async(input:unknown)=>String(input).includes("wikipedia.org")
      ? Response.json({query:{search:[{title:"中文百科",snippet:"<span>中文百科内容</span>"}]}}) : new Response("",{status:503})));
    const out=await searchTools(fakeCtx()).search.execute!({query:"中文",depth:"basic",topic:"general",maxResults:1},execOptions);
    expect(out).toContain("维基百科");expect(out).toContain("中文百科内容");
  });
  it("无搜索条目时DDG即时问答的UTF8中文仍可读取",async()=>{
    vi.stubGlobal("fetch",vi.fn(async(input:unknown)=>String(input).startsWith("https://api.duckduckgo.com")
      ? Response.json({AbstractText:"正确中文即时摘要",AbstractURL:"https://example.com"}) : new Response("",{status:503})));
    const out=await searchTools(fakeCtx()).search.execute!({query:"中文",depth:"basic",topic:"general",maxResults:1},execOptions);
    expect(out).toContain("正确中文即时摘要");
  });
});
