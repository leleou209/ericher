import { describe, expect, it, vi } from "vitest";
import {
  emptyConfig,
  loadConfig,
  type MatrixEnv,
  saveConfig,
  serveMatrixPage,
} from "../src/matrix/core";

function environment(path: string) {
  const config = {
    ...emptyConfig(),
    pages: [
      {
        id: path,
        title: path,
        path,
        access: "public",
        types: [],
        kind: "html",
        external: false,
        sandbox: false,
        entry: false,
        created: "",
        updated: "",
      },
    ],
  };
  const bucket = {
    get: vi.fn(async (key: string) =>
      key === "matrix/config.json"
        ? { text: async () => JSON.stringify(config) }
        : { text: async () => `<html><head></head><body>${path}</body></html>`, size: 100 },
    ),
    put: vi.fn(async () => {}),
  };
  return { config, bucket, env: { MEMORY_BUCKET: bucket } as unknown as MatrixEnv };
}

describe("矩阵配置缓存", () => {
  it("缺少桶绑定时读路径仍回落空配置", async () => {
    expect(await loadConfig({} as MatrixEnv)).toEqual(emptyConfig());
  });

  it("缓存按桶隔离，不把另一个环境的页面配置带过来", async () => {
    const a = environment("one");
    const b = environment("two");
    expect((await loadConfig(a.env)).pages[0].path).toBe("one");
    expect((await loadConfig(b.env)).pages[0].path).toBe("two");
    expect(a.bucket.get).toHaveBeenCalledTimes(1);
  });

  it("调用方修改未保存的配置不会污染缓存；保存失败也保持原值", async () => {
    const h = environment("old");
    const config = await loadConfig(h.env);
    config.pages[0].title = "new";
    expect((await loadConfig(h.env)).pages[0].title).toBe("old");
    h.bucket.put.mockRejectedValue(new Error("R2 failed"));
    await expect(saveConfig(h.env, config)).rejects.toThrow("R2 failed");
    expect((await loadConfig(h.env)).pages[0].title).toBe("old");
  });

  it("保存成功更新缓存，调用方后续修改也不影响已保存版本", async () => {
    const h = environment("old");
    const config = await loadConfig(h.env);
    config.pages[0].title = "saved";
    await saveConfig(h.env, config);
    config.pages[0].title = "unsaved";
    expect((await loadConfig(h.env)).pages[0].title).toBe("saved");
  });

  it("公开页仍能渲染，并对入口页执行跳转", async () => {
    const h = environment("one");
    h.config.pages[0].entry = true;
    const root = await serveMatrixPage(
      new Request("https://app.test/"),
      h.env,
      { role: "public" },
      "/",
    );
    expect(root?.status).toBe(302);
    expect(root?.headers.get("Location")).toBe("/one");
    const page = await serveMatrixPage(
      new Request("https://app.test/one"),
      h.env,
      { role: "public" },
      "/one",
    );
    expect(page?.status).toBe(200);
    expect(await page?.text()).toContain("one");
  });
});
