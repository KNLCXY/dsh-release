// 诊断（需要联网）：对任意一个真仓库跑一次 prepare，把计划卡片原样打出来。
// 用法：node test/diag-prepare.mjs <仓库路径> [版本号]
import { resolve } from 'node:path'
import { loadPlugin, fakeCtx } from './_setup.mjs'

const repo = resolve(process.argv[2] || '.')
const version = process.argv[3]
console.log('仓库 =', repo, version ? `· 目标版本 ${version}` : '')

const { mod, toolsPath } = await loadPlugin()
console.log('dsh-tools =', toolsPath || '（没找到，用的是桩）')

const { ctx, tools } = fakeCtx()
mod.apply(ctx, {})
const tool = tools.find((t) => t.name === 'release')

const t0 = Date.now()
const r = await tool.execute({ repo, action: 'prepare', ...(version ? { version } : {}) }, { agent: { id: 'diag' } })
console.log('\n' + r.text)
console.log(`\n（collect 用时 ${((Date.now() - t0) / 1000).toFixed(1)}s）`)