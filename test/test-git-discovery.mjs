// dsh-ops 临时目录里的 git 探测 —— 这是「desktop 上找不到 git」那个 bug 的回归测试。
//
// 背景（2026-11-08）：dsh-ops 0.5.0 把自带工具链从固定的
//   node_modules/@dsh-ops/bash-win32-x64/ucrt64/bin/
// 挪到了
//   %TEMP%/dsh-ops-niu-exec-<随机>/winuxcmd/usr/bin/
// 而且**每次启动新建一个**。bash 会话能用（PATH 被注入），桌面启动的宿主进程拿不到 →
// dsh-release 报「找不到 git」。
//
// 所以 findGit 必须能扫临时目录，而不能只信固定路径。
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dshOpsTempGitCandidates } from '../lib/proc.js'
import { makeAsserts } from './_setup.mjs'

const a = makeAsserts('git-discovery')

/** 造一个假 git.exe（内容无所谓 —— 这个测试只验路径发现，不验可执行性）。 */
function fakeGit(dir) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'git.exe'), 'stub')
}

const base = mkdtempSync(join(tmpdir(), 'git-disc-'))

try {
  // ① 0.5.0 新布局（winuxcmd），两个实例，新的应排在前面
  const oldDir = join(base, 'dsh-ops-niu-exec-OLD001')
  const newDir = join(base, 'dsh-ops-niu-exec-NEW002')
  fakeGit(join(oldDir, 'winuxcmd', 'usr', 'bin'))
  fakeGit(join(newDir, 'winuxcmd', 'usr', 'bin'))
  // 把 oldDir 的 mtime 设成 10 分钟前（在它内部文件写完之后设）
  const past = new Date(Date.now() - 10 * 60 * 1000)
  utimesSync(oldDir, past, past)

  const list = dshOpsTempGitCandidates(base)
  a.ok(list.length >= 2, `至少发现两条候选（实际 ${list.length}）`)
  a.eq(list[0], join(newDir, 'winuxcmd', 'usr', 'bin', 'git.exe'), 'mtime 最新的排第一')
  a.has(list.join('|'), oldDir.replace(/\\/g, '\\'), '旧实例也在候选里')
  a.ok(list.indexOf(join(newDir, 'winuxcmd', 'usr', 'bin', 'git.exe')) <
    list.indexOf(join(oldDir, 'winuxcmd', 'usr', 'bin', 'git.exe')), '新的一定排在旧的之前')

  // ② 0.4.x 旧布局（ucrt64）也要认
  const legacyDir = join(base, 'dsh-ops-legacy003')
  fakeGit(join(legacyDir, 'ucrt64', 'bin'))
  const list2 = dshOpsTempGitCandidates(base)
  a.has(list2.join('|'), join(legacyDir, 'ucrt64', 'bin', 'git.exe'), '旧布局 ucrt64/bin 也在候选里')

  // ③ 不相关的目录必须被忽略（否则会去执行乱七八糟的 exe）
  for (const noise of ['npm-cache', 'dsh-rc-matrix', 'other-tool', 'dshx-something']) {
    mkdirSync(join(base, noise, 'winuxcmd', 'usr', 'bin'), { recursive: true })
    writeFileSync(join(base, noise, 'winuxcmd', 'usr', 'bin', 'git.exe'), 'nope')
  }
  // 「dshx-」前缀不该命中 /^dsh-ops/
  const list3 = dshOpsTempGitCandidates(base)
  const junk = list3.filter((p) => /npm-cache|dsh-rc-matrix|other-tool|dshx-/.test(p))
  a.eq(junk.length, 0, '不相关目录一个都不许进候选')
  a.eq(list3.length, 3 + 3, '只包含 3 个 dsh-ops 实例 × (新布局+旧布局) 的路径槽')

  // ④ 目录不存在时安静返回空数组，不抛
  a.eq(dshOpsTempGitCandidates(join(base, 'does-not-exist')).length, 0, '目录不存在返回空数组')
  a.eq(dshOpsTempGitCandidates('').length, 0, '空路径不抛错')

  // ⑤ 真实环境里至少能找到一个（这台机器上应该有；找不到只提示不算失败，
  //    因为 CI 或别的机器可能确实没有 dsh-ops）
  const real = dshOpsTempGitCandidates()
  if (real.length) {
    const { existsSync } = await import('node:fs')
    const hit = real.find((p) => existsSync(p))
    console.log(`  · 真实环境候选 ${real.length} 条，其中存在文件的 ${real.filter((p) => existsSync(p)).length} 条`)
    if (hit) console.log(`  · 命中：${hit}`)
  } else {
    console.log('  · 真实环境没有 dsh-ops 临时目录（本机没装 dsh-ops？）')
  }

  a.done()
} finally {
  try { rmSync(base, { recursive: true, force: true, maxRetries: 3 }) } catch { /* Windows 偶发 EPERM，忽略 */ }
}