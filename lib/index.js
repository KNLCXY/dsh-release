/**
 * dsh-release — 一次调用把「发布」做完。
 *
 * 它解决的是这台机器的真实处境：PATH 里没有 node、没有 npm，
 * 发布要经过 版本同步 → 测试 → 打包 → 提交打 tag → GitHub Release → npm 发布 → 三处核验，
 * 每一步都能单独出错，而且**发布不可逆**——所以默认只出计划，`action:"apply"` 才动手。
 *
 * 四个动作：
 *   prepare   采集现状，出一张计划卡片，不改任何东西（默认）
 *   apply     真正发布；每步都留下可核对的证据
 *   setup-ci  写 .github/workflows/release.yml（OIDC trusted publishing），并给出 npm 侧要敲的命令
 *   verify    只做三处哈希核验（对已经发出去的版本）
 *
 * 核心承诺：**只在 registry 上真的查到、且哈希对得上时，才说「发出去了」。**
 * npm 发布返回 202 是异步的 —— 报告里不会拿 202 当成功。
 *
 * @module dsh-release
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import {
  assetName, bumpVersion, chooseChannel, compareVersions, isPrerelease,
  parseRepoUrl, parseVersion, planText, reportText, tagFor,
} from './plan.js'
import {
  HOME, STORE, bytes, ensureNpm, fileSize, findGit, npmInvocation, oneLine, parsePackOutput, run, sha256File,
} from './proc.js'

export const name = 'dsh-release'
export const inject = ['tools']

const SETTINGS_FILE = join(STORE, 'settings.json')

const DEFAULTS = {
  // 显式指定工具链位置；留空 = 自动探测
  gitPath: '',
  npmCli: '',
  npmVersion: '',
  // GitHub API 凭证；留空 = 依次找 环境变量 → dsh-github 存储 → git credential
  githubToken: '',
  // 发布后把产物装进哪个 DSH profile（留空 = 不装）
  profile: '',
  access: 'public',
  // npm 是异步上线的，最多等多久确认（毫秒）
  verifyTimeoutMs: 240000,
}

function readSettingsFile() {
  try { return JSON.parse(readFileSync(SETTINGS_FILE, 'utf8')) || {} } catch { return {} }
}

function writeSettingsFile(patch) {
  mkdirSync(dirname(SETTINGS_FILE), { recursive: true })
  const next = { ...readSettingsFile(), ...(patch || {}) }
  writeFileSync(SETTINGS_FILE, JSON.stringify(next, null, 2), 'utf8')
  return next
}

export function resolveSettings(config) {
  return { ...DEFAULTS, ...(config || {}), ...readSettingsFile() }
}

// ─────────────────────────── 工具链 ───────────────────────────

async function toolchain(settings, log) {
  const [git, npm] = await Promise.all([findGit(settings), ensureNpm(settings, log)])
  return { git, npm }
}

async function gitRun(git, args, opts = {}) {
  if (!git) throw new Error('找不到 git。可以在设置里填 gitPath，或把 git 加进 PATH。')
  return run(git.path, args, { timeoutMs: 60000, ...opts })
}

async function gitOk(git, args, opts = {}) {
  const r = await gitRun(git, args, opts)
  if (r.code !== 0) {
    const tail = (r.stderr || r.stdout || '').trim().split(/\r?\n/).slice(-4).join('\n')
    throw new Error(`git ${args[0]} 失败（${r.code}）${tail ? '\n' + tail : ''}`)
  }
  return r
}

// ─────────────────────────── npm registry / GitHub API ───────────────────────────

const REGISTRY = 'https://registry.npmjs.org'

async function fetchJson(url, options = {}) {
  const res = await fetch(url, { redirect: 'follow', ...options })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* 非 JSON */ }
  return { ok: res.ok, status: res.status, json, text }
}

/** 查 registry 上这个包的全部版本与 dist-tags。包不存在返回空。 */
async function registryInfo(pkgName) {
  const r = await fetchJson(`${REGISTRY}/${encodeURIComponent(pkgName).replace('%40', '@')}`)
  if (r.status === 404) return { exists: false, versions: {}, tags: {} }
  if (!r.ok || !r.json) return { exists: false, versions: {}, tags: {}, error: `HTTP ${r.status}` }
  return { exists: true, versions: r.json.versions || {}, tags: r.json['dist-tags'] || {} }
}

/** 取某个具体版本的 dist（tarball / shasum / integrity）。没上线返回 null。 */
async function registryVersion(pkgName, version) {
  const r = await fetchJson(`${REGISTRY}/${encodeURIComponent(pkgName).replace('%40', '@')}/${version}`)
  if (r.status === 404) return null
  if (!r.ok || !r.json) return null
  return r.json.dist || null
}

/**
 * 找 GitHub 凭证。顺序：插件配置 → 环境变量 → dsh-github 的存储 → git credential。
 * 全程不打印令牌本身，报告里只出现来源和前后各 4 位。
 */
async function findGithubToken(settings, git) {
  const from = (raw, how) => (raw && String(raw).trim() ? { token: String(raw).trim(), how } : null)

  let hit = from(settings.githubToken, '插件配置')
  if (hit) return hit

  hit = from(process.env.GITHUB_TOKEN, '环境变量 GITHUB_TOKEN') || from(process.env.GH_TOKEN, '环境变量 GH_TOKEN')
  if (hit) return hit

  try {
    const p = join(HOME, '.dsh', 'storages', 'dsh-github', 'settings.json')
    if (existsSync(p)) {
      const j = JSON.parse(readFileSync(p, 'utf8'))
      hit = from(j && j.token, 'dsh-github 存储')
      if (hit) return hit
    }
  } catch { /* 读不到就继续 */ }

  if (git) {
    const r = await gitRun(git, ['credential', 'fill'], {
      input: 'protocol=https\nhost=github.com\n\n',
      timeoutMs: 20000,
    })
    if (r.code === 0) {
      const m = /^password=(.+)$/m.exec(r.stdout || '')
      hit = from(m && m[1], 'git credential（github.com）')
      if (hit) return hit
    }
  }
  return null
}

function mask(token) {
  const s = String(token || '')
  if (s.length <= 12) return `<${s.length} 字符>`
  // 只露出「类型前缀 + 末 4 位」（GitHub 自己也是这么显示的），中间一律不出现
  const m = /^(github_pat_|ghp_|gho_|ghu_|ghs_|ghr_|npm_)/.exec(s)
  return `${m ? m[1] : ''}…${s.slice(-4)}（${s.length} 字符）`
}

async function ghApi(token, method, path, body, raw) {
  const url = path.startsWith('http') ? path : `https://api.github.com${path}`
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'dsh-release',
  }
  if (raw) headers['Content-Type'] = 'application/octet-stream'
  const res = await fetch(url, { method, headers, body })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* 上传附件返回的也是 JSON，解不出就算了 */ }
  return { ok: res.ok, status: res.status, json, text }
}

// ─────────────────────────── 采集 ───────────────────────────

function readJsonSafe(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return null }
}

async function sessionCwd(ctx, exec) {
  try {
    const wd = ctx.get('workingDirectory')
    if (wd && exec && exec.agent && typeof wd.ensure === 'function') {
      return await wd.ensure(exec.agent, exec.signal)
    }
  } catch { /* 拿不到就用宿主进程的 cwd */ }
  return process.cwd()
}

/** 仓库里有没有 OIDC trusted publishing 的 workflow。 */
function detectCiWorkflow(repo) {
  const dir = join(repo, '.github', 'workflows')
  if (!existsSync(dir)) return null
  for (const f of readdirSync(dir)) {
    if (!/\.ya?ml$/i.test(f)) continue
    const text = readFileSync(join(dir, f), 'utf8')
    if (/id-token\s*:\s*write/.test(text)) return { file: f, path: join(dir, f), text }
  }
  return null
}

async function collect(settings, args, ctx, exec, log) {
  const repo = resolve(args.repo && String(args.repo).trim() ? String(args.repo) : await sessionCwd(ctx, exec))
  const pkgPath = join(repo, 'package.json')
  if (!existsSync(pkgPath)) throw new Error(`不是仓库根目录（没有 package.json）：${repo}`)
  const pkg = readJsonSafe(pkgPath)
  if (!pkg?.name) throw new Error(`package.json 里没有 name：${pkgPath}`)

  const { git, npm } = await toolchain(settings, log)

  // ── 版本一致性 ──
  const versions = { 'package.json': pkg.version }
  const dshPluginPath = join(repo, 'dsh-plugin.json')
  const dshPlugin = existsSync(dshPluginPath) ? readJsonSafe(dshPluginPath) : null
  if (dshPlugin) versions['dsh-plugin.json'] = dshPlugin.version
  const changelogPath = join(repo, 'CHANGELOG.md')
  const changelog = existsSync(changelogPath) ? readFileSync(changelogPath, 'utf8') : null

  // ── git 现状 ──
  const outside = await gitRun(git, ['rev-parse', '--is-inside-work-tree'], { cwd: repo })
  const isRepo = outside.code === 0 && /true/.test(outside.stdout)
  let gitInfo = {}
  let dirty = []
  if (isRepo) {
    const [br, st, rm] = await Promise.all([
      gitRun(git, ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repo }),
      gitRun(git, ['status', '--porcelain'], { cwd: repo }),
      gitRun(git, ['remote', 'get-url', 'origin'], { cwd: repo }),
    ])
    const branch = oneLine(br.stdout, 60) || 'HEAD'
    dirty = (st.stdout || '').split(/\r?\n/).filter(Boolean).map((l) => l.slice(3).trim())
    let sync = ''
    const lr = await gitRun(git, ['rev-list', '--left-right', '--count', `origin/${branch}...HEAD`], { cwd: repo })
    if (lr.code === 0) {
      const [behind, ahead] = (lr.stdout || '').trim().split(/\s+/).map(Number)
      sync = !behind && !ahead ? `与 origin/${branch} 一致` : `落后 ${behind || 0} · 领先 ${ahead || 0}（以本地 origin 引用为准，未联网核对）`
    } else {
      sync = `本地没有 origin/${branch} 引用`
    }
    gitInfo = { branch, clean: dirty.length === 0, remote: oneLine(rm.stdout, 120), sync }
  }

  // ── 目标版本 ──
  const current = String(pkg.version || '0.0.0')
  let target = args.version ? String(args.version).trim().replace(/^v/, '') : ''
  let bumpKind = ''
  if (!target && args.bump) {
    bumpKind = String(args.bump).toLowerCase()
    target = bumpVersion(current, bumpKind)
  }
  if (!target) target = bumpVersion(current, 'patch'), bumpKind = 'patch'

  // ── 远端状态 ──
  const reg = await registryInfo(pkg.name)
  const latest = reg.tags?.latest || ''
  const collisions = []
  const notes = []

  if (!parseVersion(target)) collisions.push(`目标版本号不合法：${target}`)
  else if (parseVersion(current) && compareVersions(target, current) <= 0) {
    collisions.push(`目标版本 ${target} 不大于当前 ${current}（要发已发布的版本号请显式传 version，但不建议重复发布）`)
  }
  if (reg.versions?.[target]) collisions.push(`npm 上 ${pkg.name}@${target} 已存在，不能重复发布`)
  if (!isRepo) collisions.push('不是一个 git 仓库')
  if (isRepo && !gitInfo.remote) collisions.push('这个仓库没有配 origin 远端，apply 会在 git push 这一步失败')
  if (settings.profile && !args.install) notes.push('设置了默认 profile，但没传 install，发布后不会装进 profile')
  if (dshPlugin && dshPlugin.version !== pkg.version) {
    notes.push(`dsh-plugin.json 的版本（${dshPlugin.version}）和 package.json（${pkg.version}）不一致，apply 时会一起同步`)
  }
  if (changelog && !new RegExp(`^#+\\s*\\[?v?${target.replace(/\./g, '\\.')}\\b`, 'm').test(changelog)) {
    notes.push(`CHANGELOG.md 里没有 ${target} 的段落；传 changelog_entry 可以在 apply 时插入一段`)
  }

  // ── npm 凭证 ──
  let tokenOk = false
  let whoami = ''
  if (npm) {
    const r = await npmInvocation(npm.script, ['whoami'], { cwd: repo, timeoutMs: 45000 })
    tokenOk = r.code === 0
    whoami = tokenOk ? oneLine(r.stdout, 40) : oneLine(r.stderr, 80)
  }
  const ci = detectCiWorkflow(repo)
  const pick = chooseChannel({ requested: args.channel || 'auto', ci: Boolean(ci), tokenOk })

  // ── GitHub ──
  const slugFromPkg = parseRepoUrl(pkg.repository?.url || pkg.repository || pkg.homepage || '')
  const slug = slugFromPkg || parseRepoUrl(gitInfo.remote || '')
  const gh = slug ? await findGithubToken(settings, git) : null
  if (!slug) notes.push('package.json 里没有 GitHub 地址，apply 会跳过 GitHub Release')
  // 远端配了、但 GitHub 上还没有这个仓库 —— 先建仓库，否则 apply 会在推送/建 Release 时崩在半路
  let ghExists = null
  if (slug && gh) {
    const probe = await ghApi(gh.token, 'GET', `/repos/${slug.owner}/${slug.repo}`)
    ghExists = probe.ok
    if (probe.status === 404) notes.push(`GitHub 上还没有 ${slug.owner}/${slug.repo}；要先建仓库，否则 apply 会在推送或建 Release 时失败`)
  }

  const tests = { command: pkg.scripts?.test ? 'npm test' : '' }

  return {
    repo, pkg, pkgPath, dshPluginPath, dshPlugin, changelogPath, changelog,
    name: pkg.name,
    versions, git: gitInfo, dirty, current, target, bumpKind,
    prerelease: isPrerelease(target, args.prerelease ?? 'auto'),
    tag: tagFor(target), asset: assetName(pkg.name, target),
    npm: {
      channel: pick.channel, why: pick.why, cli: npm ? `npm ${npm.version}（${npm.via}）` : '不可用',
      latest, count: Object.keys(reg.versions || {}).length, taken: Boolean(reg.versions?.[target]),
      auth: npm ? (tokenOk ? `可用（whoami=${whoami}）` : `不可用（${whoami || 'whoami 失败'}）`) : '没有 npm CLI',
      registry: reg, whoami, tokenOk,
    },
    github: {
      slug: slug ? `${slug.owner}/${slug.repo}` : '', owner: slug?.owner, repoName: slug?.repo,
      enabled: Boolean(slug) && args.github !== false,
      auth: gh ? `${gh.how} · ${mask(gh.token)}` : (slug ? '找不到凭证' : '不需要'),
      token: gh?.token || '',
      exists: ghExists,
    },
    ci, tests, collisions, notes,
    tools: { git, npm },
    skipTests: Boolean(args.skip_tests),
    githubWanted: args.github !== false,
  }
}

// ─────────────────────────── apply 各步 ───────────────────────────

function step(list, ok, label, detail) {
  list.push({ ok, label, detail })
}

/** 1. 把目标版本写进 package.json / dsh-plugin.json（+ 可选 CHANGELOG 段落）。 */
function applyVersionSync(info, args) {
  const changed = []
  const pkg = readJsonSafe(info.pkgPath)
  if (pkg && pkg.version !== info.target) {
    pkg.version = info.target
    writeFileSync(info.pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8')
    changed.push('package.json')
  }
  if (info.dshPlugin && existsSync(info.dshPluginPath)) {
    const j = readJsonSafe(info.dshPluginPath)
    if (j && j.version !== info.target) {
      j.version = info.target
      writeFileSync(info.dshPluginPath, JSON.stringify(j, null, 2) + '\n', 'utf8')
      changed.push('dsh-plugin.json')
    }
  }
  let changelogNote = ''
  if (args.changelog_entry && info.changelogPath) {
    const today = new Date().toISOString().slice(0, 10)
    const section = `## ${info.target} — ${today}\n\n${String(args.changelog_entry).trim()}\n`
    const text = readFileSync(info.changelogPath, 'utf8')
    if (text.startsWith('# ')) {
      const nl = text.indexOf('\n')
      writeFileSync(info.changelogPath, text.slice(0, nl + 1) + '\n' + section + text.slice(nl + 1), 'utf8')
    } else {
      writeFileSync(info.changelogPath, section + '\n' + text, 'utf8')
    }
    changed.push('CHANGELOG.md')
  } else if (info.changelog) {
    changelogNote = '（CHANGELOG 未改，按需自己写）'
  }
  return changed.length ? `${changed.join(' / ')} → ${info.target} ${changelogNote}` : `已经是 ${info.target}（跳过）`
}

/** 2. 跑测试。 */
async function runTests(info) {
  if (info.skipTests) return { ok: 'skip', detail: '按要求跳过' }
  if (!info.tests.command) return { ok: 'skip', detail: 'package.json 没有 test 脚本' }
  const r = await npmInvocation(info.tools.npm.script, ['test'], { cwd: info.repo, timeoutMs: 900000 })
  if (r.code !== 0) {
    const tail = oneLine((r.stderr || r.stdout || '').split(/\r?\n/).slice(-8).join(' / '), 300)
    const error = new Error(`npm test 失败（${r.code}）：${tail}`)
    error.stepFailed = true
    throw error
  }
  return { ok: true, detail: `npm test 通过（${(r.ms / 1000).toFixed(1)}s）` }
}

/** 3. npm pack 出产物，算 sha256。 */
async function packArtifact(info, args) {
  const existing = join(info.repo, info.asset)
  if (existsSync(existing)) rmSync(existing)
  const r = await npmInvocation(info.tools.npm.script, ['pack', '--json'], { cwd: info.repo, timeoutMs: 300000 })
  if (r.code !== 0) {
    throw new Error(`npm pack 失败（${r.code}）：${oneLine(r.stderr || r.stdout, 300)}`)
  }
  const m = parsePackOutput(r.stdout)
  let meta = null
  try { meta = m } catch { /* 解析不了就用文件名兜底 */ }
  const file = join(info.repo, meta?.filename || info.asset)
  if (!existsSync(file)) throw new Error(`npm pack 说打包成功，但找不到产物：${file}`)
  info.artifact = file
  info.sha256 = sha256File(file)
  info.size = fileSize(file)
  info.shasum = meta?.shasum || ''
  info.fileCount = Array.isArray(meta?.files) ? meta.files.length : 0
  return {
    ok: true,
    detail: `${basename(file)} · ${bytes(info.size)} · ${info.fileCount} 个文件 · sha256 ${info.sha256.slice(0, 12)}…`,
  }
}

/** 4. 提交 + 打 tag + 推送。 */
async function commitAndPush(info, args) {
  const { git } = info.tools
  await gitOk(git, ['add', '-A'], { cwd: info.repo })

  // 仓库没配 user.email 时 commit 会直接失败，先用历史提交的身份兜底
  const ident = await gitIdentity(info)
  const commitArgs = [...ident.flags, 'commit', '-m', args.message || `release: ${info.tag}`]
  let r = await gitRun(git, commitArgs, { cwd: info.repo })
  if (r.code !== 0 && /nothing to commit|working tree clean/i.test(r.stdout + r.stderr)) {
    // 允许「只发版本、没有代码改动」的情况：版本文件已经改过了，理论上不会走到这
    return { ok: 'skip', detail: '没有需要提交的改动' }
  }
  if (r.code !== 0) throw new Error(`git commit 失败（${r.code}）：${oneLine(r.stderr || r.stdout, 300)}`)
  const sha = oneLine((await gitRun(git, ['rev-parse', '--short', 'HEAD'], { cwd: info.repo })).stdout, 20)

  if (args.tag !== false) {
    await gitRun(git, ['tag', '-d', info.tag], { cwd: info.repo }) // 旧 tag 先清掉，失败无所谓
    await gitOk(git, [...ident.flags, 'tag', '-a', info.tag, '-m', `release ${info.tag}`], { cwd: info.repo })
  }

  const branch = info.git.branch || 'HEAD'
  const push = await gitOk(git, ['push', 'origin', branch], { cwd: info.repo })
  let tagNote = ''
  if (args.tag !== false) {
    const tp = await gitRun(git, ['push', 'origin', info.tag], { cwd: info.repo })
    if (tp.code !== 0) {
      const tf = await gitRun(git, ['push', 'origin', info.tag, '--force'], { cwd: info.repo })
      tagNote = tf.code === 0 ? ' · tag 已强制推送' : ` · tag 推送失败：${oneLine(tp.stderr, 120)}`
    } else {
      tagNote = ' · tag 已推送'
    }
  }
  return { ok: true, detail: `提交 ${sha} · 推送 ${branch}${tagNote}` }
}

async function gitIdentity(info) {
  const { git } = info.tools
  const r = await gitRun(git, ['log', '-1', '--format=%an%n%ae'], { cwd: info.repo })
  const lines = (r.stdout || '').trim().split(/\r?\n/)
  if (r.code === 0 && lines[0] && lines[1]) {
    return { flags: ['-c', `user.name=${lines[0]}`, '-c', `user.email=${lines[1]}`], from: '历史提交' }
  }
  const cfg = await gitRun(git, ['config', 'user.email'], { cwd: info.repo })
  const email = oneLine(cfg.stdout, 80)
  return email ? { flags: [], from: 'git config' } : { flags: ['-c', 'user.name=dsh-release', '-c', 'user.email=dsh-release@local'], from: '兜底' }
}

/** 5. GitHub Release + 上传产物。 */
async function githubRelease(info, args) {
  if (!info.githubWanted) return { ok: 'skip', detail: '按要求跳过' }
  if (!info.github.slug) return { ok: 'skip', detail: 'package.json 里没有 GitHub 地址' }
  if (!info.github.token) return { ok: false, detail: '找不到 GitHub 凭证（插件配置 / GITHUB_TOKEN / dsh-github 存储 / git credential 都试过了）' }
  const { owner, repoName } = info.github
  const token = info.github.token

  const body = args.notes || `Release ${info.tag}`
  const created = await ghApi(token, 'POST', `/repos/${owner}/${repoName}/releases`, JSON.stringify({
    tag_name: info.tag,
    name: args.name || info.tag,
    body,
    prerelease: info.prerelease,
    draft: false,
  }))

  let release = created.json
  if (!created.ok) {
    const msg = oneLine(created.json?.message || created.text, 160)
    if (created.status === 422) {
      // tag 已存在同名 Release：取回来复用
      const got = await ghApi(token, 'GET', `/repos/${owner}/${repoName}/releases/tags/${info.tag}`)
      if (got.ok) release = got.json
      else return { ok: false, detail: `创建 Release 失败（422）：${msg}` }
    } else {
      return { ok: false, detail: `创建 Release 失败（${created.status}）：${msg}` }
    }
  }

  let assetNote = ''
  if (info.artifact && release?.id) {
    const up = await ghApi(
      token, 'POST',
      `https://uploads.github.com/repos/${owner}/${repoName}/releases/${release.id}/assets?name=${encodeURIComponent(basename(info.artifact))}`,
      readFileSync(info.artifact), true,
    )
    if (up.ok) {
      const digest = up.json?.digest || ''
      assetNote = digest ? ` · 附件 digest ${digest.replace('sha256:', 'sha256:').slice(0, 20)}…` : ' · 附件已上传'
    } else {
      assetNote = ` · 附件上传失败（${up.status}）`
    }
  }
  info.releaseId = release?.id
  info.releaseUrl = release?.html_url || ''
  return { ok: true, detail: `Release ${info.tag} · ${info.prerelease ? '预发布' : '正式版'}${assetNote}` }
}

/** 6. npm 发布（token / stage / ci）。 */
async function npmPublish(info, args) {
  const channel = info.npm.channel
  if (channel === 'ci') {
    return { ok: 'skip', detail: '已打 tag，交给 CI 的 OIDC 发布（本地不 publish，避免撞车）' }
  }
  const npmArgs = channel === 'stage'
    ? ['stage', 'publish', '--access', args.access || DEFAULTS.access]
    : ['publish', '--access', args.access || DEFAULTS.access]
  const r = await npmInvocation(info.tools.npm.script, npmArgs, { cwd: info.repo, timeoutMs: 900000 })
  const out = `${r.stdout}\n${r.stderr}`
  if (r.code !== 0) {
    return { ok: false, detail: `${npmArgs.slice(0, 2).join(' ')} 失败（${r.code}）：${oneLine(out.trim().split(/\r?\n/).slice(-4).join(' / '), 300)}` }
  }
  // npm 现在返回 202 Accepted（异步），别把 202 当成功——下面 verify 才作数
  if (channel === 'stage') {
    return { ok: true, detail: `已送进暂存区（${oneLine(out, 120)}）——还需要你去 npm 网页用 2FA 批准，批完包才公开` }
  }
  return { ok: true, detail: `npm publish 已受理（HTTP 202 是异步的，等下面的核验）· ${oneLine(out.replace(/^npm notice.*$/gm, ''), 120)}` }
}

/** 7. 核验：registry 上的 tarball、GitHub 附件，和本地产物两两比哈希。 */
async function verifyAll(info, settings, log) {
  const rows = []
  const deadline = Date.now() + Number(settings.verifyTimeoutMs || DEFAULTS.verifyTimeoutMs)
  let dist = null

  if (info.npm.channel !== 'stage') {
    log('等 npm 上线…')
    while (Date.now() < deadline) {
      dist = await registryVersion(info.pkg.name, info.target)
      if (dist) break
      await new Promise((r) => setTimeout(r, 5000))
    }
  }

  // npm 侧
  if (info.npm.channel === 'stage') {
    rows.push({ ok: 'skip', label: 'npm', detail: '走的是 staged publishing，包还没公开，发布后可用 action:"verify" 复核' })
  } else if (!dist) {
    rows.push({ ok: false, label: 'npm', detail: `等了 ${Math.round((settings.verifyTimeoutMs || DEFAULTS.verifyTimeoutMs) / 1000)}s 也没在 registry 上看到 ${info.target}（可能 CI 还在跑，或发布其实失败了）` })
  } else {
    const shasumOk = !info.shasum || dist.shasum === info.shasum
    rows.push({ ok: shasumOk, label: 'npm shasum', detail: `${dist.shasum || '?'} ${shasumOk ? '一致' : '≠ 本地 ' + info.shasum}` })
    if (dist.tarball) {
      try {
        const res = await fetch(dist.tarball, { redirect: 'follow' })
        const buf = Buffer.from(await res.arrayBuffer())
        const { createHash } = await import('node:crypto')
        const remote = createHash('sha256').update(buf).digest('hex')
        rows.push({ ok: remote === info.sha256, label: 'npm tarball', detail: `sha256 ${remote.slice(0, 16)}… ${remote === info.sha256 ? '＝ 本地，逐字节一致' : '≠ 本地 ' + info.sha256.slice(0, 16) + '…'}` })
      } catch (error) {
        rows.push({ ok: false, label: 'npm tarball', detail: `下载失败：${oneLine(error?.message, 120)}` })
      }
    }
  }

  // GitHub 侧
  if (info.githubWanted && info.github.slug && info.github.token) {
    const got = await ghApi(info.github.token, 'GET', `/repos/${info.github.owner}/${info.github.repoName}/releases/tags/${info.tag}`)
    const asset = got.json?.assets?.find((a) => a.name === basename(info.artifact || info.asset))
    if (!got.ok) {
      rows.push({ ok: false, label: 'GitHub', detail: `读不到 Release ${info.tag}（HTTP ${got.status}）` })
    } else if (!asset) {
      rows.push({ ok: false, label: 'GitHub', detail: `Release ${info.tag} 上没有找到附件 ${basename(info.artifact || info.asset)}` })
    } else {
      const digest = String(asset.digest || '')
      if (digest.startsWith('sha256:')) {
        const remote = digest.slice(7)
        rows.push({ ok: remote === info.sha256, label: 'GitHub 附件', detail: `sha256 ${remote.slice(0, 16)}… ${remote === info.sha256 ? '＝ 本地' : '≠ 本地'}` })
      } else {
        rows.push({ ok: asset.size === info.size, label: 'GitHub 附件', detail: `没有 digest，只能比大小：${bytes(asset.size)} ${asset.size === info.size ? '一致' : '≠ 本地 ' + bytes(info.size)}` })
      }
    }
  } else if (info.githubWanted === false) {
    rows.push({ ok: 'skip', label: 'GitHub', detail: '按要求跳过' })
  }

  const hard = rows.filter((r) => r.ok !== 'skip')
  return { ok: hard.length > 0 && hard.every((r) => r.ok === true), rows }
}

/** 8. 可选：装进 DSH profile。 */
async function installIntoProfile(info, settings) {
  const profile = settings.profile
  if (!profile) return { ok: 'skip', detail: '没配 profile' }
  const cli = findDshCli()
  if (!cli) return { ok: false, detail: '找不到 dsh CLI（可在设置里填 dshCli）' }
  const r = await run(cli, ['plugin', '--profile', profile, 'add', `file:${info.artifact}`], { cwd: info.repo, timeoutMs: 600000 })
  if (r.code !== 0) return { ok: false, detail: `安装失败：${oneLine(r.stderr || r.stdout, 200)}` }
  return { ok: true, detail: `已装进 profile ${profile}（重启 DSH 才加载新版本）` }
}

function findDshCli() {
  const exeDir = dirname(process.execPath)
  const guesses = [
    join(exeDir, 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd'),
    join(exeDir, 'resources', 'runtime', 'cli', 'bin', 'dsh'),
    '/usr/local/bin/dsh',
    '/usr/bin/dsh',
  ]
  return guesses.find((p) => existsSync(p)) || null
}

// ─────────────────────────── CI workflow ───────────────────────────

function workflowYaml(pkg) {
  const node = '22'
  return `# 由 dsh-release 生成：OIDC trusted publishing。
# 打 tag（v1.2.3）时由 GitHub Actions 发布到 npm —— 仓库里不存任何 npm 令牌。
# npm 侧还要跑一次（需要交互式 2FA）：
#   npm trust github ${pkg} --file release.yml --repo <owner>/<repo> --allow-publish
name: release

on:
  push:
    tags:
      - 'v*'

permissions:
  contents: read
  id-token: write   # ← OIDC 换短期凭证，缺了这行 npm 会拒绝

jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: '${node}'
          registry-url: 'https://registry.npmjs.org'

      # trusted publishing 要求 npm >= 11.5.1，runner 自带的往往不够
      - name: 升级 npm
        run: npm install -g npm@latest

      - name: 安装依赖
        run: npm ci --ignore-scripts || npm install --ignore-scripts

      - name: 测试
        run: npm test --if-present

      - name: 发布到 npm（OIDC，无令牌）
        run: npm publish --access public
`
}

// ─────────────────────────── 工具 ───────────────────────────

const DESCRIPTION =
  '一次调用把「发布」走完，并**用哈希证明三处一致**。适合发自己的 DSH 插件 / npm 包。\n\n' +
  '动作（action）：\n' +
  '- `prepare`（默认）：只采集现状，出一张计划卡片——版本一致性、git 状态、npm 已发布版本、' +
  '凭证可用性、将要提交的文件、以及会不会撞版本。**不改任何文件、不联网写任何东西。**\n' +
  '- `apply`：真正发布。顺序是 版本同步 → 测试 → npm pack → 提交打 tag 推送 → GitHub Release → ' +
  'npm 发布 → **核验三处字节一致**。任一步失败就停下并说明卡在哪。\n' +
  '- `setup-ci`：在仓库里写 `.github/workflows/release.yml`（OIDC trusted publishing），' +
  '并给出 npm 侧要执行的命令。之后打 tag 就由 CI 发布，仓库里不用再存 npm 令牌。\n' +
  '- `verify`：只做核验——把 registry 上的 tarball、GitHub Release 附件和本地产物比 sha256。\n\n' +
  '关键参数：`repo`（默认=当前会话工作目录）、`version` 或 `bump`、`channel`（auto/token/stage/ci）、' +
  '`changelog_entry`、`notes`、`install`、`skip_tests`。\n\n' +
  '口径：0.x 一律预发布，1.x 起算正式版（可用 `prerelease` 覆盖）。\n' +
  '注意：npm 发布返回的 202 是异步受理，**本工具只在 registry 上真的查到且哈希对得上时才说「发出去了」**。'

/**
 * 注册 `/_release/settings`（GET）。走 webServer 这个**可选**服务。
 *
 * 两个坑叠在一起，2026-10-25 在 rc.3 宿主上才暴露：
 *  1. `webServer` **不能**写进 `inject` —— 没有 web 的 profile（headless / tui）会因此整个插件
 *     不加载，连 `release` 工具都没了。
 *  2. 但也不能在这里直接 `ctx.get('webServer')` —— cordis 的 `get()` 对「还没 provide」的服务
 *     返回 undefined，而本插件的 apply 通常跑在 webServer 就绪**之前** → 路由静默不注册。
 *     当初还套了个 try/catch，等于把这次失败彻底吞掉。
 *
 * 正解是 `ctx.inject(['webServer'], cb)`：cordis 会在服务可用时（现在或以后）调用 cb。
 *
 * 当时被误导的地方：POST 到**任何**未知路径都返回 405，看起来像「路由已注册」。
 * 判断路由是否注册只能看 GET 是否 404。回归测试见 test/test-optional-service.mjs。
 */
function registerSettingsRoute(ctx, config) {
  const mount = (scope) => {
    // get 本身也可能抛（某些 cordis 组合下拿未 inject 的服务会报错）——
    // 这里只能吞掉，因为「没有 webServer」是正常情况，不该让整个插件加载失败。
    let webServer
    try {
      webServer = typeof scope.get === 'function' ? scope.get('webServer') : scope.webServer
    } catch { webServer = undefined }
    if (!webServer || typeof webServer.register !== 'function') return
    scope.effect(
      () => webServer.register({
        kind: 'exact',
        path: '/_release/settings',
        handler: async (req, res) => {
          const send = (status, value) => {
            res.statusCode = status
            res.setHeader('content-type', 'application/json; charset=utf-8')
            res.end(JSON.stringify(value))
          }
          try {
            if (req.method === 'GET') {
              const live = resolveSettings(config)
              const git = await findGit(live)
              send(200, {
                ok: true,
                git: git ? { path: git.path, how: git.how } : null,
                store: STORE,
                settings: { profile: live.profile, access: live.access, verifyTimeoutMs: live.verifyTimeoutMs },
              })
              return
            }
            send(405, { ok: false, error: 'GET only' })
          } catch (error) {
            send(500, { ok: false, error: String(error?.message || error) })
          }
        },
      }),
      'dsh-release: settings route',
    )
  }

  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], mount)
    return
  }
  mount(ctx) // 老 cordis 没有 ctx.inject：尽力而为
}

export function apply(ctx, config) {
  registerSettingsRoute(ctx, config)

  ctx.tools.register(
    defineTool({
      name: 'release',
      description: DESCRIPTION,
      parameters: {
        repo: { type: 'string', description: '仓库目录（默认=当前会话工作目录）' },
        action: { type: 'string', description: 'prepare | apply | setup-ci | verify，默认 prepare' },
        version: { type: 'string', description: '目标版本号，如 1.0.9（与 bump 二选一）' },
        bump: { type: 'string', description: 'patch | minor | major（没给 version 时用它递增）' },
        channel: { type: 'string', description: 'npm 发布通道：auto | token | stage | ci，默认 auto' },
        prerelease: { type: 'string', description: 'auto | true | false，默认 auto（0.x 预发布、1.x 正式版）' },
        changelog_entry: { type: 'string', description: 'apply 时插进 CHANGELOG.md 顶部的本版说明' },
        notes: { type: 'string', description: 'GitHub Release 正文' },
        name: { type: 'string', description: 'GitHub Release 标题，默认用 tag' },
        message: { type: 'string', description: '提交信息，默认 release: v<版本>' },
        access: { type: 'string', description: 'npm publish --access，默认 public' },
        profile: { type: 'string', description: '发布成功后装进哪个 DSH profile（默认不动）' },
        install: { type: 'boolean', description: '发布后把产物装进 profile（配合 profile 参数）' },
        github: { type: 'boolean', description: '是否建 GitHub Release，默认 true' },
        tag: { type: 'boolean', description: '是否打 tag 并推送，默认 true' },
        skip_tests: { type: 'boolean', description: '跳过测试，默认 false' },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => [{ type: 'text', text: value?.text || '（没有输出）' }],
      },
      timeoutMs: 1800000,
      execute: async (args, exec) => {
        const settings = resolveSettings(config)
        const action = String(args.action || 'prepare').toLowerCase()
        const logs = []
        const log = (m) => { logs.push(m) }
        const t0 = Date.now()

        try {
          if (action === 'setup-ci') return setupCi(settings, args, ctx, exec)

          const info = await collect(settings, args, ctx, exec, log)

          if (action === 'prepare') {
            const text = planText(info)
            return { text: logs.length ? text + '\n\n' + logs.join('\n') : text }
          }

          if (action === 'verify') {
            info.artifact = join(info.repo, info.asset)
            info.sha256 = existsSync(info.artifact) ? sha256File(info.artifact) : ''
            info.size = existsSync(info.artifact) ? fileSize(info.artifact) : 0
            info.shasum = ''
            const verified = await verifyAll(info, settings, log)
            const text = `核验 · ${info.pkg.name} ${info.target}\n\n` +
              verified.rows.map((r) => `  ${r.ok === false ? '✘' : r.ok === 'skip' ? '·' : '✔'} ${r.label.padEnd(12)}${r.detail}`).join('\n') +
              (info.sha256 ? `\n\n  本地产物 sha256 ${info.sha256}` : '\n\n  ⚠ 本地没有产物文件，没法做逐字节比对')
            return { text, verified }
          }

          if (action !== 'apply') return { text: `不认识的动作：${action}（只支持 prepare / apply / setup-ci / verify）` }

          // ── apply ──
          if (info.collisions.length) {
            return { text: `不能发布，先解决这些问题：\n\n` + info.collisions.map((c) => '  ✘ ' + c).join('\n') + `\n\n${planText(info)}` }
          }

          const steps = []
          step(steps, true, '版本同步', applyVersionSync(info, args))

          try {
            const t = await runTests(info)
            step(steps, t.ok, '测试', t.detail)
          } catch (error) {
            step(steps, false, '测试', oneLine(error?.message, 400))
            return { text: reportText({ name: info.pkg.name, current: info.current, target: info.target, status: 'failed', steps, elapsed: Date.now() - t0 }), failed: 'tests' }
          }

          const p = await packArtifact(info, args)
          step(steps, p.ok, '打包', p.detail)

          try {
            const c = await commitAndPush(info, args)
            step(steps, c.ok, 'git', c.detail)
          } catch (error) {
            step(steps, false, 'git', oneLine(error?.message, 400))
            return { text: reportText({ name: info.pkg.name, current: info.current, target: info.target, status: 'failed', steps, elapsed: Date.now() - t0 }), failed: 'git' }
          }

          const g = await githubRelease(info, args)
          step(steps, g.ok, 'GitHub', g.detail)

          const n = await npmPublish(info, args)
          step(steps, n.ok, 'npm', n.detail)

          const verified = await verifyAll(info, settings, log)
          const stepsWithInstall = steps
          if (args.install) {
            const inst = await installIntoProfile(info, { ...settings, profile: args.profile || settings.profile })
            stepsWithInstall.push({ ok: inst.ok, label: '安装', detail: inst.detail })
          }

          const ok = stepsWithInstall.every((s) => s.ok !== false) && verified.ok
          return {
            text: reportText({ name: info.pkg.name, current: info.current, target: info.target, status: ok ? 'ok' : 'failed', steps: stepsWithInstall, verified, elapsed: Date.now() - t0 }) +
              (info.releaseUrl ? `\n\n  Release：${info.releaseUrl}` : ''),
            ok,
            version: info.target,
            sha256: info.sha256,
          }
        } catch (error) {
          const message = oneLine(error?.message || error, 600)
          return { text: `发布中断：${message}${logs.length ? '\n\n' + logs.join('\n') : ''}` , failed: true }
        }
      },
    }),
  )
}

// ─────────────────────────── setup-ci ───────────────────────────

async function setupCi(settings, args, ctx, exec) {
  const repo = resolve(args.repo && String(args.repo).trim() ? String(args.repo) : await sessionCwd(ctx, exec))
  const pkgPath = join(repo, 'package.json')
  if (!existsSync(pkgPath)) return { text: `不是仓库根目录（没有 package.json）：${repo}` }
  const pkg = readJsonSafe(pkgPath)
  const slug = parseRepoUrl(pkg?.repository?.url || pkg?.repository || pkg?.homepage || '')

  const dir = join(repo, '.github', 'workflows')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'release.yml')
  const existed = existsSync(file)
  if (existed && !args.message) {
    return { text: `已经存在：${file}\n要看内容就 read 它；要覆盖就在 message 参数里写一句理由。`, exists: true }
  }
  writeFileSync(file, workflowYaml(pkg.name), 'utf8')

  const lines = [
    `${existed ? '已覆盖' : '已写入'} ${file}`,
    '',
    '这份 workflow 会在**打 tag 时**用 OIDC 发布到 npm —— 仓库里不用存任何 npm 令牌。',
    '',
    '还差 npm 侧一次配置（**必须交互式 2FA**，bypass 2FA 的令牌从 2026-08 起做不了这件事）：',
    '',
    `  npm trust github ${pkg.name} --file release.yml --repo ${slug ? slug.owner + '/' + slug.repo : '<owner>/<repo>'} --allow-publish`,
    '',
    '或者网页：https://www.npmjs.com/package/' + pkg.name + '/access → Trusted Publishing → GitHub Actions',
    '  · 仓库填 ' + (slug ? `${slug.owner}/${slug.repo}` : '<owner>/<repo>'),
    '  · workflow 文件名必须**一字不差**（release.yml，含扩展名）',
    '',
    '配好之后：release({ action: "apply", repo: ' + JSON.stringify(repo) + ', version: "…" })',
    '  · channel 会自动选 ci —— 本地只推 tag，npm 由 CI 发，避免两边抢同一个版本号。',
  ]
  return { text: lines.join('\n'), file, yaml: workflowYaml(pkg.name) }
}

// 给测试用的内部入口。生产路径不经过这里。
export const __test = { collect, applyVersionSync, workflowYaml, setupCi, resolveSettings, findDshCli, sessionCwd }