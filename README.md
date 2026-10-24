# dsh-release

给 DeepSeek Harness 一个 `release` 工具：**一次调用把发布走完，并用 sha256 证明三处一致。**

仓库：<https://github.com/KNLCXY/dsh-release> · 尚未发布到 npm（见下面「安装」）

```text
release({ action: "prepare", repo: "…/repo/dsh-websift" })     ← 先看计划，什么都不改
release({ action: "apply",   repo: "…/repo/dsh-websift", bump: "patch" })
```

## 它解决什么

发布一个包要经过这么多步，每一步都能单独出错：

```
版本同步 → 测试 → npm pack → 提交 + 打 tag + 推送 → GitHub Release + 传附件 → npm 发布 → 核验
```

而且 **发布不可逆**，npm 的 `publish` 又返回 `202 Accepted`（异步受理）—— 光看命令退出码
根本不知道到底上线了没有。已经踩过的坑就在眼前：`npm publish` 明明成功，registry 上却还是旧版本。

这个工具的两条硬规矩：

1. **默认只出计划。** `action: "prepare"` 不改任何文件、不写任何远端，只把「要发什么、有什么风险、
   下一步敲什么」摆出来。真正动手必须显式 `action: "apply"`。
2. **只在 registry 上真的查到、且哈希对得上时才说「发出去了」。** 报告里的每一行都有出处：
   npm 下载回来的 tarball 算 sha256 和本地比，GitHub Release 附件的 `digest` 和本地比。

## 在这台机器上尤其有用

它面对的是一台 **PATH 里没有 node、也没有 npm** 的机器：

| 需要 | 它怎么解决 |
|---|---|
| `git` | PATH → `~/.dsh/profiles/*/node_modules/@dsh-ops/…/ucrt64/bin/git.exe` → 常见安装位置，逐个探活 |
| `npm` | 本机 npm → 从 registry 下载一份 npm CLI 缓存到 `~/.dsh/storages/release/npm/`（自带的 tar.gz 解包器） |
| `node`（给 `npm test` 里的脚本用） | 造一个 `node.cmd` 垫片，用 `ELECTRON_RUN_AS_NODE=1 <DSH 的 Electron>` 当 Node |
| GitHub 令牌 | 插件配置 → `GITHUB_TOKEN`/`GH_TOKEN` → `dsh-github` 的存储 → `git credential fill` |

所以这台机器上不需要预先装任何东西。

## 安装

```bash
# 从 GitHub（当前唯一的发布渠道）
dsh plugin --profile desktop add github:KNLCXY/dsh-release

# 或者本机源码目录
dsh plugin --profile desktop add file:/path/to/dsh-release
```

> **尚未发布到 npm。** 这个生态里已经有 `dsh-release-*` 一大堆同类工具（发布自检、证据、门禁……），
> 其中一个仓库名和功能描述都和这里高度重合。所以先只留 GitHub —— 名字留着，不急着往拥挤的
> npm 命名空间里再塞一个。真要 `npm i` 的时候，`release({action:"apply"})` 一条命令就能发。

改完源码要 bump `package.json` 的 version 再重新 `add`（pnpm 是按版本号判断是否复制的），
并且**重启 DSH** 才会加载宿主半。

## 工具：`release`

| 参数 | 说明 |
|---|---|
| `action` | `prepare`（默认）/ `apply` / `setup-ci` / `verify` |
| `repo` | 仓库目录，默认=当前会话工作目录 |
| `version` / `bump` | 目标版本；`bump` 取 `patch`/`minor`/`major` |
| `channel` | `auto`（默认）/ `token` / `stage` / `ci` |
| `prerelease` | `auto`（默认）/ `true` / `false` |
| `changelog_entry` | `apply` 时插进 `CHANGELOG.md` 顶部的本版说明 |
| `notes` / `name` / `message` | Release 正文、标题、提交信息 |
| `install` / `profile` | 发布后把产物装进某个 DSH profile |
| `github` / `tag` / `skip_tests` | 关掉某一步 |

`apply` 的顺序固定：

```
版本同步 → 测试 → npm pack → git commit/tag/push → GitHub Release → npm 发布 → 核验 → (可选) 装进 profile
```

任一步失败就停下，报告里说明卡在哪一步、原始错误是什么。

## 三条 npm 通道

npm 正在淘汰「长期免验证码的令牌」：账号类操作从 **2026-08** 起要交互式 2FA，
**直接发布预计 2027-01 起也会失去**（[7-31 公告](https://github.blog/changelog/2026-07-31-restricting-npm-bypass-2fa-granular-access-tokens/)）。

| 通道 | 什么时候用 | 怎么走 |
|---|---|---|
| `token` | 现在最省事 | 本机 `~/.npmrc` 里有可用凭证，直接 `npm publish` |
| `stage` | 令牌不能直接发之后 | `npm stage publish` 送进暂存区，**你在网页用 2FA 批准**才公开 |
| `ci` | 想彻底不碰令牌 | 打 tag → GitHub Actions 用 OIDC 换一张一次性凭证发布 |

`channel` 默认 `auto`：仓库里已经有 OIDC workflow 就走 `ci`（本地不再 publish，避免两边抢同一个版本号）；
否则有可用凭证走 `token`；都没有就退回 `stage`。

### 配置 OIDC（一次的事）

```text
release({ action: "setup-ci", repo: "…/repo/dsh-websift" })
```

会写一份 `.github/workflows/release.yml`（含 `id-token: write`、并会把 runner 自带的 npm 升到
trusted publishing 要求的 ≥ 11.5.1），然后告诉你 npm 侧要敲的命令：

```bash
npm trust github <包名> --file release.yml --repo <owner>/<repo> --allow-publish
```

⚠️ 这一步**必须交互式 2FA**：bypass 2FA 的令牌从 2026-08 起做不了 trusted publishing 配置
（实测 `npm trust list dsh-websift` 直接 `403`）。网页入口：
`https://www.npmjs.com/package/<包名>/access` → Trusted Publishing。
workflow 文件名必须**一字不差**（含 `release.yml` 这个扩展名），否则 OIDC 校验会失败。

配好之后 `channel` 自动选 `ci`：本地只推 tag，npm 由 CI 发。

## 发布口径

沿用既定规矩：**0.x 一律预发布**（GitHub Release 标 `prerelease`，不算 Latest），**1.x 起算正式版**。
可用 `prerelease: "true"/"false"` 覆盖。

## 配置

运行时配置写在 `~/.dsh/storages/release/settings.json`，优先级高于 `cordis.patch.yml` 里的出厂默认：

```json
{
  "gitPath": "",
  "npmCli": "",
  "npmVersion": "",
  "githubToken": "",
  "profile": "",
  "access": "public",
  "verifyTimeoutMs": 240000
}
```

`GET http://127.0.0.1:<GUI 端口>/_release/settings` 可以看到当前探到的 git 与存储位置。

## 开发

本机没有 node/npm，用 DSH 自带的 Electron 当 Node 跑：

```bash
export ELECTRON_RUN_AS_NODE=1
EXE="C:/Users/Administrator/Desktop/DeepSeek Harness/DeepSeek Harness.exe"

"$EXE" test/test-semver.mjs   # 版本号
"$EXE" test/test-policy.mjs   # 口径 / tag / 通道选择
"$EXE" test/test-pack.mjs     # npm pack 输出解析（npm 12 是对象、老版是数组）
"$EXE" test/test-plan.mjs     # 计划卡片排版
"$EXE" test/test-fixture.mjs  # 真临时 git 仓库上跑 prepare / setup-ci（离线，假 npm）
"$EXE" test/diag-env.mjs      # 需要联网：npm 自举 + 真 pack
```

`test-fixture.mjs` 用 `test/stub-npm-cli.js` 顶替 npm，所以除了一次只读的 registry 查询之外全程离线。

## 和同类工具的关系

DSH 生态里「发布工具」不算少。2026-10-24 查过一圈，比较接近的有：

| 项目 | 它做什么 | 和这里的区别 |
|---|---|---|
| `JOJO-Adam/dsh-release` | 描述同样是「一条命令走完 check/bump/test/push/publish/verify/install」 | 名字和定位高度重合，各写各的 |
| `dsh-publish-plugin`（npm） | 一键发到 npm + GitHub，fail-closed | 同样默认不执行；发布流程重叠 |
| `dsh-testkit`（npm） | **真宿主**发布门禁：装进真 DSH 跑生命周期 | 它验运行时行为，这里比字节 |
| `dsh-release-proof` | 「多源可复现发布证据」 | 最接近这里的哈希核验那块 |
| `dsh-release-guardian` / `-guard` / `-sentinel` / `-selfcheck` / `-evidence` / `-infringement-audit` | 各类发布风险检查、合规审计 | 覆盖 `prepare` 的一部分 |

这里的两条差异（**没有**逐行读过别人的源码，所以只敢说是「没看到」而不是「没有」）：

1. **三处字节一致**：npm tarball 的 sha256、GitHub Release 附件的 `digest`、本地 `npm pack` 的产物，
   两两相等才算成功。任一不一致就报失败并写出两个哈希。
2. **令牌迁移**：token / staged / OIDC 三通道按仓库现状自动选，`setup-ci` 直接生成
   `id-token: write` 的 workflow —— 应对 npm 2027-01 起停掉 bypass-2FA 令牌直接发布。

另外它是在一台**没有 node、没有 npm、git 在插件包里**的机器上长出来的，
所以 `lib/proc.js` 里那套工具链自举（找 git、下 npm、造 node 垫片）对同类环境可能也有用。

## 已知限制

- 只在 Windows 上实测过；代码里对 POSIX 做了分支，但没跑过。
- `ci` 通道是**生成 workflow + 给出 npm 侧命令**，那一步需要人做 2FA，工具不能替你点。
- `npm test` 依赖 `package.json` 的 `test` 脚本；没有就跳过并如实标注。
- 不处理 monorepo / workspaces，一次只发一个 `package.json` 所在的目录。
- 不会自动写 CHANGELOG 内容，只做「有没有这个版本的段落」的检查；要自动插段落得显式传 `changelog_entry`。

## License

MIT