// 看图这件事分两层，别再混在一起：
//
//   view_image —— 把云盘里的一张图「递」给主模型自己看。
//                 她本来就能看图，中间再插一个视觉模型转述一道，是白等一跳、还掉细节：
//                 「图上有字」和「字是『欠款 ¥3,200』」差着一次生意。
//                 从前那条 analyze_image 就是这层中间商，现在拆了。
//
//   describeImage —— 只服务一处兜底：前端没能把原图内联进消息的时候
//                    （体积过大、格式冷门，见 src/agent/attach.ts）。
//                    那种图她真的看不见，这时才请 GLM-4V 讲成一段话。
//
// 为什么「分析」不再是一条工具：分析是她的活，工具只负责把材料摆到她眼前。

import { tool } from "ai";
import { z } from "zod";
import { canReadFile } from "../fileAccess";
import type { ToolCtx } from "./types";

const ZHIPU_URL = "https://open.bigmodel.cn/api/paas/v4/chat/completions";
const MODELS = ["glm-4.6v", "glm-4v-flash", "glm-4v-plus", "glm-4v"];

/**
 * 单张图能塞进消息的上限。
 *
 * base64 之后还要再涨三分之一，而端点那边单图到 5MB 就直接回错 ——
 * 3.5MB 原图刚好落在安全区里（attach.ts 内联那处用的是同一条线）。
 */
const MAX_INLINE_IMAGE = 3_500_000;

/** 转述用的提示词只此一处：写两份的话，改一处就会有一边悄悄落后 */
const DESCRIBE_PROMPT =
  "请详细描述这张图片的内容。包括：人物（性别年龄衣着表情动作）、物体（种类颜色形状位置）、" +
  "场景（室内外光线氛围）、文字（完整转录）、构图（视角焦点层次）。" +
  "如果图片中有值得特别注意的细节，请指出。用中文，尽可能详细但不要编造。";

/** 端点只认这四种，别的一律塞不进去 */
const OK_MIME = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/** 云盘上有些对象没带 Content-Type，这时按后缀认 */
const EXT_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

function extOf(name: string): string {
  const m = /\.([a-z0-9]+)$/i.exec(name.trim());
  return m ? m[1].toLowerCase() : "";
}

function mb(n: number): string {
  if (n < 1024 * 1024) return Math.round(n / 1024) + "KB";
  return (n / 1024 / 1024).toFixed(1) + "MB";
}

function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  const chunks: string[] = [];
  for (let i = 0; i < bytes.length; i += 8192)
    chunks.push(String.fromCharCode(...bytes.subarray(i, i + 8192)));
  return btoa(chunks.join(""));
}

type LoadedImage =
  { ok: true; data: string; mediaType: string } | { ok: false; why: string };

/**
 * 这间屋子能不能看这个 key。
 *
 * loadImage 本身不设防 —— 它不知道调用的是哪间屋子；划界只能由带着房间身份的
 * 调用方来做。所有「按模型给的 key 碰桶」的入口（view_image、draw 的自检递图）
 * 都必须先过这里：主人全库可见，来客只读自己那间前缀下的和公开空间。
 * 没有这一道，一句「帮我看看 f/default/xxx.png」就能把别人房里的图调到眼前。
 */
export function mayViewKey(ctx: ToolCtx, key: string): boolean {
  return canReadFile(key, ctx.guest ? "user" : "admin", ctx.room);
}

/**
 * 从云盘取一张图，做成能直接塞进 tool result 的图片块。
 *
 * 失败时给的是「为什么看不到」的人话而不是 null —— 那句话要原样落到她眼里，
 * 她照实说出来，比她自己猜一个理由强。
 */
export async function loadImage(env: Env, key: string): Promise<LoadedImage> {
  const obj = await env.MEMORY_BUCKET.get(key);
  if (!obj) return { ok: false, why: "云盘里没有这个文件：" + key };

  const mime = obj.httpMetadata?.contentType || "";
  const mediaType = OK_MIME.has(mime) ? mime : EXT_MIME[extOf(key)] || "";
  if (!mediaType) {
    return {
      ok: false,
      why: `这种格式（${mime || extOf(key) || "未知"}）我看不了原图，得先转成 png 或 jpg。`,
    };
  }
  if (obj.size > MAX_INLINE_IMAGE) {
    return {
      ok: false,
      why: `这张图有 ${mb(obj.size)}，超过能递到我眼前的上限（${mb(MAX_INLINE_IMAGE)}），原图我看不了。`,
    };
  }
  return { ok: true, data: toBase64(await obj.arrayBuffer()), mediaType };
}

type VisionResult =
  { ok: true; text: string; model: string } | { ok: false; error: string };

/**
 * 请 GLM-4V 把一张图讲成一段话。
 *
 * 只在「原图没能进消息」时用（attach.ts 兜底那一处）——
 * 能让她亲眼看的时候不要走这里：转述一定丢细节，还会白等一跳。
 */
export async function describeImage(
  env: Env,
  key: string,
): Promise<VisionResult> {
  const apiKey = env.ZHIPU_KEY;
  if (!apiKey) return { ok: false, error: "ZHIPU_KEY 未配置，无法分析图片。" };

  const obj = await env.MEMORY_BUCKET.get(key);
  if (!obj) return { ok: false, error: "文件不存在：" + key };
  const rawType = obj.httpMetadata?.contentType || "";
  if (
    !rawType.startsWith("image/") &&
    !/\.(png|jpe?g|webp|bmp|gif)$/i.test(key)
  ) {
    return {
      ok: false,
      error: `不是图片文件（${rawType || "未知类型"}），无法做视觉分析。`,
    };
  }
  // 类型要归一：云盘对象可能带着 application/octet-stream 这类非图片类型，
  // 原样拼进 data URL 会被端点判为不支持（和 loadImage 用同一套归一）
  const contentType = OK_MIME.has(rawType)
    ? rawType
    : EXT_MIME[extOf(key)] || "image/jpeg";
  // 上限说的是「原图字节数」，不是「base64 字符数」—— 拿它切字符串的话，
  // 半张图会被当成完整的送到端点，模型可能拿着残图当真描述
  if (obj.size > MAX_INLINE_IMAGE)
    return {
      ok: false,
      error: `这张图有 ${mb(obj.size)}，超过能递到我眼前的上限（${mb(MAX_INLINE_IMAGE)}），原图我看不了。`,
    };

  const b64 = toBase64(await obj.arrayBuffer()).replace(/\s/g, "");
  const dataUrl = `data:${contentType};base64,${b64}`;

  const errors: string[] = [];
  for (const model of MODELS) {
    try {
      const r = await fetch(ZHIPU_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + apiKey,
        },
        body: JSON.stringify({
          model,
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: DESCRIBE_PROMPT },
                { type: "image_url", image_url: { url: dataUrl } },
              ],
            },
          ],
          max_tokens: 1024,
          temperature: 0.1,
        }),
      });
      if (!r.ok) {
        errors.push(`${model}: HTTP ${r.status}`);
        continue;
      }
      const j = (await r.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const text = j.choices?.[0]?.message?.content;
      if (text) return { ok: true, text, model };
      errors.push(`${model}: 空响应`);
    } catch (e) {
      errors.push(`${model}: ${(e as Error).message.slice(0, 80)}`);
    }
  }
  return { ok: false, error: "所有视觉模型均不可用：\n" + errors.join("\n") };
}

export function visionTools(ctx: ToolCtx) {
  return {
    view_image: tool({
      description:
        "把云盘里的一张图调出来自己看：画过的图、存进图像记忆的图、他之前传上来的图。" +
        "图会原样递到你眼前，所以别再委托别人转述，也不要凭文件名猜内容。" +
        "要看图里的文字（截图、书页、票据）就用它，照着念，比转述准得多。",
      inputSchema: z.object({
        key: z
          .string()
          .describe("云盘里的图片文件名，形如 draw-1730000000000.png"),
      }),
      execute: async ({ key }) => {
        // key 是模型给的：先划界再碰桶。拒绝的话给一句不透露「有没有这个文件」的话
        if (!mayViewKey(ctx, key))
          return "这个 key 不在这间屋子能读的范围里，这张图看不到。";
        const img = await loadImage(ctx.env, key);
        if (!img.ok) return img.why;
        return `这就是 ${key} 的原图，自己看。`;
      },
      // 图在这里才真的递过去 —— 工具结果里的文字只是陪衬，
      // 主模型看见的是下面那个 image-data 块。
      // execute 拒过的 key 在这里也不能放行：这是另一次独立的取图，
      // 不设门的话拒绝就成了走个形式，图还是塞进去了
      toModelOutput: async ({ input, output }) => {
        if (!mayViewKey(ctx, input.key)) return { type: "text", value: output };
        const img = await loadImage(ctx.env, input.key);
        if (!img.ok) return { type: "text", value: output };
        return {
          type: "content",
          value: [
            { type: "text", text: output },
            { type: "image-data", data: img.data, mediaType: img.mediaType },
          ],
        };
      },
    }),
  };
}
