# 版本管理与发布公约

一次更新 = **一个提交 + 一个版本号 + 一个部署包 + 一个线上版本 id**。这四样由 `scripts/ship.mjs` 串起来产出，
人不抄数字、不记顺序、不靠记忆判断「这次算不算发版」。

命令表：`node scripts/ship.mjs status | gate | next <版本> | pack | deploy | git --yes`
（`npm run ship:gate` / `ship:pack` / `ship:deploy` / `ship:git` 是同一条的别名）

## 1. 版本号的口径

- **`package.json` 的 `version` 是唯一真值。** `version.json` 是发布清单，线上 `/api/update-check` 拿它比新旧 —— 比的是 `version` 字段，`hash` 只作显示（两边提交号几乎永远对不上，这行代码里写明了）。
- 版本号取三段或四段：能力版 `0.2.0`，修补 `0.1.8`，**只发安全/小修 patch 时用四段**（`0.1.6.5`、`0.1.7.1` 是既有先例），免得为一个安全补丁占掉一个能力版本号。
- tag 一律 `v<版本>`，打在这次发布的最后一个提交上。
- 三者只能由 `ship next` 一次改齐。手改 `version.json` 而不改 `package.json`，线上就会出现「提示有更新，但更新提示自己就是旧的」。

## 2. 什么算一次更新

- 用户能看见的变化（界面、行为、接口、口令/会话语义）才升号。
- **安全修复一律升号**，哪怕只有几行：不升号就没法向使用者说明「你该换了」，也无法让 release 资产对上修复内容。
- 纯注释、纯内部整理不单独发版，攒到下一次升号一起走。
- 一次发布只讲一条主线；CHANGELOG 顶部那一句话就是这条主线，写「实际改了什么」，不写计划。

## 3. 顺序（每步的准入条件）

| 步 | 命令 | 前置 | 产出 |
|---|---|---|---|
| 1 | `npm run ship:gate` | 改完代码 | 类型 + 全量测试 + **测试数写回四处文档** + 生产构建 + 首屏守卫 |
| 2 | `git commit` | 门禁绿 | 内容提交（`feat:` / `fix:` / `perf:` / `docs:`） |
| 3 | `npm run ship:next -- 0.1.7.1 --title "…"` | 工作树干净 | `package.json` + `version.json`（hash=HEAD）+ CHANGELOG 骨架 |
| 4 | 手写 CHANGELOG → `git commit` | 骨架填实 | 发布提交（`chore: 发布 X —— 版本号与发布清单同步`） |
| 5 | `npm run ship:pack` | 工作树干净 | `release/ericher-<版本>-cf.zip` + `.sha256` |
| 6 | `npm run ship:deploy` | 工作树干净 | 线上 Worker 版本 id |
| 7 | CHANGELOG 补 id 与 sha → `git commit` | 5、6 的数字 | 交付记录 |
| 8 | `npm run ship:git` | 全部提交完 | push main + tag + release + 挂资产 |

脚本的硬闸：`pack` / `deploy` / `git` 都**拒绝脏工作树**（产物与线上必须对应一个确定的提交）；
`pack` 前强制按公开配置重建（否则 `dist/ericher_app` 可能带着上一次私有构建的提交号，打包时校验会莫名其妙地红）；
`git` 没有 `--yes` 直接退出 —— **线上部署不等于已发布**。

## 4. CHANGELOG 的写法

- 三小节固定：**改了什么 / 实测 / 门禁与交付**。
- 「实测」只写浏览器或真机验过的；门禁绿不等于能用，UI 改动的验收结论必须来自实机。
- 「门禁与交付」写死四个数：测试文件数与例数、线上 Worker 版本 id、包名与提交号、sha256。
- 改了口令、会话、权限语义的发布，必须写明**升级后使用者要做什么**（例：旧票全部失效需重登）。

## 5. 文档里的下载指引

`README.md`、`docs/guide.html`、`docs/promo-home.html` 三处都有包名 / 大小 / SHA-256 / 下载直链。
换版本时必须一起改，否则用户按旧 sha 校验新包会一路报到「包被改过」。测试数由 `ship:gate` 代劳，
包名与校验值由 `ship:pack` 输出后代填。

> 注意：`docs/guide.html` 与 `docs/promo-home.html` 是仓库里的**源码副本**，线上的 `/guide`、`/home`
> 是矩阵存在 R2 里的页面。改完仓库不会自动生效，需要在工作台里把正文换上去（这一步要管理员登录，脚本代不了）。

## 6. GitHub 侧

- 远端 `github.com/leleou209/ericher`，分支 `main`；发布资产名 `ericher-<版本>-cf.zip`。
- 不配 CI：本地 `npm run check` 就是判据，CI 只是把同一件事再花一遍钱。
- 这台机器直连 github.com 是 TCP 通、TLS 握不上（SNI 层丢包），推送要借本机代理：
  `npm run ship:git -- --proxy=socks5h://127.0.0.1:10808`。代理只作一次性参数传入，不写进全局 git 配置。
- 凭据只取一次、在同一条命令里用完。反复 `git credential fill` 会一次次弹账号选择窗。
- 顺序：push main → 打 tag → push tag → 建/换 release → 摘同名旧资产 → 挂新资产。资产必须在 `pack` 之后挂，
  否则 release 指向的 zip 与 `version.json` 说的版本不是同一份东西。

## 7. 回滚

- 线上：Cloudflare → Worker → Versions，回滚到 CHANGELOG 里记着的上一个版本 id。
- 发布面：GitHub release 的旧资产可以先摘后挂；本地 `release/` 目录保留每版 zip 与 sha256。
- 矩阵：装备包前服务器自动留底 `matrix/snapshot/prev.zip`，`/api/matrix/pack/rollback` 一条命令回。
- 数据：DO / R2 **没有版本回滚**。所以口令、会话、权限这类改动要向前兼容 —— 旧条目能验、能就地升级，
  不要设计成「升级即作废」。

## 8. 不入库

`.dev.vars`、`.wrangler.local.jsonc`、`output/`、`release/`、`dist/`。
打包脚本会扫一遍包内文本，命中本地 secret 的真值就停止打包。
