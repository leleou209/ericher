import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { defineConfig } from "vitest/config";

/**
 * 单一 Vite 配置同时构建 Worker（src/）与前端 React（web/）。
 *
 * - Vite root = web/，前端入口是 web/index.html
 * - Worker 入口由 wrangler.jsonc 的 main 指定（src/index.ts）
 * - dev 时 miniflare 在同一个端口跑 Worker，/api/* 与 /agents/* 无需反向代理
 *
 * vitest 跑纯逻辑单测（test/，外加 web/src 里那些不碰浏览器的纯函数），
 * 不需要 workerd 运行时；cloudflare 插件会把
 * 测试塞进 workers pool 并报 "exports is not defined"，所以测试时跳过它。
 */
const isTest = !!process.env.VITEST;

/**
 * 构建期常量：版本号唯一来源是 package.json，构建号是当前 git 短 hash。
 * Worker 与前端共用同一对常量 —— 关于页显示它们，更新检查拿构建号去和
 * 开源仓库的最新提交对（见 /api/update-check）。
 */
const pkg = JSON.parse(
  readFileSync(path.resolve(import.meta.dirname, "package.json"), "utf8"),
) as {
  version: string;
};
const gitHash = isTest
  ? "test"
  : execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __GIT_HASH__: JSON.stringify(gitHash),
  },
  root: path.resolve(import.meta.dirname, "web"),
  plugins: [
    {
      name: "inline-startup-css",
      apply: "build",
      transformIndexHtml: {
        order: "post",
        handler(html, context) {
          // 入口 CSS 内联，弱网不必再等一次样式请求才能画出启动/门禁界面。
          // 可选页面的 CSS 仍随对应动态 chunk 加载，不内联整套应用。
          return html.replace(/<link\b[^>]*rel="stylesheet"[^>]*>/g, tag => {
            const href = /href="([^"]+)"/.exec(tag)?.[1];
            const asset = href ? context.bundle?.[href.replace(/^\/+/, "")] : undefined;
            if (!asset || asset.type !== "asset") return tag;
            const css = typeof asset.source === "string" ? asset.source : Buffer.from(asset.source).toString("utf8");
            // 内容已内联，移除原 link：既不重复下载，也不占 Vite 的依赖预加载表
            // （否则聊天框架加载时又被追加一次同样的样式请求）。
            void tag;
            return `<style data-startup-css>${css}</style>`;
          });
        },
      },
    },
    ...(isTest
      ? []
      : [
          cloudflare({
            configPath: path.resolve(
              import.meta.dirname,
              process.env.HR_DESK_WRANGLER_CONFIG || "wrangler.jsonc",
            ),
          }),
        ]),
    react(),
  ],
  build: {
    outDir: path.resolve(import.meta.dirname, "dist"),
    emptyOutDir: true,
  },
  test: {
    root: path.resolve(import.meta.dirname),
    include: ["test/**/*.test.ts", "web/src/**/*.test.ts"],
    environment: "node",
  },
});
