/**
 * MODULE: 文件读取工具。
 * 安全：限定工作区目录，支持 offset/limit 分页。
 */
const fs = require('fs/promises')
const { assertExistingAgentPathInsideRoots } = require('../path-guard')

const MAX_FILE_BYTES = 512 * 1024
const MAX_OUTPUT_CHARS = 30000

module.exports = {
  definition: {
    name: 'read_file',
    description: '读取本地文件内容。用于代码、配置、日志等。支持分页。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件绝对路径' },
        offset: { type: 'number', description: '起始行号，默认 1' },
        limit: { type: 'number', description: '最多行数，默认 200，最大 500' },
      },
      required: ['path'],
    },
  },
  async execute(params = {}) {
    const filePath = String(params.path || '').trim()
    if (!filePath) throw new Error('路径不能为空')

    const { abs } = await assertExistingAgentPathInsideRoots(filePath, '文件')

    let stat
    try { stat = await fs.stat(abs) } catch { throw new Error(`文件不存在：${filePath}`) }
    if (!stat.isFile()) throw new Error(`不是文件：${filePath}`)
    if (stat.size > MAX_FILE_BYTES) throw new Error(`文件过大：${stat.size} bytes，最大 ${MAX_FILE_BYTES} bytes`)

    const buffer = await fs.readFile(abs)
    if (buffer.includes(0)) throw new Error('疑似二进制文件，拒绝读取')
    const content = buffer.toString('utf8')
    const lines = content.split('\n')
    const start = Math.max(0, (parseInt(params.offset, 10) || 1) - 1)
    const end = Math.min(lines.length, start + Math.min(500, parseInt(params.limit, 10) || 200))

    const body = lines.slice(start, end).join('\n')
    const clipped = body.length > MAX_OUTPUT_CHARS ? body.slice(0, MAX_OUTPUT_CHARS) + `\n...(输出截断，共 ${body.length} 字符)` : body
    return `文件：${abs}（共 ${lines.length} 行，显示 ${start + 1}-${end} 行）\n${clipped}`
  },
  dangerous: false,
  defaultChannels: ['dashboard'],
}
