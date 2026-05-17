/**
 * MODULE: 受限 JavaScript 执行工具。
 * 安全：用于数据处理，禁止 Node/文件/进程能力，超时执行。
 */
const vm = require('vm')

const BLOCKED = /\b(?:require|import|process|child_process|fs|global|globalThis|__dirname|__filename|module|exports|Function|eval)\b/
const MAX_CODE_CHARS = 12000
const MAX_RESULT_CHARS = 8000
const MAX_JSONIFY_CHARS = 64000

function safeStringifyResult(result) {
  const seen = new WeakSet()
  return JSON.stringify(result === undefined ? null : result, (key, value) => {
    if (typeof value === 'string' && value.length > MAX_RESULT_CHARS) return value.slice(0, MAX_RESULT_CHARS) + `...(字符串截断，共 ${value.length} 字符)`
    if (Array.isArray(value) && value.length > 2000) return value.slice(0, 2000)
    if (value && typeof value === 'object') {
      if (seen.has(value)) return '[Circular]'
      seen.add(value)
    }
    return value
  }, 2)
}

module.exports = {
  definition: {
    name: 'execute_javascript',
    description: '在受限沙箱中执行短 JavaScript 片段做数据处理。禁止文件、进程、网络和模块加载。',
    parameters: {
      type: 'object',
      properties: {
        code: { type: 'string', description: '要执行的 JavaScript 表达式或脚本，最后一行作为结果' },
      },
      required: ['code'],
    },
  },
  async execute(params = {}) {
    const code = String(params.code || '')
    if (!code.trim()) throw new Error('code 不能为空')
    if (code.length > MAX_CODE_CHARS) throw new Error(`代码过长：${code.length} 字符，最大 ${MAX_CODE_CHARS}`)
    if (BLOCKED.test(code)) throw new Error('代码包含被禁止的 Node/进程/模块能力')
    const sandbox = Object.freeze({ Math, JSON, Date, Number, String, Boolean, Array, Object, RegExp })
    const context = vm.createContext({ ...sandbox })
    const script = new vm.Script(`'use strict';\n${code}`)
    const result = script.runInContext(context, { timeout: 10000 })
    const text = safeStringifyResult(result)
    if (text && text.length > MAX_JSONIFY_CHARS) return text.slice(0, MAX_RESULT_CHARS) + `\n...(结果过大，截断前 ${text.length} 字符)`
    if (text && text.length > MAX_RESULT_CHARS) return text.slice(0, MAX_RESULT_CHARS) + `\n...(结果截断，共 ${text.length} 字符)`
    return text
  },
  dangerous: true,
  defaultChannels: ['dashboard'],
}
