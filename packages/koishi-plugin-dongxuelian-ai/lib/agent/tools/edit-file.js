/**
 * MODULE: 文件编辑工具。
 * 安全：限定工作区目录，只做唯一精确字符串替换。
 */
const fs = require('fs/promises')
const { assertExistingAgentPathInsideRoots } = require('../path-guard')

const MAX_FILE_BYTES = 512 * 1024
const MAX_REPLACEMENT_BYTES = 256 * 1024
const MAX_EDIT_RESULT_BYTES = 1024 * 1024

function countOccurrences(text, needle) {
  let count = 0
  let index = 0
  while (needle && (index = text.indexOf(needle, index)) !== -1) {
    count++
    index += needle.length
    if (count > 1) break
  }
  return count
}

module.exports = {
  definition: {
    name: 'edit_file',
    description: '编辑允许工作区内的文本文件。默认要求 oldString 在文件中唯一匹配。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件绝对路径' },
        oldString: { type: 'string', description: '要替换的原文本' },
        newString: { type: 'string', description: '替换后的文本' },
        replaceAll: { type: 'boolean', description: '是否替换所有匹配，默认 false' },
      },
      required: ['path', 'oldString', 'newString'],
    },
  },
  async execute(params = {}) {
    const filePath = String(params.path || '').trim()
    if (!filePath) throw new Error('路径不能为空')
    if (typeof params.oldString !== 'string' || !params.oldString) throw new Error('oldString 不能为空')
    if (typeof params.newString !== 'string') throw new Error('newString 必须是字符串')
    if (params.oldString === params.newString) throw new Error('newString 必须不同于 oldString')

    const replacementBytes = Buffer.byteLength(params.newString, 'utf8')
    if (replacementBytes > MAX_REPLACEMENT_BYTES) throw new Error(`替换内容过大：${replacementBytes} bytes，最大 ${MAX_REPLACEMENT_BYTES} bytes`)

    const { abs } = await assertExistingAgentPathInsideRoots(filePath, '文件')

    let stat
    try { stat = await fs.stat(abs) } catch { throw new Error(`文件不存在：${filePath}`) }
    if (!stat.isFile()) throw new Error(`不是文件：${filePath}`)
    if (stat.size > MAX_FILE_BYTES) throw new Error(`文件过大：${stat.size} bytes，最大 ${MAX_FILE_BYTES} bytes`)

    const buffer = await fs.readFile(abs)
    if (buffer.includes(0)) throw new Error('疑似二进制文件，拒绝编辑')
    const content = buffer.toString('utf8')
    const occurrences = countOccurrences(content, params.oldString)
    if (occurrences === 0) throw new Error('未找到 oldString')
    if (occurrences > 1 && !params.replaceAll) throw new Error('oldString 匹配多处，请设置 replaceAll=true 或提供更长上下文')

    const next = params.replaceAll
      ? content.split(params.oldString).join(params.newString)
      : content.replace(params.oldString, params.newString)
    const nextBytes = Buffer.byteLength(next, 'utf8')
    if (nextBytes > MAX_EDIT_RESULT_BYTES) throw new Error(`编辑后文件过大：${nextBytes} bytes，最大 ${MAX_EDIT_RESULT_BYTES} bytes`)
    await fs.writeFile(abs, next, 'utf8')
    return `已编辑：${abs}（替换 ${params.replaceAll ? occurrences : 1} 处）`
  },
  dangerous: true,
  defaultChannels: ['dashboard'],
}
