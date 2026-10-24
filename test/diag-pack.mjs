// 看 npm pack --json 到底吐了什么
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureNpm, npmInvocation } from '../lib/proc.js'

const npm = await ensureNpm({})
const dir = mkdtempSync(join(tmpdir(), 'rel-diag2-'))
const r = await npmInvocation(npm.script, ['pack', '--json', '--pack-destination', dir], { cwd: join(import.meta.dirname, '..'), timeoutMs: 300000 })
console.log('code =', r.code)
console.log('--- stdout len', r.stdout.length, '---')
console.log(JSON.stringify(r.stdout.slice(0, 900)))
console.log('--- stderr len', r.stderr.length, '---')
console.log(JSON.stringify(r.stderr.slice(0, 500)))
rmSync(dir, { recursive: true, force: true })