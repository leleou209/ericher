// 门禁：HMAC-SHA256 签名的会话 token + HttpOnly Cookie。
// token 形式 `<exp>.<role>.<base64url(HMAC(key, "gate." + role + "." + exp))>`，
// 无状态、无需存储；role 参与签名，客户端改不动。
//
// v2：多档来客类型的票多带一段类型 id ——
// `<exp>.<role>.<type>.<base64url(HMAC(key, "gate." + role + "." + type + "." + exp))>`。
// type 参与签名，换一档就是另一张票；type 只对 user 有意义（admin 只有一把钥匙）。
//
// v3：长期使用者的身份卡再加一段 ——
// `<exp>.<role>.<type>.<card>.<sig>`。card 参与签名，同样改不动。
// 有 card 的票，房间不从票算（票会过期重签，卡不会），而是查卡绑定的那间屋。

const COOKIE_NAME = "xm_session";
export const SESSION_TTL_SEC = 30 * 24 * 60 * 60; // 30 天

/** admin：全部面板与写操作；user：只能聊天，面板只读 */
export type Role = "admin" | "user";

/** 身份卡 id 的形状：randomUUID 截出来的 8 位小写字母数字 */
const CARD_RE = /^[a-z0-9]{4,16}$/;

const enc = new TextEncoder();

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

/** 常量时间比较，避免按字符早退泄露签名前缀（agent 子目录查口令也用它） */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * 口令一律只认环境变量，没有内置默认值。
 *
 * 本服务可从公网访问，漏配 secret 时必须拒绝登录。宁可让配置错误显现，
 * 也不能用内置默认口令让没有配置的实例开放访问。
 */
export function gatePassword(env: Env): string {
  return env.GATE_PASSWORD ?? "";
}

export function adminPassword(env: Env): string {
  return env.ADMIN_PASSWORD ?? "";
}

/**
 * 签名密钥：只认 SESSION_SECRET / ADMIN_PASSWORD，一处都拿不到时返回空串 ——
 * 签发与校验都会就此拒绝，绝不用空密钥签 token。
 *
 * 门禁码不在回退链里：它是每个进门来客都知道的东西。拿它签票，来客就能
 * 自签任意 user 票 —— 连别人的卡 id 一起签上，房间路由按卡查屋，等于
 * 一张假卡进别人的门。只配 GATE_PASSWORD 的部署签不出任何票，
 * 配置错误一眼看得见；这与口令不设内置兜底是同一条哲学：
 * 宁可门锁死，不发假钥匙。
 */
function signingKey(env: Env): string {
  return env.SESSION_SECRET || env.ADMIN_PASSWORD || "";
}

/** 密码 → 角色；不匹配返回 null */
export function roleForPassword(env: Env, pw: string): Role | null {
  // 没配的那一档不参与比较：否则 timingSafeEqual("", "") 成立，空口令就成了钥匙
  const admin = adminPassword(env);
  if (admin && timingSafeEqual(pw, admin)) return "admin";
  const gate = gatePassword(env);
  if (gate && timingSafeEqual(pw, gate)) return "user";
  return null;
}

/** 来客类型 id 在 token 里的形状：小写字母数字下划线连字符，1~32 位 */
const TYPE_RE = /^[a-z0-9_-]{1,32}$/;

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
  const exp = Date.now() + ttlSec * 1000;
  // type / card 只有 user 这档用：admin 只有一把钥匙，多带一段反而是两处要对着改
  if (role === "user" && type && card) {
    return `${exp}.${role}.${type}.${card}.${await hmac(
      key,
      `gate.${role}.${type}.${card}.${exp}`,
    )}`;
  }
  if (role === "user" && type) {
    return `${exp}.${role}.${type}.${await hmac(
      key,
      `gate.${role}.${type}.${exp}`,
    )}`;
  }
  return `${exp}.${role}.${await hmac(key, `gate.${role}.${exp}`)}`;
}

/**
 * 验一张票，连类型、身份卡一起带回来。
 * 3 段是 v1 的老票（type/card 视为没有，签名消息不变，老票不作废）；
 * 4 段是 v2：type 必须长得像类型 id，否则整张票不算数；
 * 5 段是 v3：card 必须长得像卡 id。宁可疑之人都重新登录，
 * 也不给来历不明的「类型」「卡」开门。
 */
export async function verifyTokenInfo(
  env: Env,
  token: string | null | undefined,
): Promise<{ role: Role; type?: string; card?: string; exp: number } | null> {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length < 3 || parts.length > 5) return null;
  const [expStr, role, third, fourth, fifth] = parts;
  if (role !== "admin" && role !== "user") return null;
  // 没密钥就一律当「不是我们的 token」，绝不用空串去比 —— 门禁码已不在
  // 密钥链里，知道门禁码也仿不出能过的票（user 票带别人的卡 id 也一样）
  const key = signingKey(env);
  if (!key) return null;
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || exp < Date.now()) return null;
  if (parts.length === 3) {
    return (await timingSafeEqual(
      third,
      await hmac(key, `gate.${role}.${exp}`),
    ))
      ? { role, exp }
      : null;
  }
  const type = third;
  if (!TYPE_RE.test(type)) return null;
  if (parts.length === 4) {
    return (await timingSafeEqual(
      fourth,
      await hmac(key, `gate.${role}.${type}.${exp}`),
    ))
      ? { role, type, exp }
      : null;
  }
  const card = fourth;
  const sig = fifth;
  if (!CARD_RE.test(card)) return null;
  return (await timingSafeEqual(
    sig,
    await hmac(key, `gate.${role}.${type}.${card}.${exp}`),
  ))
    ? { role, type, card, exp }
    : null;
}

export async function verifyToken(
  env: Env,
  token: string | null | undefined,
): Promise<Role | null> {
  return (await verifyTokenInfo(env, token))?.role ?? null;
}

function readCookie(req: Request, name = COOKIE_NAME): string | null {
  const raw = req.headers.get("Cookie");
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name)
      return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

/**
 * 这张 cookie 要不要带 Secure —— 看法是「这次请求本身走的会不会被窃听」。
 *
 * 原来是无条件加 Secure。线上永远走 https，看着没事；但 `wrangler dev` 和本机
 * 常驻都是 http://，带 Secure 的 cookie 在非 https 连接上根本不会被回传：
 * 登录那一下是好的，下一句就变成未登录。
 */
export function cookieSecure(req: Request): boolean {
  return new URL(req.url).protocol === "https:";
}

export function sessionCookie(
  token: string,
  secure: boolean,
  maxAgeSec = SESSION_TTL_SEC,
): string {
  return `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly;${
    secure ? " Secure;" : ""
  } SameSite=Lax; Max-Age=${maxAgeSec}`;
}

export function clearCookie(secure: boolean): string {
  return `${COOKIE_NAME}=; Path=/; HttpOnly;${
    secure ? " Secure;" : ""
  } SameSite=Lax; Max-Age=0`;
}

/** Cookie 优先，其次 `Authorization: Bearer <token>`（便于 curl 验证） */
export function authToken(req: Request): string | null {
  const bearer = req.headers.get("Authorization");
  return (
    readCookie(req) ?? (bearer?.startsWith("Bearer ") ? bearer.slice(7) : null)
  );
}

export async function authRole(req: Request, env: Env): Promise<Role | null> {
  return verifyToken(env, authToken(req));
}

/**
 * 滑动续期：票的剩余寿命不足半程就该换张新的。
 * 活跃的票永远被续着（持续制），30 天完全不露面的票自然死亡——
 * 掉线的从来只有真没来的人。半程而不是临期才续：
 * 一张票一辈子最多被续十几次，而不是天天往响应里塞 Set-Cookie。
 */
export const SESSION_RENEW_LEFT_SEC = SESSION_TTL_SEC / 2;

/** 验过的票剩余寿命不足半程 → 值得顺手续一张。 */
export function tokenNeedsRenewal(
  info: { exp: number },
  now = Date.now(),
): boolean {
  return info.exp - now < SESSION_RENEW_LEFT_SEC * 1000;
}

/** 按旧票的权益重签一张满寿命的新票：role/type/card 原样，exp 重置。 */
export function renewToken(
  env: Env,
  info: { role: Role; type?: string; card?: string },
): Promise<string> {
  return issueToken(env, info.role, SESSION_TTL_SEC, info.type, info.card);
}

/** 主人住的那一间屋子（DO 实例名） */
export const OWNER_AGENT = "default";

/**
 * 场屋名：一个会话一间屋（完整的 CoworkAgent 运行时）。
 * 屋名 = 人屋名 + `--` + 场 id。人屋名（default / guest-十六进制 / 卡房名）都不含 `--`，
 * 场 id 是 base36，所以第一段 `--` 就是分界，解析不会歧义。
 */
export function sessionRoom(room: string, sessionId: string): string {
  return `${room}--${sessionId}`;
}

/**
 * 场屋名里的人屋部分；不是场屋（人屋本尊）时返回 null。
 * 「这间屋归谁管」一律用它判断，别自己做字符串切割 —— 分隔规则改了这里一处兜底。
 */
export function ownerRoomOf(name: string): string | null {
  const i = name.indexOf("--");
  return i === -1 ? null : name.slice(0, i);
}

// 卡房缓存：cardId → 绑定的房间。查卡要走主人房 RPC，每个请求都查一趟太浪费；
// 缓存 60 秒，卡被删后缓存到期自然失效，票就退回派生房（等于变回临时身份）
const cardRoomCache = new Map<string, { room: string; at: number }>();
const CARD_ROOM_TTL_MS = 60_000;

/**
 * 查一张卡绑定的房间。卡不存在 / 主人房没醒时返回 null —— 调用方自己决定退路。
 */
export async function cardRoom(
  env: Env,
  cardId: string,
): Promise<string | null> {
  const hit = cardRoomCache.get(cardId);
  if (hit && Date.now() - hit.at < CARD_ROOM_TTL_MS) return hit.room;
  // 与登录限速同一类问题：模块级 Map 只增不减。过期条目顺手收掉
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
 *
 * 一个 DO 只有一份对话，所以「谁连哪个实例」就等于「谁能看到谁的对话」。
 * 管理员连主人那间；来客每人一间自己的 —— 名字由 token 派生，同一次登录永远是同一间，
 * 换个人就是另一场对话，翻不到主人的内容，也污染不到主人那场。
 *
 * 持卡的长期能外例外：房间不是从票算出来的（票会过期重签，一算就换房），
 * 而是卡上绑定的那间 —— 登卡就是回自己的屋子。查不到卡时退回票派生房，
 * 先把人安顿下，别让一张删掉的卡把人挡在门外。
 *
 * 名字里掺了签名密钥，所以它既稳定又猜不出；但这只是第一层，
 * Worker 入口还会再按角色核一遍地址，防止来客把名字改成 default 直接进门。
 */
export async function agentNameForToken(
  env: Env,
  role: Role,
  token: string | null,
): Promise<string> {
  if (role === "admin") return OWNER_AGENT;
  // 持卡票：回卡绑定的那间屋（票重签、换设备都不变）。卡没了就退回派生房
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
