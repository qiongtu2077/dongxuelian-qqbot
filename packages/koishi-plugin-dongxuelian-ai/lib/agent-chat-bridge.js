/**
 * MODULE: Agent 与普通聊天上下文桥接。
 * 职责: 把 QQ Agent 的最终回复和短工具摘要接入普通 conversation/chat prompt。
 * 边界: 不发送消息、不执行工具、不调用 AI API；只写普通对话历史并维护短期内存摘要。
 * 状态: recentAgentContextCache (Map，按 channelKey:userId 保存短期 Agent 摘要)。
 */
const { saveConversationTurn, getChannelKey } = require('./conversation')
const { sanitizeUserName } = require('./utils')
const { normalizeText } = require('./message-reader')

const RECENT_AGENT_CONTEXT_TTL_MS = 10 * 60 * 1000
const MAX_RECENT_AGENT_CONTEXT_ENTRIES = 200
const MAX_TOOL_SUMMARY_CHARS = 1800
const MAX_REPLY_SUMMARY_CHARS = 800

const recentAgentContextCache = new Map()

function buildAgentContextKey(channelKey = '', userId = '') {
  return `${String(channelKey || 'unknown')}:${String(userId || 'unknown')}`
}

function trimRecentAgentContextCache(now = Date.now()) {
  for (const [key, value] of recentAgentContextCache.entries()) {
    if (!value || now - Number(value.ts || 0) > RECENT_AGENT_CONTEXT_TTL_MS) {
      recentAgentContextCache.delete(key)
    }
  }
  if (recentAgentContextCache.size <= MAX_RECENT_AGENT_CONTEXT_ENTRIES) return
  const ordered = Array.from(recentAgentContextCache.entries()).sort((a, b) => Number(b[1]?.ts || 0) - Number(a[1]?.ts || 0))
  recentAgentContextCache.clear()
  for (const [key, value] of ordered.slice(0, MAX_RECENT_AGENT_CONTEXT_ENTRIES)) {
    recentAgentContextCache.set(key, value)
  }
}

function extractSearchSummary(text = '') {
  const value = String(text || '')
  if (!value) return ''
  const lines = value
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
  const kept = []
  for (const line of lines) {
    if (/^(已搜索|搜索结果|打开候选网页|候选网页正文|来源|参考|API 搜索|轻量 HTTP 搜索|Chromium|为避免低内存服务器 OOM)/.test(line)) {
      kept.push(line)
      continue
    }
    if (/^\d+\.\s/.test(line) || /^https?:\/\//i.test(line) || /https?:\/\//i.test(line)) {
      kept.push(line)
      continue
    }
    if (kept.length > 0 && kept.length < 12 && line.length <= 220) kept.push(line)
    if (kept.join('\n').length >= MAX_TOOL_SUMMARY_CHARS) break
  }
  return kept.join('\n').slice(0, MAX_TOOL_SUMMARY_CHARS)
}

function summarizeAgentToolResults(toolResults = []) {
  const items = Array.isArray(toolResults) ? toolResults : []
  const parts = []
  for (const item of items.slice(-6)) {
    const name = String(item && item.name || 'tool')
    const text = String(item && item.result || '')
    if (!text) continue
    const summary = name === 'web_search' ? extractSearchSummary(text) : normalizeText(text).slice(0, 500)
    if (summary) parts.push(`[${name}]\n${summary}`)
  }
  return parts.join('\n\n').slice(0, MAX_TOOL_SUMMARY_CHARS)
}

function recordAgentChatResult({ session, userMessage = '', userName = '用户', userId = '', channelKey = '', agentResult = {} } = {}) {
  const reply = normalizeText(agentResult && agentResult.reply || '')
  if (!reply || /^\(Agent 未获取到有效回复\)/.test(reply)) return null
  if (agentResult && agentResult.pendingId) return null

  const safeUserName = sanitizeUserName(userName || '用户')
  const cleanUserMessage = normalizeText(userMessage).slice(0, 1200)
  const normalizedChannelKey = channelKey || (session ? getChannelKey(session) : 'dashboard')
  const normalizedUserId = String(userId || (session ? (session.userId || session.author?.id || session.username) : 'dashboard') || 'unknown')
  const toolSummary = summarizeAgentToolResults(agentResult.toolResults || [])

  if (session && cleanUserMessage) {
    saveConversationTurn(
      session,
      `<user>\n昵称：${safeUserName}\n发言：${cleanUserMessage}\n</user>`,
      reply
    )
  }

  const now = Date.now()
  const entry = {
    ts: now,
    userMessage: cleanUserMessage.slice(0, 500),
    reply: reply.slice(0, MAX_REPLY_SUMMARY_CHARS),
    toolCalls: Number(agentResult.toolCalls || 0),
    toolSummary,
  }
  recentAgentContextCache.set(buildAgentContextKey(normalizedChannelKey, normalizedUserId), entry)
  trimRecentAgentContextCache(now)
  return entry
}

function isAgentFollowUp(text = '') {
  return /(?:刚刚|刚才|上次|前面|你).*?(?:搜|查|工具|来源|依据|结果)|(?:搜到|查到).{0,8}(?:什么|哪些|哪几个|结果|来源|依据)/.test(String(text || ''))
}

function getRecentAgentContextNote({ channelKey = '', userId = '', userMessage = '' } = {}) {
  trimRecentAgentContextCache()
  const entry = recentAgentContextCache.get(buildAgentContextKey(channelKey, userId))
  if (!entry) return ''
  if (Date.now() - Number(entry.ts || 0) > RECENT_AGENT_CONTEXT_TTL_MS) return ''
  
  const lines = [
    '[最近 Agent 工具上下文-内部参考]',
    '用户正在追问你刚才的 Agent/搜索/工具结果。你可以承认刚才调用过工具，并只根据下面摘要回答；不要说自己没搜索。',
    `刚才用户请求：${entry.userMessage || '(空)'}`,
    `刚才最终回复：${entry.reply || '(空)'}`,
  ]
  if (entry.toolCalls) lines.push(`工具调用数：${entry.toolCalls}`)
  if (entry.toolSummary) lines.push(`工具/搜索摘要：\n${entry.toolSummary}`)
  return lines.join('\n')
}

function clearAgentChatBridge() {
  recentAgentContextCache.clear()
}

module.exports = {
  buildAgentContextKey,
  summarizeAgentToolResults,
  extractSearchSummary,
  recordAgentChatResult,
  getRecentAgentContextNote,
  clearAgentChatBridge,
}
