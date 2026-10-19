// artifact：现场生成自包含 HTML 卡片（样式/脚本内联），存云盘，回复里用 [artifact <key> <标题>] 引用。
// 前端以 sandbox iframe 渲染（脚本可跑、无同源权限）；后端垫 CSP: sandbox，单独打开也是不透明源。

import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { sessionKey } from "../fileAccess";
import type { ToolCtx } from "./types";

/** 卡片体积上限：一张卡片不该是一本书，200KB 足够任何合理的交互页面 */
const MAX_HTML = 200_000;

export function artifactTools(ctx: ToolCtx) {
  return {
    artifact: tool({
      description:
        "生成一张可交互的 HTML 卡片（对比表、清单、日程、小仪表盘、步骤图这类），" +
        "存好后内联展示在对话里。" +
        "HTML 必须完全自包含：<style> 和 <script> 全部内联，不引用任何外部资源" +
        "（外链图片/CSS/字体都不行），浅色纸面风格，宽度自适应（手机也要能看）。" +
        "存成功后，在回复里另起一行写 [artifact <返回的key> <标题>]，那行会变成卡片。",
      inputSchema: z.object({
        title: z.string().max(40).describe("卡片标题，比如「两份 offer 对比」"),
        html: z
          .string()
          .max(MAX_HTML)
          .describe("完整的 HTML 文档（<!doctype html> 开头，自包含）"),
      }),
      execute: async ({ title, html }) => {
        const bucket = ctx.env.MEMORY_BUCKET;
        if (!bucket) return "云盘未配置，卡片存不了。";
        const key = sessionKey(ctx.room, ctx.sessionId, "artifact", "html");
        await bucket.put(key, html, {
          httpMetadata: { contentType: "text/html; charset=utf-8" },
        });
        return (
          `卡片已存好（key: ${key}）。` +
          `在回复里另起一行写：[artifact ${key} ${title}] —— ` +
          `那一行会渲染成对话里的内联卡片。`
        );
      },
    }),
  };
}
