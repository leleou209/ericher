/**
 * 信箱页「写一封」的纯规则。渲染测不了（vitest 跑在 node，没有 DOM），
 * 所以判断这一层必须自己站得住 —— 尤其一个会把信送出本系统的按钮。
 *
 * 运行: npx vitest run web/src/lib/mailCompose.test.ts
 */
import { describe, expect, it } from "vitest";
import {
  COMPOSE_SUBJECT_MAX,
  COMPOSE_TEXT_MAX,
  addressListOf,
  blankCompose,
  composeCanSend,
  composeMissing,
  composePayload,
  composeResultSentence,
  effectiveRecipients,
  recipientModeLabel,
  replyPrefill,
  textOverflowNote,
} from "./mailCompose";
import type { MailInRow } from "./types";

const full = () => ({
  ...blankCompose(),
  subject: "周报",
  text: "本周三件事。",
});

const inRow = (over: Partial<MailInRow> = {}): MailInRow => ({
  id: "m1",
  at: "2026-10-19T08:00:00.000Z",
  from: "someone@example.org",
  fromName: "自称管理员",
  to: "ericher@bun.example.test",
  subject: "关于邮箱托管的一件事",
  bytes: 782,
  read: false,
  hasAttachment: false,
  preview: "正文",
  emlKey: "mail/in/2026-10-19/m1.eml",
  ...over,
});

describe("必填与提交载荷", () => {
  it("主题、正文、自填模式下空地址 —— 三样各缺一次都能被点名", () => {
    expect(composeMissing(blankCompose())).toEqual(["subject", "text"]);
    expect(composeMissing({ ...blankCompose(), subject: "有主题" })).toEqual([
      "text",
    ]);
    expect(
      composeMissing({ ...blankCompose(), subject: "s", text: "t", mode: "custom" }),
    ).toEqual(["to"]);
    expect(composeCanSend(full())).toBe(true);
    expect(composeCanSend(blankCompose())).toBe(false);
  });

  it("用默认表时 to 留空 —— 表里有什么由后端说，界面不替它编一份", () => {
    const d = { ...full(), mode: "default" as const, custom: "不该被用掉@x.test" };
    expect(composePayload(d).to).toBeUndefined();
  });

  it("自填模式下 to 原样交下去（拆与去重是后端的活），两端空白裁掉", () => {
    const d = { ...full(), mode: "custom" as const, custom: "  a@x.test, b@y.test  " };
    expect(composePayload(d).to).toBe("a@x.test, b@y.test");
  });

  it("裁到服务端那两把尺，别让人写了三万字才发现被切", () => {
    const d = {
      ...full(),
      subject: "S".repeat(COMPOSE_SUBJECT_MAX + 50),
      text: "T".repeat(COMPOSE_TEXT_MAX + 50),
    };
    const p = composePayload(d);
    expect(p.subject.length).toBe(COMPOSE_SUBJECT_MAX);
    expect(p.text.length).toBe(COMPOSE_TEXT_MAX);
  });
});

describe("寄给谁：界面那一句怎么说", () => {
  it("地址表三种分隔都算，空白去掉，重复按小写认", () => {
    expect(addressListOf("a@x.test, b@y.test;\nc@z.test\n\n A@X.test ")).toEqual([
      "a@x.test",
      "b@y.test",
      "c@z.test",
    ]);
    expect(addressListOf("")).toEqual([]);
  });

  it("默认模式数的是那张表，自填模式数的是我写的，两边都不混", () => {
    const table = "t1@x.test, t2@x.test";
    expect(effectiveRecipients({ ...full(), mode: "default" }, table)).toEqual([
      "t1@x.test",
      "t2@x.test",
    ]);
    expect(
      effectiveRecipients({ ...full(), mode: "custom", custom: "c@y.test" }, table),
    ).toEqual(["c@y.test"]);
  });

  it("表是空的时那句提示要说「寄之前得先填」，不能显示成能用", () => {
    expect(recipientModeLabel("default", 0)).toContain("空的");
    expect(recipientModeLabel("default", 3)).toContain("3 个地址");
    expect(recipientModeLabel("custom", 99)).toContain("这一次填的");
  });

  it("正文越界才有提示，正好在上限内不吵人", () => {
    expect(textOverflowNote("短")).toBe("");
    expect(textOverflowNote("字".repeat(COMPOSE_TEXT_MAX))).toBe("");
    expect(textOverflowNote("字".repeat(COMPOSE_TEXT_MAX + 1))).toContain("被裁掉");
  });
});

describe("回这封：预填的规矩", () => {
  it("收件人锁在 from 上，不是那个自称的名字", () => {
    const p = replyPrefill(inRow());
    expect(p.custom).toBe("someone@example.org");
    expect(p.custom).not.toContain("自称管理员");
    expect(p.mode).toBe("custom");
  });

  it("Re: 不叠第二层，主题空着给一个能看懂的兜底", () => {
    expect(replyPrefill(inRow({ subject: "Re: already" })).subject).toBe(
      "Re: already",
    );
    expect(replyPrefill(inRow({ subject: "  " })).subject).toContain("没写主题");
    expect(replyPrefill(inRow()).subject).toBe("Re: 关于邮箱托管的一件事");
  });

  it("正文不许预填：回信写什么是人自己的决定", () => {
    expect(replyPrefill(inRow()).text).toBe("");
  });
});

describe("寄完那一句", () => {
  it("成功说「已寄出」并提醒额度", () => {
    const s = composeResultSentence({ ok: true });
    expect(s).toContain("已寄出");
    expect(s).toContain("额度");
  });

  it("失败时把后端原话整段留着，不截、不改写成「稍后再试」", () => {
    const reason = "认证被拒绝：535 提示是「发件地址未验证」，请去 Brevo 后台验证";
    const s = composeResultSentence({ ok: false, error: reason });
    expect(s).toBe(`没寄出：${reason}`);
    expect(s).not.toContain("稍后再试");
  });

  it("后端没给原因也不空着 —— 一句「没寄出：」加个空白最让人无从下手", () => {
    expect(composeResultSentence({ ok: false, error: "" })).toContain("没给原因");
  });
});
