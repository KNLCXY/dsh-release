// 端到端：模拟「宿主进程」的 PATH（把 dsh-ops 临时目录和已空的 ucrt64 剔掉），
// 验证 findGit 靠扫描临时目录仍能兜住。这就是 desktop 上那个 bug 的复现路径。
import { existsSync } from 'node:fs'
import { findGit, dshOpsTempGitCandidates } from '../lib/proc.js'

const original = process.env.PATH || ''
console.log('原始 PATH 条目:', original.split(';').filter(Boolean).length)

// 只保留「不像 dsh-ops」的目录 —— 即宿主进程能看到的那部分
const hostLike = original
  .split(';')
  .filter(Boolean)
  .filter((d) => !/dsh-ops/i.test(d))
  .filter((d) => !/ucrt64[\\/]bin$/i.test(d))

console.log('模拟宿主 PATH 条目:', hostLike.length)
console.log('  剔掉了:', original.split(';').filter(Boolean).length - hostLike.length, '个（dsh-ops 临时目录 / 空掉的 ucrt64）')

process.env.PATH = hostLike.join(';')

// 确认这个 PATH 里确实没有可用的裸 git —— 否则测试就没意义了
const { execFileSync } = await import('node:child_process')
let bareWorks = false
try { execFileSync('git', ['--version'], { encoding: 'utf8', stdio: 'pipe' }); bareWorks = true } catch { bareWorks = false }
console.log('  模拟 PATH 下裸 git 可用:', bareWorks, bareWorks ? '（测试前提不成立）' : '（正是宿主困境）')

console.log('\n候选（扫描临时目录得到）:')
const cands = dshOpsTempGitCandidates()
if (cands.length === 0) console.log('  （没有 dsh-ops 临时目录）')
for (const c of cands) console.log(' ', existsSync(c) ? '✔' : '✘', c)

console.log('\nfindGit 结果（关键）:')
const r = await findGit({})
if (!r) {
  console.log('  ✘ 仍然找不到 git —— 修复没兜住')
  process.exitCode = 1
} else {
  console.log('  ✔ path =', r.path)
  console.log('    how  =', r.how)
  const { execFileSync: run } = await import('node:child_process')
  console.log('    实测 :', run(r.path, ['--version'], { encoding: 'utf8' }).trim())
  if (/dsh-ops 临时目录/.test(r.how)) console.log('    → 走的正是新加的扫描分支')
  else if (bareWorks) console.log('    → 走的是 PATH（前提不成立，说明力弱）')
  else console.log('    → ⚠ 没走扫描分支但也不是 PATH，检查 how 的判定')
}