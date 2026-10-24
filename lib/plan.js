/**
 * dsh-release — 纯逻辑层。
 *
 * 这里只有可单测的纯函数：版本号解析/递增、预发布策略、tag 与产物命名、
 * 仓库 URL 解析、发布通道选择，以及计划卡片 / 结果报告的渲染。
 * 不碰文件系统、不起子进程 —— 那些在 lib/proc.js 和 lib/index.js。
 *
 * @module dsh-release/plan
 */

export const BUMP_KINDS = ['patch', 'minor', 'major']

/** 解析 semver。非法返回 null。允许前缀 v、预发布段和 build 段。 */
export function parseVersion(input) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/.exec(String(input ?? '').trim())
  if (!m) return null
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] || '', build: m[5] || '' }
}

export function formatVersion(p) {
  if (!p) return ''
  return `${p.major}.${p.minor}.${p.patch}${p.pre ? '-' + p.pre : ''}${p.build ? '+' + p.build : ''}`
}

/** 按 patch / minor / major 递增。预发布后缀一律丢掉（发正式版）。 */
export function bumpVersion(current, kind) {
  const p = parseVersion(current)
  if (!p) throw new Error(`无法解析版本号：${current}`)
  if (!BUMP_KINDS.includes(kind)) throw new Error(`bump 只能是 ${BUMP_KINDS.join(' / ')}`)
  if (kind === 'major') return `${p.major + 1}.0.0`
  if (kind === 'minor') return `${p.major}.${p.minor + 1}.0`
  return `${p.major}.${p.minor}.${p.patch + 1}`
}

/** semver 比较：a>b 返回 1，a<b 返回 -1，相等 0。非法输入抛错。 */
export function compareVersions(a, b) {
  const pa = parseVersion(a)
  const pb = parseVersion(b)
  if (!pa || !pb) throw new Error(`无法比较版本号：${a} / ${b}`)
  for (const k of ['major', 'minor', 'patch']) {
    if (pa[k] !== pb[k]) return pa[k] > pb[k] ? 1 : -1
  }
  if (pa.pre === pb.pre) return 0
  if (!pa.pre) return 1 // 有预发布后缀的 < 同号正式版
  if (!pb.pre) return -1
  return pa.pre > pb.pre ? 1 : -1
}

/**
 * 预发布判定。setting 为 auto（默认）时按「0.x 一律预发布、1.x 起正式版」的既定口径。
 * 显式 true / false（或字符串）优先。
 */
export function isPrerelease(version, setting = 'auto') {
  const s = setting === undefined || setting === null ? 'auto' : setting
  if (s === true || s === 'true') return true
  if (s === false || s === 'false') return false
  const p = parseVersion(version)
  if (!p) throw new Error(`无法解析版本号：${version}`)
  return p.major === 0
}

/** git tag 名：v1.2.3 */
export function tagFor(version) {
  return 'v' + String(version ?? '').trim().replace(/^v/, '')
}

/** npm pack 产物文件名：@scope/name → scope-name-1.2.3.tgz */
export function assetName(pkgName, version) {
  const base = String(pkgName ?? '').replace(/^@/, '').replace(/\//g, '-')
  return `${base}-${version}.tgz`
}

/** 从 package.json 的 repository / homepage 里抠出 owner/repo。 */
export function parseRepoUrl(input) {
  const s = String(input ?? '')
  const m = /github\.com[/:]([^/\s]+)\/([^/\s#?]+?)(?:\.git)?(?:[/#?]|$)/i.exec(s)
  if (!m) return null
  return { owner: m[1], repo: m[2] }
}

/**
 * 选择 npm 发布通道。
 *   ci    仓库里有 trusted publishing workflow → 打 tag 交给 CI（本地不再 publish，避免撞车）
 *   token 本机 npm 凭证可用 → 直接 npm publish
 *   stage 没有可用凭证 → npm stage publish，之后由人 2FA 批准
 */
export function chooseChannel({ requested = 'auto', ci = false, tokenOk = false } = {}) {
  const want = String(requested ?? 'auto').toLowerCase()
  if (want !== 'auto') {
    if (!['token', 'stage', 'ci'].includes(want)) throw new Error(`channel 只能是 auto / token / stage / ci，收到 ${requested}`)
    return { channel: want, why: '显式指定' }
  }
  if (ci) return { channel: 'ci', why: '仓库里已有 OIDC workflow，交给 CI 发布' }
  if (tokenOk) return { channel: 'token', why: '本机 npm 凭证可用' }
  return { channel: 'stage', why: '没有可用凭证，退回 staged publishing（需人工 2FA 批准）' }
}

/** 已发布版本集合里挑出「最新正式版」和「最新预发布版」，用于对比展示。 */
export function summarizePublished(versions, tags = {}) {
  const list = Object.keys(versions || {})
  if (list.length === 0) return { latest: tags.latest || '', count: 0 }
  return { latest: tags.latest || '', count: list.length }
}

const CHECK = '✔'
const CROSS = '✘'
const WARN = '⚠'

function hr(title) {
  return `\n${title}`
}

function pad(label, width = 14) {
  const s = String(label)
  let n = 0
  for (const ch of s) n += ch.charCodeAt(0) > 0x2e80 ? 2 : 1
  return s + ' '.repeat(Math.max(1, width - n))
}

function line(label, value) {
  return `  ${pad(label)}${value}`
}

/**
 * 渲染 prepare 卡片。info 由 index.js 采集；这里只管排版。
 * 排版目标：一屏内看清「要发什么、有什么风险、下一步敲什么」。
 */
export function planText(info) {
  const {
    repo = '', name = '', current = '', target = '', bumpKind = '',
    prerelease = false, tag = '', asset = '',
    versions = {}, git = {}, npm = {}, github = {}, tests = {},
    dirty = [], collisions = [], notes = [],
  } = info

  const out = []
  out.push(`发布计划 · ${name || '未知包'} ${current} → ${target}`)

  out.push(hr('目标'))
  out.push(line('版本', `${target}${bumpKind ? `（bump ${bumpKind}）` : '（显式指定）'}`))
  out.push(line('预发布', prerelease ? '是（0.x 口径，GitHub Release 标 prerelease）' : '否（正式版）'))
  out.push(line('tag', tag))
  out.push(line('产物', asset))

  out.push(hr('版本一致性'))
  for (const [file, v] of Object.entries(versions)) {
    const same = v === current
    const mark = v === undefined || v === null || v === '' ? `${WARN} 读不到` : same ? CHECK : `${WARN} ${v} ≠ ${current} → 将同步为 ${target}`
    out.push(line(file, mark))
  }

  out.push(hr('仓库'))
  out.push(line('路径', repo))
  out.push(line('分支', [git.branch, git.clean ? '工作区干净' : `${dirty.length} 个未提交改动`].filter(Boolean).join(' · ')))
  if (git.remote) out.push(line('远端', git.remote))
  out.push(line('同步', git.sync || '未知'))
  if (dirty.length) {
    out.push(line('待提交', dirty.slice(0, 8).join(', ') + (dirty.length > 8 ? ` … 等 ${dirty.length} 个文件` : '')))
  }

  out.push(hr('npm'))
  out.push(line('包名', name))
  out.push(line('通道', `${npm.channel || '?'}（${npm.why || ''}）`))
  out.push(line('CLI', npm.cli || '未知'))
  out.push(line('已发布', npm.latest ? `latest=${npm.latest}（共 ${npm.count || 0} 个版本）` : '（registry 上还没有这个包）'))
  out.push(line('本版本', npm.taken ? `${WARN} ${target} 已被占用，不能重复发布` : `${CHECK} ${target} 未占用`))
  out.push(line('凭证', npm.auth || '未知'))

  out.push(hr('GitHub'))
  out.push(line('仓库', github.slug || `（package.json 里没有 GitHub 地址）`))
  out.push(line('凭证', github.auth || '未知'))
  out.push(line('Release', github.enabled === false ? '跳过' : `${tag} · ${prerelease ? '预发布' : '正式版（Latest）'} · 附件 ${asset}`))

  out.push(hr('测试'))
  out.push(line('命令', tests.command || '（package.json 没有 test 脚本）'))

  if (collisions.length) {
    out.push(hr('停止条件'))
    for (const c of collisions) out.push(`  ${WARN} ${c}`)
  }
  if (notes.length) {
    out.push(hr('提醒'))
    for (const n of notes) out.push(`  · ${n}`)
  }

  const ready = collisions.length === 0
  out.push('')
  out.push(ready
    ? `下一步：release({ action: "apply", repo: ${JSON.stringify(repo)}, version: ${JSON.stringify(target)} })`
    : `不可发布：先解决上面的 ${collisions.length} 个问题。`)

  return out.join('\n')
}

/** 渲染 apply 结果。steps 是 { ok, label, detail } 数组。 */
export function reportText(res) {
  const { name = '', current = '', target = '', status = 'ok', steps = [], verified = null, elapsed = 0 } = res
  const head = status === 'ok' ? `发布完成 · ${name} ${target}` : `发布未完成 · ${name} ${current} → ${target}`
  const out = [head, '']
  for (const s of steps) {
    out.push(`  ${s.ok === false ? CROSS : s.ok === 'skip' ? '·' : CHECK} ${pad(s.label, 10)}${s.detail || ''}`)
  }
  if (verified) {
    out.push('')
    out.push(`  核验：${verified.ok ? '三处字节一致 ' + CHECK : '存在不一致 ' + CROSS}`)
    for (const v of verified.rows || []) out.push(`    ${v.ok ? CHECK : CROSS} ${v.label}  ${v.detail}`)
  }
  if (elapsed) out.push(`\n  用时 ${(elapsed / 1000).toFixed(1)}s`)
  return out.join('\n')
}

export const __test = { hr, pad, CHECK, CROSS, WARN }