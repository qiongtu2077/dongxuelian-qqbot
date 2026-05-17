/**
 * MODULE: 文件写入工具。
 * 安全：限定工作区目录，默认不覆盖已有文件。
 */
const fs = require('fs/promises')
const path = require('path')
const { assertNewAgentPathInsideRoots, assertExistingAgentPathInsideRoots } = require('../path-guard')

const MAX_CONTENT_BYTES = 256 * 1024
const MAX_OVERWRITE_TARGET_BYTES = 2 * 1024 * 1024

module.exports = {
  definition: {
    name: 'write_file',
    description: '写入允许工作区内的文本文件。默认不覆盖已有文件，可显式 overwrite。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件绝对路径' },
        content: { type: 'string', description: '要写入的文本内容' },
        overwrite: { type: 'boolean', description: '是否允许覆盖已有文件，默认 false' },
        createDirectories: { type: 'boolean', description: '是否自动创建父目录，默认 false' },
      },
      required: ['path', 'content'],
    },
  },
  async execute(params = {}) {
    const filePath = String(params.path || '').trim()
    if (!filePath) throw new Error('路径不能为空')
    if (typeof params.content !== 'string') throw new Error('content 必须是字符串')

    const contentBytes = Buffer.byteLength(params.content, 'utf8')
    if (contentBytes > MAX_CONTENT_BYTES) throw new Error(`内容过大：${contentBytes} bytes，最大 ${MAX_CONTENT_BYTES} bytes`)

    const { abs } = await assertNewAgentPathInsideRoots(filePath, '路径', !!params.createDirectories)
    const parent = path.dirname(abs)

    const linkStat = await fs.lstat(abs).catch(() => null)
    if (linkStat && linkStat.isSymbolicLink()) throw new Error(`目标是符号链接，拒绝写入：${filePath}`)
    let existing = null
    try { existing = await fs.stat(abs) } catch {}
    if (existing) await assertExistingAgentPathInsideRoots(abs, '路径')
    if (existing && existing.isDirectory()) throw new Error(`目标是目录：${filePath}`)
    if (existing && existing.size > MAX_OVERWRITE_TARGET_BYTES) throw new Error(`目标文件过大，拒绝覆盖：${existing.size} bytes`)
    if (existing && !params.overwrite) throw new Error('文件已存在，如需覆盖请设置 overwrite=true')

    if (params.createDirectories) await fs.mkdir(parent, { recursive: true })
    else {
      const parentStat = await fs.stat(parent).catch(() => null)
      if (!parentStat || !parentStat.isDirectory()) throw new Error(`父目录不存在：${parent}`)
    }

    await fs.writeFile(abs, params.content, 'utf8')
    return `已写入：${abs}（${contentBytes} bytes）`
  },
  dangerous: true,
  defaultChannels: ['dashboard'],
}
