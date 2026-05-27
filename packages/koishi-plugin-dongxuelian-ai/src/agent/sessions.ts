/**
 * MODULE: Agent 会话索引。
 * 职责: 记录 Agent 调用产生的会话摘要，供 Dashboard 查询。
 * 边界: 不保存普通聊天历史，不调用 AI API，不执行工具。
 * 状态: sessions (Map，最多 100 个会话，每会话最多 20 条记录)。
 */
interface AgentSessionTurn {
  at: number
  userMessage: string
  reply: string
  toolCalls: number
  pendingId: string | null
}

interface AgentSession {
  id: string
  channel: string
  channelKey: string
  userId: string
  userName: string
  title: string
  createdAt: number
  updatedAt: number
  turns: AgentSessionTurn[]
  toolCalls: number
  pendingId?: string | null
  lastMessage?: string
  lastReply?: string
}

interface RecordAgentSessionInput {
  channel?: string
  channelKey?: string
  userId?: string
  userName?: string
  userMessage?: string
  reply?: string
  toolCalls?: number
  pendingId?: string | null
}

interface AgentSessionSummary {
  id: string
  channel: string
  channelKey: string
  userId: string
  userName: string
  title: string
  createdAt: number
  updatedAt: number
  turns: number
  toolCalls: number
  pendingId: string | null
  lastMessage: string
  lastReply: string
}

const sessions: Map<string, AgentSession> = new Map()
const MAX_SESSIONS = 100
const MAX_TURNS_PER_SESSION = 20

function normalizeSessionPart(item: unknown): string {
  return String(item || 'unknown').replace(/[^a-zA-Z0-9_.:-]/g, '_').slice(0, 80)
}

function buildAgentSessionId(channelKey: unknown, userId: unknown, channel: unknown = 'unknown'): string {
  return [channel, channelKey, userId].map(normalizeSessionPart).join(':')
}

function trimAgentSessions(): void {
  while (sessions.size > MAX_SESSIONS) {
    const oldestId = sessions.keys().next().value
    if (!oldestId) break
    sessions.delete(oldestId)
  }
}

function recordAgentSession({ channel = 'unknown', channelKey = 'unknown', userId = 'unknown', userName = '用户', userMessage = '', reply = '', toolCalls = 0, pendingId = null }: RecordAgentSessionInput = {}): string {
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
  if (sessions.has(id)) sessions.delete(id)
  sessions.set(id, current)
  trimAgentSessions()
  return id
}

function listAgentSessions(): AgentSessionSummary[] {
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

function getAgentSession(id: unknown): AgentSession | null {
  const session = sessions.get(String(id || ''))
  if (!session) return null
  return { ...session, turns: session.turns.slice() }
}

function clearAgentSessions(): void {
  sessions.clear()
}

export = { buildAgentSessionId, recordAgentSession, listAgentSessions, getAgentSession, clearAgentSessions }
