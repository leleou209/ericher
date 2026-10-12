// 云盘文件的房间约定与读取权限。
//
// R2 是同一只桶，但屋子是分开的：文件 key 一律带上归属房间的前缀
// （f/<DO 名>/…），读取时管理员全库可见，来客只能读自己那间画出来/存下来的。
// 没有前缀的老对象（前缀约定之前的存量）对来客一律不可见 —— 那些图他本来也
// 看不了（/api/files 曾是管理员专属），不是回退，是把「看不了」的原因写明。
//
// key 里同时带一段随机量：光有时间戳的话，毫秒级枚举就能撞到别人的文件名。

/** 某间屋子的文件都住在这个前缀下（尾斜杠保证前缀匹配不会撞进相似房间名） */
export function roomKeyPrefix(room: string): string {
  return `f/${room}/`;
}

/**
 * 这间屋子「算自己人」的全部前缀：人屋本尊 + 它名下的各个场屋。
 *
 * 产物 key 用的是「当时那间屋」的名字：在场屋里画出来的图，前缀是
 * `f/人屋--场id/`；而 REST 那侧算房间时只会算到人屋 —— 不认这一层，
 * 来客在自己场屋里画出来的图，他自己都打不开（管理员不受影响，全库可见）。
 * 第二个前缀故意不带尾斜杠：`f/人屋--` 才匹配得上 `f/人屋--场id/`，
 * 而别人的屋名不会以它开头。
 */
export function roomKeyPrefixes(room: string): string[] {
  const i = room.indexOf("--");
  const owner = i === -1 ? room : room.slice(0, i);
  // 自己那间 + 人屋本尊 + 人屋名下的场屋一族（三者在人屋本尊那一档会重合，去重）
  return [...new Set([`f/${room}/`, `f/${owner}/`, `f/${owner}--`])];
}

/**
 * 公开空间：key 在这个前缀下的文件，登录进来的人谁都读得到。
 * 不是一间「屋子」——没有门票指向它，它只是把「愿意给所有人看的」
 * 和「只属于某间屋的」在 key 上分开。permPublic 权益管的是谁能往里放。
 */
export const PUBLIC_PREFIX = "f/public/";

/** 给某间屋子生成一个新文件 key：f/<room>/<base>-<时间戳>-<随机段>.<ext> */
export function scopedKey(
  room: string,
  base: string,
  ext: string,
  folder = "",
): string {
  const rand = crypto.randomUUID().slice(0, 8);
  const dir = folder ? `${folder}/` : "";
  return `${roomKeyPrefix(room)}${dir}${base}-${Date.now()}-${rand}.${ext}`;
}

// ── 虚拟文件夹 ────────────────────────────────────────
//
// R2 没有真文件夹，目录就是 key 里的路径前缀。这里把「文件夹」做成纯约定：
// 产物按会话归档（会话/<id>/…），人建的文件夹是任意路径段，空文件夹用
// 一个 .keep 占位对象撑着 —— 不迁数据、不建表，旧 key 原地不动就是根下的文件。

/** 会话归档目录名（一段中文路径，树形界面里直接按这个名字显示） */
export const SESSION_FOLDER = "会话";

/** 建空文件夹时塞进去的占位对象名：列表里不显示，只负责让前缀「存在」 */
export const FOLDER_KEEP = ".keep";

/**
 * 给会话产物生成 key：f/<room>/会话/<sessionId>/<base>-<时间戳>-<随机段>.<ext>。
 * 没有会话（老调用点、场外跑的活）退回旧路 —— 和改造前的行为一字不差。
 * 产物跟着会话走：回头在云盘树里按会话翻，比在一堆时间戳里大海捞针强。
 */
export function sessionKey(
  room: string,
  sessionId: string | undefined,
  base: string,
  ext: string,
): string {
  const rand = crypto.randomUUID().slice(0, 8);
  const folder = sessionId ? `${SESSION_FOLDER}/${sessionId}/` : "";
  return `${roomKeyPrefix(room)}${folder}${base}-${Date.now()}-${rand}.${ext}`;
}

/**
 * 美化包（主题包 zip）在云盘里的特殊文件夹：装备过的包都在这里留一份底。
 * 落公开空间 —— 皮肤本来就是全局可见的东西，包也一样：谁都能翻出来
 * 再下载、再装备。名字带时间戳和随机段，同名包传两次是两份，都留着。
 */
export const THEME_PACK_FOLDER = "betpag";

/** 美化包归档 key：f/public/betpag/<名字>-<时间戳>-<随机段>.zip */
export function themePackKey(name: string): string {
  const raw = String(name ?? "")
    .replace(/\.zip$/i, "")
    .replace(/[/\\?%*:|"<>]/g, "_")
    .slice(0, 60);
  return scopedKey("public", raw || "ericher-theme", "zip", THEME_PACK_FOLDER);
}

/**
 * 把人给的文件夹路径洗净成安全的相对路径（"a/b" 形状）。
 * 每段都得是正经名字：不为空、不是 . 或 ..、不带控制字符和路径分隔符、
 * 长度有限、层级有限 —— 路径是拿去拼 R2 key 的，这里不干净，
 * 「移动到 ../别人家/」那种事就会从拼 key 这一步溜进去。不合法直接抛错。
 */
export function safeFolder(input: string, maxDepth = 6): string {
  const segs = String(input)
    .split("/")
    .map((s) => s.trim())
    .filter((s) => s !== "");
  if (!segs.length) return "";
  if (segs.length > maxDepth)
    throw new Error(`文件夹层级太深（最多 ${maxDepth} 层）`);
  for (const s of segs) {
    if (s === "." || s === "..") throw new Error("文件夹名不能是 . 或 ..");
    if (/[\\/:*?"<>|\u0000-\u001f]/.test(s) || s.length > 80)
      throw new Error(`文件夹名不合法：${s.slice(0, 20)}`);
  }
  return segs.join("/");
}

/**
 * 把一整条 key 路径按段洗净（「f/room/子目录/名字」原样保留形状）。
 * 和 safeFolder 同一套段规则，但不钉房间前缀 —— 前缀划界是调用方的事
 * （fileScopeFor + assertInScope），这里只管「别让路径长出脚来」。
 */
export function safeKeyPath(input: string): string {
  const segs = String(input)
    .split("/")
    .map((s) => s.trim())
    .filter((s) => s !== "");
  if (!segs.length) throw new Error("路径不能为空");
  if (segs.length > 12) throw new Error("路径层级太深");
  for (const s of segs) {
    if (s === "." || s === "..") throw new Error("路径段不能是 . 或 ..");
    if (/[\\:*?"<>|\u0000-\u001f]/.test(s) || s.length > 80)
      throw new Error(`路径段不合法：${s.slice(0, 20)}`);
  }
  return segs.join("/");
}

/**
 * 云盘写操作的范围检查：来客的 key 必须落在自己房间前缀之下，
 * 管理员 scope 为空串（整只桶）。越界就抛 —— 调用方把话转给界面。
 */
export function assertInScope(key: string, scope: string | string[]): void {
  const list = Array.isArray(scope) ? scope : [scope];
  // 空串 = 管理员（整只桶）；多前缀 = 来客（人屋本尊 + 他名下的场屋）
  if (list.includes("")) return;
  if (!list.some((s) => key.startsWith(s)))
    throw new Error("这个操作超出了你那间的文件范围");
}

/** 谁能读这个 key：管理员全库可见；来客读自己房间前缀下的，公开空间人人都读得 */
export function canReadFile(
  key: string,
  role: "admin" | "user",
  room: string,
): boolean {
  if (role === "admin") return true;
  if (key.startsWith(PUBLIC_PREFIX)) return true;
  return roomKeyPrefixes(room).some((p) => key.startsWith(p));
}

/**
 * 云盘对象响应的通用头。
 *
 * HTML / SVG / XHTML 是「当文档打开就跑脚本」的东西，响应一律压进 CSP sandbox
 * （不透明源）：就算有人把链接发给管理员点开，页面里的脚本也拿不到同源
 * 权限，调不了带 cookie 的管理接口。SVG 是图纸工具的直接产物——来客画得
 * 出来、管理员点得开，它跟 text/html 一样是文档，不是图片。
 * 判断按去参数后的媒体类型来：上传存的类型可能带着 `; charset=utf-8`，
 * 精确匹配会把这一类漏到 sandbox 外面去。
 */
export function fileResponseHeaders(
  contentType: string,
  isPublic = false,
): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": contentType,
    // 私有对象的同一 URL 可能在同一浏览器中跨登录态复用，不交给共享或本地缓存。
    "Cache-Control": isPublic
      ? "public, max-age=86400, immutable"
      : "private, no-store",
  };
  const media = contentType.split(";")[0].trim().toLowerCase();
  const asDocument =
    media === "text/html" ||
    media === "image/svg+xml" ||
    media === "application/xhtml+xml";
  if (media.startsWith("image/") || asDocument)
    headers["x-robots-tag"] = "noindex";
  if (media.startsWith("image/")) headers["Content-Disposition"] = "inline";
  if (asDocument) headers["Content-Security-Policy"] = "sandbox allow-scripts";
  return headers;
}
