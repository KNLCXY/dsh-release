// gitIdentity 的回归测试 —— 锁住「git config 优先，历史提交只能兜底」。
//
// 背景（2026-11-09）：原来的实现**优先抄最后一次历史提交的身份**。本机某次手滑用了
// npm 账号的真实邮箱提交，之后每次 release 的 apply 都把那个错邮箱一路复制下去，
// 最终 13 个公开提交带上了那个错邮箱（已全部改写为 noreply）。
//
// 所以这里最要紧的一条是「历史里是错邮箱、config 里是对的 → 必须用 config 那个」，
// 也就是 ①。谁把这行改回去，这条立刻红。
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findGit } from '../lib/proc.js'
import { loadPlugin, makeAsserts } from './_setup.mjs'

const a = makeAsserts('git-identity')
const { mod } = await loadPlugin()
const { gitIdentity } = mod.__test

const g = await findGit({})
if (!g) {
  console.log('  ⚠ 这台机器没有 git，跳过（不算失败）')
  a.done()
} else {
  const git = g          // 注意：gitRun 要的是 { path } 对象，不是字符串
  const gitIn = (cwd, args) =>
    execFileSync(git.path, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  // git config --get 在「没有这个配置」时退出码是 1 —— 那是正常结果，不是错误
  const gitTry = (cwd, args) => {
    try { return gitIn(cwd, args) } catch { return '' }
  }

  // 把全局/系统的 gitconfig 指向空文件，用来看「本机完全没配身份」时的行为。
  // 不隔离的话，本机设定的全局 noreply 会一直命中 config 分支，兜底逻辑根本测不到。
  const isolated = async (fn) => {
    const cfg = join(repo, 'empty-gitconfig')
    writeFileSync(cfg, '')
    const g0 = process.env.GIT_CONFIG_GLOBAL
    const s0 = process.env.GIT_CONFIG_SYSTEM
    process.env.GIT_CONFIG_GLOBAL = cfg
    process.env.GIT_CONFIG_SYSTEM = cfg
    try { return await fn() } finally {
      if (g0 === undefined) delete process.env.GIT_CONFIG_GLOBAL
      else process.env.GIT_CONFIG_GLOBAL = g0
      if (s0 === undefined) delete process.env.GIT_CONFIG_SYSTEM
      else process.env.GIT_CONFIG_SYSTEM = s0
    }
  }

  const repo = mkdtempSync(join(tmpdir(), 'ident-'))
  try {
    gitIn(repo, ['init', '-q'])
    gitIn(repo, ['config', 'core.autocrlf', 'false'])
    writeFileSync(join(repo, 'f.txt'), 'x')

    // 造一个「历史提交用了错邮箱」的仓库：作者 = wrong@example.com
    gitIn(repo, [
      '-c', 'user.name=Wrong Name',
      '-c', 'user.email=wrong@example.com',
      'commit', '-q', '--allow-empty', '-m', 'seed',
    ])
    const histEmail = gitIn(repo, ['log', '-1', '--format=%ae'])
    a.eq(histEmail, 'wrong@example.com', '① 前提：历史里确实是那个错邮箱')

    // ---- ① 核心回归：config 有正确身份 → 必须用 config，绝不能抄历史 ----
    gitIn(repo, ['config', 'user.name', 'KNLCXY'])
    gitIn(repo, ['config', 'user.email', '136904142+KNLCXY@users.noreply.github.com'])

    const r1 = await gitIdentity({ repo, tools: { git } })
    a.eq(r1.from, 'git config', '① config 存在时 from 应为 git config')
    const f1 = r1.flags.join(' ')
    a.has(f1, 'user.email=136904142+KNLCXY@users.noreply.github.com', '① 用的是 config 里的 noreply')
    a.ok(!f1.includes('wrong@example.com'), '① 绝不能出现历史里的错邮箱')
    a.has(f1, 'user.name=KNLCXY', '① name 也取 config')

    // ---- ② 本地没配、但全局配了 → 仍然走 config（这正是期望的行为：
    //        全局设了 noreply 之后，谁也别想再抄历史里的错邮箱） ----
    gitIn(repo, ['config', '--unset', 'user.email'])
    gitIn(repo, ['config', '--unset', 'user.name'])
    const hasGlobal = gitTry(repo, ['config', '--global', '--get', 'user.email'])
    if (hasGlobal) {
      const rGlobal = await gitIdentity({ repo, tools: { git } })
      a.eq(rGlobal.from, 'git config', '② 全局有配置时仍走 config（不会退到历史）')
      a.has(rGlobal.flags.join(' '), hasGlobal, '② 用的就是全局那个邮箱')
    } else {
      console.log('  · 本机没配全局 user.email，跳过 ② 的全局分支')
    }

    // ---- ③ 彻底没有 config（隔离全局）→ 才允许历史兜底 ----
    await isolated(async () => {
      const noneNow = gitTry(repo, ['config', '--get', 'user.email'])
      a.eq(noneNow, '', '③ 前提：隔离后确实读不到任何 user.email')

      const r2 = await gitIdentity({ repo, tools: { git } })
      a.eq(r2.from, '历史提交', '③ 完全没 config 时才用历史兜底')
      a.has(r2.flags.join(' '), 'user.email=wrong@example.com', '③ 此时才用历史那个邮箱（仅保命，不是推荐）')

      // ---- ④ 只有 email 没有 name → 不该凭空造一个 name ----
      gitIn(repo, ['config', 'user.email', 'only@example.com'])
      const r3 = await gitIdentity({ repo, tools: { git } })
      const f3 = r3.flags.join(' ')
      a.has(f3, 'user.email=only@example.com', '④ email 取 config')
      a.ok(!f3.includes('user.name='), '④ 没有 name 时不要编一个')
      gitIn(repo, ['config', '--unset', 'user.email'])
    })

    // ---- ⑤ 全新仓库：无 config、无提交 → 兜底身份，且必须真能提交 ----
    await isolated(async () => {
      const empty = mkdtempSync(join(tmpdir(), 'ident-empty-'))
      try {
        gitIn(empty, ['init', '-q'])
        const r4 = await gitIdentity({ repo: empty, tools: { git } })
        a.eq(r4.from, '兜底', '⑤ 空仓库走兜底')
        a.has(r4.flags.join(' '), 'dsh-release@local', '⑤ 兜底邮箱是 dsh-release@local')
        // 兜底身份要真能用，否则 apply 会在 commit 那一步炸
        gitIn(empty, [...r4.flags, 'commit', '-q', '--allow-empty', '-m', 't'])
        a.eq(gitIn(empty, ['log', '-1', '--format=%ae']), 'dsh-release@local', '⑤ 兜底身份能真的提交成功')
      } finally {
        try { rmSync(empty, { recursive: true, force: true, maxRetries: 3 }) } catch {}
      }
    })

    // ---- ⑥ 优先级方向唯一：config 赢历史，反过来绝不允许 ----
    a.ok(r1.from === 'git config', '⑥ 优先级：config 优先，不被历史带偏')

    a.done()
  } finally {
    try { rmSync(repo, { recursive: true, force: true, maxRetries: 3 }) } catch {}
  }
}