/**
 * MODULE: 文件列表工具。
 * 安全：限定工作区目录，只列出目录项元数据。
 */
const fs = require('fs/promises') as typeof import('fs/promises')
const path = require('path') as typeof import('path')
const { assertExistingAgentPathInsideRoots, resolveAgentDefaultRoot } = require('../path-guard') as typeof import('../path-guard')

interface ListFilesParams {
  path?: unknown
  recursive?: unknown
  limit?: unknown
}

interface FileStatLike {
  isDirectory: () => boolean
}

interface DirentLike {
  name: string
  isDirectory: () => boolean
  isFile: () => boolean
}

interface ListedFileEntry {
  path: string
  type: 'dir' | 'file' | 'other'
}

const MAX_ENTRIES = 200
const IGNORED_DIRS = new Set(['.git', 'node_modules', 'dist', 'dist-portable', '.claude', 'tmp'])

export = {
  definition: {
    name: 'list_files',
    description: '列出允许工作区内某个目录的文件和子目录。默认不递归。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '目录绝对路径；默认第一个允许根目录' },
        recursive: { type: 'boolean', description: '是否递归列出，默认 false' },
        limit: { type: 'number', description: '最多返回项数，默认 80，最大 200' },
      },
    },
  },
  async execute(params: ListFilesParams = {}): Promise<string> {
    const requested = params.path ? String(params.path) : await resolveAgentDefaultRoot()
    const { abs: target } = await assertExistingAgentPathInsideRoots(requested, '目录')

    const stat = await fs.stat(target).catch((): null => null) as FileStatLike | null
    if (!stat) throw new Error(`目录不存在：${target}`)
    if (!stat.isDirectory()) throw new Error(`不是目录：${target}`)

    const limit = Math.min(MAX_ENTRIES, Math.max(1, parseInt(String(params.limit), 10) || 80))
    const recursive = !!params.recursive
    const entries: ListedFileEntry[] = []

    async function walk(dir: string, depth: number): Promise<void> {
      if (entries.length >= limit) return
      let list: DirentLike[] = []
      try { list = await fs.readdir(dir, { withFileTypes: true }) } catch {
        /* non-critical: unreadable directories are skipped */
        return
      }
      for (const entry of list) {
        if (entries.length >= limit) return
        if (entry.isDirectory() && IGNORED_DIRS.has(entry.name)) continue
        const full = path.join(dir, entry.name)
        entries.push({ path: full, type: entry.isDirectory() ? 'dir' : entry.isFile() ? 'file' : 'other' })
        if (recursive && entry.isDirectory() && depth < 5) await walk(full, depth + 1)
      }
    }

    await walk(target, 0)
    return JSON.stringify({ root: target, recursive, total: entries.length, truncated: entries.length >= limit, entries }, null, 2)
  },
  dangerous: false,
  defaultChannels: ['dashboard'],
}
