import { sessionConflictResponse } from "./shared/sessionConflict";
import { fail, readJsonObject } from "./shared/httpInput";
// Worker 入口：鉴权 → 路由 → routeAgentRequest → 静态资源回退。
// Agent 本体在 ./agent/cowork.ts。

import { routeAgentRequest } from "agents";
import {
  adminPassword,
  agentNameFor,
  agentNameForToken,
  authToken,
  authRole,
  clearCookie,
  cookieSecure,
  forbidden,
  gatePassword,
  issueToken,
  renewToken,
  tokenNeedsRenewal,
  OWNER_AGENT,
  roleForPassword,
  sessionCookie,
  unauthorized,
  verifyTokenInfo,
  type Role,
} from "./auth";
import { COMMON_TYPE_ID } from "./agent/userCards";
// 长期权益的四档口径与 DO 的现查同源（guestTypes.ts）：闸与 RPC 两端各写一遍联合类型，
// 漏一项就是「REST 进得去、RPC 被拒」的半开
import type { GuestCardPerm } from "./agent/guestTypes";
import { compareSemver } from "./version";
import {
  handleMatrixApi,
  serveMatrixPage,
  type MatrixViewer,
} from "./matrix/core";

// wrangler.jsonc 的 class_name 需要能从 main 模块解析到 CoworkAgent
export { CoworkAgent } from "./agent/cowork";

import { DEFAULT_BASE_PROMPT } from "./agent/prompt";
import { DEFAULT_RECAP_PROMPT } from "./agent/recap";
// 邮件配置的字段闸：白名单收口在 store 里，路由不自己列可写字段（漏一格就是一格口子）
import { parseMailConfigInput } from "./mail/store";
import { EML_FEED_MAX } from "./mail/mailbox";
import { analyzeUpload, attachBlock } from "./agent/attach";
import {
  FOLDER_KEEP,
  PUBLIC_PREFIX,
  assertInScope,
  canReadFile,
  fileResponseHeaders,
  roomKeyPrefix,
  roomKeyPrefixes,
  safeFolder,
  safeKeyPath,
  scopedKey,
  themePackKey,
} from "./fileAccess";
import {
  referencedAssets,
  type ThemeConfig,
  type ThemeConfigPatch,
} from "./agent/themeConfig";
import {
  packThemePack,
  safeAssetName,
  unpackThemePack,
  type UnpackedThemePack,
} from "./agent/themePack";
// 云盘删/移前的矩阵引用检查：与 agent 的 files 工具共用同一把尺子 ——
// 被矩阵页引用着的云盘文件，走 REST 这条路也不许删/搬，否则页面当场没正文
import { matrixRefGuard } from "./tools/files";
import { fetchOfficialUsage } from "./analytics";
import {
  canSynthesize,
  effectiveVoice,
  invalidateTtsCache,
  synthesize,
  ttsOptions,
} from "./audio/tts";

const MAX_UPLOAD_SIZE = 50 * 1024 * 1024; // 50MB

/**
 * 普通用户可访问的接口：其余 /api/* 一律管理员专属。
 * 反馈类接口按会话共享，所以访客也要能给自己聊过的消息点赞评论；
 * 会话列表和切换要放开 —— 来客也是这个家的朋友，他该有自己的几场对话。
 */
const USER_ROUTES = new Set([
  "/api/health",
  "/api/me",
  "/api/feedback",
  "/api/vote",
  "/api/comment",
  "/api/flag",
  "/api/sessions",
  "/api/sessions/switch",
  // 多端对齐：记「最后看的是哪间屋、哪一场」—— 来客也该有自己的最后一场
  "/api/active-room",
  "/api/memory/public",
  // 公开墙是贴给进门的人看的：读墙放给所有登录角色（贴/摘的门槛在下面按方法判）
  "/api/posts",
  // 留痕是明说的：来客随时能翻自己那间的账
  "/api/visitor-log",
]);

/**
 * 按方法放开的接口（`"POST /api/memory"` 这样写）。
 *
 * 为什么单开一张表：账本上「写」和「读」是两件事 ——
 * 来客可以往上添一笔，却不该能翻整间屋子的记忆。
 * 光按路径放开的话，GET 也会跟着松掉，那就不是「登记」而是「读取」了。
 */
const USER_WRITE_ROUTES = new Set([
  "POST /api/memory",
  "POST /api/think",
  // 进门介绍页的落点：报称呼/来历（都可空、可跳过）
  "POST /api/guest-intro",
]);

/**
 * 这台机器认识哪些「存 key 的 secret」。
 *
 * 配置目录里存的是 secret 的**变量名**，key 本体在 Worker secrets 里；
 * 面板加/改配置时要挑一个变量名，这份名单就是可选项，
 * 同时也是 GET 回显 —— 只回名字、只报「配没配过」，值永远不出去。
 */
const KNOWN_KEY_SECRETS = [
  "API_KEY",
  "SK_MAINTENANCE",
  "MIMO_API_KEY",
  "DOUBAO_TTS_KEY",
  "ZHIPU_KEY",
  "DEEPSEEK_KEY",
  "OPENAI_KEY",
  "ANTHROPIC_KEY",
  "GEMINI_KEY",
  "GLM_KEY",
  "SILICONFLOW_KEY",
  // MiniMax（M Plan）：聊天/语音/绘图三条线共用这一把
  "MINIMAX_KEY",
  // 搜索通道的两把：少了它们，搜索配置面板的下拉里永远列不出自己的 key，
  // 一旦在面板里重选保存，keySecret 就被洗成别家/清空 —— key 明明还在
  // env 里，调度却永远落到免费通道（还悄无声息，查起来最费人）
  "TAVILY_API_KEY",
  "BRAVE_API_KEY",
];

const FAVICON =
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">` +
  `<rect width="64" height="64" rx="14" fill="#1f2329"/>` +
  `<text x="32" y="45" text-anchor="middle" font-family="monospace" ` +
  `font-size="40" fill="#ffffff" font-weight="bold">e</text></svg>`;

function methodNotAllowed(): Response {
  return Response.json({ ok: false, error: "方法不允许" }, { status: 405 });
}

/** 从 /agents/<类名>/<实例名> 里取出实例名；不是这个形状就返回 null（不拦） */
function agentNameInPath(pathname: string): string | null {
  const seg = pathname.split("/").filter(Boolean);
  if (seg[0] !== "agents" || seg.length < 3) return null;
  // 非法百分号编码会让 decodeURIComponent 抛错，把整条请求 500 掉。退回原样段：
  // 它对不上 token 派生的屋名，guard 照样会拒，安全侧不留后门
  try {
    return decodeURIComponent(seg[2]);
  } catch {
    return seg[2];
  }
}

/**
 * 面板传上来的来客工具清单。不是数组就当作没传（老客户端只传三个开关，
 * 由 guestTypes.ts 推平一次）；空数组是「显式全关」，与没传分得开。
 */
function parseToolList(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  return v.filter((x): x is string => typeof x === "string");
}

// ── 登录限速（isolate 内存态，够挡住暴力猜密码） ──────────

const FAIL_LIMIT = 5;
const LOCKOUT_MS = 60_000;
const attempts = new Map<string, { n: number; until: number; at: number }>();

function clientKey(req: Request): string {
  return req.headers.get("CF-Connecting-IP") || "unknown";
}

function isLockedOut(key: string): number {
  const rec = attempts.get(key);
  if (!rec || rec.until <= Date.now()) return 0;
  return Math.ceil((rec.until - Date.now()) / 1000);
}

function noteFailure(key: string): void {
  const now = Date.now();
  // 这张表是 isolate 内存态，只增不减的话，扫一批不同来源 IP 就能把它撑大。
  // 过了阈值顺手收掉「十分钟没再动过、也没在锁定期里」的旧条目 ——
  // 仍在锁定中的那几个（until 未到）原地保留，拦人的效果不受影响
  if (attempts.size > 500)
    for (const [k, v] of attempts)
      if (v.until <= now && now - v.at > LOCKOUT_MS * 10) attempts.delete(k);
  const rec = attempts.get(key) || { n: 0, until: 0, at: 0 };
  rec.n += 1;
  rec.at = now;
  if (rec.n >= FAIL_LIMIT) {
    rec.until = Date.now() + LOCKOUT_MS;
    rec.n = 0;
  }
  attempts.set(key, rec);
}

async function handleLogin(req: Request, env: Env): Promise<Response> {
  // 没配口令时这道门谁都进不去 —— 这是故意的（见 auth.ts），但别让它伪装成
  // 「你密码打错了」：那会把人引去反复试口令，而真正要做的是一条 secret put
  if (!gatePassword(env) && !adminPassword(env))
    return Response.json(
      {
        ok: false,
        error:
          "门禁未配置：先给这个 Worker 设 GATE_PASSWORD（管理员另需 ADMIN_PASSWORD）secret 再部署",
      },
      { status: 503 },
    );
  const key = clientKey(req);
  const locked = isLockedOut(key);
  if (locked) {
    return Response.json(
      { ok: false, error: `尝试过于频繁，请 ${locked} 秒后再试` },
      { status: 429 },
    );
  }

  let pw: unknown;
  try {
    ({ pw } = (await readJsonObject(req)) as { pw?: unknown });
  } catch {
    return Response.json({ ok: false, error: "请求格式错误" }, { status: 400 });
  }

  const role = typeof pw === "string" ? roleForPassword(env, pw) : null;
  // 两个内置口令都没对上时，再试多档来客类型：主人那间记着名册（guest_types），
  // 命中哪一档就签一张带档位 id 的 user 票（token v2，档位参与签名，改不动）。
  // 查询失败（主间没醒、额度用尽）一律按「没这档」处理，走下面统一的失败限流。
  let type: string | undefined;
  if (!role && typeof pw === "string") {
    try {
      const hit = await agentStub(env).verifyGuestType(pw);
      if (hit) type = hit.id;
    } catch {
      // 按「没这档」处理
    }
  }
  if (!role && !type) {
    noteFailure(key);
    return Response.json({ ok: false, error: "密码错误" }, { status: 401 });
  }

  attempts.delete(key);
  const token = await issueToken(env, role ?? "user", undefined, type);
  // 顺带把「这次该连哪间屋子」告诉前端：一个 DO 只有一份对话，
  // 来客必须进自己那间，否则一开门就会看到主人正在聊的内容
  const agent = await agentNameForToken(env, role ?? "user", token);
  return Response.json(
    { ok: true, role: role ?? "user", agent },
    { headers: { "Set-Cookie": sessionCookie(token, cookieSecure(req)) } },
  );
}

/**
 * 登卡：凭「昵称 + 密码」回到卡绑定的那间屋。不需要门禁码 —— 卡本身就是
 * 钥匙，门禁码管「能不能进这栋楼」，卡管「你是哪位、回哪间房」。
 * 限速与门禁同一套：同一个来源连续错 5 次锁 60 秒，防拿名单一个个试密码。
 */
async function handleCardLogin(req: Request, env: Env): Promise<Response> {
  const key = clientKey(req);
  const locked = isLockedOut(key);
  if (locked) {
    return Response.json(
      { ok: false, error: `尝试过于频繁，请 ${locked} 秒后再试` },
      { status: 429 },
    );
  }
  let body: { name?: unknown; password?: unknown };
  try {
    body = (await readJsonObject(req)) as typeof body;
  } catch {
    return Response.json({ ok: false, error: "请求格式错误" }, { status: 400 });
  }
  const name = typeof body.name === "string" ? body.name : "";
  const password = typeof body.password === "string" ? body.password : "";
  let card = null;
  try {
    card = await agentStub(env).verifyCardLogin(name, password);
  } catch {
    // 主人房没醒（额度用尽等）按「没对上」处理，走统一的失败限流
  }
  if (!card) {
    noteFailure(key);
    return Response.json(
      { ok: false, error: "昵称或密码不对" },
      { status: 401 },
    );
  }
  attempts.delete(key);
  const token = await issueToken(env, "user", undefined, card.typeId, card.id);
  const agent = await agentNameForToken(env, "user", token);
  return Response.json(
    { ok: true, role: "user", agent, card },
    { headers: { "Set-Cookie": sessionCookie(token, cookieSecure(req)) } },
  );
}

/**
 * 这张请求背后的长期身份卡有没有某项权益。临时票（无卡）一律没有 ——
 * 长期权益没有持久身份就谈不上「自己的」记事本和云盘。
 * 查询失败（主人房没醒等）按没有算：宁可拒了，也不能把没权限的路由放进来。
 */
async function cardAllows(
  req: Request,
  env: Env,
  perm: GuestCardPerm,
): Promise<boolean> {
  const token = authToken(req);
  const info = await verifyTokenInfo(env, token);
  if (!info || info.role !== "user" || !info.card) return false;
  try {
    return await agentStub(env).cardPerm(info.card, perm);
  } catch {
    return false;
  }
}

// ── R2 文件接口 ────────────────────────────────────────

async function handleUpload(req: Request, env: Env): Promise<Response> {
  try {
    const form = await req.formData();
    const file = form.get("file") as File | null;
    if (!file)
      return Response.json({ ok: false, error: "缺少文件" }, { status: 400 });
    if (file.size > MAX_UPLOAD_SIZE) {
      return Response.json(
        {
          ok: false,
          error: `文件过大，最大 ${MAX_UPLOAD_SIZE / 1024 / 1024}MB`,
        },
        { status: 413 },
      );
    }
    // form 里带了 public=1 就是想放进公开空间：权益不当场说明白，人会以为
    // 「传上去就是公开的」—— 静默降级成私有是最坏的那种欺骗，宁可拒了明说
    const wantPublic = form.get("public") === "1";
    if (wantPublic) {
      const info = await verifyTokenInfo(env, authToken(req));
      const allowed =
        info?.role === "admin" || (await cardAllows(req, env, "permPublic"));
      if (!allowed)
        return Response.json(
          { ok: false, error: "公开权益没开：这一档跟着长期身份的档位走" },
          { status: 403 },
        );
    }
    const folder = wantPublic
      ? "public"
      : safeFolder(String(form.get("folder") ?? ""));
    const key = await uploadKeyFor(req, env, file, wantPublic, folder);
    await env.MEMORY_BUCKET.put(key, file.stream(), {
      httpMetadata: { contentType: file.type || "application/octet-stream" },
    });
    return Response.json({
      ok: true,
      key,
      public: wantPublic,
      name: file.name,
      type: file.type,
      size: file.size,
    });
  } catch (e) {
    return fail(e);
  }
}

/**
 * 这次上传落到哪个 key。管理员传到桶根（原来就这条路，带 folder 就落进
 * 桶根下的那个子目录）；长期使用者（有卡）传进自己房间的前缀 —— R2 是
 * 同一只桶，但他读写都只见自己那间（canReadFile 按前缀划界）。
 * 临时票在路由层就被拦了，走不到这里。
 * 想公开的落 f/public/（权益已在 handleUpload 里核过）：那个前缀谁都能读。
 * folder 已在 handleUpload 里洗过（safeFolder），这里只管拼。
 */
async function uploadKeyFor(
  req: Request,
  env: Env,
  file: File,
  wantPublic: boolean,
  folder = "",
): Promise<string> {
  const raw = file.name || "upload";
  const dot = raw.lastIndexOf(".");
  const base =
    (dot > 0 ? raw.slice(0, dot) : raw)
      .replace(/[/\\?%*:|"<>]/g, "_")
      .slice(0, 60) || "file";
  const ext =
    (dot > 0 ? raw.slice(dot + 1) : "")
      .replace(/[^a-zA-Z0-9]/g, "")
      .slice(0, 8) || "bin";
  // 公开空间不挑身份：管理员和持卡者发的都落同一个前缀（权益已在 handleUpload 核过）
  if (wantPublic) return scopedKey("public", base, ext);
  const info = await verifyTokenInfo(env, authToken(req));
  if (!info || info.role !== "user" || !info.card) {
    const rand = crypto.randomUUID().slice(0, 8);
    return folder
      ? `${folder}/${Date.now()}-${rand}-${raw}`
      : `${Date.now()}-${rand}-${raw}`;
  }
  const room = await agentNameForToken(env, "user", authToken(req));
  return scopedKey(room, base, ext, folder);
}

/**
 * 云盘写操作（建文件夹 / 移动 / 删除）的范围。
 * 管理员整只桶（scope=""，key 从桶根算）；来客凭 permFiles 权益
 * 限自己房间前缀。没票、没卡、没权益都是 null —— 调用方回 403。
 */
async function fileScopeFor(req: Request, env: Env): Promise<string[] | null> {
  const info = await verifyTokenInfo(env, authToken(req));
  if (!info) return null;
  if (info.role === "admin") return [""];
  if (!(await cardAllows(req, env, "permFiles"))) return null;
  const room = await agentNameForToken(env, "user", authToken(req));
  // 人屋本尊 + 他名下的场屋：产物按「当时那间屋」的前缀存，只放人屋前缀的话，
  // 来客在自己场屋里生成的文件列得出来却删不掉
  return roomKeyPrefixes(room);
}

/**
 * 读一份刚传上来的附件，换成一段模型能读的话。
 *
 * 只回数据不落库：附件是「这一轮要说的事」，不是长期资产。
 * 正文跟着消息进对话历史，之后几轮照样看得到 —— 该记的它会自己记进记忆里。
 */
async function handleAttach(req: Request, env: Env): Promise<Response> {
  try {
    const { key, name, native } = (await readJsonObject(req)) as {
      key?: unknown;
      name?: unknown;
      native?: unknown;
    };
    if (typeof key !== "string" || !key)
      return Response.json(
        { ok: false, error: "缺少文件 key" },
        { status: 400 },
      );
    // key 是请求体里随手填的：先按房间划界再碰桶 —— analyzeUpload 会把对象读出来
    // 转成文字/摘录，没这道门的话，知道别家 key 的持卡来客就能把别人的附件读走。
    // 和 handleServe 是同一把尺子；找不到和不让读都回 404，不给试探者反馈
    const role = (await authRole(req, env)) ?? "user";
    const room = await agentNameFor(req, env, role);
    if (!canReadFile(key, role, room))
      return Response.json(
        { ok: false, error: "没有这个文件" },
        { status: 404 },
      );
    const a = await analyzeUpload(
      env,
      key,
      typeof name === "string" ? name : key,
      native === true,
    );
    return Response.json({ ok: true, data: { ...a, block: attachBlock(a) } });
  } catch (e) {
    return fail(e);
  }
}

/**
 * 念一段话。
 *
 * 失败不抛给上层 500：这台机器配不上云端嗓子是很正常的状态（比如本地没配 ZHIPU_KEY），
 * 前端收到 503 就退回浏览器自带音色，用户听到的只是音质差一点，而不是一个红色报错。
 */
async function handleTts(req: Request, env: Env): Promise<Response> {
  try {
    const { text, voice } = (await readJsonObject(req)) as {
      text?: unknown;
      voice?: unknown;
    };
    const say = typeof text === "string" ? text : "";
    if (!say.trim())
      return Response.json(
        { ok: false, error: "没有要念的文字" },
        { status: 400 },
      );

    const out = await synthesize(
      env,
      say,
      typeof voice === "string" ? voice : "",
    );
    if (!out.ok) {
      // 带上 why：只回一句「没可用的云端嗓子」的话，没配 key 和 key 被拒
      // 在界面上完全一样，用户只能一直听到浏览器那个难听的嗓子，却查不到为什么
      return Response.json(
        { ok: false, error: "这台机器没有可用的云端嗓子", why: out.why },
        { status: 503 },
      );
    }
    // 同一句话常被重复念（重听一条消息），但不缓存：音频很小，而缓存键要跟音色绑定，
    // 为这点开销引入一层缓存不划算。
    return new Response(out.bytes, {
      headers: { "Content-Type": out.mime, "Cache-Control": "no-store" },
    });
  } catch (e) {
    return fail(e);
  }
}

async function handleServe(
  env: Env,
  key: string,
  role: Role,
  room: string,
): Promise<Response> {
  try {
    // 地址里的文件名是编码过的（中文名、空格、井号都编过），得先解回云盘里那个原样的 key。
    // 不解的话，「存的时候叫什么、这里就该查什么」对不上，取到的永远是「找不到」——
    // 界面上就是一张破图。解码后仍找不到，再按原样查一次：地址是模型手写的，
    // 也可能它压根没编码。
    let name = key;
    try {
      name = decodeURIComponent(key);
    } catch {
      // 不是合法编码（地址里有半截 % 之类）就按原样查
    }
    // 房间划界：管理员全库可见；来客只读自己那间的。不通过回 404 而不是 403 ——
    // 「没有这个文件」和「有但不许你看」不区分，不给试探者任何反馈
    if (!canReadFile(name, role, room) && !canReadFile(key, role, room))
      return new Response("Not found", { status: 404 });
    const primary = await env.MEMORY_BUCKET.get(name);
    const obj =
      primary || (name === key ? null : await env.MEMORY_BUCKET.get(key));
    if (!obj) return new Response("Not found", { status: 404 });
    const objectKey = primary ? name : key;
    // 对象没带类型时按后缀补一个：浏览器不认类型就不肯把它画成图，会直接当文件下载
    const contentType = obj.httpMetadata?.contentType || guessType(objectKey);
    // 只有公开前缀可以缓存。私有文件必须随每次登录态重新做房间授权。
    // HTML / SVG 等文档另由 fileAccess 压进不透明源。
    return new Response(obj.body, {
      headers: fileResponseHeaders(
        contentType,
        objectKey.startsWith(PUBLIC_PREFIX),
      ),
    });
  } catch {
    return new Response("Error", { status: 500 });
  }
}

/** 云盘对象缺 Content-Type 时的兜底表（图片是这里的全部意义：别的类型本来就会当文件下） */
const IMG_TYPE: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  bmp: "image/bmp",
  svg: "image/svg+xml",
};

function guessType(key: string): string {
  const ext = key.slice(key.lastIndexOf(".") + 1).toLowerCase();
  return IMG_TYPE[ext] || "application/octet-stream";
}

// ── 全局美术主题：读免鉴权（全局可见），写只有管理员（handleApi 总闸）──
//
// 主题素材住在 R2 公开区 f/public/theme/ 下，主题文档里只存 `asset:<文件名>`
// 引用 —— 公开前缀人人读得，正好对上「皮肤不受身份限制地全局可见」。
// 图片/动图都当静态字节下发，动图（gif）浏览器自己会动，不用任何特判。

/** 主题素材的 R2 前缀 */
const THEME_ASSET_PREFIX = `${PUBLIC_PREFIX}theme/`;

function themeAssetKey(name: string): string {
  return THEME_ASSET_PREFIX + safeAssetName(name);
}

/** 读主题：门口/Gate 未登录也要拿得到皮肤，这条不进鉴权闸 */
async function handleThemeGet(env: Env): Promise<Response> {
  try {
    return Response.json({ ok: true, theme: await agentStub(env).getTheme() });
  } catch (e) {
    return fail(e);
  }
}

/** 主题素材本体（图片/动图）：免鉴权下发，公开缓存 */
async function handleThemeAsset(
  env: Env,
  rawName: string,
): Promise<Response> {
  let name: string;
  try {
    name = themeAssetKey(rawName);
  } catch {
    return new Response("Not found", { status: 404 });
  }
  const obj = await env.MEMORY_BUCKET.get(name);
  if (!obj) return new Response("Not found", { status: 404 });
  const contentType = obj.httpMetadata?.contentType || guessType(name);
  return new Response(obj.body, {
    headers: fileResponseHeaders(contentType, true),
  });
}

/**
 * 传一份主题素材（图片/动图）进公开区。文件名就是主题里的引用名（asset:<文件名>），
 * 同名重传 = 换图。只收原始字节（body 就是文件本体，?name= 给文件名）——
 * 主题素材没有「半个文件」的中间态，multipart 在这里纯属绕路。
 */
async function handleThemeAssetUpload(
  req: Request,
  env: Env,
): Promise<Response> {
  try {
    const rawName = new URL(req.url).searchParams.get("name") || "";
    if (!rawName)
      return Response.json(
        { ok: false, error: "缺少文件名（?name=…）" },
        { status: 400 },
      );
    const key = themeAssetKey(rawName);
    const bytes = await req.arrayBuffer();
    if (!bytes.byteLength)
      return Response.json(
        { ok: false, error: "缺少文件内容" },
        { status: 400 },
      );
    if (bytes.byteLength > MAX_UPLOAD_SIZE)
      return Response.json(
        { ok: false, error: `文件过大，最大 ${MAX_UPLOAD_SIZE / 1024 / 1024}MB` },
        { status: 413 },
      );
    await env.MEMORY_BUCKET.put(key, bytes, {
      httpMetadata: { contentType: guessType(key) },
    });
    return Response.json({
      ok: true,
      ref: `asset:${key.slice(THEME_ASSET_PREFIX.length)}`,
      size: bytes.byteLength,
    });
  } catch (e) {
    return fail(e);
  }
}

/**
 * 来源 key → 稳定短哈希。撞名时拼进别名用：同一条云盘文件反复导入
 * 永远算出同一个名字，不会越导越长。
 */
function sourceHash(key: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36).slice(0, 6);
}

/**
 * 从云盘导一份图进主题公开区。云盘文件可能是私有的（来客读不到），而主题要
 * 免鉴权全局可见 —— 所以导入是「复制一份进 f/public/theme/」，主题里存的还是
 * asset: 引用，绝不把私有云盘 key 直接写进公开的皮肤里（那是把私房照挂上墙）。
 * 文件名以云盘原名为准；和已有素材撞名且来路不同时换一个按来源 key 算的稳定别名，
 * 免得导入悄悄换掉主题里别处正在用的另一张图。
 */
async function handleThemeImport(req: Request, env: Env): Promise<Response> {
  try {
    const body = (await readJsonObject(req)) as Record<string, unknown>;
    const key = typeof body.key === "string" ? body.key : "";
    if (!key)
      return Response.json(
        { ok: false, error: "缺少云盘文件（key）" },
        { status: 400 },
      );
    const src = await env.MEMORY_BUCKET.get(key);
    if (!src)
      return Response.json(
        { ok: false, error: "云盘里没有这个文件" },
        { status: 404 },
      );
    if (src.size > MAX_UPLOAD_SIZE)
      return Response.json(
        {
          ok: false,
          error: `文件过大，最大 ${MAX_UPLOAD_SIZE / 1024 / 1024}MB`,
        },
        { status: 413 },
      );
    let name = safeAssetName(key);
    const clash = await env.MEMORY_BUCKET.get(themeAssetKey(name));
    if (clash && clash.customMetadata?.sourceKey !== key) {
      const dot = name.lastIndexOf(".");
      name = `${dot > 0 ? name.slice(0, dot) : name}-${sourceHash(key)}${
        dot > 0 ? name.slice(dot) : ""
      }`;
    }
    const target = themeAssetKey(name);
    await env.MEMORY_BUCKET.put(target, src.body, {
      httpMetadata: {
        contentType: src.httpMetadata?.contentType || guessType(target),
      },
      // 记下来路：再导同一条云盘文件就地换图，不另起名字
      customMetadata: { sourceKey: key },
    });
    return Response.json({
      ok: true,
      ref: `asset:${target.slice(THEME_ASSET_PREFIX.length)}`,
      size: src.size,
    });
  } catch (e) {
    return fail(e);
  }
}

/**
 * 装一份已经解开的包：素材进公开区 → 整份替换主题。
 * 「上传装备」和「换回自定义存档」两条路共用这一把刀 —— 收口都在 unpackThemePack。
 */
async function applyUnpackedTheme(
  pack: UnpackedThemePack,
  env: Env,
): Promise<ThemeConfig> {
  for (const [name, data] of pack.assets) {
    await env.MEMORY_BUCKET.put(themeAssetKey(name), data, {
      httpMetadata: { contentType: guessType(name) },
    });
  }
  return agentStub(env).replaceTheme(pack.theme);
}

/**
 * 装备主题包：解 zip（theme.json 清单 + assets/ 素材）→ 素材进公开区 →
 * 整份替换主题。清单收口在 unpackThemePack（不许路径穿越、引用悬空当场报），
 * 落库前再过 normalizeTheme 收口 —— 包里带什么花活，进库的都是全形状主题。
 * 包本体不丢：解包通过就留一份进云盘的 betpag 文件夹，回头能翻、能再传。
 */
async function handleThemePackEquip(
  req: Request,
  env: Env,
): Promise<Response> {
  try {
    const bytes = new Uint8Array(await req.arrayBuffer());
    if (!bytes.byteLength)
      return Response.json(
        { ok: false, error: "缺少压缩包" },
        { status: 400 },
      );
    if (bytes.byteLength > MAX_UPLOAD_SIZE)
      return Response.json(
        { ok: false, error: `包体过大，最大 ${MAX_UPLOAD_SIZE / 1024 / 1024}MB` },
        { status: 413 },
      );
    const pack = unpackThemePack(bytes);
    // 解包过关才算正经包：坏包不进档案，betpag 里住的都是装得上的
    const driveKey = themePackKey(
      new URL(req.url).searchParams.get("name") || "",
    );
    await env.MEMORY_BUCKET.put(driveKey, bytes, {
      httpMetadata: { contentType: "application/zip" },
    });
    return Response.json({
      ok: true,
      theme: await applyUnpackedTheme(pack, env),
      driveKey,
      // 前端拿它显示「装了 N 个素材」，缺了就是一行 undefined
      assets: pack.assets.size,
    });
  } catch (e) {
    return fail(e);
  }
}

/** 打包当前主题（清单 + 它引用的素材）成 zip 字节。存档与导出共用 */
async function packCurrentTheme(env: Env): Promise<Uint8Array> {
  const theme = await agentStub(env).getTheme();
  const assets = new Map<string, Uint8Array>();
  for (const name of referencedAssets(theme)) {
    const obj = await env.MEMORY_BUCKET.get(themeAssetKey(name));
    if (obj) assets.set(name, new Uint8Array(await obj.arrayBuffer()));
  }
  return packThemePack(theme, assets);
}

/** 自定义主题存档：列全部 */
async function handleThemeSetsList(env: Env): Promise<Response> {
  try {
    return Response.json({ ok: true, sets: await agentStub(env).listThemeSets() });
  } catch (e) {
    return fail(e);
  }
}

/**
 * 把当前主题存成一份带名字的档：打包 → 落云盘 betpag → 记一行。
 * 包体自包含素材，所以哪怕后来素材被换被删，这份档翻出来照样装得上。
 */
async function handleThemeSetSave(req: Request, env: Env): Promise<Response> {
  try {
    const body = (await readJsonObject(req)) as Record<string, unknown>;
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name)
      return Response.json(
        { ok: false, error: "先给这套配置起个名字" },
        { status: 400 },
      );
    const zip = await packCurrentTheme(env);
    // 包底按「名字 + 一串随机码」落盘：同名的档可以存好几份（改完外观再存一次
    // 是常态），若只按名字拼 key，后存的那份会静静顶掉前一份的包体 ——
    // 两份档指同一份底，换装拿到的是别人的内容、删掉一份另一份也废了。
    const packKey = themePackKey(
      `${name.slice(0, 40)}-${crypto.randomUUID().slice(0, 8)}`,
    );
    await env.MEMORY_BUCKET.put(packKey, zip, {
      httpMetadata: { contentType: "application/zip" },
    });
    // 包体先落云盘、再记账；记账这一关可能过不去（名额满了、名字不合法），
    // 那就把刚落下的包体收回来 —— 一份包五六个 MB，留在盘里没人认领
    const set = await agentStub(env)
      .addThemeSet({ name, packKey, bytes: zip.byteLength })
      .catch(async (e: unknown) => {
        await env.MEMORY_BUCKET.delete(packKey);
        throw e;
      });
    return Response.json({
      ok: true,
      set,
      sets: await agentStub(env).listThemeSets(),
    });
  } catch (e) {
    return fail(e);
  }
}

/** 换回某份存档：读回包体、解包、装上去 —— 和装备主题包同一条路 */
async function handleThemeSetApply(req: Request, env: Env): Promise<Response> {
  try {
    const body = (await readJsonObject(req)) as Record<string, unknown>;
    const id = typeof body.id === "string" ? body.id : "";
    if (!id)
      return Response.json({ ok: false, error: "缺少存档 id" }, { status: 400 });
    const set = await agentStub(env).getThemeSet(id);
    if (!set)
      return Response.json(
        { ok: false, error: "这份存档不在了" },
        { status: 404 },
      );
    const obj = await env.MEMORY_BUCKET.get(set.packKey);
    if (!obj)
      return Response.json(
        { ok: false, error: "存档的包体在云盘里找不到了" },
        { status: 404 },
      );
    const pack = unpackThemePack(new Uint8Array(await obj.arrayBuffer()));
    return Response.json({
      ok: true,
      theme: await applyUnpackedTheme(pack, env),
      assets: pack.assets.size,
      set,
    });
  } catch (e) {
    return fail(e);
  }
}

/** 删一份存档：连它在云盘里的包体一并清走（那份底只属于这份档） */
async function handleThemeSetDelete(req: Request, env: Env): Promise<Response> {
  try {
    const body = (await readJsonObject(req)) as Record<string, unknown>;
    const id = typeof body.id === "string" ? body.id : "";
    if (!id)
      return Response.json({ ok: false, error: "缺少存档 id" }, { status: 400 });
    const removed = await agentStub(env).removeThemeSet(id);
    if (!removed)
      return Response.json(
        { ok: false, error: "这份存档不在了" },
        { status: 404 },
      );
    await env.MEMORY_BUCKET.delete(removed.packKey);
    return Response.json({
      ok: true,
      sets: await agentStub(env).listThemeSets(),
    });
  } catch (e) {
    return fail(e);
  }
}

/** 导出主题包：当前主题 + 它引用的素材打成 zip，存下来就是一份能再装备的包 */
async function handleThemePackExport(env: Env): Promise<Response> {
  try {
    const zip = await packCurrentTheme(env);
    return new Response(zip, {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": 'attachment; filename="ericher-theme.zip"',
        "Cache-Control": "private, no-store",
      },
    });
  } catch (e) {
    return fail(e);
  }
}

/** R2 对象 → 前端文件行。树形是前端按 key 路径自己拼的，这里只给原料 */
function toFileRow(o: R2Object): {
  key: string;
  size: number;
  uploaded: Date;
} {
  return { key: o.key, size: o.size, uploaded: o.uploaded };
}

/**
 * 翻页把清单取全。单次 list 只回 500 条，不跟 cursor 的话超出的文件在
 * 云盘树里无声无息地消失；但也不能无节制地翻 —— 超大桶会把一次请求拖死，
 * 翻满 LIST_MAX_PAGES 还没完就停，把 truncated 交给调用方在返回里明说。
 */
const LIST_MAX_PAGES = 20;

async function listAll(
  bucket: R2Bucket,
  opts: { prefix?: string },
): Promise<{ objects: R2Object[]; truncated: boolean }> {
  const objects: R2Object[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < LIST_MAX_PAGES; page++) {
    const list = await bucket.list({ prefix: opts.prefix, cursor, limit: 500 });
    objects.push(...list.objects);
    if (!list.truncated) return { objects, truncated: false };
    cursor = list.cursor;
  }
  return { objects, truncated: true };
}

/**
 * 云盘清单。管理员看整只桶；来客看自己那间 + 公开空间（读得到的地方
 * 才列得出来，和 canReadFile 同一把尺子）。文件夹是 key 里的路径，
 * 这里不整理 —— 列表的形状交给前端拼树。
 */
async function handleList(req: Request, env: Env): Promise<Response> {
  try {
    const bucket = env.MEMORY_BUCKET;
    if (!bucket)
      return Response.json({ ok: false, error: "云盘未配置" }, { status: 500 });
    const role = (await authRole(req, env)) ?? "user";
    if (role === "admin") {
      const all = await listAll(bucket, {});
      return Response.json({
        files: all.objects.map(toFileRow),
        count: all.objects.length,
        scope: "",
        truncated: all.truncated,
      });
    }
    const room = await agentNameFor(req, env, role);
    // 自己那间的：人屋本尊 + 他名下各场屋的产物（场屋 key 前缀是「人屋--场id」）
    const [own, pub] = await Promise.all([
      Promise.all(
        roomKeyPrefixes(room).map((prefix) => listAll(bucket, { prefix })),
      ),
      listAll(bucket, { prefix: PUBLIC_PREFIX }),
    ]);
    const objects = [...own.flatMap((r) => r.objects), ...pub.objects];
    return Response.json({
      files: objects.map(toFileRow),
      count: objects.length,
      scope: roomKeyPrefix(room),
      truncated: own.some((r) => r.truncated) || pub.truncated,
    });
  } catch (e) {
    return fail(e);
  }
}

/** 新建文件夹：塞一个 .keep 占位对象，前缀就算「存在」了 */
async function handleMkdir(req: Request, env: Env): Promise<Response> {
  try {
    const bucket = env.MEMORY_BUCKET;
    if (!bucket)
      return Response.json({ ok: false, error: "云盘未配置" }, { status: 500 });
    const scope = await fileScopeFor(req, env);
    if (scope === null) return forbidden();
    const { path } = (await readJsonObject(req)) as { path?: unknown };
    const base = safeKeyPath(String(path ?? ""));
    assertInScope(base, scope);
    const key = `${base}/${FOLDER_KEEP}`;
    await bucket.put(key, "", {
      httpMetadata: { contentType: "application/x-empty" },
    });
    return Response.json({ ok: true, key });
  } catch (e) {
    return fail(e);
  }
}

/**
 * 删/移主题素材前对照当前主题的引用。主题文档里存的是 `asset:<文件名>`，
 * 素材一没了引用就悬空，导出主题包会永久报错 —— 那不是「回头再补」能救的。
 * 命中就回 409，让用户先在主题面板里换掉引用再动文件。
 * 只有要动的 key 真落在主题素材前缀下才去 getTheme：它走 DO 往返，
 * 日常云盘删改不该替主题检查买单。
 */
async function themeRefGuard(
  env: Env,
  keys: string[],
  action: string,
): Promise<Response | null> {
  const names = keys
    .filter((k) => k.startsWith(THEME_ASSET_PREFIX))
    .map((k) => k.slice(THEME_ASSET_PREFIX.length));
  if (!names.length) return null;
  const used = new Set(referencedAssets(await agentStub(env).getTheme()));
  const hits = names.filter((n) => used.has(n));
  if (!hits.length) return null;
  return Response.json(
    {
      ok: false,
      error: `主题正在引用：${hits.join("、")} —— 先在主题面板里换掉，再来${action}。`,
    },
    { status: 409 },
  );
}

/**
 * 移动 / 重命名：from 精确命中一个对象就搬一个；没命中就当前缀，
 * 把整个「文件夹」逐个 copy+delete 搬过去。R2 没有原生 move，
 * 搬就是「复制到新 key、删掉旧 key」。
 */
async function handleMove(req: Request, env: Env): Promise<Response> {
  try {
    const bucket = env.MEMORY_BUCKET;
    if (!bucket)
      return Response.json({ ok: false, error: "云盘未配置" }, { status: 500 });
    const scope = await fileScopeFor(req, env);
    if (scope === null) return forbidden();
    const { from, to } = (await readJsonObject(req)) as { from?: unknown; to?: unknown };
    let src = "";
    let dst = "";
    try {
      src = safeKeyPath(String(from ?? ""));
      dst = safeKeyPath(String(to ?? ""));
      assertInScope(src, scope);
      assertInScope(dst, scope);
    } catch (e) {
      return Response.json(
        { ok: false, error: (e as Error).message },
        { status: 400 },
      );
    }
    if (src === dst)
      return Response.json(
        { ok: false, error: "原地不动，不用搬" },
        { status: 400 },
      );
    // 搬进自己的子目录会把自己套进去：搬完这批，下一批列到的是刚搬出来的副本
    if (dst.startsWith(`${src}/`))
      return Response.json(
        { ok: false, error: "不能把文件夹搬进它自己里面" },
        { status: 400 },
      );
    const obj = await bucket.get(src);
    if (obj) {
      // 被主题引用着的素材不许搬：搬走引用就悬空，导出永久报错
      const guard = await themeRefGuard(env, [src], "搬");
      if (guard) return guard;
      // 被矩阵页引用着的文件同样不许搬：搬走那一页就读不到正文了
      const mxRef = await matrixRefGuard(bucket, [src], "搬");
      if (mxRef) return Response.json({ ok: false, error: mxRef }, { status: 409 });
      // 撞名就地换掉目标是不可恢复的（源也跟着删了）—— 先拦下来让人改名
      if (await bucket.head(dst))
        return Response.json(
          { ok: false, error: `目标已存在：${dst}（换个名字或先删旧的）` },
          { status: 409 },
        );
      await bucket.put(dst, obj.body, {
        httpMetadata: obj.httpMetadata,
        // customMetadata（主题导入记的 sourceKey 来路）要跟着走：move 是 copy+delete，
        // 不捎上就被剥掉，导入去重会把同一条云盘文件当成两个来路
        customMetadata: obj.customMetadata,
      });
      await bucket.delete(src);
      return Response.json({ ok: true, moved: 1 });
    }
    const srcPrefix = `${src}/`;
    // 先把整夹的 key 攒齐、逐个过主题引用检查，再动手 ——
    // 边列边搬的话撞到引用中途停手，就剩半个文件夹散在外头
    const keys: string[] = [];
    let cursor: string | undefined;
    do {
      const list = await bucket.list({ prefix: srcPrefix, cursor, limit: 500 });
      keys.push(...list.objects.map((o) => o.key));
      cursor = list.truncated ? list.cursor : undefined;
    } while (cursor);
    const guard = await themeRefGuard(env, keys, "搬");
    if (guard) return guard;
    const mxRef = await matrixRefGuard(bucket, keys, "搬");
    if (mxRef) return Response.json({ ok: false, error: mxRef }, { status: 409 });
    let moved = 0;
    for (const key of keys) {
      const one = await bucket.get(key);
      if (!one) continue;
      await bucket.put(`${dst}/${key.slice(srcPrefix.length)}`, one.body, {
        httpMetadata: one.httpMetadata,
        customMetadata: one.customMetadata,
      });
      await bucket.delete(key);
      moved++;
    }
    // 子文件撞名不做逐个 head 预检：上传的文件名都带「时间戳-随机段」，基本撞不上；
    // 真撞上的只有 .keep 占位（空壳，覆盖无损失）—— 为它把往返翻倍不值当
    if (!moved)
      return Response.json(
        { ok: false, error: `没有这个文件或文件夹：${src}` },
        { status: 404 },
      );
    return Response.json({ ok: true, moved });
  } catch (e) {
    return fail(e);
  }
}

/**
 * 删除：给 key 删单个对象，给 folder 清整个前缀。范围照 fileScopeFor 划 ——
 * 管理员整只桶，来客只动得了自己那间；删公开空间的东西不在任何人的「自己那间」里。
 */
async function handleDelete(req: Request, env: Env): Promise<Response> {
  try {
    const bucket = env.MEMORY_BUCKET;
    if (!bucket)
      return Response.json({ ok: false, error: "云盘未配置" }, { status: 500 });
    const scope = await fileScopeFor(req, env);
    if (scope === null) return forbidden();
    const body = (await readJsonObject(req)) as { key?: unknown; folder?: unknown };
    if (typeof body.folder === "string" && body.folder.trim()) {
      const base = safeKeyPath(body.folder);
      assertInScope(base, scope);
      const prefix = base.endsWith("/") ? base : `${base}/`;
      // 先列全、逐个过主题引用检查，再删 —— 边列边删撞到引用中途停手，
      // 就剩半个文件夹的残骸
      const keys: string[] = [];
      let cursor: string | undefined;
      do {
        const list = await bucket.list({ prefix, cursor, limit: 500 });
        keys.push(...list.objects.map((o) => o.key));
        cursor = list.truncated ? list.cursor : undefined;
      } while (cursor);
      const guard = await themeRefGuard(env, keys, "删");
      if (guard) return guard;
      const mxRef = await matrixRefGuard(bucket, keys, "删");
      if (mxRef)
        return Response.json({ ok: false, error: mxRef }, { status: 409 });
      for (const key of keys) await bucket.delete(key);
      return Response.json({ ok: true, deleted: keys.length });
    }
    if (typeof body.key !== "string" || !body.key.trim())
      return Response.json(
        { ok: false, error: "缺少 key 或 folder" },
        { status: 400 },
      );
    // 老 key（前缀约定之前传的）里可能带着 ?*"<> 这类字符，过不了段校验 ——
    // 单删退回原样字串，划界（assertInScope）照做，来客照样出不了自己那间
    let key = body.key.trim();
    try {
      key = safeKeyPath(key);
    } catch {
      // 过不了校验的老名字按原样删，范围检查在下面兜底
    }
    assertInScope(key, scope);
    // 被主题引用着的素材不许删：删了引用就悬空，导出永久报错
    const guard = await themeRefGuard(env, [key], "删");
    if (guard) return guard;
    // 被矩阵页引用着的文件同样不许删：删了那一页当场没正文
    const mxRef = await matrixRefGuard(bucket, [key], "删");
    if (mxRef) return Response.json({ ok: false, error: mxRef }, { status: 409 });
    await bucket.delete(key);
    return Response.json({ ok: true });
  } catch (e) {
    return fail(e);
  }
}

// ── 受鉴权保护的 API ───────────────────────────────────

function agentStub(env: Env, name = OWNER_AGENT) {
  return env.COWORK_AGENT.get(env.COWORK_AGENT.idFromName(name));
}

/** 列表类接口都收 ?limit=：越界只当没看见（默认 50、封顶 200），界面上少几行不致命 */
function mailLimit(url: URL): number {
  const n = Number(url.searchParams.get("limit"));
  return Number.isFinite(n) && n > 0 ? Math.min(Math.trunc(n), 200) : 50;
}

/** 「喂一封」这一口的体积闸，按字符数算（DO 那边还有一道按字节的） */

/**
 * 滑动续期：这次请求带的票剩余寿命不足半程，就在响应上顺手挂一张满寿命的新票。
 * 验签不过的票到不了能续的地方（伪造票借不了道）；权益核验照旧走各路由的现查
 * —— 续期只换寿命，不动任何权益面。不是每请求都发：半程闸让一张票
 * 最多每 15 天被续一次。WebSocket 握手不走这里，前端页面加载与面板操作的
 * REST 流量足以撑住活跃用户的续期节奏。
 */
async function renewIfNeeded(
  req: Request,
  env: Env,
  res: Response,
): Promise<Response> {
  const info = await verifyTokenInfo(env, authToken(req));
  if (!info || !tokenNeedsRenewal(info)) return res;
  const fresh = await renewToken(env, info);
  const headers = new Headers(res.headers);
  headers.append("Set-Cookie", sessionCookie(fresh, cookieSecure(req)));
  return new Response(res.body, { status: res.status, headers });
}

/**
 * 首段属于主包自己的路径：矩阵不认领这些，照旧交给应用 / 静态资源。
 *
 * api（接口）、agents（智能体运行时）、assets（前端产物）、index（首页文件）
 * 是保留字；assistant 是接待台本体的固定落点 —— 公开访客访问 `/` 会被 302 到
 * 入口页，总得有个地方能走回助手与登录门，外挂层的「回助手」就指向它。
 * 带「.」的首段（favicon.ico、logo.png 之类）也当静态文件放行。
 * 其余路径（含根 `/`）交给矩阵先认领，认领不了（返回 null）再回落应用。
 */
function isReservedPath(pathname: string): boolean {
  const first = pathname.split("/")[1] ?? "";
  if (!first) return false;
  return first.includes(".") || RESERVED_MATRIX_FIRST.has(first);
}
const RESERVED_MATRIX_FIRST = new Set([
  "api",
  "agents",
  "assets",
  "index",
  "assistant",
]);

/** 当前请求的矩阵访客身份：没带票就是过路人（public） */
async function matrixViewerOf(
  req: Request,
  env: Env,
): Promise<MatrixViewer> {
  const info = await verifyTokenInfo(env, authToken(req));
  if (!info) return { role: "public" };
  return { role: info.role, type: info.type, card: info.card };
}

/** 矩阵包推送：Authorization: Bearer <MATRIX_PUSH_TOKEN>（常量时间比较） */
function matrixPushAllowed(req: Request, env: Env): boolean {
  const token = (env.MATRIX_PUSH_TOKEN || "").trim();
  if (!token) return false;
  const got = (req.headers.get("authorization") || "").trim();
  const expected = `Bearer ${token}`;
  if (got.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < got.length; i++)
    diff |= got.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

async function handleApi(
  req: Request,
  env: Env,
  url: URL,
  role: Role,
): Promise<Response> {
  const p = url.pathname;
  const m = req.method;

  if (p === "/api/me")
    return Response.json({
      ok: true,
      role,
      agent: await agentNameFor(req, env, role),
    });

  // 普通用户只能看健康状态、自己的会话和公开账本，其余管理接口一律拒绝。
  // 例外：文件读取（/api/files/<key>）对所有登录角色放行 —— 读哪个 key 的
  // 房间划界在 handleServe 里做，这里放的是「来客要看得见自己那间画的图」。
  //
  // 长期使用者的权益接线（身份卡 + 档位权益，缺一不可）：
  // - 记事本整组 /api/notes*：agentStub 按票寻址，落在他自己那间的 SQLite；
  // - 云盘上传 /api/upload、/api/attach：key 划进自己房间前缀（见 uploadKeyFor）。
  // 临时票没有卡，cardAllows 一律 false —— 长期权益没有持久身份谈不上「自己的」。
  const permNotes =
    p.startsWith("/api/notes") && (await cardAllows(req, env, "permNotes"));
  const permFiles =
    m === "POST" &&
    (p === "/api/upload" || p === "/api/attach") &&
    (await cardAllows(req, env, "permFiles"));
  // 云盘文件管理（列表 / 建文件夹 / 移动 / 删除）：同一把 permFiles 权益。
  // 管理员天生放行（上面 role !== "admin" 拦不到他）；来客范围在
  // fileScopeFor 里再划一道 —— 放行的是「进来」，动的范围仍限自己那间
  const fileMgr =
    (p === "/api/files" && m === "GET") ||
    (m === "POST" &&
      (p === "/api/files/mkdir" ||
        p === "/api/files/move" ||
        p === "/api/delete"));
  const permFileMgr = fileMgr && (await cardAllows(req, env, "permFiles"));
  // 公开墙：贴一条要 permPublic 权益；摘自己贴的只要卡还在 ——
  // 收回自己说过的话不该被档位卡住，挡的从来是往墙上贴
  const wallPost =
    p === "/api/posts" &&
    m === "POST" &&
    (await cardAllows(req, env, "permPublic"));
  const wallUnpost =
    p === "/api/posts" &&
    m === "DELETE" &&
    !!(await verifyTokenInfo(env, authToken(req)))?.card;
  // 网页矩阵的管理面：这一档是整面一起给的（页面、连线、外观、外站认定表、
  // 打包/装备），不做子权限分化，所以闸也只有一道 —— 持卡 + 这一档开了 permMatrix。
  // 矩阵页的公开读那条路不在这里（走 serveMatrixPage），本来对外公开，不动它。
  const permMatrix =
    p.startsWith("/api/matrix/") && (await cardAllows(req, env, "permMatrix"));
  if (
    role !== "admin" &&
    !(p.startsWith("/api/files/") && m === "GET") &&
    !permNotes &&
    !permFiles &&
    !permFileMgr &&
    !wallPost &&
    !wallUnpost &&
    !permMatrix &&
    !USER_ROUTES.has(p) &&
    !USER_WRITE_ROUTES.has(`${m} ${p}`)
  )
    return forbidden();

  if (p === "/api/health") {
    let ds = "err";
    try {
      env.COWORK_AGENT.get(env.COWORK_AGENT.idFromName("default"));
      ds = "ok";
    } catch {
      // DO 绑定不可用
    }
    return Response.json({
      ok: true,
      do: ds,
      hasKey: !!env.API_KEY,
      hasEndpoint: !!env.API_ENDPOINT,
      hasR2: !!env.MEMORY_BUCKET,
      hasTavily: !!env.TAVILY_API_KEY,
      hasVision: !!env.ZHIPU_KEY,
      hasVoice: await canSynthesize(env),
      hasMimoVoice: !!env.MIMO_API_KEY,
      hasDoubaoVoice: !!env.DOUBAO_TTS_KEY,
    });
  }

  // 网页矩阵的管理面（页面增删改、正文读写）：能走到这里的有两种人 ——
  // 管理员，和档位发了「权限矩阵」长期权益的持卡来客（上面那道闸放的就是他们）。
  // 身份一律从会话派生，不再写死 admin：写死就等于让来客拿管理员的名义记账。
  if (p.startsWith("/api/matrix/"))
    return handleMatrixApi(req, env, p, {
      ...(await matrixViewerOf(req, env)),
      matrix: role === "admin" || permMatrix,
    });

  if (p === "/api/upload" && m === "POST") return handleUpload(req, env);
  // 附件分析：先把文件传上来（/api/upload），再拿 key 来换一段模型能读的话。
  // 分两步而不是一次 multipart 传完就分析，是为了让前端能先把文件传完、
  // 让「正在读」的转圈立刻出现 —— 读一份 PDF 要好几秒，那几秒界面不能是死的。
  if (p === "/api/attach" && m === "POST") return handleAttach(req, env);
  // 文件读取对所有登录角色放行（来客要看得见自己那间画的图），
  // 但读哪个 key 由 handleServe 按房间划界 —— 放行的是「读自己的」，不是「读全部」
  const fileRead = p.startsWith("/api/files/") && m === "GET";
  if (p === "/api/files" && m === "GET") return handleList(req, env);
  if (p === "/api/files/mkdir" && m === "POST") return handleMkdir(req, env);
  if (p === "/api/files/move" && m === "POST") return handleMove(req, env);
  if (fileRead)
    return handleServe(
      env,
      p.slice("/api/files/".length),
      role,
      await agentNameFor(req, env, role),
    );
  if (p === "/api/delete" && m === "POST") return handleDelete(req, env);

  // 朗读：这台机器上有哪些嗓子可用（tts_configs，走主人那间）。只回列表不读 state ——
  // 「当前选了哪副」在 state 里，前端连上时本来就拿到了，不必再问一次。
  if (p === "/api/voices" && m === "GET") {
    const voices = await ttsOptions(env);
    return Response.json({
      ok: true,
      data: {
        voices,
        cloud: await canSynthesize(env),
        // 「没选」时实际会用的是哪一副。不带这个，设置页就会摆一列没人认领的选项
        defaultVoice: await effectiveVoice(env, ""),
      },
    });
  }
  // 朗读：把一段话念成音频。前端按句切好逐句来取，所以这里只管一段。
  if (p === "/api/tts" && m === "POST") return handleTts(req, env);

  // 这一串接口都落在「说话的人自己那间屋子」上：管理员是主人那间，
  // 来客是 token 派生的那间。以前这里固定写死 default，来客点会话列表
  // 拿到的是主人家的东西 —— 现在他看的是自己的几场对话。
  const base = await agentNameFor(req, env, role);
  const agent = agentStub(env, base);
  const readState = async <T>(p: Promise<T>): Promise<Response> => {
    try {
      return Response.json({ ok: true, data: await p });
    } catch (e) {
      return fail(e);
    }
  };
  const writeState = async <T>(p: Promise<T> | T): Promise<Response> =>
    readState(Promise.resolve(p));

  // 「点名的屋」核验：多场并行后前端会点名某间场屋（人屋--场id）来打 REST，
  // 比如 /api/think、/api/stop 要打的是连接正挂着的那间，不是人屋。
  // 只放行本人名下的屋 —— 前缀派生不可伪造，冒用别人的前缀只能给自己开野场，
  // 进不了别人的屋。和 /agents 守卫（routeAgentRequest 的 guard）同一把尺。
  // 没点名 / 点得不对就落回人屋：老客户端不带你玩也不出错
  const targetRoom = (room: unknown): string =>
    typeof room === "string" && (room === base || room.startsWith(base + "--"))
      ? room
      : base;

  // 面板与功能留痕：来客动过哪个接口就记一笔（介绍页里明说过的那份账）。
  // 记完就忘：留痕失败不该拖住请求本身，更不该把它记到主人头上（logVisitor 内部判房间）。
  if (role !== "admin")
    Promise.resolve(agent.logVisitor("panel", `${m} ${p}`)).catch(() => {});

  // ── 来客行为档案 ─────────────────────────────────────────
  // 来客翻自己的账（介绍页承诺的「随时能看」）；
  // 名册和某位来客的明细只归管理员（不在 USER_ROUTES 里，上面已经拦了）。
  if (p === "/api/visitor-log" && m === "GET")
    return readState(agent.visitorEvents());
  if (p === "/api/guest-intro" && m === "POST") {
    const body = (await readJsonObject(req)) as {
      nickname?: string;
      origin?: string;
    };
    // 来历要进账本（addGuestEntry），type 段同样得带过去核权益
    const info = await verifyTokenInfo(env, authToken(req));
    return writeState(agent.guestIntro({ ...body, typeId: info?.type }));
  }
  if (p === "/api/visitors" && m === "GET")
    return readState(agent.visitorRooms());
  if (p === "/api/visitors/events" && m === "GET")
    return readState(agent.visitorEventsOf(url.searchParams.get("room") || ""));

  // 持卡人名册：只归管理员（不在 USER_ROUTES，user 在上面已经拦了）。
  // 名册归主人那间的台子配置，和来客名册不是一个来源 —— 卡是长期身份，
  // 来客名册是每一次进门；邮箱也只在这里摊开，用于人工联系。
  if (p === "/api/cards" && m === "GET")
    return readState(agentStub(env).listCards());

  // ── 公开墙：墙归主人那间（public_posts），读墙上面已放给所有登录角色 ──
  if (p === "/api/posts" && m === "GET")
    return readState(agentStub(env).listPosts());
  // 贴一条：权益在上面核过（wallPost）。署名用卡的昵称快照，别信前端报的名字
  if (p === "/api/posts" && m === "POST") {
    const info = await verifyTokenInfo(env, authToken(req));
    if (!info?.card) return forbidden();
    // 权益在这里再核一遍：门禁那张表按路径放行读墙，wallPost 的核验会被
    // USER_ROUTES 一项短路 —— 档位收回了公开权益的持卡来客，不该还能往墙上贴
    if (!(await cardAllows(req, env, "permPublic"))) return forbidden();
    const body = (await readJsonObject(req)) as { content?: unknown };
    try {
      const card = await agentStub(env).cardInfo(info.card);
      return writeState(
        agentStub(env).publishPost({
          cardId: info.card,
          author: card?.name || "",
          content: String(body.content ?? ""),
        }),
      );
    } catch (e) {
      return Response.json(
        { ok: false, error: (e as Error).message },
        { status: 400 },
      );
    }
  }
  // 摘一条：管理员收拾整块板子；持卡者只摘得动自己贴的（removePost 按 cardId 挡）
  if (p === "/api/posts" && m === "DELETE") {
    const info = await verifyTokenInfo(env, authToken(req));
    if (!info) return unauthorized();
    // 摘帖必须有卡：无卡票连「自己贴的」都没有，而 removePublicPost 在
    // byCardId 缺省时删任意 id —— 把 undefined 递进去等于全权删除
    if (info.role !== "admin" && !info.card) return forbidden();
    const body = (await readJsonObject(req)) as { id?: unknown };
    if (typeof body.id !== "string" || !body.id)
      return Response.json({ ok: false, error: "缺少 id" }, { status: 400 });
    const done = await agentStub(env).removePost(
      body.id,
      info.role === "admin" ? undefined : info.card,
    );
    if (!done)
      return Response.json(
        { ok: false, error: "这条不在墙上（或不是你贴的）" },
        { status: 404 },
      );
    return Response.json({ ok: true });
  }

  // ── 全库导出：备份只有管理员能做。manifest + 分页拉行聚成一份 JSON 下载；
  // DO RPC 有 1MB 响应上限，一把梭整库迟早炸在消息表上 ──
  if (p === "/api/export" && m === "GET") {
    const owner = agentStub(env, "default");
    const manifest = await owner.exportManifest();
    const tables: Record<string, Record<string, SqlStorageValue>[]> = {};
    const PAGE = 400;
    for (const t of manifest) {
      const rows: Record<string, SqlStorageValue>[] = [];
      for (let off = 0; ; off += PAGE) {
        const page = await owner.exportRows(t.name, off, PAGE);
        rows.push(...page);
        if (page.length < PAGE) break;
      }
      tables[t.name] = rows;
    }
    const body = JSON.stringify(
      { exportedAt: new Date().toISOString(), room: "default", tables },
      null,
      2,
    );
    return new Response(body, {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "content-disposition": `attachment; filename="hr-desk-backup-${new Date().toISOString().slice(0, 10)}.json"`,
      },
    });
  }

  // ── 多档来客类型：档位是这张台子的配置，只有管理员能碰
  // （不在 USER_ROUTES，上面已经拦了来客）。清单里的 password 只进主人那间的表，
  // 对外面板的回显由前端按需取舍 ──
  if (p === "/api/guest-types" && m === "GET")
    return readState(Promise.resolve(agent.guestTypes()));
  if (p === "/api/guest-types" && m === "POST") {
    try {
      const body = (await readJsonObject(req)) as Record<string, unknown>;
      if (
        typeof body.name !== "string" ||
        !body.name.trim() ||
        typeof body.password !== "string" ||
        !body.password
      )
        return Response.json(
          { ok: false, error: "缺少 name 或 password" },
          { status: 400 },
        );
      return writeState(
        Promise.resolve(
          agent.addGuestType({
            name: body.name,
            password: body.password,
            note: typeof body.note === "string" ? body.note : undefined,
            // 逐工具权益：面板按件传；老客户端只传三个开关时由 guestTypes.ts 推平一次
            tools: parseToolList(body.tools),
            permSearch:
              typeof body.permSearch === "boolean"
                ? body.permSearch
                : undefined,
            permDraw:
              typeof body.permDraw === "boolean" ? body.permDraw : undefined,
            permMemory:
              typeof body.permMemory === "boolean"
                ? body.permMemory
                : undefined,
            permNotes:
              typeof body.permNotes === "boolean" ? body.permNotes : undefined,
            permFiles:
              typeof body.permFiles === "boolean" ? body.permFiles : undefined,
            permPublic:
              typeof body.permPublic === "boolean"
                ? body.permPublic
                : undefined,
            permMatrix:
              typeof body.permMatrix === "boolean"
                ? body.permMatrix
                : undefined,
          }),
        ),
      );
    } catch (e) {
      return fail(e);
    }
  }
  if (p === "/api/guest-types" && m === "PATCH") {
    try {
      const body = (await readJsonObject(req)) as Record<string, unknown>;
      const id = typeof body.id === "string" ? body.id : "";
      if (!id)
        return Response.json({ ok: false, error: "缺少 id" }, { status: 400 });
      return writeState(
        Promise.resolve(
          agent.updateGuestType(id, {
            name: typeof body.name === "string" ? body.name : undefined,
            password:
              typeof body.password === "string" ? body.password : undefined,
            note: typeof body.note === "string" ? body.note : undefined,
            tools: parseToolList(body.tools),
            permSearch:
              typeof body.permSearch === "boolean"
                ? body.permSearch
                : undefined,
            permDraw:
              typeof body.permDraw === "boolean" ? body.permDraw : undefined,
            permMemory:
              typeof body.permMemory === "boolean"
                ? body.permMemory
                : undefined,
            permNotes:
              typeof body.permNotes === "boolean" ? body.permNotes : undefined,
            permFiles:
              typeof body.permFiles === "boolean" ? body.permFiles : undefined,
            permPublic:
              typeof body.permPublic === "boolean"
                ? body.permPublic
                : undefined,
            permMatrix:
              typeof body.permMatrix === "boolean"
                ? body.permMatrix
                : undefined,
            active: typeof body.active === "boolean" ? body.active : undefined,
          }),
        ),
      );
    } catch (e) {
      return fail(e);
    }
  }
  if (p === "/api/guest-types" && m === "DELETE") {
    const id = url.searchParams.get("id") || "";
    if (!id)
      return Response.json({ ok: false, error: "缺少 id" }, { status: 400 });
    return writeState(Promise.resolve(agent.removeGuestType(id)));
  }

  // ── 更新检查：拿本地版本号去对开源仓库的版本号 ──
  // 公开仓库（ericher）是交付出口，但私有部署攒批推送是常态 —— 两边的提交
  // 几乎永远对不上号，hash 不同不代表这边旧。所以判新旧只认版本号：
  // 开源仓 package.json 的 version（随发布一起走）比本地新，才是真的该更新；
  // 构建号与提交信息照旧取回来，作「对方走到哪了」的参照。
  // 转发放到 Worker 端而不是浏览器直连 —— Cloudflare 到 GitHub 的路比访客
  // 浏览器到 GitHub 的路稳得多，前端也不必自己会走 GitHub。
  //
  // 只读 raw.githubusercontent 一个文件（scripts/publish-open-source.mjs 每次
  // 发布写好的 version.json），不去打 api.github.com：那个接口匿名只有
  // 60 次/小时/IP，而 Worker 出口是共享 IP —— 实测它长期回 403，整条检查跟着哑掉。
  if (p === "/api/update-check" && m === "GET") {
    try {
      const res = await fetch(
        "https://raw.githubusercontent.com/leleou209/ericher/main/version.json",
        { headers: { "User-Agent": "ericher-update-check" } },
      );
      if (!res.ok)
        return Response.json(
          { ok: false, error: `GitHub 返回 ${res.status}` },
          { status: 502 },
        );
      const j = (await res.json()) as {
        version?: string;
        hash?: string;
        message?: string;
        date?: string;
      };
      const remote = (j.version || "").trim();
      if (!remote)
        return Response.json(
          { ok: false, error: "开源仓 version.json 没有 version 字段" },
          { status: 502 },
        );
      const latest = {
        version: remote,
        hash: (j.hash || "").trim(),
        message: (j.message || "").trim().slice(0, 100),
        date: (j.date || "").trim(),
      };
      return Response.json({
        ok: true,
        upToDate: compareSemver(remote, __APP_VERSION__) <= 0,
        latest,
      });
    } catch (e) {
      return fail(e);
    }
  }

  // ── 模型目录（供应商 + 模型条目两级）：这张台子用哪家模型，只有管理员能碰 ──
  // 表在主人那间，回显里只有 secret 的变量名（keySecret）—— key 本体在
  // Worker secrets 里，从不落库、从不外发。keySecrets 是已知钥匙名单：
  // 面板「用哪把 key」下拉框的选项，只回名字不回值。
  if (p === "/api/model-configs" && m === "GET") {
    try {
      const known = env as unknown as Record<string, unknown>;
      return Response.json({
        ok: true,
        ...(await agent.modelCatalog()),
        keySecrets: KNOWN_KEY_SECRETS.filter((k) => !!known[k]),
      });
    } catch (e) {
      return fail(e);
    }
  }
  // 新建一家供应商。firstModel 给了就顺手挂上首个模型条目（没有生效条目时
  // 它自动生效）—— 「从厂商开始 → 拉列表 → 点一个 → 保存」一步到位。
  if (p === "/api/model-configs/providers" && m === "POST") {
    try {
      const body = (await readJsonObject(req)) as Record<string, unknown>;
      for (const f of ["name", "format", "baseUrl", "keySecret"]) {
        if (typeof body[f] !== "string" || !(body[f] as string).trim())
          return Response.json(
            { ok: false, error: `缺少 ${f}` },
            { status: 400 },
          );
      }
      return writeState(
        Promise.resolve(
          agent.addModelProvider({
            name: body.name as string,
            format: body.format as string,
            baseUrl: body.baseUrl as string,
            keySecret: body.keySecret as string,
            maintKeySecret:
              typeof body.maintKeySecret === "string"
                ? body.maintKeySecret
                : undefined,
            maintModel:
              typeof body.maintModel === "string" ? body.maintModel : undefined,
            firstModel:
              typeof body.firstModel === "string" ? body.firstModel : undefined,
            maxOutput:
              typeof body.maxOutput === "number" ? body.maxOutput : undefined,
          }),
        ),
      );
    } catch (e) {
      return fail(e);
    }
  }
  if (p === "/api/model-configs/providers" && m === "PATCH") {
    try {
      const body = (await readJsonObject(req)) as Record<string, unknown>;
      const id = typeof body.id === "string" ? body.id : "";
      if (!id)
        return Response.json({ ok: false, error: "缺少 id" }, { status: 400 });
      const str = (k: string) =>
        typeof body[k] === "string" ? (body[k] as string) : undefined;
      return writeState(
        Promise.resolve(
          agent.updateModelProvider(id, {
            name: str("name"),
            format: str("format"),
            baseUrl: str("baseUrl"),
            keySecret: str("keySecret"),
            maintKeySecret: str("maintKeySecret"),
            maintModel: str("maintModel"),
          }),
        ),
      );
    } catch (e) {
      return fail(e);
    }
  }
  if (p === "/api/model-configs/providers" && m === "DELETE") {
    const id = url.searchParams.get("id") || "";
    if (!id)
      return Response.json({ ok: false, error: "缺少 id" }, { status: 400 });
    return writeState(Promise.resolve(agent.removeModelProvider(id)));
  }
  if (p === "/api/model-configs/entries" && m === "POST") {
    try {
      const body = (await readJsonObject(req)) as Record<string, unknown>;
      const providerId =
        typeof body.providerId === "string" ? body.providerId : "";
      const model = typeof body.model === "string" ? body.model.trim() : "";
      if (!providerId || !model)
        return Response.json(
          { ok: false, error: "缺少 providerId / model" },
          { status: 400 },
        );
      return writeState(
        Promise.resolve(
          agent.addModelEntry({
            providerId,
            model,
            maxOutput:
              typeof body.maxOutput === "number" ? body.maxOutput : undefined,
            contextWindow:
              typeof body.contextWindow === "number"
                ? body.contextWindow
                : undefined,
          }),
        ),
      );
    } catch (e) {
      return fail(e);
    }
  }
  if (p === "/api/model-configs/entries" && m === "PATCH") {
    try {
      const body = (await readJsonObject(req)) as Record<string, unknown>;
      const id = typeof body.id === "string" ? body.id : "";
      if (!id)
        return Response.json({ ok: false, error: "缺少 id" }, { status: 400 });
      return writeState(
        Promise.resolve(
          agent.updateModelEntry(id, {
            model: typeof body.model === "string" ? body.model : undefined,
            maxOutput:
              typeof body.maxOutput === "number" ? body.maxOutput : undefined,
            contextWindow:
              typeof body.contextWindow === "number"
                ? body.contextWindow
                : undefined,
            active: typeof body.active === "boolean" ? body.active : undefined,
          }),
        ),
      );
    } catch (e) {
      return fail(e);
    }
  }
  if (p === "/api/model-configs/entries" && m === "DELETE") {
    const id = url.searchParams.get("id") || "";
    if (!id)
      return Response.json({ ok: false, error: "缺少 id" }, { status: 400 });
    return writeState(Promise.resolve(agent.removeModelEntry(id)));
  }
  // 让厂商报一份它家的模型清单，填「模型名」时照抄而不用手打。
  // 只做透传：地址必须 https，key 由这台机器自己持有的 secrets 出 ——
  // 前端永远摸不到 key，也就没有借面板把 key 发去别处的口子。
  if (p === "/api/model-configs/list-models" && m === "POST") {
    try {
      const body = (await readJsonObject(req)) as Record<string, unknown>;
      const format = typeof body.format === "string" ? body.format.trim() : "";
      const baseUrl =
        typeof body.baseUrl === "string" ? body.baseUrl.trim() : "";
      const keySecret =
        typeof body.keySecret === "string" ? body.keySecret.trim() : "";
      // 厂商预设里核实过的列表端点：给了就直接用它，不再从 format+baseUrl 拼
      const listUrl =
        typeof body.listUrl === "string" ? body.listUrl.trim() : "";
      const listAuth =
        typeof body.listAuth === "string" ? body.listAuth.trim() : "";
      if (!format || !keySecret || (!baseUrl && !listUrl))
        return Response.json(
          { ok: false, error: "缺少 format / keySecret / baseUrl" },
          { status: 400 },
        );
      if (!["anthropic", "openai-chat", "openai-responses"].includes(format))
        return Response.json(
          { ok: false, error: "不认识这种接口格式" },
          { status: 400 },
        );
      // 只认配置目录登记过的变量名：env 是一整排抽屉，不设这道门，
      // 一个被劫持的管理员会话就能把 SESSION_SECRET 当 Bearer 发出门
      if (!KNOWN_KEY_SECRETS.includes(keySecret))
        return Response.json(
          { ok: false, error: "keySecret 不在配置目录的名单里" },
          { status: 400 },
        );
      const url = (listUrl || baseUrl).replace(/\/+$/, "");
      if (!url.startsWith("https://"))
        return Response.json(
          { ok: false, error: "接口地址必须是 https" },
          { status: 400 },
        );
      const key = (env as unknown as Record<string, unknown>)[keySecret];
      if (typeof key !== "string" || !key)
        return Response.json(
          { ok: false, error: `这台机器没配 ${keySecret}` },
          { status: 400 },
        );
      // 鉴权头：厂商点了名听厂商的；没点名才按线格式猜
      // （anthropic 家的兼容端点下没有 /models，全靠厂商自己的列表端点）
      const headers: Record<string, string> =
        listAuth === "x-api-key" || (!listAuth && format === "anthropic")
          ? { "x-api-key": key, "anthropic-version": "2023-06-01" }
          : { Authorization: `Bearer ${key}` };
      const r = await fetch(listUrl ? url : `${url}/models`, { headers });
      if (!r.ok) {
        const raw = (await r.text().catch(() => "")).slice(0, 300);
        console.warn(`[model-configs] 拉模型清单失败 ${r.status}：${raw}`);
        return Response.json(
          {
            ok: false,
            error:
              r.status === 401 ? "key 不对" : `对方回了 ${r.status}：${raw}`,
          },
          { status: 502 },
        );
      }
      const j = (await r.json().catch(() => ({}))) as {
        data?: { id?: unknown; name?: unknown }[];
      };
      const models = (Array.isArray(j.data) ? j.data : [])
        .filter((x) => x && typeof x.id === "string")
        .map((x) => ({
          id: x.id as string,
          ...(typeof x.name === "string" ? { name: x.name } : {}),
        }));
      return Response.json({ ok: true, models });
    } catch (e) {
      return fail(e);
    }
  }

  // ── 读音配置目录（tts_configs）：这台机器用哪家读音服务，只有管理员能碰 ──
  // 顺序即优先级，没有「生效中」的概念；和模型目录一样只存 secret 变量名。
  if (p === "/api/tts-configs" && m === "GET") {
    try {
      // keySecrets 同模型目录：只回变量名清单给下拉框，key 本体不出 secrets
      const known = env as unknown as Record<string, unknown>;
      return Response.json({
        ok: true,
        configs: await agent.ttsConfigs(),
        keySecrets: KNOWN_KEY_SECRETS.filter((k) => !!known[k]),
      });
    } catch (e) {
      return fail(e);
    }
  }
  if (p === "/api/tts-configs" && m === "POST") {
    try {
      const body = (await readJsonObject(req)) as Record<string, unknown>;
      for (const f of ["name", "protocol", "keySecret"]) {
        if (typeof body[f] !== "string" || !(body[f] as string).trim())
          return Response.json(
            { ok: false, error: `缺少 ${f}` },
            { status: 400 },
          );
      }
      return writeState(
        Promise.resolve(
          agent.addTtsConfig({
            name: body.name as string,
            protocol: body.protocol as string,
            keySecret: body.keySecret as string,
            baseUrl:
              typeof body.baseUrl === "string" ? body.baseUrl : undefined,
            model: typeof body.model === "string" ? body.model : undefined,
            voice: typeof body.voice === "string" ? body.voice : undefined,
            style: typeof body.style === "string" ? body.style : undefined,
          }),
        ).then((r) => {
          invalidateTtsCache();
          return r;
        }),
      );
    } catch (e) {
      return fail(e);
    }
  }
  if (p === "/api/tts-configs" && m === "PATCH") {
    try {
      const body = (await readJsonObject(req)) as Record<string, unknown>;
      const id = typeof body.id === "string" ? body.id : "";
      if (!id)
        return Response.json({ ok: false, error: "缺少 id" }, { status: 400 });
      const str = (k: string) =>
        typeof body[k] === "string" ? (body[k] as string) : undefined;
      return writeState(
        Promise.resolve(
          agent.updateTtsConfig(id, {
            name: str("name"),
            protocol: str("protocol"),
            baseUrl: str("baseUrl"),
            keySecret: str("keySecret"),
            model: str("model"),
            voice: str("voice"),
            style: str("style"),
          }),
        ).then((r) => {
          invalidateTtsCache();
          return r;
        }),
      );
    } catch (e) {
      return fail(e);
    }
  }
  if (p === "/api/tts-configs" && m === "DELETE") {
    const id = url.searchParams.get("id") || "";
    if (!id)
      return Response.json({ ok: false, error: "缺少 id" }, { status: 400 });
    return writeState(
      Promise.resolve(agent.removeTtsConfig(id)).then((r) => {
        invalidateTtsCache();
        return r;
      }),
    );
  }

  // ── 绘图配置目录（draw_configs）：出图三档各用哪家，只有管理员能碰 ──
  // 同 model/tts 两套目录：只存 secret 变量名，key 本体永不落库。
  if (p === "/api/draw-configs" && m === "GET") {
    try {
      return Response.json({ ok: true, configs: await agent.drawConfigList() });
    } catch (e) {
      return fail(e);
    }
  }
  if (p === "/api/draw-configs" && m === "PATCH") {
    try {
      const body = (await readJsonObject(req)) as Record<string, unknown>;
      const tier = typeof body.tier === "string" ? body.tier : "";
      if (!tier)
        return Response.json(
          { ok: false, error: "缺少 tier" },
          { status: 400 },
        );
      return writeState(
        Promise.resolve(
          agent.patchDrawConfig(tier, {
            format: typeof body.format === "string" ? body.format : undefined,
            endpoint:
              typeof body.endpoint === "string" ? body.endpoint : undefined,
            models: Array.isArray(body.models)
              ? body.models.map(String)
              : undefined,
            keySecret:
              typeof body.keySecret === "string" ? body.keySecret : undefined,
            label: typeof body.label === "string" ? body.label : undefined,
          }),
        ),
      );
    } catch (e) {
      return fail(e);
    }
  }

  // ── 搜索通道配置（search_config）：搜索走 Tavily 还是 Brave，只有管理员能碰 ──
  // 同 model/tts/draw 几套目录：只存 secret 变量名，key 本体永不落库。
  if (p === "/api/search-configs" && m === "GET") {
    try {
      return Response.json({ ok: true, config: await agent.searchConfigGet() });
    } catch (e) {
      return fail(e);
    }
  }
  if (p === "/api/search-configs" && m === "PATCH") {
    try {
      const body = (await readJsonObject(req)) as Record<string, unknown>;
      return writeState(
        Promise.resolve(
          agent.patchSearchConfig({
            format: typeof body.format === "string" ? body.format : undefined,
            keySecret:
              typeof body.keySecret === "string" ? body.keySecret : undefined,
          }),
        ),
      );
    } catch (e) {
      return fail(e);
    }
  }

  // ── 邮件通道（mail_config）：SMTP 服务器 + 每日额度，只有管理员能碰 ──
  // 同 search/tts/draw 几套目录：表里只存 secret 的**变量名**，口令本体永不入库、
  // 永不回显（GET 出来的 keyAvailable 只说那个变量在这台机器上配没配）。
  if (p === "/api/mail/config" && m === "GET")
    return readState(agent.mailConfigGet());
  if (p === "/api/mail/config" && m === "POST") {
    try {
      // 坏 body 在 readJsonObject 就 400，压根走不到写入那一步
      const body = (await readJsonObject(req)) as Record<string, unknown>;
      // 白名单在 parseMailConfigInput 里收口：password 一类的字段进不了 patch
      const patch = parseMailConfigInput(body);
      return writeState(Promise.resolve(agent.mailConfigSave(patch)));
    } catch (e) {
      return fail(e);
    }
  }
  if (p === "/api/mail/test" && m === "POST") {
    try {
      const body = (await readJsonObject(req)) as Record<string, unknown>;
      // body 里的 to 只是「换个收件地址试一封」；没给就用配置里那个
      const to = body.to;
      if (to !== undefined && to !== null && typeof to !== "string")
        return Response.json(
          { ok: false, error: "to 得是一段文本" },
          { status: 400 },
        );
      // 这一条不回 {ok:true,data}：契约就是 {ok:true} / {ok:false,error}，
      // 失败那句是服务器给的原话，不吞成成功
      return Response.json(
        await agent.mailTestSend(typeof to === "string" ? to : undefined),
      );
    } catch (e) {
      return fail(e);
    }
  }
  // 人亲自动笔寄一封（信箱页）。空主题/空正文不在这里 400 —— 那是 DO 给出的
  // 领域答案（不占额度、不拨号），界面拿到那句原话显示就行；HTTP 边上只挡形状错的。
  if (p === "/api/mail/send" && m === "POST") {
    try {
      const body = (await readJsonObject(req)) as Record<string, unknown>;
      for (const k of ["to", "subject", "text"] as const) {
        const v = body[k];
        if (v !== undefined && v !== null && typeof v !== "string")
          return Response.json(
            { ok: false, error: `${k} 得是一段文本` },
            { status: 400 },
          );
      }
      return Response.json(
        await agent.mailComposeSend({
          to: typeof body.to === "string" ? body.to : undefined,
          subject: typeof body.subject === "string" ? body.subject : "",
          text: typeof body.text === "string" ? body.text : "",
        }),
      );
    } catch (e) {
      return fail(e);
    }
  }

  // ── 信箱：发件流水与收件（都只读主屋那一本账，见 cowork 的 mailOutbox/mailInbox）──
  // outbox 回的是 {rows}，不是裸数组：契约（mailboxTypes.ts）这么定的，界面按它读；
  // 少裹这一层，面板不会报错，只会一直显示「0 封」—— 那是最难发现的一类假空。
  if (p === "/api/mail/outbox" && m === "GET")
    return readState(agent.mailOutbox(mailLimit(url)).then((rows) => ({ rows })));
  if (p === "/api/mail/inbox" && m === "GET")
    return readState(agent.mailInbox(mailLimit(url)));
  if (p === "/api/mail/inbox/read" && m === "GET")
    return readState(agent.mailInboxRead(url.searchParams.get("id") || ""));
  if (p === "/api/mail/inbox/open" && m === "POST") {
    try {
      const body = (await readJsonObject(req)) as Record<string, unknown>;
      const id = body.id;
      if (typeof id !== "string" || !id)
        return Response.json({ ok: false, error: "id 得是一个字符串" }, { status: 400 });
      if (typeof body.read !== "boolean")
        return Response.json({ ok: false, error: "read 得是 true / false" }, { status: 400 });
      // 行不在就回 null：不替一次没改到任何东西的操作造一个「成功」
      return Response.json(await agent.mailInboxOpen(id, body.read));
    } catch (e) {
      return fail(e);
    }
  }
  // 喂一封原始报文进来（管理员专供）：收件通道接上之前，这是唯一能把整条
  // 解析→入库→读正文测穿的路；接上之后它仍然是「这封信为什么没进收件箱」的复现口。
  // 走的是与 email() 投递同一个 mailIngest，不另开一套逻辑。
  if (p === "/api/mail/inbox/feed" && m === "POST") {
    try {
      const body = (await readJsonObject(req)) as Record<string, unknown>;
      const raw = body.raw;
      if (typeof raw !== "string")
        return Response.json(
          { ok: false, error: "raw 得是一段文本（整封原始报文）" },
          { status: 400 },
        );
      if (raw.length > EML_FEED_MAX)
        return Response.json(
          { ok: false, error: `这一段太大了，超过 ${EML_FEED_MAX} 字符不收` },
          { status: 400 },
        );
      // 固定投主屋：这本账只在主屋记，场屋那间连表都是空的
      return Response.json(await agentStub(env).mailIngest(raw));
    } catch (e) {
      return fail(e);
    }
  }

  // ── 全局美术主题（theme_config）：皮肤/名字头像/弹页/主题包，只有管理员能碰 ──
  // 读是免鉴权的（fetch 入口 GET /api/theme / /api/theme-asset/），走到这里的
  // 只有写。表归主人那间，所以写也点名主人房（agentStub 默认就它），
  // 不跟请求者自己那间走 —— 主题是全屋一份的，不是每人一份。
  if (p === "/api/theme" && m === "PATCH") {
    try {
      const body = (await readJsonObject(req)) as Record<string, unknown>;
      return writeState(agentStub(env).patchTheme(body as ThemeConfigPatch));
    } catch (e) {
      return fail(e);
    }
  }
  if (p === "/api/theme/assets" && m === "POST")
    return handleThemeAssetUpload(req, env);
  if (p === "/api/theme/import" && m === "POST")
    return handleThemeImport(req, env);
  if (p === "/api/theme/pack" && m === "POST")
    return handleThemePackEquip(req, env);
  if (p === "/api/theme/pack" && m === "GET")
    return handleThemePackExport(env);
  // 自定义主题存档：把当前配置存成一份带名字的档、换回来、删掉
  if (p === "/api/theme/sets" && m === "GET")
    return handleThemeSetsList(env);
  if (p === "/api/theme/sets" && m === "POST")
    return handleThemeSetSave(req, env);
  if (p === "/api/theme/sets/apply" && m === "POST")
    return handleThemeSetApply(req, env);
  if (p === "/api/theme/sets/delete" && m === "POST")
    return handleThemeSetDelete(req, env);

  // 人设与回想两份提示词的出厂默认值，供管理员面板「恢复默认」用。
  // 工具那一份不在这里 —— 它拆成了逐工具的稿子，出厂稿随名册走（见 /api/tool-groups）。
  if (p === "/api/prompt" && m === "GET")
    return Response.json({
      ok: true,
      data: {
        base: DEFAULT_BASE_PROMPT,
        recap: DEFAULT_RECAP_PROMPT,
      },
    });

  // 工具守则面板：组/工具名册 + 两侧（主人/来客）的出厂稿与当前自定义。
  // 形状容纳未来的 MCP 工具：多几件工具而已，前端不用改。
  if (p === "/api/tool-groups" && m === "GET")
    return readState(Promise.resolve(agent.toolGroupsCatalog()));

  // ── 会话：元信息与消息都存在 DO 里（不再是 R2 的一份标题索引）──
  if (p === "/api/sessions" && m === "GET")
    return readState(Promise.resolve(agent.listAllSessions()));
  // 公开会话：只列 / 只读被标成公开的那几场。这条入口现在收着 ——
  // 来客侧栏只看自己那几场（他也是这个家的朋友，但不能翻主人的对话），
  // 所以这两个路由不在 USER_ROUTES 里。留着是因为那件事本身没想明白，不是忘了删。
  if (p === "/api/sessions/open" && m === "GET")
    return readState(Promise.resolve(agent.listOpenSessions()));
  if (p === "/api/sessions/read" && m === "GET") {
    const id = url.searchParams.get("id") || "";
    return readState(Promise.resolve(agent.readOpenSession(id)));
  }
  if (p === "/api/sessions" && m === "POST") {
    try {
      const { title, visibility } = (await readJsonObject(req)) as {
        title?: string;
        visibility?: string;
      };
      return writeState(
        agent.createSession(
          title,
          visibility === "public" ? "public" : "private",
        ),
      );
    } catch (e) {
      return fail(e);
    }
  }
  if (p === "/api/sessions/switch" && m === "POST") {
    try {
      const { id } = (await readJsonObject(req)) as { id?: string };
      if (!id)
        return Response.json({ ok: false, error: "缺少 id" }, { status: 400 });
      const session = await agent.switchSession(id);
      return Response.json({ ok: true, data: session });
    } catch (e) {
      return sessionConflictResponse(e) ?? fail(e);
    }
  }
  // 多端最后状态对齐：记下「他最后看的是哪间屋、哪一场」。
  // 写口恒落人屋（agent 就是 token 派生出的那间）—— 连着场屋时发的这条也写到人屋，
  // 正是要的效果：人屋是每台设备开机先连的地方，靠这两格把新设备送回最后那一间。
  // 写在 state（非 PATCHABLE），前端只经这条专用门改，不让它自己挑屋。
  if (p === "/api/active-room" && m === "POST") {
    try {
      const { room, session, at } = (await readJsonObject(req)) as {
        room?: unknown;
        session?: unknown;
        at?: unknown;
      };
      return writeState(
        agent.setLastView(
          typeof room === "string" ? room : "",
          typeof session === "string" ? session : "",
          // 前端在动作那一刻打的时间戳；没带（老前端）就传 0，由 DO 回落到此刻
          typeof at === "number" && Number.isFinite(at) ? at : 0,
        ),
      );
    } catch (e) {
      return fail(e);
    }
  }
  if (p === "/api/sessions/rename" && m === "POST") {
    try {
      const { id, title } = (await readJsonObject(req)) as {
        id?: string;
        title?: string;
      };
      if (!id || !title?.trim())
        return Response.json(
          { ok: false, error: "缺少 id 或 title" },
          { status: 400 },
        );
      return writeState(Promise.resolve(agent.renameSession(id, title)));
    } catch (e) {
      return fail(e);
    }
  }
  if (p === "/api/sessions/visibility" && m === "POST") {
    try {
      const { id, visibility } = (await readJsonObject(req)) as {
        id?: string;
        visibility?: string;
      };
      if (!id)
        return Response.json({ ok: false, error: "缺少 id" }, { status: 400 });
      return writeState(
        Promise.resolve(
          agent.setSessionVisibility(
            id,
            visibility === "public" ? "public" : "private",
          ),
        ),
      );
    } catch (e) {
      return fail(e);
    }
  }
  if (p === "/api/sessions/archive" && m === "POST") {
    try {
      const { id, archived } = (await readJsonObject(req)) as {
        id?: string;
        archived?: boolean;
      };
      if (!id)
        return Response.json({ ok: false, error: "缺少 id" }, { status: 400 });
      return writeState(
        Promise.resolve(agent.setSessionArchived(id, !!archived)),
      );
    } catch (e) {
      return fail(e);
    }
  }
  if (p === "/api/sessions/pin" && m === "POST") {
    try {
      const { id, pinned } = (await readJsonObject(req)) as {
        id?: string;
        pinned?: boolean;
      };
      if (!id)
        return Response.json({ ok: false, error: "缺少 id" }, { status: 400 });
      return writeState(Promise.resolve(agent.setSessionPinned(id, !!pinned)));
    } catch (e) {
      return fail(e);
    }
  }
  if (p === "/api/sessions/delete" && m === "POST") {
    try {
      const { id } = (await readJsonObject(req)) as { id?: string };
      if (!id)
        return Response.json({ ok: false, error: "缺少 id" }, { status: 400 });
      return writeState(agent.deleteSession(id));
    } catch (e) {
      return fail(e);
    }
  }

  // ── 提醒：到点 ericher 自己开口，所以只有管理员看得到自己的约定 ──
  if (p === "/api/reminders" && m === "GET")
    return readState(Promise.resolve(agent.listReminders()));
  if (p === "/api/reminders/cancel" && m === "POST") {
    try {
      const { id } = (await readJsonObject(req)) as { id?: string };
      if (!id)
        return Response.json({ ok: false, error: "缺少 id" }, { status: 400 });
      return writeState(Promise.resolve(agent.cancelReminder(id)));
    } catch (e) {
      return fail(e);
    }
  }

  // 主动开口的账：今天她说了几次、现在是不是安静时段。
  // 放在设置里给他看，是因为「她今天烦了我几次」这件事该是看得见的 ——
  // 看不见就只能靠感觉，感觉到烦的时候通常已经想全关掉了。
  if (p === "/api/proactive" && m === "GET")
    return readState(Promise.resolve(agent.proactiveStats()));

  // ── 笔记本：管理员和我一起写的本子。一条都不给来客 ——
  // 它是他的草稿本，性质和记忆一样偏私，不该因为「顺手」就开在门外 ──
  // room 定参：本子跟着场走（每场自带资产）——连在哪间场屋上，读写的就是
  // 哪一间的本子（note 工具那头读的也是同一间）。核验走 targetRoom 同一把尺
  if (p === "/api/notes" && m === "GET") {
    const notes = agentStub(env, targetRoom(url.searchParams.get("room")));
    return readState(
      Promise.resolve(
        notes.listNotes(
          url.searchParams.get("q") || "",
          url.searchParams.get("tag") || "",
        ),
      ),
    );
  }
  if (p === "/api/notes/read" && m === "GET") {
    const id = url.searchParams.get("id") || "";
    if (!id)
      return Response.json({ ok: false, error: "缺少 id" }, { status: 400 });
    return readState(
      Promise.resolve(
        agentStub(env, targetRoom(url.searchParams.get("room"))).readNote(id),
      ),
    );
  }
  if (p === "/api/notes/save" && m === "POST") {
    try {
      const body = (await readJsonObject(req)) as Record<string, unknown>;
      const id = typeof body.id === "string" ? body.id : undefined;
      // by 固定成 user：这条路只有管理员走得通（admin-only），
      // 我动笔那条路在工具里，那边自己写 assistant
      return writeState(
        Promise.resolve(
          agentStub(env, targetRoom(body.room)).saveNote({
            id,
            title: typeof body.title === "string" ? body.title : undefined,
            body: typeof body.body === "string" ? body.body : undefined,
            tags: Array.isArray(body.tags)
              ? (body.tags as string[])
              : undefined,
            pinned: typeof body.pinned === "boolean" ? body.pinned : undefined,
            by: "user",
          }),
        ),
      );
    } catch (e) {
      return fail(e);
    }
  }
  if (p === "/api/notes/delete" && m === "POST") {
    try {
      const { id, room } = (await readJsonObject(req)) as {
        id?: string;
        room?: unknown;
      };
      if (!id)
        return Response.json({ ok: false, error: "缺少 id" }, { status: 400 });
      return writeState(
        Promise.resolve(agentStub(env, targetRoom(room)).deleteNote(id)),
      );
    } catch (e) {
      return fail(e);
    }
  }
  // 「他翻开了哪一篇」：id 给空串 = 合上了。
  // 单开一条窄路由，而不是塞进 POST /api/config —— 后者一放，人格提示词、任务清单也跟着开了。
  if (p === "/api/notes/focus" && m === "POST") {
    try {
      const { id, room } = (await readJsonObject(req)) as {
        id?: string;
        room?: unknown;
      };
      return writeState(
        Promise.resolve(
          agentStub(env, targetRoom(room)).setNoteFocus(
            typeof id === "string" ? id : "",
          ),
        ),
      );
    } catch (e) {
      return fail(e);
    }
  }
  if (p === "/api/notes/revisions" && m === "GET") {
    const id = url.searchParams.get("id") || "";
    if (!id)
      return Response.json({ ok: false, error: "缺少 id" }, { status: 400 });
    return readState(
      Promise.resolve(
        agentStub(
          env,
          targetRoom(url.searchParams.get("room")),
        ).listNoteRevisions(id),
      ),
    );
  }
  if (p === "/api/notes/restore" && m === "POST") {
    try {
      const { id, seq, room } = (await readJsonObject(req)) as {
        id?: string;
        seq?: number;
        room?: unknown;
      };
      if (!id || typeof seq !== "number")
        return Response.json(
          { ok: false, error: "缺少 id 或 seq" },
          { status: 400 },
        );
      return writeState(
        Promise.resolve(
          agentStub(env, targetRoom(room)).restoreNoteRevision(id, seq),
        ),
      );
    } catch (e) {
      return fail(e);
    }
  }

  // ── 本场计划：这一场的目标与步骤。和笔记一样不进 USER_ROUTES，只给管理员 ──
  // 两个定参缺一不可：
  //   room    —— 计划跟着场走，连在哪间场屋上就读写哪一间（同笔记的定参）；
  //   session —— 一间屋能装好几场（老场都住在人屋），不点明是哪一场就会串台。
  // 会话内计划 vs 会话外提醒是两回事：提醒在后端是 reminders 表（到点响），
  // 这里是 sessions.goal + session_tasks 表（不排期、不响，只钉住这一场的注意力）。
  if (p === "/api/session-plan" && m === "GET") {
    return readState(
      Promise.resolve(
        agentStub(env, targetRoom(url.searchParams.get("room"))).sessionPlan(
          url.searchParams.get("session") || "",
        ),
      ),
    );
  }
  if (p === "/api/session-plan" && m === "POST") {
    try {
      const body = (await readJsonObject(req)) as Record<string, unknown>;
      return writeState(
        Promise.resolve(
          agentStub(env, targetRoom(body.room)).saveSessionPlan({
            session: typeof body.session === "string" ? body.session : "",
            // 没给这一格就不动它：只改目标的手改不该顺手把步骤清空
            goal: typeof body.goal === "string" ? body.goal : undefined,
            tasks: Array.isArray(body.tasks)
              ? (body.tasks as {
                  title: string;
                  desc: string;
                  status: "todo" | "doing" | "done";
                  created: string;
                }[])
              : undefined,
          }),
        ),
      );
    } catch (e) {
      return fail(e);
    }
  }

  // ── 跨会话回忆：管理员在自己的历史里搜原话（会话含私有内容，不放开来客）──
  if (p === "/api/recall" && m === "GET") {
    const q = url.searchParams.get("q") || "";
    return readState(agent.recall(q));
  }

  // ── 今日写额度：谁在吃那 10 万行。只给管理员看（它是这间屋子的运行账）──
  if (p === "/api/writes" && m === "GET")
    return readState(Promise.resolve(agent.writeReport()));

  // ── 额度总览：自计量（SQL / neurons / Vectorize）+ 官方校准（请求数、DO 读写行）。
  // 同样不进 USER_ROUTES —— 这是运行账，只给管理员看。
  if (p === "/api/usage" && m === "GET") {
    return readState(
      (async () => {
        const [writes, resources, official] = await Promise.all([
          agent.writeReport(),
          agent.resourceReport(),
          fetchOfficialUsage(env),
        ]);
        return { writes, resources, official };
      })(),
    );
  }

  if (p === "/api/config" && m === "GET") return readState(agent.getConfig());
  if (p === "/api/config" && m === "POST") {
    try {
      const { patch } = (await readJsonObject(req)) as {
        patch?: Partial<Record<string, unknown>>;
      };
      return writeState(agent.patchConfig(patch || {}));
    } catch (e) {
      return fail(e);
    }
  }

  // 思考强度：这件事来客也该能调 —— 问的是同一副脑子，没道理主人能要她想深一点，
  // 来客就只能收着。（这句话说的是他「能要」，来客那间屋子有自己的 thinkMode，
  // 调的是他自己那场，不会动到主人。）
  // 单开一条窄路由，而不是把 POST /api/config 放开给他：后者一放，
  // 人格提示词、任务清单、自我认知就一起开了，那不是「调强度」是「接管」。
  if (p === "/api/think" && m === "POST") {
    try {
      const { mode, room } = (await readJsonObject(req)) as {
        mode?: unknown;
        room?: unknown;
      };
      if (mode !== "deep" && mode !== "normal") {
        return Response.json(
          { ok: false, error: "只有 deep 和 normal 两种模式" },
          { status: 400 },
        );
      }
      // 点名场屋时调的是那一场自己的开关（每场各自的强度），不动人屋的
      return writeState(
        agentStub(env, targetRoom(room)).patchConfig({ thinkMode: mode }),
      );
    } catch (e) {
      return fail(e);
    }
  }

  // 回答一张提问卡：他的回答会 resolve 那次挂起的 ask 工具调用（阻塞式），
  // 模型带着答案在同一轮工作流里接着跑；room 定参送进挂起的场屋 ——
  // 他可能切到别的场才想起来答。空答案 = 先不答（让他自己拿主意继续）。
  // 不给来客：他那一间没有 ask 工具，也就不该有卡片可答。
  if (p === "/api/ask/answer" && m === "POST") {
    try {
      const { id, answer, room } = (await readJsonObject(req)) as {
        id?: string;
        answer?: string;
        room?: string;
      };
      if (!id)
        return Response.json({ ok: false, error: "缺少 id" }, { status: 400 });
      const target = room ? agentStub(env, targetRoom(room)) : agent;
      const r = await target.answerAsk(id, answer ?? "");
      // 挂起已经不在（超时放行过、或这间屋重启过）：答案喂不进那次工具调用了。
      // 不能假装成功 —— 前端收到 409 保留答案，由用户核对后决定是否发送
      if (!r.delivered)
        return Response.json(
          { ok: false, error: "这张提问已经过期了（超时或已重开）" },
          { status: 409 },
        );
      return Response.json({ ok: true, data: r.state });
    } catch (e) {
      return fail(e);
    }
  }

  // 公开账本：来客能看的那一档 —— 管理员公开的人物条目 + 他这场自己登记的
  if (p === "/api/memory/public" && m === "GET")
    return readState(agent.publicLedger());
  // 记忆书架
  if (p === "/api/memory" && m === "GET") {
    const person = url.searchParams.get("person");
    const all = url.searchParams.get("includeSuperseded") === "1";
    if (person)
      return readState(
        Promise.resolve(agent.listMemoryOfPerson(person, 200, all)),
      );
    const shelf = url.searchParams.get("shelf") || undefined;
    return readState(Promise.resolve(agent.listMemoryShelf(shelf, 200, all)));
  }
  // 已作废的记忆：历史版本，不再参与检索
  if (p === "/api/memory/history" && m === "GET")
    return readState(Promise.resolve(agent.listMemoryHistory()));
  // 该复核的记忆：说的是现状、又有一阵没核对过的那些
  if (p === "/api/memory/due" && m === "GET")
    return readState(Promise.resolve(agent.listMemoryDueForReview()));
  // 还挂着疑问的记忆：写下来时发现和别的说法像在说同一件事，还没对上
  if (p === "/api/memory/conflicts" && m === "GET")
    return readState(Promise.resolve(agent.listMemoryConflicts()));
  // 人工作答「这两条不是一回事」：疑问销掉，两条都留着
  if (p === "/api/memory/coexist" && m === "POST") {
    try {
      const { id } = (await readJsonObject(req)) as { id?: string };
      if (!id)
        return Response.json({ ok: false, error: "缺少 id" }, { status: 400 });
      return readState(Promise.resolve(agent.settleMemoryConflict(id)));
    } catch (e) {
      return fail(e);
    }
  }
  // 复核确认：记下「我刚核对过它」（可同时改「会不会变」的标记）
  if (p === "/api/memory/confirm" && m === "POST") {
    try {
      const { id, volatility } = (await readJsonObject(req)) as {
        id?: string;
        volatility?: string;
      };
      if (!id)
        return Response.json({ ok: false, error: "缺少 id" }, { status: 400 });
      return readState(
        Promise.resolve(agent.confirmMemoryEntry(id, volatility)),
      );
    } catch (e) {
      return fail(e);
    }
  }
  // 改「会不会变」：会变的那些才会进复核清单
  if (p === "/api/memory/volatility" && m === "POST") {
    try {
      const { id, volatility } = (await readJsonObject(req)) as {
        id?: string;
        volatility?: string;
      };
      if (!id)
        return Response.json({ ok: false, error: "缺少 id" }, { status: 400 });
      return readState(
        Promise.resolve(agent.setMemoryVolatility(id, volatility || "stable")),
      );
    } catch (e) {
      return fail(e);
    }
  }
  // 公开 / 收回一条记忆：点头的事只能由人来做，所以只开面板这一条路
  if (p === "/api/memory/visibility" && m === "POST") {
    try {
      const { id, visibility } = (await readJsonObject(req)) as {
        id?: string;
        visibility?: string;
      };
      if (!id)
        return Response.json({ ok: false, error: "缺少 id" }, { status: 400 });
      return readState(
        Promise.resolve(
          agent.setMemoryVisibility(
            id,
            visibility === "public" ? "public" : "private",
          ),
        ),
      );
    } catch (e) {
      return fail(e);
    }
  }
  // 改一条记忆的量级：五档都在管理员手里，包括绝密 —— 模型的工具里没有那一档。
  // 只开面板这一条路（不在 USER_ROUTES），来客改不了量级。
  if (p === "/api/memory/sensitivity" && m === "POST") {
    try {
      const { id, sensitivity } = (await readJsonObject(req)) as {
        id?: string;
        sensitivity?: string;
      };
      if (!id)
        return Response.json({ ok: false, error: "缺少 id" }, { status: 400 });
      return readState(
        Promise.resolve(
          agent.setMemorySensitivity(id, sensitivity || "normal"),
        ),
      );
    } catch (e) {
      return fail(e);
    }
  }
  // tag 公开门槛：一次拿到「开着哪几道门」+「每个 tag 各量级多少条」。
  // 面板上决定开不开门，这两样要一起看 —— 只看门槛不看分布，等于闭着门拉闸。
  if (p === "/api/memory/tags" && m === "GET")
    // 两个 RPC 调用必须先等齐再装包：stub 方法返回的是 Promise，
    // 直接塞进对象字面量会被 JSON 序列化成 {} —— 前端拿到 gates:{}，
    // 渲染第一行带 tag 的记忆就崩。POST 那条没这毛病（整个 Promise
    // 被 readState 等掉了），GET 是唯一把两个调用拼在一处的地方
    return readState(
      Promise.all([agent.listTagGates(), agent.memoryTagStats()]).then(
        ([gates, stats]) => ({ gates, stats }),
      ),
    );
  if (p === "/api/memory/tags" && m === "POST") {
    try {
      const { tag, maxLevel } = (await readJsonObject(req)) as {
        tag?: string;
        maxLevel?: string;
      };
      if (!tag)
        return Response.json({ ok: false, error: "缺少 tag" }, { status: 400 });
      return readState(Promise.resolve(agent.setTagGate(tag, maxLevel || "")));
    } catch (e) {
      return fail(e);
    }
  }
  // 人脉视图：人物 + 各自记忆条数
  if (p === "/api/persons" && m === "GET")
    return readState(Promise.resolve(agent.listPersonGroups()));
  if (p === "/api/memory/stats" && m === "GET")
    return readState(Promise.resolve(agent.memoryStats()));
  if (p === "/api/memory/search" && m === "GET") {
    const q = url.searchParams.get("q") || "";
    return readState(
      agent.searchMemoryEntries(
        q,
        10,
        url.searchParams.get("includeSuperseded") === "1",
      ),
    );
  }
  // 作废 / 撤销作废：一条记忆被新说法取代，旧的不删，标掉
  if (p === "/api/memory/supersede" && m === "POST") {
    try {
      const { id, restore } = (await readJsonObject(req)) as {
        id?: string;
        restore?: boolean;
      };
      if (!id)
        return Response.json({ ok: false, error: "缺少 id" }, { status: 400 });
      return readState(
        Promise.resolve(agent.supersedeMemoryEntry(id, !!restore)),
      );
    } catch (e) {
      return fail(e);
    }
  }
  if (p === "/api/memory" && m === "POST") {
    try {
      const body = (await readJsonObject(req)) as Record<string, unknown>;
      const content = String(body.content || "").slice(0, 500);
      const shelf = typeof body.shelf === "string" ? body.shelf : undefined;
      const tags = Array.isArray(body.tags)
        ? (body.tags as string[])
        : undefined;
      const volatility =
        typeof body.volatility === "string" ? body.volatility : undefined;
      // 来客走另一条路：只能添一笔，落在他自己那间，同时送一份到主人那儿。
      // 不分流的话，他会拿到 addMemoryEntry 的完整能力（带冲突检测、可指定人物），
      // 那不是「登记」，是把记忆面板搬到了门外。
      // 票里的 type 段必须带过去：这是纯 HTTP 直呼，DO 里没有连接快照可查，
      // 权益核实就靠这一下（拿不到 type = 无法核实 = 那头按没有权益拒绝）。
      if (role !== "admin") {
        const info = await verifyTokenInfo(env, authToken(req));
        return writeState(
          agent.addGuestEntry({
            content,
            shelf,
            tags,
            volatility,
            typeId: info?.type,
          }),
        );
      }
      return writeState(
        agent.addMemoryEntry({
          content,
          type: typeof body.type === "string" ? body.type : "insight",
          shelf,
          tags,
          person: typeof body.person === "string" ? body.person : undefined,
          volatility,
        }),
      );
    } catch (e) {
      return fail(e);
    }
  }
  if (p === "/api/memory/delete" && m === "POST") {
    try {
      const { id } = (await readJsonObject(req)) as { id?: string };
      if (!id)
        return Response.json({ ok: false, error: "缺少 id" }, { status: 400 });
      return readState(agent.removeMemory(id));
    } catch (e) {
      return fail(e);
    }
  }

  // ── 会话记忆：她休息时回头整理出来的那些 ──
  // 三条都收在管理员这边，不进 USER_ROUTES —— 这是她自己回头看留下的东西，
  // 来客不该能按时间、按语气把主人每个晚上的心绪翻一遍。
  if (p === "/api/session-memory" && m === "GET") {
    const limit = Number(url.searchParams.get("limit") || 200);
    return readState(
      Promise.resolve(
        agent.listSessionMemories({
          sessionId: url.searchParams.get("sessionId") || undefined,
          sentiment: url.searchParams.get("sentiment") || undefined,
          from: url.searchParams.get("from") || undefined,
          to: url.searchParams.get("to") || undefined,
          q: url.searchParams.get("q") || undefined,
          limit: Number.isFinite(limit)
            ? Math.min(Math.max(limit, 1), 500)
            : 200,
        }),
      ),
    );
  }
  // 左栏那一列「哪些场我回头看过」：场名、条数、最后一次
  if (p === "/api/session-memory/sessions" && m === "GET")
    return readState(Promise.resolve(agent.sessionMemoryGroups()));
  // 手动让她现在就看一眼。她说「这一场没有新的」，也不是失败，如实回一句
  if (p === "/api/session-memory/recap" && m === "POST") {
    try {
      const { id } = (await readJsonObject(req)) as { id?: string };
      if (!id)
        return Response.json({ ok: false, error: "缺少 id" }, { status: 400 });
      const ran = await agent.recapNow(id);
      return writeState(
        Promise.resolve(
          ran
            ? { recap: true }
            : { recap: false, note: "这一场没有还没记过的新内容。" },
        ),
      );
    } catch (e) {
      return fail(e);
    }
  }

  // 消息反馈：赞 / 踩 / 评论 / 标重。访客也能用，所以这几个路由在 USER_ROUTES 里。
  // room：反馈得跟着「场」走 —— 消息住在场屋里（人屋--场id），写进人屋那间
  // 永远读不回来（聊天那头读的是场屋的库），被踩触发的反思也会找不到那条消息。
  // 点名的屋由 targetRoom 核验前缀，没点名就落回人屋
  if (p === "/api/feedback" && m === "GET")
    return readState(
      Promise.resolve(
        agentStub(
          env,
          targetRoom(url.searchParams.get("room")),
        ).feedbackSummary(role),
      ),
    );
  if (p === "/api/vote" && m === "POST") {
    try {
      const { messageId, value, room } = (await readJsonObject(req)) as {
        messageId?: string;
        value?: unknown;
        room?: string;
      };
      if (!messageId)
        return Response.json(
          { ok: false, error: "缺少 messageId" },
          { status: 400 },
        );
      return writeState(
        Promise.resolve(
          agentStub(env, targetRoom(room)).vote(messageId, role, Number(value)),
        ),
      );
    } catch (e) {
      return fail(e);
    }
  }
  if (p === "/api/comment" && m === "GET") {
    const messageId = url.searchParams.get("messageId");
    if (!messageId)
      return Response.json(
        { ok: false, error: "缺少 messageId" },
        { status: 400 },
      );
    return readState(
      Promise.resolve(
        agentStub(env, targetRoom(url.searchParams.get("room"))).readComments(
          messageId,
        ),
      ),
    );
  }
  if (p === "/api/comment" && m === "POST") {
    try {
      const { messageId, content, room } = (await readJsonObject(req)) as {
        messageId?: string;
        content?: string;
        room?: string;
      };
      if (!messageId || !content?.trim()) {
        return Response.json(
          { ok: false, error: "缺少 messageId 或 content" },
          { status: 400 },
        );
      }
      return writeState(
        Promise.resolve(
          agentStub(env, targetRoom(room)).postComment(
            messageId,
            role,
            content,
          ),
        ),
      );
    } catch (e) {
      return fail(e);
    }
  }
  // 标重：给管理员自己的发言打「要重视」的标记，可多条并存，再点一次取消
  if (p === "/api/flag" && m === "POST") {
    try {
      const { messageId, room } = (await readJsonObject(req)) as {
        messageId?: string;
        room?: string;
      };
      if (!messageId)
        return Response.json(
          { ok: false, error: "缺少 messageId" },
          { status: 400 },
        );
      return writeState(
        Promise.resolve(agentStub(env, targetRoom(room)).toggleFlag(messageId)),
      );
    } catch (e) {
      return fail(e);
    }
  }

  if (p === "/api/organize" && m === "POST") return readState(agent.organize());
  // 打断：让这一轮正在生成的回答停下来。
  // room：正在说话的那间屋 —— 连接可能挂在场屋上，REST 没有连接语义得点名；
  // 老客户端不带 body 也不出错（照旧打断人屋那场）
  if (p === "/api/stop" && m === "POST") {
    const body = (await readJsonObject(req)) as { room?: unknown };
    const room = targetRoom(body.room);
    // 谁按的「停」要留痕：轮次被叫停在界面上只剩一个「中断」，
    // 分不清是 Esc、停止按钮，还是哪条路径误触 —— 和 [stream] 那行对上时间就能定性
    console.warn("[stop] 收到打断请求", { room });
    return readState(agentStub(env, room).stopGenerating());
  }
  // 清空当前这场（消息与压缩摘要一起清）。
  // room：同 /api/stop —— 连接可能挂在场屋上（矩阵工作台那间就是），REST 要清哪间得点名；
  // 不带 body 照旧清人屋那场，老客户端不受影响
  if (p === "/api/clear" && m === "POST") {
    const body = (await readJsonObject(req)) as { room?: unknown };
    await agentStub(env, targetRoom(body.room)).resetActiveSession();
    return Response.json({ ok: true });
  }

  if (p === "/api/export" && m === "GET") {
    return Response.json(await agent.exportData());
  }
  // 一次性迁移：旧 state.longMemory → memories 表 + 向量重建（幂等，可重复调用查状态）
  if (p === "/api/migrate" && m === "POST") {
    try {
      return Response.json({
        ok: true,
        ...(await agentStub(env).runMigration()),
      });
    } catch (e) {
      return fail(e);
    }
  }
  // replace=true 时先清空记忆表与配置态，用于把既有 DO 对齐到新的并集种子
  if (p === "/api/seed" && m === "POST") {
    try {
      const { ops, replace } = (await readJsonObject(req)) as {
        ops?: unknown;
        replace?: unknown;
      };
      if (!Array.isArray(ops)) {
        return Response.json(
          { ok: false, error: "ops 必须是数组" },
          { status: 400 },
        );
      }
      return Response.json({
        ok: true,
        ...(await agentStub(env).importSeed(ops, replace === true)),
      });
    } catch (e) {
      return fail(e);
    }
  }

  return Response.json({ ok: false, error: "not found" }, { status: 404 });
}

// ── 入口 ───────────────────────────────────────────────

export default {
  /**
   * 收信入口：Cloudflare Email Routing 把整封外交到这儿（域名那侧把本 Worker 设成投递目标）。
   *
   * 这一头没有任何鉴权 —— 公网任何人都能往这里寄 —— 所以它只做一件事：把原件取出来
   * 交给主屋。开关、体积上限、指纹去重、落库全在 mailIngest 那侧（fail-closed 在那儿）。
   * 读不出原件时**不抛**：抛了平台会重投，而读不出的东西投十次还是读不出。
   * 反过来，主屋一时唤不醒这类暂态要抛回去：悄悄丢一封来信，比多投一次贵得多。
   */
  async email(message: unknown, env: Env): Promise<void> {
    const raw = (message as { raw?: ReadableStream }).raw;
    if (!raw) {
      console.warn("[mail] 这封投递里没有 raw 段，跳过");
      return;
    }
    let text: string;
    try {
      text = await new Response(raw).text();
    } catch (e) {
      console.warn("[mail] 原件读不出来", String((e as Error)?.message ?? e));
      return;
    }
    try {
      const r = await agentStub(env).mailIngest(text);
      if (!r.ok && !r.duplicate) console.warn("[mail] 这封没收进收件箱", r.error);
    } catch (e) {
      console.warn("[mail] 收信入库异常，交回平台重投", String((e as Error)?.message ?? e));
      throw e;
    }
  },
  fetch(req: Request, env: Env): Promise<Response> {
    // 兜底：矩阵认领、静态回退这些不在局部 try 里的路径一旦失败，冒出 Worker 就是
    // Cloudflare 的 1101 纯文本页 —— 前端拿不到 {ok:false}，用户只看到「网站坏了」。
    async function run(): Promise<Response> {
      const url = new URL(req.url);
      const p = url.pathname;

      if (p === "/favicon.ico" || p === "/favicon.svg") {
        return new Response(FAVICON, {
          headers: {
            "Content-Type": "image/svg+xml",
            "Cache-Control": "public, max-age=86400",
          },
        });
      }

      // 登录 / 登出是唯一无需鉴权的接口
      if (p === "/api/auth")
        return req.method === "POST" ? handleLogin(req, env) : methodNotAllowed();
      if (p === "/api/logout")
        return Response.json(
          { ok: true },
          { headers: { "Set-Cookie": clearCookie(cookieSecure(req)) } },
        );

      // ── 身份卡：登卡是免门禁的（卡本身就是钥匙），限速与门禁同一套 ──
      if (p === "/api/card/login" && req.method === "POST")
        return handleCardLogin(req, env);

      // /api/cards（管理员看名册）是另一个接口：前缀判断把它排出去，
      // 不然它会掉进下面这格「来客领卡」的闸里 —— 那格只放 user，
      // 管理员到此就吃 401 被踢回登录页，名册处理器根本轮不到
      if (p.startsWith("/api/card") && p !== "/api/cards") {
        const info = await verifyTokenInfo(env, authToken(req));
        if (!info || info.role !== "user") return unauthorized();
        // 领卡（把当前临时会话升级成长期）：当前房绑定到新卡，历史一条不搬
        if (p === "/api/card" && req.method === "POST") {
          let body: {
            name?: unknown;
            purpose?: unknown;
            password?: unknown;
            email?: unknown;
          };
          try {
            body = (await readJsonObject(req)) as typeof body;
          } catch {
            return Response.json(
              { ok: false, error: "请求格式错误" },
              { status: 400 },
            );
          }
          if (info.card)
            return Response.json(
              { ok: false, error: "这张票已经带着卡了" },
              { status: 409 },
            );
          const room = await agentNameForToken(env, "user", authToken(req));
          try {
            const card = await agentStub(env).createCard({
              name: String(body.name ?? ""),
              purpose: String(body.purpose ?? ""),
              password: String(body.password ?? ""),
              email: body.email === undefined ? undefined : String(body.email),
              typeId: info.type || COMMON_TYPE_ID,
              room,
            });
            const token = await issueToken(
              env,
              "user",
              undefined,
              card.typeId,
              card.id,
            );
            const agent = await agentNameForToken(env, "user", token);
            return Response.json(
              { ok: true, role: "user", agent, card },
              {
                headers: {
                  "Set-Cookie": sessionCookie(token, cookieSecure(req)),
                },
              },
            );
          } catch (e) {
            return Response.json(
              { ok: false, error: (e as Error).message },
              { status: 400 },
            );
          }
        }
        // 当前卡信息：身份卡弹层用。临时票返回 card:null（前端显示「未领卡」）
        if (p === "/api/card" && req.method === "GET") {
          const card = info.card
            ? await agentStub(env).cardInfo(info.card)
            : null;
          return Response.json({ ok: true, card });
        }
        // 解卡：长卡退回临时态（同一档位换张无卡票）。房间里的东西还在卡上，
        // 再登卡就回来 —— 解卡只是这台设备不再持卡
        if (p === "/api/card/detach" && req.method === "POST") {
          const token = await issueToken(env, "user", undefined, info.type);
          const agent = await agentNameForToken(env, "user", token);
          return Response.json(
            { ok: true, role: "user", agent },
            {
              headers: { "Set-Cookie": sessionCookie(token, cookieSecure(req)) },
            },
          );
        }
      }

      // ── 主题：读全局可见（门口/Gate 未登录也要看得到皮肤），写在 handleApi 里 ──
      if (p === "/api/theme" && req.method === "GET") return handleThemeGet(env);
      if (p.startsWith("/api/theme-asset/") && req.method === "GET") {
        let name = p.slice("/api/theme-asset/".length);
        try {
          name = decodeURIComponent(name);
        } catch {
          // 不是合法编码就按原样查（handleServe 对 key 同款兜底）
        }
        return handleThemeAsset(env, name);
      }

      // 矩阵包推送入口：给「本地/自动化把一个矩阵包直接推上云」留的一条道。
      // 只有配了 MATRIX_PUSH_TOKEN 才启用；未配（默认）时这里整个不生效，
      // 推包仍只有工作台那一处。仅认这一条路由，且必须是 POST。
      // 这里的 admin 上下文不是冒充：这条路上没有会话，认的是那把推送 token 本身。
      if (
        p === "/api/matrix/pack" &&
        req.method === "POST" &&
        matrixPushAllowed(req, env)
      )
        return handleMatrixApi(req, env, p, { role: "admin" });

      if (p.startsWith("/api/")) {
        const role = await authRole(req, env);
        if (!role) return unauthorized();
        try {
          // 出口统一包一层滑动续期：票进了半程就在这个响应上换新（见 renewIfNeeded）
          return await renewIfNeeded(
            req,
            env,
            await handleApi(req, env, url, role),
          );
        } catch (e) {
          return fail(e);
        }
      }

      // /agents/*：钩子在唤醒 DO 之前执行，返回 Response 即短路拒绝。
      // 除了验登录，还要核对「进的是哪一间」—— 一个 DO 只有一份对话，
      // 来客要是能把地址里的名字改成 default，就等于直接进了主人的屋子。
      const guard = async (r: Request) => {
        const role = await authRole(r, env);
        if (!role) return unauthorized();
        const name = agentNameInPath(new URL(r.url).pathname);
        const room = await agentNameFor(r, env, role);
        // 本人的屋，或本人名下的场屋（room--sessionId，一个会话一间完整运行时）：
        // 前缀派生不可伪造 —— 冒用别人的前缀只能给自己开野场，进不了别人的屋
        if (name && name !== room && !name.startsWith(room + "--"))
          return forbidden();
        return undefined;
      };
      try {
        const agentResponse = await routeAgentRequest(req, env, {
          onBeforeConnect: guard,
          onBeforeRequest: guard,
        });
        if (agentResponse) return agentResponse;
      } catch (e) {
        // 唤醒失败（最常见的是配额用尽）：回一句人话，别让前端一直卡在「连接中」
        return fail(e);
      }

      // 网页矩阵：非保留路径先请矩阵认领 —— 它认领了（认得出这个层级路径、
      // 或按入口页规则要 302）就回正文，认领不了（返回 null）就落到下面交还应用。
      // 根 `/` 也走这条：公开访客在此被 302 去入口页，登录用户与管理员则回落接待台。
      if (!isReservedPath(p)) {
        const res = await serveMatrixPage(req, env, await matrixViewerOf(req, env), p);
        if (res) return res;
      }

      return env.ASSETS.fetch(req);
    }
    // 用 .catch 而不是 try/catch：路由里大量 `return handleX(...)` 没 await，
    // 这类 promise 拒绝会直接交付出 try/catch 的覆盖范围，只有挂在返回值上才收得住。
    return run().catch(fail);
  },
};
