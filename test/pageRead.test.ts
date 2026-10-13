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
import { assertPublicUrl, fetchPageText } from "../src/tools/search";

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
