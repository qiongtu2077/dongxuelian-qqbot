/**
 * MODULE: Agent 会话索引。
 * 职责: 记录 Agent 调用产生的会话摘要，供 Dashboard 查询。
 * 边界: 不保存普通聊天历史，不调用 AI API，不执行工具。
 * 状态: sessions (Map，最多 100 个会话，每会话最多 20 条记录)。
 */
const sessions = new Map()
const MAX_SESSIONS = 100
const MAX_TURNS_PER_SESSION = 20

function buildAgentSessionId(channelKey, userId, channel = 'unknown') {
  return [channel, channelKey, userId].map(item => String(item || 'unknown').replace(/[^a-zA-Z0-9_.:-]/g, '_').slice(0, 80)).join(':')
}

function trimAgentSessions() {
  const ordered = Array.from(sessions.entries()).sort((a, b) => b[1].updatedAt - a[1].updatedAt)
  sessions.clear()
  for (const [id, session] of ordered.slice(0, MAX_SESSIONS)) sessions.set(id, session)
}

function recordAgentSession({ channel = 'unknown', channelKey = 'unknown', userId = 'unknown', userName = '用户', userMessage = '', reply = '', toolCalls = 0, pendingId = null } = {}) {
  const id = buildAgentSessionId(channelKey, userId, channel)
  const now = Date.now()
  const current = sessions.get(id) || {
    id,
    channel,
    channelKey,
    userId,
    userName,
    title: String(userMessage || 'Agent 会话').slice(0, 40) || 'Agent 会话',
    createdAt: now,
    updatedAt: now,
    turns: [],
    toolCalls: 0,
  }
  current.channel = channel
  current.channelKey = channelKey
  current.userId = userId
  current.userName = userName || current.userName
  current.updatedAt = now
  current.toolCalls += Number(toolCalls) || 0
  current.pendingId = pendingId || null
  current.lastMessage = String(userMessage || '').slice(0, 160)
  current.lastReply = String(reply || '').slice(0, 160)
  current.turns.unshift({ at: now, userMessage: current.lastMessage, reply: current.lastReply, toolCalls: Number(toolCalls) || 0, pendingId: current.pendingId })
  if (current.turns.length > MAX_TURNS_PER_SESSION) current.turns.length = MAX_TURNS_PER_SESSION
  sessions.set(id, current)
  trimAgentSessions()
  return id
}

function listAgentSessions() {
  return Array.from(sessions.values())
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map(session => ({
      id: session.id,
      channel: session.channel,
      channelKey: session.channelKey,
      userId: session.userId,
      userName: session.userName,
      title: session.title,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      turns: session.turns.length,
      toolCalls: session.toolCalls,
      pendingId: session.pendingId || null,
      lastMessage: session.lastMessage || '',
      lastReply: session.lastReply || '',
    }))
}

function getAgentSession(id) {
  const session = sessions.get(String(id || ''))
  if (!session) return null
  return { ...session, turns: session.turns.slice() }
}

function clearAgentSessions() {
  sessions.clear()
}

module.exports = { buildAgentSessionId, recordAgentSession, listAgentSessions, getAgentSession, clearAgentSessions }
