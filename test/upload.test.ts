import { describe, expect, it } from "vitest";
import {
  DEFAULT_PART_SIZE,
  MAX_UPLOAD_SIZE,
  assertSessionScope,
  isSessionKey,
  partBounds,
  readUploadMeta,
  safeContentType,
  safeFileName,
  sessionKey,
  shouldUseParts,
} from "../src/upload";

describe("上传元数据清洗", () => {
  it("文件名去掉路径与控制字符，保留可读短名", () => {
    expect(safeFileName("../../etc/passwd")).toBe("passwd");
    expect(safeFileName("a/b\\c.txt")).toBe("c.txt");
    expect(safeFileName("   ")).toBe("upload.bin");
    expect(safeFileName("..")).toBe("upload.bin");
    expect(safeFileName("x".repeat(300)).length).toBeLessThanOrEqual(120);
  });
  it("内容类型只认 token 形状，别把引号换行带进 R2 元数据", () => {
    expect(safeContentType("text/plain")).toBe("text/plain");
    expect(safeContentType("text/plain\r\nX-Evil: 1")).toBe("application/octet-stream");
    expect(safeContentType("")).toBe("application/octet-stream");
  });
  it("大小缺失或超限直接拒绝", () => {
    const tooBig = readUploadMeta(
      new URL(`https://x/?size=${MAX_UPLOAD_SIZE + 1}`),
      new Headers(),
    );
    expect(tooBig.error).toContain("过大");
    const missing = readUploadMeta(new URL("https://x/"), new Headers());
    expect(missing.error).toContain("缺少文件大小");
  });
  it("公开空间强制落在 public 前缀，文件夹按权限拼", () => {
    const meta = readUploadMeta(
      new URL("https://x/?size=10&public=1&folder=whatever"),
      new Headers(),
    ).meta;
    expect(meta.folder).toBe("public");
  });
});

describe("分片边界", () => {
  it("按分片大小切分，最后一片可以短", () => {
    const bounds = partBounds(20 * 1024 * 1024, 8 * 1024 * 1024);
    expect(bounds).toHaveLength(3);
    expect(bounds[0]).toEqual({ start: 0, end: 8 * 1024 * 1024 });
    expect(bounds[2].end).toBe(20 * 1024 * 1024);
  });
  it("小于一片的文件不切片，空文件无片", () => {
    expect(partBounds(1024, 8 * 1024 * 1024)).toHaveLength(1);
    expect(partBounds(0, 8 * 1024 * 1024)).toHaveLength(0);
  });
  it("小文件不该走分片：多一次往返反而更慢", () => {
    expect(shouldUseParts(5 * 1024 * 1024, DEFAULT_PART_SIZE)).toBe(false);
    expect(shouldUseParts(9 * 1024 * 1024, DEFAULT_PART_SIZE)).toBe(true);
  });
});

describe("分片会话的边界", () => {
  it("会话 key 在保留前缀下，不出现在云盘列表", () => {
    const key = sessionKey("abc");
    expect(isSessionKey(key)).toBe(true);
    expect(isSessionKey("f/default/real.pdf")).toBe(false);
  });
  it("管理员可合并任意会话，来客只能合并自己房间前缀下的", () => {
    expect(() => assertSessionScope("f/default/x", [""])).not.toThrow();
    expect(() => assertSessionScope("f/guest-1/x", ["f/guest-1/"])).not.toThrow();
    expect(() => assertSessionScope("f/guest-2/x", ["f/guest-1/"])).toThrow();
  });
});
