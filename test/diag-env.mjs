// 诊断（需要联网，不进 npm test）：
//   1. 找不找得到 git
//   2. npm 自举能不能跑通 —— 本机没有 node/npm，插件要自己下一份 npm CLI 并解 tar
//   3. 用真 npm 对一个真包跑一次 pack，确认 sha256/shasum 采集正确
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { STORE, bytes, ensureNpm, fileSize, findGit, nodeRuntime, npmInvocation, oneLine, parsePackOutput, sha256File } from '../lib/proc.js'

const t0 = Date.now()
console.log('store =', STORE)

console.log('node  =', (() => { const r = nodeRuntime(); return `${r.path}（${r.how}）` })())
const git = await findGit({})
console.log('git   =', git ? `${git.path}（${git.how}）` : '找不到')

console.log('\n--- npm 自举 ---')
const npm = await ensureNpm({}, (m) => console.log('  ', m))
console.log('npm   =', npm.script)
console.log('版本  =', npm.version, '·', npm.via, `· ${Date.now() - t0}ms`)

const who = await npmInvocation(npm.script, ['whoami'], { timeoutMs: 45000 })
console.log('whoami =', who.code === 0 ? oneLine(who.stdout, 40) : `失败(${who.code}) ${oneLine(who.stderr, 120)}`)

console.log('\n--- 真 npm pack ---')
const dir = mkdtempSync(join(tmpdir(), 'rel-diag-'))
const r = await npmInvocation(npm.script, ['pack', '--json', '--pack-destination', dir], { cwd: join(import.meta.dirname, '..'), timeoutMs: 300000 })
if (r.code !== 0) {
  console.log('pack 失败：', oneLine(r.stderr || r.stdout, 400))
} else {
  const m = parsePackOutput(r.stdout)
  const meta = m
  const file = join(dir, meta.filename)
  console.log('产物   =', meta.filename, '·', bytes(fileSize(file)), '·', meta.files.length, '个文件')
  console.log('shasum =', meta.shasum)
  console.log('sha256 =', sha256File(file))
  console.log('文件存在 =', existsSync(file))
}
rmSync(dir, { recursive: true, force: true })
console.log(`\n总用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`)