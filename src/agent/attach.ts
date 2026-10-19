// 对话内附件：把用户随手丢进来的文件变成一段模型能读的话，入口在输入框旁，出口是当轮上下文。
// 图片 → 原图直接进消息，前端没内联的才请视觉模型转述；文本/代码 → 直读并截断告知；
// PDF → 抽文字层，扫描件抽不出就明说；音频 → 转写；视频 → 只送音轨并写明「画面没看」。
// Worker 解不了视频画面（要 WASM ffmpeg），假装看过比说「看不了」糟得多。

import { describeImage } from "../tools/vision";

export type AttachKind =
  "image" | "text" | "pdf" | "audio" | "video" | "unknown";

export interface Attachment {
  kind: AttachKind;
  /** 文件名（去掉路径前缀） */
  name: string;
  size: number;
  /** 读到的正文，给模型看。空串 = 这次什么也没读到 */
  text: string;
  /** 一句话结论：读到了什么，或者为什么读不到 */
  note: string;
}

/** 文本类最多读这么多字。再多不是读不完，是没必要 —— 上下文是有代价的。 */
const MAX_TEXT = 24000;
/** PDF 抽出来的文字上限 */
const MAX_PDF = 30000;
/** PDF 本体上限：抽文字要先把整个文件摊成字符串，太大的会撑爆内存 */
const MAX_PDF_BYTES = 12 * 1024 * 1024;
/** 转写接口的体积上限（智谱 GLM-ASR 是 25MB），留一点余量 */
const MAX_MEDIA = 20 * 1024 * 1024;
/** 太小的「音频」多半是个空文件，不值得花一次转写 */
const MIN_MEDIA = 1024;

const ASR_URL = "https://open.bigmodel.cn/api/paas/v4/audio/transcriptions";

const IMAGE_EXT = new Set([
  "png",
  "jpg",
  "jpeg",
  "webp",
  "bmp",
  "gif",
  "heic",
  "avif",
]);
const AUDIO_EXT = new Set([
  "mp3",
  "wav",
  "m4a",
  "aac",
  "flac",
  "ogg",
  "oga",
  "opus",
  "amr",
  "wma",
  "silk",
]);
const VIDEO_EXT = new Set([
  "mp4",
  "mov",
  "mkv",
  "webm",
  "avi",
  "m4v",
  "flv",
  "3gp",
]);
const TEXT_EXT = new Set([
  "txt",
  "md",
  "markdown",
  "log",
  "csv",
  "tsv",
  "json",
  "jsonl",
  "yaml",
  "yml",
  "toml",
  "ini",
  "env",
  "xml",
  "html",
  "htm",
  "css",
  "scss",
  "less",
  "js",
  "jsx",
  "ts",
  "tsx",
  "mjs",
  "cjs",
  "vue",
  "svelte",
  "py",
  "rb",
  "go",
  "rs",
  "java",
  "kt",
  "c",
  "h",
  "cpp",
  "hpp",
  "cs",
  "php",
  "swift",
  "sh",
  "bash",
  "zsh",
  "ps1",
  "bat",
  "sql",
  "conf",
  "properties",
  "lock",
  "gitignore",
  "dockerfile",
]);

function extOf(name: string): string {
  const m = /\.([a-z0-9]+)$/i.exec(name.trim());
  return m ? m[1].toLowerCase() : "";
}

/** 这份文件该按哪一类读。名字和 MIME 谁说得准就用谁 —— 两边都可能缺。 */
export function kindOf(name: string, mime: string): AttachKind {
  const e = extOf(name);
  const t = (mime || "").toLowerCase();
  if (t.startsWith("image/") || IMAGE_EXT.has(e)) return "image";
  if (t.startsWith("audio/") || AUDIO_EXT.has(e)) return "audio";
  if (t.startsWith("video/") || VIDEO_EXT.has(e)) return "video";
  if (t === "application/pdf" || e === "pdf") return "pdf";
  if (
    t.startsWith("text/") ||
    t.includes("json") ||
    t.includes("xml") ||
    TEXT_EXT.has(e)
  )
    return "text";
  return "unknown";
}

/** 这一类的中文名，给用户看的 */
export const KIND_LABEL: Record<AttachKind, string> = {
  image: "图片",
  text: "文本",
  pdf: "PDF",
  audio: "音频",
  video: "视频",
  unknown: "文件",
};

function mb(n: number): string {
  if (n < 1024) return n + "B";
  if (n < 1024 * 1024) return Math.round(n / 1024) + "KB";
  return (n / 1024 / 1024).toFixed(1) + "MB";
}

/**
 * 读一份刚上传的文件。native = 前端已把原图放进消息（主模型能直接看图，转述反而掉细节）；
 * 内联有上限（端点单图 5MB、base64 膨胀 1/3），超限或冷门格式才请视觉模型转述。
 * 不抛错：读不出来是常态，带一句人话回去，不能让整个上传 500。
 */
export async function analyzeUpload(
  env: Env,
  key: string,
  name: string,
  native = false,
): Promise<Attachment> {
  const label = (name || key).split("/").pop() || key;
  const obj = await env.MEMORY_BUCKET.get(key);
  if (!obj)
    return {
      kind: "unknown",
      name: label,
      size: 0,
      text: "",
      note: "没找到这个文件，可能已经被删了",
    };

  const mime = obj.httpMetadata?.contentType || "";
  const kind = kindOf(label, mime);
  const size = obj.size;

  try {
    if (kind === "image") {
      if (native) {
        // 云盘 key 一起给他：他想让这张图进记忆库时（type=image），指针就是它
        return {
          kind,
          name: label,
          size,
          text: "",
          note: `原图已直接放进这条消息，我能亲眼看到（云盘 key：${key}）`,
        };
      }
      const r = await describeImage(env, key);
      if (!r.ok)
        return {
          kind,
          name: label,
          size,
          text: "",
          note: `看图没成功：${r.error}`,
        };
      return {
        kind,
        name: label,
        size,
        text: r.text,
        note: `画面已经看过了（${r.model}）`,
      };
    }

    if (kind === "pdf") {
      if (size > MAX_PDF_BYTES) {
        return {
          kind,
          name: label,
          size,
          text: "",
          note: `这份 PDF 有 ${mb(size)}，超过我能抽文字的上限（${mb(MAX_PDF_BYTES)}）`,
        };
      }
      const full = await pdfText(await obj.arrayBuffer());
      if (!readable(full)) {
        return {
          kind,
          name: label,
          size,
          text: "",
          note: "这份 PDF 里抽不出文字 —— 多半是扫描件或图片拼的，我读不了它的内容",
        };
      }
      const cut = full.slice(0, MAX_PDF);
      return {
        kind,
        name: label,
        size,
        text: cut,
        note:
          full.length > MAX_PDF
            ? `抽到 ${full.length} 字，先读了前 ${MAX_PDF} 字`
            : `抽到 ${full.length} 字`,
      };
    }

    if (kind === "audio" || kind === "video") {
      if (size < MIN_MEDIA)
        return {
          kind,
          name: label,
          size,
          text: "",
          note: "这个文件几乎是空的，没什么可听的",
        };
      if (size > MAX_MEDIA) {
        return {
          kind,
          name: label,
          size,
          text: "",
          note: `${mb(size)} 太大了，超过转写能处理的 ${mb(MAX_MEDIA)}`,
        };
      }
      const said = await transcribe(env, await obj.arrayBuffer(), label, mime);
      const head =
        kind === "video"
          ? "画面我看不了（只能听声音），以下是音轨转成的文字。"
          : "";
      if (!said.ok) {
        return {
          kind,
          name: label,
          size,
          text: "",
          note: `${head}录音没能转成文字：${said.error}`,
        };
      }
      return {
        kind,
        name: label,
        size,
        text: said.text,
        note: head || `已转成文字（${said.text.length} 字）`,
      };
    }

    // 剩下的按文本试一把：解不出来就说解不出来，不硬凑
    const raw = await obj.text();
    if (looksBinary(raw)) {
      return {
        kind,
        name: label,
        size,
        text: "",
        note: `这种格式（${mime || extOf(label) || "未知"}）我读不出文字内容`,
      };
    }
    const cut = raw.slice(0, MAX_TEXT);
    return {
      kind: label ? "text" : kind,
      name: label,
      size,
      text: cut,
      note:
        raw.length > MAX_TEXT
          ? `一共 ${raw.length} 字，先读了前 ${MAX_TEXT} 字`
          : `${raw.length} 字`,
    };
  } catch (e) {
    return {
      kind,
      name: label,
      size,
      text: "",
      note: `读这个文件时出错了：${(e as Error).message.slice(0, 160)}`,
    };
  }
}

/** 解码后满是替换字符或空字节，说明它根本不是文本 */
function looksBinary(s: string): boolean {
  const probe = s.slice(0, 4000);
  if (!probe) return false;
  if (probe.includes("\u0000")) return true;
  const bad = (probe.match(/\uFFFD/g) || []).length;
  return bad / probe.length > 0.02;
}

/** 抽出来的文字像不像人话：人话里中英文和标点该占大多数 */
function readable(s: string): boolean {
  const t = s.trim();
  if (t.length < 20) return false;
  const ok = (
    t.match(/[\u4e00-\u9fff\u3000-\u303fA-Za-z0-9，。！？、：；（）]/g) || []
  ).length;
  return ok / t.length > 0.5;
}

// ── 转写（音频 / 视频音轨）────────────────────────────

async function transcribe(
  env: Env,
  bytes: ArrayBuffer,
  name: string,
  mime: string,
): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  const apiKey = env.ZHIPU_KEY;
  if (!apiKey)
    return { ok: false, error: "ZHIPU_KEY 没配，没法把录音转成文字" };

  const form = new FormData();
  form.append("model", "glm-asr");
  // 视频文件原样送过去：转写服务会自己取音轨，能取到就转，取不到会回错
  form.append(
    "file",
    new Blob([bytes], { type: mime || "application/octet-stream" }),
    name,
  );

  try {
    const r = await fetch(ASR_URL, {
      method: "POST",
      headers: { Authorization: "Bearer " + apiKey },
      body: form,
    });
    if (!r.ok)
      return {
        ok: false,
        error: `HTTP ${r.status} ${(await r.text()).slice(0, 200)}`,
      };
    const j = (await r.json()) as {
      text?: unknown;
      choices?: Array<{ message?: { content?: unknown } }>;
    };
    const text =
      typeof j.text === "string"
        ? j.text
        : typeof j.choices?.[0]?.message?.content === "string"
          ? (j.choices![0].message!.content as string)
          : "";
    if (!text.trim())
      return { ok: false, error: "回的是空内容（可能是纯音乐，或没有人声）" };
    return { ok: true, text: text.trim() };
  } catch (e) {
    return { ok: false, error: (e as Error).message.slice(0, 160) };
  }
}

// ── PDF 抽文字 ────────────────────────────────────────
//
// 不引 pdf.js：只为读一段文字把大依赖搬进 Worker 不划算。这里只解压内容流取字符串；
// 扫描件、加密、内嵌 CID 字体抽不出就老实说。

/** 一字节一字地摊成字符串。索引与字节一一对应，后面切分还要靠这个特性。 */
function latin1(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 8192)
    s += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return s;
}

/** 把 `stream ... endstream` 之间那段切出来 */
function pdfStreams(bytes: Uint8Array, raw: string): Uint8Array[] {
  const out: Uint8Array[] = [];
  let at = 0;
  for (;;) {
    const s = raw.indexOf("stream", at);
    if (s < 0) break;
    // 「endstream」里也含 stream 这个词，别把它当成开头
    if (raw.startsWith("endstream", s)) {
      at = s + 9;
      continue;
    }
    let start = s + 6;
    if (raw[start] === "\r") start++;
    if (raw[start] === "\n") start++;
    const end = raw.indexOf("endstream", start);
    if (end < 0) break;
    let stop = end;
    // 结尾的换行属于分隔符，不属于数据
    if (raw[stop - 1] === "\n") stop--;
    if (raw[stop - 1] === "\r") stop--;
    if (stop > start) out.push(bytes.subarray(start, stop));
    at = end + 9;
  }
  return out;
}

/** 解 zlib 流。PDF 的 FlateDecode 就是 zlib；个别文件是裸 deflate，都试一下。 */
async function inflate(part: Uint8Array): Promise<Uint8Array | null> {
  for (const fmt of ["deflate", "deflate-raw"] as const) {
    try {
      const body = new Response(part).body;
      if (!body) return null;
      const out = new Uint8Array(
        await new Response(
          body.pipeThrough(new DecompressionStream(fmt)),
        ).arrayBuffer(),
      );
      if (out.length) return out;
    } catch {
      // 换下一种格式；两种都不成就当它是没压缩的
    }
  }
  return null;
}

async function pdfText(bytes: ArrayBuffer): Promise<string> {
  const u8 = new Uint8Array(bytes);
  const raw = latin1(u8);
  const out: string[] = [];
  for (const s of pdfStreams(u8, raw)) {
    const body = (await inflate(s)) ?? s;
    const c = latin1(body);
    // 只有内容流里才有这两个算子；没有就别浪费时间解析它
    if (!/\b(Tj|TJ)\b/.test(c)) continue;
    out.push(textFromContent(c));
  }
  return tidy(out.join("\n"));
}

/** 在内容流里按「位置变化算子」切段，段内把字符串拼起来 —— 一段大致就是一行 */
function textFromContent(c: string): string {
  const parts = c.split(/\bTd\b|\bTD\b|\bT\*|\bET\b|\bBT\b/);
  const lines = parts.map((p) => stringsIn(p).join("")).filter((s) => s.trim());
  return lines.join("\n");
}

/** 抓出一段内容流里所有的字符串：圆括号串（含转义）和尖括号十六进制串 */
function stringsIn(c: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < c.length; i++) {
    const ch = c[i];
    if (ch === "(") {
      let depth = 1;
      let s = "";
      i++;
      for (; i < c.length && depth > 0; i++) {
        const d = c[i];
        if (d === "\\") {
          const n = c[++i];
          if (n === "n") s += "\n";
          else if (n === "r") s += "";
          else if (n === "t") s += " ";
          else if (n >= "0" && n <= "7") {
            let oct = n;
            while (oct.length < 3 && c[i + 1] >= "0" && c[i + 1] <= "7")
              oct += c[++i];
            s += String.fromCharCode(parseInt(oct, 8));
          } else if (n === undefined) break;
          else s += n;
        } else if (d === "(") {
          depth++;
          s += d;
        } else if (d === ")") {
          depth--;
          if (depth > 0) s += d;
        } else s += d;
      }
      out.push(s);
      i--;
    } else if (ch === "<" && c[i + 1] !== "<") {
      // 字典的 << 不是字符串，排掉
      const close = c.indexOf(">", i);
      if (close < 0) break;
      const hex = c.slice(i + 1, close).replace(/[^0-9a-fA-F]/g, "");
      let s = "";
      for (let k = 0; k + 1 < hex.length; k += 2)
        s += String.fromCharCode(parseInt(hex.slice(k, k + 2), 16));
      out.push(s);
      i = close;
    }
  }
  return out;
}

function tidy(s: string): string {
  return s
    .replace(/\u0000/g, "")
    .replace(/[ \t]+/g, " ")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .join("\n")
    .trim();
}

// ── 拼成给模型看的一段话 ──────────────────────────────
//
// 这段正文原样进对话历史，后续几轮可见，格式要稳：前端按同一套标记拆附件头和正文，
// 好把正文折起来。

export const ATTACH_OPEN = "<<<附件正文";
export const ATTACH_CLOSE = "附件正文>>>";

/** 拼出消息里那段附件块。text 为空就只给一行说明。 */
export function attachBlock(a: Attachment): string {
  const head = `${KIND_LABEL[a.kind]} · ${a.note}`;
  if (!a.text.trim()) return `【附件：${a.name}（${head}）】`;
  return `【附件：${a.name}（${head}）】\n${ATTACH_OPEN}\n${a.text}\n${ATTACH_CLOSE}`;
}
