// 端到端：在一个真的临时 git 仓库上跑 prepare / setup-ci，并验证「撞版本会被拦住」。
// npm 用 test/stub-npm-cli.js 顶替，所以除了一次只读的 registry 查询，全程离线、秒级。
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadPlugin, fakeCtx, makeAsserts } from './_setup.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const STUB_NPM = join(HERE, 'stub-npm-cli.js')
const a = makeAsserts('fixture')

const PKG = 'dsh-release-fixture-9f3c-does-not-exist'

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

/** Windows 上 git 会在 .git 里留下短暂的句柄，删目录常报 EPERM —— 重试几次，删不掉就算了。 */
function cleanup(dir) {
  for (let i = 0; i < 5; i++) {
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); return true } catch { /* 再试 */ }
  }
  return false
}

const tmp = mkdtempSync(join(tmpdir(), 'rel-fixture-'))
try {
  // ── 造一个像模像样的包仓库 ──
  writeFileSync(join(tmp, 'package.json'), JSON.stringify({
    name: PKG,
    version: '0.1.0',
    repository: { type: 'git', url: 'git+https://github.com/KNLCXY/dsh-release-fixture.git' },
    scripts: { test: 'node -e "process.exit(0)"' },
  }, null, 2) + '\n')
  writeFileSync(join(tmp, 'dsh-plugin.json'), JSON.stringify({
    manifestVersion: '0.15', id: PKG, name: PKG, version: '0.0.9',
  }, null, 2) + '\n')
  writeFileSync(join(tmp, 'CHANGELOG.md'), '# 变更记录\n\n## 0.1.0 — 2026-10-01\n\n- 起手\n')
  writeFileSync(join(tmp, 'lib.js'), 'export const x = 1\n')

  git(tmp, ['init', '-q', '-b', 'main'])
  git(tmp, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '-A'])
  git(tmp, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init'])
  git(tmp, ['remote', 'add', 'origin', 'https://github.com/KNLCXY/dsh-release-fixture.git'])

  const { mod, toolsPath, tmpDir } = await loadPlugin()
  // 纯 node 读不到 asar，会退化成桩 —— 只提示，不算失败；用 Electron 跑才会用真的 defineTool。
  if (!toolsPath) console.log('  ⚠ 没找到 DSH 自带的 dsh-tools（纯 node 读不到 asar），本次用桩')

  const { ctx, tools } = fakeCtx()
  mod.apply(ctx, { npmCli: STUB_NPM })
  const tool = tools.find((t) => t.name === 'release')
  a.ok(Boolean(tool), '注册了 release 工具')

  // webServer 是可选服务：某些 cordis 版本对没 inject 的服务会**抛错**而不是返回 undefined。
  // 那种情况下插件也必须照常加载（只注册工具）。
  const strictTools = []
  mod.apply({
    get: () => { throw new Error('service not found: webServer') },
    tools: { register: (t) => strictTools.push(t) },
    effect: (fn) => { fn(); return () => {} },
  }, { npmCli: STUB_NPM })
  a.ok(strictTools.some((t) => t.name === 'release'), 'ctx.get 抛错时插件仍能加载')

  const exec = { agent: { id: 'fixture-agent' }, signal: undefined }

  // ── prepare ──
  const prep = await tool.execute({ repo: tmp, action: 'prepare' }, exec)
  const text = prep.text
  a.has(text, `${PKG} 0.1.0 → 0.1.1`, '默认 bump patch')
  a.has(text, '预发布', '0.x 标为预发布')
  a.has(text, 'v0.1.1', 'tag 名')
  a.has(text, `${PKG}-0.1.1.tgz`, '产物名')
  a.has(text, '0.0.9 ≠ 0.1.0', '抓出 dsh-plugin.json 版本漂移')
  a.has(text, 'stub-user', 'whoami 走了假 npm')
  a.has(text, '0.1.1 未占用', '目标版本未占用')
  a.has(text, 'registry 上还没有这个包', '不存在的包如实说明')
  a.has(text, 'main', '分支名')
  a.ok(!text.includes('不可发布'), '干净仓库不报冲突')

  // ── 显式版本 ──
  const exp = await tool.execute({ repo: tmp, action: 'prepare', version: '2.0.0' }, exec)
  a.has(exp.text, '0.1.0 → 2.0.0', '显式 version 生效')
  a.ok(!exp.text.includes('bump'), '显式指定时不写 bump')

  // ── 撞版本必须被拦住（这条路径没有任何副作用） ──
  const same = await tool.execute({ repo: tmp, action: 'apply', version: '0.1.0' }, exec)
  a.has(same.text, '不能发布', '同版本被拦')
  a.has(same.text, '不大于当前', '说明拦截原因')

  // ── 不是 git 仓库也要拦住 ──
  const plain = mkdtempSync(join(tmpdir(), 'rel-plain-'))
  writeFileSync(join(plain, 'package.json'), JSON.stringify({ name: PKG + '-plain', version: '0.1.0' }) + '\n')
  const nogit = await tool.execute({ repo: plain, action: 'plan' }, exec)
  a.has(nogit.text, '不认识的动作', '未知 action 给出可用列表')
  const nogit2 = await tool.execute({ repo: plain, action: 'prepare' }, exec)
  a.has(nogit2.text, '不是一个 git 仓库', '非 git 仓库被标出')
  rmSync(plain, { recursive: true, force: true })

  // ── 有 git 但没配 origin 也要拦住（apply 会死在 push 那一步） ──
  const noremote = mkdtempSync(join(tmpdir(), 'rel-noremote-'))
  writeFileSync(join(noremote, 'package.json'), JSON.stringify({
    name: PKG + '-noremote', version: '0.1.0',
    scripts: { test: 'node -e "process.exit(0)"' },
  }) + '\n')
  git(noremote, ['init', '-q', '-b', 'main'])
  git(noremote, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '-A'])
  git(noremote, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init'])
  const nr = await tool.execute({ repo: noremote, action: 'apply', version: '0.1.1' }, exec)
  a.has(nr.text, '没有配 origin 远端', '没配 origin 的仓库被拦住')
  a.has(nr.text, '不能发布', '且不会继续往下走')
  cleanup(noremote)

  // ── 版本同步真的会改文件 ──
  const cfg = { npmCli: STUB_NPM }
  const info = await mod.__test.collect(cfg, { repo: tmp }, ctx, exec, () => {})
  const detail = mod.__test.applyVersionSync(info, {})
  a.has(detail, 'package.json', '同步说明里含 package.json')
  a.has(detail, 'dsh-plugin.json', '同步说明里含 dsh-plugin.json')
  a.eq(JSON.parse(readFileSync(join(tmp, 'package.json'), 'utf8')).version, '0.1.1', 'package.json 已改')
  a.eq(JSON.parse(readFileSync(join(tmp, 'dsh-plugin.json'), 'utf8')).version, '0.1.1', 'dsh-plugin.json 已改')

  // 幂等：同样目标版本再跑一次应当说「已经是」
  const info2 = await mod.__test.collect(cfg, { repo: tmp, version: '0.1.1' }, ctx, exec, () => {})
  a.has(mod.__test.applyVersionSync(info2, {}), '已经是 0.1.1', '重复同步幂等')

  // ── CHANGELOG 段落插入 ──
  const info3 = await mod.__test.collect(cfg, { repo: tmp, version: '0.1.2' }, ctx, exec, () => {})
  mod.__test.applyVersionSync(info3, { changelog_entry: '- 修了某个 bug\n- 加了某个功能' })
  const cl = readFileSync(join(tmp, 'CHANGELOG.md'), 'utf8')
  a.has(cl, '## 0.1.2 — ', 'CHANGELOG 插入了新段落')
  a.has(cl, '- 修了某个 bug', '段落内容进来了')
  a.ok(cl.indexOf('## 0.1.2') < cl.indexOf('## 0.1.0'), '新段落在最上面')
  a.ok(cl.startsWith('# 变更记录'), 'H1 标题还在最前面')

  // ── setup-ci ──
  const ci = await tool.execute({ repo: tmp, action: 'setup-ci' }, exec)
  a.has(ci.text, 'OIDC', '提示里提到 OIDC')
  a.has(ci.text, 'npm trust github', '给出 npm 侧命令')
  const wf = readFileSync(join(tmp, '.github', 'workflows', 'release.yml'), 'utf8')
  a.has(wf, 'id-token: write', 'workflow 声明了 id-token: write')
  a.has(wf, 'npm install -g npm@latest', 'workflow 会升级 npm（runner 自带的低于 11.5.1）')
  a.has(wf, "tags:", 'workflow 由 tag 触发')
  a.has(wf, PKG, '打的是这个包名')

  // 第二次不覆盖
  const ci2 = await tool.execute({ repo: tmp, action: 'setup-ci' }, exec)
  a.has(ci2.text, '已经存在', '不静默覆盖已有 workflow')

  rmSync(tmpDir, { recursive: true, force: true })
  a.done()
} finally {
  cleanup(tmp)
}