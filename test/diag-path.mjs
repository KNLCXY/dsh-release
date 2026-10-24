// 排查：npm 跑脚本时子进程看到的 PATH / PATHEXT 是什么，node 垫片有没有生效。
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureNpm, ensureNodeShim, nodeRuntime, npmInvocation } from '../lib/proc.js'

const npm = await ensureNpm({})
const shim = ensureNodeShim()
const rt = nodeRuntime()
console.log('node      =', rt.path, `(${rt.how})`)
console.log('shim dir  =', shim)

const dir = mkdtempSync(join(tmpdir(), 'rel-path-'))
mkdirSync(join(dir, 'node_modules', '.bin'), { recursive: true })
writeFileSync(join(dir, 'package.json'), JSON.stringify({
  name: 'path-probe', version: '0.0.0',
  scripts: { test: 'node -e "console.log(\'CHILD_PATH=\'+process.env.PATH)" && where node' },
}, null, 2))

const r = await npmInvocation(npm.script, ['test'], { cwd: dir, timeoutMs: 120000 })
console.log('code =', r.code)
console.log('--- stdout ---')
console.log(r.stdout)
console.log('--- stderr ---')
console.log(r.stderr.slice(0, 1200))
rmSync(dir, { recursive: true, force: true })