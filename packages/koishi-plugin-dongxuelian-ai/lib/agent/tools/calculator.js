/**
 * MODULE: 精确计算工具。
 * 安全：只允许数字、运算符、括号和 Math 函数，拒绝任意代码执行。
 */
module.exports = {
  definition: {
    name: 'calculate',
    description: '精确计算数学表达式。用户问计算题时使用，避免 LLM 算错。支持：加减乘除、括号、Math.sin/cos/sqrt/pow/abs/floor 等函数。',
    parameters: {
      type: 'object',
      properties: {
        expression: { type: 'string', description: '数学表达式。例: "0.1 + 0.2", "Math.sqrt(16)", "1024 * 8 / 2"' },
      },
      required: ['expression'],
    },
  },
  async execute(params = {}) {
    const expr = String(params.expression || '').trim()
    if (!expr) throw new Error('表达式为空')
    if (expr.length > 200) throw new Error('表达式过长')

    const clean = expr.replace(/\s+/g, '')
    const allowedMath = new Set(['abs', 'acos', 'asin', 'atan', 'atan2', 'ceil', 'cos', 'floor', 'log', 'max', 'min', 'pow', 'round', 'sin', 'sqrt', 'tan'])
    const normalized = clean.replace(/Math\.([a-zA-Z]+)\(/g, (_, name) => {
      if (!allowedMath.has(name)) throw new Error(`不支持的 Math 函数: ${name}`)
      return '('
    })
    if (!/^[\d.+\-*/()%,]+$/.test(normalized)) throw new Error(`不安全字符: ${clean.slice(0, 60)}`)

    try {
      const result = new Function('Math', `"use strict"; return (${expr})`)(Math)
      if (!Number.isFinite(result)) throw new Error('结果非有限数')
      if (Number.isInteger(result)) return String(result)
      return String(parseFloat(result.toPrecision(12)))
    } catch (e) {
      throw new Error(`计算失败: ${e.message}`)
    }
  },
  dangerous: false,
  defaultChannels: ['dashboard', 'qq'],
}
