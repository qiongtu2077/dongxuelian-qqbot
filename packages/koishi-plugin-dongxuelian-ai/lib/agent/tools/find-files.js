/**
 * MODULE: 文件名搜索工具。
 * 职责: 在允许根目录下按文件名模式列出候选文件。
 * 边界: 不读取文件内容、不执行 shell。
 * 状态: 无。
 */
const fs = require('fs/promises')
const path = require('path')
const { assertExistingAgentPathInsideRoots, resolveAgentDefaultRoot } = require('../path-guard')

const MAX_RESULTS = 80
const MAX_VISITED = 4000
const IGNORED_DIRS = new Set(['.git', 'node_modules', 'dist', 'dist-portable', '.claude', 'tmp'])

function wildcardToRegExp(pattern) {
  const text = String(pattern || '*').trim() || '*'
  const escaped = text.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')
  return new RegExp('^' + escaped + '$', 'i')
}

module.exports = {
  definition: {
    name: 'find_files',
    description: '在允许工作区内按文件名通配符查找文件。例: "*.js", "Agent*.vue"。',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: '文件名通配符，默认 *' },
        root: { type: 'string', description: '搜索根目录，必须位于允许根目录内' },
      },
    },
  },
  async execute(params = {}) {
    const requested = params.root ? String(params.root) : await resolveAgentDefaultRoot()
    const { abs: root } = await assertExistingAgentPathInsideRoots(requested, '搜索目录')
    const matcher = wildcardToRegExp(params.pattern || '*')
    const results = []
    let visited = 0

    async function walk(dir) {
      if (results.length >= MAX_RESULTS || visited >= MAX_VISITED) return
      let entries
      try { entries = await fs.readdir(dir, { withFileTypes: true }) } catch { return }
      for (const entry of entries) {
        if (results.length >= MAX_RESULTS || visited >= MAX_VISITED) return
        if (entry.isDirectory()) {
          if (!IGNORED_DIRS.has(entry.name)) await walk(path.join(dir, entry.name))
          continue
        }
        if (!entry.isFile()) continue
        visited++
        if (matcher.test(entry.name)) results.push(path.join(dir, entry.name))
      }
    }

    await walk(root)
    return JSON.stringify({ root, pattern: params.pattern || '*', total: results.length, truncated: results.length >= MAX_RESULTS || visited >= MAX_VISITED, files: results }, null, 2)
  },
  dangerous: false,
  defaultChannels: ['dashboard'],
}
