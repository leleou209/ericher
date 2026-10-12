// 主题包（.zip）的解包与封包。纯函数，不碰 R2 / DO —— 装备、导出、单测都走这里。
//
// 包体格式（zip）：
//   theme.json          清单：{ format: "ericher-theme", version: 1, theme: {...} }
//   assets/<文件名>      素材本体（图片/动图），theme 里用 `asset:<文件名>` 引用
//
// 解包收口：只认 assets/ 一层下的文件名（不许 ..、不许绝对路径、不许目录穿越），
// 每个素材和总量都封顶；theme.json 里的 asset: 引用若指向包里没有的素材，
// 当场报人话错误 —— 免得装一半满屏破图。清单本身过 normalizeTheme 收口。

import { unzipSync, zipSync, strFromU8, strToU8 } from "fflate";
import {
  normalizeTheme,
  referencedAssets,
  type ThemeConfig,
} from "./themeConfig";

const PACK_FORMAT = "ericher-theme";
const PACK_VERSION = 1;

/** 素材限额：个数 / 单个 / 总量。和 /api/upload 的 50MB 单文件上限对齐 */
export const MAX_PACK_FILES = 200;
export const MAX_PACK_FILE_BYTES = 50 * 1024 * 1024;
export const MAX_PACK_TOTAL_BYTES = 200 * 1024 * 1024;
/** 清单的单条上限：theme.json 是一份 JSON 文档，256KB 装得下任何正经主题 */
export const MAX_PACK_MANIFEST_BYTES = 256 * 1024;
/** 包内条目总数上限：正经的包只有 theme.json + 最多 200 个素材，留些余量 */
export const MAX_PACK_ENTRIES = 1000;

const ASSETS_DIR = "assets/";

export interface UnpackedThemePack {
  theme: ThemeConfig;
  /** 素材文件名 -> 字节 */
  assets: Map<string, Uint8Array>;
}

function packError(msg: string): Error {
  return new Error(`主题包不对：${msg}`);
}

/**
 * 素材文件名收口：只要文件名本身，不许路径穿越。
 * 解包、封包、上传素材三条路共用这一把尺，直接抛人话错误。
 */
export function safeAssetName(name: string): string {
  const base = name.split(/[/\\]/).pop() ?? "";
  if (!base || base === "." || base === ".." || base.includes(".."))
    throw new Error(`素材文件名不对：${name}`);
  return base;
}

interface RawPack {
  format?: unknown;
  version?: unknown;
  theme?: unknown;
}

/** zip 字节 -> 主题 + 素材。任何不合规当场抛人话错误 */
export function unpackThemePack(bytes: Uint8Array): UnpackedThemePack {
  let entries: Record<string, Uint8Array>;
  // unzipSync 是先全量解压进内存的：高压缩比的包（几十 KB 的 zip 解出几个 GB）
  // 等解完再查大小就晚了。好在 filter 回调拿得到 zip 目录里声明的原始大小，
  // 解压前就按声明值拦一道；声明值可能谎报（写小实际大），所以下面素材那步
  // 仍按解出来的实际字节再兜一道底。
  let over: string | null = null;
  let count = 0;
  let declaredTotal = 0;
  try {
    entries = unzipSync(bytes, {
      filter: (file) => {
        // 条目数先拦：几百万个空条目的包能把解包活活拖死
        count += 1;
        if (count > MAX_PACK_ENTRIES) {
          over ??= `包里条目数超过上限（${MAX_PACK_ENTRIES} 个），包不老实`;
          return false;
        }
        // theme.json 与其余条目各管各的单条上限：清单是文本，给小些
        const isManifest =
          file.name === "theme.json" || file.name.endsWith("/theme.json");
        const single = isManifest ? MAX_PACK_MANIFEST_BYTES : MAX_PACK_FILE_BYTES;
        if (file.originalSize > single) {
          over ??= isManifest
            ? `theme.json 清单超过单条上限（${MAX_PACK_MANIFEST_BYTES >> 10}KB），包不老实`
            : `条目 ${file.name} 超过单文件上限（${MAX_PACK_FILE_BYTES >> 20}MB），包不老实`;
          return false;
        }
        declaredTotal += file.originalSize;
        if (declaredTotal > MAX_PACK_TOTAL_BYTES) {
          over ??= `条目解出来超过总量上限（${MAX_PACK_TOTAL_BYTES >> 20}MB），包不老实`;
          return false;
        }
        return true;
      },
    });
  } catch {
    throw packError("这不是一个能解开的 zip 压缩包");
  }
  // 拦下的条目不让它解出来，理由在这里补抛 —— filter 只能回 true/false
  if (over) throw packError(over);
  const manifestKey = Object.keys(entries).find(
    (k) => k === "theme.json" || k.endsWith("/theme.json"),
  );
  if (!manifestKey) throw packError("包里没有 theme.json 清单");
  let raw: RawPack;
  try {
    raw = JSON.parse(strFromU8(entries[manifestKey])) as RawPack;
  } catch {
    throw packError("theme.json 不是合法的 JSON");
  }
  if (raw.format !== PACK_FORMAT)
    throw packError(`不是主题包（format 要是 ${PACK_FORMAT}）`);
  const version = Number(raw.version);
  if (!Number.isFinite(version) || version > PACK_VERSION)
    throw packError(`版本太新（本机只认 v${PACK_VERSION} 及以下）`);

  // 素材：只收 assets/ 一层，文件名安全检查 + 大小封顶
  const assets = new Map<string, Uint8Array>();
  let total = 0;
  for (const [path, data] of Object.entries(entries)) {
    if (!path.startsWith(ASSETS_DIR)) continue;
    const name = safeAssetName(path.slice(ASSETS_DIR.length));
    if (!name) continue;
    if (data.byteLength > MAX_PACK_FILE_BYTES)
      throw packError(`素材 ${name} 超过单文件上限（${MAX_PACK_FILE_BYTES >> 20}MB）`);
    total += data.byteLength;
    if (total > MAX_PACK_TOTAL_BYTES)
      throw packError(`素材总量超过上限（${MAX_PACK_TOTAL_BYTES >> 20}MB）`);
    if (assets.size >= MAX_PACK_FILES)
      throw packError(`素材个数超过上限（${MAX_PACK_FILES} 个）`);
    assets.set(name, data);
  }

  const theme = normalizeTheme(raw.theme);
  for (const name of referencedAssets(theme)) {
    if (!assets.has(name)) throw packError(`清单引用了包里没有的素材：${name}`);
  }
  return { theme, assets };
}

/**
 * 主题 + 素材 -> zip 字节（导出用）。清单里的 `asset:<文件名>` 引用按名字
 * 对上 assets/ 里的文件；引用了但没给字节的素材直接抛 —— 导出一个装上就破图
 * 的包没有意义。
 */
export function packThemePack(
  theme: ThemeConfig,
  assets: Map<string, Uint8Array>,
): Uint8Array {
  const normalized = normalizeTheme(theme);
  const files: Record<string, Uint8Array> = {};
  for (const name of referencedAssets(normalized)) {
    const data = assets.get(name);
    if (!data) throw packError(`素材 ${name} 没有本体，导出的包装上会破图`);
    files[`${ASSETS_DIR}${safeAssetName(name)}`] = data;
  }
  const manifest: RawPack = {
    format: PACK_FORMAT,
    version: PACK_VERSION,
    theme: normalized,
  };
  files["theme.json"] = strToU8(JSON.stringify(manifest, null, 2));
  // level 0：素材多半是图片/动图，本身已压缩，再压纯烧 CPU
  return zipSync(files, { level: 0 });
}
