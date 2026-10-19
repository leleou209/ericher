import { describe, expect, it } from "vitest";
import {
  IMPLICIT_TLS_PORTS,
  MAX_DAILY_CAP,
  MAX_TO_ADDRESSES,
  STARTTLS_PORT,
  addressCellProblem,
  addressListSummary,
  addressTableOf,
  addressTableRemove,
  addressTableSet,
  blankMailDraft,
  blockedPortMessage,
  draftAddressTable,
  draftKeyMissing,
  inboxEnabledHint,
  inboxEnabledSummary,
  isHostname,
  isMailAddress,
  isSecretName,
  joinAddressTable,
  keyMissingHint,
  keySecretHint,
  lastSendNote,
  mailDraftOf,
  mailMissingFields,
  mailPayloadOf,
  mailSummary,
  mailWithSecure,
  parseDailyCap,
  parsePort,
  sayMailHint,
  sayMailSummary,
  secureLabel,
  securePortHint,
  splitAddressTable,
  testSentNote,
  type MailDraft,
} from "./mailForm";
import type { MailConfigView, MailConfigViewFull } from "./types";

const view = (over: Partial<MailConfigViewFull> = {}): MailConfigViewFull => ({
  enabled: true,
  hostname: "smtp.example.test",
  port: 465,
  secure: true,
  username: "ericher@example.test",
  keySecret: "MAIL_KEY",
  from: "ericher@example.test",
  to: "owner@example.test",
  dailyCap: 20,
  keyAvailable: true,
  lastSend: null,
  ...over,
});

const draft = (over: Partial<MailDraft> = {}): MailDraft => ({
  ...mailDraftOf(view()),
  ...over,
});

describe("草稿与提交口径", () => {
  it("视图回写成草稿是逐格抄，两个数字格折成字符串", () => {
    expect(mailDraftOf(view())).toEqual({
      enabled: true,
      hostname: "smtp.example.test",
      port: "465",
      secure: true,
      username: "ericher@example.test",
      keySecret: "MAIL_KEY",
      from: "ericher@example.test",
      to: "owner@example.test",
      dailyCap: "20",
      sayMail: false,
      inboxEnabled: false,
    });
  });
  it("后端还没回新增那三格（老形状）：两个开关按关着读，地址表从 to 文本里拆", () => {
    const 老视图: MailConfigView = {
      enabled: true,
      hostname: "smtp.example.test",
      port: 587,
      secure: false,
      username: "ericher@example.test",
      keySecret: "MAIL_KEY",
      from: "ericher@example.test",
      to: "a@x.co\nb@y.co",
      dailyCap: 5,
      keyAvailable: true,
      lastSend: null,
    };
    const d = mailDraftOf(老视图);
    expect(d.sayMail).toBe(false);
    expect(d.inboxEnabled).toBe(false);
    expect(draftAddressTable(d)).toEqual(["a@x.co", "b@y.co"]);
  });
  it("空白草稿是关着的、没有凭据的、两个开关也关着", () => {
    const d = blankMailDraft();
    expect(d.enabled).toBe(false);
    expect(d.username).toBe("");
    expect(d.keySecret).toBe("");
    expect(d.sayMail).toBe(false);
    expect(d.inboxEnabled).toBe(false);
  });
  it("请求体正好是那十一格可写字段，一个不多", () => {
    expect(Object.keys(mailPayloadOf(draft())).sort()).toEqual(
      [
        "dailyCap",
        "enabled",
        "from",
        "hostname",
        "inboxEnabled",
        "keySecret",
        "port",
        "sayMail",
        "secure",
        "to",
        "username",
      ],
    );
  });
  it("请求体里绝不允许出现口令：keyAvailable 与 lastSend 也不回传", () => {
    const body = mailPayloadOf(draft({ keySecret: "MAIL_KEY" }));
    // keySecret 是唯一带「密钥」字样的键，它存的是变量名，不是口令
    for (const k of Object.keys(body)) expect(k.toLowerCase()).not.toMatch(/pass|pwd|token/);
    expect(body.keySecret).toBe("MAIL_KEY");
    expect("keyAvailable" in body).toBe(false);
    expect("lastSend" in body).toBe(false);
  });
  it("提交前每格 trim，数字格折成数字", () => {
    const p = mailPayloadOf(draft({ hostname: "  smtp.x.test ", from: " a@b.co ", port: " 587 ", dailyCap: " 30 " }));
    expect(p.hostname).toBe("smtp.x.test");
    expect(p.from).toBe("a@b.co");
    expect(p.port).toBe(587);
    expect(p.dailyCap).toBe(30);
  });
  it("enabled 原样带过去：行上那个开关翻的是什么，提交的就是什么", () => {
    expect(mailPayloadOf(draft({ enabled: true })).enabled).toBe(true);
    expect(mailPayloadOf(draft({ enabled: false })).enabled).toBe(false);
  });
  it("两个新开关也原样带过去，默认都是关", () => {
    const p = mailPayloadOf(draft());
    expect(p.sayMail).toBe(false);
    expect(p.inboxEnabled).toBe(false);
    const q = mailPayloadOf(draft({ sayMail: true, inboxEnabled: true }));
    expect(q.sayMail).toBe(true);
    expect(q.inboxEnabled).toBe(true);
  });
  it("提交时收件人那一格拼成规整的地址表文本：逗号拆开、重复并掉、一行一个", () => {
    const p = mailPayloadOf(draft({ to: "a@x.co, B@Y.CO\n\n A@X.CO \n" }));
    expect(p.to).toBe("a@x.co\nB@Y.CO");
  });
});

describe("数字格的解析", () => {
  it("端口只认 1 到 65535 的整数", () => {
    expect(parsePort("465")).toBe(465);
    expect(parsePort("65535")).toBe(65535);
    expect(parsePort("")).toBeUndefined();
    expect(parsePort("  ")).toBeUndefined();
    expect(parsePort("abc")).toBeUndefined();
    expect(parsePort("0")).toBeUndefined();
    expect(parsePort("65536")).toBeUndefined();
    expect(parsePort("25.5")).toBeUndefined();
  });
  it("每日上限把小数收成整数、超界算没填（后端对这格是直接 400）、负数算没填", () => {
    expect(parseDailyCap("20")).toBe(20);
    expect(parseDailyCap("1.6")).toBe(2);
    expect(parseDailyCap(String(MAX_DAILY_CAP))).toBe(MAX_DAILY_CAP);
    expect(parseDailyCap("999999")).toBeUndefined();
    expect(parseDailyCap("-1")).toBeUndefined();
    expect(parseDailyCap("")).toBeUndefined();
  });
});

describe("必填与坏值", () => {
  it("开着时缺哪几格就报哪几格，顺序跟着表单走", () => {
    const missing = mailMissingFields({
      ...blankMailDraft(),
      enabled: true,
    });
    expect(missing.map((m) => m.field)).toEqual([
      "hostname",
      "port",
      "username",
      "keySecret",
      "from",
      "to",
      "dailyCap",
    ]);
  });
  it("填齐了开着没有缺项", () => {
    expect(mailMissingFields(draft())).toEqual([]);
  });
  it("关着时半空不算缺项：还没配好是正常状态", () => {
    const d: MailDraft = {
      ...blankMailDraft(),
      enabled: false,
      port: String(STARTTLS_PORT),
      dailyCap: String(IMPLICIT_TLS_PORTS[0]),
    };
    expect(mailMissingFields(d)).toEqual([]);
  });
  it("纯空格算没填，不是填过了", () => {
    expect(
      mailMissingFields(draft({ hostname: "  ", username: "\t" })).map((m) => m.field),
    ).toEqual(["hostname", "username"]);
  });
  it("关着也要说坏值：填了不像数字的端口与不像邮箱的地址照样报", () => {
    const d: MailDraft = {
      ...blankMailDraft(),
      enabled: false,
      port: "99999",
      dailyCap: "abc",
      from: "nope",
    };
    expect(mailMissingFields(d).map((m) => m.field)).toEqual(["port", "from", "dailyCap"]);
  });
  it("后端会 400 的三样坏值当场拦住：坏主机名、25 端口、坏变量名", () => {
    const d = draft({ port: "25", hostname: "smtp example.test", keySecret: "MAIL-KEY" });
    expect(mailMissingFields(d).map((m) => m.field)).toEqual([
      "hostname",
      "port",
      "keySecret",
    ]);
    expect(mailMissingFields(d)[1].message).toContain("平台禁止出站");
  });
  it("每日上限超界与不合法主机名在关着时也报：那是存不进去的值", () => {
    const d: MailDraft = {
      ...blankMailDraft(),
      enabled: false,
      hostname: "https://smtp.x.test",
      dailyCap: String(MAX_DAILY_CAP + 1),
    };
    expect(mailMissingFields(d).map((m) => m.field)).toEqual(["hostname", "dailyCap"]);
  });
});

describe("邮箱地址与 secret 变量名的形状", () => {
  it("认加号、子域与中文本地名", () => {
    expect(isMailAddress("ericher+desk@smtp.example.test")).toBe(true);
    expect(isMailAddress("我@example.test")).toBe(true);
  });
  it("尖括号、空格、换行一律不收 —— 后端 assertSafeAddress 拦的就是这些", () => {
    expect(isMailAddress("a@b.co><CR>")).toBe(false);
    expect(isMailAddress("a@b.co x")).toBe(false);
    expect(isMailAddress("a@b.co\r\nRCPT TO:<evil@x>")).toBe(false);
    expect(isMailAddress("a@b")).toBe(false);
    expect(isMailAddress("a@@b.co")).toBe(false);
    expect(isMailAddress("")).toBe(false);
  });
  it("变量名只能由字母数字下划线组成且不以数字开头", () => {
    expect(isSecretName("MAIL_KEY")).toBe(true);
    expect(isSecretName("_mail")).toBe(true);
    expect(isSecretName("MAIL-KEY")).toBe(false);
    expect(isSecretName("1MAIL")).toBe(false);
    expect(isSecretName("MAIL KEY")).toBe(false);
  });
  it("主机名只认字母、数字、点、连字符 —— 和后端 HOSTNAME_RE 同一条", () => {
    expect(isHostname("smtp.example.test")).toBe(true);
    expect(isHostname("smtp-1.example.test")).toBe(true);
    expect(isHostname("https://smtp.example.test")).toBe(false);
    expect(isHostname("smtp example")).toBe(false);
    expect(isHostname("smtp_example")).toBe(false);
  });
  it("提示分三种：没填说填法、像口令本体说本体、名字不合法说不合法", () => {
    expect(keySecretHint("")).toBe("填 secret 的变量名，不是口令本体");
    expect(keySecretHint("sk-abc123")).toContain("像是口令本体");
    expect(keySecretHint("MAIL-KEY")).toContain("不像一个 secret 变量名");
    expect(keySecretHint("MAIL_KEY")).toBe("");
  });
});

describe("变量在这台机器上配没配", () => {
  it("没改过那一格就照后端那份只读事实", () => {
    expect(draftKeyMissing("MAIL_KEY", { keySecret: "MAIL_KEY", keyAvailable: false })).toBe(true);
    expect(draftKeyMissing("MAIL_KEY", { keySecret: "MAIL_KEY", keyAvailable: true })).toBe(false);
  });
  it("改成别的名字就不下结论：不在候选册上不等于没配", () => {
    const saved = { keySecret: "MAIL_KEY", keyAvailable: true };
    // 候选清单来自模型目录那本册子，不含邮件变量名；拿它当"配没配"的依据会误报
    expect(draftKeyMissing("OTHER_KEY", saved)).toBe(false);
    expect(draftKeyMissing("SMTP_KEY", saved)).toBe(false);
    expect(draftKeyMissing("   ", saved)).toBe(false);
    // 只有还在已存那个名字上时，才用后端读过 env 的那份事实
    expect(draftKeyMissing("MAIL_KEY", { keySecret: "MAIL_KEY", keyAvailable: false })).toBe(true);
    expect(draftKeyMissing("MAIL_KEY", saved)).toBe(false);
  });
  it("那句提示带全 wrangler 命令，空白变量名不给半句话", () => {
    expect(keyMissingHint("MAIL_KEY")).toContain("npx wrangler secret put MAIL_KEY");
    expect(keyMissingHint("MAIL_KEY")).toContain("这台机器上还没有 MAIL_KEY，发不出去");
    expect(keyMissingHint("  ")).toBe("");
  });
});

describe("加密方式与端口的组合", () => {
  it("换加密方式时，停在另一扇标准门上的端口跟着换对", () => {
    expect(mailWithSecure(draft({ port: "587", secure: false }), true).port).toBe("465");
    expect(mailWithSecure(draft({ port: "465", secure: true }), false).port).toBe("587");
    expect(mailWithSecure(draft({ port: "997", secure: true }), false).port).toBe("587");
  });
  it("手填过的端口留住不动，但加密方式照样改", () => {
    const d = mailWithSecure(draft({ port: "2525", secure: false }), true);
    expect(d.port).toBe("2525");
    expect(d.secure).toBe(true);
  });
  it("门与握手方式对不上各说一句，配对时闭嘴", () => {
    expect(securePortHint("465", true)).toBe("");
    expect(securePortHint(String(IMPLICIT_TLS_PORTS[1]), true)).toBe("");
    expect(securePortHint("587", false)).toBe("");
    expect(securePortHint("587", true)).toContain("不是隐式 TLS 的门");
    expect(securePortHint("465", false)).toContain("是隐式 TLS 的门");
    // 25 是平台禁止出站：两种加密说法下都先说这一条
    expect(securePortHint("25", false)).toContain("平台禁止出站");
    expect(securePortHint("25", true)).toContain("平台禁止出站");
    expect(blockedPortMessage(25)).toContain("改 465 或 587");
    // 不像端口的东西不配给判断
    expect(securePortHint("", true)).toBe("");
    expect(securePortHint("70000", false)).toBe("");
  });
  it("标签表就两种说法，摘要与提示共用", () => {
    expect(secureLabel(true)).toBe("隐式TLS");
    expect(secureLabel(false)).toBe("STARTTLS");
  });
});

describe("列表行摘要", () => {
  it("开着时把门、收发、限额与钥匙收成一句", () => {
    const s = mailSummary(view());
    expect(s).toBe(
      "smtp.example.test:465 隐式TLS · 发件 ericher@example.test · 收件 owner@example.test · 每日 20 封 · 密钥变量 MAIL_KEY",
    );
  });
  it("关着时只说未启用，不铺半配的细账", () => {
    expect(mailSummary(view({ enabled: false }))).toBe("未启用");
  });
  it("钥匙不在机器上：开着的那行带「（未配置）」并把那句话摆出来", () => {
    const s = mailSummary(view({ keyAvailable: false }));
    expect(s).toContain("密钥变量 MAIL_KEY（未配置）");
    expect(s).toContain("这台机器上还没有 MAIL_KEY，发不出去");
  });
  it("钥匙不在机器上：关着的那行也得说，否则人以为打开就能发", () => {
    expect(mailSummary(view({ enabled: false, keyAvailable: false }))).toBe(
      "未启用 · 这台机器上还没有 MAIL_KEY，发不出去",
    );
  });
  it("没填密钥时不提「未配置」—— 那是没填，不是配了却读不到", () => {
    const s = mailSummary(view({ keySecret: "", keyAvailable: false }));
    expect(s).toContain("密钥变量 未填");
    expect(s).not.toContain("未配置");
  });
});

describe("最后一次发信那一行", () => {
  it("没发过就一句话也不说", () => {
    expect(lastSendNote(null)).toBe("");
  });
  it("成功：时间与收件地址摆成一行", () => {
    expect(
      lastSendNote({ at: "2026-10-01T00:00:00.000Z", ok: true, error: "", to: "owner@x" }, "10月1日 08:00"),
    ).toBe("最后一次发信成功：10月1日 08:00 发到 owner@x");
  });
  it("失败：服务器原话跟在后面", () => {
    expect(
      lastSendNote({ at: "2026-10-01T00:00:00.000Z", ok: false, error: "535 认证失败", to: "owner@x" }),
    ).toContain("535 认证失败");
  });
  it("失败又没给原因：明说一句，不留半句话", () => {
    expect(
      lastSendNote({ at: "T", ok: false, error: "", to: "" }, "T"),
    ).toBe("最后一次发信失败：T 收件地址没记上 —— 后端没给出原因");
  });
});

describe("测试发送的回执", () => {
  it("点了地址就说那个地址，没点就说按默认收件地址", () => {
    expect(testSentNote("owner@x")).toBe("测试邮件已发到 owner@x");
    expect(testSentNote("  ")).toBe("测试邮件已按配置里的默认收件地址发出");
  });
  it("表里另有几个就明说这一封没寄给它们：别让一个人以为三个人都收到了", () => {
    expect(testSentNote("a@x.co", 2)).toContain("表里另有 2 个地址，这一封没寄给它们");
    // 0 个（表里就一行）时不多嘴
    expect(testSentNote("a@x.co", 0)).toBe("测试邮件已发到 a@x.co");
    expect(testSentNote("", 0)).toBe("测试邮件已按配置里的默认收件地址发出");
  });
});

describe("默认收件地址表：文本 ↔ 数组互转", () => {
  it("按换行拆、空行丢掉、纯空格不算一条", () => {
    expect(splitAddressTable("a@x.co\n\n \nb@y.co\n")).toEqual(["a@x.co", "b@y.co"]);
    expect(splitAddressTable("")).toEqual([]);
    expect(splitAddressTable("   \n\t \n")).toEqual([]);
  });
  it("逗号分隔的一串也拆得开（从聊天窗口粘过来那种）", () => {
    expect(splitAddressTable("a@x.co, b@y.co\nc@z.co , , d@w.co")).toEqual([
      "a@x.co",
      "b@y.co",
      "c@z.co",
      "d@w.co",
    ]);
  });
  it("重复只认第一次那种写法，比较不分大小写", () => {
    expect(splitAddressTable("Owner@X.co\nowner@x.co\nOWNER@X.CO\nother@y.co")).toEqual([
      "Owner@X.co",
      "other@y.co",
    ]);
  });
  it("拼回文本是一行一个、没有尾换行；再过一遍拆出来的还是它自己", () => {
    const text = joinAddressTable([" a@x.co ", "b@y.co", "A@X.CO"]);
    expect(text).toBe("a@x.co\nb@y.co");
    expect(splitAddressTable(text)).toEqual(["a@x.co", "b@y.co"]);
    // 幂等：文本→数组→文本 再走一遍不变形
    expect(joinAddressTable(splitAddressTable(text))).toBe(text);
  });
  it("拆 21 行照样拆得出（拆不拦），上限由校验拦", () => {
    const many = Array.from({ length: MAX_TO_ADDRESSES + 1 }, (_, i) => `p${i}@x.co`);
    expect(splitAddressTable(many.join("\n"))).toHaveLength(MAX_TO_ADDRESSES + 1);
    const d = draft({ to: many.join("\n") });
    const errs = mailMissingFields(d).filter((m) => m.field === "to");
    expect(errs.length).toBe(1);
    expect(errs[0].message).toContain(`最多 ${MAX_TO_ADDRESSES} 个`);
    expect(errs[0].message).toContain(String(MAX_TO_ADDRESSES + 1));
  });
  it("改一格：idx 是行号，null 是追加；越界的 idx 当追加处理", () => {
    const text = "a@x.co\nb@y.co";
    expect(addressTableSet(text, 0, "c@z.co")).toBe("c@z.co\nb@y.co");
    expect(addressTableSet(text, null, "d@w.co")).toBe("a@x.co\nb@y.co\nd@w.co");
    expect(addressTableSet(text, 9, "e@v.co")).toBe("a@x.co\nb@y.co\ne@v.co");
  });
  it("把一格改成空 = 把这一行删掉，表里不留空地址", () => {
    expect(addressTableSet("a@x.co\nb@y.co", 0, "   ")).toBe("b@y.co");
    expect(addressTableRemove("a@x.co\nb@y.co", 1)).toBe("a@x.co");
    // 越界的删除不动任何东西
    expect(addressTableRemove("a@x.co", 5)).toBe("a@x.co");
  });
  it("编辑自己那一行不算重复，别人那行算了要指着第几行", () => {
    const list = ["a@x.co", "b@y.co"];
    expect(addressCellProblem("A@X.CO", list, 0)).toBe("");
    expect(addressCellProblem("b@y.co", list, null)).toContain("第 2 行");
    expect(addressCellProblem("", list, null)).toBe("请填写收件地址");
    expect(addressCellProblem("nope", list, null)).toContain("不像一个邮箱地址");
  });
  it("满表还想加就拦住，改现有那行不受这条影响", () => {
    const full = Array.from({ length: MAX_TO_ADDRESSES }, (_, i) => `p${i}@x.co`);
    expect(addressCellProblem("new@x.co", full, null)).toContain(`最多 ${MAX_TO_ADDRESSES} 个`);
    expect(addressCellProblem("new@x.co", full, 0)).toBe("");
  });
  it("地址表来自视图：后端给了 toList 就信它，没给才从 to 文本里拆", () => {
    expect(addressTableOf(view({ to: "a@x.co\nb@y.co" }))).toEqual(["a@x.co", "b@y.co"]);
    expect(
      addressTableOf(view({ to: "stale@x.co", toList: ["live@y.co", "LIVE@Y.CO", "two@z.co"] })),
    ).toEqual(["live@y.co", "two@z.co"]);
  });
  it("行摘要：一个念那一个，多个折成「第一个 等 N 个」，空表回空串", () => {
    expect(addressListSummary(["a@x.co"])).toBe("a@x.co");
    expect(addressListSummary(["a@x.co", "b@y.co", "c@z.co"])).toBe("a@x.co 等 3 个");
    expect(addressListSummary([])).toBe("");
  });
  it("配置行上的收件人也折成一句：别被十个地址挤满一行", () => {
    expect(mailSummary(view({ to: "a@x.co\nb@y.co\nc@z.co" }))).toContain(
      "收件 a@x.co 等 3 个",
    );
    expect(mailSummary(view({ to: "" }))).toContain("收件 未填");
  });
});

describe("必填校验：收件人是一张表", () => {
  it("开着时空表报 to，坏掉的那条点名说的是哪一条", () => {
    expect(mailMissingFields(draft({ to: "" })).map((m) => m.field)).toEqual(["to"]);
    const errs = mailMissingFields(draft({ to: "a@x.co\nnope" })).filter(
      (m) => m.field === "to",
    );
    expect(errs).toHaveLength(1);
    expect(errs[0].message).toContain("nope");
  });
  it("关着也照样说坏值：那是后端要 400 的东西，不该等打开才发现", () => {
    expect(mailMissingFields(draft({ enabled: false, to: "not-an-address" })).map((m) => m.field)).toEqual([
      "to",
    ]);
    // 关着且表空 = 还没配好，不是坏值
    expect(mailMissingFields(draft({ enabled: false, to: "" }))).toEqual([]);
  });
  it("整张表都合法就没有 to 这一项", () => {
    expect(
      mailMissingFields(draft({ to: "a@x.co\nb@y.co\nc@z.co" })).map((m) => m.field),
    ).toEqual([]);
  });
});

describe("两个开关的行上说法", () => {
  it("关着是什么行为必须写在行上，不能只说「未启用」", () => {
    expect(sayMailSummary(false)).toContain("关着");
    expect(sayMailSummary(false)).toContain("不往外寄邮件副本");
    expect(sayMailSummary(true)).toContain("开着");
    expect(inboxEnabledSummary(false)).toContain("还没接收件通道");
    expect(inboxEnabledSummary(true)).toContain("开着");
  });
  it("开关的补充说明各说各的那件事：副本看限额、收信看 MX", () => {
    expect(sayMailHint(false)).toContain("每日上限");
    expect(inboxEnabledHint(false)).toContain("MX");
  });
});
