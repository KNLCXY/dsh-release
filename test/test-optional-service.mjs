// 回归测试：webServer 是**可选**服务，而且 apply 跑的时候它往往还没就绪。
//
// 真实踩过的坑（2026-10-25 在 rc.3 宿主上发现）：dsh-release 0.1.0 用
//   const ws = ctx.get('webServer')      // ← 这时它还没 provide，拿到 undefined
//   if (ws) ctx.effect(() => ws.register(...))
// 结果 `/_release/settings` 路由**从来没注册过**，而 try/catch 把这事悄悄吞了。
// 更阴的是：POST 到任何未知路径都返回 405，看起来像「路由已注册」。
//
// 正确做法是 ctx.inject(['webServer'], cb) —— cordis 会在服务可用时（现在或以后）调用它。
import { loadPlugin, fakeCtx, makeAsserts } from './_setup.mjs'

const a = makeAsserts('optional-service')

/** 模拟 cordis：webServer 一开始不存在，稍后才 provide。 */
function lateServiceCtx() {
  const routes = []
  const tools = []
  const waiting = []
  let webServer

  const scope = {
    get: (k) => (k === 'webServer' ? webServer : undefined),
    tools: { register: (t) => tools.push(t) },
    effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {} },
    // cordis 的 ctx.inject(names, cb)：服务就绪时调 cb
    inject: (names, cb) => { waiting.push({ names, cb }) },
  }

  const provide = () => {
    webServer = { register: (r) => { routes.push(r); return () => {} } }
    for (const w of waiting.splice(0)) w.cb(scope)
  }

  return { ctx: scope, tools, routes, provide, waiting }
}

const { mod } = await loadPlugin()

// ① 服务「后到」：apply 时还没有 webServer

const late = lateServiceCtx()
mod.apply(late.ctx, {})
a.ok(late.tools.some((t) => t.name === 'release'), '缺 webServer 不影响 release 工具注册')
a.ok(late.waiting.length > 0 || late.routes.length > 0, '必须登记对 webServer 的等待（否则路由永远不会注册）')

late.provide()
a.eq(late.routes.length, 1, 'webServer 就绪后必须注册一条路由')
a.eq(late.routes[0]?.path, '/_release/settings', '路由路径正确')
a.eq(late.routes[0]?.kind, 'exact', '路由 kind 正确')

// ② 服务一开始就在（老 cordis 没有 ctx.inject 的退化路径也要能注册）

const early = fakeCtx()
mod.apply(early.ctx, {})
a.ok(early.routes.some((r) => r.path === '/_release/settings'), 'webServer 已就绪时立刻注册')

// ③ 完全没有 webServer 的 profile（headless/tui）也不能因此整个插件不加载

const none = {
  get: () => undefined,
  tools: { register: (t) => { none.tools.list.push(t) } },
  effect: () => () => {},
  inject: () => {},
}
none.tools.list = []
mod.apply(none, {})
a.ok(none.tools.list.some((t) => t.name === 'release'), '没有 webServer 时插件照常加载工具')

a.done()