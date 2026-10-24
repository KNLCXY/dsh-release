// npm pack 输出解析 —— 这块曾经真的踩坑：npm 12.2.1 返回对象，老版本返回数组。
import { firstJsonValue, parsePackOutput } from '../lib/proc.js'
import { makeAsserts } from './_setup.mjs'

const a = makeAsserts('pack')

const OLD = `[
  {
    "id": "dsh-websift@1.0.8",
    "name": "dsh-websift",
    "version": "1.0.8",
    "shasum": "a914c7e66c46e328617c13a7906e6e6c07f9494c",
    "filename": "dsh-websift-1.0.8.tgz",
    "files": [{ "path": "lib/index.js", "size": 1, "mode": 420 }]
  }
]
`

// 实测 npm 12.2.1 的形状
const NEW = `{
  "dsh-release": {
    "id": "dsh-release@0.1.0",
    "name": "dsh-release",
    "version": "0.1.0",
    "shasum": "f13c1f175f16e7b2cb2b524de4569ad184772291",
    "filename": "dsh-release-0.1.0.tgz",
    "files": [{ "path": "lib/index.js", "size": 1, "mode": 420 }]
  }
}
`

a.eq(parsePackOutput(OLD)?.filename, 'dsh-websift-1.0.8.tgz', '老版本的数组形状')
a.eq(parsePackOutput(OLD)?.shasum, 'a914c7e66c46e328617c13a7906e6e6c07f9494c', '数组形状的 shasum')
a.eq(parsePackOutput(NEW)?.filename, 'dsh-release-0.1.0.tgz', 'npm 12 的对象形状')
a.eq(parsePackOutput(NEW)?.shasum, 'f13c1f175f16e7b2cb2b524de4569ad184772291', '对象形状的 shasum')
a.eq(parsePackOutput(NEW)?.files?.length, 1, '对象形状也能拿到 files')

// 前后有噪音（npm 的 notice 混在 stdout 里）
a.eq(parsePackOutput(`npm notice something\n${NEW}\nnpm notice done\n`)?.version, '0.1.0', '前后有噪音也能抠出来')
a.eq(parsePackOutput(`npm warn before\n${OLD}`)?.version, '1.0.8', '数组形状带噪音')

// 字符串里含括号，不能把括号配对扫歪
a.eq(parsePackOutput('{"x":{"filename":"a[b]c.tgz","note":"}{"}}')?.filename, 'a[b]c.tgz', '字符串里的括号不干扰配对')
a.eq(parsePackOutput('{"x":{"filename":"say \\"hi\\"","version":"1.0.0"}}')?.version, '1.0.0', '转义引号不干扰')

a.eq(parsePackOutput(''), null, '空串返回 null')
a.eq(parsePackOutput('npm error something went wrong'), null, '纯文本返回 null')
a.eq(parsePackOutput('{ broken json '), null, '残缺 JSON 返回 null')
a.eq(parsePackOutput('{}'), null, '空对象返回 null')

a.eq(firstJsonValue('xx[1,2]yy')?.[1], 2, 'firstJsonValue 直接可用')

a.done()