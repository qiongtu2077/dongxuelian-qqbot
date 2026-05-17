/**
 * MODULE: 文件内容搜索工具。
 * 安全：限定工作区目录，跳过二进制和大文件，限制返回行数。
 */
const fs = require('fs/promises')
const path = require('path')
const { assertExistingAgentPathInsideRoots, resolveAgentDefaultRoot, isAgentPathInside } = require('../path-guard')

const MAX_FILE_BYTES = 512 * 1024
const MAX_MATCHES = 200
const MAX_LINE_CHARS = 240
const MAX_TOTAL_OUTPUT_CHARS = 40000
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'dist-portable', '.claude', 'tmp'])

function grepWildcardToRegExp(pattern = '*') {
  const escaped = String(pattern || '*').replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')
  return new RegExp('^' + escaped + '$', 'i')
}

async function collectFiles(dir, matcher, out, maxFiles = 2000) {
  if (out.length >= maxFiles) return
  let entries = []
  try { entries = await fs.readdir(dir, { withFileTypes: true }) } catch { return }
  for (const entry of entries) {
    if (out.length >= maxFiles) return
    if (entry.name.startsWith('.') && entry.name !== '.env') continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) await collectFiles(full, matcher, out, maxFiles)
    } else if (entry.isFile() && matcher.test(entry.name)) {
      out.push(full)
    }
  }
}

module.exports = {
  definition: {
    name: 'grep_search',
    description: '在允许工作区内按正则搜索文本文件内容，返回 file:line: content。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '要搜索的正则或文本' },
        path: { type: 'string', description: '搜索根目录或单个文件，默认读取根目录' },
        glob: { type: 'string', description: '文件名通配符，例如 *.md、*.js，默认 *' },
        ignoreCase: { type: 'boolean', description: '是否忽略大小写，默认 true' },
        limit: { type: 'number', description: '最大匹配行数，默认 50，最大 200' },
      },
      required: ['query'],
    },
  },
  async execute(params = {}) {
    const query = String(params.query || '').trim()
    if (!query) throw new Error('query 不能为空')
    const limit = Math.max(1, Math.min(MAX_MATCHES, parseInt(params.limit, 10) || 50))
    let regex
    try { regex = new RegExp(query, params.ignoreCase === false ? 'u' : 'iu') } catch { regex = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), params.ignoreCase === false ? 'u' : 'iu') }

    const target = String(params.path || '').trim() || await resolveAgentDefaultRoot()
    const checked = await assertExistingAgentPathInsideRoots(target, '搜索路径')
    const stat = await fs.stat(checked.abs)
    const files = []
    if (stat.isFile()) files.push(checked.abs)
    else if (stat.isDirectory()) await collectFiles(checked.abs, grepWildcardToRegExp(params.glob || '*'), files)
    else throw new Error(`不支持的搜索路径：${target}`)

    const matches = []
    for (const file of files) {
      if (!isAgentPathInside(file, checked.real) && stat.isDirectory()) continue
      const st = await fs.stat(file).catch(() => null)
      if (!st || !st.isFile() || st.size > MAX_FILE_BYTES) continue
      const buffer = await fs.readFile(file).catch(() => null)
      if (!buffer || buffer.includes(0)) continue
      const lines = buffer.toString('utf8').split(/\r?\n/)
      for (let i = 0; i < lines.length; i++) {
        if (regex.test(lines[i])) {
          matches.push(`${file}:${i + 1}: ${lines[i].slice(0, MAX_LINE_CHARS)}`)
          const joined = matches.join('\n')
          if (joined.length > MAX_TOTAL_OUTPUT_CHARS) return `匹配 ${matches.length} 条（输出已截断）：\n${joined.slice(0, MAX_TOTAL_OUTPUT_CHARS)}`
          if (matches.length >= limit) return `匹配 ${matches.length} 条（已达上限）：\n${matches.join('\n')}`
        }
        regex.lastIndex = 0
      }
    }
    return matches.length ? `匹配 ${matches.length} 条：\n${matches.join('\n')}` : '未找到匹配内容。'
  },
  dangerous: false,
  defaultChannels: ['dashboard'],
}
