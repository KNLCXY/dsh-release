// 计划卡片 / 结果报告的排版 —— 保证关键信息一定会出现在卡片上。
import { planText, reportText } from '../lib/plan.js'
import { makeAsserts } from './_setup.mjs'

const a = makeAsserts('plan')

const info = {
  repo: 'C:\\work\\repo\\dsh-websift',
  name: 'dsh-websift',
  current: '1.0.8',
  target: '1.0.9',
  bumpKind: 'patch',
  prerelease: false,
  tag: 'v1.0.9',
  asset: 'dsh-websift-1.0.9.tgz',
  versions: { 'package.json': '1.0.8', 'dsh-plugin.json': '1.0.6' },
  git: { branch: 'main', clean: false, remote: 'https://github.com/KNLCXY/dsh-websift.git', sync: '与 origin/main 一致' },
  dirty: ['package.json', 'lib/index.js'],
  npm: { channel: 'token', why: '本机 npm 凭证可用', cli: 'npm 12.2.1（缓存）', latest: '1.0.8', count: 9, taken: false, auth: '可用（whoami=knlcxy）' },
  github: { slug: 'KNLCXY/dsh-websift', enabled: true, auth: 'dsh-github 存储 · npm_…GR（40 字符）' },
  tests: { command: 'npm test' },
  collisions: [],
  notes: ['CHANGELOG.md 里没有 1.0.9 的段落；传 changelog_entry 可以在 apply 时插入一段'],
}

const text = planText(info)

a.has(text, '1.0.8 → 1.0.9', '标题带版本跃迁')
a.has(text, 'token（本机 npm 凭证可用）', '通道与理由')
a.has(text, '1.0.6 ≠ 1.0.8', '指出 dsh-plugin.json 版本漂移')
a.has(text, 'v1.0.9', 'tag')
a.has(text, 'dsh-websift-1.0.9.tgz', '产物名')
a.has(text, '未占用', '目标版本可用')
a.has(text, 'KNLCXY/dsh-websift', 'GitHub slug')
a.has(text, 'npm test', '测试命令')
a.has(text, 'release({ action: "apply"', '给出下一步命令')
a.has(text, '2 个未提交改动', '脏工作区计数')
a.has(text, 'package.json, lib/index.js', '待提交文件清单')
a.ok(!text.includes('不可发布'), '没有冲突时不出现「不可发布」')

// 有冲突时必须明确拦住，并且不再给「下一步」
const blocked = planText({
  ...info,
  collisions: ['npm 上 dsh-websift@1.0.9 已存在，不能重复发布', '不是一个 git 仓库'],
})
a.has(blocked, '不可发布', '冲突时给出停止信号')
a.has(blocked, '已存在，不能重复发布', '冲突原因要写清楚')
a.ok(!blocked.includes('下一步：'), '冲突时不给执行命令')

// 彩排（dry-run）卡片：预发布口径 + 没有 GitHub 地址
const pre = planText({
  ...info,
  name: 'dsh-github',
  current: '0.4.0',
  target: '0.5.0',
  prerelease: true,
  tag: 'v0.5.0',
  asset: 'dsh-github-0.5.0.tgz',
  versions: { 'package.json': '0.4.0' },
  npm: { ...info.npm, latest: '0.4.1', taken: false },
  github: { slug: '', enabled: false, auth: '不需要' },
  notes: [],
})
a.has(pre, '预发布', '0.x 标预发布')
a.has(pre, 'package.json 里没有 GitHub 地址', '缺 GitHub 地址要说明')

const report = reportText({
  name: 'dsh-websift',
  current: '1.0.8',
  target: '1.0.9',
  status: 'ok',
  steps: [
    { ok: true, label: '版本同步', detail: 'package.json / dsh-plugin.json → 1.0.9' },
    { ok: true, label: '测试', detail: 'npm test 通过（12.4s）' },
    { ok: 'skip', label: '安装', detail: '没配 profile' },
  ],
  verified: {
    ok: true,
    rows: [
      { ok: true, label: 'npm tarball', detail: 'sha256 5249c882… ＝ 本地，逐字节一致' },
      { ok: true, label: 'GitHub 附件', detail: 'sha256 5249c882… ＝ 本地' },
    ],
  },
  elapsed: 74000,
})
a.has(report, '发布完成', '成功报告标题')
a.has(report, '版本同步', '列出版本同步')
a.has(report, '三处字节一致', '核验结论')
a.has(report, '74.0s', '用时')
a.ok(report.includes('· 安装'), 'skip 步骤用 · 而不是 ✔')

const bad = reportText({
  name: 'dsh-websift', current: '1.0.8', target: '1.0.9', status: 'failed',
  steps: [{ ok: true, label: '版本同步', detail: 'ok' }, { ok: false, label: '测试', detail: 'npm test 失败（1）' }],
  verified: { ok: false, rows: [{ ok: false, label: 'npm', detail: '没上线' }] },
})
a.has(bad, '发布未完成', '失败报告标题')
a.has(bad, '✘', '失败用 ✘')

a.done()