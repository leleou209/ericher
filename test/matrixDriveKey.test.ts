/**
 * 矩阵页「引用云盘文件」的范围闸。
 *
 * R2 是同一只桶：key 能指向邮件原件、别的房间的私有文件。矩阵管理权是
 * 一整面的页面管理权，不是整只桶的读取权 —— 管理员仍可引用任意文件，
 * 其余调用者只能引用公开区与自己那间的文件，且拒绝发生在 head 之前
 * （不能拿「文件存不存在」当探针）。矩阵包装备走同一把尺。
 *
 * 运行: npx vitest run test/matrixDriveKey.test.ts
 */

import { describe, expect, it } from "vitest";
import { strToU8, zipSync } from "fflate";
import {
  handleMatrixApi,
  loadConfig,
  type MatrixEnv,
  type MatrixViewer,
} from "../src/matrix/core";
import { PUBLIC_PREFIX } from "../src/fileAccess";

function fakeEnv(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  const heads: string[] = [];
  const bucket = {
    get: async (key: string) => {
      const v = store.get(key);
      if (v === undefined) return null;
      return {
        text: async () => v,
        size: v.length,
        arrayBuffer: async () => new TextEncoder().encode(v).buffer,
      };
    },
    put: async (key: string, value: unknown) => {
      store.set(
        key,
        typeof value === "string"
          ? value
          : new TextDecoder().decode(value as ArrayBuffer),
      );
    },
    head: async (key: string) => {
      heads.push(key);
      const v = store.get(key);
      return v === undefined ? null : { size: v.length };
    },
    delete: async (key: string) => {
      store.delete(key);
    },
    list: async () => ({ objects: [], truncated: false }),
  };
  return {
    store,
    heads,
    env: { MEMORY_BUCKET: bucket } as unknown as MatrixEnv,
  };
}

const OWN_ROOM = "guest-abcd1234";
const OWN_KEY = `f/${OWN_ROOM}/doc.html`;
const OTHER_KEY = "f/guest-other/secret.html";
const MAIL_KEY = "mail/in/20261026/x.eml";

function saveRequest(key: string): Request {
  const form = new FormData();
  form.set(
    "meta",
    JSON.stringify({ path: "p1", title: "一页", access: "public" }),
  );
  form.set("key", key);
  return new Request("https://app.test/api/matrix/save", {
    method: "POST",
    body: form,
  });
}

function packRequest(driveKey: string): Request {
  const manifest = {
    format: "ericher-matrix",
    version: 1,
    config: {
      pages: [
        {
          id: "p1",
          path: "p1",
          title: "一页",
          access: "public",
          driveKey,
        },
      ],
      links: [],
    },
  };
  return new Request("https://app.test/api/matrix/pack", {
    method: "POST",
    body: zipSync({ "matrix.json": strToU8(JSON.stringify(manifest)) }),
  });
}

const viewer = (over: Partial<MatrixViewer> = {}): MatrixViewer => ({
  role: "user",
  matrix: true,
  fileRoom: OWN_ROOM,
  ...over,
});

describe("保存一页：引用云盘文件按调用者划界", () => {
  it("管理员可引用任意文件", async () => {
    const h = fakeEnv({ [OTHER_KEY]: "<p>secret</p>" });
    const res = await handleMatrixApi(
      saveRequest(OTHER_KEY),
      h.env,
      "/api/matrix/save",
      viewer({ role: "admin" }),
    );
    expect(res.status).toBe(200);
    expect((await loadConfig(h.env)).pages[0].driveKey).toBe(OTHER_KEY);
  });

  it("矩阵来客可引用自己那间与公开区的文件", async () => {
    for (const key of [OWN_KEY, `${PUBLIC_PREFIX}pic.html`]) {
      const h = fakeEnv({ [key]: "<p>ok</p>" });
      const res = await handleMatrixApi(
        saveRequest(key),
        h.env,
        "/api/matrix/save",
        viewer(),
      );
      expect(res.status).toBe(200);
      expect((await loadConfig(h.env)).pages[0].driveKey).toBe(key);
    }
  });

  it("矩阵来客引用别人房间或邮件原件：400，且不去 head 探存在性", async () => {
    const keys = [OTHER_KEY, MAIL_KEY];
    for (const key of keys) {
      const h = fakeEnv({ [key]: "private" });
      const res = await handleMatrixApi(
        saveRequest(key),
        h.env,
        "/api/matrix/save",
        viewer(),
      );
      expect(res.status).toBe(400);
      expect(h.heads).not.toContain(key);
      expect((await loadConfig(h.env)).pages).toHaveLength(0);
    }
  });
});

describe("装备矩阵包：包里的引用走同一把尺", () => {
  it("矩阵来客装自己范围的包：成功", async () => {
    const h = fakeEnv({ [OWN_KEY]: "<p>mine</p>" });
    const res = await handleMatrixApi(
      packRequest(OWN_KEY),
      h.env,
      "/api/matrix/pack",
      viewer(),
    );
    expect(res.status).toBe(200);
    expect((await loadConfig(h.env)).pages[0].driveKey).toBe(OWN_KEY);
  });

  it("矩阵来客装引用私有文件的包：400，配置原样不动", async () => {
    const h = fakeEnv({ [MAIL_KEY]: "private" });
    const res = await handleMatrixApi(
      packRequest(MAIL_KEY),
      h.env,
      "/api/matrix/pack",
      viewer(),
    );
    expect(res.status).toBe(400);
    expect(h.heads).not.toContain(MAIL_KEY);
    expect((await loadConfig(h.env)).pages).toHaveLength(0);
  });
});
