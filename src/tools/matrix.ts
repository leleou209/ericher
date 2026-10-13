// 网页矩阵工具：让助手也能建页、改页、连通路、换外观。
//
// 它是「外站守则」的执行侧：外站能不能去由认定表说了算 —— 这里不往表里加域名
// （认可是人的决定），表外的一律如实回报「访客会被门卫页拦下」；伪协议
// （javascript: / data: / blob:）任何动作都不放行。
//
// 矩阵已并回主包，工具直接调 src/matrix/core.ts 的域函数 —— 同进程、同一只桶，
// 不再绕 HTTP、不再签名。参数不合规时 core 抛 MatrixInputError，这里翻成人话。

import { tool } from "ai";
import { z } from "zod";
import type { ToolCtx } from "./types";
import {
  MatrixInputError,
  matrixListLinks,
  matrixListPages,
  matrixListSites,
  matrixReadPage,
  matrixSaveLink,
  matrixSaveTheme,
  savePageCore,
  type MatrixPage,
} from "../matrix/core";

/** 闭区间夹取（落点百分比，core 那边还会再夹一次） */
function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** 路径常态：去首尾斜杠 */
function norm(p: string): string {
  return p.trim().replace(/^\/+/, "").replace(/\/+$/, "");
}

/** 按 id 或路径找一页（路径可以带不带首斜杠） */
function findPage(pages: MatrixPage[], ref: string): MatrixPage | undefined {
  const r = norm(ref);
  return pages.find((p) => p.id === ref.trim()) ?? pages.find((p) => p.path === r);
}

/** 一律不许作为出行目标的协议：伪协议能借链接执行脚本或塞内联内容 */
const BLOCKED_SCHEME_RE =
  /^[\s\u0000-\u001f]*(javascript|data|blob|vbscript|file)\s*:/i;
/** 绝对地址：http(s) 或协议相对的 //；相对路径不出站 */
const ABS_URL_RE = /^(?:https?:)?\/\//i;

/**
 * 落点速记 → core 要的形状。三种写法：
 *   auto           兜底栏（页面末尾的「通路」栏）
 *   anchor:名字    填进正文里名为「名字」的命名锚点
 *   point:12,34    拖拽落点到整页的百分比坐标
 * 认不出来的当 auto —— 落点错了顶多难找，不该让整次操作失败。
 */
function parsePlace(raw?: string): unknown {
  const s = (raw ?? "").trim();
  if (s.startsWith("anchor:")) {
    const name = s.slice(7).trim();
    return name ? { kind: "anchor", name } : { kind: "auto" };
  }
  if (s.startsWith("point:")) {
    const [x, y] = s
      .slice(6)
      .split(",")
      .map((n) => Number(n.trim()));
    if (Number.isFinite(x) && Number.isFinite(y))
      return { kind: "point", x: clamp(x, 0, 100), y: clamp(y, 0, 100) };
  }
  return { kind: "auto" };
}

/** 给一个外站生成一条没被占用的矩阵路径（首段固定 out，方便一眼认出是外站页） */
function extPath(pages: MatrixPage[], host: string): string {
  const slug =
    host.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) ||
    "site";
  const base = `out/${slug}`;
  if (!pages.some((p) => p.path === base)) return base;
  for (let i = 2; i < 100; i++) {
    const p = `${base}-${i}`;
    if (!pages.some((x) => x.path === p)) return p;
  }
  return `${base}-${Date.now().toString(36)}`;
}

/** 节点类型在工具输出里的叫法（page 是默认，不特意标出来） */
const KIND_TEXT: Record<string, string> = {
  gate: "门卫",
  assistant: "助手",
  app: "功能块",
};

/** 一页的现状一行（给 list 用） */
function pageLine(p: MatrixPage): string {
  const tags: string[] = [p.access];
  if (p.kind && p.kind !== "page") tags.push(KIND_TEXT[p.kind] ?? p.kind);
  if (p.entry) tags.push("入口页");
  if (p.sandbox) tags.push("沙箱");
  if (p.css) tags.push("有本页CSS");
  if (p.external) tags.push("外站");
  return `- ${p.path}（${p.title || "无题"}｜${tags.join("/")}）id=${p.id}${
    p.external ? ` → ${p.external}` : ""
  }`;
}

export function matrixTools(ctx: ToolCtx) {
  /** 参数不合规，翻成人话；返回 null 表示这次是成功的 */
  const fail = (e: unknown): string | null => {
    if (e instanceof MatrixInputError) return `没接这活：${e.message}`;
    throw e;
  };

  return {
    matrix: tool({
      description:
        "网页矩阵（接待台对面那些页面）。action=list 看现状（页面/通路/外观/外站认定）；" +
        "create 建一页（必填 path + title + html）；" +
        "edit 改一页（用 id 或 path 指定，可改 title/html/css/kind/access/entry/sandbox/newPath）；" +
        "bind 连一条通路（from 指向 to；to 是站内 path/id 或一条完整外站网址，落点用 place 速记）；" +
        "style 改全站外观（accent 主色 / button 按钮形态）。\n" +
        "kind 决定这一格是什么：page 网页（默认，带正文）/ gate 门卫（自己不出正文，站上去就是去验票，验完去它的第一条出线）/ assistant 助手（站上去送去 /assistant）/ app 功能块（还没实作）。\n" +
        "守则：外站能不能去由「认定表」说话 —— 我不往表里加域名，只在已认定的范围内连线，表外的一律如实说明「访客会被门卫页拦下」；" +
        "javascript: / data: / blob: 这类伪协议任何动作都不放行。动手前先 list 看清现有路径，别撞已有路径。",
      inputSchema: z
        .object({
          action: z.enum(["list", "create", "edit", "bind", "style"]),
          /** 定位一页：edit/bind 用它，id 或 path 都认 */
          ref: z.string().optional().describe("list/edit 时：页面 id 或路径"),
          path: z
            .string()
            .optional()
            .describe("create 必填、edit 可改：层级路径，如大厅 或 thisme/foryou"),
          title: z.string().optional().describe("页面标题"),
          html: z
            .string()
            .optional()
            .describe("create 必填、edit 可换：整篇正文 HTML"),
          css: z.string().optional().describe("本页 CSS（只在这一页生效）"),
          kind: z
            .enum(["page", "gate", "assistant", "app"])
            .optional()
            .describe(
              "节点类型：page 网页（默认，带正文）/ gate 门卫（自己不出正文，站上去就是去验票，验完去它的第一条出线）/ assistant 助手（站上去送去 /assistant）/ app 功能块（还没实作）",
            ),
          access: z
            .enum(["public", "visitor", "admin", "types"])
            .optional()
            .describe("谁能看：public 所有人 / visitor 持票来客 / admin 仅管理员 / types 指定档位"),
          types: z
            .array(z.string())
            .optional()
            .describe("access=types 时的档位白名单"),
          entry: z.boolean().optional().describe("设为入口页（公开访客访问根路径时去它，全站最多一个）"),
          sandbox: z.boolean().optional().describe("页面级沙箱"),
          newPath: z.string().optional().describe("edit 时改路径（换 URL）"),
          external: z
            .string()
            .optional()
            .describe("create 时填了它就是外站页（正文留空）"),
          /** bind 用 */
          from: z.string().optional().describe("bind 必填：起点页（id 或 path）"),
          to: z
            .string()
            .optional()
            .describe("bind 必填：终点（站内 path/id，或一条完整外站网址）"),
          label: z.string().optional().describe("bind 时按钮文字"),
          place: z
            .string()
            .optional()
            .describe("bind 时按钮落点：auto（兜底栏）/ anchor:名字 / point:12,34"),
          /** style 用 */
          accent: z.string().optional().describe("style：主色，六个十六进制位，如 #0b6bcb"),
          button: z
            .enum(["text", "outline", "solid"])
            .optional()
            .describe("style：按钮形态，文字链 / 描边 / 实底"),
        })
        .superRefine((a, refine) => {
          const need = (ok: boolean, field: string, msg: string) => {
            if (!ok)
              refine.addIssue({ code: "custom", path: [field], message: msg });
          };
          if (a.action === "create") {
            need(!!(a.path || "").trim(), "path", "create 必填：路径");
            need(!!(a.title || "").trim(), "title", "create 必填：标题");
            // 门卫/助手/功能块自己不出正文，所以只有建网页才要 html
            if (!a.kind || a.kind === "page")
              need(
                !!(a.html || "").trim() || !!(a.external || "").trim(),
                "html",
                "create 必填：正文 HTML（外站页则改填 external）",
              );
          }
          if (a.action === "edit" || (a.action === "bind" && !a.from))
            need(!!(a.ref || a.path || "").trim(), "ref", `${a.action} 必填：用 id 或 path 指定页面`);
          if (a.action === "bind") {
            need(!!(a.from || "").trim(), "from", "bind 必填：起点页");
            need(!!(a.to || "").trim(), "to", "bind 必填：终点（站内 path 或外站网址）");
          }
          if (a.action === "style")
            need(
              !!(a.accent || "").trim() || !!(a.button || "").trim(),
              "accent",
              "style 至少给一样：accent 或 button",
            );
        }),
      execute: async (a) => {
        try {
          // ── 看现状 ──
          if (a.action === "list") {
            const { pages, theme } = await matrixListPages(ctx.env);
            const ref = (a.ref || a.path || "").trim();
            if (ref) {
              const p = findPage(pages, ref);
              if (!p) return `没有这一页：${ref}。先 list 看现有路径。`;
              if (p.external) return `外站页 ${p.path}（${p.title}）→ ${p.external}\nid=${p.id}`;
              const detail = await matrixReadPage(ctx.env, p.id);
              const body = detail?.body ?? "";
              const cut = body.slice(0, 6000);
              return `# ${p.path}｜${p.title}\nid=${p.id}\n\n${cut}${
                body.length > 6000 ? "\n\n[正文已截断]" : ""
              }`;
            }
            const links = await matrixListLinks(ctx.env);
            const sites = await matrixListSites(ctx.env);
            const byId = new Map(pages.map((p) => [p.id, p.path]));
            const linkLines = links.slice(0, 80).map(
              (l) =>
                `${byId.get(l.from) ?? l.from} → ${byId.get(l.to) ?? l.to}（${l.label}）`,
            );
            return (
              `【页面】${pages.length} 页\n` +
              (pages.length ? pages.map(pageLine).join("\n") : "（还没有页面）") +
              `\n\n【通路】${links.length} 条\n` +
              (linkLines.length ? linkLines.join("\n") : "（还没有连线）") +
              `\n\n【外观】主色 ${theme.accent}，按钮 ${theme.button}` +
              `\n\n【外站认定】${
                sites.length
                  ? sites
                      .map((s) => `${s.host}${s.skip ? "（免提示）" : ""}`)
                      .join("、")
                  : "（一张空表 —— 任何外站都会被门卫页拦下）"
              }`
            );
          }

          // ── 建页 ──
          if (a.action === "create") {
            const path = norm(a.path ?? "");
            if (a.external && BLOCKED_SCHEME_RE.test(a.external.trim()))
              return "这条外站地址用的协议不被允许（javascript / data / blob 之类），我不放行。";
            const page = await savePageCore(ctx.env, {
              path,
              title: a.title,
              kind: a.kind,
              access: a.access ?? "public",
              types: a.types,
              entry: a.entry === true,
              sandbox: a.sandbox === true,
              css: a.css,
              external: a.external,
              text: a.external ? undefined : a.html,
            });
            return `建好了：/${page.path}（${page.title}）id=${page.id}${
              page.entry ? "，已设为入口页" : ""
            }${page.external ? `，外站 → ${page.external}` : ""}${
              page.kind && page.kind !== "page"
                ? `，类型：${KIND_TEXT[page.kind] ?? page.kind}`
                : ""
            }`;
          }

          // ── 改页 ──
          if (a.action === "edit") {
            const ref = (a.ref || a.path || "").trim();
            const { pages } = await matrixListPages(ctx.env);
            const cur = findPage(pages, ref);
            if (!cur) return `没有这一页：${ref}。先 list 看现有路径。`;
            // 没给的字段沿用现值：保存是整页覆盖，漏传就等于把 access/css 抹回默认。
            // 正文不传就是「不动」—— core 见到已有页面会沿用旧正文
            const page = await savePageCore(ctx.env, {
              id: cur.id,
              path: norm(a.newPath || cur.path),
              title: a.title ?? cur.title,
              kind: a.kind ?? cur.kind,
              access: a.access ?? cur.access,
              types: a.types ?? cur.types,
              entry: a.entry ?? cur.entry === true,
              sandbox: a.sandbox ?? cur.sandbox === true,
              css: a.css ?? cur.css,
              external: cur.external,
              text: a.html !== undefined && !cur.external ? a.html : undefined,
            });
            const changed = [
              a.html !== undefined && "正文",
              a.css !== undefined && "本页CSS",
              a.title !== undefined && "标题",
              a.kind !== undefined && "类型",
              a.access !== undefined && "可见范围",
              a.newPath !== undefined && "路径",
              a.entry !== undefined && "入口页",
              a.sandbox !== undefined && "沙箱",
            ].filter(Boolean) as string[];
            return `改好了：/${page.path}（改了 ${changed.join("、") || "（无变化）"}）id=${page.id}`;
          }

          // ── 连一条通路 ──
          if (a.action === "bind") {
            const { pages } = await matrixListPages(ctx.env);
            const from = findPage(pages, a.from ?? "");
            if (!from) return `起点页找不到：${a.from}。先 list 看现有路径。`;
            if (from.external) return "外站页没有本地正文，挂不了按钮 —— 它只能当终点。";

            const rawTo = (a.to ?? "").trim();
            let target: MatrixPage | undefined;
            let note = "";
            // 伪协议先拦：javascript: 之类不以 // 开头，会漏进站内路径分支，
            // 被当成「找不到这一页」混过去 —— 所以排在分流之前。
            if (BLOCKED_SCHEME_RE.test(rawTo))
              return "这条外站地址用的协议不被允许（javascript / data / blob 之类），我不放行。";
            if (ABS_URL_RE.test(rawTo)) {
              const abs = rawTo.startsWith("//") ? `https:${rawTo}` : rawTo;
              // 同一个外站只建一页：已经有指它的一条外站页就复用
              target = pages.find((p) => p.external === abs);
              if (!target) {
                const host = new URL(abs).hostname.toLowerCase();
                const page = await savePageCore(ctx.env, {
                  path: extPath(pages, host),
                  title: a.label?.trim() || host,
                  access: "public",
                  external: abs,
                });
                target = page;
              }
              // 认定表是人的决定：这里只如实回报，不代加
              const sites = await matrixListSites(ctx.env);
              const host = new URL(abs).hostname.toLowerCase();
              const ok = sites.some((s) => host === s.host || host.endsWith(`.${s.host}`));
              note = ok
                ? "该外站在认定表里，访客点它会先过门卫页提醒（或按认定设置直跳）。"
                : `但 ${host} 还没被认定 —— 访客点它会被门卫页拦下；要放行得先有人在面板「外站认定」里加上它。`;
            } else {
              target = findPage(pages, rawTo);
              if (!target) return `终点页找不到：${rawTo}。先 list 看现有路径。`;
            }

            const link = await matrixSaveLink(ctx.env, {
              from: from.id,
              to: target.id,
              label: a.label,
              place: parsePlace(a.place),
            });
            return (
              `连好了：/${from.path} → ${
                target.external ? target.external : `/${target.path}`
              }（按钮「${link.label}」，落点 ${a.place?.trim() || "auto"}）。${note}`
            );
          }

          // ── 换全站外观 ──
          if (a.action === "style") {
            const { theme } = await matrixListPages(ctx.env);
            if (a.accent && !/^#[0-9a-fA-F]{6}$/.test(a.accent.trim()))
              return "主色要写成六个十六进制位，如 #0b6bcb。";
            const next = await matrixSaveTheme(ctx.env, {
              accent: a.accent?.trim().toLowerCase() || theme.accent,
              button: a.button || theme.button,
            });
            return `外观改好了：主色 ${next.accent}，按钮 ${next.button}。`;
          }

          return "没认出来这个动作。";
        } catch (e) {
          const msg = fail(e);
          if (msg !== null) return msg;
          throw e;
        }
      },
    }),
  };
}
