/**
 * 门禁口令与 token 测试（云端这一份）。
 *
 * 这批用例盯着两件事：
 * 1. 没配口令时必须谁都进不来。公网 Worker 不能带内置默认口令，
 *    漏配 secret 必须显式失败，因此在这里单独验证。
 * 2. 没配签名密钥时不许签、也不许验。空密钥签出来的票如果还能被接受，
 *    任何人都能给自己签发一张 admin 票。
 *
 * 运行: npx vitest run test/auth.test.ts
 */

import { describe, expect, it } from "vitest";
import {
  adminPassword,
  clearCookie,
  cookieSecure,
  gatePassword,
  issueToken,
  renewToken,
  roleForPassword,
  SESSION_RENEW_LEFT_SEC,
  SESSION_TTL_SEC,
  sessionCookie,
  tokenNeedsRenewal,
  verifyToken,
  verifyTokenInfo,
  type Role,
} from "../src/auth";

const env = (v: Partial<Env> = {}) => v as unknown as Env;

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

describe("token 的签发与校验", () => {
  it("配了密钥：签出去的原样验得回来，角色跟着票走", async () => {
    const e = env({ GATE_PASSWORD: "menkou", SESSION_SECRET: "s3cr3t" });
    const admin = await issueToken(e, "admin");
    expect(await verifyToken(e, admin)).toBe("admin");
    const guest = await issueToken(e, "user");
    expect(await verifyToken(e, guest)).toBe("user");
  });

  it("过期票不作数", async () => {
    const e = env({ SESSION_SECRET: "s3cr3t" });
    const stale = await issueToken(e, "admin", -10);
    expect(await verifyToken(e, stale)).toBeNull();
  });

  it("换密钥即作废：旧票在新密钥下验不过", async () => {
    const old = env({ SESSION_SECRET: "old" });
    const token = await issueToken(old, "admin");
    expect(await verifyToken(env({ SESSION_SECRET: "new" }), token)).toBeNull();
  });

  it("换了签名密钥，旧票一律作废；门禁码怎么改都与票据无关", async () => {
    const before = env({ SESSION_SECRET: "s1" });
    const token = await issueToken(before, "user");
    expect(await verifyToken(before, token)).toBe("user");
    expect(await verifyToken(env({ SESSION_SECRET: "s2" }), token)).toBeNull();
    // 门禁码不在签名链里：换门禁码不动摇任何一张票
    expect(
      await verifyToken(
        env({ SESSION_SECRET: "s1", GATE_PASSWORD: "b" }),
        token,
      ),
    ).toBe("user");
  });

  it("缺密钥：签会抛错，形状再对的票也验不过", async () => {
    const e = env();
    await expect(issueToken(e, "admin")).rejects.toThrow(/门禁未配置/);
    const forged = await signWith(
      "attacker-guess",
      Date.now() + 60_000,
      "admin",
    );
    expect(await verifyToken(e, forged)).toBeNull();
    expect(await verifyToken(e, "1700000000000.admin.deadbeef")).toBeNull();
    expect(await verifyToken(e, "garbage")).toBeNull();
    expect(await verifyToken(e, null)).toBeNull();
  });

  it("空密钥这条路本身也走不通：WebCrypto 就拒绝零长 HMAC 密钥", async () => {
    await expect(
      crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(""),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      ),
    ).rejects.toThrow(/Zero-length key/);
  });
});

describe("签名密钥不落门禁码", () => {
  it("只配门禁码：什么票都签不出来 —— 门禁码是来客知道的东西，不能当签名钥", async () => {
    const e = env({ GATE_PASSWORD: "menkou" });
    await expect(issueToken(e, "admin")).rejects.toThrow(/SESSION_SECRET/);
    await expect(issueToken(e, "user")).rejects.toThrow(/SESSION_SECRET/);
  });

  it("只配门禁码：仿签的 admin 票验不过", async () => {
    const e = env({ GATE_PASSWORD: "menkou" });
    const forged = await signWith("menkou", Date.now() + 60_000, "admin");
    expect(await verifyTokenInfo(e, forged)).toBeNull();
  });

  it("只配门禁码：仿签的 user 票连别人的卡 id 一起签上也验不过 —— 这本来是能进别人房间的那条链", async () => {
    const e = env({ GATE_PASSWORD: "menkou" });
    const forged = await signWithCard(
      "menkou",
      Date.now() + 60_000,
      "user",
      "common",
      "abcd1234",
    );
    expect(await verifyTokenInfo(e, forged)).toBeNull();
  });

  it("配了 SESSION_SECRET：user 票带卡照常签验，拿门禁码仿签的照旧进不来", async () => {
    const e = env({ SESSION_SECRET: "s3cr3t", GATE_PASSWORD: "menkou" });
    const token = await issueToken(e, "user", undefined, "common", "abcd1234");
    expect(await verifyTokenInfo(e, token)).toEqual({
      role: "user",
      type: "common",
      card: "abcd1234",
      exp: expect.any(Number),
    });
    const forged = await signWithCard(
      "menkou",
      Date.now() + 60_000,
      "user",
      "common",
      "abcd1234",
    );
    expect(await verifyTokenInfo(e, forged)).toBeNull();
  });

  it("只配 ADMIN_PASSWORD：票用口令签、用口令验，照常工作", async () => {
    const e = env({ ADMIN_PASSWORD: "guanmen" });
    const token = await issueToken(e, "admin");
    expect(await verifyTokenInfo(e, token)).toEqual({
      role: "admin",
      exp: expect.any(Number),
    });
  });
});

describe("token v2：带档位的来客票", () => {
  it("带档位签出四段票：role 和 type 都验得回来", async () => {
    const e = env({ SESSION_SECRET: "s3cr3t" });
    const token = await issueToken(e, "user", undefined, "vip");
    expect(token.split(".")).toHaveLength(4);
    expect(await verifyToken(e, token)).toBe("user");
    expect(await verifyTokenInfo(e, token)).toEqual({
      role: "user",
      type: "vip",
      exp: expect.any(Number),
    });
  });

  it("admin 不分档：给了 type 也只签三段", async () => {
    const e = env({ SESSION_SECRET: "s3cr3t" });
    const token = await issueToken(e, "admin", undefined, "vip");
    expect(token.split(".")).toHaveLength(3);
    expect(await verifyTokenInfo(e, token)).toEqual({
      role: "admin",
      exp: expect.any(Number),
    });
  });

  it("v1 老票（三段）照样验得过，type 视为没有", async () => {
    const e = env({ SESSION_SECRET: "s3cr3t" });
    const old = await signWith("s3cr3t", Date.now() + 60_000, "user");
    expect(old.split(".")).toHaveLength(3);
    expect(await verifyTokenInfo(e, old)).toEqual({
      role: "user",
      exp: expect.any(Number),
    });
  });

  it("档位对不上签名：整张票作废 —— 档位是签进去的，改不动", async () => {
    const e = env({ SESSION_SECRET: "s3cr3t" });
    const token = await issueToken(e, "user", undefined, "vip");
    const [exp, role, , sig] = token.split(".");
    const swapped = `${exp}.${role}.other.${sig}`;
    expect(await verifyTokenInfo(e, swapped)).toBeNull();
    expect(await verifyToken(e, swapped)).toBeNull();
  });

  it("type 长得不像档位 id：签名是好的也不算数", async () => {
    const e = env({ SESSION_SECRET: "s3cr3t" });
    const bad = await signWithTyped(
      "s3cr3t",
      Date.now() + 60_000,
      "user",
      "BAD.TYPE",
    );
    expect(await verifyTokenInfo(e, bad)).toBeNull();
  });

  it("过期票和乱写的四段票一样不作数", async () => {
    const e = env({ SESSION_SECRET: "s3cr3t" });
    const stale = await issueToken(e, "user", -10, "vip");
    expect(await verifyTokenInfo(e, stale)).toBeNull();
    expect(await verifyTokenInfo(e, "1.2.3.4")).toBeNull();
    expect(await verifyTokenInfo(e, null)).toBeNull();
  });
});

describe("token v3：长期使用者的身份卡票", () => {
  it("带 type+card 签出五段票：role/type/card 都验得回来", async () => {
    const e = env({ SESSION_SECRET: "s3cr3t" });
    const token = await issueToken(e, "user", undefined, "vip", "abcd1234");
    expect(token.split(".")).toHaveLength(5);
    expect(await verifyToken(e, token)).toBe("user");
    expect(await verifyTokenInfo(e, token)).toEqual({
      role: "user",
      type: "vip",
      card: "abcd1234",
      exp: expect.any(Number),
    });
  });

  it("admin 不带卡：给了 card 也只签三段", async () => {
    const e = env({ SESSION_SECRET: "s3cr3t" });
    const token = await issueToken(e, "admin", undefined, "vip", "abcd1234");
    expect(token.split(".")).toHaveLength(3);
    expect(await verifyTokenInfo(e, token)).toEqual({
      role: "admin",
      exp: expect.any(Number),
    });
  });

  it("v2 四段老票照样验得过：card 视为没有", async () => {
    const e = env({ SESSION_SECRET: "s3cr3t" });
    const old = await issueToken(e, "user", undefined, "vip");
    expect(old.split(".")).toHaveLength(4);
    expect(await verifyTokenInfo(e, old)).toEqual({
      role: "user",
      type: "vip",
      exp: expect.any(Number),
    });
  });

  it("card 段换掉：签名对不上，整张票作废 —— 卡 id 是签进去的，改不动", async () => {
    const e = env({ SESSION_SECRET: "s3cr3t" });
    const token = await issueToken(e, "user", undefined, "vip", "abcd1234");
    const [exp, role, type, , sig] = token.split(".");
    const swapped = `${exp}.${role}.${type}.zzzz9999.${sig}`;
    expect(await verifyTokenInfo(e, swapped)).toBeNull();
  });

  it("card 形状不合法：签名再好也不算数", async () => {
    const e = env({ SESSION_SECRET: "s3cr3t" });
    for (const card of ["ABCD1234", "含汉字", "a".repeat(17)]) {
      const forged = await signWithCard(
        "s3cr3t",
        Date.now() + 60_000,
        "user",
        "vip",
        card,
      );
      expect(await verifyTokenInfo(e, forged)).toBeNull();
    }
  });

  it("乱写的五段票和过期票一样不作数", async () => {
    const e = env({ SESSION_SECRET: "s3cr3t" });
    const stale = await issueToken(e, "user", -10, "vip", "abcd1234");
    expect(await verifyTokenInfo(e, stale)).toBeNull();
    expect(await verifyTokenInfo(e, "1.2.3.4.5")).toBeNull();
    expect(await verifyTokenInfo(e, null)).toBeNull();
  });
});

/** 用任意密钥签一张票，模拟攻击者手上那张「猜出来的钥匙」 */
async function signWith(key: string, exp: number, role: Role): Promise<string> {
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const buf = await crypto.subtle.sign(
    "HMAC",
    material,
    new TextEncoder().encode(`gate.${role}.${exp}`),
  );
  const bytes = new Uint8Array(buf);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return `${exp}.${role}.${btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;
}

/** 同上，但签的是 v2 四段票（攻击者按新格式仿制） */
async function signWithTyped(
  key: string,
  exp: number,
  role: Role,
  type: string,
): Promise<string> {
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const buf = await crypto.subtle.sign(
    "HMAC",
    material,
    new TextEncoder().encode(`gate.${role}.${type}.${exp}`),
  );
  const bytes = new Uint8Array(buf);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return `${exp}.${role}.${type}.${btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;
}

/** 同上，但签的是 v3 五段票（card 形状不合法的仿制票走这条） */
async function signWithCard(
  key: string,
  exp: number,
  role: Role,
  type: string,
  card: string,
): Promise<string> {
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const buf = await crypto.subtle.sign(
    "HMAC",
    material,
    new TextEncoder().encode(`gate.${role}.${type}.${card}.${exp}`),
  );
  const bytes = new Uint8Array(buf);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return `${exp}.${role}.${type}.${card}.${btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;
}

const reqTo = (url: string) => new Request(url);

describe("cookie 上的 Secure 跟着这次请求走", () => {
  it("云端 https：带 Secure", () => {
    const cookie = sessionCookie(
      "t2",
      cookieSecure(reqTo("https://example.workers.dev/")),
    );
    expect(cookie).toContain("Secure");
  });

  // wrangler dev 是 http://，无条件加 Secure 会让「登录成功」之后每一句都是未登录
  it("本机 http：不带 Secure，否则票在下一句就发不回去", () => {
    const cookie = sessionCookie(
      "t1",
      cookieSecure(reqTo("http://localhost:5173/api/auth")),
    );
    expect(cookie).not.toContain("Secure");
    expect(cookie).toContain("xm_session=t1");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
  });

  it("登出用的那一张跟着同一把尺子", () => {
    expect(clearCookie(false)).not.toContain("Secure");
    expect(clearCookie(true)).toContain("Secure");
    expect(clearCookie(true)).toContain("Max-Age=0");
  });

  it("token 里有特殊字符也不会把 cookie 撑成两条", () => {
    const cookie = sessionCookie("a.b=c d", false);
    expect(cookie.split(";").length).toBeGreaterThan(1);
    expect(cookie).not.toContain("a.b=c d");
    expect(cookie).toContain(encodeURIComponent("a.b=c d"));
  });
});

/**
 * 滑动续期：活跃的票永远被续着（持续制），30 天完全不露面的票自然死亡。
 * 判定是「剩余寿命不足半程」—— 一张票最多每 15 天被续一次，不是天天塞 Set-Cookie。
 */
describe("滑动续期", () => {
  const DAY_SEC = 24 * 3600;

  it("新签的票满寿命，不需要续", async () => {
    const e = env({ SESSION_SECRET: "s3cr3t" });
    const token = await issueToken(e, "user", SESSION_TTL_SEC, "type_a");
    const info = await verifyTokenInfo(e, token);
    expect(info).not.toBeNull();
    expect(tokenNeedsRenewal(info!)).toBe(false);
  });

  it("剩余寿命掉进半程 → 该续了（活跃的票从此被一直续着）", async () => {
    const e = env({ SESSION_SECRET: "s3cr3t" });
    // 手签一张只剩 10 天寿命的票：10 天 < 15 天半程
    const token = await issueToken(e, "user", 10 * DAY_SEC, "type_a");
    const info = await verifyTokenInfo(e, token);
    expect(info).not.toBeNull();
    expect(tokenNeedsRenewal(info!)).toBe(true);
  });

  it("正好卡在半程上不算该续：判定是「不足半程」，不是「不足等于」", () => {
    // 把 now 钉死再算边界：不然测试里 Date.now() 和函数里那一下差上 1ms，
    // 「正好卡半程」就被推成「不足半程」，红得毫无道理。
    const now = Date.now();
    expect(
      tokenNeedsRenewal(
        { exp: now + SESSION_RENEW_LEFT_SEC * 1000 },
        now,
      ),
    ).toBe(false);
  });

  it("续出的新票满寿命、权益原样带过去", async () => {
    const e = env({ SESSION_SECRET: "s3cr3t" });
    const old = await issueToken(e, "user", 10 * DAY_SEC, "type_a", "card1234");
    const info = (await verifyTokenInfo(e, old))!;
    const fresh = await renewToken(e, info);
    const freshInfo = await verifyTokenInfo(e, fresh);
    expect(freshInfo).toMatchObject({
      role: "user",
      type: "type_a",
      card: "card1234",
    });
    // 新票的寿命回到了满程（允许签发过程耗掉一点时间）
    expect(freshInfo!.exp - Date.now()).toBeGreaterThan(
      SESSION_TTL_SEC * 1000 - 60_000,
    );
    expect(tokenNeedsRenewal(freshInfo!)).toBe(false);
  });

  it("admin 票同样能续：只换寿命不换角色", async () => {
    const e = env({ SESSION_SECRET: "s3cr3t" });
    const old = await issueToken(e, "admin", 5 * DAY_SEC);
    const info = (await verifyTokenInfo(e, old))!;
    const freshInfo = await verifyTokenInfo(e, await renewToken(e, info));
    expect(freshInfo).toMatchObject({ role: "admin" });
  });
});
