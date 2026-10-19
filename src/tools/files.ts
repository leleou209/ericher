// R2 记忆库文件操作：破坏性操作要求显式 confirm，clear 必须给前缀。
// 房间划界：同一只桶、屋子分开。来客那间的 list/read/delete/clear 一律限 f/<room>/… ——
// 否则一次「列目录」就翻出全库文件名，一个 delete 就能删别家；管理员不设限。
// 文件夹是纯约定（key 路径即目录，会话/<id>/ 是产物归档处）；mkdir 用 .keep 撑空夹，move 是 copy+delete。

import { tool } from "ai";
import { z } from "zod";
import { FOLDER_KEEP, roomKeyPrefix, safeKeyPath } from "../fileAccess";
import type { ToolCtx } from "./types";

function fmtSize(n: number): string {
  if (n < 1024) return n + "B";
  if (n < 1048576) return (n / 1024).toFixed(1) + "KB";
  return (n / 1048576).toFixed(1) + "MB";
}

/** 网页矩阵的配置落点（与 src/matrix/core.ts 的 CONFIG_KEY 一致） */
const MATRIX_CONFIG_KEY = "matrix/config.json";

/**
 * 网页矩阵页引用着的云盘文件：key → 引用它的页面路径们。矩阵页正文可以直接引用云盘文件
 * （实时读，不拷副本），删它/搬它页面当场没正文。配置读不到或坏了就返回空表 ——
 * 矩阵是可选的，不该因为它的配置问题把云盘锁死。
 */
async function matrixDriveRefs(
  bucket: R2Bucket,
): Promise<Map<string, string[]>> {
  const refs = new Map<string, string[]>();
  try {
    const obj = await bucket.get(MATRIX_CONFIG_KEY);
    if (!obj) return refs;
    const cfg = JSON.parse(await obj.text()) as {
      pages?: Array<{ path?: unknown; driveKey?: unknown }>;
    };
    for (const p of cfg.pages ?? []) {
      const key = typeof p.driveKey === "string" ? p.driveKey : "";
      if (!key) continue;
      const arr = refs.get(key) ?? [];
      arr.push(String(p.path ?? "（未命名页面）"));
      refs.set(key, arr);
    }
  } catch {
    // 按没引用处理：宁可漏拦，也不能因为读不到配置就让整库文件动不了
  }
  return refs;
}

/** 这批 key 里有没有被矩阵页引用的；有就回绝并说清是谁引用的，没有返回 null */
export async function matrixRefGuard(
  bucket: R2Bucket,
  keys: string[],
  action: string,
): Promise<string | null> {
  const refs = await matrixDriveRefs(bucket);
  if (!refs.size) return null;
  const hits = keys
    .filter((k) => refs.has(k))
    .map((k) => `${k}（被页面 /${refs.get(k)!.join("、/")} 引用）`);
  if (!hits.length) return null;
  return (
    `网页矩阵正在引用这些文件，${action}不了：${hits.join("；")}。` +
    "要动它，先去矩阵里把那一页的正文来源换成别的，再来。"
  );
}

export function fileTools(ctx: ToolCtx) {
  return {
    files: tool({
      description:
        "记忆库文件（对象存储）操作。action=list 列目录；read 读文本内容；" +
        "delete 删除单个文件（需 confirm=true）；clear 按前缀批量删除（需 confirm=true，且必须提供 prefix）；" +
        "mkdir 新建文件夹（path 可以多级，如 f/default/个人/合同）；" +
        "move 移动或重命名（from = 现在的 key，to = 完整去处 key；改名 = 同目录换文件名，" +
        "from 是文件夹前缀时整夹搬）。",
      inputSchema: z
        .object({
          action: z.enum(["list", "read", "delete", "clear", "mkdir", "move"]),
          key: z
            .string()
            .optional()
            .describe("文件名，read / delete 时必填；move 时是「从哪搬」"),
          prefix: z
            .string()
            .optional()
            .describe("clear 时必填，只删除以此为前缀的文件"),
          path: z
            .string()
            .optional()
            .describe("mkdir 时必填：要建的文件夹路径，可以一次建几级"),
          to: z
            .string()
            .optional()
            .describe("move 时必填：完整的去处 key（含文件名）"),
          confirm: z
            .boolean()
            .default(false)
            .describe("破坏性操作必须显式置 true"),
        })
        .superRefine((a, refine) => {
          // action 的条件必填在 schema 层就拦下：错误信息里曾经写错字段名（from/key），
          // 模型照着错误重试永远失败 —— 现在校验直接说清缺什么
          const needKey =
            a.action === "read" || a.action === "delete" || a.action === "move";
          if (needKey && !(a.key || "").trim())
            refine.addIssue({
              code: "custom",
              path: ["key"],
              message: `${a.action} 必填：文件 key（list 里能看到）`,
            });
          if (a.action === "move" && !(a.to || "").trim())
            refine.addIssue({
              code: "custom",
              path: ["to"],
              message: "move 必填：完整的去处 key（含文件名）",
            });
          if (a.action === "clear" && !(a.prefix || "").trim())
            refine.addIssue({
              code: "custom",
              path: ["prefix"],
              message: "clear 必填：要清空的前缀",
            });
          if (a.action === "mkdir" && !(a.path || "").trim())
            refine.addIssue({
              code: "custom",
              path: ["path"],
              message: "mkdir 必填：文件夹路径，可以多级",
            });
        }),
      execute: async ({ action, key, prefix, path, to, confirm }) => {
        const bucket = ctx.env.MEMORY_BUCKET;
        if (!bucket) return "记忆库未配置。";
        // 来客那间的可见范围：自己房间的文件。老对象（没有房间前缀）不在范围内
        const scope = ctx.guest ? roomKeyPrefix(ctx.room) : "";
        const inScope = (k: string) => !scope || k.startsWith(scope);

        if (action === "list") {
          // 单次 list 只回一页，超出的文件会无声消失：翻到上限还没列完就如实说只给了前一批
          const LIST_MAX = 500;
          const objects: R2Object[] = [];
          let cursor: string | undefined;
          let more = false;
          while (objects.length < LIST_MAX) {
            const list = await bucket.list({
              prefix: scope || undefined,
              cursor,
              limit: LIST_MAX - objects.length,
            });
            objects.push(...list.objects);
            if (!list.truncated) break;
            cursor = list.cursor;
            more = true;
          }
          if (!objects.length) return "文件库是空的 📭";
          return (
            `📦 ${objects.length} 个文件${
              more ? `（文件较多，这里只列了前 ${LIST_MAX} 个，还有更多没列出）` : ""
            }：\n` +
            objects
              .map((o, i) => `${i + 1}. ${o.key} (${fmtSize(o.size)})`)
              .join("\n")
          );
        }

        if (action === "read") {
          if (!key) return "read 需要提供 key。";
          if (!inScope(key)) return "文件不存在：" + key;
          const obj = await bucket.get(key);
          if (!obj) return "文件不存在：" + key;
          const text = await obj.text();
          return `📄 ${key}\n\n${text.slice(0, 6000)}${text.length > 6000 ? "\n\n[已截断]" : ""}`;
        }

        if (action === "mkdir") {
          if (!path) return "mkdir 需要提供 path（文件夹路径）。";
          let base: string;
          try {
            base = safeKeyPath(path);
          } catch (e) {
            return `这个路径用不了：${(e as Error).message}`;
          }
          if (!inScope(base))
            return "这个路径超出了本间的文件范围，建夹只能建在自己那间。";
          await bucket.put(`${base}/${FOLDER_KEEP}`, "", {
            httpMetadata: { contentType: "application/x-empty" },
          });
          return `文件夹建好了：${base}/（之后往里放文件就用这个前缀）。`;
        }

        if (action === "move") {
          if (!key || !to)
            return "move 需要提供 key（现在在哪）和 to（完整去处 key）。";
          let src = "";
          let dst = "";
          try {
            src = safeKeyPath(key);
            dst = safeKeyPath(to);
          } catch (e) {
            return `这个路径用不了：${(e as Error).message}`;
          }
          if (!inScope(src) || !inScope(dst))
            return "搬进或搬出的路径超出了本间的文件范围，只能动自己那间的。";
          if (src === dst) return "原地不动，不用搬。";
          if (dst.startsWith(`${src}/`))
            return "不能把文件夹搬进它自己里面 —— 换个去处。";
          // 精确命中一个对象：就是移动 / 改名一个文件
          const obj = await bucket.get(src);
          if (obj) {
            // 被矩阵页引用着的文件不许搬：搬走那一页就读不到正文了
            const refGuard = await matrixRefGuard(bucket, [src], "搬");
            if (refGuard) return refGuard;
            // 目标撞名就地覆盖是不可恢复的（源也跟着删了）—— 先拦下来让人改名，别静默覆盖
            if (await bucket.head(dst))
              return `目标已存在：${dst}（换个名字或先删掉旧的，别静默覆盖）`;
            await bucket.put(dst, obj.body, {
              httpMetadata: obj.httpMetadata,
              // customMetadata（主题导入记的 sourceKey 来路）要跟着走：move 是 copy+delete，
              // 不捎上就被剥掉，导入去重会把同一条云盘文件当成两个来路
              customMetadata: obj.customMetadata,
            });
            await bucket.delete(src);
            return `搬好了：${src} → ${dst}`;
          }
          // 没精确命中就当前缀：整个文件夹逐个 copy + delete。先把整夹 key 攒齐、过引用检查再动手 ——
          // 边搬边撞到引用中途停手，就剩半个文件夹散在外头
          const srcPrefix = `${src}/`;
          const keys: string[] = [];
          let cursor: string | undefined;
          do {
            const list = await bucket.list({
              prefix: srcPrefix,
              cursor,
              limit: 500,
            });
            keys.push(...list.objects.map((o) => o.key));
            cursor = list.truncated ? list.cursor : undefined;
          } while (cursor);
          const refGuard = await matrixRefGuard(bucket, keys, "搬");
          if (refGuard) return refGuard;
          let moved = 0;
          for (const key of keys) {
            const one = await bucket.get(key);
            if (!one) continue;
            await bucket.put(`${dst}/${key.slice(srcPrefix.length)}`, one.body, {
              httpMetadata: one.httpMetadata,
              // 同上：customMetadata（sourceKey 来路）跟着搬走，别被剥掉
              customMetadata: one.customMetadata,
            });
            await bucket.delete(key);
            moved++;
          }
          return moved
            ? `整个文件夹搬好了（${moved} 个文件）：${src}/ → ${dst}/`
            : `没有这个文件或文件夹：${src}`;
        }

        if (action === "delete") {
          if (!key) return "delete 需要提供 key。";
          if (!inScope(key)) return "文件不存在：" + key;
          // R2 删一个不存在的 key 也算成功：不先看一眼，就会回「已删除」一个本来就没有的东西
          if (!(await bucket.head(key))) return "没有这个文件：" + key;
          if (!confirm)
            return `删除是不可逆操作。确认要删除「${key}」的话，请带 confirm=true 再调用一次。`;
          // 被矩阵页引用着的文件删不得：删了那一页当场没有正文
          const refGuard = await matrixRefGuard(bucket, [key], "删");
          if (refGuard) return refGuard;
          await bucket.delete(key);
          return "已删除：" + key;
        }

        if (!prefix) return "clear 必须提供 prefix（避免误清整个桶）。";
        if (!inScope(prefix))
          return "这个前缀超出了本间的文件范围，clear 只能动自己那间的文件。";
        if (!confirm)
          return `clear 将删除所有以「${prefix}」开头的文件。确认请带 confirm=true 再调用一次。`;
        // 先列全、过一遍矩阵引用检查，再删 —— 免得删到一半撞上引用，剩下半截
        const doomed: string[] = [];
        let cursor: string | undefined;
        do {
          const list = await bucket.list({ prefix, cursor, limit: 500 });
          doomed.push(...list.objects.map((o) => o.key));
          cursor = list.truncated ? list.cursor : undefined;
        } while (cursor);
        const refGuard = await matrixRefGuard(bucket, doomed, "清");
        if (refGuard) return refGuard;
        let deleted = 0;
        for (const k of doomed) {
          await bucket.delete(k);
          deleted++;
        }
        return `已按前缀「${prefix}」清空 ${deleted} 个文件。`;
      },
    }),
  };
}
