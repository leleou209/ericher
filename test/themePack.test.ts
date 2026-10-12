/**
 * 主题包（.zip）解包/封包测试。
 *
 * 包体就两样东西：theme.json 清单 + assets/ 一层素材。这里验：
 * - packThemePack + unpackThemePack 往返：主题和素材字节原样转一圈；
 * - 解包收口：不是 zip、没有清单、清单坏了、format/版本不对、
 *   引用了包里没有的素材，全都当场抛人话错误（免得装一半满屏破图）；
 * - 安全：assets/ 下的路径穿越条目过不了 safeAssetName；素材个数封顶；
 *   解压前就按 zip 目录声明的原始大小拦（unzipSync 是先全量解压进内存的，
 *   高压缩比包等解完再查就晚了）—— 清单单条 256KB、其余条目单条/总量/条目数封顶；
 * - 封包：引用了但没给字节的素材直接抛 —— 导出一个装上就破图的包没有意义。
 *
 * 单文件 50MB / 总量 200MB 的上限数据太大不硬造，用常量断言钉住口径。
 *
 * 运行: npx vitest run test/themePack.test.ts
 */

import { describe, it, expect } from "vitest";
import { strToU8, zipSync } from "fflate";
import {
  MAX_PACK_ENTRIES,
  MAX_PACK_FILES,
  MAX_PACK_FILE_BYTES,
  MAX_PACK_MANIFEST_BYTES,
  MAX_PACK_TOTAL_BYTES,
  packThemePack,
  safeAssetName,
  unpackThemePack,
} from "../src/agent/themePack";
import { normalizeTheme } from "../src/agent/themeConfig";

const MANIFEST_FORMAT = "ericher-theme";

/** 造一个包：清单 + 可选素材（键是纯文件名，自动放进 assets/） */
function makePack(
  manifest: unknown,
  assets: Record<string, Uint8Array> = {},
  extra: Record<string, Uint8Array> = {},
): Uint8Array {
  const files: Record<string, Uint8Array> = {
    "theme.json": strToU8(JSON.stringify(manifest)),
    ...Object.fromEntries(
      Object.entries(assets).map(([name, data]) => [`assets/${name}`, data]),
    ),
    ...extra,
  };
  return zipSync(files, { level: 0 });
}

const goodManifest = (theme: unknown = {}, over: Record<string, unknown> = {}) => ({
  format: MANIFEST_FORMAT,
  version: 1,
  theme,
  ...over,
});

describe("safeAssetName（素材文件名收口）", () => {
  it("只认最后一段文件名：路径前缀都被剥掉", () => {
    expect(safeAssetName("bg.png")).toBe("bg.png");
    expect(safeAssetName("a/b/c.png")).toBe("c.png");
    // 穿越前缀剥掉后只剩纯文件名 —— 引用落不到包外
    expect(safeAssetName("../evil.png")).toBe("evil.png");
    expect(safeAssetName("..\\..\\evil.png")).toBe("evil.png");
    expect(safeAssetName("C:\\evil\\x.png")).toBe("x.png");
  });

  it("空名、`.`、`..`、带 `..` 的名字当场抛人话错误", () => {
    for (const bad of ["", "..", ".", "a..b.png", "...."]) {
      expect(() => safeAssetName(bad), bad).toThrow(/素材文件名不对/);
    }
  });
});

describe("packThemePack + unpackThemePack 往返", () => {
  it("主题和素材字节原样转一圈", () => {
    const theme = normalizeTheme({
      base: "dark",
      agentName: "小艾",
      agentAvatar: "asset:face.png",
      backgrounds: { global: { src: "asset:bg.png", dim: 0.3, blur: 6 } },
      iconOverrides: { home: "asset:icon.png" },
      popups: [{ id: "p1", title: "公告", image: "asset:pop.png", trigger: "daily" }],
    });
    const assets = new Map<string, Uint8Array>([
      ["bg.png", strToU8("背景字节")],
      ["face.png", strToU8("头像字节")],
      ["icon.png", strToU8("图标字节")],
      ["pop.png", strToU8("弹页字节")],
    ]);

    const back = unpackThemePack(packThemePack(theme, assets));
    expect(back.theme).toEqual(theme);
    for (const [name, data] of assets) expect(back.assets.get(name)).toEqual(data);
  });

  it("没被引用的素材不进包（导出只带主题用得上的）", () => {
    const theme = normalizeTheme({ agentAvatar: "asset:face.png" });
    const assets = new Map<string, Uint8Array>([
      ["face.png", strToU8("头像字节")],
      ["spare.png", strToU8("多余的")],
    ]);
    const back = unpackThemePack(packThemePack(theme, assets));
    expect([...back.assets.keys()]).toEqual(["face.png"]);
  });
});

describe("unpackThemePack 错误路径", () => {
  it("不是 zip：解开失败说人话", () => {
    expect(() => unpackThemePack(strToU8("这不是压缩包"))).toThrow(
      /不是一个能解开的 zip/,
    );
  });

  it("包里没有 theme.json 清单", () => {
    const pack = zipSync({ "readme.txt": strToU8("你好") }, { level: 0 });
    expect(() => unpackThemePack(pack)).toThrow(/没有 theme\.json 清单/);
  });

  it("theme.json 不是合法 JSON", () => {
    const pack = zipSync({ "theme.json": strToU8("{这不是 JSON") }, { level: 0 });
    expect(() => unpackThemePack(pack)).toThrow(/不是合法的 JSON/);
  });

  it("format 不对：这不是主题包", () => {
    const pack = makePack({ format: "ericher-meme", version: 1, theme: {} });
    expect(() => unpackThemePack(pack)).toThrow(/不是主题包/);
  });

  it("版本太新拒收：本机只认 v1 及以下", () => {
    const pack = makePack(goodManifest({}, { version: 2 }));
    expect(() => unpackThemePack(pack)).toThrow(/版本太新/);
    // v1 及以下照收
    expect(() => unpackThemePack(makePack(goodManifest({}, { version: 1 })))).not.toThrow();
  });

  it("清单引用了包里没有的素材：装一半破图不如不装", () => {
    const pack = makePack(
      goodManifest({ backgrounds: { global: { src: "asset:gone.png" } } }),
    );
    expect(() => unpackThemePack(pack)).toThrow(/引用了包里没有的素材：gone\.png/);
  });

  it("「assets/../evil.png」这类条目被收口成纯文件名，落不到包外", () => {
    const pack = makePack(goodManifest(), {}, {
      "assets/../evil.png": strToU8("抢跑的"),
    });
    const back = unpackThemePack(pack);
    expect([...back.assets.keys()]).toEqual(["evil.png"]);
  });

  it("「assets/..」这种光秃秃的穿越名当场抛错", () => {
    const pack = makePack(goodManifest(), {}, { "assets/..": strToU8("穿越") });
    expect(() => unpackThemePack(pack)).toThrow(/素材文件名不对/);
  });

  it("素材个数超过上限拒收", () => {
    const assets: Record<string, Uint8Array> = {};
    for (let i = 0; i <= MAX_PACK_FILES; i++) assets[`f${i}.bin`] = strToU8("x");
    const pack = makePack(goodManifest(), assets);
    expect(() => unpackThemePack(pack)).toThrow(/素材个数超过上限/);
  });

  it("单文件/总量上限的口径钉住（超限数据太大不硬造）", () => {
    // 和 /api/upload 的 50MB 单文件上限对齐，总量 200MB、个数 200
    expect(MAX_PACK_FILE_BYTES).toBe(50 * 1024 * 1024);
    expect(MAX_PACK_TOTAL_BYTES).toBe(200 * 1024 * 1024);
    expect(MAX_PACK_FILES).toBe(200);
    expect(MAX_PACK_MANIFEST_BYTES).toBe(256 * 1024);
    expect(MAX_PACK_ENTRIES).toBe(1000);
  });

  it("theme.json 清单超过单条上限：解压前按声明大小拦，包不老实", () => {
    // 300KB 的正文不管压不压缩，zip 目录里声明的原始大小都不变 ——
    // 靠的就是解压前能拿到声明值，压缩比再高也藏不住
    const pack = makePack(goodManifest({}, { junk: "x".repeat(300 * 1024) }));
    expect(() => unpackThemePack(pack)).toThrow(/清单超过单条上限/);
  });

  it("非素材条目也受单文件上限约束：高压缩比炸弹解不出来", () => {
    // 51MB 的 "0" 用 deflate 压成几十 KB —— 没有解压前拦截的话，
    // unzipSync 会先把它全量解进内存再谈检查
    const bomb = new Uint8Array(51 * 1024 * 1024).fill(0x30);
    const pack = zipSync(
      {
        "theme.json": strToU8(JSON.stringify(goodManifest())),
        "bomb.bin": bomb,
      },
      { level: 1 },
    );
    expect(() => unpackThemePack(pack)).toThrow(/超过单文件上限/);
  });

  it("条目数超过上限拒收：几百万个空条目的包别想拖死解包", () => {
    const junk: Record<string, Uint8Array> = {};
    for (let i = 0; i < MAX_PACK_ENTRIES; i++) junk[`junk/${i}.txt`] = strToU8("x");
    const pack = makePack(goodManifest(), {}, junk);
    expect(() => unpackThemePack(pack)).toThrow(/条目数超过上限/);
  });
});

describe("packThemePack 导出", () => {
  it("引用了但没给字节的素材抛错：导出一个装上就破图的包没有意义", () => {
    const theme = normalizeTheme({ agentAvatar: "asset:gone.png" });
    expect(() => packThemePack(theme, new Map())).toThrow(
      /没有本体，导出的包装上会破图/,
    );
    // 少给一个也不行
    const partial = normalizeTheme({
      agentAvatar: "asset:face.png",
      backgrounds: { global: { src: "asset:bg.png" } },
    });
    expect(() =>
      packThemePack(partial, new Map([["face.png", strToU8("头像")]])),
    ).toThrow(/没有本体，导出的包装上会破图/);
  });
});
