# dsh-release 手册

面向「要用它发版」和「要改它」两种人。README 讲怎么用，这里讲**每一步到底做了什么、失败时意味着什么**。

---

## 1. 为什么要有这个插件

### 1.1 发布本身是七步串行，且不可逆

```
版本同步 → 测试 → npm pack → git commit/tag/push → GitHub Release → npm 发布 → 核验
```

手工做一次要敲十几条命令，跨三个系统（本地 git、GitHub API、npm registry）。
错一步的代价不对称：**包一旦发出去就撤不回来**（npm 只允许 72 小时内 unpublish，而且会留痕）。

### 1.2 `npm publish` 的成功信号是假的

实测：`npm publish` 返回退出码 0，debug log 里是

```
http fetch PUT 202 https://registry.npmjs.org/dsh-websift 2566ms
```

`202 Accepted` 意思是「我收下了，稍后处理」。当时 `npm view dsh-websift version` 还返回旧版本，
大约一分钟后才变成新的。**只看退出码就会报「发布成功」，而实际上 registry 上还是旧版本。**

所以这个插件的核验不是可选项：

- 轮询 `https://registry.npmjs.org/<包名>/<版本>`，直到出现为止（默认最多 240s）
- 把 `dist.tarball` 下载回来算 sha256，和本地 `npm pack` 的产物逐字节比
- 同时比 `dist.shasum`
- 再去 GitHub 读 Release 附件的 `digest`，同样比 sha256

三者都对了才算成功。任何一处对不上，报告里会写明是哪一处、两个哈希各是什么。

### 1.3 npm 正在淘汰长期令牌

| 时间 | 变化 | 状态 |
|---|---|---|
| 2026-08 | bypass-2FA 令牌不能再做账号/组织/包管理类操作（建删令牌、改 maintainer、改 trusted publishing 配置） | **已生效** |
| 2027-01（目标） | bypass-2FA 令牌**失去直接发布**；只剩读私有包 + staged publishing | 计划中 |

来源：[7-31 公告](https://github.blog/changelog/2026-07-31-restricting-npm-bypass-2fa-granular-access-tokens/)、
[7-08 公告](https://github.blog/changelog/2026-07-08-npm-install-time-security-and-gat-bypass2fa-deprecation/)。

本机实测佐证：`npm trust list dsh-websift` 用 bypass-2FA 令牌直接 `403 Forbidden`。
（同一条限制不影响 `npm publish` —— 那个现在还能用。）

于是有了三条通道，工具默认会自动选，也可以显式指定。

---

## 2. 工具链自举（这一节解释为什么它在这台机器上能跑）

DSH 桌面版自带一个完整的 Node（就是 Electron）。这台机器的 PATH 里**没有 node、没有 npm，
`C:\Program Files\Git` 也不存在** —— 但 `@dsh-ops` 插件包自带一份 git。

### 2.1 git

`findGit()` 的顺序：

1. `settings.gitPath`（显式配置，存在就用）
2. `process.env.PATH` 里每个目录下的 `git.exe` / `git`
3. `~/.dsh/profiles/*/node_modules/@dsh-ops/bash-win32-x64/ucrt64/bin/git.exe`
4. `C:\Program Files\Git\cmd\git.exe`、`(x86)`、`%LOCALAPPDATA%\Programs\Git\cmd\git.exe`、`/usr/bin/git` …
5. 最后赌一次 `git --version`（应对 `.cmd` 包装这类 `existsSync` 探不到的情况）

每个候选都真的跑一次 `git --version`，跑通才算数（**存在 ≠ 可执行**）。

### 2.2 npm

`ensureNpm()` 的顺序：

1. `settings.npmCli`
2. `process.execPath` 旁边的 `node_modules/npm/bin/npm-cli.js`（真装了 node 的机器）
3. 缓存：`~/.dsh/storages/release/npm/current/package/bin/npm-cli.js`
4. 从 `https://registry.npmjs.org/npm/-/npm-<版本>.tgz` 下载解包后缓存

第 4 步的 tar.gz 解包是 `lib/proc.js` 里的 `extractTarGz()`：`zlib.gunzipSync` + 一个 ustar 解析器
（512 字节头，name 在 0..100，size 是 124..136 的八进制，typeflag 在 156）。带目录穿越防护。
实测下载 2.9MB，解包 15 秒左右，只发生一次。

### 2.3 node 垫片

`npm test` 会去执行 `package.json` 里的 `scripts.test`（例如 `node test/test-semver.mjs`），
而 PATH 里没有 node。所以 `ensureNodeShim()` 在 `~/.dsh/storages/release/bin/` 下写一个：

```bat
@echo off
set ELECTRON_RUN_AS_NODE=1
"C:\...\DeepSeek Harness.exe" %*
```

然后每次跑 npm 都把这个目录塞进子进程 `PATH` 的最前面。`ELECTRON_RUN_AS_NODE=1` 让 Electron
以 Node 模式启动，不弹窗口、不加载 GUI。

> ⚠️ 顺带记一笔踩过的坑：给 `spawn` 传 `windowsHide: true` 在 Windows 上会通过 STARTUPINFO 传
> `SW_HIDE`，把子进程自己的第一次 `ShowWindow` 覆盖掉。我们起的都是控制台程序（git / npm），
> 本来就不创建窗口，所以**一律不传这个选项**。

---

## 3. `prepare` 采集了什么

`prepare` 是一条只读路径：不写文件、不碰远端。它做这些查询：

| 项目 | 来源 |
|---|---|
| 包名、版本、repository、scripts | 目标目录的 `package.json` |
| `dsh-plugin.json` 的版本 | 用于比对**版本漂移**（这个仓库自己就踩过：`package.json` 是 1.0.8，`dsh-plugin.json` 还停在 1.0.6） |
| CHANGELOG 里有没有目标版本段落 | 正则扫 `^#+\s*\[?v?<版本>\b` |
| 分支 / 脏工作区 / 远端 / 领先落后 | `git rev-parse`、`git status --porcelain`、`git remote get-url`、`git rev-list --left-right --count` |
| registry 上已发布版本 | `GET https://registry.npmjs.org/<包名>` |
| 凭证可用性 | `npm whoami`（跑得通就是可用），以及 `npm` CLI 版本 |
| 有没有 OIDC workflow | 扫 `.github/workflows/*.y{a,}ml` 里有没有 `id-token: write` |
| GitHub 凭证 | 见 §5 |

**会拦住发布的冲突**（`collisions`）：

- 目标版本号不合法
- 目标版本 ≤ 当前版本
- registry 上已经存在这个版本
- 不是一个 git 仓库

有冲突时卡片最后一行不是「下一步」而是「不可发布」，并且 `apply` 会直接拒绝执行。

**只是提醒、不拦**：`dsh-plugin.json` 版本漂移、CHANGELOG 没有本版段落、没有 test 脚本、
`package.json` 里没有 GitHub 地址（那就不建 Release）。

---

## 4. `apply` 每一步在做什么

### 4.1 版本同步

- `package.json` → `version` 写目标版本（`JSON.stringify(…, 2)` + 末尾换行）
- `dsh-plugin.json`（如果存在）→ 同样写
- 传了 `changelog_entry` 才动 `CHANGELOG.md`：在 H1 标题之后插入
  `## <版本> — <YYYY-MM-DD>` 和内容。没有 H1 就插到最前面。

幂等：目标版本已经等于当前值时说「已经是 x.y.z（跳过）」。

### 4.2 测试

`npm test`（走 §2.3 的垫片）。失败就**立刻停**，不再往下走 —— 不会打包、不会提交、不会发布。
没有 `test` 脚本则标注为跳过，并在报告里用 `·` 而不是 `✔`。

### 4.3 打包

`npm pack --json`，解析产物名 / shasum / 文件数，再自己算一遍 sha256。

> 这里踩过一个坑：**npm 12.2.1 的 `pack --json` 返回的是对象**（键是包名），
> 老版本返回的是数组。按数组解析会 `SyntaxError`。
> `parsePackOutput()` 两种都认，`test-pack.mjs` 专门锁住这个行为。

### 4.4 git

```
git add -A
git commit -m <message|release: v<版本>>
git tag -d <tag>            # 清掉同名旧 tag，失败无所谓
git tag -a <tag> -m …
git push origin <分支>
git push origin <tag>       # 失败时再试一次 --force（重发同一版本时用得到）
```

**身份兜底**：这个仓库没配 `user.email`，`git commit` 会报 `unable to auto-detect email`。
所以先读 `git log -1 --format=%an%n%ae` 拿历史提交的身份，用 `-c user.name=… -c user.email=…`
传进去；没有历史提交时才退回 `git config`，最后才是兜底值。

### 4.5 GitHub Release

`POST /repos/{owner}/{repo}/releases`，`prerelease` 由 §6 的口径决定。
返回 422（同名 Release 已存在）时会 `GET .../releases/tags/<tag>` 取回来复用，而不是直接报错。

然后 `POST https://uploads.github.com/.../releases/{id}/assets?name=<文件>` 上传 tgz。

### 4.6 npm 发布

| 通道 | 命令 |
|---|---|
| `token` | `npm publish --access <access>` |
| `stage` | `npm stage publish --access <access>` |
| `ci` | **本地什么都不发**，只推 tag，交给 workflow |

`ci` 通道下本地不发布是刻意的：两边都发会撞版本号（`409`）。

### 4.7 核验

见 §1.2。`stage` 通道下包还没公开，核验会明确标注「跳过，批准后可用 `action:"verify"` 复核」，
而不是假装成功。

### 4.8 可选：装进 profile

`install: true` + `profile: "desktop"` 时会跑
`dsh plugin --profile <p> add file:<产物 tgz>`。CLI 路径从 `process.execPath` 旁边推
（`resources/runtime/cli/bin/dsh.cmd`）。装完**要重启 DSH** 才加载宿主半。

---

## 5. GitHub 凭证从哪来

顺序（全程不把令牌写进对话，报告里只有「来源 + 类型前缀 + 末 4 位」）：

1. `settings.githubToken`（插件配置 / `settings.json`）
2. 环境变量 `GITHUB_TOKEN` → `GH_TOKEN`
3. `~/.dsh/storages/dsh-github/settings.json` 的 `token` 字段（复用 `dsh-github` 插件已经存好的）
4. `git credential fill`（`protocol=https` / `host=github.com`）—— 复用 git 凭据管理器里已有的那份

第 4 条实测在本机可用：返回 `username=x-access-token` 加一个 40 字符的 `ghp_…`。
所以**只装了 `git` 和 `dsh-github` 的话，这个插件不需要任何额外配置就能建 Release**。

---

## 6. 发布口径

```
0.x  →  prerelease: true   （GitHub Release 标预发布，不算 Latest）
1.x+ →  prerelease: false  （正式版）
```

`prerelease` 参数取值 `auto`（默认）/ `true` / `false`。显式值永远优先。

---

## 7. 失败模式对照表

| 报告里出现 | 意思 | 怎么办 |
|---|---|---|
| `不能发布，先解决这些问题` | `prepare` 阶段就发现了冲突 | 按列出的条目改；撞版本就换版本号 |
| `npm test 失败（1）` | 测试没过，**没有任何副作用** | 修测试 |
| `git commit 失败` | 通常是身份或钩子 | 看报告里的 stderr 尾部 |
| `创建 Release 失败（403）` | 令牌没 `repo` 权限 | 换令牌，或检查 `dsh-github` 里存的那份 |
| `npm publish 已受理（HTTP 202…）` | 命令成功，但**还没确认上线** | 看紧随其后的核验结果 |
| `等了 240s 也没在 registry 上看到 x.y.z` | 发布实际失败了，或 CI 还在跑 | 本地发就看 npm 的 debug log；CI 发就看 Actions |
| `npm tarball ≠ 本地 …` | registry 上的包和本地产物不是同一份 | **重点排查**：是不是有别的流程也在发，或 `files` 白名单与本地不一致 |
| `GitHub Release 上没有找到附件` | 附件上传失败 | 重新 `apply` 只会重复建 Release，先手动补附件 |
| `npm trust list` 返回 403 | 正常现象，见 §1.3 | 那一步要交互式 2FA，用网页做 |

---

## 8. 测试怎么跑

| 文件 | 覆盖 | 需要网络 |
|---|---|---|
| `test-semver.mjs` | 版本解析/递增/比较，含预发布与非法输入 | 否 |
| `test-policy.mjs` | 预发布口径、tag/产物命名、仓库地址解析、通道选择 | 否 |
| `test-pack.mjs` | `npm pack --json` 的两种形状、字符串里的括号、残缺 JSON | 否 |
| `test-plan.mjs` | 计划卡片必须出现的关键信息；冲突时不给执行命令 | 否 |
| `test-fixture.mjs` | 真临时 git 仓库上跑 `prepare` / 同步 / `setup-ci` | 只读查一次 registry |
| `diag-env.mjs` | npm 自举（下载+解包）、`whoami`、真 `npm pack` | 是 |
| `diag-pack.mjs` | 打印 `npm pack --json` 的原始输出 | 是 |

`test-fixture.mjs` 用 `test/stub-npm-cli.js` 顶替 npm CLI（`--version` / `whoami` / `test` / `pack` 各回一句），
所以它验证的是「spawn → 解析输出 → 判断」这条链路本身，而不是 npm 的行为。

跑法（本机没有 node）：

```bash
export ELECTRON_RUN_AS_NODE=1
"C:/Users/Administrator/Desktop/DeepSeek Harness/DeepSeek Harness.exe" test/test-fixture.mjs
```

---

## 9. 加新功能前的三条评审

沿用既定标准，任一为「是」就不做或改设计：

1. **会不会大幅增加 token 消耗？** —— 一次调用只回一份摘要，不产生中间态。
   工具描述本身也算常驻成本，所以写得很紧。
2. **会不会让上下文不连贯？** —— `prepare` 一张卡片、`apply` 一份报告，没有中间过程外泄。
3. **会不会准确性不足？** —— 这是本插件最敏感的一条：**宁可说「没确认」也不说「成功」**。
   所以有 §1.2 的哈希核验、`202` 不当成功、`stage` 通道明确标注「还没公开」。

**已按此否决**：自动猜版本号（`bump` 默认 patch 但仍要 `prepare` 确认一次）、
自动写 CHANGELOG 正文（内容判断不了，改成显式传 `changelog_entry`）、
monorepo 批量发布（容易误判哪个包该发）。

---

## 10. 已知限制

- 只在 Windows 上实测；POSIX 分支写了但没跑过。
- 一次只处理一个 `package.json` 所在目录，不认 workspaces / monorepo。
- `ci` 通道的 npm 侧配置（`npm trust github` 或网页）需要人做 2FA，工具只生成文件并给命令。
- `verify` 动作对 `stage` 通道的包无能为力（还没公开）。
- GitHub Enterprise / 自建 registry 需要改 `lib/index.js` 里的 `REGISTRY` 与 API base。