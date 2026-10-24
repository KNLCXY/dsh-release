#!/usr/bin/env node
// 测试用的假 npm CLI：只回答 dsh-release 会问到的那几个子命令。
// 这样 fixture 测试完全离线、毫秒级，同时真的走了一遍「spawn → 解析输出」的路径。
const args = process.argv.slice(2)

if (args.includes('--version') || args[0] === '--version') {
  process.stdout.write('9.9.9-stub\n')
  process.exit(0)
}
if (args[0] === 'whoami') {
  process.stdout.write('stub-user\n')
  process.exit(0)
}
if (args[0] === 'test') {
  process.stdout.write('stub tests passed\n')
  process.exit(0)
}
if (args[0] === 'pack') {
  process.stdout.write(JSON.stringify([{ filename: 'stub-0.0.0.tgz', shasum: 'deadbeef', files: [{ path: 'a' }] }]) + '\n')
  process.exit(0)
}
if (args[0] === 'publish' || args[0] === 'stage') {
  process.stdout.write('+ stub-pkg@0.0.0\n')
  process.exit(0)
}
process.stdout.write('\n')
process.exit(0)