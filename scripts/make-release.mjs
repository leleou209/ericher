// 打一个可整包交付的 0.1.7 部署资源：Worker 打包产物 + 静态资源 + Wrangler 配置。
// 包内不含源码、node_modules、.dev.vars 与任何密钥；解压后直接 wrangler deploy。
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const version = pkg.version;
const commit = execSync("git rev-parse --short HEAD", { cwd: root, encoding: "utf8" }).trim();
const builtAt = new Date().toISOString();

const worker = path.join(root, "dist", "ericher_app", "index.js");
const client = path.join(root, "dist", "client");
if (!existsSync(worker) || !existsSync(client)) {
  throw new Error("缺少 dist/ericher_app/index.js 或 dist/client，请先运行 npm run build");
}
if (!readFileSync(worker, "utf8").includes(version)) {
  throw new Error(`Worker 产物里找不到版本号 ${version}，拒绝打包`);
}
if (!readFileSync(worker, "utf8").includes(commit)) {
  throw new Error(`Worker 产物里找不到提交号 ${commit}，产物与当前 HEAD 不一致`);
}

const outRoot = path.join(root, "release");
const pkgName = `ericher-${version}-cf`;
const stage = path.join(outRoot, pkgName);
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });

copyFileSync(worker, path.join(stage, "index.js"));
copyTree(client, path.join(stage, "assets"));
copyFileSync(path.join(root, "CHANGELOG.md"), path.join(stage, "CHANGELOG.md"));

writeFileSync(
  path.join(stage, "wrangler.jsonc"),
  `{
  // 这是 0.1.7 的完整部署包：index.js + assets/ 已构建完成，不需要再跑 npm install / build。
  // 换 Worker 名或资源名时，这里与下面三处一起改。
  "name": "ericher-app",
  "main": "index.js",
  "compatibility_date": "2026-05-14",
  "compatibility_flags": ["nodejs_compat"],
  "no_bundle": true,
  "assets": {
    "binding": "ASSETS",
    "directory": "./assets",
    "not_found_handling": "single-page-application",
    "run_worker_first": true,
  },
  "durable_objects": {
    "bindings": [
      { "name": "COWORK_AGENT", "class_name": "CoworkAgent" },
    ],
  },
  // 类名必须保持 CoworkAgent：DO 存储按类标识派生，改名会导致既有记忆读不到。
  "migrations": [
    { "tag": "v1", "new_sqlite_classes": ["CoworkAgent"] },
  ],
  "observability": { "enabled": true },
  "r2_buckets": [
    { "binding": "MEMORY_BUCKET", "bucket_name": "ericher-memory" },
  ],
  "vectorize": [
    { "binding": "VECTORIZE_INDEX", "index_name": "ericher-memory-bge-m3" },
  ],
  "ai": { "binding": "AI" },
  "browser": { "binding": "BROWSER" },
}
`,
);

writeFileSync(
  path.join(stage, "RELEASE.json"),
  JSON.stringify({ name: "ericher", version, commit, builtAt, format: "wrangler-deploy-bundle" }, null, 2) + "\n",
);

writeFileSync(path.join(stage, "DEPLOY.md"), deployDoc(version, commit));

// ── 打包前扫一遍密钥：本地 .dev.vars 里的真实值绝不能被带进交付包 ──
const secrets = readSecrets(path.join(root, ".dev.vars"));
for (const file of walk(stage)) {
  if (path.basename(file) === ".dev.vars") throw new Error(`交付包里出现了 .dev.vars：${file}`);
  const text = readFileSync(file, "utf8");
  for (const { key, value } of secrets) {
    if (text.includes(value)) throw new Error(`交付包的 ${path.relative(stage, file)} 里出现了 ${key} 的值，已停止打包`);
  }
}

const entries = {};
for (const file of walk(stage)) {
  entries[path.relative(stage, file).split(path.sep).join("/")] = new Uint8Array(readFileSync(file));
}
const zipped = zipSync(entries, { level: 6 });
const zipPath = path.join(outRoot, `${pkgName}.zip`);
writeFileSync(zipPath, zipped);

// ── 回读校验：能解压、入口齐全、没有 .dev.vars、版本与提交号对得上 ──
const back = unzipSync(zipped);
for (const required of ["index.js", "wrangler.jsonc", "DEPLOY.md", "RELEASE.json", "assets/index.html"]) {
  if (!back[required]) throw new Error(`打包结果缺少 ${required}`);
}
if (Object.keys(back).some((name) => name.endsWith(".dev.vars"))) throw new Error("打包结果里出现了 .dev.vars");
if (!strFromU8(back["index.js"]).includes(version)) throw new Error("打包结果里的 index.js 版本号不对");
const sha256 = createHash("sha256").update(zipped).digest("hex");
writeFileSync(path.join(outRoot, `${pkgName}.zip.sha256`), `${sha256}  ${pkgName}.zip\n`);

console.log(`已生成 ${path.relative(root, zipPath)}`);
console.log(`  版本 ${version}  提交 ${commit}  文件 ${Object.keys(back).length} 个  ${(zipped.length / 1024 / 1024).toFixed(2)} MiB`);
console.log(`  sha256 ${sha256}`);

function copyTree(from, to) {
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) copyTree(src, dst);
    else if (entry.isFile()) copyFileSync(src, dst);
  }
}

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.isFile()) yield full;
  }
}

function readSecrets(file) {
  if (!existsSync(file)) return [];
  const out = [];
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    let value = m[2];
    if (
      (value.startsWith("'") && value.endsWith("'")) ||
      (value.startsWith('"') && value.endsWith('"'))
    ) value = value.slice(1, -1);
    if (value.length >= 8 && /(?:^|_)(?:KEY|PASSWORD|SECRET|TOKEN)$/.test(m[1])) {
      out.push({ key: m[1], value });
    }
  }
  return out;
}

function deployDoc(version, commit) {
  return `# ericher ${version} · Cloudflare 部署包

这是 0.1.7 的完整可部署产物（构建号 ${commit}）：Worker 已打包成 \`index.js\`，前端已构建在 \`assets/\`，配置在 \`wrangler.jsonc\`。包内没有源码、node_modules、\`.dev.vars\` 或任何密钥。

## 一条命令部署

需要 Node.js ≥ 22.12，并先登录 Cloudflare：

\`\`\`bash
npx wrangler@4 login
npx wrangler@4 deploy
\`\`\`

\`wrangler deploy\` 会把本目录的 \`index.js\` 与 \`assets/\` 原样上传，不需要再安装依赖或构建。

## 首次部署前：建两个资源

名字与 \`wrangler.jsonc\` 对应，可自行改名（改完同步改配置）：

\`\`\`bash
npx wrangler@4 r2 bucket create ericher-memory
npx wrangler@4 vectorize create ericher-memory-bge-m3 --dimensions 1024 --metric cosine
\`\`\`

## 配置密钥

密钥不随包分发，部署后逐项写入：

\`\`\`bash
npx wrangler@4 secret put API_ENDPOINT
npx wrangler@4 secret put API_KEY
npx wrangler@4 secret put API_MODEL
npx wrangler@4 secret put ADMIN_PASSWORD
npx wrangler@4 secret put GATE_PASSWORD
npx wrangler@4 secret put SESSION_SECRET
\`\`\`

管理员口令与来客口令必须不同；没有口令时登录页直接 503。可选密钥（搜索、语音、绘画、发信等）见仓库 \`.dev.vars.example\`，例如 \`MAIL_KEY\` 用于 SMTP 发信。

Cloudflare Dashboard 的「直接上传 JS」只能传单个脚本，带 Durable Objects / R2 / Vectorize 绑定和静态资源的 Worker 走 \`wrangler deploy\` 这一条；本包就是给这条命令用的完整产物。

## 回滚

保留上一版本的 zip 即可：解压后用同一条 \`npx wrangler@4 deploy\` 覆盖。DO 的 SQLite 与 R2 数据不会被部署动作删除。
`;
}
