import { type Attachment } from "./types";

/** 待发的一份附件：已经传到云盘、也已经读好了，只等跟着这条消息一起发出去。
 *  file：能内联的那张图，留着原件，发消息时读成 data URL 随行（模型亲眼看原图）。 */
export type Attached = Attachment & { key: string; file?: File };

/** 一次最多带这么多份 —— 再多也不是读不完，是他自己都记不清带了什么 */
export const MAX_ATTACH = 5;

/**
 * 哪些图可以原图直进消息：主流模型端点都认这四种，别的一律走转述兜底。
 * 体积卡在 3.5MB：端点单图上限 5MB 是按 base64 算的，原图先膨胀 1/3，留出余量。
 */
export const INLINE_IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);
export const INLINE_IMAGE_MAX = 3_500_000;
export const canInlineImage = (f: File): boolean =>
  (INLINE_IMAGE_TYPES.has(f.type) || /\.(png|jpe?g|webp|gif)$/i.test(f.name)) &&
  f.size <= INLINE_IMAGE_MAX;

/** 文件读成 data URL。SDK 的 file part 认这个格式，转出来就是模型能吃的图片块 */
export const readAsDataURL = (f: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error ?? new Error("读不出来"));
    r.readAsDataURL(f);
  });