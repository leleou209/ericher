// 笔记本工具：我和管理员一起写的本子。与 memory 的分工必须在 description 里说清，否则会互相吞掉：
//   memory —— 我记住的（措辞我定，他读到的是转述）；note —— 他要留的（原话、成篇、Markdown 保结构）。
// 他以前说「留着」只能塞进记忆，而记忆是我消化过的产物；他要的是原稿，不是读书笔记。
// 写不写、怎么写归我（语义判断），落库、压旧版、裁版本、查 id 归代码（noteStore.ts）。

import { tool } from "ai";
import { z } from "zod";
import { NOTE_CAP, NOTE_BODY_MAX, describeNote } from "../agent/noteStore";
import type { ToolCtx } from "./types";

/** read 一次最多吐这么多字：整本倒给模型既烧钱又没意义，剩下的让他自己再翻一次 */
const READ_LIMIT = 8000;

export function noteTools(ctx: ToolCtx) {
  return {
    note: tool({
      description:
        "和用户共用的笔记本，一篇一篇的 Markdown。\n" +
        "它和 memory 不是一回事：memory 是「我记住的东西」（措辞是我定的，他读到的是我的转述）；" +
        "note 是「他要留下的东西」（他的原话、成篇、保结构）。" +
        "他让我把一件事写下来留着、或者让我整理他正在写的那一篇，我用 note，不用 memory。\n" +
        "list 看笔记本里有哪些篇（给 q 按词搜，给 tag 按标签筛）；" +
        "read 读正文（一次最多 " +
        READ_LIMIT +
        " 字，没读完的带 offset 续读；不给 id 就读他此刻正在看的那一篇）；" +
        "new 新建一篇；write 整体改写某一篇的正文（⚠️ 这是覆盖式的，他会看到的是我改完的版本）；" +
        "append 在一篇末尾追加一段（不想动他写过的字时走这条）；" +
        "tag 改标签（tags 是要加上的，untag 是要拿掉的）；delete 删掉一整篇。\n" +
        "我改过的字会记成「我改的」，他那边看得出来 —— 所以改完我在对话里说清我动了哪几处。\n" +
        "旧版本代码会替每一篇留最近几个，恢复在面板上做——别跟他说「我来退回去」，我手里没有恢复这一手。" +
        `笔记本上限 ${NOTE_CAP} 篇，单篇正文上限 ${NOTE_BODY_MAX} 字。`,
      inputSchema: z
        .object({
          action: z.enum([
            "list",
            "read",
            "new",
            "write",
            "append",
            "tag",
            "delete",
          ]),
          id: z
            .string()
            .optional()
            .describe(
              "read/write/append/tag/delete 用的笔记 id（list 里能看到）",
            ),
          title: z.string().optional().describe("new/write 选填：这一篇叫什么"),
          body: z
            .string()
            .optional()
            .describe("new/write 的正文（Markdown 原文）"),
          text: z
            .string()
            .optional()
            .describe("append 要追加的那一段（Markdown）"),
          tags: z
            .string()
            .optional()
            .describe("new/write/tag：要加上的标签，逗号分隔"),
          untag: z.string().optional().describe("tag：要拿掉的标签，逗号分隔"),
          q: z.string().optional().describe("list：按词搜（命中标题或正文）"),
          tag: z.string().optional().describe("list：按标签筛，精确命中"),
          offset: z
            .number()
            .int()
            .min(0)
            .optional()
            .describe(
              "read 续读：上次返回里说从第几字接着读，就填那个数；首次读不填",
            ),
        })
        .superRefine((a, refine) => {
          // action 的条件必填在 schema 层就拦下：写操作缺 id/正文到执行层才报错，
          // 会被统计记成成功，模型也白花一步
          const needId =
            a.action === "write" ||
            a.action === "append" ||
            a.action === "tag" ||
            a.action === "delete";
          if (needId && !(a.id || "").trim())
            refine.addIssue({
              code: "custom",
              path: ["id"],
              message: `${a.action} 必填：笔记 id（list 里能看到；read 不给 id 读他正在看的那篇）`,
            });
          if ((a.action === "write" || a.action === "new") && !a.body?.trim())
            refine.addIssue({
              code: "custom",
              path: ["body"],
              message: `${a.action} 必填：正文（Markdown 原文）`,
            });
          if (a.action === "append" && !a.text?.trim())
            refine.addIssue({
              code: "custom",
              path: ["text"],
              message: "append 必填：要追加的那一段（Markdown）",
            });
        }),
      execute: (a) => {
        // 标签在工具里是逗号串，到了 store 才是数组 —— 让模型少写一层 JSON 括号
        const split = (s?: string) =>
          (s || "")
            .split(/[,，]/)
            .map((t) => t.trim())
            .filter(Boolean);

        if (a.action === "list") {
          const rows = ctx.listNotes({ q: a.q, tag: a.tag });
          if (!rows.length) {
            const why = a.q || a.tag ? "没有对上的" : "本子还空着";
            return `${why}。要用 note 的 new 起一篇吗？`;
          }
          return (
            `本子上有 ${rows.length} 篇${a.q || a.tag ? "（筛过的）" : ""}：\n` +
            rows
              .map(
                (n) =>
                  `${describeNote(n)}${n.preview ? `\n    ${n.preview}` : ""}`,
              )
              .join("\n")
          );
        }

        if (a.action === "read") {
          const target = a.id ? ctx.readNote(a.id) : ctx.focusedNote();
          if (!target) {
            return a.id
              ? `没有 id 为 ${a.id} 的那一篇 —— 先用 list 看一眼。`
              : "他这会儿没打开哪一篇笔记。先用 list 挑一篇，或者问他在说哪篇。";
          }
          // 分页读：长文一次全倒给模型既烧钱又挤窗口；没读完的给明确的续读位
          const offset = Math.max(0, a.offset ?? 0);
          const slice = target.body.slice(offset, offset + READ_LIMIT);
          const next = offset + READ_LIMIT;
          const more =
            next < target.body.length
              ? `\n\n…（未读完：正文共 ${target.body.length} 字，这次读到 ${next}。` +
                `要看后文就再调一次 read，带 offset=${next}）`
              : "";
          return (
            `《${target.title}》${target.tags.length ? `｜标签：${target.tags.join("、")}` : ""}` +
            `｜${target.updatedBy === "assistant" ? "上次我改的" : "上次他改的"}\n` +
            `id：${target.id}\n\n${slice}${more}`
          );
        }

        if (a.action === "new") {
          const body = (a.body || "").trim();
          if (!body && !(a.title || "").trim())
            return "new 至少要给 title 或 body —— 空的一篇他自己也不知道是什么。";
          try {
            const n = ctx.saveNote({
              title: a.title,
              body,
              tags: split(a.tags),
            });
            return `起了新的一篇：《${n.title}》（id：${n.id}）。以后说「那篇讲什么的」我按标题找。`;
          } catch (e) {
            return (e as Error).message;
          }
        }

        if (
          a.action === "write" ||
          a.action === "append" ||
          a.action === "tag" ||
          a.action === "delete"
        ) {
          // 这四种都要落到某一篇上：不给 id 就往「他正在看的那一篇」上落 ——
          // 他指着屏幕说「这篇」，指的多半就是它
          const id = (a.id || "").trim() || (ctx.focusedNote()?.id ?? "");
          if (!id)
            return `${a.action} 需要 id，但他这会儿也没打开哪一篇 —— 先用 list 挑一篇。`;
          const old = ctx.readNote(id);
          if (!old) return `没有 id 为 ${id} 的那一篇 —— 先用 list 看一眼。`;

          if (a.action === "delete") {
            ctx.deleteNote(id);
            return `删掉了《${old.title}》一整篇（连它那几版旧稿）。`;
          }

          if (a.action === "tag") {
            const add = split(a.tags);
            const drop = split(a.untag);
            if (!add.length && !drop.length)
              return "tag 需要 tags（要加的）或者 untag（要拿掉的）。";
            const next = old.tags.filter((t) => !drop.includes(t));
            const merged = [...next, ...add.filter((t) => !next.includes(t))];
            const n = ctx.saveNote({ id, tags: merged });
            return `《${n.title}》的标签现在是：${n.tags.length ? n.tags.join("、") : "（没有标签）"}。`;
          }

          if (a.action === "append") {
            const text = (a.text || "").trim();
            if (!text) return "append 需要 text：要追加的那一段。";
            const merged = old.body ? `${old.body}\n\n${text}` : text;
            const n = ctx.saveNote({ id, body: merged });
            // 触顶后写入层会静默截断（noteStore 按 NOTE_BODY_MAX 切）——
            // 不比对的话，回话会说「加好了」而实际掉了半段
            if (n.body.length < merged.length)
              return (
                `《${n.title}》已经到单篇上限（${NOTE_BODY_MAX} 字）了，这一回只写进去 ` +
                `${Math.max(0, n.body.length - old.body.length)} 字，后面那段被截掉了。` +
                "要接着写，得先精简这一篇，或者另起一篇。"
              );
            return `在《${n.title}》末尾加了一段，这一篇现在 ${n.body.length} 字。他那边的正文会跟着更新。`;
          }

          const body = (a.body || "").trim();
          if (!body)
            return "write 需要 body：改写之后的完整正文（这一条是覆盖式的，不能只给要改的那一句）。";
          const n = ctx.saveNote({
            id,
            body,
            title: a.title,
            tags: a.tags ? split(a.tags) : undefined,
          });
          return (
            `改写好了《${n.title}》（${old.body.length} → ${n.body.length} 字）。` +
            "旧的那版我留着了，他要退回去随时可以 —— 但我在回复里得说清我动了哪几处。"
          );
        }

        return "没认出来这个动作。";
      },
    }),
  };
}
