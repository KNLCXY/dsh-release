# 变更记录

## 0.1.2 — 2026-11-08

修「找不到 git」：`findGit()` 现在会**扫描 dsh-ops 的临时目录**。

- **根因**（`dsh-ops` 0.5.0 改了布局，不是框架问题）：它自带的 git 从固定的
  `node_modules/@dsh-ops/bash-win32-x64/ucrt64/bin/git.exe` 挪到了
  `%TEMP%\dsh-ops-niu-exec-<随机>\winuxcmd\usr\bin\git.exe`，而且**每次启动新建一个**；
  那个固定目录现在是空的。
  bash 会话能用（dsh-ops 往 PATH 注入了临时目录），但**桌面启动的宿主进程拿不到** ——
  于是 `release` 工具在 desktop 上直接报「找不到 git」，`prepare` / `apply` 全废。
- **修法**：新增 `dshOpsTempGitCandidates()`，扫 `%TEMP%/dsh-ops-*/` 下两种布局
  （0.5.x 的 `winuxcmd/usr/bin`、0.4.x 的 `ucrt64/bin`），**按 mtime 倒序**（最新的最可能是
  当前这次启动的），逐个实测 `--version` 跑通才算。路径来自扫描时 `how` 标为
  「dsh-ops 临时目录（扫描发现）」，便于排错时一眼看出走的是哪个分支。
- 新增回归测试 `test/test-git-discovery.mjs`（9 条断言）：验证新旧两种布局都能发现、
  mtime 排序、不相关目录（`npm-cache`、`dshx-*` 等）绝不进候选、空路径不抛错。
- 新增诊断 `test/diag-host-git.mjs`：剔除 PATH 里的 dsh-ops 目录来**模拟宿主视角**，
  确认裸 `git` 不可用的情况下 `findGit` 仍能从临时目录兜住。实测通过。

## 0.1.1 — 2026-10-25

修一个**静默失效**的 bug：`/_release/settings` 路由**有时根本不注册**（竞态）。

- **根因**：`apply()` 里直接 `ctx.get('webServer')`。cordis 的 `get()` 对「还没 provide 的服务」
  返回 `undefined`（`inject` 才是等它就绪的机制），所以这条路由只有在 webServer
  **恰好已经就绪**时才注册。外层还套了 `try/catch`，把这次失败彻底吞掉 ——
  插件看起来加载正常，路由其实不存在。
- **修法**：改用 `ctx.inject(['webServer'], cb)`，服务可用时（现在或以后）再注册；
  同时**不**把 `webServer` 写进 `inject`，否则没有 web 的 profile（headless / tui）会整个插件不加载。
- **发现的经过**：在 **DSH 0.2.1-rc.3** 的临时 profile 上实测时暴露。一开始以为是 rc.3 的回归，
  做了 2×2 对照才确认**跟 rc.2/rc.3 完全无关**：

  | 宿主 | profile | 插件版本 | `GET /_release/settings` |
  |---|---|---|---|
  | rc.2 | 精简临时 profile | 0.1.0 | **404** |
  | rc.3 | 精简临时 profile | 0.1.0 | **404** |
  | rc.2 | 精简临时 profile | 0.1.1 | **200** |
  | rc.3 | 精简临时 profile | 0.1.1 | **200** |
  | rc.2 | desktop（十几个插件） | 0.1.0 | **200** ← 抢赢了竞态 |

  变量是**插件多少**（决定 apply 时 webServer 就绪没有），不是宿主版本。
- **被误导的地方**：POST 到**任何**未知路径都返回 405，看起来像「路由已注册」。
  判断路由是否注册只能看 GET —— 而且随机路径的 GET 也是 404，所以必须拿**已知路径**对照。
- 新增回归测试 `test/test-optional-service.mjs`（7 条断言）：先在旧代码上验证它会失败，再修。

## 0.1.0 — 2026-10-24

首个版本。

- `release` 工具，四个动作：`prepare` / `apply` / `setup-ci` / `verify`
- 发布主流程：版本同步 → 测试 → npm pack → git 提交打 tag 推送 → GitHub Release + 附件 → npm 发布 → 核验
- **三处哈希核验**：把 registry 上的 tarball 下回来算 sha256、GitHub Release 附件的 `digest`，
  和本地产物逐字节比对；npm 的 `202 Accepted` 不当成功
- 三条 npm 通道：`token` / `stage`（staged publishing，人工 2FA 批准）/ `ci`（OIDC trusted publishing），
  `auto` 会按仓库里有没有 `id-token: write` 的 workflow 自动选
- `setup-ci` 生成 `.github/workflows/release.yml`（含升级 npm 到 ≥ 11.5.1 的一步），并给出 npm 侧命令
- **工具链自举**：PATH 里没有 node/npm 也能跑 —— 找 git、从 registry 下载并缓存 npm CLI（自带 tar.gz 解包）、
  造 `node.cmd` 垫片让 `npm test` 里的 `node xxx.mjs` 能执行
- GitHub 凭证自动寻源：插件配置 → 环境变量 → `dsh-github` 存储 → `git credential fill`；只显示类型前缀+末 4 位
- 默认只出计划（`prepare`），`apply` 才动手；撞版本、不是 git 仓库、版本号不合法都会在动手前拦住
- 5 个测试：`semver` / `policy` / `pack` / `plan` / `fixture`（真临时 git 仓库，假 npm，离线）