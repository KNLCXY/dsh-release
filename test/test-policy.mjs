// 发布口径：预发布策略、tag/产物命名、仓库地址解析、通道选择。
import { isPrerelease, tagFor, assetName, parseRepoUrl, chooseChannel, summarizePublished } from '../lib/plan.js'
import { makeAsserts } from './_setup.mjs'

const a = makeAsserts('policy')

// 用户定的口径：0.x 一律预发布，1.x 起算正式版
a.eq(isPrerelease('0.9.26'), true, '0.9.26 是预发布')
a.eq(isPrerelease('0.0.1'), true, '0.0.1 是预发布')
a.eq(isPrerelease('1.0.0'), false, '1.0.0 是正式版')
a.eq(isPrerelease('2.3.4'), false, '2.3.4 是正式版')
a.eq(isPrerelease('0.9.26', true), true, '显式 true 覆盖')
a.eq(isPrerelease('1.0.0', true), true, '显式 true 覆盖正式版')
a.eq(isPrerelease('0.9.26', false), false, '显式 false 覆盖 0.x')
a.eq(isPrerelease('1.0.0', 'true'), true, '字符串 true 也认')

a.eq(tagFor('1.0.9'), 'v1.0.9', 'tag 加 v')
a.eq(tagFor('v1.0.9'), 'v1.0.9', '已有 v 不重复加')
a.eq(tagFor('1.0.0-rc.1'), 'v1.0.0-rc.1', '预发布 tag')

a.eq(assetName('dsh-websift', '1.0.9'), 'dsh-websift-1.0.9.tgz', '普通包名')
a.eq(assetName('@knlcxy/dsh-websift', '1.0.9'), 'knlcxy-dsh-websift-1.0.9.tgz', 'scope 拍平')
a.eq(assetName('a/b/c', '1.0.0'), 'a-b-c-1.0.0.tgz', '多斜杠都拍平')

a.eq(parseRepoUrl('git+https://github.com/KNLCXY/dsh-websift.git')?.owner, 'KNLCXY', 'owner')
a.eq(parseRepoUrl('git+https://github.com/KNLCXY/dsh-websift.git')?.repo, 'dsh-websift', 'repo 去掉 .git')
a.eq(parseRepoUrl('https://github.com/a/b')?.repo, 'b', '无 .git')
a.eq(parseRepoUrl('git@github.com:a/b.git')?.repo, 'b', 'SSH 形式')
a.eq(parseRepoUrl('https://gitlab.com/a/b'), null, '非 github 返回 null')
a.eq(parseRepoUrl(''), null, '空串返回 null')

// 通道选择：显式优先 → 有 workflow 走 CI → 有凭证走 token → 都没有走 staged
a.eq(chooseChannel({ requested: 'token', ci: true, tokenOk: true }).channel, 'token', '显式 token 优先')
a.eq(chooseChannel({ requested: 'stage', ci: true, tokenOk: true }).channel, 'stage', '显式 stage 优先')
a.eq(chooseChannel({ ci: true, tokenOk: true }).channel, 'ci', '有 workflow 走 CI（不让本地和 CI 抢版本号）')
a.eq(chooseChannel({ ci: false, tokenOk: true }).channel, 'token', '无 workflow 有凭证走 token')
a.eq(chooseChannel({ ci: false, tokenOk: false }).channel, 'stage', '都没有走 staged')
let threw = false
try { chooseChannel({ requested: 'bogus' }) } catch { threw = true }
a.ok(threw, '非法 channel 抛错')

a.eq(summarizePublished({}, {}).count, 0, '空版本表')
a.eq(summarizePublished({ '1.0.0': {}, '1.0.1': {} }, { latest: '1.0.1' }).latest, '1.0.1', '取 latest')

a.done()