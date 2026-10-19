import { describe, expect, it } from "vitest";
import {
  MAIL_SOURCE_LABEL,
  fmtBytes,
  inDetailSummary,
  inRowFromAddr,
  inRowFromLabel,
  inRowSummary,
  inboxFaceNote,
  inboxUnreadLabel,
  mailSourceLabel,
  mailSourceNote,
  mailSubjectLabel,
  markerSentences,
  outErrorText,
  outFlagLabel,
  outRecipients,
  outRowSummary,
  outToSummary,
  outboxFaceNote,
  readBodyOf,
  readMarkersOf,
  readToggleLabel,
  rowsNewestFirst,
  unreadFromRows,
  unreadReadOf,
} from "./mailBoxView";
import type { MailInRow, MailOutRow } from "./types";

const out = (over: Partial<MailOutRow> = {}): MailOutRow => ({
  at: "2026-10-01T00:00:00.000Z",
  to: ["owner@example.test"],
  subject: "今天的账",
  ok: true,
  error: "",
  source: "tool",
  ...over,
});

const mail = (over: Partial<MailInRow> = {}): MailInRow => ({
  id: "m1",
  at: "2026-10-02T08:00:00.000Z",
  from: "boss@example.test",
  fromName: "老板",
  to: "ericher@example.test",
  subject: "在吗",
  bytes: 20480,
  read: false,
  hasAttachment: false,
  preview: "正文的开头一段",
  emlKey: "eml/m1",
  ...over,
});

describe("来源翻人话", () => {
  it("三档各有说法，行上叫法与弹页里那句都不空", () => {
    expect(MAIL_SOURCE_LABEL.panel).toBe("面板试发");
    expect(mailSourceLabel("panel")).toBe("面板试发");
    expect(mailSourceLabel("tool")).toBe("ericher 寄的");
    expect(mailSourceLabel("say")).toContain("副本");
    expect(mailSourceNote("say")).toContain("离线副本");
    expect(mailSourceNote("panel")).toContain("测试邮件");
    expect(mailSourceNote("tool")).toContain("工具");
  });
  it("后端新增一档来路：原样念出来，不崩也不替它编一个说法", () => {
    const 没听过 = "digest" as MailOutRow["source"];
    expect(mailSourceLabel(没听过)).toBe("来路「digest」");
    expect(mailSourceNote(没听过)).toContain("还没这一档说法");
    // 空串也不能变成一句空白话
    expect(mailSourceLabel("")).toBe("来路「没记上」");
  });
});

describe("收件人数组 → 摘要", () => {
  it("一个就念那一个，三个折成「第一个 等 3 个」", () => {
    expect(outToSummary(["a@x.co"])).toBe("a@x.co");
    expect(outToSummary(["a@x.co", "b@y.co", "c@z.co"])).toBe("a@x.co 等 3 个");
  });
  it("一个也没有时说明白：那种行是真没记上，不是界面漏了", () => {
    expect(outToSummary([])).toBe("收件人没记上");
    expect(outRowSummary(out({ to: [] }), "10月1日 08:00")).toContain("收件人没记上");
  });
  it("行摘要带上时刻与来路，主题在标题那一行不重复", () => {
    const s = outRowSummary(out({ to: ["a@x.co", "b@y.co"] }), "10月1日 08:00");
    expect(s).toBe("10月1日 08:00 · 收件 a@x.co 等 2 个 · ericher 寄的");
    // 时刻格式化不了时把原串摆出来，不留空白
    expect(outRowSummary(out({ at: "" }), "")).toContain("时刻没记上");
  });
  it("逐个列全时只丢空串，不动顺序也不折成一句", () => {
    expect(outRecipients(out({ to: ["b@y.co", "", " a@x.co "] }))).toEqual(["b@y.co", "a@x.co"]);
  });
});

describe("发件行成/败与失败原因原文", () => {
  it("成的那封不给失败原因：界面不该摆一句「没给出原因」的空话", () => {
    expect(outErrorText(out({ ok: true, error: "" }))).toBe("");
    expect(outFlagLabel(out({ ok: true }))).toBe("已寄出");
    expect(outFlagLabel(out({ ok: false }))).toBe("没寄出去");
  });
  it("失败原因是后端原话：多长、几行都整段留着，一个字不改", () => {
    const 原文 =
      "535 5.7.8 Authentication failed [smtp.example.test 465]\n服务器回的详细报文第二行\n第三行才是真正的原因：账号被冻结，去控制台看";
    const got = outErrorText(out({ ok: false, error: 原文 }));
    expect(got).toBe(原文);
    expect(got.split("\n")).toHaveLength(3);
    expect(got).toContain("账号被冻结");
  });
  it("失败但 error 是空串：明说一句，不摆一个空白框当原因", () => {
    expect(outErrorText(out({ ok: false, error: "" }))).toContain("后端没给出原因");
    expect(outErrorText(out({ ok: false, error: "   " }))).toContain("后端没给出原因");
  });
  it("清单空着那句话与「读不到」是两件事", () => {
    expect(outboxFaceNote([])).toContain("还没往外寄出过信");
    expect(outboxFaceNote([out()])).toBe("");
  });
});

describe("清单排序", () => {
  it("新的在前，时刻念不出来的排到最后而不是把整面卡住", () => {
    const rows = [
      out({ at: "2026-10-01T00:00:00.000Z", subject: "早" }),
      out({ at: "不是一串时刻", subject: "念不出" }),
      out({ at: "2026-10-03T00:00:00.000Z", subject: "最新" }),
    ];
    expect(rowsNewestFirst(rows).map((r) => r.subject)).toEqual(["最新", "早", "念不出"]);
  });
  it("时刻相同的保持原序，不靠 sort 的稳定性碰运气", () => {
    const same = "2026-10-05T00:00:00.000Z";
    const rows = [out({ at: same, subject: "一" }), out({ at: same, subject: "二" })];
    expect(rowsNewestFirst(rows).map((r) => r.subject)).toEqual(["一", "二"]);
  });
});

describe("字节数说成人话", () => {
  it("1024 以下用 B，到 1 MB 用 KB，再往上用 MB", () => {
    expect(fmtBytes(0)).toBe("0 B");
    expect(fmtBytes(999)).toBe("999 B");
    expect(fmtBytes(1023)).toBe("1023 B");
    expect(fmtBytes(1024)).toBe("1 KB");
    expect(fmtBytes(1536)).toBe("1.5 KB");
    expect(fmtBytes(20480)).toBe("20 KB");
    expect(fmtBytes(1048575)).toBe("1024 KB");
    expect(fmtBytes(1048576)).toBe("1 MB");
    expect(fmtBytes(1048576 * 3.4)).toBe("3.4 MB");
  });
  it("拿不到账就明说字节不明，不折成一个看着像样的数", () => {
    expect(fmtBytes(-1)).toBe("字节不明");
    expect(fmtBytes(Number.NaN)).toBe("字节不明");
    expect(fmtBytes(Number.POSITIVE_INFINITY)).toBe("字节不明");
    // 一位小数就够：这一格看的是量级
    expect(fmtBytes(1024 + 51)).toBe("1 KB");
  });
});

describe("收件行的读法", () => {
  it("有显示名用显示名，没有落回地址，两个都没有才说不知道谁寄的", () => {
    expect(inRowFromLabel(mail())).toBe("老板");
    expect(inRowFromLabel(mail({ fromName: "" }))).toBe("boss@example.test");
    expect(inRowFromLabel(mail({ fromName: "   ", from: "  " }))).toBe("不知道谁寄的");
  });
  it("已经在用显示名时才单独列地址，避免同一串字念两遍", () => {
    expect(inRowFromAddr(mail())).toBe("boss@example.test");
    expect(inRowFromAddr(mail({ fromName: "" }))).toBe("");
  });
  it("主题空着明说「没有主题」，不摆一个空白", () => {
    expect(mailSubjectLabel("在吗")).toBe("在吗");
    expect(mailSubjectLabel("   ")).toBe("（没有主题）");
    expect(inRowSummary(mail({ subject: "" }), "10月2日 16:00")).toContain("（没有主题）");
  });
  it("行摘要：地址 · 主题 · 时刻 · 字节，带附件再补一句", () => {
    expect(inRowSummary(mail(), "10月2日 16:00")).toBe(
      "boss@example.test · 在吗 · 10月2日 16:00 · 20 KB",
    );
    expect(inRowSummary(mail({ hasAttachment: true, fromName: "" }), "10月2日 16:00")).toBe(
      "在吗 · 10月2日 16:00 · 20 KB · 带附件",
    );
  });
  it("详情副标题：寄到谁那儿与大小摆一行", () => {
    expect(inDetailSummary(mail(), "10月2日 16:00")).toBe(
      "10月2日 16:00 · 寄到 ericher@example.test · 20 KB",
    );
    expect(inDetailSummary(mail({ to: "" }), "")).toContain("寄到谁那儿没记上");
  });
  it("那颗常显控件的字说清按下去变成什么", () => {
    expect(readToggleLabel(false)).toBe("标已读");
    expect(readToggleLabel(true)).toBe("标未读");
  });
});

describe("开关没开 ≠ 收件箱是空的", () => {
  it("通道没接就直说没接，不写「空的」", () => {
    expect(inboxFaceNote(false, [])).toContain("还没接收件通道");
    expect(inboxFaceNote(false, [])).not.toContain("清单是空的");
    expect(inboxFaceNote(false, [])).toContain("这不是「收件箱是空的」");
  });
  it("通道没接但留有旧信：说明不会再有新的", () => {
    const s = inboxFaceNote(false, [mail()]);
    expect(s).toContain("还没接收件通道");
    expect(s).toContain("不会再有新的");
  });
  it("通道开着才是那句「清单是空的」", () => {
    expect(inboxFaceNote(true, [])).toContain("清单是空的");
    expect(inboxFaceNote(true, [mail()])).toBe("");
  });
  it("未读数：通道没接时标注这是旧账", () => {
    expect(inboxUnreadLabel(true, 3)).toBe("未读 3");
    expect(inboxUnreadLabel(false, 3)).toContain("通道还没接");
  });
});

describe("未读计数信谁的", () => {
  it("两个数一致就不多嘴", () => {
    const rows = [mail(), mail({ id: "m2", read: true })];
    const r = unreadReadOf(rows, 1);
    expect(r).toEqual({ count: 1, note: "" });
    expect(unreadFromRows(rows)).toBe(1);
  });
  it("后端的全量数与清单里数出来的不一致：摆后端那个，并把差异说出来", () => {
    // 清单只回了最近 2 行、其中 1 封未读，而后端记着 40 封没看
    const rows = [mail(), mail({ id: "m2", read: true })];
    const r = unreadReadOf(rows, 40);
    expect(r.count).toBe(40);
    expect(r.note).toContain("40 封未读");
    expect(r.note).toContain("1 封");
    expect(r.note).toContain("全量");
    // 反过来（后端给 0、清单里有未读）也信后端，不悄悄换成清单数
    const back = unreadReadOf(rows, 0);
    expect(back.count).toBe(0);
    expect(back.note).toContain("后端记的是 0 封未读");
  });
  it("后端没回这个数（缺字段、NaN、负数）才落回按清单数，并说明是兜底", () => {
    const rows = [mail(), mail({ id: "m2", read: true })];
    for (const bad of [undefined, null, Number.NaN, -1, "3"]) {
      const r = unreadReadOf(rows, bad);
      expect(r.count).toBe(1);
      expect(r.note).toContain("后端没回未读总数");
    }
  });
});

describe("详情里那三个「这封看不全」的标记", () => {
  it("emlKey 为空就是只有摘要：这条只看字段，不受 note 措辞影响", () => {
    expect(readMarkersOf(mail({ emlKey: "  " }), "一切都好")).toEqual({
      onlySummary: true,
      truncated: false,
      htmlOnly: false,
    });
    expect(readMarkersOf(mail(), "").onlySummary).toBe(false);
  });
  it("行上明写了布尔就照单收，没写才去 note 里找", () => {
    const 带标记 = { ...mail(), truncated: true, htmlOnly: true } as MailInRow;
    expect(readMarkersOf(带标记, "")).toEqual({
      onlySummary: false,
      truncated: true,
      htmlOnly: true,
    });
    expect(readMarkersOf(mail(), "正文按上限裁过一段").truncated).toBe(true);
    expect(readMarkersOf(mail(), "this mail is HTML only, text was stripped").htmlOnly).toBe(
      true,
    );
    // 行上明写 false 时，note 里那几个字不算数
    const 明写没裁 = { ...mail(), truncated: false } as MailInRow;
    expect(readMarkersOf(明写没裁, "裁过了").truncated).toBe(false);
  });
  it("标记各成一句、顺序固定；完整的一封不必多嘴", () => {
    expect(markerSentences({ onlySummary: false, truncated: false, htmlOnly: false })).toEqual([]);
    const all = markerSentences(readMarkersOf({ ...mail(), emlKey: "", truncated: true, htmlOnly: true } as MailInRow));
    expect(all).toHaveLength(3);
    expect(all[0]).toContain("只有摘要");
    expect(all[1]).toContain("不是全文");
    expect(all[2]).toContain("只有 HTML");
    // 三条说的是三件事，不许合成一句含糊话
    expect(all[0]).toContain("不是「信是空的」");
  });
  it("正文取不到时退回清单里那段摘要，并说明那不是全文", () => {
    expect(readBodyOf("正文在此", mail())).toEqual({ body: "正文在此", missing: "" });
    // 原样端出来：正文里的换行与空白不许被 trim 掉
    const 带空白 = "\n  第一段\n\n第二段\n";
    expect(readBodyOf(带空白, mail()).body).toBe(带空白);
    const 只摘要 = readBodyOf("", mail({ preview: "开头一段" }));
    expect(只摘要.body).toBe("开头一段");
    expect(只摘要.missing).toContain("不是全文");
    const 全空 = readBodyOf("   ", mail({ preview: "  " }));
    expect(全空.body).toBe("");
    expect(全空.missing).toContain("没有可读的正文");
  });
});
