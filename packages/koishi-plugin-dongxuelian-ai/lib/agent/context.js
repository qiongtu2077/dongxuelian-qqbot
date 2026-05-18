/**
 * MODULE: Agent 上下文管理。
 * 职责: Token 估算、工具结果截断、临时压缩（Phase 2）。
 * 边界: 不写 conversation.js，不修改传入的 messages。
 * 状态: externalResultCounter (number)。
 */

const fs = require('fs')
const path = require('path')
const { DATA_DIR } = require('../constants')

const TOOL_RESULTS_DIR = path.join(DATA_DIR, 'agent-tool-results')
let toolResultsDirReady = false

let externalResultCounter = 0

/** 粗略 token 估算：中文 ~0.5 token/char，英文 ~0.25 */
function estimateTokens(messages = []) {
  let total = 0
  for (const m of messages) {
    if (typeof m.content === 'string') {
      // 中文字符约 0.5 token，英文字符约 0.25
      const hasChinese = /[\u4e00-\u9fff]/.test(m.content)
      total += Math.ceil(m.content.length * (hasChinese ? 0.5 : 0.25))
    }
    if (m.tool_calls) {
      total += Math.ceil(JSON.stringify(m.tool_calls).length * 0.25)
    }
  }
  return total
}

/** 工具结果截断，默认 8000 字符 */
function truncateToolResult(text = '', maxChars = 8000) {
  const s = String(text)
  if (s.length <= maxChars) return s
  return s.slice(0, maxChars) + `\n...(结果截断，共 ${s.length} 字符)`
}

/** 构建上下文摘要报告 */
function buildContextReport(messages = []) {
  return {
    messageCount: messages.length,
    estimatedTokens: estimateTokens(messages),
    roles: messages.reduce((acc, m) => { acc[m.role] = (acc[m.role] || 0) + 1; return acc }, {}),
  }
}

function externalizeToolResult(text = '', toolName = 'tool', maxInlineChars = 8000) {
  const s = String(text)
  if (s.length <= maxInlineChars) return s
  const safeName = String(toolName || 'tool').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 48) || 'tool'
  if (!toolResultsDirReady) { fs.mkdirSync(TOOL_RESULTS_DIR, { recursive: true }); toolResultsDirReady = true }
  const file = path.join(TOOL_RESULTS_DIR, `${Date.now()}-${++externalResultCounter}-${safeName}.txt`)
  fs.writeFileSync(file, s, 'utf8')
  return `${s.slice(0, maxInlineChars)}\n...(结果截断，共 ${s.length} 字符；完整结果已保存：${file})`
}

function compactMessages(messages = [], maxMessages = 24) {
  if (!Array.isArray(messages) || messages.length <= maxMessages) return messages.slice()
  const first = messages[0]
  const tailStart = Math.max(1, messages.length - maxMessages)
  const kept = messages.slice(tailStart).filter(m => m && m.role !== 'tool' && !m.tool_calls)
  const omitted = messages.slice(1, tailStart)
  const users = omitted.filter(m => m.role === 'user' && typeof m.content === 'string').slice(-3).map(m => m.content.slice(0, 120))
  const tools = omitted.filter(m => m.role === 'tool' && typeof m.content === 'string').slice(-6).map(m => m.content.slice(0, 160))
  const summaryParts = [`前文已压缩：省略 ${omitted.length} 条 Agent 中间消息，保留最近 ${kept.length} 条非工具消息。`]
  if (users.length) summaryParts.push('较早用户目标：' + users.join(' / '))
  if (tools.length) summaryParts.push('较早工具结果摘要：' + tools.join(' / '))
  const summary = { role: 'system', content: summaryParts.join('\n') }
  return [first, summary, ...kept].filter(Boolean)
}

function buildStructuredSummaryPrompt(messages = []) {
  const transcript = (Array.isArray(messages) ? messages : []).slice(-80).map((m, index) => {
    const role = m.role || 'unknown'
    const toolCalls = m.tool_calls ? `\n工具调用：${JSON.stringify(m.tool_calls).slice(0, 1200)}` : ''
    const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '')
    return `#${index + 1} ${role}\n${String(content || '').slice(0, 3000)}${toolCalls}`
  }).join('\n\n')
  return [
    '请把以下 Agent 上下文压缩为结构化摘要，必须保留用户目标、当前进度、关键事实、已做决策和下一步。',
    '只输出 Markdown，格式必须包含以下标题：',
    '## 目标',
    '## 进度',
    '## 关键事实',
    '## 决策',
    '## 下一步',
    '',
    transcript.slice(0, 50000),
  ].join('\n')
}

function mergeSummaryIntoMessages(summary, recentMessages = []) {
  const content = String(summary || '').trim()
  const safeSummary = content || '## 目标\n未知\n\n## 进度\n已进行上下文压缩。\n\n## 关键事实\n无\n\n## 决策\n无\n\n## 下一步\n继续根据最近消息推进。'
  const first = recentMessages.find(m => m && m.role === 'system') || null
  const tail = recentMessages.filter(m => m && m !== first)
  return [
    first,
    { role: 'system', content: `以下是较早 Agent 上下文的结构化摘要：\n${safeSummary.slice(0, 12000)}` },
    ...compactOldToolResults(tail, 4, 1200),
  ].filter(Boolean)
}

async function compactWithLLM(messages = [], config = {}, requestFn) {
  if (!Array.isArray(messages) || messages.length <= 24) return messages.slice()
  const recentMessages = messages.slice(-24)
  if (typeof requestFn !== 'function') return compactMessages(messages, 24)
  try {
    const prompt = buildStructuredSummaryPrompt(messages)
    const summary = await requestFn([
      { role: 'system', content: prompt },
      { role: 'user', content: '压缩以上 Agent 上下文。' },
    ], config, { max_tokens: 1200, _fallbackSet: 'lightweight' })
    if (!summary || typeof summary !== 'string') throw new Error('empty summary')
    if (!/##\s*目标/.test(summary) || !/##\s*下一步/.test(summary)) throw new Error('bad summary shape')
    return mergeSummaryIntoMessages(summary, recentMessages)
  } catch {
    return compactMessages(messages, 24)
  }
}

function summarizeToolResult(text = '', toolName = 'tool', maxChars = 1200) {
  const s = String(text || '')
  if (s.length <= maxChars) return s
  const head = s.slice(0, Math.floor(maxChars * 0.7))
  const tail = s.slice(-Math.floor(maxChars * 0.2))
  return `[${toolName} 结果摘要，原始 ${s.length} 字符]\n${head}\n...\n${tail}`
}

function compactOldToolResults(messages = [], keepRecent = 4, maxToolChars = 1200) {
  if (!Array.isArray(messages)) return []
  let seenTools = 0
  const result = []
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m && m.role === 'tool' && typeof m.content === 'string') {
      seenTools++
      result.unshift(seenTools > keepRecent ? { ...m, content: summarizeToolResult(m.content, 'tool', maxToolChars) } : m)
    } else {
      result.unshift(m)
    }
  }
  return result
}

function estimateCacheHitRate(systemMessage = '', previousSystemMessage = '') {
  const current = String(systemMessage || '')
  const previous = String(previousSystemMessage || '')
  if (!current || !previous) return 0
  const max = Math.min(current.length, previous.length)
  let same = 0
  while (same < max && current.charCodeAt(same) === previous.charCodeAt(same)) same++
  return Math.round((same / Math.max(current.length, previous.length)) * 1000) / 10
}

module.exports = { estimateTokens, truncateToolResult, externalizeToolResult, buildContextReport, compactMessages, buildStructuredSummaryPrompt, mergeSummaryIntoMessages, compactWithLLM, compactOldToolResults, summarizeToolResult, estimateCacheHitRate }
