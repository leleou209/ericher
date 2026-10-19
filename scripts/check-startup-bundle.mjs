import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import ts from "typescript";

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const client = path.join(project, "dist/client");
const html = readFileSync(path.join(client, "index.html"), "utf8");
const entries = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map(match => path.join(client, match[1]));
function closure(roots) {
  const visited = new Set();
  function visit(file) {
    if (visited.has(file)) return;
    visited.add(file);
    const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) continue;
      const specifier = statement.moduleSpecifier;
      if (specifier && ts.isStringLiteral(specifier) && specifier.text.startsWith("."))
        visit(path.resolve(path.dirname(file), specifier.text));
    }
  }
  roots.forEach(visit);
  return [...visited];
}
function bytes(files) {
  return files.reduce((sum, file) => {
    sum.raw += statSync(file).size;
    sum.gzip += gzipSync(readFileSync(file)).length;
    return sum;
  }, { raw: 0, gzip: 0 });
}
const assets = path.join(client, "assets");
const shell = readdirSync(assets).find(file => /^Shell-.*\.js$/.test(file));
const initial = closure(entries);
const firstBytes = bytes(initial);
console.log(`首屏 JS 静态闭包：${initial.length} 文件，原始 ${firstBytes.raw} 字节，gzip ${firstBytes.gzip} 字节`);
assert(shell, "Shell 必须是独立动态 chunk，不得合回首屏");
assert(firstBytes.gzip < 100 * 1024, "首屏 JS gzip 不得超过 100 KiB");
assert(!initial.some(file => /(?:Shell|Messages|SettingsPage|NotePage)-/.test(path.basename(file))), "首屏不得静态包含聊天或设置模块");
const shellFiles = closure([path.join(assets, shell)]);
assert(!shellFiles.some(file => /(?:Messages|SettingsPage|NotePage|SessionMemoryPage)-/.test(path.basename(file))), "聊天框架不得静态包含可选内容渲染与设置模块");
console.log(`聊天框架静态闭包：gzip ${bytes(shellFiles).gzip} 字节（可与入口共享模块）`);
assert(html.includes("data-startup-css"), "入口关键 CSS 必须内联，不能等样式网络请求才能绘制");
assert(!/<link\b[^>]*rel="stylesheet"/.test(html), "首屏不应存在外部阻塞样式：入口 CSS 必须已内联且移除原 link");
assert(html.includes('id="boot"') && html.includes('id="boot-retry"'), "HTML必须在JS未到时提供启动和失败恢复入口");
console.log("首屏分包、关键CSS与体积检查通过。");
