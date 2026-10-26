// 门禁：随机 sid + 服务端会话（auth_sessions）+ HttpOnly Cookie。
// Cookie 只带 `<sid>.<HMAC(key, "sid." + sid)>`；role/type/card/exp 不在 Cookie 里，
// 读不到也改不了。会话记录在主屋 DO 的 SQLite：登出/撤销能真生效，过期由服务端判。
//
// 旧的自包含 HMAC 票（v1/v2/v3）不再接受；升级后所有人需要重新登录一次。

const COOKIE_NAME = "xm_session";
const HOST_COOKIE = "__Host-xm_session";
export const SESSION_TTL_SEC = 30 * 24 * 60 * 60; // 30 天

/** admin：全部面板与写操作；user：只能聊天，面板只读 */
export type Role = "admin" | "user";

export interface TokenInfo {
  role: Role;
  type?: string;
  card?: string;
  exp: number;
}

const enc = new TextEncoder();

/** 来客类型 id / 身份卡 id 的形状；签会话前先过一遍，脏值不进库 */
const TYPE_RE = /^[a-z0-9_-]{1,32}$/;
const CARD_RE = /^[a-z0-9]{4,16}$/;

function b64url(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i += 8192)
    s += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function hmac(key: string, msg: string): Promise<string> {
  const k = await crypto.subtle.importKey(
    "raw",
    enc.encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return b64url(await crypto.subtle.sign("HMAC", k, enc.encode(msg)));
}

async function hashSid(sid: string): Promise<string> {
  const buf = await crypto.subtle.digest(
    "SHA-256",
    enc.encode(`sid.${sid}`),
  );
  return [...new Uint8Array(buf)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function randomSid(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return b64url(bytes.buffer);
}

/** 常量时间比较，避免按字符早退泄露签名前缀（agent 子目录查口令也用它） */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * 口令一律只认环境变量，没有内置默认值。
 * 漏配 secret 时必须拒绝登录，不能拿内置默认口令开放访问。
 */
export function gatePassword(env: Env): string {
  return env.GATE_PASSWORD ?? "";
}

export function adminPassword(env: Env): string {
  return env.ADMIN_PASSWORD ?? "";
}

/**
 * 签名密钥：只认 SESSION_SECRET / ADMIN_PASSWORD。门禁码不在回退链里 ——
 * 它是每个进门来客都知道的东西，拿它签名等于让来客自签任意票。
 */
function signingKey(env: Env): string {
  return env.SESSION_SECRET || env.ADMIN_PASSWORD || "";
}

/** 密码 → 角色；不匹配返回 null */
export function roleForPassword(env: Env, pw: string): Role | null {
  const admin = adminPassword(env);
  if (admin && timingSafeEqual(pw, admin)) return "admin";
  const gate = gatePassword(env);
  if (gate && timingSafeEqual(pw, gate)) return "user";
  return null;
}

interface SessionStub {
  sessionCreate(input: {
    hash: string;
    role: Role;
    type?: string;
    card?: string;
    exp: number;
  }): Promise<void>;
  sessionVerify(hash: string): Promise<TokenInfo | null>;
  sessionRenew(hash: string, ttlSec: number): Promise<number | null>;
  sessionRevoke(hash: string): Promise<boolean>;
}

function sessionStub(env: Env): SessionStub {
  // 测试可注入独立会话命名空间；生产没有这个绑定时走主屋 DO。
  const ns = (
    (env as Env & {
      AUTH_SESSIONS?: {
        idFromName(name: string): unknown;
        get(id: unknown): unknown;
      };
    }).AUTH_SESSIONS ?? env.COWORK_AGENT
  ) as {
    idFromName(name: string): unknown;
    get(id: unknown): unknown;
  };
  if (!ns) throw new Error("会话存储未配置：缺少 COWORK_AGENT 绑定");
  return ns.get(ns.idFromName("default")) as unknown as SessionStub;
}

/** 签发一张新会话：每次登录都是新的随机 sid；身份与过期写进主屋。 */
export async function issueToken(
  env: Env,
  role: Role,
  ttlSec = SESSION_TTL_SEC,
  type?: string,
  card?: string,
): Promise<string> {
  const key = signingKey(env);
  if (!key)
    throw new Error(
      "门禁未配置：SESSION_SECRET / ADMIN_PASSWORD 至少要有一个（门禁码不能当签名密钥）",
    );
  if (type && !TYPE_RE.test(type)) throw new Error("来客类型 id 不合法");
  if (card && !CARD_RE.test(card)) throw new Error("身份卡 id 不合法");
  const sid = randomSid();
  const exp = Date.now() + ttlSec * 1000;
  await sessionStub(env).sessionCreate({
    hash: await hashSid(sid),
    role,
    type,
    card,
    exp,
  });
  const sig = await hmac(key, `sid.${sid}`);
  return `${sid}.${sig}`;
}

/** 验票：先验 sid 的 HMAC（换 SESSION_SECRET 会全部失效），再查服务端会话。 */
export async function verifyTokenInfo(
  env: Env,
  token: string | null | undefined,
): Promise<TokenInfo | null> {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [sid, sig] = parts;
  if (!sid || !sig) return null;
  const key = signingKey(env);
  if (!key) return null;
  if (!(await timingSafeEqual(sig, await hmac(key, `sid.${sid}`)))) return null;
  try {
    const info = await sessionStub(env).sessionVerify(await hashSid(sid));
    if (!info || info.exp <= Date.now()) return null;
    if (info.role !== "admin" && info.role !== "user") return null;
    return info;
  } catch {
    return null;
  }
}

export async function verifyToken(
  env: Env,
  token: string | null | undefined,
): Promise<Role | null> {
  return (await verifyTokenInfo(env, token))?.role ?? null;
}

/** 登出：删掉这张会话；签名不对/已不存在都算没有。 */
export async function revokeSession(
  env: Env,
  token: string | null | undefined,
): Promise<boolean> {
  if (!token) return false;
  const parts = token.split(".");
  if (parts.length !== 2) return false;
  const [sid, sig] = parts;
  const key = signingKey(env);
  if (!sid || !sig || !key) return false;
  if (!(await timingSafeEqual(sig, await hmac(key, `sid.${sid}`)))) return false;
  try {
    return await sessionStub(env).sessionRevoke(await hashSid(sid));
  } catch {
    return false;
  }
}

/** 续期：延长同一张 sid 的过期；返回原 Cookie 值（签名不变），失败返回 null。 */
export async function renewSession(
  env: Env,
  token: string | null | undefined,
  ttlSec = SESSION_TTL_SEC,
): Promise<string | null> {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [sid, sig] = parts;
  const key = signingKey(env);
  if (!sid || !sig || !key) return null;
  if (!(await timingSafeEqual(sig, await hmac(key, `sid.${sid}`)))) return null;
  try {
    const exp = await sessionStub(env).sessionRenew(await hashSid(sid), ttlSec);
    return exp === null ? null : token;
  } catch {
    return null;
  }
}

function readCookie(req: Request, name: string): string | null {
  const raw = req.headers.get("Cookie");
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) {
      try {
        return decodeURIComponent(part.slice(i + 1).trim());
      } catch {
        return null;
      }
    }
  }
  return null;
}

/**
 * 这张 cookie 要不要带 Secure —— 看法是「这次请求本身走的会不会被窃听」。
 * 线上 https 用 __Host-（要求 Secure、Path=/、不带 Domain）；本机 http 才退回 xm_session。
 */
export function cookieSecure(req: Request): boolean {
  return new URL(req.url).protocol === "https:";
}

export function sessionCookie(
  token: string,
  secure: boolean,
  maxAgeSec = SESSION_TTL_SEC,
): string {
  const name = secure ? HOST_COOKIE : COOKIE_NAME;
  return `${name}=${encodeURIComponent(token)}; Path=/; HttpOnly;${
    secure ? " Secure;" : ""
  } SameSite=Lax; Max-Age=${maxAgeSec}`;
}

export function clearCookie(secure: boolean): string {
  const name = secure ? HOST_COOKIE : COOKIE_NAME;
  return `${name}=; Path=/; HttpOnly;${
    secure ? " Secure;" : ""
  } SameSite=Lax; Max-Age=0`;
}

/** 登出时把新旧两个名字都清掉，避免旧 xm_session 残留。 */
export function clearCookies(secure: boolean): string[] {
  return [
    `${HOST_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`,
    `${COOKIE_NAME}=; Path=/; HttpOnly;${
      secure ? " Secure;" : ""
    } SameSite=Lax; Max-Age=0`,
  ];
}

/** Cookie 优先，其次 `Authorization: Bearer <token>`（便于 curl 验证） */
export function authToken(req: Request): string | null {
  const bearer = req.headers.get("Authorization");
  return (
    readCookie(req, HOST_COOKIE) ??
    readCookie(req, COOKIE_NAME) ??
    (bearer?.startsWith("Bearer ") ? bearer.slice(7) : null)
  );
}

export async function authRole(req: Request, env: Env): Promise<Role | null> {
  return verifyToken(env, authToken(req));
}

/**
 * 滑动续期：票的剩余寿命不足半程就该续。
 * 活跃的票永远被续着，30 天完全不露面的票自然死亡；半程而不是临期才续。
 */
export const SESSION_RENEW_LEFT_SEC = SESSION_TTL_SEC / 2;

export function tokenNeedsRenewal(
  info: { exp: number },
  now = Date.now(),
): boolean {
  return info.exp - now < SESSION_RENEW_LEFT_SEC * 1000;
}

/** 主人住的那一间屋子（DO 实例名） */
export const OWNER_AGENT = "default";

/**
 * 场屋名：一个会话一间屋（完整的 CoworkAgent 运行时）。
 * 屋名 = 人屋名 + `--` + 场 id。人屋名（default / guest-十六进制 / 卡房名）都不含 `--`。
 */
export function sessionRoom(room: string, sessionId: string): string {
  return `${room}--${sessionId}`;
}

/** 场屋名里的人屋部分；不是场屋（人屋本尊）时返回 null。 */
export function ownerRoomOf(name: string): string | null {
  const i = name.indexOf("--");
  return i === -1 ? null : name.slice(0, i);
}

// 卡房缓存：cardId → 绑定的房间。查卡要走主人房 RPC，每个请求都查一趟太浪费；
// 缓存 60 秒，卡被删后缓存到期自然失效，票就退回派生房（等于变回临时身份）
const cardRoomCache = new Map<string, { room: string; at: number }>();
const CARD_ROOM_TTL_MS = 60_000;

/** 查一张卡绑定的房间。卡不存在 / 主人房没醒时返回 null。 */
export async function cardRoom(
  env: Env,
  cardId: string,
): Promise<string | null> {
  const hit = cardRoomCache.get(cardId);
  if (hit && Date.now() - hit.at < CARD_ROOM_TTL_MS) return hit.room;
  if (cardRoomCache.size > 200) {
    const now = Date.now();
    for (const [k, v] of cardRoomCache)
      if (now - v.at >= CARD_ROOM_TTL_MS) cardRoomCache.delete(k);
  }
  try {
    const stub = env.COWORK_AGENT.get(
      env.COWORK_AGENT.idFromName(OWNER_AGENT),
    ) as unknown as { cardRoom(id: string): Promise<string | null> };
    const room = await stub.cardRoom(cardId);
    if (room) cardRoomCache.set(cardId, { room, at: Date.now() });
    return room;
  } catch {
    return null;
  }
}

/**
 * 这次会话该连哪一间屋子。
 * 管理员连主人那间；持卡来客回卡绑定的房间；临时来客按这次会话的 sid 派生。
 * 名字由签名密钥 + 会话 token 派生；Worker 入口还会按角色再核一遍地址。
 */
export async function agentNameForToken(
  env: Env,
  role: Role,
  token: string | null,
): Promise<string> {
  if (role === "admin") return OWNER_AGENT;
  const info = await verifyTokenInfo(env, token);
  if (info?.card) {
    const bound = await cardRoom(env, info.card);
    if (bound) return bound;
  }
  const buf = await crypto.subtle.digest(
    "SHA-256",
    enc.encode(`guest.${signingKey(env)}.${token || "anon"}`),
  );
  const hex = [...new Uint8Array(buf).slice(0, 8)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `guest-${hex}`;
}

export async function agentNameFor(
  req: Request,
  env: Env,
  role: Role,
): Promise<string> {
  return agentNameForToken(env, role, authToken(req));
}

export function unauthorized(): Response {
  return Response.json({ ok: false, error: "未登录" }, { status: 401 });
}

export function forbidden(): Response {
  return Response.json({ ok: false, error: "需要管理员权限" }, { status: 403 });
}
