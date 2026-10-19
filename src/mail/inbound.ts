/**
 * 入站报文 → ParsedMail：整封原始 RFC822 进来，纯数据出去，不做任何 IO。
 *
 * 三件事决定了下面每个函数为什么长成这样：
 *   1. 零依赖、不读时钟。只用 Web API（TextDecoder / atob / Uint8Array），不引 npm 包；
 *      `now` 由调用方（入库那一刻）传进来，同一份报文喂两次必须出完全相同的结果 ——
 *      否则这层没法离线测，也没法事后复查某封信。
 *   2. 永不抛错。来件是外人发的，什么形状都有：坏 base64、缺 boundary、只有半行的头、
 *      截断的 multipart。这层的职责是"尽力读出能读的部分"，收不收是 store.ts 的判断 ——
 *      解析器一拒绝，界面就只剩一片空白，谁也不知道那封信原本长什么样。
 *   3. 每个字段都有上限（值 500 / 地址 254 / 名字 120 / 附件名 200 / 正文 20000），
 *      超限截断而不是报错。正文那个数与 src/mail/send.ts 的 TEXT_MAX 同尺，两边必须是
 *      一个数，否则「寄得出、收不回」，界面上"这封是全文"也成了假话。
 *
 * 字节口径：先把整封报文**逐字节**摊成 latin1 字符串来切结构与行（每个字符就是一个字节，
 * 下标即字节序），这样 `bytes`（整封报文）与附件的 `bytes`（该段解码后）都是真实字节数，
 * 不会因为 TextDecoder 的替换字符而失真；字符集只在"把某一段变成可读文本"时才解一次，
 * 认不出来退回 UTF-8，非法字节由 TextDecoder 替换掉。
 */

import type { ParsedMail } from "./mailboxTypes";

/** 头部值与地址的长度闸：来源是不可信的外站，超限就截，不跟它计较 */
const VALUE_MAX = 500;
const ADDRESS_MAX = 254;
const NAME_MAX = 120;
const FILE_NAME_MAX = 200;
/** 正文上限：与 src/mail/send.ts 的 TEXT_MAX 同尺 */
const TEXT_MAX = 20_000;
/** 原始头值先收在这个长度上，挡掉"一行几 MB"的病态输入；最终字段仍按上面的上限截 */
const RAW_VALUE_MAX = 2000;
/** 一封信里最多读这么多段 / 嵌这么深： MIME 允许嵌套，但没允许拿嵌套把内存吃完 */
const MAX_PARTS = 200;
const MAX_DEPTH = 8;
/** Date 能表示的最大毫秒差，超出它 toISOString() 自己会抛 RangeError */
const DATE_EXTREME = 8.64e15;
/** 只认这几家 CTE，别的按原样（等价于 binary）处理：不认识不等于可以拒绝这封信 */
const KNOWN_CTE = ["base64", "quoted-printable", "7bit", "8bit", "binary"];
/** 头行长什么样：首字符非空白非冒号，且后面有冒号。不像头的行一律算进体里 */
const HEADER_LINE_RE = /^[^ \t:][^:]*:/;
const ENCODED_WORD_RE = /=\?([^?\s]{1,64})\?([BbQq])\?([^?]*)\?=/g;

interface Part {
  headers: Map<string, string>;
  /** 段体的原始行（latin1，已去掉段头与空行分隔符） */
  lines: string[];
}

/** 一次遍历攒出来的四样东西；plain/html 用 null 区分"没见到"与"见到但是空段" */
interface Sink {
  plain: string | null;
  html: string | null;
  attachments: { name: string; bytes: number }[];
  budget: number;
}

interface FieldParams {
  /** 分号前的那一段：Content-Type 的类型本体，或 Content-Disposition 的 disposition */
  base: string;
  params: Record<string, string>;
}

// ── 字节与文本 ────────────────────────────────────────────────

/**
 * 入参归一成字节。string 也要按 UTF-8 算字节（口径 4），Cloudflare 的 email()
 * 给的是 Uint8Array，string 那条路是本地联调与测试用的。
 * 这里手写 UTF-8 而不是 TextEncoder：白名单只有 TextDecoder / atob / Uint8Array。
 */
function toBytes(raw: Uint8Array | string): Uint8Array {
  const v = raw as unknown;
  if (typeof v === "string") return encodeUtf8(v);
  if (v instanceof Uint8Array) return v;
  try {
    // 其它视图（DataView、Int8Array……）按视图范围取，别用 new Uint8Array(数字) 那条
    // 会把长度当字节数的路：传错了顶多是空报文，不能凭空报出几 MB
    if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
    if (v instanceof ArrayBuffer) return new Uint8Array(v);
  } catch {
    // 分离过的 buffer（detached）连视图都建不出来：交给空报文，后面读到的都是空串
  }
  return new Uint8Array(0);
}

function encodeUtf8(text: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    else if (c >= 0xd800 && c < 0xe000) {
      const lo = i + 1 < text.length ? text.charCodeAt(i + 1) : 0;
      if (c < 0xdc00 && lo >= 0xdc00 && lo < 0xe000) {
        const cp = 0x10000 + ((c - 0xd800) << 10) + (lo - 0xdc00);
        out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
        i++;
      } else out.push(0xef, 0xbf, 0xbd); // 落单的代理对：与 TextEncoder 一致，替换掉
    } else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
  }
  return Uint8Array.from(out);
}

/** 逐字节摊成字符串：每个字符的码点就是那一个字节的值 */
function toLatin1(bytes: Uint8Array): string {
  let s = "";
  const CHUNK = 4096;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const view = bytes.subarray(i, i + CHUNK);
    const codes: number[] = [];
    for (let j = 0; j < view.length; j++) codes.push(view[j]);
    s += String.fromCharCode(...codes);
  }
  return s;
}

/** latin1 字符串摊回字节（长度不变，所以附件字节数是真实的） */
function bytesFromLatin1(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}

/** 段的原始字节：行用 \n 连接，段尾那个空行是 MIME 的传输填充，丢掉 */
function bytesOfLines(lines: string[]): Uint8Array {
  let end = lines.length;
  while (end > 0 && lines[end - 1] === "") end--;
  const active = lines.slice(0, end);
  // 先算准长度：多留一格就会在正文尾巴上留一个 NUL，界面看到的是"正文末尾莫名多一个空字符"
  let n = active.length > 1 ? active.length - 1 : 0;
  for (const l of active) n += l.length;
  const out = new Uint8Array(n);
  let p = 0;
  for (let i = 0; i < active.length; i++) {
    const l = active[i];
    for (let j = 0; j < l.length; j++) out[p++] = l.charCodeAt(j) & 0xff;
    if (i < active.length - 1) out[p++] = 10;
  }
  return out;
}

const DECODERS = new Map<string, TextDecoder>();

/**
 * 字符集不认识或非法时退回 UTF-8（口径 6）。TextDecoder 的构造在标签非法时会抛，
 * 非法字节则按非 fatal 模式替换掉 —— 两种"坏"都不许把整封信带走。
 */
function decoderFor(charset: string): TextDecoder {
  const key = (charset || "").toLowerCase();
  const cached = DECODERS.get(key);
  if (cached) return cached;
  let d: TextDecoder;
  try {
    d = new TextDecoder(/^[a-z0-9][a-z0-9_-]{0,63}$/.test(key) ? key : "utf-8", { fatal: false, ignoreBOM: false });
    // 构造没抛不等于在这台运行时真能用这个标签：解一个字节试试，抛了就算它无效
    d.decode(new Uint8Array([0xff]));
  } catch {
    d = new TextDecoder("utf-8", { fatal: false, ignoreBOM: false });
  }
  DECODERS.set(key, d);
  return d;
}

function decodeText(data: Uint8Array, charset: string): string {
  try {
    return normalizeNewlines(decoderFor(charset).decode(data));
  } catch {
    try {
      return normalizeNewlines(new TextDecoder("utf-8").decode(data));
    } catch {
      return "";
    }
  }
}

function normalizeNewlines(s: string): string {
  return s.replace(/\r\n?/g, "\n");
}

function cut(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

// ── 转移编码 ──────────────────────────────────────────────────

/**
 * base64：先丢掉一切非字母表字符（折行的 \r\n、空格、混进来的垃圾），再把补位号
 * 摘掉重算 —— 长度不整（被截断的信）时裁到能解的那一段，而不是抛。
 * atob 只可能因为长度不成形而抛（非法字符已经丢干净了），抛了就退回最大的完整组。
 */
function b64ToBytes(text: string): Uint8Array {
  const chars = text.replace(/[^A-Za-z0-9+/]/g, "");
  const rem = chars.length % 4;
  const padded = rem === 0 ? chars : rem === 1 ? chars.slice(0, -1) : chars + "=".repeat(4 - rem);
  for (const candidate of [padded, chars.slice(0, chars.length - (chars.length % 4))]) {
    if (!candidate) continue;
    try {
      const bin = atob(candidate);
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i) & 0xff;
      return out;
    } catch {
      // 换下一个更短的候选
    }
  }
  return new Uint8Array(0);
}

function hexByte(text: string, i: number): number | null {
  const c = text.charCodeAt(i);
  if (c >= 48 && c <= 57) return c - 48;
  if (c >= 65 && c <= 70) return c - 55;
  if (c >= 97 && c <= 102) return c - 87;
  return null;
}

/** quoted-printable：`=` 十六进制是字节，行尾 `=` 是软换行（接下一行，不插换行） */
function qpToBytes(lines: string[], keepBreaks: boolean): Uint8Array {
  const out: number[] = [];
  for (let n = 0; n < lines.length; n++) {
    let line = lines[n].replace(/[ \t]+$/, "");
    let hardBreak = true;
    if (keepBreaks) {
      const soft = /=$/.exec(line);
      if (soft) {
        line = line.slice(0, soft.index);
        hardBreak = false;
      }
    }
    for (let i = 0; i < line.length; i++) {
      const c = line.charCodeAt(i);
      if (c === 61) {
        const hi = hexByte(line, i + 1);
        const lo = hexByte(line, i + 2);
        if (hi !== null && lo !== null) {
          out.push(hi * 16 + lo);
          i += 2;
          continue;
        }
        out.push(61); // 光杆一个 = ：按字面留着，别把后面的字符吃掉
        continue;
      }
      if (c === 95 && !keepBreaks) {
        out.push(32); // RFC 2047 的 Q 编码里下划线代表空格
        continue;
      }
      out.push(c & 0xff);
    }
    if (keepBreaks && hardBreak && n < lines.length - 1) out.push(10);
  }
  return Uint8Array.from(out);
}

// ── 头部 ─────────────────────────────────────────────────────

/** RFC 2047 编码词：=?charset?B|Q?text?=；相邻编码词之间的空白是折行留下的，不算内容 */
function decodeWords(value: string): string {
  let out = "";
  let last = 0;
  let afterWord = false;
  ENCODED_WORD_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ENCODED_WORD_RE.exec(value)) !== null) {
    const between = value.slice(last, m.index);
    out += afterWord && between.trim() === "" ? "" : headerToText(between);
    out += decodeWord(m[1], m[2], m[3]);
    afterWord = true;
    last = m.index + m[0].length;
  }
  return out + headerToText(value.slice(last));
}

const FATAL_UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

/**
 * 头部里非 ASCII 的那一段：结构是从**逐字节**视图上切的，所以裸 8 位字节在这里
 * 是一串 latin1 形状的字符（"报告" 会变成 "æ¥å"）。编码词自带 charset 不用管，
 * 剩下那些裸字节按 UTF-8 严格解一次，解不动才按 latin1 认 —— 顺序反了的话，
 * 一个 Latin-1 的 é 会被当成半个 UTF-8 序列变成乱码。
 */
function headerToText(value: string): string {
  if (!/[^\x00-\x7f]/.test(value)) return value;
  const data = bytesFromLatin1(value);
  try {
    return FATAL_UTF8.decode(data);
  } catch {
    let s = "";
    for (let i = 0; i < data.length; i++) s += String.fromCharCode(data[i]);
    return s;
  }
}

/** 地址列表里取第一个 mailbox：顶层逗号前那段（引号与尖括号里的逗号不算分隔） */
function firstMailbox(value: string): string {
  let quote = false;
  let escaped = false;
  let angle = 0;
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (c === "\\") {
      escaped = true;
      continue;
    }
    if (c === '"') {
      quote = !quote;
      continue;
    }
    if (quote) continue;
    if (c === "<") angle++;
    else if (c === ">") angle = angle > 0 ? angle - 1 : 0;
    else if (c === "," && angle === 0) return value.slice(0, i);
  }
  return value;
}

function decodeWord(charset: string, encoding: string, text: string): string {
  const data = encoding.toLowerCase() === "b" ? b64ToBytes(text) : qpToBytes([text], false);
  return decodeText(data, charset);
}

function stripComments(value: string): string {
  let s = value;
  for (let i = 0; i < 3 && s.includes("("); i++) s = s.replace(/\(([^()]*)\)/g, " ");
  const open = s.indexOf("(");
  if (open >= 0 && !s.includes(")")) s = s.slice(0, open); // 没闭合的注释：后面全是注释
  return s.replace(/\s+/g, " ").trim();
}

function unquote(value: string): string {
  let s = value.trim();
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) s = s.slice(1, -1);
  return s.replace(/\\([\\"])/g, "$1").trim();
}

/** 取第一个地址：To 里那串通常第一个就是本信箱自己 */
function firstAddress(value: string): { name: string; addr: string } {
  // 注释先去、编码词先解，再切列表：多个地址时显示名不许把第二个地址一起粘进来
  const v = firstMailbox(stripComments(decodeWords(value)));
  const lt = v.indexOf("<");
  if (lt >= 0) {
    const gt = v.indexOf(">", lt);
    const addr = (gt > lt ? v.slice(lt + 1, gt) : v.slice(lt + 1)).trim();
    const name = unquote(`${v.slice(0, lt).trim()} ${gt > lt ? v.slice(gt + 1) : ""}`.trim());
    return { name: cut(name, NAME_MAX), addr: cut(cleanAddress(addr), ADDRESS_MAX) };
  }
  const first = unquote(v.split(",")[0] ?? "");
  if (!first.includes("@")) return { name: "", addr: "" };
  return { name: "", addr: cut(cleanAddress(first), ADDRESS_MAX) };
}

/** 地址里一切能改动报文行的字符都剔掉：这层不判合法性（那是 store 的事），只保证不带毒 */
function cleanAddress(addr: string): string {
  return addr.replace(/[\s<>"',;]/g, "").replace(/[\u0000-\u001f\u007f]/g, "");
}

/** ISO 8601 与 RFC 2822 两种形状都先试原生 Date.parse，认不出的常见变体再补一手 */
function parseDateHeader(value: string): number | null {
  const cleaned = stripComments(value);
  if (!cleaned) return null;
  const direct = Date.parse(cleaned);
  if (Number.isFinite(direct)) return direct;
  const named = /^([A-Za-z]{3,9},)?\s*(\d{1,2})\s+([A-Za-z]{3,9})\s+(\d{2,4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([+-]\d{4}|[A-Za-z]{1,5})?$/.exec(
    cleaned,
  );
  if (named) {
    const month = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"].indexOf(
      named[3].toLowerCase(),
    );
    if (month >= 0) {
      let offsetMinutes = 0;
      const zone = named[8] || "";
      if (/^[+-]\d{4}$/.test(zone)) {
        const sign = zone[0] === "-" ? -1 : 1;
        offsetMinutes = sign * (Number(zone.slice(1, 3)) * 60 + Number(zone.slice(3, 5)));
      }
      let year = Number(named[4]);
      if (year < 100) year += year < 50 ? 2000 : 1900;
      const ms = Date.UTC(year, month, Number(named[2]), Number(named[5]), Number(named[6]), Number(named[7] || 0));
      if (Number.isFinite(ms)) return ms - offsetMinutes * 60_000;
    }
  }
  const iso = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})(?::(\d{2}))?\s*(Z|[+-]\d{2}:?\d{2})?$/i.exec(cleaned);
  if (iso) {
    const ms = Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]), Number(iso[4]), Number(iso[5]), Number(iso[6] || 0));
    if (Number.isFinite(ms)) return ms;
  }
  return null;
}

/** 落回 `now`：不读时钟（口径 2）；没给 now 就用 epoch，也不动 Date.now() */
function isoOf(ms: number): string {
  const safe = Math.min(Math.max(Math.round(ms), -DATE_EXTREME), DATE_EXTREME);
  try {
    return new Date(safe).toISOString();
  } catch {
    return new Date(0).toISOString();
  }
}

// ── MIME 参数与结构 ───────────────────────────────────────────

/**
 * 分号分隔的参数，引号里的分号不算分隔（`boundary="a;b"`、`filename="x; y"` 真见过）。
 * 键一律小写：头部字段名与参数名都大小写不敏感（口径 5）。
 */
function parseParams(value: string): FieldParams {
  const parts: string[] = [];
  let cur = "";
  let quoted = false;
  let escaped = false;
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (escaped) {
      cur += c;
      escaped = false;
    } else if (c === "\\" && quoted) escaped = true;
    else if (c === '"') {
      quoted = !quoted;
      cur += c;
    } else if (c === ";" && !quoted) {
      parts.push(cur);
      cur = "";
    } else cur += c;
  }
  parts.push(cur);
  const base = (parts.shift() ?? "").trim();
  const params: Record<string, string> = {};
  for (const p of parts) {
    const eq = p.indexOf("=");
    if (eq < 0) continue;
    const k = p.slice(0, eq).trim().toLowerCase();
    if (!k) continue;
    params[k] = unquote(p.slice(eq + 1));
  }
  return { base, params };
}

/** 附件名：优先 filename*（RFC 2231 的百分号形式，可分段），退回 filename / name */
function fileNameOf(...sources: Record<string, string>[]): string {
  let plain = "";
  let encoded = "";
  const segs: { idx: number; value: string }[] = [];
  for (const src of sources) {
    if (!plain && src.filename) plain = src.filename;
    if (!plain && src.name) plain = src.name;
    if (!encoded && src["filename*"]) encoded = src["filename*"];
    for (const k of Object.keys(src)) {
      const m = /^filename\*(\d{1,3})\*?$/.exec(k);
      if (m) segs.push({ idx: Number(m[1]), value: src[k] });
    }
  }
  if (!encoded && segs.length) {
    segs.sort((a, b) => a.idx - b.idx);
    encoded = segs.map((s) => s.value).join("");
  }
  return cut(encoded ? decodeRfc2231(encoded) : headerToText(plain), FILE_NAME_MAX);
}

/** `UTF-8''%E4%B8%AD.pdf` → 按 charset 百分号解回来；形不成三段就整串按 UTF-8 试 */
function decodeRfc2231(value: string): string {
  const m = /^([^']*)'[^']*'(.*)$/s.exec(value);
  const charset = m ? m[1] : "";
  const body = (m ? m[2] : value).replace(/["']/g, "");
  const bytes: number[] = [];
  for (let i = 0; i < body.length; i++) {
    if (body[i] === "%") {
      const hi = hexByte(body, i + 1);
      const lo = hexByte(body, i + 2);
      if (hi !== null && lo !== null) {
        bytes.push(hi * 16 + lo);
        i += 2;
        continue;
      }
    }
    bytes.push(body.charCodeAt(i) & 0xff);
  }
  return decodeText(Uint8Array.from(bytes), charset || "utf-8");
}

function readHeaders(lines: string[]): { headers: Map<string, string>; rest: string[] } {
  const raw: string[] = [];
  let i = 0;
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (line === "") {
      i++;
      break; // 头/体分隔的空行
    }
    if (/^[ \t]/.test(line)) {
      // obs-fold：续行以空格或制表符开头，并回上一行（连着前面的 WSP 一起并，
      // 结构化头与 2047 都靠这个空格不至于把两个词粘成一个）
      if (raw.length) raw[raw.length - 1] += line;
      continue;
    }
    if (!HEADER_LINE_RE.test(line)) break; // 不像头的行起就是体
    raw.push(line);
  }
  const headers = new Map<string, string>();
  for (const line of raw) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    if (!name || headers.has(name)) continue; // 同名的头取第一个
    headers.set(name, cut(line.slice(colon + 1).trim(), RAW_VALUE_MAX));
  }
  return { headers, rest: lines.slice(i) };
}

function headerOf(part: Part, name: string): string {
  return part.headers.get(name) ?? "";
}

function splitMultipart(lines: string[], boundary: string): string[][] {
  const dash = `--${boundary}`;
  const sections: string[][] = [];
  let i = 0;
  let closed = false;
  while (i < lines.length && !lines[i].startsWith(dash)) i++; // 前言丢掉
  if (i >= lines.length) return sections;
  let current: string[] | null = null;
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith(dash)) {
      if (current) {
        sections.push(current);
        current = null;
      }
      // 切段本身也要有上限：一封拿同样的边界刷一万行的信，不该在解析结构时就把内存吃光
      if (sections.length >= MAX_PARTS) break;
      if (line.slice(dash.length).trimStart().startsWith("--")) {
        closed = true;
        break;
      }
      current = [];
      continue;
    }
    if (current) current.push(line);
  }
  // 半截 multipart（截断的来件、边界写错的发件端）：最后一段照旧交下去解析
  if (!closed && current) sections.push(current);
  return sections;
}

function cteOf(part: Part): string {
  const raw = headerOf(part, "content-transfer-encoding").toLowerCase().replace(/[^a-z0-9+-]/g, "");
  return KNOWN_CTE.includes(raw) ? raw : "";
}

/** 段体按 CTE 还原成字节：base64 / quoted-printable，其余（含认不出的）原样 */
function decodeBody(part: Part): Uint8Array {
  const cte = cteOf(part);
  if (cte === "base64") return b64ToBytes(part.lines.join(""));
  if (cte === "quoted-printable") return qpToBytes(part.lines, true);
  return bytesOfLines(part.lines);
}

function walkPart(part: Part, depth: number, sink: Sink): void {
  if (sink.budget <= 0 || depth > MAX_DEPTH) return; // 超预算就停在这，不抛
  sink.budget--;
  const ct = parseParams(headerOf(part, "content-type"));
  const cd = parseParams(headerOf(part, "content-disposition"));
  const base = (ct.base || "text/plain").toLowerCase().trim(); // 没有 Content-Type 就是 text/plain（RFC 2045）
  const slash = base.indexOf("/");
  const type = (slash > 0 ? base.slice(0, slash) : base).trim();
  const subtype = slash > 0 ? base.slice(slash + 1).trim() : "";

  if (type === "multipart") {
    const boundary = (ct.params.boundary ?? "").trim();
    if (!boundary) {
      // 自称 multipart 却给不出 boundary：不猜分隔符，把整段的体当纯文本读出来
      sink.plain ??= decodeText(decodeBody(part), ct.params.charset ?? "");
      return;
    }
    for (const section of splitMultipart(part.lines, boundary)) {
      if (sink.budget <= 0) break;
      const parsed = readHeaders(section);
      walkPart({ headers: parsed.headers, lines: parsed.rest }, depth + 1, sink);
    }
    return;
  }

  const data = decodeBody(part);
  const filename = fileNameOf(cd.params, ct.params);
  const disposition = (cd.base || "").toLowerCase().trim();
  const isText = type === "text";
  // 口径 7 的三个条件：disposition=attachment、带 filename、或类型既非 text/* 也非 multipart/*
  const isAttachment = disposition === "attachment" || filename !== "" || (!isText && type !== "multipart");
  if (isAttachment) sink.attachments.push({ name: filename, bytes: data.length });
  if (isText && disposition !== "attachment") {
    // text/html 只进 html；其余 text/*（plain、csv、richtext……）都进 plain 这一格，
    // 宁可读出带点标记的文本，也好过界面上一片空白。plain 已有值时后来的不再覆盖
    const text = decodeText(data, ct.params.charset ?? "");
    if (subtype === "html") sink.html ??= text;
    else sink.plain ??= text;
  }
}

// ── HTML 兜底（口径 8）───────────────────────────────────────

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: "\u00a0",
};

/** 一次正则扫完，避免把 `&amp;lt;` 二次解成 `<` */
function decodeEntities(text: string): string {
  return text.replace(/&#([xX])?([0-9a-fA-F]{1,7});|&(amp|lt|gt|quot|apos|nbsp);/g, (whole, hexMark, digits, name) => {
    if (name) return NAMED_ENTITIES[name] ?? whole;
    const cp = hexMark ? Number.parseInt(digits, 16) : Number.parseInt(digits, 10);
    if (!Number.isFinite(cp) || cp < 0 || cp > 0x10ffff) return whole;
    try {
      return String.fromCodePoint(cp);
    } catch {
      return whole;
    }
  });
}

/**
 * 只有 HTML 的信：先把 script/style 的**内容**整段删掉（不闭合的一路删到结尾），
 * 再去标签，最后还原实体。去标签要求尖括号后先是字母或 `/`，否则正文里的
 * 「x < 5 and y > 3」会被当成一个标签吃掉。
 */
function htmlToText(html: string): string {
  let s = html.replace(/<!--[\s\S]*?(?:-->|$)/g, "");
  s = s.replace(/<(script|style)\b[\s\S]*?(?:<\/\1[ \t]*>|$)/gi, "");
  s = s.replace(/<br\s*\/?[ \t]*>/gi, "\n");
  s = s.replace(/<\/(p|div|li|ul|ol|tr|td|th|table|h[1-6]|blockquote|pre|section|article|header|footer|html|body)[ \t]*>/gi, "\n");
  s = s.replace(/<\/?[a-z!][^>]*>/gi, "");
  s = decodeEntities(s);
  s = normalizeNewlines(s).replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n");
  return s.trim();
}

// ── 入口 ─────────────────────────────────────────────────────

function emptyParsed(nowMs: number, bytes: number): ParsedMail {
  return {
    at: isoOf(nowMs),
    from: "",
    fromName: "",
    to: "",
    subject: "",
    replyTo: "",
    text: "",
    bytes,
    hasAttachment: false,
    attachments: [],
    htmlOnly: false,
    truncated: false,
  };
}

/**
 * 解一封入站报文。永不抛错，字段缺省一律空串/空数组，`bytes` 照实报。
 * 调用方（email() 入口 → store.ts）决定这一封收不收；这里只负责"能读出多少算多少"。
 */
export function parseIncoming(raw: Uint8Array | string, now?: number): ParsedMail {
  const nowMs = Number.isFinite(now) ? (now as number) : 0;
  let data: Uint8Array;
  try {
    data = toBytes(raw);
  } catch {
    return emptyParsed(nowMs, 0);
  }
  try {
    return parseBytes(data, nowMs);
  } catch {
    // 兜底：内部任何一处没兜住的意外，都只交出一份"只有字节数"的结果。
    // 这一行是"永不抛错"的最后两道闸：第二道在入口，第一道在每个读点。
    return emptyParsed(nowMs, data.length);
  }
}

function parseBytes(data: Uint8Array, nowMs: number): ParsedMail {
  const lines = toLatin1(data).split(/\r\n|\n|\r/);
  const parsed = readHeaders(lines);
  const headers = parsed.headers;
  const root: Part = { headers, lines: parsed.rest };

  const from = firstAddress(headerOf(root, "from"));
  const to = firstAddress(headerOf(root, "to"));
  const replyTo = headerOf(root, "reply-to") ? firstAddress(headerOf(root, "reply-to")).addr : "";
  const dateMs = headerOf(root, "date") ? parseDateHeader(headerOf(root, "date")) : null;

  const sink: Sink = { plain: null, html: null, attachments: [], budget: MAX_PARTS };
  walkPart(root, 0, sink);

  const htmlOnly = sink.plain === null && sink.html !== null;
  const full = sink.plain !== null ? sink.plain : htmlOnly ? htmlToText(sink.html ?? "") : "";
  const truncated = full.length > TEXT_MAX;
  const text = truncated ? cut(full, TEXT_MAX) : full;

  return {
    at: isoOf(dateMs !== null ? dateMs : nowMs),
    from: from.addr,
    fromName: from.name,
    to: to.addr,
    subject: cut(decodeWords(headerOf(root, "subject")).trim(), VALUE_MAX),
    replyTo,
    text,
    bytes: data.length,
    hasAttachment: sink.attachments.length > 0,
    attachments: sink.attachments,
    htmlOnly,
    truncated,
  };
}
