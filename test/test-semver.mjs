// 版本号解析 / 递增 / 比较 —— 全是纯函数，毫秒级。
import { parseVersion, formatVersion, bumpVersion, compareVersions } from '../lib/plan.js'
import { makeAsserts } from './_setup.mjs'

const a = makeAsserts('semver')

a.eq(parseVersion('1.2.3').major, 1, 'major')
a.eq(parseVersion('1.2.3').minor, 2, 'minor')
a.eq(parseVersion('1.2.3').patch, 3, 'patch')
a.eq(parseVersion('v0.9.26').patch, 26, 'v 前缀可解析')
a.eq(parseVersion('1.0.0-rc.2').pre, 'rc.2', '预发布段')
a.eq(parseVersion('1.0.0+build.5').build, 'build.5', 'build 段')
a.eq(parseVersion('1.2'), null, '1.2 不是完整 semver')
a.eq(parseVersion(''), null, '空串返回 null')
a.eq(parseVersion(undefined), null, 'undefined 返回 null')
a.eq(parseVersion('abc'), null, '乱码返回 null')

a.eq(formatVersion(parseVersion('1.2.3-rc.1')), '1.2.3-rc.1', '格式化往返')

a.eq(bumpVersion('1.0.8', 'patch'), '1.0.9', 'patch')
a.eq(bumpVersion('1.0.8', 'minor'), '1.1.0', 'minor')
a.eq(bumpVersion('1.0.8', 'major'), '2.0.0', 'major')
a.eq(bumpVersion('0.9.26', 'minor'), '0.10.0', 'minor 不进位到 1')
a.eq(bumpVersion('1.0.0-rc.2', 'patch'), '1.0.1', 'bump 丢掉预发布后缀')

let threw = false
try { bumpVersion('1.0.0', 'nope') } catch { threw = true }
a.ok(threw, '非法 bump 抛错')
threw = false
try { bumpVersion('abc', 'patch') } catch { threw = true }
a.ok(threw, '非法版本号抛错')

a.eq(compareVersions('1.0.9', '1.0.8'), 1, '1.0.9 > 1.0.8')
a.eq(compareVersions('1.0.8', '1.0.9'), -1, '1.0.8 < 1.0.9')
a.eq(compareVersions('1.0.8', '1.0.8'), 0, '相等')
a.eq(compareVersions('2.0.0', '1.99.99'), 1, 'major 优先')
a.eq(compareVersions('1.0.0', '1.0.0-rc.1'), 1, '正式版 > 同号预发布')
a.eq(compareVersions('1.0.0-rc.2', '1.0.0-rc.1'), 1, '预发布之间可比')

a.done()