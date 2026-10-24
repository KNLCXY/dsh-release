/**
 * dsh-release — 进程与工具链供应层。
 *
 * 这台机器（以及很多装了 DSH 桌面版的机器）PATH 里**没有 node，也没有 npm**。
 * 所以这里做三件事：
 *   1. 找得到 git（PATH → 几个已知位置，逐个探活）
 *   2. 自己解决 npm：优先本机已装的，找不到就从 registry 下一份 npm CLI 缓存起来，
 *      用 `ELECTRON_RUN_AS_NODE=1 <Electron> npm-cli.js` 跑（DSH 桌面版自带 Node）
 *   3. 造一个 node 垫片目录，让 `npm test` 里的 `node xxx.mjs` 也能跑起来
 *
 * 注意：spawn 一律**不传** windowsHide —— 见 dsh-websift 桌面白框那笔账：
 * 它在 Windows 上通过 STARTUPINFO 传 SW_HIDE，会覆盖子进程自己的第一次 ShowWindow。
 * 我们起的都是控制台程序，本来就不创建窗口。
 *
 * @module dsh-release/proc
 */

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { gunzipSync } from 'node:zlib'

export const HOME = homedir()
export const STORE = join(HOME, '.dsh', 'storages', 'release')

const IS_WIN = process.platform === 'win32'

/** 跑一个子进程，收 stdout/stderr。绝不抛错，交给调用方按 code 判断。 */
export function run(cmd, args, options = {}) {
  const { cwd, env, timeoutMs = 120000, input, stdio } = options
  return new Promise((resolvePromise) => {
    const started = Date.now()
    let child
    try {
      child = spawn(cmd, args, {
        cwd,
        env: env ? { ...process.env, ...env } : process.env,
        stdio: stdio || ['pipe', 'pipe', 'pipe'],
      })
    } catch (error) {
      resolvePromise({ code: -1, stdout: '', stderr: String(error?.message || error), ms: 0, cmd, args })
      return
    }
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timer = timeoutMs > 0
      ? setTimeout(() => {
        timedOut = true
        try { child.kill('SIGKILL') } catch { /* 已经退了 */ }
      }, timeoutMs)
      : null

    child.stdout?.on('data', (b) => { stdout += b.toString('utf8') })
    child.stderr?.on('data', (b) => { stderr += b.toString('utf8') })
    if (input !== undefined && child.stdin) {
      child.stdin.end(input)
    } else {
      child.stdin?.end()
    }
    child.on('error', (error) => {
      if (timer) clearTimeout(timer)
      resolvePromise({ code: -1, stdout, stderr: stderr + String(error?.message || error), ms: Date.now() - started, cmd, args })
    })
    child.on('close', (code) => {
      if (timer) clearTimeout(timer)
      resolvePromise({ code: code ?? -1, stdout, stderr, ms: Date.now() - started, cmd, args, timedOut })
    })
  })
}

/** 跑一个子进程，非 0 退出时抛错（错误信息带上 stderr 尾部）。 */
export async function runOk(cmd, args, options = {}) {
  const r = await run(cmd, args, options)
  if (r.code !== 0) {
    const tail = (r.stderr || r.stdout || '').trim().split(/\r?\n/).slice(-6).join('\n')
    const error = new Error(`${cmd} ${args.join(' ')} 退出码 ${r.code}${r.timedOut ? '（超时）' : ''}${tail ? '\n' + tail : ''}`)
    error.result = r
    throw error
  }
  return r
}

/** 收起一段输出成单行，便于塞进报告。 */
export function oneLine(text, max = 200) {
  const s = String(text || '').trim().split(/\r?\n/).filter(Boolean).join(' / ')
  return s.length > max ? s.slice(0, max - 1) + '…' : s
}

function canRun(cmd, args = ['--version'], timeoutMs = 5000) {
  return run(cmd, args, { timeoutMs }).then((r) => r.code === 0)
}

/** 找 git：显式配置 → PATH → 几个已知位置（含 dsh-ops 自带的那份）。 */
export async function findGit(settings = {}) {
  if (settings.gitPath && existsSync(settings.gitPath)) return { path: settings.gitPath, how: '配置' }

  const candidates = []
  for (const dir of String(process.env.PATH || '').split(IS_WIN ? ';' : ':').filter(Boolean)) {
    candidates.push(join(dir, IS_WIN ? 'git.exe' : 'git'))
  }
  const profilesRoot = join(HOME, '.dsh', 'profiles')
  if (existsSync(profilesRoot)) {
    for (const p of safeReaddir(profilesRoot)) {
      candidates.push(join(profilesRoot, p, 'node_modules', '@dsh-ops', 'bash-win32-x64', 'ucrt64', 'bin', 'git.exe'))
    }
  }
  candidates.push(
    'C:/Program Files/Git/cmd/git.exe',
    'C:/Program Files (x86)/Git/cmd/git.exe',
    join(process.env.LOCALAPPDATA || '', 'Programs', 'Git', 'cmd', 'git.exe'),
    '/usr/bin/git',
    '/usr/local/bin/git',
    '/opt/homebrew/bin/git',
  )

  for (const c of candidates) {
    if (!c || !existsSync(c)) continue
    if (await canRun(c)) return { path: c, how: c.includes('ucrt64') ? 'PATH 邻域（dsh-ops 自带 git）' : '自动探测' }
  }
  // 最后再赌一次 PATH 解析（存在但 existsSync 没命中，比如 .cmd 包装）
  if (await canRun('git')) return { path: 'git', how: 'PATH' }
  return null
}

function safeReaddir(dir) {
  try { return readdirSync(dir) } catch { return [] }
}

/** 解 tar.gz（只认 ustar 常规文件/目录，够解 npm 的包）。 */
export function extractTarGz(buffer, destDir) {
  const tar = gunzipSync(buffer)
  mkdirSync(destDir, { recursive: true })
  let offset = 0
  let files = 0
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512)
    // 连续两个空块 = 结束
    if (header.every((b) => b === 0)) break
    const rawName = readCString(header, 0, 100)
    const prefix = readCString(header, 345, 155)
    const name = prefix ? `${prefix}/${rawName}` : rawName
    const size = parseInt(readCString(header, 124, 12).trim() || '0', 8) || 0
    const typeflag = String.fromCharCode(header[156] || 0x30)
    const dataStart = offset + 512
    if (name) {
      // 防目录穿越
      const target = resolve(destDir, name)
      if (!target.startsWith(resolve(destDir))) throw new Error(`tar 条目越界：${name}`)
      if (typeflag === '5') {
        mkdirSync(target, { recursive: true })
      } else if (typeflag === '0' || typeflag === '\0' || typeflag === '') {
        mkdirSync(dirname(target), { recursive: true })
        writeFileSync(target, tar.subarray(dataStart, dataStart + size))
        files++
      }
    }
    offset = dataStart + Math.ceil(size / 512) * 512
  }
  if (files === 0) throw new Error('tar 解出来是空的')
  return files
}

function readCString(buf, start, len) {
  let end = start
  const max = start + len
  while (end < max && buf[end] !== 0) end++
  return buf.toString('utf8', start, end)
}

/**
 * 保证有一个可用的 npm CLI。
 * 顺序：配置里的 npmCli → 本机 node 自带的 npm → 缓存目录 → 从 registry 下载后缓存。
 * 返回 { script, via, version }；script 是 npm-cli.js 的绝对路径。
 */
export async function ensureNpm(settings = {}, log = () => {}) {
  if (settings.npmCli && existsSync(settings.npmCli)) {
    const v = await npmVersionOf(settings.npmCli)
    if (v) return { script: settings.npmCli, via: '配置指定', version: v }
  }

  // 本机若真装了 npm，直接用它（多一层探测，别浪费）
  const local = await findLocalNpmCli()
  if (local) {
    const v = await npmVersionOf(local)
    if (v) return { script: local, via: '本机 npm', version: v }
  }

  const cached = join(STORE, 'npm', 'current', 'package', 'bin', 'npm-cli.js')
  if (existsSync(cached)) {
    const v = await npmVersionOf(cached)
    if (v) return { script: cached, via: '缓存', version: v }
  }

  const version = settings.npmVersion ? String(settings.npmVersion) : await latestNpmVersion()
  log(`下载 npm ${version}…`)
  const url = `https://registry.npmjs.org/npm/-/npm-${version}.tgz`
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok) throw new Error(`下载 npm 失败：HTTP ${res.status} ${url}`)
  const buf = Buffer.from(await res.arrayBuffer())
  const dest = join(STORE, 'npm', 'current')
  extractTarGz(buf, dest)
  const script = join(dest, 'package', 'bin', 'npm-cli.js')
  if (!existsSync(script)) throw new Error(`npm 包装好了但找不到 ${script}`)
  const v = await npmVersionOf(script)
  return { script, via: `刚下载（${(buf.length / 1024 / 1024).toFixed(1)}MB）`, version: v || version }
}

async function latestNpmVersion() {
  try {
    const res = await fetch('https://registry.npmjs.org/npm/latest', { redirect: 'follow' })
    if (res.ok) {
      const j = await res.json()
      if (j && j.version) return j.version
    }
  } catch { /* 离线就退回钉住的版本 */ }
  return '12.2.1'
}

async function findLocalNpmCli() {
  const exe = process.execPath
  const guesses = [
    join(dirname(exe), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(dirname(exe), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    '/usr/lib/node_modules/npm/bin/npm-cli.js',
    '/usr/local/lib/node_modules/npm/bin/npm-cli.js',
  ]
  for (const g of guesses) if (g && existsSync(g)) return g
  return null
}

async function npmVersionOf(script) {
  const r = await npmInvocation(script, ['--version'], { timeoutMs: 30000 })
  if (r.code !== 0) return null
  const v = oneLine(r.stdout, 20)
  return /^\d+\.\d+\.\d+/.test(v) ? v : null
}

/**
 * 挑一个「Node 运行时」。
 * 优先真 node（DSH 自带的运行时依赖就有一份，比拿 Electron 顶替快得多），
 * 找不到才退回宿主进程自己 —— Electron 用 ELECTRON_RUN_AS_NODE=1 就是 Node。
 */
export function nodeRuntime() {
  const candidates = [
    process.env.DSH_RELEASE_NODE,
    join(HOME, '.dsh', 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'node', 'bin', 'node.exe'),
    join(HOME, '.dsh', 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'node', 'bin', 'node'),
    join(dirname(process.execPath), 'node.exe'),
    join(dirname(process.execPath), 'node'),
  ].filter(Boolean)
  for (const c of candidates) {
    if (existsSync(c)) return { path: c, electron: false, how: 'DSH 自带的 node' }
  }
  return { path: process.execPath, electron: true, how: '宿主进程（Electron 当 Node 用）' }
}

/**
 * npm 垫片：让 `npm test` 里的 `node xxx.mjs` 有 node 可跑。
 */
export function ensureNodeShim() {
  const dir = join(STORE, 'bin')
  mkdirSync(dir, { recursive: true })
  const rt = nodeRuntime()
  if (IS_WIN) {
    const body = rt.electron
      ? `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${rt.path}" %*\r\n`
      : `@echo off\r\n"${rt.path}" %*\r\n`
    for (const name of ['node.cmd', 'npx.cmd']) {
      const shim = join(dir, name)
      let same = false
      try { same = readFileSync(shim, 'utf8') === body } catch { same = false }
      if (!same) writeFileSync(shim, body, 'utf8')
    }
    return dir
  }
  const shim = join(dir, 'node')
  const body = rt.electron
    ? `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec "${rt.path}" "$@"\n`
    : `#!/bin/sh\nexec "${rt.path}" "$@"\n`
  let same = false
  try { same = readFileSync(shim, 'utf8') === body } catch { same = false }
  if (!same) {
    writeFileSync(shim, body, 'utf8')
    try { chmodSync(shim, 0o755) } catch { /* 非 POSIX 或没权限就跳过 */ }
  }
  return dir
}

/** 用 Node 跑 npm-cli.js：把垫片目录塞进 PATH；Electron 还要带 ELECTRON_RUN_AS_NODE。 */
export function npmInvocation(script, args, options = {}) {
  const shim = ensureNodeShim()
  const path = [shim, process.env.PATH || ''].filter(Boolean).join(delimiter)
  const env = { ...(options.env || {}), PATH: path, Path: path }
  const rt = nodeRuntime()
  if (rt.electron) env.ELECTRON_RUN_AS_NODE = '1'
  return run(rt.path, [script, ...args], { ...options, env })
}

export function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

export function sha1File(path) {
  return createHash('sha1').update(readFileSync(path)).digest('hex')
}

export function fileSize(path) {
  try { return statSync(path).size } catch { return 0 }
}

/** 人类可读的字节数。 */
export function bytes(n) {
  return `${Number(n || 0).toLocaleString('en-US')} B`
}

/** 从一段输出里抠出第一段完整 JSON（按括号配对扫，跳过字符串里的括号）。 */
export function firstJsonValue(text) {
  const s = String(text || '')
  const start = s.search(/[[{]/)
  if (start < 0) return null
  const open = s[start]
  const close = open === '{' ? '}' : ']'
  let depth = 0
  let inStr = false
  let esc = false
  for (let i = start; i < s.length; i++) {
    const ch = s[i]
    if (inStr) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') { inStr = true; continue }
    if (ch === open) depth++
    else if (ch === close) {
      depth--
      if (depth === 0) {
        try { return JSON.parse(s.slice(start, i + 1)) } catch { return null }
      }
    }
  }
  return null
}

/**
 * 解析 `npm pack --json` 的输出。
 * 实测 npm 12.2.1 给的是**对象**（键是包名），老版本给的是**数组** —— 两种都认。
 */
export function parsePackOutput(text) {
  const v = firstJsonValue(text)
  if (!v) return null
  if (Array.isArray(v)) return v[0] || null
  const values = Object.values(v)
  return values.length ? values[0] : null
}