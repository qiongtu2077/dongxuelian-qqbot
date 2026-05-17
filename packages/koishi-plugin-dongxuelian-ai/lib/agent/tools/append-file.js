/**
 * MODULE: 文件追加工具。
 * 安全：限定工作区目录，拒绝符号链接，限制内容大小。
 */
const fs = require('fs/promises')
const path = require('path')
const { assertNewAgentPathInsideRoots, assertExistingAgentPathInsideRoots } = require('../path-guard')

const MAX_APPEND_BYTES = 128 * 1024
const MAX_APPEND_TARGET_BYTES = 2 * 1024 * 1024

module.exports = {
  definition: {
    name: 'append_file',
    description: '向允许工作区内的文本文件末尾追加内容。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件绝对路径' },
        content: { type: 'string', description: '要追加的文本内容' },
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
    if (contentBytes > MAX_APPEND_BYTES) throw new Error(`内容过大：${contentBytes} bytes，最大 ${MAX_APPEND_BYTES} bytes`)

    const { abs } = await assertNewAgentPathInsideRoots(filePath, '路径', !!params.createDirectories)
    const linkStat = await fs.lstat(abs).catch(() => null)
    if (linkStat && linkStat.isSymbolicLink()) throw new Error(`目标是符号链接，拒绝追加：${filePath}`)
    const existing = await fs.stat(abs).catch(() => null)
    if (existing) await assertExistingAgentPathInsideRoots(abs, '路径')
    if (existing && existing.isDirectory()) throw new Error(`目标是目录：${filePath}`)
    if (existing && existing.size + contentBytes > MAX_APPEND_TARGET_BYTES) throw new Error(`追加后文件过大：${existing.size + contentBytes} bytes，最大 ${MAX_APPEND_TARGET_BYTES} bytes`)
    if (params.createDirectories) await fs.mkdir(path.dirname(abs), { recursive: true })
    await fs.appendFile(abs, params.content, 'utf8')
    return `已追加：${abs}（${contentBytes} bytes）`
  },
  dangerous: true,
  defaultChannels: ['dashboard'],
}
