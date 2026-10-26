/**
 * 门禁口令与会话票测试（云端这一份）。
 *
 * 现在 Cookie 只带随机 sid；身份与过期在主屋的 auth_sessions 里。
 * 这批用例盯：没配口令/密钥必须失败；每登录一张新票；篡改/撤销/过期/换密钥都进不来；
 * Cookie 属性（HttpOnly / SameSite / Secure / __Host-）与续期边界。
 */

import { describe, expect, it } from "vitest";
import {
  adminPassword,
  authToken,
  clearCookie,
  clearCookies,
  cookieSecure,
  gatePassword,
  issueToken,
  renewSession,
  revokeSession,
  roleForPassword,
  SESSION_RENEW_LEFT_SEC,
  SESSION_TTL_SEC,
  sessionCookie,
  tokenNeedsRenewal,
  verifyToken,
  verifyTokenInfo,
} from "../src/auth";
import { attachFakeSessions, type FakeSession } from "./fakeSessions";

const DAY_SEC = 24 * 60 * 60;
const store = () => new Map<string, FakeSession>();
function env(v: Partial<Env> = {}, sessions = store()) {
  const agent = attachFakeSessions({}, sessions);
  return {
    ...v,
    COWORK_AGENT: { idFromName: (n: string) => n, get: () => agent },
  } as unknown as Env;
}

describe("口令只在配了的情况下才算数", () => {
  it("三项全缺：任何口令都换不到角色，没有内置默认值", () => {
    const e = env();
    expect(gatePassword(e)).toBe("");
    expect(adminPassword(e)).toBe("");
    for (const pw of ["", "1234", "another-guess"]) {
      expect(roleForPassword(e, pw)).toBeNull();
    }
  });

  it("只配来客口令：对得上是 user，空口令不算对上", () => {
    const e = env({ GATE_PASSWORD: "menkou" });
    expect(roleForPassword(e, "menkou")).toBe("user");
    expect(roleForPassword(e, "")).toBeNull();
    expect(roleForPassword(e, "menkou ")).toBeNull();
    expect(roleForPassword(e, "wrong-guess")).toBeNull();
  });

  it("两个都配：各归各的位，交叉一律不算", () => {
    const e = env({ GATE_PASSWORD: "menkou", ADMIN_PASSWORD: "guanmen" });
    expect(roleForPassword(e, "guanmen")).toBe("admin");
    expect(roleForPassword(e, "menkou")).toBe("user");
    expect(roleForPassword(e, "")).toBeNull();
  });

  it("两档口令写成同一个值时按高的那档算", () => {
    const e = env({ GATE_PASSWORD: "same", ADMIN_PASSWORD: "same" });
    expect(roleForPassword(e, "same")).toBe("admin");
  });
});

describe("会话票的签发与校验", () => {
  it("签出去的原样验得回来，角色跟着会话说", async () => {
    const e = env({ SESSION_SECRET: "s3cr3t" });
    const admin = await issueToken(e, "admin");
    expect(await verifyToken(e, admin)).toBe("admin");
    const guest = await issueToken(e, "user");
    expect(await verifyToken(e, guest)).toBe("user");
  });

  it("每次签发都是不同的 sid：同角色同秒也拿不到同一张票", async () => {
    const e = env({ SESSION_SECRET: "s3cr3t" });
    const a = await issueToken(e, "admin");
    const b = await issueToken(e, "admin");
    expect(a).not.toBe(b);
    expect(await verifyToken(e, a)).toBe("admin");
    expect(await verifyToken(e, b)).toBe("admin");
  });

  it("会话带 type / card：校验时原样返回", async () => {
    const e = env({ SESSION_SECRET: "s3cr3t" });
    const token = await issueToken(e, "user", undefined, "vip", "abcd1234");
    expect(await verifyTokenInfo(e, token)).toMatchObject({
      role: "user",
      type: "vip",
      card: "abcd1234",
    });
  });

  it("非法 type / card 在签发时就拒绝", async () => {
    const e = env({ SESSION_SECRET: "s3cr3t" });
    await expect(
      issueToken(e, "user", undefined, "Vip!", "abcd1234"),
    ).rejects.toThrow();
    await expect(
      issueToken(e, "user", undefined, "vip", "bad id"),
    ).rejects.toThrow();
  });

  it("没配签名密钥：签不出、也验不过", async () => {
    const e = env({ GATE_PASSWORD: "menkou" });
    await expect(issueToken(e, "admin")).rejects.toThrow(/SESSION_SECRET/);
    expect(await verifyToken(e, "a.b")).toBeNull();
  });

  it("签名被改、格式不对、空票都进不来", async () => {
    const e = env({ SESSION_SECRET: "s3cr3t" });
    const token = await issueToken(e, "admin");
    const [sid, sig] = token.split(".");
    expect(await verifyToken(e, `${sid}.${sig.slice(0, -1)}x`)).toBeNull();
    expect(await verifyToken(e, "1700000000000.admin.deadbeef")).toBeNull();
    expect(await verifyToken(e, "garbage")).toBeNull();
    expect(await verifyToken(e, null)).toBeNull();
  });

  it("换签名密钥：旧票全部失效，哪怕会话记录还在", async () => {
    const sessions = store();
    const before = env({ SESSION_SECRET: "old" }, sessions);
    const token = await issueToken(before, "admin");
    expect(await verifyToken(env({ SESSION_SECRET: "new" }, sessions), token)).toBeNull();
    expect(await verifyToken(env({ SESSION_SECRET: "old" }, sessions), token)).toBe("admin");
  });

  it("会话被撤销：票即使签名有效也不再认", async () => {
    const e = env({ SESSION_SECRET: "s3cr3t" });
    const token = await issueToken(e, "admin");
    expect(await revokeSession(e, token)).toBe(true);
    expect(await verifyToken(e, token)).toBeNull();
    expect(await revokeSession(e, token)).toBe(false);
  });

  it("会话记录不存在（换库/清理）：按未登录处理", async () => {
    const e = env({ SESSION_SECRET: "s3cr3t" });
    const token = await issueToken(e, "admin");
    expect(
      await verifyToken(env({ SESSION_SECRET: "s3cr3t" }), token),
    ).toBeNull();
  });

  it("过期会话：签发时就带过去的时间，也验不过", async () => {
    const e = env({ SESSION_SECRET: "s3cr3t" });
    const stale = await issueToken(e, "admin", -10);
    expect(await verifyToken(e, stale)).toBeNull();
  });
});

describe("Cookie 属性", () => {
  it("https 用 __Host-，带 Secure / HttpOnly / SameSite", () => {
    const cookie = sessionCookie("t1", true);
    expect(cookie).toContain("__Host-xm_session=t1");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain(`Max-Age=${SESSION_TTL_SEC}`);
  });

  it("本机 http 退回 xm_session，不硬塞 Secure", () => {
    const cookie = sessionCookie("t1", false);
    expect(cookie).toContain("xm_session=t1");
    expect(cookie).not.toContain("__Host-");
    expect(cookie).not.toContain("Secure");
  });

  it("值会 URL 编码；清 Cookie 是 Max-Age=0", () => {
    expect(sessionCookie("a.b=c d", false)).toContain(
      "xm_session=" + encodeURIComponent("a.b=c d"),
    );
    expect(clearCookie(true)).toContain("__Host-xm_session=;");
    expect(clearCookie(true)).toContain("Secure");
    expect(clearCookie(true)).toContain("Max-Age=0");
  });

  it("登出同时清新旧两个名字", () => {
    const all = clearCookies(true);
    expect(all).toHaveLength(2);
    expect(all.join("\n")).toContain("__Host-xm_session=");
    expect(all.join("\n")).toContain("xm_session=");
  });

  it("cookieSecure 只看这次请求的协议", () => {
    expect(cookieSecure(new Request("https://x.test/"))).toBe(true);
    expect(cookieSecure(new Request("http://localhost/"))).toBe(false);
  });

  it("读 Cookie 时 __Host- 优先，Bearer 兜底", () => {
    const req = new Request("https://x.test/", {
      headers: {
        Cookie: "xm_session=legacy; __Host-xm_session=host",
        Authorization: "Bearer bearer-token",
      },
    });
    expect(authToken(req)).toBe("host");
    const onlyLegacy = new Request("http://localhost/", {
      headers: { Cookie: "xm_session=legacy" },
    });
    expect(authToken(onlyLegacy)).toBe("legacy");
    const header = new Request("https://x.test/", {
      headers: { Authorization: "Bearer bearer-token" },
    });
    expect(authToken(header)).toBe("bearer-token");
  });
});

describe("滑动续期", () => {
  it("剩余寿命过半不续；掉进半程才续", async () => {
    const e = env({ SESSION_SECRET: "s3cr3t" });
    const full = await verifyTokenInfo(
      e,
      await issueToken(e, "user", SESSION_TTL_SEC, "type_a"),
    );
    expect(full).not.toBeNull();
    expect(tokenNeedsRenewal(full!)).toBe(false);

    const near = await verifyTokenInfo(
      e,
      await issueToken(e, "user", 10 * DAY_SEC, "type_a"),
    );
    expect(near).not.toBeNull();
    expect(tokenNeedsRenewal(near!)).toBe(true);
  });

  it("正好卡在半程上不算该续", () => {
    const now = Date.now();
    expect(
      tokenNeedsRenewal(
        { exp: now + SESSION_RENEW_LEFT_SEC * 1000 },
        now,
      ),
    ).toBe(false);
  });

  it("续期延长同一张会话，权益原样带过去", async () => {
    const e = env({ SESSION_SECRET: "s3cr3t" });
    const old = await issueToken(e, "user", 10 * DAY_SEC, "type_a", "abcd1234");
    const fresh = await renewSession(e, old);
    expect(fresh).toBe(old);
    const info = await verifyTokenInfo(e, fresh!);
    expect(info).toMatchObject({
      role: "user",
      type: "type_a",
      card: "abcd1234",
    });
    expect(info!.exp - Date.now()).toBeGreaterThan(
      SESSION_TTL_SEC * 1000 - 60_000,
    );
    expect(tokenNeedsRenewal(info!)).toBe(false);
  });

  it("撤销后的会话不能再续", async () => {
    const e = env({ SESSION_SECRET: "s3cr3t" });
    const token = await issueToken(e, "admin");
    await revokeSession(e, token);
    expect(await renewSession(e, token)).toBeNull();
  });
});
