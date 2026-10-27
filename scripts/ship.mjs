#!/usr/bin/env node
// 发布工装：把「一次更新」的重复动作收进一条命令，并把手抄数字、构建来源、
// 部署目标这类容易悄悄错的地方交给脚本判定。公约见 docs/release-workflow.md。
//
// 默认不碰 GitHub：只有 `git` 子命令 + --yes 才会推、打 tag、换 release 资产。
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const cmd = argv[0] && !argv[0].startsWith("--") ? argv[0] : "status";
const flags = argv.filter((a) => a.startsWith("--"));
const flagValue = (name) => {
  const hit = flags.find((f) => f.startsWith(`--${name}=`));
  if (hit) return hit.slice(name.length + 3);
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--")
    ? argv[i + 1]
    : undefined;
};
const has = (name) => flags.includes(`--${name}`);

const PRIVATE_CONFIG = ".wrangler.local.jsonc";

/**
 * 一律用当前 Node 直接跑本地 bin，不经过 npm.cmd：
 * Windows 下 spawnSync("npm") 找不到 npm（它是个 .cmd），退出码会是 null，
 * 报错看着像「typecheck 挂了」，其实是没起起来。
 */
function node(args, opts = {}) {
  const r = spawnSync(process.execPath, args, {
    cwd: root,
    encoding: "utf8",
    stdio: opts.capture ? ["ignore", "pipe", "pipe"] : "inherit",
    env: { ...process.env, ...(opts.env || {}) },
    maxBuffer: 64 * 1024 * 1024,
  });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  if ((r.status ?? 1) !== 0) {
    if (opts.capture) console.error(out);
    die(`命令失败（exit ${r.status}）：node ${args.join(" ")}`);
  }
  return out;
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    cwd: root,
    encoding: "utf8",
    stdio: opts.capture ? ["ignore", "pipe", "pipe"] : "inherit",
    env: { ...process.env, ...(opts.env || {}) },
    maxBuffer: 64 * 1024 * 1024,
  });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  if ((r.status ?? 1) !== 0) {
    if (opts.capture) console.error(out);
    die(`命令失败（exit ${r.status}）：${cmd} ${args.join(" ")}`);
  }
  return out;
}
const git = (args, opts) => run("git", args, { ...opts, capture: true }).trim();

/** 取不到也不报错的 git 查询（状态面板用，别为一条展示信息把脚本弄红） */
function gitSoft(args) {
  const r = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  return (r.status ?? 1) === 0 ? r.stdout.trim() : "";
}

function die(msg) {
  console.error(`\n✗ ${msg}`);
  process.exit(1);
}
const ok = (msg) => console.log(`✓ ${msg}`);
const short = () => git(["rev-parse", "--short", "HEAD"]);
const subject = () => git(["log", "-1", "--pretty=%s"]);
const dirty = () => git(["status", "--porcelain"]).length > 0;
const read = (rel) => readFileSync(path.join(root, rel), "utf8");
const write = (rel, text) => {
  writeFileSync(path.join(root, rel), text, "utf8");
};

/** 剥掉 ANSI 转义：vitest 的汇总行里 "Test Files" 与数字之间夹着颜色码，不剥就永远匹不上 */
function stripAnsi(text) {
  const esc = String.fromCharCode(27);
  let out = "";
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== esc) {
      out += text[i];
      continue;
    }
    let j = i + 1;
    if (text[j] === "[") {
      j += 1;
      while (j < text.length && !/[A-Za-z~]/.test(text[j])) j += 1;
    }
    i = j;
  }
  return out;
}

/** 测试口径：文件数与例数只认 vitest 的输出，不认人的眼睛 */
function parseCounts(raw) {
  const text = stripAnsi(raw);
  const files = /Test Files\s+(\d+) passed/.exec(text)?.[1];
  const tests = /Tests\s+(\d+) passed/.exec(text)?.[1];
  if (!files || !tests)
    die("没从测试输出里读到「Test Files / Tests」，数字不能凭猜写进文档");
  return { files: Number(files), tests: Number(tests) };
}

const DOC_PATTERNS = (f, t) => [
  [/(（|\()(\d+) 个文件 \/ (\d+) 例/g, `$1${f} 个文件 / ${t} 例`],
  [/(\d+) 个测试文件 \/ (\d+) 例/g, `${f} 个测试文件 / ${t} 例`],
  [/(\d+) 文件 \/ (\d+) 例/g, `${f} 文件 / ${t} 例`],
  [/(\d+) 例测试/g, `${t} 例测试`],
  [/(\d+) 个测试文件；/g, `${f} 个测试文件；`],
  [/类型 \+ (\d+) 例 \+ 构建/g, `类型 + ${t} 例 + 构建`],
];
const DOC_FILES = [
  "README.md",
  "CHANGELOG.md",
  "docs/guide.html",
  "docs/promo-home.html",
];

function syncCounts({ files, tests }) {
  const touched = [];
  for (const rel of DOC_FILES) {
    if (!existsSync(path.join(root, rel))) continue;
    let text = read(rel);
    const before = text;
    for (const [re, rep] of DOC_PATTERNS(files, tests)) text = text.replace(re, rep);
    if (text !== before) {
      write(rel, text);
      touched.push(rel);
    }
  }
  return touched;
}

/** 文档里现在写着哪些数字（用来判断有没有对不上） */
function docCounts() {
  const found = new Set();
  for (const rel of DOC_FILES) {
    if (!existsSync(path.join(root, rel))) continue;
    for (const m of read(rel).matchAll(/(\d+) (?:个文件|个测试文件|文件) \/ (\d+) 例/g))
      found.add(`${m[1]} / ${m[2]}`);
  }
  return [...found];
}

function requireClean(what) {
  if (dirty())
    die(
      `${what} 要求工作树干净：产物与线上版本必须对应一个确定的提交。\n` +
        `  未提交：\n${git(["status", "--short"]).replace(/^/gm, "    ")}`,
    );
}

function versionIds() {
  const pkg = JSON.parse(read("package.json"));
  const manifest = existsSync(path.join(root, "version.json"))
    ? JSON.parse(read("version.json"))
    : null;
  return { pkg: pkg.version, manifest };
}

// ── 子命令 ───────────────────────────────────────────────

function status() {
  const { pkg, manifest } = versionIds();
  const tags = git(["tag", "--list", `v${pkg}`]);
  console.log(`提交          ${short()}  ${subject()}`);
  console.log(`工作树        ${dirty() ? "有未提交改动" : "干净"}`);
  console.log(`package.json  ${pkg}`);
  console.log(
    `version.json  ${manifest ? `${manifest.version} @ ${manifest.hash}` : "缺失"}`,
  );
  console.log(`tag v${pkg}    ${tags ? "有" : "没有（发版后需 git 子命令打）"}`);
  const counts = docCounts();
  console.log(`文档里的测试数 ${counts.length ? counts.join("、") : "（没找到）"}`);
  if (counts.length > 1)
    console.log("  ⚠ 文档之间不一致：跑 npm run ship:gate 一次就平");
  if (manifest && manifest.version !== pkg)
    console.log(`  ⚠ version.json 落后于 package.json：跑 npm run ship:next -- ${pkg}`);
  const ahead = gitSoft(["rev-list", "--count", "HEAD", "--not", "--remotes"]);
  if (ahead) console.log(`未推送提交    ${ahead}`);
}

function gate() {
  node(["node_modules/typescript/bin/tsc", "-b"]);
  const out = node(["node_modules/vitest/vitest.mjs", "run"], { capture: true });
  const { files, tests } = parseCounts(out);
  ok(`门禁测试 ${files} 个文件 / ${tests} 例 全绿`);
  const touched = syncCounts({ files, tests });
  console.log(
    touched.length
      ? `✓ 测试数已写回文档：${touched.join("、")}（记得提交）`
      : "✓ 文档里的测试数与实际一致，无需改动",
  );
  node(["node_modules/vite/bin/vite.js", "build"]);
  node(["scripts/check-startup-bundle.mjs"]);
  ok("构建与首屏包守卫通过");
  if (dirty())
    console.log(
      `\n下一步：git add -A && git commit（提交后才允许 pack / deploy）`,
    );
}

function pack() {
  requireClean("打包");
  // make-release 会校验产物里带着当前提交号；上一轮若用私有配置构建过，
  // dist/ericher_app 可能是旧提交 —— 这里强制先按公开配置重建。
  node(["node_modules/vite/bin/vite.js", "build"]);
  const out = node(["scripts/make-release.mjs"], { capture: true });
  process.stdout.write(out);
  const sha = /sha256 ([0-9a-f]{64})/.exec(out)?.[1];
  ok(`发布包已生成（提交 ${short()}）${sha ? `  sha256 ${sha}` : ""}`);
}

function deploy() {
  requireClean("部署");
  if (!existsSync(path.join(root, PRIVATE_CONFIG)))
    die(
      `没有 ${PRIVATE_CONFIG}：私有部署没有目标，公开示例部署请直接跑 node scripts/deploy.mjs`,
    );
  const out = node(["scripts/deploy.mjs", "--private"], {
    capture: true,
    env: { HR_DESK_WRANGLER_CONFIG: PRIVATE_CONFIG },
  });
  const id = /Current Version ID:\s*([0-9a-f-]{36})/.exec(out)?.[1];
  process.stdout.write(out.slice(-800));
  ok(`已部署（提交 ${short()}）线上版本 id ${id ?? "（没读到，去 dashboard 核对）"}`);
}

function next() {
  const to = argv[1] && !argv[1].startsWith("--") ? argv[1] : undefined;
  if (!to || !/^\d+\.\d+\.\d+(\.\d+)?$/.test(to))
    die(
      `用法：node scripts/ship.mjs next 0.1.7.1 --title "这一版的主线"` +
        `（版本号取三段或四段：安全/小修补可走 0.1.6.5 这种四段）`,
    );
  const { pkg } = versionIds();
  if (to === pkg) die(`package.json 已经是 ${to}`);
  const title = flagValue("title") || "（待补：这一版改了什么）";
  const day = new Date().toISOString().slice(0, 10);

  const pkgPath = "package.json";
  const pkgText = read(pkgPath).replace(
    /^(\s*"version":\s*")[^"]+(")/m,
    `$1${to}$2`,
  );
  if (!pkgText.includes(`"version": "${to}"`)) die("没找到 package.json 的 version 字段");
  write(pkgPath, pkgText);
  ok(`package.json → ${to}`);

  const changePath = "CHANGELOG.md";
  const change = read(changePath);
  if (new RegExp(`^## v${to.replace(/\./g, "\\.")}`, "m").test(change))
    die(`CHANGELOG 里已经有 v${to} 那一节`);
  const at = change.search(/^## v/m);
  const section =
    `## v${to} · ${day}\n\n` +
    `这一版的主线是${title}。\n\n` +
    `### 改了什么\n\n- 待补：逐项写「实际改了什么」，不写计划。\n\n` +
    `### 实测\n\n- 待补：哪些是浏览器/真机验过的，哪些只是门禁绿。\n\n` +
    `### 门禁与交付\n\n- 全量 **待补 个测试文件 / 待补 例**通过；` +
    `线上版本 id 待补；发布包（提交待补）sha256 待补。\n\n`;
  write(
    changePath,
    at === -1 ? `${change}\n\n${section}` : change.slice(0, at) + section + change.slice(at),
  );
  ok(`CHANGELOG 顶部插入 v${to} 骨架（三处待补由人填，脚本不编内容）`);

  const manifest = {
    version: to,
    hash: short(),
    message: `feat: ${to} —— ${title}`,
    date: new Date().toISOString(),
  };
  write("version.json", JSON.stringify(manifest, null, 2) + "\n");
  ok(`version.json → ${to} @ ${manifest.hash}`);
  console.log(
    `\n下一步：填完 CHANGELOG 三处待补 → npm run ship:gate → 提交 → ship:pack → ship:deploy`,
  );
}

/** 取一次 GitHub 凭据：push 与 release API 共用，避免分两步各弹一次登录窗 */
function credentialFill() {
  const r = spawnSync("git", ["credential", "fill"], {
    cwd: root,
    encoding: "utf8",
    input: "protocol=https\nhost=github.com\n\n",
  });
  if ((r.status ?? 1) !== 0)
    die(`取不到 GitHub 凭据：${(r.stderr || "").slice(0, 200)}`);
  const out = r.stdout || "";
  const username = /^username=(.*)$/m.exec(out)?.[1]?.trim();
  const password = /^password=(.*)$/m.exec(out)?.[1]?.trim();
  if (!password) die("凭据里没有 password（token）");
  return { username: username || "x-access-token", password };
}

async function pushGit() {
  if (!has("yes"))
    die(
      "推 GitHub 需要显式 --yes（线上部署不等于已发布）",
    );
  requireClean("推 GitHub");
  const proxy = flagValue("proxy");
  const proxyArgs = proxy ? ["-c", `http.proxy=${proxy}`] : [];
  const { pkg } = versionIds();
  const tag = `v${pkg}`;

  // 凭据只取一次；下面用一次性 helper 通过环境变量交给 git，token 不进 argv
  const cred = credentialFill();
  ok("已拿到 GitHub 凭据（本次运行内复用）");
  const authArgs = [
    "-c",
    "credential.helper=",
    "-c",
    'credential.helper=!f() { echo "username=$SHIP_GIT_USER"; echo "password=$SHIP_GIT_PASS"; }; f',
  ];
  const authEnv = { SHIP_GIT_USER: cred.username, SHIP_GIT_PASS: cred.password };

  run("git", [...proxyArgs, ...authArgs, "push", "origin", "HEAD:main"], {
    env: authEnv,
  });
  ok("已推 main");
  const hasTag = git(["tag", "--list", tag]);
  if (!hasTag) {
    run("git", ["tag", "-a", tag, "-m", `${tag} ${subject()}`]);
    ok(`已打 tag ${tag}`);
  }
  run("git", [...proxyArgs, ...authArgs, "push", "origin", tag], {
    env: authEnv,
  });
  ok(`已推 tag ${tag}`);

  const zipRel = `release/ericher-${pkg}-cf.zip`;
  const shaRel = `${zipRel}.sha256`;
  if (!existsSync(path.join(root, zipRel))) {
    console.log(`（没有 ${zipRel}：跳过 release 资产，先跑 npm run ship:pack）`);
    return;
  }
  const owner = flagValue("owner") || "leleou209";
  const repo = flagValue("repo") || "ericher";
  // 用开头取到的那一份，不再 fill 第二次
  const token = cred.password;

  const api = (method, url, body) =>
    spawnSync(
      "curl",
      [
        "-sS",
        "-X",
        method,
        "-H",
        `Authorization: Bearer ${token}`,
        "-H",
        "Accept: application/vnd.github+json",
        ...(body ? ["-H", "Content-Type: application/json", "-d", body] : []),
        ...(proxy ? ["-x", proxy] : []),
        `https://api.github.com${url}`,
      ],
      { cwd: root, encoding: "utf8" },
    ).stdout || "";

  let rel = JSON.parse(
    api("GET", `/repos/${owner}/${repo}/releases/tags/${tag}`) || "{}",
  );
  if (!rel.id) {
    rel = JSON.parse(
      api(
        "POST",
        `/repos/${owner}/${repo}/releases`,
        JSON.stringify({
          tag_name: tag,
          name: `${tag} 部署包`,
          body: `解压后在包目录里 \`npx wrangler@4 deploy\` 即可，细节见包内 DEPLOY.md。`,
        }),
      ) || "{}",
    );
    if (!rel.id) die(`建 release 失败：${JSON.stringify(rel).slice(0, 200)}`);
    ok(`已建 release ${tag}`);
  }
  const name = path.basename(zipRel);
  for (const asset of rel.assets || []) {
    if (asset.name !== name) continue;
    api("DELETE", `/repos/${owner}/${repo}/releases/assets/${asset.id}`);
    ok(`已摘掉旧资产 ${name}`);
  }
  const shaText = existsSync(path.join(root, shaRel))
    ? read(shaRel).trim().split(/\s+/)[0]
    : "";
  const upload = spawnSync(
    "curl",
    [
      "-sS",
      "-X",
      "POST",
      "-H",
      `Authorization: Bearer ${token}`,
      "-F",
      `name=${name}`,
      "-F",
      `file=@${zipRel}`,
      ...(proxy ? ["-x", proxy] : []),
      `https://uploads.github.com/repos/${owner}/${repo}/releases/${rel.id}/assets?name=${name}`,
    ],
    { cwd: root, encoding: "utf8" },
  );
  const upJson = JSON.parse(upload.stdout || "{}");
  if (!upJson.id) die(`资产上传失败：${(upload.stdout || "").slice(0, 200)}`);
  ok(`已挂新资产 ${name}${shaText ? `（sha256 ${shaText.slice(0, 16)}…）` : ""}`);
}

const table = {
  status,
  gate,
  pack,
  deploy,
  next,
  git: pushGit,
};

const fn = table[cmd];
if (!fn) {
  console.log(
    [
      "用法: node scripts/ship.mjs <命令>",
      "",
      "  status            看当前提交 / 版本号 / 文档测试数是否对齐",
      "  gate              类型 + 测试 + 把测试数写回文档 + 构建 + 首屏守卫",
      "  next <版本> --title \"…\"   升版本号 + CHANGELOG 骨架 + version.json",
      "  pack              干净树前提下重建公开产物并打部署包（打印 sha256）",
      "  deploy            干净树前提下部署私有目标（打印线上版本 id）",
      "  git --yes         推 main + 打 tag + 换 release 资产（默认拒绝）",
      "",
      "公约见 docs/release-workflow.md。",
    ].join("\n"),
  );
  process.exit(cmd === "help" ? 0 : 1);
}
Promise.resolve(fn()).catch((e) => die(String(e?.stack ?? e)));
