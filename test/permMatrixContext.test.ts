/**
 * 矩阵管理面收到的身份：从会话派生，不是写死的 admin。
 *
 * 这一档给出去的是整面网页，但「拿谁的身份记账」是另一件事：
 * 持卡来客进去了仍然是 user + 他的卡，只是多带一个主包核过的 matrix 位。
 * 今天那条 `{ role: "admin" }` 的写死口径如果留着，来客一进来就是以管理员名义操作。
 * 所以这里把矩阵模块换成回声桩，直接看主包传给它的那份 viewer。
 *
 * 运行: npx vitest run test/permMatrixContext.test.ts
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { issueToken, sessionCookie } from "../src/auth";
import worker from "../src/index";

// 回声桩要把收到的身份交回测试看，而 vi.mock 的工厂在 import 之前就要能取到这两个数组
const store = vi.hoisted(() => ({
  seen: [] as Array<{ pathname: string; viewer: Record<string, unknown> }>,
  pageViewers: [] as Array<Record<string, unknown>>,
}));

vi.mock("../src/agent/cowork", () => ({ CoworkAgent: class {} }));
vi.mock("agents", () => ({
  routeAgentRequest: vi.fn(async () => null),
  getCurrentAgent: () => ({}),
}));
vi.mock("../src/matrix/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/matrix/core")>();
  return {
    ...actual,
    handleMatrixApi: vi.fn(async (_req: Request, _env: unknown, pathname: string, viewer: Record<string, unknown>) => {
      store.seen.push({ pathname, viewer });
      return Response.json({ ok: true, data: { viewer } });
    }),
    serveMatrixPage: vi.fn(async (_req: Request, _env: unknown, viewer: Record<string, unknown>) => {
      store.pageViewers.push(viewer);
      return null;
    }),
  };
});

beforeEach(() => {
  store.seen.length = 0;
  store.pageViewers.length = 0;
});

function environment(pushToken = "") {
  const agent = {
    cardPerm: vi.fn(async (_card: string, perm: string) => perm === "permMatrix"),
  };
  const env = {
    ADMIN_PASSWORD: "admin-test",
    GATE_PASSWORD: "guest-test",
    SESSION_SECRET: "test-session-secret",
    MATRIX_PUSH_TOKEN: pushToken,
    MEMORY_BUCKET: {},
    COWORK_AGENT: { idFromName: (name: string) => name, get: () => agent },
    ASSETS: { fetch: vi.fn(async () => new Response("app")) },
  } as unknown as Env;
  return { env, agent };
}

async function request(
  env: Env,
  path: string,
  role: "admin" | "user",
  card?: string,
  init: RequestInit = {},
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

describe("传给矩阵模块的身份", () => {
  it("持卡来客：role 仍是 user、带着他自己的卡，只多一个核过的 matrix 位", async () => {
    const { env } = environment();
    const response = await worker.fetch(
      await request(env, "/api/matrix/pages", "user", "card1"),
      env,
    );
    expect(response.status).toBe(200);
    expect(store.seen.at(-1)).toMatchObject({
      pathname: "/api/matrix/pages",
      viewer: { role: "user", card: "card1", type: "common", matrix: true },
    });
    // 写死 admin 那条路一旦回来，上面这条就红了 —— 这一条是本功能的防权限提升底线
    expect(store.seen.at(-1)!.viewer.role).not.toBe("admin");
  });

  it("管理员：身份照旧是 admin，matrix 位也跟着为真", async () => {
    const { env } = environment();
    expect(
      (await worker.fetch(await request(env, "/api/matrix/pages", "admin"), env))
        .status,
    ).toBe(200);
    expect(store.seen.at(-1)!.viewer).toMatchObject({ role: "admin", matrix: true });
  });

  it("档位没发这一档：主包就地把人挡下，矩阵模块一次都不被调用", async () => {
    const { env, agent } = environment();
    agent.cardPerm.mockResolvedValue(false);
    const response = await worker.fetch(
      await request(env, "/api/matrix/pages", "user", "card1"),
      env,
    );
    expect(response.status).toBe(403);
    expect(store.seen).toHaveLength(0);
  });

  it("推送入口那条路没有会话：它带的 admin 是推送 token 自己的，不是冒充谁", async () => {
    const { env } = environment("push-test");
    const response = await worker.fetch(
      new Request("https://app.test/api/matrix/pack", {
        method: "POST",
        headers: { Authorization: "Bearer push-test" },
        body: "zip-bytes",
      }),
      env,
    );
    expect(response.status).toBe(200);
    expect(store.seen.at(-1)).toMatchObject({
      pathname: "/api/matrix/pack",
      viewer: { role: "admin" },
    });
    expect(store.seen.at(-1)!.viewer.matrix).toBeUndefined();
  });

  it("矩阵页的公开读那条路不受这轮改动影响：没带票的过路人仍是 public", async () => {
    const { env } = environment();
    const response = await worker.fetch(
      new Request("https://app.test/m/some-page"),
      env,
    );
    expect(response.status).toBe(200);
    expect(store.pageViewers.at(-1)).toEqual({ role: "public" });
    // 这条读路径不碰管理面，也不去核权益
    expect(store.seen).toHaveLength(0);
  });
});
