/**
 * 档位发了「权限矩阵」这一档长期权益之后，/api/matrix/* 门前四种人的行为。
 *
 * 判定口径与 permNotes / permFiles / permPublic 完全同族（同一张 cardAllows →
 * 隔着 DO 的 cardPerm）：票上必须有卡，且这一档的 permMatrix 为真，两者缺一不可。
 * 这里跑的是真入口 + 真矩阵模块，所以「REST 进得去、RPC 被拒」那种半开状态
 * 藏不住 —— 写下去的东西要能在同一张闸后面读回来。
 *
 * 运行: npx vitest run test/permMatrixGate.test.ts
 */

import { describe, expect, it, vi } from "vitest";
import { issueToken, sessionCookie } from "../src/auth";
import worker from "../src/index";

vi.mock("../src/agent/cowork", () => ({ CoworkAgent: class {} }));
vi.mock("agents", () => ({
  routeAgentRequest: vi.fn(async () => null),
  getCurrentAgent: () => ({}),
}));

/** 假桶：矩阵的配置只用到 get / put */
function fakeBucket() {
  const store = new Map<string, string>();
  return {
    get: async (key: string) => {
      const v = store.get(key);
      return v === undefined
        ? null
        : { text: async () => v, json: async () => JSON.parse(v) };
    },
    put: async (key: string, value: string) => {
      store.set(key, typeof value === "string" ? value : String(value));
    },
  } as unknown as R2Bucket;
}

/**
 * @param allowed 这一档开着的长期权益（cardPerm 照这份回答，别的都算没有）
 */
function environment(allowed: string[] = []) {
  const agent = {
    cardPerm: vi.fn(async (_card: string, perm: string) =>
      allowed.includes(perm),
    ),
    updateGuestType: vi.fn(async (id: string, patch: Record<string, unknown>) => ({
      id,
      ...patch,
    })),
  };
  const env = {
    ADMIN_PASSWORD: "admin-test",
    GATE_PASSWORD: "guest-test",
    SESSION_SECRET: "test-session-secret",
    MEMORY_BUCKET: fakeBucket(),
    COWORK_AGENT: { idFromName: (name: string) => name, get: () => agent },
    ASSETS: { fetch: vi.fn(async () => new Response("app")) },
  } as unknown as Env;
  return { env, agent };
}

async function request(
  env: Env,
  path: string,
  role: "admin" | "user",
  init: RequestInit = {},
  card?: string,
) {
  const token = await issueToken(
    env,
    role,
    undefined,
    card ? "common" : undefined,
    card,
  );
  return new Request(`https://app.test${path}`, {
    ...init,
    headers: { Cookie: sessionCookie(token, true).split(";")[0] },
  });
}

describe("矩阵闸：四种人", () => {
  it("有卡且这一档发了矩阵权：读与写都放行，写的东西读得回来", async () => {
    const { env, agent } = environment(["permMatrix"]);
    const read = await worker.fetch(
      await request(env, "/api/matrix/stat", "user", {}, "card1"),
      env,
    );
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({ ok: true });
    // 核的是这一档，不是蹭别的权益
    expect(agent.cardPerm).toHaveBeenCalledWith("card1", "permMatrix");

    const write = await worker.fetch(
      await request(
        env,
        "/api/matrix/nav",
        "user",
        { method: "POST", body: JSON.stringify({ on: false }) },
        "card1",
      ),
      env,
    );
    expect(write.status).toBe(200);
    const back = await worker.fetch(
      await request(env, "/api/matrix/nav", "user", {}, "card1"),
      env,
    );
    expect(await back.json()).toMatchObject({ ok: true, data: { nav: { on: false } } });
  });

  it("有卡但这一档只开了别的权益：矩阵还是 403", async () => {
    const { env, agent } = environment(["permNotes", "permFiles", "permPublic"]);
    for (const path of ["/api/matrix/stat", "/api/matrix/pages", "/api/matrix/sites"]) {
      const response = await worker.fetch(
        await request(env, path, "user", {}, "card1"),
        env,
      );
      expect(`${path} ${response.status}`).toBe(`${path} 403`);
    }
    expect(agent.cardPerm).toHaveBeenCalledWith("card1", "permMatrix");
  });

  it("临时票（无卡）：档位全开也进不去 —— 这一档只跟持久身份走", async () => {
    const { env, agent } = environment(["permMatrix", "permNotes"]);
    for (const path of ["/api/matrix/stat", "/api/matrix/pages"]) {
      const response = await worker.fetch(await request(env, path, "user"), env);
      expect(`${path} ${response.status}`).toBe(`${path} 403`);
    }
    // 票上没卡，连那一趟隔间查询都不必发
    expect(agent.cardPerm).not.toHaveBeenCalled();
  });

  it("隔间查询失败（主人房没醒）：按没有算，不放行", async () => {
    const { env, agent } = environment(["permMatrix"]);
    agent.cardPerm.mockRejectedValue(new Error("DO 抖了一下"));
    const response = await worker.fetch(
      await request(env, "/api/matrix/stat", "user", {}, "card1"),
      env,
    );
    expect(response.status).toBe(403);
  });

  it("管理员照旧：不需要卡，也不去核这一档", async () => {
    const { env, agent } = environment([]);
    const response = await worker.fetch(
      await request(env, "/api/matrix/stat", "admin"),
      env,
    );
    expect(response.status).toBe(200);
    expect(agent.cardPerm).not.toHaveBeenCalled();
  });
});

describe("矩阵权的提交口径（PATCH 白名单）", () => {
  it("只有真布尔才转给名册；字符串与缺省都不算开", async () => {
    const { env, agent } = environment();
    const patch = async (body: unknown) =>
      worker.fetch(
        await request(env, "/api/guest-types", "admin", {
          method: "PATCH",
          body: typeof body === "string" ? body : JSON.stringify(body),
        }),
        env,
      );

    await patch({ id: "t1", permMatrix: "true" });
    expect(agent.updateGuestType.mock.calls[0][1].permMatrix).toBeUndefined();
    await patch({ id: "t1", permMatrix: 1 });
    expect(agent.updateGuestType.mock.calls[1][1].permMatrix).toBeUndefined();
    await patch({ id: "t1", name: "只改名字" });
    expect(agent.updateGuestType.mock.calls[2][1].permMatrix).toBeUndefined();

    await patch({ id: "t1", permMatrix: false });
    expect(agent.updateGuestType.mock.calls[3][1].permMatrix).toBe(false);
    await patch({ id: "t1", permMatrix: true });
    expect(agent.updateGuestType.mock.calls[4][1].permMatrix).toBe(true);
  });

  it("坏 body 一律 400，且名册一次都不碰", async () => {
    const { env, agent } = environment();
    for (const body of ["null", "[]", "broken", '{"a":1']) {
      const response = await worker.fetch(
        await request(env, "/api/guest-types", "admin", { method: "PATCH", body }),
        env,
      );
      expect(response.status).toBe(400);
    }
    expect(agent.updateGuestType).not.toHaveBeenCalled();
  });
});
