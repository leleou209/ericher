import { describe, expect, it } from "vitest";
import { assertReadableWebText, decodeWebBytes, decodeWebResponse } from "../src/shared/webText";
const ascii = (s: string) => new TextEncoder().encode(s);
const hex = (s: string) => Uint8Array.from(s.match(/../g)!.map(x => parseInt(x, 16)));
const gbk = hex("d6d0cec4d0c2cec5"); // 中文新闻
const join = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n,p) => n+p.length,0));
  let at=0; for (const p of parts) { out.set(p,at); at+=p.length; } return out;
};

describe("网页原始字节解码", () => {
  it.each(["GBK", "gb2312", "GB18030", "gb_2312-80"])("HTTP charset=%s读取中文", label => {
    expect(decodeWebBytes(gbk, `text/html; charset="${label}"`)).toBe("中文新闻");
  });
  it.each([
    '<meta charset="GB2312">',
    "<META CHARSET='gbk' />",
    '<meta http-equiv="Content-Type" content="text/html; charset=gbk">',
    "<meta content='text/html; charset=GB2312' HTTP-EQUIV='content-type'>",
  ])("没有HTTP字符集时识别meta：%s", meta => {
    expect(decodeWebBytes(join(ascii(meta),gbk), "text/html")).toContain("中文新闻");
  });
  it("HTTP声明优先于meta，UTF8 BOM又优先于HTTP", () => {
    const text = '<meta charset="gbk">中文新闻';
    expect(decodeWebBytes(ascii(text), "text/html;charset=utf-8")).toBe(text);
    expect(decodeWebBytes(join(hex("efbbbf"),ascii(text)), "text/html;charset=gbk")).toBe(text);
  });
  it("UTF16大小端BOM均可识别", () => {
    expect(decodeWebBytes(hex("fffe2d4e8765"))).toBe("中文");
    expect(decodeWebBytes(hex("feff4e2d6587"))).toBe("中文");
  });
  it("Big5中文与Windows-1252英文标点不是UTF8", () => {
    expect(decodeWebBytes(hex("a4a4a4e5"),"text/html;charset=big5")).toBe("中文");
    expect(decodeWebBytes(hex("93686994"),"text/html;charset=iso-8859-1")).toBe("“hi”");
  });
  it("默认UTF8保留中文、英文、emoji和数字", () => {
    const text="新闻 CPI 0.2% — English 😀";
    expect(decodeWebBytes(ascii(text), "text/html")).toBe(text);
  });
  it("忽略注释、没有http-equiv的content、以及1024字节以外的meta", () => {
    for (const prefix of ['<!-- <meta charset="gbk"> -->', '<meta name="description" content="charset=gbk">', ' '.repeat(1024)+'<meta charset="gbk">']) {
      expect(decodeWebBytes(ascii(prefix+"中文"), "text/html")).toContain("中文");
    }
  });
  it("text/plain不会把正文里的meta当成编码声明", () => {
    expect(decodeWebBytes(ascii('<meta charset="gbk">中文'), "text/plain")).toContain("中文");
  });
  it("无声明坏UTF8、截断GBK、未知字符集均报错，不返回replacement乱码", () => {
    expect(()=>decodeWebBytes(gbk)).toThrow(/可靠解码/);
    expect(()=>decodeWebBytes(hex("d6"),"text/html;charset=gbk")).toThrow(/可靠解码/);
    expect(()=>decodeWebBytes(ascii("hello"),"text/html;charset=not-a-real-encoding")).toThrow(/不支持/);
  });
  it("Response包装读取字节及最终响应HTTP声明", async () => {
    expect(await decodeWebResponse(new Response(gbk,{headers:{"content-type":"text/html;charset=gb2312"}}))).toBe("中文新闻");
  });
  it("明显上游乱码不能当正文，个别replacement引用不误伤正常长文", () => {
    expect(()=>assertReadableWebText("9�·�CPI��PPIͬ���Ƿ�������")).toThrow(/编码损坏/);
    expect(assertReadableWebText("解释字符�的用途，"+"这是正常中文正文。".repeat(100))).toContain("�");
  });
});
