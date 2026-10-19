import { describe, expect, it, vi } from "vitest";
import { fail, HttpError, readJsonObject } from "../src/shared/httpInput";

function post(body: string) {
  return new Request("https://app.test/api/config", { method: "POST", body });
}

describe("HTTP 输入闸门", () => {
  it.each(["null", "[]", '[{"a":1}]', '"text"', "true", "1", "{bad", ""])(
    "写接口拒绝非对象 body 并回 400：%s",
    async (body) => {
      try {
        await readJsonObject(post(body));
        throw new Error("应拒绝请求");
      } catch (error) {
        expect(error).toBeInstanceOf(HttpError);
        const response = fail(error);
        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({ ok: false });
      }
    },
  );

  it("保留对象字段，业务校验归各路由", async () => {
    const req = post(JSON.stringify({ patch: { tasks: [] } }));
    expect(await readJsonObject(req)).toEqual({ patch: { tasks: [] } });
  });

  it("空对象仍是一个合法请求（老客户端点名房间用的就是它）", async () => {
    expect(await readJsonObject(post("{}"))).toEqual({});
  });

  it("未知内部错误记录日志，只向客户端返回公共文案", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const error = new Error("private R2 key and implementation details");
      const response = fail(error);
      expect(response.status).toBe(500);
      expect(await response.text()).not.toContain("private");
      expect(log).toHaveBeenCalledWith(error);
    } finally {
      log.mockRestore();
    }
  });

  it("DO 免费层配额报错翻成人话，不把英文原文糊到面板上", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = fail(new Error("Too many rows written in Durable Objects free tier"));
      expect(response.status).toBe(500);
      const text = JSON.stringify(await response.json());
      expect(text).toContain("记忆额度用完了");
      expect(text).not.toContain("free tier");
    } finally {
      log.mockRestore();
    }
  });
});
