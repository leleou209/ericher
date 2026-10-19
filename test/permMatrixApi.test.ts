/**
 * 矩阵模块自己的那道闸（handleMatrixApi 的第二道）。
 *
 * 主包放过来的只有「管理员」和「核过这一档的持卡来客」两种身份，矩阵模块不认人 ——
 * 它只看主包传进来的那份 viewer。这里直接喂 viewer，验的是放行面收不收得紧：
 * matrix 位只能和 user 身份一起认，过路人身上谁把它点亮都不算。
 *
 * 运行: npx vitest run test/permMatrixApi.test.ts
 */

import { describe, expect, it } from "vitest";
import { handleMatrixApi, type MatrixEnv } from "../src/matrix/core";

/** 不给桶：loadConfig 走「读不到就按空处理」那条路，够用 */
const env = {} as MatrixEnv;

const call = (viewer: Parameters<typeof handleMatrixApi>[3], path = "/api/matrix/stat") =>
  handleMatrixApi(new Request(`https://app.test${path}`), env, path, viewer);

describe("矩阵管理面的第二道闸", () => {
  it("管理员：放行", async () => {
    expect((await call({ role: "admin" })).status).toBe(200);
  });

  it("持卡来客且主包核过这一档（user + matrix）：放行", async () => {
    const response = await call({ role: "user", type: "common", card: "c1", matrix: true });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true });
  });

  it("持卡来客但没核过这一档：403", async () => {
    expect((await call({ role: "user", type: "common", card: "c1" })).status).toBe(403);
    expect((await call({ role: "user", matrix: false })).status).toBe(403);
  });

  it("过路人即便被点了 matrix 位也不放行：这一档只跟登录身份走", async () => {
    expect((await call({ role: "public", matrix: true })).status).toBe(403);
    expect((await call({ role: "public" })).status).toBe(403);
  });

  it("403 的回执是 ok:false —— 前端的提交口径按这个算失败", async () => {
    const response = await call({ role: "user" });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ ok: false });
  });
});
