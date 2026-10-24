# 变更记录

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