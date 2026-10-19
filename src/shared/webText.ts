/** 网页必须先按声明解码字节，再抽取正文；Response.text() 固定使用 UTF-8。 */
const charsetOf = (value: string): string | undefined =>
  /(?:^|[;\s])charset\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s;"']+))/i.exec(value)
    ?.slice(1).find(Boolean)?.trim();

function metaCharset(bytes: Uint8Array): string | undefined {
  // HTML 编码预扫描仅看头部1024字节；逐字节保留ASCII，尚未对正文做不可逆解码。
  const head = Array.from(bytes.subarray(0, 1024), b => String.fromCharCode(b)).join("")
    .replace(/<!--[\s\S]*?(?:-->|$)/g, "");
  for (const tag of head.match(/<meta\b(?:"[^"]*"|'[^']*'|[^'">])*>/gi) ?? []) {
    const attrs = new Map<string, string>();
    const pattern = /([^\s=<>/]+)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
    for (const match of tag.slice(5, -1).matchAll(pattern)) {
      const key = match[1].toLowerCase();
      if (!attrs.has(key)) attrs.set(key, match[2] ?? match[3] ?? match[4] ?? "");
    }
    const direct = attrs.get("charset")?.trim();
    if (direct) return direct;
    if (attrs.get("http-equiv")?.toLowerCase() === "content-type") {
      const declared = charsetOf(attrs.get("content") ?? "");
      if (declared) return declared;
    }
  }
  return undefined;
}

/** 已由第三方损坏的Unicode无法逆推出原文；拒绝明显的replacement污染，不按长度冒充成功。 */
export function assertReadableWebText(text: string): string {
  const count = (text.match(/\uFFFD/g) ?? []).length;
  if (count >= 3 && count / Math.max(1, text.replace(/\s/g, "").length) >= 0.01)
    throw new Error("网页文字存在明显编码损坏，不能可靠读取正文");
  return text;
}

export function decodeWebBytes(bytes: Uint8Array, contentType = ""): string {
  const bom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? "utf-8"
    : bytes[0] === 0xff && bytes[1] === 0xfe ? "utf-16le"
    : bytes[0] === 0xfe && bytes[1] === 0xff ? "utf-16be" : undefined;
  const html = !contentType || /(?:text\/html|application\/xhtml\+xml)/i.test(contentType);
  const encoding = bom ?? charsetOf(contentType) ?? (html ? metaCharset(bytes) : undefined) ?? "utf-8";
  let decoder: TextDecoder;
  try { decoder = new TextDecoder(encoding, { fatal: true, ignoreBOM: false }); }
  catch { throw new Error(`网页声明了不支持的字符集：${encoding}`); }
  try { return assertReadableWebText(decoder.decode(bytes)); }
  catch { throw new Error(`网页不能按 ${decoder.encoding} 可靠解码，正文可能损坏`); }
}

export async function decodeWebResponse(response: Response): Promise<string> {
  return decodeWebBytes(new Uint8Array(await response.arrayBuffer()), response.headers.get("content-type") ?? "");
}
