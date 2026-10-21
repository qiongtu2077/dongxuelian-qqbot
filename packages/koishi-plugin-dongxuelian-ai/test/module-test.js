'use strict'
const fs = require('fs')
const path = require('path')
const { createCascadeHarness } = require('./helpers/cascade-harness')

// 只运行明确指定的场景模块，未知名称在执行前拒绝，避免误跑全量。
async function main() {
  const names = process.argv.slice(2)
  const available = new Set(fs.readdirSync(path.join(__dirname, 'scenarios')).filter(name => name.endsWith('.test.js')).map(name => name.slice(0, -8)))
  if (!names.length || names.some(name => !available.has(name))) throw new Error('请指定有效模块：' + [...available].join(', '))
  const t = createCascadeHarness(path.resolve(__dirname, '../../..'))
  for (const name of [...new Set(names)]) await require('./scenarios/' + name + '.test.js').run(t)
  const counts = t.getCounts()
  console.log(counts)
  process.exit(counts.failed || counts.skipped ? 1 : 0)
}
main().catch(error => { console.error(error.stack || error.message); process.exit(1) })
