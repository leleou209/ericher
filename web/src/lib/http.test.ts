import { describe, expect, it, vi } from "vitest";
import { ApiError, createHttpClient } from "./http";

function clientWith(response: Response) {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response);
  const client = createHttpClient(fetcher);
  const expired = vi.fn();
  client.setUnauthorizedHandler(expired);
  return { ...client, fetcher, expired };
}

describe("公共 HTTP 客户端", () => {
  it("解包成功数据，同时保留未包装的旧接口", async () => {
    const wrapped = clientWith(Response.json({ ok: true, data: { id: "s1" } }));
    expect(await wrapped.request("/api/sessions")).toEqual({ id: "s1" });
    const legacy = clientWith(Response.json({ ok: true, role: "admin" }));
    expect(await legacy.request("/api/me")).toEqual({ ok: true, role: "admin" });
  });

  it("200 中的业务失败在解包前抛出，包括带 data 的失败", async () => {
    const client = clientWith(Response.json({ ok: false, error: "保存失败", data: null }));
    await expect(client.request("/api/config")).rejects.toMatchObject({
      name: "ApiError", message: "保存失败", status: 200,
    });
  });

  it.each(["<html>网关错误</html>", "", "{oops"])("成功状态却没有合法 JSON：%s", async (body) => {
    const client = clientWith(new Response(body));
    await expect(client.request("/api/config")).rejects.toThrow("服务器响应格式错误");
  });

  it("失败响应中非字符串的 error 不会作为异常文案泄漏", async () => {
    const client = clientWith(Response.json({ error: { detail: "internal" } }, { status: 502 }));
    await expect(client.request("/api/config")).rejects.toMatchObject({ message: "502 请求失败", status: 502 });
  });

  it("401 触发登录失效处理并保留服务端说明", async () => {
    const client = clientWith(Response.json({ error: "票已过期" }, { status: 401 }));
    await expect(client.request("/api/me")).rejects.toThrow("票已过期");
    expect(client.expired).toHaveBeenCalledOnce();
  });

  it.each(["/api/auth", "/api/auth?next=chat", "/api/card/login"])("登录失败不触发过期处理：%s", async (path) => {
    const client = clientWith(Response.json({ error: "口令错误" }, { status: 401 }));
    await expect(client.request(path)).rejects.toThrow("口令错误");
    expect(client.expired).not.toHaveBeenCalled();
  });

  it("二进制下载也执行过期处理", async () => {
    const client = clientWith(new Response("<html>login</html>", { status: 401 }));
    await expect(client.response("/api/theme/pack")).rejects.toBeInstanceOf(ApiError);
    expect(client.expired).toHaveBeenCalledOnce();
  });

  it("音频错误响应使用 why 字段", async () => {
    const client = clientWith(Response.json({ why: "读音服务未配置" }, { status: 503 }));
    await expect(client.response("/api/tts")).rejects.toThrow("读音服务未配置");
  });

  it("下载成功保留原始字节和响应头", async () => {
    const client = clientWith(new Response(new Uint8Array([0, 1, 255]), { headers: { "X-Pack": "ok" } }));
    const response = await client.response("/api/theme/pack");
    expect(response.headers.get("X-Pack")).toBe("ok");
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([0, 1, 255]);
  });

  it("透传 AbortSignal，不将取消请求变成业务错误", async () => {
    const controller = new AbortController();
    const abort = new DOMException("取消", "AbortError");
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(abort);
    const client = createHttpClient(fetcher);
    await expect(client.request("/api/config", { signal: controller.signal })).rejects.toBe(abort);
    expect(fetcher).toHaveBeenCalledWith("/api/config", { signal: controller.signal });
  });
});
