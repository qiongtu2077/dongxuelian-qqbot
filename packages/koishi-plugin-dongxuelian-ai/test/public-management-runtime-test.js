'use strict'

const assert = require('assert')
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..', '..', '..')
const management = require('../lib/public/management-runtime')
const CALLER_SOURCE_DIRS = [
  path.join(ROOT, 'packages', 'koishi-plugin-dashboard', 'src'),
  path.join(ROOT, 'packages', 'koishi-plugin-daily-report', 'src'),
]
const PRIVATE_AI_PATH_RE = /koishi-plugin-dongxuelian-ai[\\/]lib[\\/](?!public[\\/])/g

// 递归列出受检调用方中的 TypeScript 源码文件。
function listTypeScriptFiles(dir) {
  const files = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const target = path.join(dir, entry.name)
    if (entry.isDirectory()) files.push(...listTypeScriptFiles(target))
    else if (/\.(?:ts|tsx|vue)$/i.test(entry.name)) files.push(target)
  }
  return files
}

// 将绝对路径转换成仓库相对路径，便于失败信息直接定位。
function relative(file) {
  return path.relative(ROOT, file).replace(/\\/g, '/')
}

// 验证公共运行时的标识清单、惰性加载与非法输入拒绝行为。
function testPublicRuntimeContract() {
  const ids = management.listManagementModules()
  assert.ok(ids.length >= 40, 'public management module registry is incomplete')
  assert.strictEqual(new Set(ids).size, ids.length, 'public management module ids must be unique')
  assert.strictEqual(typeof management.loadManagementModule('core.frontmatter').parseFrontmatterDocument, 'function')
  assert.strictEqual(typeof management.loadManagementModule('agent.pathGuard').getAgentPathAllowedRoots, 'function')
  assert.strictEqual(typeof management.loadManagementModule('resource.files').readRecentJsonlEvents, 'function')
  assert.strictEqual(typeof management.loadManagementModule('media.personaDiagnostics').scanPersonaDocuments, 'function')
  assert.strictEqual(typeof management.loadManagementModule('daily.summaryMerge').mergeDailyFinalInput, 'function')
  assert.throws(() => management.loadManagementModule('core/private-file'), /unknown management module/)
}

// 禁止 Dashboard 和日报重新引用 AI 插件的非公开 lib 深路径。
function testNoPrivateAiDeepImports() {
  const failures = []
  for (const dir of CALLER_SOURCE_DIRS) {
    for (const file of listTypeScriptFiles(dir)) {
      const source = fs.readFileSync(file, 'utf8')
      PRIVATE_AI_PATH_RE.lastIndex = 0
      if (PRIVATE_AI_PATH_RE.test(source) || /\bAI_LIB\b/.test(source)) failures.push(relative(file))
    }
  }
  assert.deepStrictEqual(failures, [], `private AI deep imports found: ${failures.join(', ')}`)
}

// 执行公共边界结构回归并输出稳定摘要。
function main() {
  testPublicRuntimeContract()
  testNoPrivateAiDeepImports()
  console.log('public management runtime tests passed')
}

main()
