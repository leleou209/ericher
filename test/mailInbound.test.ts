import { describe, expect, it } from "vitest";
import { parseIncoming } from "../src/mail/inbound";

/**
 * 入站解析器的离线测：没有网络、没有 workerd、不读时钟。
 * 每条都断到具体值 —— "没抛错"只算半个断言，垃圾输入那组才允许以它为主。
 */

/** 入库那侧传进来的时刻：2026-10-20T03:04:05.000Z */
const NOW = Date.UTC(2026, 9, 20, 3, 4, 5);
const NOW_ISO = "2026-10-20T03:04:05.000Z";

/** 行尾在这里统一造：CRLF 与裸 LF 两种都要跑（现实里确实有裸 LF 的发件端） */
function mail(lines: string[], eol = "\r\n"): string {
  return lines.join(eol);
}

function b64(text: string, fold = 0): string {
  const raw = Buffer.from(text, "utf8").toString("base64");
  return fold > 0 ? raw.replace(new RegExp(`.{1,${fold}}`, "g"), "$&\n").replace(/\n$/, "") : raw;
}

function bytesOf(text: string): number {
  return new TextEncoder().encode(text).length;
}

describe("头部还原", () => {
  it("obs-fold 续行并回上一行，字段名大小写混写也认", () => {
    const raw = mail([
      "From: =?UTF-8?B?5byg5LiJ?= <san.zhang@example.com>,",
      ' "Bob" <bob@example.com>',
      "To:  mailbox@ericher.dev",
      "subject: Weekly",
      " report =?UTF-8?Q?=E4=BD=A0=E5=A5=BD?=",
      "Date: Wed, 15 Oct 2026 08:30:00 +0800",
      "Content-Type: text/plain; charset=UTF-8",
      "content-transfer-encoding: 7bit",
      "",
      "Hello world",
    ]);
    const r = parseIncoming(raw, NOW);
    expect(r.from).toBe("san.zhang@example.com"); // 多地址取第一个，显示名不许把第二个地址粘进来
    expect(r.fromName).toBe("张三");
    expect(r.to).toBe("mailbox@ericher.dev");
    expect(r.subject).toBe("Weekly report 你好"); // 折叠 + 编码词一起还原
    expect(r.replyTo).toBe("");
    expect(r.at).toBe("2026-10-15T00:30:00.000Z"); // +0800 → UTC
    expect(r.text).toBe("Hello world");
    expect(r.bytes).toBe(bytesOf(raw));
    expect(r.htmlOnly).toBe(false);
    expect(r.truncated).toBe(false);
    expect(r.hasAttachment).toBe(false);
    expect(r.attachments).toEqual([]);
  });

  it("Q 编码的显示名（下划线代表空格）与 B 编码的主题各自解开", () => {
    const r = parseIncoming(
      mail([
        "From: =?utf-8?Q?Bob_=E5=B0=8F=E6=98=8E?= <bob@example.com>",
        "To: box@ericher.dev",
        "Subject: =?UTF-8?B?5pel5b+X5bel5L2c6K6h5YiS?=",
        "Reply-To: noreply@maillist.example",
        "Content-Type: text/plain; charset=us-ascii",
        "",
        "body",
      ]),
      NOW,
    );
    expect(r.fromName).toBe("Bob 小明");
    expect(r.subject).toBe("日志工作计划"); // =?UTF-8?B?5pel5b+X5bel5L2c6K6h5YiS?=
    expect(r.replyTo).toBe("noreply@maillist.example");
    expect(r.from).toBe("bob@example.com");
    expect(r.text).toBe("body");
  });

  it("Reply-To 存在时回信去向以它为准，不等于 From", () => {
    const r = parseIncoming(
      mail([
        "From: sender@example.com",
        "To: box@ericher.dev",
        "Reply-To: List <bounce@lists.example>",
        "Subject: x",
        "",
        "y",
      ]),
      NOW,
    );
    expect(r.replyTo).toBe("bounce@lists.example");
    expect(r.from).toBe("sender@example.com");
    expect(r.replyTo).not.toBe(r.from);
  });

  it("Date 缺失与 Date 是坏值时都落回传入的 now", () => {
    const noDate = mail(["From: a@b.example", "To: c@d.example", "", "hi"]);
    const missing = parseIncoming(noDate, NOW);
    expect(missing.at).toBe(NOW_ISO);
    const broken = parseIncoming(
      mail(["Date: not a real date at all", "From: a@b.example", "", "hi"]),
      NOW,
    );
    expect(broken.at).toBe(NOW_ISO);
    // 换一个 now 就换一个 at：证明用的是调用方给的时刻，不是内部读的
    expect(parseIncoming(noDate, NOW + 1000).at).toBe("2026-10-20T03:04:06.000Z");
    // 有合法 Date 时与 now 无关
    expect(parseIncoming(mail(["Date: Thu, 1 Jan 2026 00:00:00 +0000", "", "hi"], "\n"), 0).at).toBe(
      "2026-01-01T00:00:00.000Z",
    );
  });

  it("每个字段都有上限，超限截断而不是报错", () => {
    const r = parseIncoming(
      mail([
        `From: ${"n".repeat(200)} <${"a".repeat(300)}@example.com>`,
        `To: box@ericher.dev`,
        `Subject: ${"s".repeat(900)}`,
        "",
        "hi",
      ]),
      NOW,
    );
    expect(r.subject.length).toBe(500);
    expect(r.from.length).toBe(254);
    expect(r.fromName.length).toBe(120);
  });
});

describe("正文与转移编码", () => {
  it("base64 正文（被折行的）解出中文，裸 LF 行尾一样能读", () => {
    const text = "你好，世界\n这是第二行正文";
    const raw = mail(
      [
        "From: a@b.example",
        "To: box@ericher.dev",
        "Subject: hi",
        "Content-Type: text/plain; charset=utf-8",
        "Content-Transfer-Encoding: base64",
        "",
        b64(text, 20), // 故意折成 20 字符一行
      ],
      "\n",
    );
    const r = parseIncoming(raw, NOW);
    expect(r.text).toBe(text);
    expect(r.htmlOnly).toBe(false);
    expect(r.bytes).toBe(bytesOf(raw));
  });

  it("8bit 中文正文的 bytes 是 UTF-8 字节数，不是字符数", () => {
    const raw = mail(["From: a@b.example", "Content-Type: text/plain; charset=utf-8", "", "你好世界"]);
    const r = parseIncoming(raw, NOW);
    expect(r.text).toBe("你好世界");
    expect(r.bytes).toBe(bytesOf(raw));
    expect(r.bytes).toBeGreaterThan(raw.length); // 4 个中文各占 3 字节
  });

  it("quoted-printable：=XX 转义、行尾软换行拼接、光杆 = 按字面留着", () => {
    const raw = mail([
      "From: a@b.example",
      "Content-Type: text/plain; charset=utf-8",
      "Content-Transfer-Encoding: quoted-printable",
      "",
      "=E4=BD=A0=E5=A5=BD=", // 软换行：与下一行直接相连
      " world=21",
      "",
      "c=3Dd",
    ]);
    const r = parseIncoming(raw, NOW);
    expect(r.text).toBe("你好 world!\n\nc=d");
  });

  it("字符集认不出时退回 UTF-8，非法字节替换掉，不抛", () => {
    const raw = mail([
      "From: a@b.example",
      "Content-Type: text/plain; charset=x-not-a-charset",
      "",
      "ok \u00ff\u00fe",
    ]);
    const r = parseIncoming(raw, NOW);
    expect(r.text.startsWith("ok ")).toBe(true);
    expect(r.truncated).toBe(false);
  });

  it("正文超过 20000 字符就裁到 20000 并置 truncated", () => {
    const raw = mail(["From: a@b.example", "Content-Type: text/plain", "", "x".repeat(25_000)]);
    const r = parseIncoming(raw, NOW);
    expect(r.truncated).toBe(true);
    expect(r.text.length).toBe(20_000);
    expect(r.text).toBe("x".repeat(20_000));
  });

  it("正好 20000 字符不算裁过", () => {
    const raw = mail(["From: a@b.example", "Content-Type: text/plain", "", "y".repeat(20_000)]);
    const r = parseIncoming(raw, NOW);
    expect(r.truncated).toBe(false);
    expect(r.text.length).toBe(20_000);
  });
});

describe("multipart 结构", () => {
  const PLAIN = "纯文本那一版";
  const HTML = "<div><p>纯文本那一版</p></div>";

  it("alternative 里取 text/plain，不取 html", () => {
    const raw = mail([
      "From: a@b.example",
      "To: box@ericher.dev",
      "Subject: alt",
      'Content-Type: multipart/alternative; boundary="B1"',
      "",
      "--B1",
      "Content-Type: text/html; charset=utf-8",
      "Content-Transfer-Encoding: base64",
      "",
      b64(HTML),
      "--B1",
      "Content-Type: text/plain; charset=utf-8",
      "Content-Transfer-Encoding: base64",
      "",
      b64(PLAIN),
      "--B1--",
    ]);
    const r = parseIncoming(raw, NOW);
    expect(r.text).toBe(PLAIN);
    expect(r.htmlOnly).toBe(false);
    expect(r.text).not.toContain("<div>");
  });

  it("只有 text/html 时 htmlOnly=true，正文是剥了标签与 script/style 内容的纯文本", () => {
    const html =
      "<div><p>你好</p><script>alert(1)</script><style>p{color:red}</style>a&nbsp;b &amp; c &#65;</div>";
    const raw = mail([
      "From: site@example.com",
      "To: box@ericher.dev",
      "Content-Type: text/html; charset=\"utf-8\"",
      "Content-Transfer-Encoding: base64",
      "",
      b64(html),
    ]);
    const r = parseIncoming(raw, NOW);
    expect(r.htmlOnly).toBe(true);
    expect(r.text).toBe("你好\na\u00a0b & c A");
    expect(r.text).not.toContain("alert"); // script 的内容整段删掉
    expect(r.text).not.toContain("color:red");
    expect(r.text).not.toContain("<div>");
  });

  it("mixed 里套 alternative 再挂一个 pdf：一层嵌套照常读，附件记名与字节", () => {
    const pdf = "%PDF-1.4" + "x".repeat(20); // 28 字节
    const raw = mail([
      "From: a@b.example",
      "To: box@ericher.dev",
      "Subject: 报告",
      'Content-Type: multipart/mixed; boundary="TOP"',
      "",
      "--TOP",
      'Content-Type: multipart/alternative; boundary="INNER"',
      "",
      "--INNER",
      "Content-Type: text/plain; charset=utf-8",
      "Content-Transfer-Encoding: base64",
      "",
      b64(PLAIN),
      "--INNER",
      "Content-Type: text/html; charset=utf-8",
      "Content-Transfer-Encoding: base64",
      "",
      b64(HTML),
      "--INNER--",
      "",
      "--TOP",
      "Content-Type: application/pdf",
      "Content-Disposition: attachment; filename*=UTF-8''%E6%9C%88%E6%8A%A5.pdf",
      "Content-Transfer-Encoding: base64",
      "",
      b64(pdf),
      "--TOP--",
    ]);
    const r = parseIncoming(raw, NOW);
    expect(r.text).toBe(PLAIN);
    expect(r.htmlOnly).toBe(false);
    expect(r.hasAttachment).toBe(true);
    expect(r.attachments).toEqual([{ name: "月报.pdf", bytes: 28 }]);
    expect(r.subject).toBe("报告");
  });

  it("附件判定三条件都要认，名字没有就留空；正文不留附件内容", () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const raw =
      mail(
        [
          "From: a@b.example",
          'Content-Type: multipart/mixed; boundary="M"',
          "",
          "--M",
          "Content-Type: text/plain; charset=utf-8",
          "",
          "正文",
          "--M",
          "Content-Type: image/png",
          "Content-Transfer-Encoding: base64",
          "",
          Buffer.from(png).toString("base64"),
          "--M",
          "Content-Type: application/octet-stream",
          'Content-Disposition: attachment; filename="月度 报告; v2.bin"',
          "Content-Transfer-Encoding: base64",
          "",
          b64("abcdefgh"),
          "--M--",
        ],
        "\n",
      ) + "\n";
    const r = parseIncoming(raw, NOW);
    expect(r.text).toBe("正文");
    expect(r.hasAttachment).toBe(true);
    expect(r.attachments).toEqual([
      { name: "", bytes: 8 }, // 内联图片没有 filename：名留空，字节照实
      { name: "月度 报告; v2.bin", bytes: 8 }, // 引号里的分号不当参数分隔符
    ]);
    expect(JSON.stringify(r.attachments[0]).length).toBeLessThan(40); // 附件只留名与大小，内容一个字节都不带
  });

  it("半截 multipart（只有 boundary 头 + 一个没收尾的段）照常出正文", () => {
    const raw = mail([
      "MIME-Version: 1.0",
      'Content-Type: multipart/mixed; boundary="xx"',
      "",
      "--xx",
      "Content-Type: text/plain; charset=utf-8",
      "Content-Transfer-Encoding: base64",
      "",
      "5L2g",
    ]);
    const r = parseIncoming(raw, NOW);
    expect(r.text).toBe("你");
    expect(r.hasAttachment).toBe(false);
    expect(r.attachments).toEqual([]);
    expect(r.bytes).toBe(bytesOf(raw));
  });

  it("自称 multipart 却没有 boundary：把整段的体当纯文本读，不整封变空", () => {
    const raw = mail([
      "From: a@b.example",
      "Content-Type: multipart/mixed",
      "",
      "这封没有可用边界",
    ]);
    const r = parseIncoming(raw, NOW);
    expect(r.text).toBe("这封没有可用边界");
    expect(r.attachments).toEqual([]);
  });

  it("说了 boundary 却在正文里一个分隔符都没出现：读出空正文，不去猜", () => {
    const r = parseIncoming(
      mail(["Content-Type: multipart/mixed; boundary=NOPE", "", "--other", "Content-Type: text/plain", "", "读不到"],),
      NOW,
    );
    expect(r.text).toBe("");
    expect(r.htmlOnly).toBe(false);
    expect(r.attachments).toEqual([]);
  });

  it("冒号后不留空格的头、以及无限嵌套的 multipart：都收得住", () => {
    const tight = parseIncoming(mail(["From:a@b.example", "To:box@ericher.dev", "Subject:紧挨着", "", "hi"]), NOW);
    expect(tight.from).toBe("a@b.example");
    expect(tight.subject).toBe("紧挨着");
    expect(tight.text).toBe("hi");

    // 嵌套不设上限就能拿一段循环把内存吃完：MAX_DEPTH 之外那些段直接不读，正文停在能读到的那一层
    const deep: string[] = ["Content-Type: multipart/mixed; boundary=\"D\""];
    for (let i = 0; i < 60; i++) deep.push("", "--D", "Content-Type: multipart/mixed; boundary=\"D\"", "", "--D");
    deep.push("Content-Type: text/plain", "", "最深处的正文");
    const r = parseIncoming(mail(deep), NOW);
    expect(r.text).toBe("");
    expect(r.attachments).toEqual([]);
  });
});

describe("垃圾输入", () => {
  it("控制字符开头的一行怪东西：不抛错，bytes 照实报", () => {
    const raw = "\u0000\u0001 not a mail";
    const r = parseIncoming(raw, NOW);
    expect(r.bytes).toBe(13);
    expect(r.text).toBe("\u0000\u0001 not a mail");
    expect(r.from).toBe("");
    expect(r.fromName).toBe("");
    expect(r.to).toBe("");
    expect(r.subject).toBe("");
    expect(r.replyTo).toBe("");
    expect(r.at).toBe(NOW_ISO);
    expect(r.hasAttachment).toBe(false);
    expect(r.attachments).toEqual([]);
    expect(r.htmlOnly).toBe(false);
    expect(r.truncated).toBe(false);
  });

  it("空报文与不传 now：bytes 为 0，时刻落 epoch", () => {
    const r = parseIncoming(new Uint8Array(0));
    expect(r.bytes).toBe(0);
    expect(r.text).toBe("");
    expect(r.at).toBe("1970-01-01T00:00:00.000Z");
    expect(r.attachments).toEqual([]);
  });

  it("坏 base64、坏 QP、坏编码词：一律尽力返回，不抛", () => {
    const badBase64 = parseIncoming(
      mail(["Content-Type: text/plain", "Content-Transfer-Encoding: base64", "", "!!! 不是 base64 !!!"]),
      NOW,
    );
    expect(badBase64.text).toBe("m\ufffd\u001e\ufffd"); // 丢掉非字母表只剩 "base64" 六个字符，硬解出来的四个字节
    expect(badBase64.bytes).toBeGreaterThan(0);

    const badQp = parseIncoming(
      mail(["Content-Type: text/plain", "Content-Transfer-Encoding: quoted-printable", "", "a=zz b="]),
      NOW,
    );
    expect(badQp.text).toBe("a=zz b"); // =zz 不是十六进制，按字面留着；行尾那个 = 仍按软换行吃掉

    const badWord = parseIncoming(mail(["Subject: =?utf-8?B?&&&&?=", "", "hi"]), NOW);
    expect(badWord.subject).toBe(""); // 解不出来的编码词只留下空，不把 =?...?= 原样塞进界面

    const noBoundary = parseIncoming(new Uint8Array([0x2d, 0x2d, 0x00, 0xff]), NOW);
    expect(noBoundary.bytes).toBe(4);
  });

  it("Uint8Array 入参与 string 入参算出同一个结果", () => {
    const raw = mail(["From: a@b.example", "Subject: 你好", "Content-Type: text/plain; charset=utf-8", "", "正文"]);
    expect(parseIncoming(new TextEncoder().encode(raw), NOW)).toEqual(parseIncoming(raw, NOW));
  });

  it("把一封信逐段砍短：任何长度都不抛，bytes 始终等于输入字节数，字段一律不越上限", () => {
    const full = new TextEncoder().encode(
      mail([
        "From: =?UTF-8?B?5byg5LiJ?= <san@example.com>, \"Bob\" <bob@example.com>",
        "To: box@ericher.dev, other@ericher.dev",
        "Reply-To: =?utf-8?Q?noreply@lists.example?=",
        "Subject: =?UTF-8?B?5p2l5rqQ6aKd5aSW55qE5LiA5bCB6K6w?= 里还混着裸的 8 位字节",
        "Date: Wed, 15 Oct 2026 08:30:00 +0800",
        'Content-Type: multipart/mixed; boundary="F"',
        "",
        "--F",
        "Content-Type: text/plain; charset=utf-8",
        "Content-Transfer-Encoding: base64",
        "",
        b64("正文，被切成任意长度都要尽力读出来"),
        "--F",
        "Content-Type: image/png",
        "Content-Transfer-Encoding: base64",
        "",
        b64("ÿþ\u0000图片"),
        "--F--",
      ]),
    );
    for (let n = 0; n <= full.length; n += 7) {
      const slice = full.slice(0, n);
      // 这一行本身就是断言：任何前缀都不许抛（真抛了 vitest 会把这一格标红）
      const r = parseIncoming(slice, NOW);
      expect(r.bytes).toBe(n);
      expect(r.at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      expect(r.subject.length).toBeLessThanOrEqual(500);
      expect(r.from.length).toBeLessThanOrEqual(254);
      expect(r.to.length).toBeLessThanOrEqual(254);
      expect(r.replyTo.length).toBeLessThanOrEqual(254);
      expect(r.fromName.length).toBeLessThanOrEqual(120);
      expect(r.text.length).toBeLessThanOrEqual(20_000);
      expect(r.truncated).toBe(false);
      expect(Array.isArray(r.attachments)).toBe(true);
      for (const a of r.attachments) {
        expect(a.name.length).toBeLessThanOrEqual(200);
        expect(Number.isInteger(a.bytes) && a.bytes >= 0).toBe(true);
        expect(Object.keys(a).sort()).toEqual(["bytes", "name"]); // 只许有名与大小，内容不带
      }
    }
    // 完整的一封读得出正文与附件（砍到一半时读不出是应该的，读不出不算失败）
    expect(parseIncoming(full, NOW).text).toBe("正文，被切成任意长度都要尽力读出来");
    expect(parseIncoming(full, NOW).attachments).toEqual([{ name: "", bytes: bytesOf("ÿþ\u0000图片") }]);
  });
});

describe("确定性", () => {
  it("同一份输入喂两次结果完全相同（钉住不读时钟）", () => {
    const raw = mail([
      "From: =?UTF-8?B?5byg5LiJ?= <a@b.example>",
      "To: box@ericher.dev",
      "Subject: 同一封",
      'Content-Type: multipart/mixed; boundary="Z"',
      "",
      "--Z",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "两次一样",
      "--Z--",
    ]);
    expect(parseIncoming(raw, NOW)).toEqual(parseIncoming(raw, NOW));
    // 只有坏 Date 时才随 now 变，其余字段一个字都不动
    const noDate = mail(["Subject: 无日期", "", "hi"]);
    const a = parseIncoming(noDate, NOW);
    const b = parseIncoming(noDate, NOW + 60_000);
    expect(a.at).toBe(NOW_ISO);
    expect(b.at).toBe("2026-10-20T03:05:05.000Z");
    expect({ ...a, at: "" }).toEqual({ ...b, at: "" });
  });

  it("CRLF 与裸 LF 两种行尾解出同样的字段，只有 bytes 差在 \r 上", () => {
    const lines = [
      "From: =?UTF-8?B?5byg5LiJ?= <san@example.com>",
      "To: box@ericher.dev",
      "Subject: 两种行尾",
      'Content-Type: multipart/mixed; boundary="P"',
      "",
      "--P",
      "Content-Type: text/plain; charset=utf-8",
      "Content-Transfer-Encoding: base64",
      "",
      b64("第一行\n第二行"),
      "--P",
      "Content-Type: application/octet-stream",
      'Content-Disposition: attachment; filename="a.bin"',
      "Content-Transfer-Encoding: base64",
      "",
      b64("0123456789"),
      "--P--",
    ];
    const crlf = parseIncoming(mail(lines, "\r\n"), NOW);
    const lf = parseIncoming(mail(lines, "\n"), NOW);
    expect(crlf.from).toBe("san@example.com");
    expect(crlf.fromName).toBe("张三");
    expect(crlf.subject).toBe("两种行尾");
    expect(crlf.text).toBe("第一行\n第二行");
    expect(crlf.attachments).toEqual([{ name: "a.bin", bytes: 10 }]);
    expect({ ...lf, bytes: 0 }).toEqual({ ...crlf, bytes: 0 }); // 除字节数外一字不差
    expect(crlf.bytes - lf.bytes).toBe(lines.length - 1); // 每行多一个 \r
    expect(lf.bytes).toBe(bytesOf(mail(lines, "\n")));
  });
});
