import { describe, expect, it, vi } from "vitest";
import { agentNameFor, issueToken, sessionCookie } from "../src/auth";
import worker from "../src/index";
import { attachFakeSessions } from "./fakeSessions";

vi.mock("../src/agent/cowork", () => ({ CoworkAgent: class {} }));
vi.mock("agents", () => ({
  routeAgentRequest: vi.fn(async () => null),
  getCurrentAgent: () => ({}),
}));

function environment() {
  const agent = {
    logVisitor: vi.fn(),
    cardPerm: vi.fn(async () => false),
    cardRoom: vi.fn(async () => "guest-card1"),
    listNotes: vi.fn(async () => []),
    patchConfig: vi.fn(async () => ({})),
    getConfig: vi.fn(async () => ({ tasks: [] })),
    listPosts: vi.fn(async () => []),
    listAllSessions: vi.fn(async () => [{ id: "s1" }]),
    publicLedger: vi.fn(async () => []),
    modelCatalog: vi.fn(async () => ({ providers: [], entries: [] })),
    stopGenerating: vi.fn(async () => ({})),
    resetActiveSession: vi.fn(async () => {}),
  };
  const names: string[] = [];
  attachFakeSessions(agent);
  const authAgent = attachFakeSessions({});
  const env = {
    ADMIN_PASSWORD: "admin-test",
    GATE_PASSWORD: "guest-test",
    SESSION_SECRET: "test-session-secret",
    COWORK_AGENT: {
      idFromName: (name: string) => {
        names.push(name);
        return name;
      },
      get: () => agent,
    },
    AUTH_SESSIONS: { idFromName: (name: string) => name, get: () => authAgent },
    ASSETS: { fetch: vi.fn(async () => new Response("app")) },
  } as unknown as Env;
  return { env, agent, names };
}

async function request(
  env: Env,
  path: string,
  role: "admin" | "user",
  init: RequestInit = {},
  card?: string,
) {
  const token = await issueToken(env, role, undefined, card ? "common" : undefined, card);
  return new Request(`https://app.test${path}`, {
    ...init,
    headers: { Cookie: sessionCookie(token, true).split(";")[0] },
  });
}

describe("Worker 入口路由", () => {
  it("未登录的管理 API 保持 401", async () => {
    const { env, agent } = environment();
    const response = await worker.fetch(new Request("https://app.test/api/config"), env);
    expect(response.status).toBe(401);
    expect(agent.getConfig).not.toHaveBeenCalled();
  });

  it("访客不能进入配置和模型管理路由", async () => {
    const { env, agent } = environment();
    for (const path of ["/api/config", "/api/model-configs", "/api/theme/sets"]) {
      expect((await worker.fetch(await request(env, path, "user"), env)).status).toBe(403);
    }
    expect(agent.getConfig).not.toHaveBeenCalled();
  });

  it("管理员仍通过原有接口读配置", async () => {
    const { env, agent, names } = environment();
    const response = await worker.fetch(await request(env, "/api/config", "admin"), env);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, data: { tasks: [] } });
    expect(agent.getConfig).toHaveBeenCalledOnce();
    expect(names).toContain("default");
  });

  it.each(["null", "[]", "broken", '{"a":1'])(
    "管理员写入非法 JSON 时返回 400，且不会修改数据：%s",
    async (body) => {
      const { env, agent } = environment();
      const response = await worker.fetch(
        await request(env, "/api/config", "admin", { method: "POST", body }),
        env,
      );
      expect(response.status).toBe(400);
      expect(agent.patchConfig).not.toHaveBeenCalled();
    },
  );

  it("登录请求传 null 也返回 400，不冒未捕获异常", async () => {
    const { env } = environment();
    const response = await worker.fetch(
      new Request("https://app.test/api/card/login", { method: "POST", body: "null" }),
      env,
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ ok: false });
  });

  it("破坏性接口不接受坏 body：清空当前场次的请求必须先是一个 JSON 对象", async () => {
    const { env, agent } = environment();
    for (const path of ["/api/clear", "/api/stop"]) {
      const response = await worker.fetch(
        await request(env, path, "admin", { method: "POST", body: "[]" }),
        env,
      );
      expect(response.status).toBe(400);
    }
    expect(agent.resetActiveSession).not.toHaveBeenCalled();
    expect(agent.stopGenerating).not.toHaveBeenCalled();
  });

  it("落在任何局部 try 之外的路径抛出时也收成 JSON 500", async () => {
    // /api/theme-asset 的取桶一步没有局部兜底：这里的 env 故意不给 MEMORY_BUCKET，
    // 等价于线上 R2 抖一下。没有入口兜底时 fetch 会直接把异常冒到平台层（1101 纯文本）。
    const { env } = environment();
    const response = await worker.fetch(
      new Request("https://app.test/api/theme-asset/avatar.png"),
      env,
    );
    expect(response.status).toBe(500);
    expect(response.headers.get("Content-Type")).toContain("application/json");
    expect(await response.json()).toMatchObject({ ok: false });
  });

  it("局部兜底之外抛出的错误也只回公共文案，不泄漏内部原文", async () => {
    const { env, agent } = environment();
    agent.getConfig = vi.fn(async () => {
      throw new Error("private R2 key and internal state");
    });
    const response = await worker.fetch(await request(env, "/api/config", "admin"), env);
    expect(response.status).toBe(500);
    expect(response.headers.get("Content-Type")).toContain("application/json");
    expect(await response.text()).not.toContain("private");
  });

  it("访客仍能读公开墙，撤回自身权益后不能发帖", async () => {
    const { env, agent } = environment();
    const read = await worker.fetch(await request(env, "/api/posts", "user"), env);
    expect(read.status).toBe(200);
    expect(agent.listPosts).toHaveBeenCalledOnce();
    const write = await worker.fetch(
      await request(env, "/api/posts", "user", { method: "POST", body: '{"content":"hi"}' }, "card1"),
      env,
    );
    expect(write.status).toBe(403);
  });

  it("临时访客不能通过笔记路由获取内容", async () => {
    const { env, agent } = environment();
    const response = await worker.fetch(await request(env, "/api/notes", "user"), env);
    expect(response.status).toBe(403);
    expect(agent.listNotes).not.toHaveBeenCalled();
  });

  it("管理员的模型目录请求落在目录路由", async () => {
    const { env, agent } = environment();
    const response = await worker.fetch(await request(env, "/api/model-configs", "admin"), env);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, providers: [], entries: [], keySecrets: [] });
    expect(agent.modelCatalog).toHaveBeenCalledOnce();
  });

  it("访客的会话列表落在自己的房间", async () => {
    const { env, agent, names } = environment();
    const req = await request(env, "/api/sessions", "user");
    const room = await agentNameFor(req, env, "user");
    const response = await worker.fetch(req, env);
    expect(await response.json()).toEqual({ ok: true, data: [{ id: "s1" }] });
    expect(agent.listAllSessions).toHaveBeenCalledOnce();
    expect(names).toContain(room);
    expect(names).not.toContain("default");
  });

  it("公开记忆请求落在记忆路由", async () => {
    const { env, agent } = environment();
    const response = await worker.fetch(await request(env, "/api/memory/public", "user"), env);
    expect(response.status).toBe(200);
    expect(agent.publicLedger).toHaveBeenCalledOnce();
  });

  it("具有笔记权益的持卡者仍能读自己的笔记", async () => {
    const { env, agent } = environment();
    agent.cardPerm.mockResolvedValue(true);
    const response = await worker.fetch(await request(env, "/api/notes", "user", {}, "card1"), env);
    expect(response.status).toBe(200);
    expect(agent.listNotes).toHaveBeenCalledOnce();
  });

  it("访客不能通过请求中的 room 指定管理员房间", async () => {
    const { env, agent, names } = environment();
    const req = await request(env, "/api/think", "user", {
      method: "POST",
      body: JSON.stringify({ mode: "deep", room: "default" }),
    });
    const room = await agentNameFor(req, env, "user");
    const response = await worker.fetch(req, env);
    expect(response.status).toBe(200);
    expect(agent.patchConfig).toHaveBeenCalledWith({ thinkMode: "deep" });
    expect(names).toContain(room);
    expect(names).not.toContain("default");
  });

  /**
   * 矩阵权的回归：这一档关着的时候，/api/matrix/* 的对外行为与加这档之前一字不变。
   * 关着的三种人（无卡用户、有卡但档位没发、临时票）都是 403；管理员照旧 200。
   */
  it("矩阵管理面对没这一档的来客一律 403，管理员照旧放行", async () => {
    const { env, agent } = environment();
    for (const [path, init, card] of [
      ["/api/matrix/stat", {}, undefined],
      ["/api/matrix/pages", {}, "card1"],
      ["/api/matrix/sites", {}, "card1"],
      ["/api/matrix/links", {}, "card1"],
      ["/api/matrix/save", { method: "POST", body: "{}" }, "card1"],
      ["/api/matrix/pack", { method: "POST", body: "zip" }, "card1"],
    ] as const) {
      const response = await worker.fetch(await request(env, path, "user", init, card), env);
      expect(`${path} ${response.status}`).toBe(`${path} 403`);
    }
    // 持卡的会去隔间核这一档（核的是 permMatrix，不是蹭别的权益）
    expect(agent.cardPerm).toHaveBeenCalledWith("card1", "permMatrix");
    // 没卡的不必费那一趟 RPC：票上没卡就已经是 403
    agent.cardPerm.mockClear();
    expect((await worker.fetch(await request(env, "/api/matrix/stat", "user"), env)).status).toBe(403);
    expect(agent.cardPerm).not.toHaveBeenCalled();
    expect((await worker.fetch(await request(env, "/api/matrix/stat", "admin"), env)).status).toBe(200);
  });

  it("矩阵网页的公开读那条路不经过权益闸", async () => {
    const { env } = environment();
    // 过路人和持卡来客读自建网页：认领不了就照旧回落应用，不会被 403 挡在门外
    for (const req of [
      new Request("https://app.test/m/some-page"),
      await request(env, "/m/some-page", "user", {}, "card1"),
      await request(env, "/m/some-page", "admin"),
    ]) {
      expect((await worker.fetch(req, env)).status).toBe(200);
    }
  });
});
